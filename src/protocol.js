export const SYNC_BYTES = Object.freeze([0xa5, 0x5a]);
export const PROTOCOL_VERSION = 0x01;

export const VERSION_OFFSET = 2;
export const PACKET_NUMBER_OFFSET = 3;
export const TYPE_OFFSET = 5;
export const LENGTH_OFFSET = 6;
export const PAYLOAD_OFFSET = 7;
export const CRC_DATA_OFFSET = PACKET_NUMBER_OFFSET;

export const FRAME_PREFIX_SIZE = PAYLOAD_OFFSET;
export const CRC_SIZE = 2;
export const FRAME_OVERHEAD = FRAME_PREFIX_SIZE + CRC_SIZE;
export const MIN_FRAME_SIZE = FRAME_OVERHEAD;
export const MAX_PAYLOAD_SIZE = 60;

export const COMMAND_PAYLOAD_SIZE = 8;
export const TELEMETRY_PAYLOAD_SIZE = 54;
export const COMMAND_FRAME_SIZE = FRAME_OVERHEAD + COMMAND_PAYLOAD_SIZE;
export const TELEMETRY_FRAME_SIZE = FRAME_OVERHEAD + TELEMETRY_PAYLOAD_SIZE;

export const CRC16_CONFIG = Object.freeze({
  name: 'CRC-16/CCITT-FALSE',
  polynomial: 0x1021,
  initialValue: 0xffff,
  xorOut: 0x0000,
  reflected: false,
});

export const USB_MESSAGE_TYPES = Object.freeze({
  RAW: 0,
  DEBUG_TEXT: 1,
  RADIO_PACKET: 2,
  TELEMETRY: 3,
  COMMAND: 4,
  CONFIG: 5,
});

// RadioHead header-flags values used on the RF69 link itself (distinct from
// USB_MESSAGE_TYPES). Sourced from AFC-Drone/include/radio.h's radio_MessageType.
export const RADIO_MESSAGE_TYPES = Object.freeze({
  SETUP: 0,
  STATUS0: 1,
  STATUS1: 2,
  STATUS2: 3,
  STATUS3: 4,
  STATUS4: 5,
  STATUS5: 6,
  STATUS6: 7,
  COMMAND: 8,
  CONFIG: 9,
});

export const RADIO_MESSAGE_TYPE_NAMES = Object.freeze({
  [RADIO_MESSAGE_TYPES.SETUP]: 'Setup',
  [RADIO_MESSAGE_TYPES.STATUS0]: 'Status0',
  [RADIO_MESSAGE_TYPES.STATUS1]: 'Status1',
  [RADIO_MESSAGE_TYPES.STATUS2]: 'Status2',
  [RADIO_MESSAGE_TYPES.STATUS3]: 'Status3',
  [RADIO_MESSAGE_TYPES.STATUS4]: 'Status4',
  [RADIO_MESSAGE_TYPES.STATUS5]: 'Status5',
  [RADIO_MESSAGE_TYPES.STATUS6]: 'Status6',
  [RADIO_MESSAGE_TYPES.COMMAND]: 'Command',
  [RADIO_MESSAGE_TYPES.CONFIG]: 'Config',
});

// The connection-identify handshake reuses USB_MESSAGE_TYPES.RAW, which no
// firmware otherwise emits or accepts.
export const RADIO_HANDSHAKE = Object.freeze({
  IDENTIFY_QUERY: 0x3f,
  DEVICE_KIND_DRONE_DIRECT: 0x01,
  DEVICE_KIND_BASE_STATION_RELAY: 0x02,
});

// TELEMETRY's currentMode / RF STATUS0's currentMode, both Drone::state.
export const DRONE_STATES = Object.freeze({
  BOOT: 0,
  RADIO_SETUP: 1,
  SENSOR_SETUP: 2,
  CONTROL_SETUP: 3,
  READY_ARMED: 4,
  FLIGHT: 5,
  FAULT_ERROR: 6,
});

export const DRONE_STATE_NAMES = Object.freeze({
  [DRONE_STATES.BOOT]: 'Boot',
  [DRONE_STATES.RADIO_SETUP]: 'Radio Setup',
  [DRONE_STATES.SENSOR_SETUP]: 'Sensor Setup',
  [DRONE_STATES.CONTROL_SETUP]: 'Control Setup',
  [DRONE_STATES.READY_ARMED]: 'Ready / Armed',
  [DRONE_STATES.FLIGHT]: 'Flight',
  [DRONE_STATES.FAULT_ERROR]: 'Fault Error',
});

export function formatDroneState(value) {
  if (value === undefined || value === null) return '--';
  return DRONE_STATE_NAMES[value] ?? `Unknown (${value})`;
}

// The persistent-config wire version, versioned independently of the USB
// framing PROTOCOL_VERSION. This is AFC-Drone's CONFIG_VERSION (src/configs.cpp)
// and both the USB and radio firmware handlers reject any config request whose
// version byte does not match theirs with ConfigResult::UNKNOWN_VERSION. V2
// added DebugMode at key 0 and moved TxPowerDbm after the booleans.
export const CONFIG_VERSION = 2;

export const CONFIG_OPS = Object.freeze({
  READ: 0x01,
  SET: 0x02,
  ZERO_ALL: 0xff,
  READ_RESPONSE: 0x81,
  SET_RESPONSE: 0x82,
});

export const CONFIG_RESULTS = Object.freeze({
  OK: 0,
  INVALID_VALUE: 1,
  INVALID_KEY: 2,
  UNSAFE_STATE: 3,
  UNKNOWN_VERSION: 4,
  UNKNOWN_OP: 5,
});

export const CONFIG_RESULT_LABELS = Object.freeze({
  [CONFIG_RESULTS.OK]: 'OK',
  [CONFIG_RESULTS.INVALID_VALUE]: 'Invalid value',
  [CONFIG_RESULTS.INVALID_KEY]: 'Invalid key',
  [CONFIG_RESULTS.UNSAFE_STATE]: 'Rejected (unsafe state)',
  [CONFIG_RESULTS.UNKNOWN_VERSION]: 'Unknown version',
  [CONFIG_RESULTS.UNKNOWN_OP]: 'Unknown operation',
});

export const CONFIG_READ_ENTRY_MAX = 8;
export const CONFIG_SET_ENTRY_MAX = 9;

export const CONFIG_KEYS = Object.freeze([
  { id: 0, key: 'DebugMode', label: 'Debug Mode', kind: 'bool', default: 0, effect: 'Enables increased debug logging.'},
  { id: 1, key: 'TxPowerDbm', label: 'Tx power', kind: 'int', min: 14, max: 20, default: 20, unit: 'dBm', effect: 'RFM69 transmit power in dBm.' },
  { id: 2, key: 'UsbRelayEnabled', label: 'USB relay enabled', kind: 'bool', default: 1, effect: 'Enables USB communication handling.' },
  { id: 3, key: 'RadioEnabled', label: 'Radio enabled', kind: 'bool', default: 1, effect: 'Enables periodic radio processing.' },
  { id: 4, key: 'SkipRadioHandshake', label: 'Skip radio handshake', kind: 'bool', default: 1, effect: 'Skips the radio connection handshake when enabled.' },
  { id: 5, key: 'GimbalPitchOffset', label: 'Gimbal pitch offset', kind: 'int', min: 60, max: 120, default: 90, unit: 'deg', effect: 'Pitch-servo center/setpoint offset in degrees.' },
  { id: 6, key: 'GimbalYawOffset', label: 'Gimbal yaw offset', kind: 'int', min: 60, max: 120, default: 89, unit: 'deg', effect: 'Yaw-servo center/setpoint offset in degrees.' },
  { id: 7, key: 'Motor1Offset', label: 'Motor 1 offset (top)', kind: 'int', min: -100, max: 100, default: 0, effect: 'Top-motor speed adjustment.' },
  { id: 8, key: 'Motor2Offset', label: 'Motor 2 offset (bottom)', kind: 'int', min: -100, max: 100, default: 0, effect: 'Bottom-motor speed adjustment.' },
]);

export function getConfigKeyById(id) {
  return CONFIG_KEYS.find((entry) => entry.id === id) ?? null;
}

function encodeConfigPayload(values = {}) {
  const { operation, entries = [], version = CONFIG_VERSION } = values;

  let maxEntries;
  if (operation === CONFIG_OPS.SET) maxEntries = CONFIG_SET_ENTRY_MAX;
  else if (operation === CONFIG_OPS.READ) maxEntries = CONFIG_READ_ENTRY_MAX;
  else if (operation === CONFIG_OPS.ZERO_ALL) maxEntries = 0;
  else throw new Error(`Unsupported config operation: 0x${Number(operation).toString(16)}`);

  if (entries.length > maxEntries) {
    throw new Error(`Config ${operation === CONFIG_OPS.SET ? 'set' : 'read'} request supports at most ${maxEntries} entries`);
  }

  // Every request entry is 6 bytes (ConfigKey + int32 value), even for READ,
  // which just ignores the value field — the firmware expects a uniform stride.
  const entrySize = 6;
  const payload = new Uint8Array(3 + entries.length * entrySize);
  const view = new DataView(payload.buffer);
  payload[0] = version & 0xff;
  payload[1] = operation & 0xff;
  payload[2] = entries.length;

  let offset = 3;
  for (const entry of entries) {
    view.setUint16(offset, entry.key, true);
    view.setInt32(offset + 2, operation === CONFIG_OPS.SET ? entry.value : 0, true);
    offset += entrySize;
  }

  if (payload.byteLength > MAX_PAYLOAD_SIZE) {
    throw new Error(`Config payload is ${payload.byteLength} bytes; maximum is ${MAX_PAYLOAD_SIZE}`);
  }
  return payload;
}

function decodeConfigPayload(payload) {
  if (payload.byteLength < 4) throw new Error('Config response requires at least 4 header bytes');

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint8(0);
  const operation = view.getUint8(1);
  const length = view.getUint8(2);
  const result = view.getUint8(3);
  const entrySize = operation === CONFIG_OPS.READ_RESPONSE ? 7 : 3;

  const statuses = [];
  let offset = 4;
  for (let index = 0; index < length; index += 1) {
    const key = view.getUint16(offset, true);
    const entryResult = view.getUint8(offset + 2);
    const status = { key, result: entryResult };
    if (operation === CONFIG_OPS.READ_RESPONSE) status.value = view.getInt32(offset + 3, true);
    statuses.push(status);
    offset += entrySize;
  }

  return { version, operation, length, result, statuses };
}

// Quaternion components are normalized to [-1, 1] and packed as Q15 fixed
// point; acceleration/velocity are packed as millimeter-scale fixed point
// (value_in_SI_units * 1000). Shared by the direct-wire TELEMETRY schema and
// the RF STATUS3/STATUS4/STATUS5 schemas below, so both decode identically.
const QUATERNION_SCALE = 32767;
const MOTION_SCALE = 1000;
const MOTION_LIMIT = 32767 / MOTION_SCALE; // int16 range at the mm-scale factor

const numericTypes = {
  uint8: { size: 1, read: (view, offset) => view.getUint8(offset), write: (view, offset, value) => view.setUint8(offset, value) },
  int8: { size: 1, read: (view, offset) => view.getInt8(offset), write: (view, offset, value) => view.setInt8(offset, value) },
  uint16: { size: 2, read: (view, offset) => view.getUint16(offset, true), write: (view, offset, value) => view.setUint16(offset, value, true) },
  int16: { size: 2, read: (view, offset) => view.getInt16(offset, true), write: (view, offset, value) => view.setInt16(offset, value, true) },
  uint32: { size: 4, read: (view, offset) => view.getUint32(offset, true), write: (view, offset, value) => view.setUint32(offset, value, true) },
  int32: { size: 4, read: (view, offset) => view.getInt32(offset, true), write: (view, offset, value) => view.setInt32(offset, value, true) },
  float32: { size: 4, read: (view, offset) => view.getFloat32(offset, true), write: (view, offset, value) => view.setFloat32(offset, value, true) },
  float64: { size: 8, read: (view, offset) => view.getFloat64(offset, true), write: (view, offset, value) => view.setFloat64(offset, value, true) },
};

function rawPayloadDecoder(payload) {
  return { raw: bytesToHex(payload) };
}

// RF-level payload shapes below are sourced from AFC-Drone/include/radio.h's
// StatusMsg0_t..StatusMsg6_t and ConfigPacket — the sender's real structs,
// not the base station's mirrored (and, for STATUS2, incorrectly-widened)
// copies. Every RF application payload is exactly 8 bytes.

const RADIO_STATUS_SCHEMAS = {
  [RADIO_MESSAGE_TYPES.STATUS0]: {
    name: 'Status0', payloadSize: 8,
    fields: [
      { key: 'loopTimeAvg', type: 'uint16' },
      { key: 'loopTimeMax', type: 'uint16' },
      { key: 'runTime', type: 'uint16' },
      { key: 'currentMode', type: 'uint8' },
      { key: 'reserved' , type: 'uint8', hidden: true},
    ],
  },
  [RADIO_MESSAGE_TYPES.STATUS1]: {
    name: 'Status1', payloadSize: 8,
    fields: [
      { key: 'gimbalPitch', type: 'int16' },
      { key: 'gimbalYaw', type: 'int16' },
      { key: 'topServoSet', type: 'int16' },
      { key: 'bottomServoSet', type: 'int16' },
    ],
  },
  [RADIO_MESSAGE_TYPES.STATUS2]: {
    name: 'Status2', payloadSize: 8,
    fields: [
      { key: 'motor1Set', type: 'uint16' },
      { key: 'motor2Set', type: 'uint16' },
      { key: 'voltage', type: 'uint16' },
      { key: 'rssi', type: 'uint16' },
    ],
  },
  // Quaternion components are Q15 fixed-point (already normalized to
  // [-1, 1] by the sensor fusion, wire value = round(component * 32767)).
  [RADIO_MESSAGE_TYPES.STATUS3]: {
    name: 'Status3', payloadSize: 8,
    fields: [
      { key: 'qR', type: 'int16', scale: QUATERNION_SCALE, min: -1, max: 1 },
      { key: 'qI', type: 'int16', scale: QUATERNION_SCALE, min: -1, max: 1 },
      { key: 'qJ', type: 'int16', scale: QUATERNION_SCALE, min: -1, max: 1 },
      { key: 'qK', type: 'int16', scale: QUATERNION_SCALE, min: -1, max: 1 },
    ],
  },
  // Acceleration/velocity are world-frame (gravity/orientation-compensated),
  // millimeter-scale fixed point: wire value = round(value_in_SI_units * 1000).
  [RADIO_MESSAGE_TYPES.STATUS4]: {
    name: 'Status4', payloadSize: 8,
    fields: [
      { key: 'accelX', type: 'int16', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT },
      { key: 'accelY', type: 'int16', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT },
      { key: 'accelZ', type: 'int16', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT },
      { key: 'reserved', type: 'int16', hidden: true },
    ],
  },
  [RADIO_MESSAGE_TYPES.STATUS5]: {
    name: 'Status5', payloadSize: 8,
    fields: [
      { key: 'velX', type: 'int16', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT },
      { key: 'velY', type: 'int16', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT },
      { key: 'velZ', type: 'int16', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT },
      { key: 'reserved', type: 'int16', hidden: true },
    ],
  },
  [RADIO_MESSAGE_TYPES.STATUS6]: {
    name: 'Status6', payloadSize: 8,
    fields: [
      { key: 'posX', type: 'int16' },
      { key: 'posY', type: 'int16' },
      { key: 'posZ', type: 'int16' },
      { key: 'reserved', type: 'int16', hidden: true },
    ],
  },
};

// The single-key radio CONFIG shape (ConfigPacket): distinct from the
// batched USB CONFIG codec above, which only applies to direct-wire mode.
const RADIO_CONFIG_SCHEMA = {
  name: 'Radio Config',
  payloadSize: 8,
  fields: [
    { key: 'version', type: 'uint8' },
    { key: 'state', type: 'uint8' },
    { key: 'configKey', type: 'uint16' },
    { key: 'value', type: 'int32' },
  ],
};

export function decodeRadioMessage(radioMessageType, bytes) {
  if (radioMessageType === RADIO_MESSAGE_TYPES.COMMAND) {
    return decodePayload(getSchemaById(USB_MESSAGE_TYPES.COMMAND), bytes);
  }
  if (radioMessageType === RADIO_MESSAGE_TYPES.CONFIG) {
    return decodePayload(RADIO_CONFIG_SCHEMA, bytes);
  }
  const statusSchema = RADIO_STATUS_SCHEMAS[radioMessageType];
  if (statusSchema) return decodePayload(statusSchema, bytes);
  if (radioMessageType === RADIO_MESSAGE_TYPES.SETUP) {
    return { text: new TextDecoder().decode(bytes).replace(/\0+$/, '') };
  }
  return rawPayloadDecoder(bytes);
}

export function encodeRadioMessage(radioMessageType, values) {
  if (radioMessageType === RADIO_MESSAGE_TYPES.COMMAND) {
    return encodePayload(getSchemaById(USB_MESSAGE_TYPES.COMMAND), values);
  }
  if (radioMessageType === RADIO_MESSAGE_TYPES.CONFIG) {
    return encodePayload(RADIO_CONFIG_SCHEMA, values);
  }
  const statusSchema = RADIO_STATUS_SCHEMAS[radioMessageType];
  if (statusSchema) return encodePayload(statusSchema, values);
  throw new Error(`Cannot encode radio message type ${radioMessageType}`);
}

const RADIO_PACKET_REQUEST_SIZE = 11;

function decodeRadioPacketPayload(payload) {
  if (payload.byteLength !== 11 && payload.byteLength !== 12) {
    throw new Error(`Radio Packet requires 11 or 12 bytes, received ${payload.byteLength}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const directionRaw = view.getUint8(0);
  const radioMessageType = view.getUint8(2);
  const message = payload.subarray(3, 11);

  return {
    direction: directionRaw === 1 ? 'sent' : 'received',
    directionRaw,
    radioPacketNumber: view.getUint8(1),
    radioMessageType,
    radioMessageTypeName: RADIO_MESSAGE_TYPE_NAMES[radioMessageType] ?? `Unknown (${radioMessageType})`,
    radioPayload: bytesToHex(message),
    decodedMessage: decodeRadioMessage(radioMessageType, message),
    rssi: payload.byteLength === 12 ? view.getUint8(11) : null,
  };
}

// Outbound "please transmit" instruction: no rssi (not meaningful for a
// request) and no real packet number (the relay assigns its own).
function encodeRadioPacketPayload(values = {}) {
  const { radioMessageType, message } = values;
  if (!(message instanceof Uint8Array) || message.byteLength !== 8) {
    throw new Error('Radio message payload must be exactly 8 bytes');
  }

  const payload = new Uint8Array(RADIO_PACKET_REQUEST_SIZE);
  payload[0] = 1; // direction hint: SENT
  payload[1] = 0; // packetNum placeholder
  payload[2] = radioMessageType & 0xff;
  payload.set(message, 3);
  return payload;
}

export const PACKET_SCHEMAS = [
  {
    id: USB_MESSAGE_TYPES.RAW,
    name: 'Raw',
    direction: 'both',
    variableLength: true,
    decoder: rawPayloadDecoder,
  },
  {
    id: USB_MESSAGE_TYPES.DEBUG_TEXT,
    name: 'Debug Text',
    direction: 'in',
    variableLength: true,
    decoder: (payload) => ({ text: new TextDecoder().decode(payload) }),
  },
  {
    id: USB_MESSAGE_TYPES.RADIO_PACKET,
    name: 'Radio Packet',
    direction: 'both',
    variableLength: true,
    builderHidden: true,
    encoder: encodeRadioPacketPayload,
    decoder: decodeRadioPacketPayload,
  },
  {
    id: USB_MESSAGE_TYPES.TELEMETRY,
    name: 'Telemetry',
    direction: 'in',
    payloadSize: TELEMETRY_PAYLOAD_SIZE,
    fields: [
      { key: 'loopTimeAvg', label: 'Average loop time', type: 'uint16', unit: 'us', group: 'Timing' },
      { key: 'loopTimeMax', label: 'Maximum loop time', type: 'uint16', unit: 'us', group: 'Timing' },
      { key: 'runTime', label: 'Runtime', type: 'uint16', unit: 's', group: 'Timing' },
      { key: 'rssi', label: 'RSSI', type: 'uint8', unit: 'Dbm', group: 'Radio' },
      { key: 'currentMode', label: 'Current mode', type: 'uint8', unit: '', group: 'Status' },

      { key: 'gimbalPitch', label: 'Gimbal pitch', type: 'int16', unit: '', group: 'Gimbal' },
      { key: 'gimbalYaw', label: 'Gimbal yaw', type: 'int16', unit: '', group: 'Gimbal' },
      { key: 'topServoSet', label: 'Top servo setpoint', type: 'int16', unit: '', group: 'Gimbal' },
      { key: 'bottomServoSet', label: 'Bottom servo setpoint', type: 'int16', unit: '', group: 'Gimbal' },

      { key: 'motor1Set', label: 'Bottom motor setpoint', type: 'uint8', unit: '', group: 'Power' },
      { key: 'motor2Set', label: 'Top motor setpoint', type: 'uint8', unit: '', group: 'Power' },
      { key: 'voltage', label: 'Voltage', type: 'uint16', unit: '', group: 'Power' },

      { key: 'qR', label: 'Quaternion R', type: 'int16', unit: '', group: 'Quaternion', scale: QUATERNION_SCALE, min: -1, max: 1, precision: 4 },
      { key: 'qI', label: 'Quaternion I', type: 'int16', unit: '', group: 'Quaternion', scale: QUATERNION_SCALE, min: -1, max: 1, precision: 4 },
      { key: 'qJ', label: 'Quaternion J', type: 'int16', unit: '', group: 'Quaternion', scale: QUATERNION_SCALE, min: -1, max: 1, precision: 4 },
      { key: 'qK', label: 'Quaternion K', type: 'int16', unit: '', group: 'Quaternion', scale: QUATERNION_SCALE, min: -1, max: 1, precision: 4 },

      { key: 'accelX', label: 'Acceleration X', type: 'int16', unit: 'm/s²', group: 'Acceleration', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT, precision: 3 },
      { key: 'accelY', label: 'Acceleration Y', type: 'int16', unit: 'm/s²', group: 'Acceleration', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT, precision: 3 },
      { key: 'accelZ', label: 'Acceleration Z', type: 'int16', unit: 'm/s²', group: 'Acceleration', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT, precision: 3 },

      { key: 'velX', label: 'Velocity X', type: 'int16', unit: 'm/s', group: 'Velocity', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT, precision: 3 },
      { key: 'velY', label: 'Velocity Y', type: 'int16', unit: 'm/s', group: 'Velocity', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT, precision: 3 },
      { key: 'velZ', label: 'Velocity Z', type: 'int16', unit: 'm/s', group: 'Velocity', scale: MOTION_SCALE, min: -MOTION_LIMIT, max: MOTION_LIMIT, precision: 3 },

      { key: 'posX', label: 'Position X', type: 'int16', unit: '', group: 'Position' },
      { key: 'posY', label: 'Position Y', type: 'int16', unit: '', group: 'Position' },
      { key: 'posZ', label: 'Position Z', type: 'int16', unit: '', group: 'Position' },

      { key: 'latitude', label: 'Latitude', type: 'float32', unit: 'deg', group: 'GPS', precision: 7 },
      { key: 'longitude', label: 'Longitude', type: 'float32', unit: 'deg', group: 'GPS', precision: 7 },
    ],
  },
  {
    id: USB_MESSAGE_TYPES.COMMAND,
    name: 'Command',
    direction: 'out',
    payloadSize: COMMAND_PAYLOAD_SIZE,
    fields: [
      {
        key: 'flags',
        label: 'Flags',
        type: 'bitfield8',
        group: 'Command',
        bits: [
          { key: 'targSlot', label: 'Target slot', bit: 0, default: false },
          { key: 'activeSlot', label: 'Active slot', bit: 1, default: false },
        ],
      },
      // The flight loop divides the raw wire value by 1638.0, yielding
      // approximately +-20 degrees - encode/decode work in degrees directly
      // via the field's scale factor (see encodePayload/decodePayload).
      { key: 'gimbalX', label: 'Gimbal X', type: 'int16', unit: 'deg', min: -20, max: 20, step: 0.1, default: 0, scale: 1638, group: 'Command' },
      { key: 'gimbalY', label: 'Gimbal Y', type: 'int16', unit: 'deg', min: -20, max: 20, step: 0.1, default: 0, scale: 1638, group: 'Command' },
      { key: 'motor0Speed', label: 'Motor 0 speed', type: 'uint8', min: 0, max: 255, step: 1, default: 0, group: 'Command' },
      { key: 'motor1Speed', label: 'Motor 1 speed', type: 'uint8', min: 0, max: 255, step: 1, default: 0, group: 'Command' },
      { key: 'unused', label: 'Reserved', type: 'uint8', default: 0, hidden: true, group: 'Command' },
    ],
  },
  {
    id: USB_MESSAGE_TYPES.CONFIG,
    name: 'Config',
    direction: 'both',
    variableLength: true,
    builderHidden: true,
    encoder: encodeConfigPayload,
    decoder: decodeConfigPayload,
  },
];

export function getSchemaById(id) {
  return PACKET_SCHEMAS.find((schema) => schema.id === id) ?? null;
}

export function getOutboundSchemas() {
  return PACKET_SCHEMAS.filter(
    (schema) => !schema.builderHidden && (schema.direction === 'out' || schema.direction === 'both'),
  );
}

export function fieldSize(field) {
  if (field.type === 'bitfield8') return 1;
  if (field.type === 'bytes' || field.type === 'string') return field.length ?? 0;
  const type = numericTypes[field.type];
  if (!type) throw new Error(`Unsupported field type: ${field.type}`);
  return type.size;
}

export function schemaPayloadSize(schema) {
  if (schema.variableLength) return null;
  if (Number.isInteger(schema.payloadSize)) return schema.payloadSize;
  return (schema.fields ?? []).reduce((total, field) => total + fieldSize(field), 0);
}

function validatePayloadLength(schema, payload) {
  if (payload.byteLength > MAX_PAYLOAD_SIZE) {
    throw new Error(`${schema?.name ?? 'Payload'} exceeds ${MAX_PAYLOAD_SIZE} bytes`);
  }
  const expected = schemaPayloadSize(schema);
  if (expected !== null && payload.byteLength !== expected) {
    throw new Error(`${schema.name} requires exactly ${expected} bytes, received ${payload.byteLength}`);
  }
}

export function decodePayload(schema, payload) {
  if (!(payload instanceof Uint8Array)) throw new TypeError('Payload must be a Uint8Array');
  if (!schema) return rawPayloadDecoder(payload);

  validatePayloadLength(schema, payload);
  if (schema.decoder) return schema.decoder(payload);

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const result = {};
  let offset = 0;

  for (const field of schema.fields ?? []) {
    if (field.type === 'bitfield8') {
      const raw = view.getUint8(offset);
      const value = { _raw: raw };
      let knownMask = 0;
      for (const bit of field.bits ?? []) {
        knownMask |= 1 << bit.bit;
        value[bit.key] = Boolean(raw & (1 << bit.bit));
      }
      value._reserved = raw & (~knownMask & 0xff);
      result[field.key] = value;
      offset += 1;
      continue;
    }

    if (field.type === 'bytes') {
      result[field.key] = payload.slice(offset, offset + field.length);
      offset += field.length;
      continue;
    }

    if (field.type === 'string') {
      const bytes = payload.slice(offset, offset + field.length);
      result[field.key] = new TextDecoder().decode(bytes).replace(/\0+$/, '');
      offset += field.length;
      continue;
    }

    const type = numericTypes[field.type];
    const raw = type.read(view, offset);
    result[field.key] = field.scale ? raw / field.scale : raw;
    offset += type.size;
  }

  return result;
}

export function encodePayload(schema, values = {}) {
  if (!schema) throw new Error('Cannot encode an unknown schema');
  if (schema.encoder) return schema.encoder(values);

  const size = schemaPayloadSize(schema);
  if (size === null) throw new Error(`${schema.name} has a variable-length payload and needs a custom encoder`);
  if (size > MAX_PAYLOAD_SIZE) throw new Error(`Payload is ${size} bytes; maximum is ${MAX_PAYLOAD_SIZE}`);

  const payload = new Uint8Array(size);
  const view = new DataView(payload.buffer);
  let offset = 0;

  for (const field of schema.fields ?? []) {
    const value = values[field.key] ?? field.default ?? 0;

    if (field.type === 'bitfield8') {
      let raw = 0;
      const bitValues = typeof value === 'object' && value !== null ? value : {};
      for (const bit of field.bits ?? []) {
        const enabled = bitValues[bit.key] ?? bit.default ?? false;
        if (enabled) raw |= 1 << bit.bit;
      }
      view.setUint8(offset, raw & 0xff);
      offset += 1;
      continue;
    }

    if (field.type === 'bytes') {
      const source = value instanceof Uint8Array ? value : hexToBytes(String(value));
      payload.set(source.slice(0, field.length), offset);
      offset += field.length;
      continue;
    }

    if (field.type === 'string') {
      const encoded = new TextEncoder().encode(String(value));
      payload.set(encoded.slice(0, field.length), offset);
      offset += field.length;
      continue;
    }

    const type = numericTypes[field.type];
    let numericValue = Number(value);
    if (field.scale) {
      // Clamp in the field's human-readable unit (e.g. degrees) before
      // scaling, so an out-of-range input can't silently wrap around once
      // it no longer fits the wire integer type.
      if (field.min !== undefined) numericValue = Math.max(field.min, numericValue);
      if (field.max !== undefined) numericValue = Math.min(field.max, numericValue);
      numericValue = Math.round(numericValue * field.scale);
    }
    type.write(view, offset, numericValue);
    offset += type.size;
  }

  validatePayloadLength(schema, payload);
  return payload;
}

export function crc16CcittFalse(bytes) {
  let crc = CRC16_CONFIG.initialValue;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0
        ? ((crc << 1) ^ CRC16_CONFIG.polynomial) & 0xffff
        : (crc << 1) & 0xffff;
    }
  }

  return (crc ^ CRC16_CONFIG.xorOut) & 0xffff;
}

export function buildPacket(packetNumber, type, payload, version = PROTOCOL_VERSION) {
  if (!(payload instanceof Uint8Array)) throw new TypeError('Payload must be a Uint8Array');
  if (payload.byteLength > MAX_PAYLOAD_SIZE) throw new Error(`Payload exceeds ${MAX_PAYLOAD_SIZE} bytes`);

  const frame = new Uint8Array(FRAME_OVERHEAD + payload.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = SYNC_BYTES[0];
  frame[1] = SYNC_BYTES[1];
  frame[VERSION_OFFSET] = version & 0xff;
  view.setUint16(PACKET_NUMBER_OFFSET, packetNumber & 0xffff, true);
  frame[TYPE_OFFSET] = type & 0xff;
  frame[LENGTH_OFFSET] = payload.byteLength;
  frame.set(payload, PAYLOAD_OFFSET);

  const crcOffset = PAYLOAD_OFFSET + payload.byteLength;
  const crc = crc16CcittFalse(frame.subarray(CRC_DATA_OFFSET, crcOffset));
  view.setUint16(crcOffset, crc, true);
  return frame;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(' ');
}

export function hexToBytes(text) {
  const normalized = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (normalized.length % 2 !== 0) throw new Error('Hex data must contain complete bytes');
  const result = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    result[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return result;
}

export function formatFieldValue(field, value) {
  if (value === undefined || value === null) return '--';
  if (field.type === 'bitfield8') {
    return (field.bits ?? []).filter((bit) => value[bit.key]).map((bit) => bit.label).join(', ') || 'None';
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(field.precision)) {
    return value.toFixed(field.precision);
  }
  return String(value);
}
