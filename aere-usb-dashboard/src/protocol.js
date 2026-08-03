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
});

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
    direction: 'in',
    variableLength: true,
    decoder: rawPayloadDecoder,
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
      { key: 'rssi', label: 'RSSI', type: 'uint8', unit: '', group: 'Radio' },
      { key: 'currentMode', label: 'Current mode', type: 'uint8', unit: '', group: 'Status' },

      { key: 'gimbalPitch', label: 'Gimbal pitch', type: 'int16', unit: '', group: 'Gimbal' },
      { key: 'gimbalYaw', label: 'Gimbal yaw', type: 'int16', unit: '', group: 'Gimbal' },
      { key: 'topServoSet', label: 'Top servo setpoint', type: 'int16', unit: '', group: 'Gimbal' },
      { key: 'bottomServoSet', label: 'Bottom servo setpoint', type: 'int16', unit: '', group: 'Gimbal' },

      { key: 'motor1Set', label: 'Bottom motor setpoint', type: 'uint8', unit: '', group: 'Power' },
      { key: 'motor2Set', label: 'Top motor setpoint', type: 'uint8', unit: '', group: 'Power' },
      { key: 'voltage', label: 'Voltage', type: 'uint16', unit: '', group: 'Power' },

      { key: 'qR', label: 'Quaternion R', type: 'int16', unit: '', group: 'Quaternion' },
      { key: 'qI', label: 'Quaternion I', type: 'int16', unit: '', group: 'Quaternion' },
      { key: 'qJ', label: 'Quaternion J', type: 'int16', unit: '', group: 'Quaternion' },
      { key: 'qK', label: 'Quaternion K', type: 'int16', unit: '', group: 'Quaternion' },

      { key: 'accelX', label: 'Acceleration X', type: 'int16', unit: '', group: 'Acceleration' },
      { key: 'accelY', label: 'Acceleration Y', type: 'int16', unit: '', group: 'Acceleration' },
      { key: 'accelZ', label: 'Acceleration Z', type: 'int16', unit: '', group: 'Acceleration' },

      { key: 'velX', label: 'Velocity X', type: 'int16', unit: '', group: 'Velocity' },
      { key: 'velY', label: 'Velocity Y', type: 'int16', unit: '', group: 'Velocity' },
      { key: 'velZ', label: 'Velocity Z', type: 'int16', unit: '', group: 'Velocity' },

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
      { key: 'gimbalX', label: 'Gimbal X', type: 'int16', min: -32768, max: 32767, step: 1, default: 0, group: 'Command' },
      { key: 'gimbalY', label: 'Gimbal Y', type: 'int16', min: -32768, max: 32767, step: 1, default: 0, group: 'Command' },
      { key: 'motor0Speed', label: 'Motor 0 speed', type: 'uint8', min: 0, max: 255, step: 1, default: 0, group: 'Command' },
      { key: 'motor1Speed', label: 'Motor 1 speed', type: 'uint8', min: 0, max: 255, step: 1, default: 0, group: 'Command' },
      { key: 'unused', label: 'Reserved', type: 'uint8', default: 0, hidden: true, group: 'Command' },
    ],
  },
];

export function getSchemaById(id) {
  return PACKET_SCHEMAS.find((schema) => schema.id === id) ?? null;
}

export function getOutboundSchemas() {
  return PACKET_SCHEMAS.filter((schema) => schema.direction === 'out' || schema.direction === 'both');
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
    result[field.key] = type.read(view, offset);
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
    type.write(view, offset, Number(value));
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
