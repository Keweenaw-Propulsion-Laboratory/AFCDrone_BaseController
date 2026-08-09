import {
  USB_MESSAGE_TYPES,
  RADIO_MESSAGE_TYPES,
  RADIO_HANDSHAKE,
  PROTOCOL_VERSION,
  PACKET_NUMBER_OFFSET,
  CRC_SIZE,
  PACKET_SCHEMAS,
  CONFIG_KEYS,
  CONFIG_OPS,
  CONFIG_RESULTS,
  CONFIG_RESULT_LABELS,
  getConfigKeyById,
  getSchemaById,
  getOutboundSchemas,
  decodePayload,
  encodePayload,
  buildPacket,
  bytesToHex,
  hexToBytes,
  formatFieldValue,
  DRONE_STATES,
  formatDroneState,
} from './protocol.js';
import { SerialLink } from './serial-link.js';
import {
  encodeRadioCommandEnvelope,
  encodeRadioConfigEnvelope,
  applyRadioStatusToTelemetry,
  sendRadioConfigSequence,
  RADIO_CONFIG_REQUEST_TIMEOUT_MS,
  RADIO_CONFIG_MAX_ATTEMPTS,
} from './radio-relay.js';
// Dynamically imported in initializeOrientationView() - orientation-view.js
// itself pulls Three.js from a CDN, and a static top-level import would take
// the whole dashboard down on a CDN hiccup instead of just the 3D tab.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const link = new SerialLink();
const state = {
  connected: false,
  bridgeConnected: false,
  currentPort: null,
  demoRunning: false,
  demoTimer: null,
  liveTimer: null,
  rxPackets: 0,
  txPackets: 0,
  badFrames: 0,
  packetTimes: [],
  lastTelemetryAt: null,
  lastTelemetry: null,
  chartWindowMs: 30_000,
  packetRows: [],
  configTouched: new Set(),
  configSyncedAt: null,
  // The drone's USB command handler currently falls through into its config
  // handler (a firmware bug - fixed upstream, but old firmware may still be
  // running), which can emit an unsolicited type-5 reply after a plain
  // COMMAND send. Only treat an inbound CONFIG response as real if a direct
  // (non-relay) config request is actually outstanding.
  pendingDirectConfigRequest: false,
  // Guards against overlapping Read/Apply/Reset sequences (e.g. the
  // auto-config-read racing a manual click) - relay mode's sequential
  // per-key requests share one single-slot resolver, so two concurrent
  // sequences would cross-attribute replies to the wrong key.
  configSequenceBusy: false,
  // Auto-triggers one Config Read as soon as the first telemetry sample
  // after connecting tells us the vehicle isn't in FLIGHT. Reset on every
  // fresh connection so it fires again next time.
  autoConfigReadDone: false,
  // 'direct' = wired straight to the drone; 'relay' = through a dumb base
  // station. Resolved by the identify handshake on every fresh connection.
  linkMode: null,
  linkModeKnown: false,
  relayTelemetry: {},
  pendingIdentifyResolve: null,
  pendingRadioConfigResolve: null,
  history: {
    loopTimeAvg: [],
    loopTimeMax: [],
    rssi: [],
  },
};

const telemetrySchema = getSchemaById(USB_MESSAGE_TYPES.TELEMETRY);
const commandSchema = getSchemaById(USB_MESSAGE_TYPES.COMMAND);
const configSchema = getSchemaById(USB_MESSAGE_TYPES.CONFIG);

const CHART_RETENTION_MS = 30 * 60 * 1000;
const CHART_MAX_POINTS_PER_PIXEL = 2;
const IDENTIFY_TIMEOUT_MS = 1500;
const IDENTIFY_MAX_ATTEMPTS = 3;

const MAP_ZOOM = 20;
const MAP_DEFAULT_CENTER = [47.1164, -88.5385];
const MAP_MAX_TRAIL_POINTS = 600;
let telemetryMap = null;
let mapTileLayer = null;
let mapPositionMarker = null;
let mapTrailLayer = null;
let mapTrailCoordinates = [];
let lastMapPosition = null;
let mapTileError = false;

let orientationView = null;
let orientationModule = null;

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function showToast(message, tone = 'info') {
  const region = $('#toast-region');
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.textContent = message;
  region.append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  window.setTimeout(() => {
    toast.classList.remove('visible');
    window.setTimeout(() => toast.remove(), 180);
  }, 3500);
}

function setConnectionStatus(connected, label = null) {
  state.connected = connected;

  let displayLabel = label;
  if (!displayLabel) {
    if (state.demoRunning) displayLabel = 'Demo';
    else if (!state.bridgeConnected) displayLabel = 'Server Offline';
    else displayLabel = connected ? 'Connected' : 'Serial Disconnected';
  }

  const badge = $('#connection-badge');
  badge.innerHTML = `<span id="connection-dot" class="status-dot ${connected ? 'online' : ''}"></span>${escapeHtml(displayLabel)}`;
  badge.classList.toggle('connected', connected);

  const connectButton = $('#connect-button');
  connectButton.textContent = connected ? 'Disconnect' : 'Connect Serial';
  connectButton.disabled = !state.bridgeConnected || (!connected && !$('#serial-port').value);
  $('#refresh-ports').disabled = !state.bridgeConnected;

  setText('metric-connection', displayLabel);
  if (state.demoRunning) {
    setText('metric-connection-detail', 'Simulated source');
  } else if (!state.bridgeConnected) {
    setText('metric-connection-detail', 'No server bridge');
  } else if (connected) {
    setText('metric-connection-detail', `${state.currentPort || 'Server serial'} active`);
  } else {
    setText('metric-connection-detail', 'Server ready; no serial port open');
  }
}

function updateLinkModeDisplay() {
  const el = $('#link-mode-status');
  if (!el) return;

  if (state.linkMode === 'relay') {
    el.textContent = 'Link: Relay (base station)';
    el.className = 'link-mode-badge relay';
  } else if (state.linkMode === 'direct' && state.linkModeKnown) {
    el.textContent = 'Link: Direct (drone)';
    el.className = 'link-mode-badge direct';
  } else if (state.linkMode === 'direct') {
    el.textContent = 'Link: Unknown (assuming direct)';
    el.className = 'link-mode-badge unknown';
  } else {
    el.textContent = 'Link: Not connected';
    el.className = 'link-mode-badge';
    setText('metric-downlink-rssi', '--');
  }
}

function resetLinkMode() {
  state.linkMode = null;
  state.linkModeKnown = false;
  state.pendingIdentifyResolve = null;
  state.pendingRadioConfigResolve = null;
  state.relayTelemetry = {};
  state.autoConfigReadDone = false;
  updateLinkModeDisplay();
}

// A relay connection can be saturated with STATUS0-6 telemetry (one every
// few ms under load), so a single identify query/reply is easy to lose in
// the noise within one timeout window - retry a few times before giving up.
async function attemptIdentifyQuery() {
  const replyPromise = new Promise((resolve) => {
    state.pendingIdentifyResolve = resolve;
  });

  try {
    await sendFrame(USB_MESSAGE_TYPES.RAW, new Uint8Array([RADIO_HANDSHAKE.IDENTIFY_QUERY]), null, 'Identify query');
  } catch {
    // Fall through to the timeout below; the device just won't answer.
  }

  const timeoutPromise = new Promise((resolve) => {
    window.setTimeout(() => resolve(null), IDENTIFY_TIMEOUT_MS);
  });

  const kind = await Promise.race([replyPromise, timeoutPromise]);
  state.pendingIdentifyResolve = null;
  return kind;
}

// Bumped on every call so a slow/superseded handshake attempt can tell it's
// no longer the latest one and avoid clobbering a newer result - the type is
// always re-verified fresh per connection, never reused from a prior one.
let identifyGeneration = 0;

async function runIdentifyHandshake() {
  const generation = ++identifyGeneration;
  state.linkMode = null;
  state.linkModeKnown = false;
  updateLinkModeDisplay();

  let kind = null;
  for (let attempt = 0; attempt < IDENTIFY_MAX_ATTEMPTS && kind === null; attempt += 1) {
    kind = await attemptIdentifyQuery();
  }
  if (generation !== identifyGeneration) return; // a newer handshake has already taken over

  state.relayTelemetry = {};

  if (kind === RADIO_HANDSHAKE.DEVICE_KIND_BASE_STATION_RELAY) {
    state.linkMode = 'relay';
    state.linkModeKnown = true;
  } else if (kind === RADIO_HANDSHAKE.DEVICE_KIND_DRONE_DIRECT) {
    state.linkMode = 'direct';
    state.linkModeKnown = true;
  } else {
    state.linkMode = 'direct';
    state.linkModeKnown = false;
    showToast('No identify response from the connected device — assuming direct connection', 'warning');
  }
  updateLinkModeDisplay();
}

function setBridgeStatus(connected) {
  state.bridgeConnected = connected;
  $('#server-warning').hidden = connected;
  if (!connected) {
    state.currentPort = null;
    setConnectionStatus(false, 'Server Offline');
  } else {
    setConnectionStatus(state.connected);
  }
}

function renderSerialPorts(ports) {
  const select = $('#serial-port');
  const previous = state.currentPort || select.value;
  select.innerHTML = '';

  if (!ports.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No serial ports found';
    select.append(option);
  } else {
    for (const port of ports) {
      const option = document.createElement('option');
      option.value = port.device;
      const description = port.description && port.description !== port.device ? ` - ${port.description}` : '';
      option.textContent = `${port.device}${description}`;
      select.append(option);
    }
    if (ports.some((port) => port.device === previous)) select.value = previous;
  }

  setConnectionStatus(state.connected);
}

function formatRuntime(seconds) {
  const value = Number(seconds) || 0;
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatAge(timestamp) {
  if (!timestamp) return 'Never';
  const seconds = Math.max(0, (performance.now() - timestamp) / 1000);
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms ago`;
  if (seconds < 60) return `${seconds.toFixed(1)} s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

function addHistory(key, value, timestamp = Date.now()) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return;

  const series = state.history[key];
  series.push({ timestamp, value: numericValue });

  const cutoff = timestamp - CHART_RETENTION_MS;
  let removeCount = 0;
  while (removeCount < series.length && series[removeCount].timestamp < cutoff) removeCount += 1;
  if (removeCount > 0) series.splice(0, removeCount);
}

function pointsInWindow(points, startTime, endTime) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timestamp < startTime) low = middle + 1;
    else high = middle;
  }

  let end = low;
  while (end < points.length && points[end].timestamp <= endTime) end += 1;
  return points.slice(low, end);
}

function downsampleMinMax(points, targetCount) {
  if (points.length <= targetCount || targetCount < 4) return points;

  const bucketCount = Math.max(1, Math.floor(targetCount / 2));
  const bucketSize = points.length / bucketCount;
  const sampled = [];

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.min(points.length, Math.floor((bucket + 1) * bucketSize));
    if (end <= start) continue;

    let minimum = points[start];
    let maximum = points[start];
    for (let index = start + 1; index < end; index += 1) {
      if (points[index].value < minimum.value) minimum = points[index];
      if (points[index].value > maximum.value) maximum = points[index];
    }

    if (minimum.timestamp <= maximum.timestamp) {
      sampled.push(minimum);
      if (maximum !== minimum) sampled.push(maximum);
    } else {
      sampled.push(maximum);
      if (maximum !== minimum) sampled.push(minimum);
    }
  }

  const lastPoint = points[points.length - 1];
  if (sampled[sampled.length - 1] !== lastPoint) sampled.push(lastPoint);
  return sampled;
}

function formatChartValue(value, unit = '') {
  if (!Number.isFinite(value)) return '--';
  const formatted = Math.abs(value) >= 100 || Number.isInteger(value)
    ? Math.round(value).toLocaleString()
    : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatAxisTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatHoverTime(timestamp) {
  const date = new Date(timestamp);
  const hours24 = date.getHours();
  const hours12 = hours24 % 12 || 12;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  const period = hours24 >= 12 ? 'PM' : 'AM';
  return `${hours12}:${minutes}:${seconds}.${milliseconds} ${period}`;
}

function drawTimeChart(canvas, seriesDefinitions, unit = '') {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue('--muted').trim();
  const border = styles.getPropertyValue('--border').trim();
  const now = Date.now();
  const startTime = now - state.chartWindowMs;
  const plot = {
    left: 54,
    right: Math.max(64, rect.width - 10),
    top: 10,
    bottom: Math.max(34, rect.height - 28),
  };
  const plotWidth = Math.max(1, plot.right - plot.left);
  const plotHeight = Math.max(1, plot.bottom - plot.top);

  const series = seriesDefinitions.map((definition) => {
    const points = pointsInWindow(state.history[definition.key], startTime, now);
    return {
      ...definition,
      color: styles.getPropertyValue(definition.colorVariable).trim(),
      points,
      renderPoints: downsampleMinMax(points, Math.max(20, Math.floor(plotWidth * CHART_MAX_POINTS_PER_PIXEL))),
    };
  });
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let valueCount = 0;
  for (const item of series) {
    for (const point of item.points) {
      minimum = Math.min(minimum, point.value);
      maximum = Math.max(maximum, point.value);
      valueCount += 1;
    }
  }

  ctx.font = '11px system-ui';
  ctx.lineWidth = 1;
  ctx.textBaseline = 'middle';

  if (valueCount === 0) {
    ctx.fillStyle = muted;
    ctx.textAlign = 'left';
    ctx.fillText('Waiting for telemetry in the selected time span', plot.left, plot.top + 12);
    canvas._chartMeta = null;
    return;
  }
  if (maximum === minimum) {
    const padding = Math.max(1, Math.abs(maximum) * 0.05);
    minimum -= padding;
    maximum += padding;
  } else {
    const padding = (maximum - minimum) * 0.08;
    minimum -= padding;
    maximum += padding;
  }

  const yForValue = (value) => plot.bottom - ((value - minimum) / (maximum - minimum)) * plotHeight;
  const xForTime = (timestamp) => plot.left + ((timestamp - startTime) / state.chartWindowMs) * plotWidth;

  ctx.strokeStyle = border;
  ctx.fillStyle = muted;
  for (let tick = 0; tick <= 4; tick += 1) {
    const ratio = tick / 4;
    const y = plot.top + ratio * plotHeight;
    const value = maximum - ratio * (maximum - minimum);

    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();

    ctx.textAlign = 'right';
    ctx.fillText(formatChartValue(value), plot.left - 7, y);
  }

  const xTickCount = rect.width < 480 ? 2 : 3;
  ctx.textBaseline = 'top';
  for (let tick = 0; tick < xTickCount; tick += 1) {
    const ratio = xTickCount === 1 ? 0 : tick / (xTickCount - 1);
    const x = plot.left + ratio * plotWidth;
    const timestamp = startTime + ratio * state.chartWindowMs;
    ctx.textAlign = tick === 0 ? 'left' : tick === xTickCount - 1 ? 'right' : 'center';
    ctx.fillText(formatAxisTime(timestamp), x, plot.bottom + 8);
  }

  ctx.textBaseline = 'middle';
  for (const item of series) {
    if (item.renderPoints.length === 0) continue;

    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    item.renderPoints.forEach((point, index) => {
      const x = xForTime(point.timestamp);
      const y = yForValue(point.value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const latest = item.points[item.points.length - 1];
    if (latest) {
      ctx.beginPath();
      ctx.arc(xForTime(latest.timestamp), yForValue(latest.value), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  canvas._chartMeta = {
    startTime,
    endTime: now,
    plot,
    plotWidth,
    unit,
    series,
  };
}

function findNearestPoint(points, timestamp) {
  if (!points.length) return null;

  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }

  const candidate = points[low];
  const previous = low > 0 ? points[low - 1] : null;
  if (!previous) return candidate;
  return Math.abs(previous.timestamp - timestamp) <= Math.abs(candidate.timestamp - timestamp) ? previous : candidate;
}

function hideChartTooltip(canvas) {
  const wrapper = canvas.closest('.chart-wrap');
  if (!wrapper) return;
  const tooltip = $('.chart-tooltip', wrapper);
  const line = $('.chart-hover-line', wrapper);
  if (tooltip) tooltip.hidden = true;
  if (line) line.hidden = true;
}

function showChartTooltip(canvas, event) {
  const meta = canvas._chartMeta;
  const wrapper = canvas.closest('.chart-wrap');
  if (!meta || !wrapper) {
    hideChartTooltip(canvas);
    return;
  }

  const bounds = canvas.getBoundingClientRect();
  const pointerX = event.clientX - bounds.left;
  if (pointerX < meta.plot.left || pointerX > meta.plot.right) {
    hideChartTooltip(canvas);
    return;
  }

  const ratio = (pointerX - meta.plot.left) / meta.plotWidth;
  const targetTime = meta.startTime + ratio * (meta.endTime - meta.startTime);
  const samples = meta.series
    .map((series) => ({ series, point: findNearestPoint(series.points, targetTime) }))
    .filter((sample) => sample.point);

  if (!samples.length) {
    hideChartTooltip(canvas);
    return;
  }

  const referencePoint = samples.reduce((closest, sample) => {
    if (!closest) return sample.point;
    return Math.abs(sample.point.timestamp - targetTime) < Math.abs(closest.timestamp - targetTime)
      ? sample.point
      : closest;
  }, null);
  const lineX = meta.plot.left
    + ((referencePoint.timestamp - meta.startTime) / (meta.endTime - meta.startTime)) * meta.plotWidth;

  const tooltip = $('.chart-tooltip', wrapper);
  const line = $('.chart-hover-line', wrapper);
  tooltip.replaceChildren();

  const time = document.createElement('strong');
  time.className = 'chart-tooltip-time';
  time.textContent = formatHoverTime(referencePoint.timestamp);
  tooltip.append(time);

  for (const sample of samples) {
    const row = document.createElement('div');
    row.className = 'chart-tooltip-row';

    const label = document.createElement('span');
    label.className = 'chart-tooltip-label';
    const dot = document.createElement('span');
    dot.className = 'chart-tooltip-dot';
    dot.style.backgroundColor = sample.series.color;
    label.append(dot, document.createTextNode(sample.series.label));

    const value = document.createElement('span');
    value.className = 'chart-tooltip-value';
    value.textContent = formatChartValue(sample.point.value, meta.unit);
    row.append(label, value);
    tooltip.append(row);
  }

  line.hidden = false;
  line.style.left = `${lineX}px`;
  line.style.top = `${meta.plot.top}px`;
  line.style.height = `${meta.plot.bottom - meta.plot.top}px`;

  tooltip.hidden = false;
  let tooltipLeft = lineX + 12;
  const tooltipWidth = tooltip.offsetWidth;
  if (tooltipLeft + tooltipWidth > wrapper.clientWidth - 6) tooltipLeft = lineX - tooltipWidth - 12;
  tooltip.style.left = `${Math.max(6, tooltipLeft)}px`;
  tooltip.style.top = `${Math.max(6, meta.plot.top + 4)}px`;
}

function renderCharts() {
  drawTimeChart($('#loop-chart'), [
    { key: 'loopTimeAvg', label: 'Average', colorVariable: '--accent' },
    { key: 'loopTimeMax', label: 'Maximum', colorVariable: '--warning' },
  ], 'us');
  drawTimeChart($('#rssi-chart'), [
    { key: 'rssi', label: 'RSSI', colorVariable: '--accent' },
  ]);
}

function setMapStatus(message, tone = '') {
  const status = $('#map-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('has-fix', tone === 'success');
  status.classList.toggle('error', tone === 'error');
}

function isValidTelemetryPosition(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

function initializeMap() {
  const container = $('#telemetry-map');
  if (!container) return;

  if (!window.L) {
    setMapStatus('Map library failed to load. Check this client\'s internet connection.', 'error');
    return;
  }

  telemetryMap = window.L.map(container, {
    center: MAP_DEFAULT_CENTER,
    zoom: MAP_ZOOM,
    minZoom: 1,
    maxZoom: MAP_ZOOM,
    zoomControl: true,
    preferCanvas: true,
  });

  mapTileLayer = window.L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: '&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      maxZoom: MAP_ZOOM,
      maxNativeZoom: 19,
    },
  ).addTo(telemetryMap);

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#42b8ff';
  mapTrailLayer = window.L.polyline([], {
    color: accent,
    weight: 3,
    opacity: 0.85,
    interactive: false,
  }).addTo(telemetryMap);

  mapTileLayer.on('tileerror', () => {
    if (mapTileError) return;
    mapTileError = true;
    setMapStatus('Satellite imagery could not be loaded by this browser.', 'error');
  });

  telemetryMap.on('zoomend', () => setText('map-zoom', telemetryMap.getZoom()));
  setText('map-zoom', telemetryMap.getZoom());
  requestAnimationFrame(() => telemetryMap.invalidateSize({ pan: false }));
}

function setOrientationStatus(message, tone = '') {
  const status = $('#orientation-status');
  if (!status) return;
  if (message === null) {
    status.classList.add('hidden');
    return;
  }
  status.textContent = message;
  status.classList.remove('hidden');
  status.classList.toggle('error', tone === 'error');
}

async function initializeOrientationView() {
  const container = $('#orientation-canvas');
  if (!container) return;

  try {
    orientationModule = await import('./orientation-view.js');
  } catch {
    setOrientationStatus('3D library failed to load. Check this client\'s internet connection.', 'error');
    return;
  }

  orientationView = orientationModule.createOrientationView(container);
  orientationView.loadModel();
  setOrientationStatus('Loading 3D model...');

  const pollLoadStatus = () => {
    if (!orientationView) return;
    if (orientationView.state.loaded) {
      setOrientationStatus(null);
    } else if (orientationView.state.loadError) {
      setOrientationStatus(`Showing placeholder - model failed to load (${orientationView.state.loadError})`, 'error');
    } else if (orientationView.state.loading) {
      const percent = Math.round(orientationView.state.loadProgress * 100);
      setOrientationStatus(`Loading 3D model... ${percent}%`);
      window.setTimeout(pollLoadStatus, 200);
    }
  };
  window.setTimeout(pollLoadStatus, 200);
}

function updateTelemetryMap(decoded) {
  const latitude = Number(decoded.latitude);
  const longitude = Number(decoded.longitude);

  setText('map-latitude', Number.isFinite(latitude) ? latitude.toFixed(7) : '--');
  setText('map-longitude', Number.isFinite(longitude) ? longitude.toFixed(7) : '--');

  if (!isValidTelemetryPosition(latitude, longitude)) {
    setMapStatus('Waiting for a non-zero GPS position');
    return;
  }

  if (!telemetryMap) initializeMap();
  if (!telemetryMap) return;

  const position = window.L.latLng(latitude, longitude);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#42b8ff';

  if (!mapPositionMarker) {
    mapPositionMarker = window.L.circleMarker(position, {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: accent,
      fillOpacity: 0.9,
      className: 'drone-position-marker',
    }).addTo(telemetryMap);
  } else {
    mapPositionMarker.setLatLng(position);
  }

  mapPositionMarker.bindTooltip(
    `Drone<br>${latitude.toFixed(7)}, ${longitude.toFixed(7)}`,
    { direction: 'top', offset: [0, -8] },
  );

  if (!lastMapPosition || telemetryMap.distance(lastMapPosition, position) >= 0.25) {
    mapTrailCoordinates.push(position);
    if (mapTrailCoordinates.length > MAP_MAX_TRAIL_POINTS) {
      mapTrailCoordinates.splice(0, mapTrailCoordinates.length - MAP_MAX_TRAIL_POINTS);
    }
    mapTrailLayer.setLatLngs(mapTrailCoordinates);
  }

  const firstFix = lastMapPosition === null;
  lastMapPosition = position;
  $('#map-recenter').disabled = false;

  if (firstFix || $('#map-follow').checked) {
    telemetryMap.setView(position, MAP_ZOOM, { animate: false });
  }

  setText('map-zoom', telemetryMap.getZoom());
  setMapStatus(
    mapTileError ? 'GPS position received; satellite imagery is unavailable.' : 'Tracking latest GPS position',
    mapTileError ? 'error' : 'success',
  );
}

// Fires once per connection, as soon as the first telemetry sample tells us
// whether the vehicle is in FLIGHT - configuration reads (and especially
// writes) shouldn't happen while it's flying.
function maybeAutoReadConfig(currentMode) {
  if (state.autoConfigReadDone || currentMode === undefined || currentMode === null) return;
  state.autoConfigReadDone = true;

  if (currentMode === DRONE_STATES.FLIGHT) {
    showToast('Skipped automatic config read: vehicle is in FLIGHT', 'warning');
    return;
  }

  sendConfigRead();
}

function updateOrientationView(decoded) {
  const { qR, qI, qJ, qK, velX, velY, velZ, accelX, accelY, accelZ } = decoded;
  const hasQuaternion = [qR, qI, qJ, qK].every(Number.isFinite);
  const hasVelocity = [velX, velY, velZ].every(Number.isFinite);
  const hasAcceleration = [accelX, accelY, accelZ].every(Number.isFinite);

  if (hasQuaternion && orientationModule) {
    const euler = orientationModule.quaternionToEulerDegrees(qR, qI, qJ, qK);
    setText('orientation-roll', `${euler.roll.toFixed(1)}°`);
    setText('orientation-pitch', `${euler.pitch.toFixed(1)}°`);
    setText('orientation-yaw', `${euler.yaw.toFixed(1)}°`);
  }
  if (hasVelocity) {
    setText('orientation-velocity', `${Math.hypot(velX, velY, velZ).toFixed(2)} m/s`);
  }
  if (hasAcceleration) {
    setText('orientation-accel', `${Math.hypot(accelX, accelY, accelZ).toFixed(2)} m/s²`);
  }

  if (!orientationView) return;
  if (hasQuaternion) orientationView.updateOrientation(qR, qI, qJ, qK);
  if (hasVelocity) orientationView.updateVelocity(velX, velY, velZ);
  if (hasAcceleration) orientationView.updateAcceleration(accelX, accelY, accelZ);
}

function updateTelemetry(decoded) {
  state.lastTelemetry = decoded;
  state.lastTelemetryAt = performance.now();
  const chartTimestamp = Date.now();

  maybeAutoReadConfig(decoded.currentMode);

  setText('metric-loop-avg', `${decoded.loopTimeAvg ?? '--'} us`);
  setText('metric-loop-max', `Max ${decoded.loopTimeMax ?? '--'} us`);
  setText('metric-rssi', decoded.rssi ?? '--');
  setText('metric-mode', formatDroneState(decoded.currentMode));
  setText('metric-runtime', formatRuntime(decoded.runTime));
  setText('metric-voltage', decoded.voltage ?? '--');
  setText('metric-motors', `${decoded.motor1Set ?? '--'} / ${decoded.motor2Set ?? '--'}`);
  setText('metric-gimbal', `${decoded.gimbalPitch ?? '--'} / ${decoded.gimbalYaw ?? '--'}`);
  setText('loop-chart-latest-avg', formatChartValue(Number(decoded.loopTimeAvg), 'us'));
  setText('loop-chart-latest-max', formatChartValue(Number(decoded.loopTimeMax), 'us'));
  setText('rssi-chart-latest', formatChartValue(Number(decoded.rssi)));
  updateTelemetryMap(decoded);
  updateOrientationView(decoded);

  const telemetryTable = $('#telemetry-table-body');
  telemetryTable.innerHTML = '';
  for (const field of telemetrySchema.fields) {
    const row = document.createElement('tr');
    row.dataset.group = field.group;
    const displayValue = field.key === 'currentMode'
      ? formatDroneState(decoded[field.key])
      : formatFieldValue(field, decoded[field.key]);
    row.innerHTML = `
      <td>${escapeHtml(field.group)}</td>
      <td>${escapeHtml(field.label)}</td>
      <td class="value-cell">${escapeHtml(displayValue)}</td>
      <td>${escapeHtml(field.unit || '')}</td>
    `;
    telemetryTable.append(row);
  }

  addHistory('loopTimeAvg', decoded.loopTimeAvg, chartTimestamp);
  addHistory('loopTimeMax', decoded.loopTimeMax, chartTimestamp);
  addHistory('rssi', decoded.rssi, chartTimestamp);
  renderCharts();
}

function updatePacketRate() {
  const now = performance.now();
  state.packetTimes = state.packetTimes.filter((time) => now - time <= 1000);
  setText('metric-packet-rate', `${state.packetTimes.length} pkt/s`);
  setText('metric-rx', state.rxPackets);
  setText('metric-tx', state.txPackets);
  setText('metric-errors', state.badFrames);
  setText('last-telemetry-age', formatAge(state.lastTelemetryAt));
}

function resolvePacketSchema(packet) {
  return { effectiveType: packet.type, schema: getSchemaById(packet.type) };
}

function handlePacket(packet) {
  state.rxPackets += 1;
  state.packetTimes.push(performance.now());

  const { effectiveType, schema } = resolvePacketSchema(packet);
  let decoded = null;
  let decodeError = '';

  try {
    decoded = decodePayload(schema, packet.payload);
  } catch (error) {
    decodeError = error.message;
    state.badFrames += 1;
  }

  if (!decodeError && effectiveType === USB_MESSAGE_TYPES.TELEMETRY) updateTelemetry(decoded);
  if (!decodeError && effectiveType === USB_MESSAGE_TYPES.DEBUG_TEXT) appendTerminal(decoded.text, 'rx');
  if (!decodeError && effectiveType === USB_MESSAGE_TYPES.CONFIG) updateConfigFromResponse(decoded);
  if (!decodeError && effectiveType === USB_MESSAGE_TYPES.RADIO_PACKET) handleRadioPacket(decoded);
  if (!decodeError && effectiveType === USB_MESSAGE_TYPES.RAW) handleRawPacket(packet.payload);

  addPacketRow({
    direction: 'RX',
    packetNumber: packet.packetNumber,
    type: packet.type,
    effectiveType,
    typeName: schema?.name ?? `Unknown (${packet.type})`,
    length: packet.payloadLength,
    payload: packet.payload,
    decoded,
    version: packet.version ?? PROTOCOL_VERSION,
    crc: packet.crc ?? null,
    crcValid: packet.crcValid ?? true,
    raw: packet.raw ?? null,
    note: decodeError,
    timestamp: new Date(),
  });
  updatePacketRate();
}

function handleRawPacket(payload) {
  // The only thing dashboard-inbound RAW frames mean right now is an
  // identify-handshake reply (a single device-kind byte).
  if (payload.length !== 1 || !state.pendingIdentifyResolve) return;
  state.pendingIdentifyResolve(payload[0]);
  state.pendingIdentifyResolve = null;
}

function handleRadioPacket(decoded) {
  const { radioMessageType, decodedMessage, direction, rssi } = decoded;
  if (direction !== 'received') return; // ignore the relay's own sent-confirmation mirrors

  if (rssi !== null) setText('metric-downlink-rssi', String(rssi));

  if (radioMessageType >= RADIO_MESSAGE_TYPES.STATUS0 && radioMessageType <= RADIO_MESSAGE_TYPES.STATUS6) {
    applyRadioStatusToTelemetry(state.relayTelemetry, radioMessageType, decodedMessage);
    updateTelemetry(state.relayTelemetry);
  }

  if (radioMessageType === RADIO_MESSAGE_TYPES.CONFIG && state.pendingRadioConfigResolve) {
    state.pendingRadioConfigResolve(decodedMessage);
    state.pendingRadioConfigResolve = null;
  }
}

function summarizeDecoded(decoded) {
  if (!decoded) return '';
  if (typeof decoded.text === 'string') return decoded.text.replace(/\s+/g, ' ').slice(0, 80);
  return Object.entries(decoded)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(', ');
}

function addPacketRow(packet) {
  state.packetRows.unshift(packet);
  if (state.packetRows.length > 250) state.packetRows.length = 250;
  renderPacketRows();
}

function renderPacketRows() {
  const tbody = $('#packet-table-body');
  const filter = $('#packet-filter').value;
  tbody.innerHTML = '';

  const rows = state.packetRows.filter((row) => filter === 'all' || row.direction.toLowerCase() === filter);
  for (const row of rows.slice(0, 100)) {
    const tr = document.createElement('tr');
    const typeLabel = row.type === row.effectiveType ? `${row.typeName} (${row.type})` : `${row.typeName} (${row.type}->${row.effectiveType})`;
    tr.innerHTML = `
      <td>${row.timestamp.toLocaleTimeString()}</td>
      <td><span class="direction-pill ${row.direction.toLowerCase()}">${row.direction}</span></td>
      <td>${row.packetNumber}</td>
      <td>${escapeHtml(typeLabel)}</td>
      <td>${row.length}</td>
      <td class="packet-summary">${escapeHtml(row.note || summarizeDecoded(row.decoded) || bytesToHex(row.payload).slice(0, 80))}</td>
      <td><button class="secondary small inspect-packet" type="button">Inspect</button></td>
    `;
    $('.inspect-packet', tr).addEventListener('click', () => inspectPacket(row));
    tbody.append(tr);
  }
}

function inspectPacket(row) {
  $('#packet-dialog-title').textContent = `${row.direction} ${row.typeName} packet #${row.packetNumber}`;
  const crcText = row.crc === null || row.crc === undefined
    ? 'CRC unavailable'
    : `CRC 0x${row.crc.toString(16).padStart(4, '0').toUpperCase()} ${row.crcValid ? 'valid' : 'invalid'}`;
  $('#packet-dialog-meta').textContent = `${row.length} payload bytes | Version ${row.version ?? PROTOCOL_VERSION} | Type ${row.type} | ${crcText}`;
  $('#packet-dialog-frame').textContent = row.raw ? bytesToHex(row.raw) : '(complete frame unavailable)';
  $('#packet-dialog-hex').textContent = bytesToHex(row.payload) || '(empty payload)';
  $('#packet-dialog-decoded').textContent = row.decoded ? JSON.stringify(row.decoded, null, 2) : row.note || 'No schema available';
  $('#packet-dialog').showModal();
}

function appendTerminal(text, direction = 'system') {
  const terminal = $('#terminal-output');
  const line = document.createElement('div');
  line.className = `terminal-line ${direction}`;
  const prefix = direction === 'rx' ? 'RX' : direction === 'tx' ? 'TX' : '--';
  line.innerHTML = `<span class="terminal-time">${new Date().toLocaleTimeString()}</span><span class="terminal-direction">${prefix}</span><span>${escapeHtml(String(text))}</span>`;
  terminal.append(line);
  while (terminal.children.length > 500) terminal.firstElementChild.remove();
  terminal.scrollTop = terminal.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function sendFrame(type, payload, decoded = null, label = null) {
  let frame;
  let packetNumber;

  if (state.demoRunning && !state.connected) {
    packetNumber = state.txPackets & 0xffff;
    frame = buildPacket(packetNumber, type, payload);
  } else {
    frame = await link.send(type, payload);
    packetNumber = new DataView(frame.buffer).getUint16(PACKET_NUMBER_OFFSET, true);
  }

  state.txPackets += 1;
  addPacketRow({
    direction: 'TX',
    packetNumber,
    type,
    effectiveType: type,
    typeName: label || getSchemaById(type)?.name || `Unknown (${type})`,
    length: payload.length,
    payload,
    decoded,
    version: PROTOCOL_VERSION,
    crc: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(frame.byteLength - CRC_SIZE, true),
    crcValid: true,
    raw: frame,
    note: state.demoRunning && !state.connected ? 'Demo mode - not transmitted' : '',
    timestamp: new Date(),
  });
  updatePacketRate();
  return frame;
}

function commandValuesFromForm(forceMotorsOff = false) {
  const motorsEnabled = $('#motor-enable').checked && !forceMotorsOff;
  return {
    flags: {
      targSlot: Number($('input[name="target-slot"]:checked').value) === 1,
      activeSlot: Number($('input[name="active-slot"]:checked').value) === 1,
    },
    gimbalX: Number($('#gimbal-x').value),
    gimbalY: Number($('#gimbal-y').value),
    motor0Speed: motorsEnabled ? Number($('#motor-0').value) : 0,
    motor1Speed: motorsEnabled ? Number($('#motor-1').value) : 0,
    unused: 0,
  };
}

async function sendCommand(forceMotorsOff = false) {
  try {
    if (!state.connected && !state.demoRunning) throw new Error('Connect the server serial port or start demo mode first');
    const values = commandValuesFromForm(forceMotorsOff);
    if (state.linkMode === 'relay') {
      const envelope = encodeRadioCommandEnvelope(values);
      await sendFrame(USB_MESSAGE_TYPES.RADIO_PACKET, envelope, values, 'Radio Command');
    } else {
      const payload = encodePayload(commandSchema, values);
      await sendFrame(commandSchema.id, payload, values);
    }
    setText('last-command-status', `Sent at ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    showToast(error.message, 'error');
    setText('last-command-status', error.message);
  }
}

function syncRangePair(rangeId, numberId) {
  const range = document.getElementById(rangeId);
  const number = document.getElementById(numberId);
  range.addEventListener('input', () => { number.value = range.value; });
  number.addEventListener('input', () => { range.value = number.value; });
}

function updateLiveSend() {
  window.clearInterval(state.liveTimer);
  state.liveTimer = null;
  const enabled = $('#live-send').checked;
  const rate = Math.max(1, Math.min(50, Number($('#live-rate').value) || 10));
  if (enabled) state.liveTimer = window.setInterval(() => sendCommand(false), 1000 / rate);
}

async function emergencyStop() {
  $('#live-send').checked = false;
  $('#motor-enable').checked = false;
  $('#motor-0').value = '0';
  $('#motor-0-number').value = '0';
  $('#motor-1').value = '0';
  $('#motor-1-number').value = '0';
  updateLiveSend();
  await sendCommand(true);
  showToast('Zero-speed command sent and live transmission disabled', 'warning');
}

function renderGenericBuilder() {
  const select = $('#schema-select');
  select.innerHTML = '';
  for (const schema of getOutboundSchemas()) {
    const option = document.createElement('option');
    option.value = String(schema.id);
    option.textContent = `${schema.name} (type ${schema.id})`;
    select.append(option);
  }
  const rawOption = document.createElement('option');
  rawOption.value = 'raw-custom';
  rawOption.textContent = 'Raw payload';
  select.append(rawOption);
  renderSchemaFields();
}

function renderSchemaFields() {
  const container = $('#schema-fields');
  container.innerHTML = '';
  const selection = $('#schema-select').value;

  if (selection === 'raw-custom') {
    container.innerHTML = `
      <label class="field">
        <span>Packet type</span>
        <input id="raw-type" type="number" min="0" max="255" value="0">
      </label>
      <label class="field field-span-2">
        <span>Payload bytes (hex)</span>
        <textarea id="raw-payload" rows="4" placeholder="01 02 ff 10"></textarea>
      </label>
    `;
    return;
  }

  const schema = getSchemaById(Number(selection));
  for (const field of schema.fields ?? []) {
    if (field.hidden) continue;
    if (field.type === 'bitfield8') {
      const group = document.createElement('fieldset');
      group.className = 'field bitfield-group';
      group.dataset.fieldKey = field.key;
      group.innerHTML = `<legend>${escapeHtml(field.label)}</legend>`;
      for (const bit of field.bits ?? []) {
        const label = document.createElement('label');
        label.className = 'check-row';
        label.innerHTML = `<input type="checkbox" data-bit-key="${escapeHtml(bit.key)}" ${bit.default ? 'checked' : ''}><span>${escapeHtml(bit.label)} (bit ${bit.bit})</span>`;
        group.append(label);
      }
      container.append(group);
      continue;
    }

    const label = document.createElement('label');
    label.className = 'field';
    label.dataset.fieldKey = field.key;
    label.dataset.fieldType = field.type;
    const inputType = field.type === 'string' || field.type === 'bytes' ? 'text' : 'number';
    const value = field.default ?? 0;
    label.innerHTML = `
      <span>${escapeHtml(field.label)}</span>
      <input type="${inputType}" value="${escapeHtml(value)}"
        ${field.min !== undefined ? `min="${field.min}"` : ''}
        ${field.max !== undefined ? `max="${field.max}"` : ''}
        ${field.step !== undefined ? `step="${field.step}"` : ''}>
    `;
    container.append(label);
  }
}

function genericBuilderValues(schema) {
  const values = {};
  for (const field of schema.fields ?? []) {
    if (field.hidden) {
      values[field.key] = field.default ?? 0;
      continue;
    }
    if (field.type === 'bitfield8') {
      const group = $(`[data-field-key="${field.key}"]`, $('#schema-fields'));
      values[field.key] = {};
      for (const bit of field.bits ?? []) {
        values[field.key][bit.key] = $(`[data-bit-key="${bit.key}"]`, group).checked;
      }
    } else {
      const wrapper = $(`[data-field-key="${field.key}"]`, $('#schema-fields'));
      const input = $('input, textarea', wrapper);
      values[field.key] = field.type === 'string' || field.type === 'bytes' ? input.value : Number(input.value);
    }
  }
  return values;
}

async function sendGenericPacket() {
  try {
    if (!state.connected && !state.demoRunning) throw new Error('Connect the server serial port or start demo mode first');
    const selection = $('#schema-select').value;
    let type;
    let payload;
    let decoded;
    let label;

    if (selection === 'raw-custom') {
      type = Number($('#raw-type').value);
      payload = hexToBytes($('#raw-payload').value);
      decoded = { raw: bytesToHex(payload) };
      label = 'Raw payload';
    } else {
      const schema = getSchemaById(Number(selection));
      decoded = genericBuilderValues(schema);
      payload = encodePayload(schema, decoded);
      type = schema.id;
      label = schema.name;
    }

    const frame = await sendFrame(type, payload, decoded, label);
    $('#builder-preview').textContent = bytesToHex(frame);
    showToast(`${label} packet sent`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderConfigForm() {
  const tbody = $('#config-table-body');
  tbody.innerHTML = '';
  for (const entry of CONFIG_KEYS) {
    const tr = document.createElement('tr');
    tr.dataset.configId = String(entry.id);

    const nameCell = document.createElement('td');
    nameCell.textContent = entry.unit ? `${entry.label} (${entry.unit})` : entry.label;

    const effectCell = document.createElement('td');
    effectCell.className = 'config-effect';
    effectCell.textContent = entry.effect;

    const currentCell = document.createElement('td');
    currentCell.className = 'value-cell config-current';
    currentCell.textContent = '--';

    const inputCell = document.createElement('td');
    inputCell.className = 'config-input-cell';
    const input = document.createElement('input');
    if (entry.kind === 'bool') {
      input.type = 'checkbox';
      input.checked = Boolean(entry.default);
    } else {
      input.type = 'number';
      input.min = String(entry.min);
      input.max = String(entry.max);
      input.step = '1';
      input.value = String(entry.default);
    }
    input.addEventListener('input', () => state.configTouched.add(entry.id));
    inputCell.append(input);

    const statusCell = document.createElement('td');
    const statusPill = document.createElement('span');
    statusPill.className = 'config-status';
    statusPill.textContent = 'Unknown';
    statusCell.append(statusPill);

    tr.append(nameCell, effectCell, currentCell, inputCell, statusCell);
    tbody.append(tr);
  }
}

function configInput(id) {
  return $(`tr[data-config-id="${id}"] .config-input-cell input`, $('#config-table-body'));
}

function configStatusPill(id) {
  return $(`tr[data-config-id="${id}"] .config-status`, $('#config-table-body'));
}

function configCurrentCell(id) {
  return $(`tr[data-config-id="${id}"] .config-current`, $('#config-table-body'));
}

function setConfigStatus(id, text, tone = '') {
  const pill = configStatusPill(id);
  if (!pill) return;
  pill.textContent = text;
  pill.className = `config-status ${tone}`;
}

function configEntryValue(entry) {
  const input = configInput(entry.id);
  return entry.kind === 'bool' ? (input.checked ? 1 : 0) : Number(input.value);
}

// Radio CONFIG only carries one key per message. requestRadioConfigEntry
// sends one such request and resolves with the decoded single-key reply, or
// null if every retry times out - sendRadioConfigSequence (radio-relay.js)
// calls this once per key, sequentially, awaiting each reply before sending
// the next.
async function requestRadioConfigEntryOnce(operation, key, value) {
  const envelope = encodeRadioConfigEnvelope(operation, key, value);
  const replyPromise = new Promise((resolve) => {
    state.pendingRadioConfigResolve = resolve;
  });
  await sendFrame(USB_MESSAGE_TYPES.RADIO_PACKET, envelope, { operation, key, value }, 'Radio Config');

  const timeoutPromise = new Promise((resolve) => {
    window.setTimeout(() => resolve(null), RADIO_CONFIG_REQUEST_TIMEOUT_MS);
  });
  const reply = await Promise.race([replyPromise, timeoutPromise]);
  state.pendingRadioConfigResolve = null;
  return reply;
}

async function requestRadioConfigEntry(operation, key, value) {
  let reply = null;
  for (let attempt = 0; attempt < RADIO_CONFIG_MAX_ATTEMPTS && reply === null; attempt += 1) {
    reply = await requestRadioConfigEntryOnce(operation, key, value);
  }
  return reply;
}

function applyRadioConfigReply(operation, key, reply) {
  const entry = getConfigKeyById(key);
  if (!entry) return;

  if (!reply) {
    setConfigStatus(entry.id, 'No response', 'error');
    return;
  }

  const result = reply.state;
  const tone = result === CONFIG_RESULTS.OK ? 'ok' : 'error';
  setConfigStatus(entry.id, CONFIG_RESULT_LABELS[result] ?? `Unknown (${result})`, tone);

  if (operation === CONFIG_OPS.READ && result === CONFIG_RESULTS.OK) {
    const currentCell = configCurrentCell(entry.id);
    if (currentCell) currentCell.textContent = String(reply.value);
    if (!state.configTouched.has(entry.id)) {
      const input = configInput(entry.id);
      if (input) {
        if (entry.kind === 'bool') input.checked = Boolean(reply.value);
        else input.value = String(reply.value);
      }
    }
  }
}

async function sendConfigRead() {
  if (state.configSequenceBusy) {
    showToast('A config request is already in progress', 'warning');
    return;
  }
  state.configSequenceBusy = true;
  try {
    if (!state.connected && !state.demoRunning) throw new Error('Connect the server serial port or start demo mode first');
    for (const entry of CONFIG_KEYS) setConfigStatus(entry.id, 'Reading...', 'pending');

    if (state.linkMode === 'relay') {
      const entries = CONFIG_KEYS.map((entry) => ({ key: entry.id }));
      await sendRadioConfigSequence(CONFIG_OPS.READ, entries, requestRadioConfigEntry,
        (key, reply) => applyRadioConfigReply(CONFIG_OPS.READ, key, reply));
      return;
    }

    const values = { operation: CONFIG_OPS.READ, entries: CONFIG_KEYS.map((entry) => ({ key: entry.id })) };
    const payload = encodePayload(configSchema, values);
    state.pendingDirectConfigRequest = true;
    await sendFrame(configSchema.id, payload, values, 'Config Read');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.configSequenceBusy = false;
  }
}

function validateConfigForm() {
  let valid = true;
  for (const entry of CONFIG_KEYS) {
    const input = configInput(entry.id);
    if (entry.kind === 'bool') {
      input.classList.remove('invalid');
      continue;
    }
    const value = Number(input.value);
    const outOfRange = !Number.isFinite(value) || value < entry.min || value > entry.max;
    input.classList.toggle('invalid', outOfRange);
    if (outOfRange) valid = false;
  }
  return valid;
}

async function sendConfigApply() {
  if (state.configSequenceBusy) {
    showToast('A config request is already in progress', 'warning');
    return;
  }
  state.configSequenceBusy = true;
  try {
    if (!state.connected && !state.demoRunning) throw new Error('Connect the server serial port or start demo mode first');
    if (!validateConfigForm()) throw new Error('Fix out-of-range values before applying');
    for (const entry of CONFIG_KEYS) setConfigStatus(entry.id, 'Sending...', 'pending');

    if (state.linkMode === 'relay') {
      const entries = CONFIG_KEYS.map((entry) => ({ key: entry.id, value: configEntryValue(entry) }));
      await sendRadioConfigSequence(CONFIG_OPS.SET, entries, requestRadioConfigEntry,
        (key, reply) => applyRadioConfigReply(CONFIG_OPS.SET, key, reply));
      return;
    }

    const values = {
      operation: CONFIG_OPS.SET,
      entries: CONFIG_KEYS.map((entry) => ({ key: entry.id, value: configEntryValue(entry) })),
    };
    const payload = encodePayload(configSchema, values);
    state.pendingDirectConfigRequest = true;
    await sendFrame(configSchema.id, payload, values, 'Config Set');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.configSequenceBusy = false;
  }
}

async function sendConfigZeroAll() {
  if (!window.confirm('Reset every persistent configuration value to its firmware default?')) return;
  if (state.configSequenceBusy) {
    showToast('A config request is already in progress', 'warning');
    return;
  }
  state.configSequenceBusy = true;
  try {
    if (!state.connected && !state.demoRunning) throw new Error('Connect the server serial port or start demo mode first');
    for (const entry of CONFIG_KEYS) setConfigStatus(entry.id, 'Resetting...', 'pending');

    if (state.linkMode === 'relay') {
      // Radio CONFIG has no batch form; send one placeholder zero-all request.
      // The firmware doesn't implement ZERO_ALL over radio yet either, so
      // this predictably comes back UNKNOWN_OP - same as direct mode today.
      await sendRadioConfigSequence(CONFIG_OPS.ZERO_ALL, [{ key: 0 }], requestRadioConfigEntry,
        (key, reply) => applyRadioConfigReply(CONFIG_OPS.ZERO_ALL, key, reply));
      return;
    }

    const values = { operation: CONFIG_OPS.ZERO_ALL, entries: [] };
    const payload = encodePayload(configSchema, values);
    state.pendingDirectConfigRequest = true;
    await sendFrame(configSchema.id, payload, values, 'Config Zero All');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.configSequenceBusy = false;
  }
}

function updateConfigFromResponse(decoded) {
  // The firmware's COMMAND handler can fall through into the CONFIG handler
  // on old builds, emitting a spurious type-5 reply after a plain command -
  // and that spurious reply's operation tag is indistinguishable from a real
  // one. Only act on it if we actually asked for a direct config response.
  if (!state.pendingDirectConfigRequest) return;
  if (decoded.operation !== CONFIG_OPS.READ_RESPONSE && decoded.operation !== CONFIG_OPS.SET_RESPONSE) return;
  state.pendingDirectConfigRequest = false;

  state.configSyncedAt = performance.now();
  setText('config-sync-status', `Synced ${new Date().toLocaleTimeString()}`);

  for (const status of decoded.statuses) {
    const entry = getConfigKeyById(status.key);
    if (!entry) continue;

    const tone = status.result === CONFIG_RESULTS.OK ? 'ok' : 'error';
    setConfigStatus(entry.id, CONFIG_RESULT_LABELS[status.result] ?? `Unknown (${status.result})`, tone);

    if (decoded.operation === CONFIG_OPS.READ_RESPONSE && status.value !== undefined) {
      const currentCell = configCurrentCell(entry.id);
      if (currentCell) currentCell.textContent = String(status.value);
      if (!state.configTouched.has(entry.id)) {
        const input = configInput(entry.id);
        if (input) {
          if (entry.kind === 'bool') input.checked = Boolean(status.value);
          else input.value = String(status.value);
        }
      }
    }
  }

  if (decoded.result !== CONFIG_RESULTS.OK) {
    showToast(`Config request rejected: ${CONFIG_RESULT_LABELS[decoded.result] ?? decoded.result}`, 'error');
  }
}

function generateDemoTelemetry() {
  const t = performance.now() / 1000;
  const values = {
    loopTimeAvg: Math.round(920 + Math.sin(t * 1.7) * 35),
    loopTimeMax: Math.round(1320 + Math.sin(t * 0.8) * 95),
    runTime: Math.floor(t) & 0xffff,
    rssi: Math.round(72 + Math.sin(t * 0.4) * 7),
    currentMode: Math.floor(t / 8) % 4,
    gimbalPitch: Math.round(Math.sin(t * 0.7) * 1200),
    gimbalYaw: Math.round(Math.cos(t * 0.6) * 1600),
    topServoSet: Math.round(Math.sin(t * 0.7) * 900),
    bottomServoSet: Math.round(Math.cos(t * 0.6) * 900),
    motor1Set: Math.round(80 + Math.sin(t * 0.5) * 15),
    motor2Set: Math.round(82 + Math.cos(t * 0.5) * 15),
    voltage: 0,
    // A slowly-tumbling, genuinely normalized quaternion (axis-angle about a
    // fixed diagonal axis) - qR/qI/qJ/qK are dimensionless [-1, 1], scaled to
    // Q15 on the wire by encodePayload.
    ...(() => {
      const angle = t * 0.4;
      const axis = { x: 0.5, y: 0.5, z: 1 / Math.sqrt(2) }; // already unit length
      const half = Math.sin(angle / 2);
      return {
        qR: Math.cos(angle / 2),
        qI: axis.x * half,
        qJ: axis.y * half,
        qK: axis.z * half,
      };
    })(),
    // World-frame, gravity-compensated (per gyro.cpp) - oscillates around
    // zero rather than showing a standing 1g offset. Units: m/s^2, m/s.
    accelX: Math.sin(t) * 1.8,
    accelY: Math.cos(t * 0.9) * 1.6,
    accelZ: Math.sin(t * 1.3) * 0.6,
    velX: Math.sin(t * 0.4) * 2.5,
    velY: Math.cos(t * 0.4) * 2.5,
    velZ: Math.sin(t * 0.2) * 0.4,
    posX: Math.round(Math.sin(t * 0.1) * 100),
    posY: Math.round(Math.cos(t * 0.1) * 100),
    posZ: 15,
    latitude: 47.1164,
    longitude: -88.5385,
  };
  const payload = encodePayload(telemetrySchema, values);
  const raw = buildPacket(state.rxPackets & 0xffff, USB_MESSAGE_TYPES.TELEMETRY, payload);
  handlePacket({
    version: PROTOCOL_VERSION,
    packetNumber: state.rxPackets & 0xffff,
    type: USB_MESSAGE_TYPES.TELEMETRY,
    payloadLength: payload.length,
    payload,
    crc: new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint16(raw.byteLength - CRC_SIZE, true),
    crcValid: true,
    raw,
    receivedAt: performance.now(),
  });
}

function toggleDemo() {
  if (state.connected) {
    showToast('Disconnect the server serial port before starting demo mode', 'warning');
    return;
  }
  state.demoRunning = !state.demoRunning;
  window.clearInterval(state.demoTimer);
  state.demoTimer = null;

  if (state.demoRunning) {
    state.linkMode = 'direct';
    state.linkModeKnown = true;
    updateLinkModeDisplay();
    state.demoTimer = window.setInterval(generateDemoTelemetry, 100);
    $('#demo-button').textContent = 'Stop Demo';
    setConnectionStatus(false, 'Demo');
    generateDemoTelemetry();
    appendTerminal('Demo telemetry started', 'system');
  } else {
    resetLinkMode();
    $('#demo-button').textContent = 'Demo Data';
    setConnectionStatus(false, 'Disconnected');
    appendTerminal('Demo telemetry stopped', 'system');
  }
}

function exportPacketLog() {
  const data = state.packetRows.map((row) => ({
    timestamp: row.timestamp.toISOString(),
    direction: row.direction,
    version: row.version,
    packetNumber: row.packetNumber,
    type: row.type,
    effectiveType: row.effectiveType,
    typeName: row.typeName,
    length: row.length,
    crc: row.crc,
    crcValid: row.crcValid,
    frameHex: row.raw ? bytesToHex(row.raw) : null,
    payloadHex: bytesToHex(row.payload),
    decoded: row.decoded,
    note: row.note,
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `aere-usb-packets-${new Date().toISOString().replaceAll(':', '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function bindTabs() {
  $$('.tab-button').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.tab-button').forEach((item) => item.classList.toggle('active', item === button));
      $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`));
      if (button.dataset.tab === 'dashboard') {
        renderCharts();
        if (telemetryMap) window.setTimeout(() => telemetryMap.invalidateSize({ pan: false }), 0);
      } else if (button.dataset.tab === 'orientation') {
        if (orientationView) window.setTimeout(() => orientationView.resize(), 0);
      }
    });
  });
}

function bindEvents() {
  $('#connect-button').addEventListener('click', () => {
    try {
      if (state.connected) {
        link.disconnect();
      } else {
        if (state.demoRunning) toggleDemo();
        const port = $('#serial-port').value;
        link.connect(port, Number($('#baud-rate').value));
        setText('metric-connection', 'Connecting...');
      }
    } catch (error) {
      showToast(error.message, 'error');
      appendTerminal(error.message, 'system');
    }
  });
  $('#refresh-ports').addEventListener('click', () => {
    try {
      link.listPorts();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  $('#serial-port').addEventListener('change', () => setConnectionStatus(state.connected));
  $('#demo-button').addEventListener('click', toggleDemo);
  $('#send-command').addEventListener('click', () => sendCommand(false));
  $('#emergency-stop').addEventListener('click', emergencyStop);
  $('#live-send').addEventListener('change', updateLiveSend);
  $('#live-rate').addEventListener('change', updateLiveSend);
  $('#schema-select').addEventListener('change', renderSchemaFields);
  $('#send-generic').addEventListener('click', sendGenericPacket);
  $('#config-read').addEventListener('click', sendConfigRead);
  $('#config-apply').addEventListener('click', sendConfigApply);
  $('#config-zero-all').addEventListener('click', sendConfigZeroAll);
  $('#packet-filter').addEventListener('change', renderPacketRows);
  $('#clear-packets').addEventListener('click', () => { state.packetRows = []; renderPacketRows(); });
  $('#export-packets').addEventListener('click', exportPacketLog);
  $('#clear-terminal').addEventListener('click', () => { $('#terminal-output').innerHTML = ''; });
  $('#packet-dialog-close').addEventListener('click', () => $('#packet-dialog').close());
  $('#map-recenter').addEventListener('click', () => {
    if (telemetryMap && lastMapPosition) telemetryMap.setView(lastMapPosition, MAP_ZOOM, { animate: false });
  });
  $('#map-follow').addEventListener('change', (event) => {
    if (event.target.checked && telemetryMap && lastMapPosition) {
      telemetryMap.setView(lastMapPosition, MAP_ZOOM, { animate: false });
    }
  });
  $('#map-clear-trail').addEventListener('click', () => {
    mapTrailCoordinates = lastMapPosition ? [lastMapPosition] : [];
    if (mapTrailLayer) mapTrailLayer.setLatLngs(mapTrailCoordinates);
  });

  $$('.chart-window-select').forEach((select) => {
    select.addEventListener('change', (event) => {
      state.chartWindowMs = Number(event.target.value) || 30_000;
      $$('.chart-window-select').forEach((otherSelect) => {
        otherSelect.value = String(state.chartWindowMs);
      });
      $$('.chart').forEach(hideChartTooltip);
      renderCharts();
    });
  });

  $$('.chart').forEach((canvas) => {
    canvas.addEventListener('pointermove', (event) => showChartTooltip(canvas, event));
    canvas.addEventListener('pointerleave', () => hideChartTooltip(canvas));
  });

  window.addEventListener('resize', () => {
    renderCharts();
    if (telemetryMap) telemetryMap.invalidateSize({ pan: false });
    if (orientationView) orientationView.resize();
  });

  syncRangePair('gimbal-x', 'gimbal-x-number');
  syncRangePair('gimbal-y', 'gimbal-y-number');
  syncRangePair('motor-0', 'motor-0-number');
  syncRangePair('motor-1', 'motor-1-number');
}

link.addEventListener('bridge', (event) => {
  const wasConnected = state.bridgeConnected;
  setBridgeStatus(event.detail.connected);
  if (event.detail.connected && !wasConnected) {
    appendTerminal('Connected to the server-side serial bridge', 'system');
  } else if (!event.detail.connected && wasConnected) {
    appendTerminal('Lost connection to the server-side serial bridge', 'system');
  }
});
link.addEventListener('ports', (event) => renderSerialPorts(event.detail.ports));
link.addEventListener('status', (event) => {
  const wasConnected = state.connected;
  state.currentPort = event.detail.port;
  setConnectionStatus(event.detail.connected);
  if (event.detail.connected) {
    if (!wasConnected) appendTerminal(`Server opened ${event.detail.port} at ${event.detail.baudRate} baud`, 'system');
    // Re-verify relay vs. direct on every connected status, even a redundant
    // one for an already-connected link - never assume a prior result still
    // applies (e.g. a new tab joining a session another client already
    // connected would otherwise never run the handshake at all).
    runIdentifyHandshake();
  } else if (wasConnected) {
    appendTerminal('Server serial port disconnected', 'system');
    resetLinkMode();
  }
});
link.addEventListener('packet', (event) => handlePacket(event.detail));
link.addEventListener('parseerror', (event) => {
  state.badFrames += event.detail.count;
  updatePacketRate();

  const details = [];
  if (event.detail.crcErrors) details.push(`${event.detail.crcErrors} CRC error(s)`);
  if (event.detail.versionErrors) details.push(`${event.detail.versionErrors} unsupported-version frame(s)`);
  const suffix = details.length ? `; ${details.join(', ')}` : '';
  appendTerminal(`Parser discarded ${event.detail.count} byte(s) while resynchronizing${suffix}`, 'system');

  for (const diagnostic of event.detail.diagnostics ?? []) {
    if (diagnostic.kind !== 'crc') continue;
    const received = diagnostic.receivedCrc.toString(16).padStart(4, '0').toUpperCase();
    const calculated = diagnostic.calculatedCrc.toString(16).padStart(4, '0').toUpperCase();
    appendTerminal(
      `CRC mismatch packet=${diagnostic.packetNumber} type=${diagnostic.type} length=${diagnostic.payloadLength} `
        + `received=0x${received} calculated=0x${calculated} input=[${bytesToHex(diagnostic.crcInput)}] `
        + `frame=[${bytesToHex(diagnostic.raw)}]`,
      'system',
    );
  }
});
link.addEventListener('error', (event) => {
  showToast(event.detail.message || String(event.detail), 'error');
  appendTerminal(event.detail.message || String(event.detail), 'system');
});

function initialize() {
  bindTabs();
  bindEvents();
  renderGenericBuilder();
  renderConfigForm();
  initializeMap();
  initializeOrientationView();
  setConnectionStatus(false);
  updatePacketRate();
  renderCharts();

  window.setInterval(updatePacketRate, 250);
  appendTerminal('Dashboard ready. Connecting to the server-side serial bridge...', 'system');
  appendTerminal(`Loaded ${PACKET_SCHEMAS.length} packet schemas.`, 'system');
  link.start();
}

initialize();
