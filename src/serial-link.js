import {
  SYNC_BYTES,
  PROTOCOL_VERSION,
  FRAME_PREFIX_SIZE,
  CRC_SIZE,
  MIN_FRAME_SIZE,
  PACKET_NUMBER_OFFSET,
  TYPE_OFFSET,
  LENGTH_OFFSET,
  CRC_DATA_OFFSET,
  PAYLOAD_OFFSET,
  MAX_PAYLOAD_SIZE,
  buildPacket,
  crc16CcittFalse,
} from './protocol.js';

export class PacketStreamParser {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.badFrames = 0;
    this.crcErrors = 0;
    this.versionErrors = 0;
    this.recentErrors = [];
  }

  reset() {
    this.buffer = new Uint8Array(0);
    this.badFrames = 0;
    this.crcErrors = 0;
    this.versionErrors = 0;
    this.recentErrors = [];
  }

  discard(count = 1) {
    this.buffer = this.buffer.slice(count);
    this.badFrames += count;
  }

  findSync() {
    for (let index = 0; index < this.buffer.length - 1; index += 1) {
      if (this.buffer[index] === SYNC_BYTES[0] && this.buffer[index + 1] === SYNC_BYTES[1]) return index;
    }
    return -1;
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Serial data must be a Uint8Array');

    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    const packets = [];
    const errors = [];
    this.recentErrors = errors;
    while (this.buffer.length >= 2) {
      const syncIndex = this.findSync();
      if (syncIndex < 0) {
        // Preserve a trailing 0xA5 because the next chunk may start with 0x5A.
        const keep = this.buffer[this.buffer.length - 1] === SYNC_BYTES[0] ? 1 : 0;
        this.discard(this.buffer.length - keep);
        break;
      }
      if (syncIndex > 0) this.discard(syncIndex);
      if (this.buffer.length < MIN_FRAME_SIZE) break;

      const version = this.buffer[2];
      if (version !== PROTOCOL_VERSION) {
        this.versionErrors += 1;
        this.discard(1);
        continue;
      }

      const payloadLength = this.buffer[LENGTH_OFFSET];
      if (payloadLength > MAX_PAYLOAD_SIZE) {
        this.discard(1);
        continue;
      }

      const frameLength = FRAME_PREFIX_SIZE + payloadLength + CRC_SIZE;
      if (this.buffer.length < frameLength) break;

      const frame = this.buffer.slice(0, frameLength);
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const crcOffset = frameLength - CRC_SIZE;
      const receivedCrc = view.getUint16(crcOffset, true);
      const calculatedCrc = crc16CcittFalse(frame.subarray(CRC_DATA_OFFSET, crcOffset));

      if (receivedCrc !== calculatedCrc) {
        this.crcErrors += 1;
        errors.push({
          kind: 'crc',
          version,
          packetNumber: view.getUint16(PACKET_NUMBER_OFFSET, true),
          type: view.getUint8(TYPE_OFFSET),
          payloadLength,
          receivedCrc,
          calculatedCrc,
          crcInput: frame.slice(CRC_DATA_OFFSET, crcOffset),
          raw: frame,
        });
        this.discard(1);
        continue;
      }

      packets.push({
        version,
        packetNumber: view.getUint16(PACKET_NUMBER_OFFSET, true),
        type: view.getUint8(TYPE_OFFSET),
        payloadLength,
        payload: frame.slice(PAYLOAD_OFFSET, crcOffset),
        crc: receivedCrc,
        crcValid: true,
        raw: frame,
        receivedAt: performance.now(),
      });
      this.buffer = this.buffer.slice(frameLength);
    }

    return packets;
  }
}

/**
 * Connects the dashboard to the Python server. The Python process owns the
 * actual serial port; browser clients only exchange bytes over WebSocket.
 */
export class SerialLink extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.bridgeConnected = false;
    this.serialConnected = false;
    this.currentPort = null;
    this.baudRate = null;
    this.packetNumber = 0;
    this.parser = new PacketStreamParser();
    this.reconnectTimer = null;
    this.stopped = false;
  }

  get connected() {
    return this.serialConnected;
  }

  start() {
    this.stopped = false;
    this.openSocket();
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
  }

  openSocket() {
    if (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.socket.binaryType = 'arraybuffer';

    this.socket.addEventListener('open', () => {
      this.bridgeConnected = true;
      this.dispatchEvent(new CustomEvent('bridge', { detail: { connected: true } }));
      this.listPorts();
    });

    this.socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleSerialBytes(new Uint8Array(event.data));
        return;
      }
      this.handleServerMessage(event.data);
    });

    this.socket.addEventListener('close', () => {
      const wasBridgeConnected = this.bridgeConnected;
      const wasSerialConnected = this.serialConnected;
      this.bridgeConnected = false;
      this.serialConnected = false;
      this.currentPort = null;
      this.baudRate = null;
      this.socket = null;
      if (wasSerialConnected) {
        this.dispatchEvent(new CustomEvent('status', { detail: { connected: false, port: null, baudRate: null } }));
      }
      if (wasBridgeConnected || !this.stopped) {
        this.dispatchEvent(new CustomEvent('bridge', { detail: { connected: false } }));
      }
      if (!this.stopped) {
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = window.setTimeout(() => this.openSocket(), 1500);
      }
    });

    this.socket.addEventListener('error', () => {
      // The close event handles reconnects and status updates.
    });
  }

  handleServerMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.dispatchEvent(new CustomEvent('error', { detail: new Error('Received invalid JSON from the serial server') }));
      return;
    }

    if (message.event === 'status') {
      this.serialConnected = Boolean(message.connected);
      this.currentPort = message.port ?? null;
      this.baudRate = message.baudRate ?? null;
      if (!this.serialConnected) this.parser.reset();
      this.dispatchEvent(new CustomEvent('status', {
        detail: {
          connected: this.serialConnected,
          port: this.currentPort,
          baudRate: this.baudRate,
        },
      }));
      return;
    }

    if (message.event === 'ports') {
      this.dispatchEvent(new CustomEvent('ports', { detail: { ports: message.ports ?? [] } }));
      return;
    }

    if (message.event === 'error') {
      this.dispatchEvent(new CustomEvent('error', { detail: new Error(message.message || 'Serial server error') }));
    }
  }

  handleSerialBytes(chunk) {
    const beforeBadFrames = this.parser.badFrames;
    const beforeCrcErrors = this.parser.crcErrors;
    const beforeVersionErrors = this.parser.versionErrors;
    const packets = this.parser.push(chunk);
    const badFramesAdded = this.parser.badFrames - beforeBadFrames;
    const crcErrorsAdded = this.parser.crcErrors - beforeCrcErrors;
    const versionErrorsAdded = this.parser.versionErrors - beforeVersionErrors;

    if (badFramesAdded > 0 || crcErrorsAdded > 0 || versionErrorsAdded > 0) {
      this.dispatchEvent(new CustomEvent('parseerror', {
        detail: {
          count: badFramesAdded,
          crcErrors: crcErrorsAdded,
          versionErrors: versionErrorsAdded,
          diagnostics: this.parser.recentErrors.map((error) => ({ ...error })),
        },
      }));
    }
    for (const packet of packets) {
      this.dispatchEvent(new CustomEvent('packet', { detail: packet }));
    }
  }

  requireBridge() {
    if (!this.bridgeConnected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('The dashboard server is not connected');
    }
  }

  connect(port, baudRate = 115200) {
    this.requireBridge();
    if (!port) throw new Error('Select a server serial port first');
    this.socket.send(JSON.stringify({ action: 'connect', port, baudRate }));
  }

  disconnect() {
    this.requireBridge();
    this.socket.send(JSON.stringify({ action: 'disconnect' }));
  }

  listPorts() {
    this.requireBridge();
    this.socket.send(JSON.stringify({ action: 'listPorts' }));
  }

  async send(type, payload) {
    this.requireBridge();
    if (!this.connected) throw new Error('Server serial port is not connected');
    const frame = buildPacket(this.packetNumber++, type, payload);
    this.socket.send(frame);
    return frame;
  }
}
