import assert from 'node:assert/strict';
import {
  USB_MESSAGE_TYPES,
  RADIO_MESSAGE_TYPES,
  RADIO_MESSAGE_TYPE_NAMES,
  RADIO_HANDSHAKE,
  PROTOCOL_VERSION,
  FRAME_OVERHEAD,
  COMMAND_PAYLOAD_SIZE,
  TELEMETRY_PAYLOAD_SIZE,
  COMMAND_FRAME_SIZE,
  TELEMETRY_FRAME_SIZE,
  MAX_PAYLOAD_SIZE,
  PACKET_NUMBER_OFFSET,
  TYPE_OFFSET,
  LENGTH_OFFSET,
  PAYLOAD_OFFSET,
  CRC_DATA_OFFSET,
  CRC_SIZE,
  CONFIG_OPS,
  CONFIG_RESULTS,
  CONFIG_VERSION,
  getSchemaById,
  getOutboundSchemas,
  encodePayload,
  decodePayload,
  decodeRadioMessage,
  encodeRadioMessage,
  buildPacket,
  crc16CcittFalse,
  bytesToHex,
  DRONE_STATES,
  formatDroneState,
} from '../src/protocol.js';
import {
  encodeRadioPacketEnvelope,
  encodeRadioCommandEnvelope,
  encodeRadioConfigEnvelope,
  applyRadioStatusToTelemetry,
  sendRadioConfigSequence,
} from '../src/radio-relay.js';
import { PacketStreamParser } from '../src/serial-link.js';
import { quaternionToEulerDegrees } from '../src/orientation-math.js';

assert.equal(crc16CcittFalse(new TextEncoder().encode('123456789')), 0x29b1);
assert.equal(FRAME_OVERHEAD, 9);
assert.equal(COMMAND_FRAME_SIZE, 17);
assert.equal(TELEMETRY_FRAME_SIZE, 63);

const commandSchema = getSchemaById(USB_MESSAGE_TYPES.COMMAND);
// Gimbal X/Y are entered and decoded in degrees (-20..20); the wire value is
// degrees * 1638, per the flight loop's normalization factor.
const commandValues = {
  flags: { targSlot: true, activeSlot: false },
  gimbalX: -12,
  gimbalY: 18,
  motor0Speed: 67,
  motor1Speed: 89,
  unused: 0,
};
const commandPayload = encodePayload(commandSchema, commandValues);
assert.equal(commandPayload.length, COMMAND_PAYLOAD_SIZE);
assert.deepEqual(Array.from(commandPayload), [0x01, 0x38, 0xb3, 0x2c, 0x73, 0x43, 0x59, 0x00]);

const decodedCommand = decodePayload(commandSchema, commandPayload);
assert.equal(decodedCommand.flags._raw, 0x01);
assert.equal(decodedCommand.flags.targSlot, true);
assert.equal(decodedCommand.flags.activeSlot, false);
assert.equal(decodedCommand.flags._reserved, 0);
assert.equal(decodedCommand.gimbalX, -12);
assert.equal(decodedCommand.gimbalY, 18);
assert.equal(decodedCommand.motor0Speed, 67);
assert.equal(decodedCommand.motor1Speed, 89);
assert.equal(decodedCommand.unused, 0);

// Out-of-range degree input must clamp to +-20 before scaling, not wrap
// around the wire int16 the way an unclamped 100*1638 would.
const clampedPayload = encodePayload(commandSchema, { ...commandValues, gimbalX: 100, gimbalY: -100 });
const clampedView = new DataView(clampedPayload.buffer, clampedPayload.byteOffset, clampedPayload.byteLength);
assert.equal(clampedView.getInt16(1, true), Math.round(20 * 1638));
assert.equal(clampedView.getInt16(3, true), Math.round(-20 * 1638));

assert.throws(
  () => decodePayload(commandSchema, commandPayload.slice(0, 7)),
  /exactly 8 bytes/,
);
assert.throws(
  () => decodePayload(commandSchema, new Uint8Array(9)),
  /exactly 8 bytes/,
);

const commandFrame = buildPacket(0x1234, USB_MESSAGE_TYPES.COMMAND, commandPayload);
const commandView = new DataView(commandFrame.buffer, commandFrame.byteOffset, commandFrame.byteLength);
assert.equal(commandFrame.length, COMMAND_FRAME_SIZE);
assert.deepEqual(Array.from(commandFrame.slice(0, 3)), [0xa5, 0x5a, PROTOCOL_VERSION]);
assert.equal(commandView.getUint16(PACKET_NUMBER_OFFSET, true), 0x1234);
assert.equal(commandFrame[TYPE_OFFSET], USB_MESSAGE_TYPES.COMMAND);
assert.equal(commandFrame[LENGTH_OFFSET], COMMAND_PAYLOAD_SIZE);
assert.deepEqual(Array.from(commandFrame.slice(PAYLOAD_OFFSET, PAYLOAD_OFFSET + COMMAND_PAYLOAD_SIZE)), Array.from(commandPayload));

const commandCrcOffset = commandFrame.length - CRC_SIZE;
const commandCrc = commandView.getUint16(commandCrcOffset, true);
assert.equal(commandCrc, crc16CcittFalse(commandFrame.subarray(CRC_DATA_OFFSET, commandCrcOffset)));
assert.notEqual(commandCrc, crc16CcittFalse(commandFrame.subarray(2, commandCrcOffset)));

const telemetrySchema = getSchemaById(USB_MESSAGE_TYPES.TELEMETRY);
const telemetryValues = {
  loopTimeAvg: 1001,
  loopTimeMax: 2002,
  runTime: 65535,
  rssi: 77,
  currentMode: 3,
  gimbalPitch: -100,
  gimbalYaw: 200,
  topServoSet: -300,
  bottomServoSet: 400,
  motor1Set: 10,
  motor2Set: 20,
  voltage: 16800,
  qR: 1000,
  qI: -1001,
  qJ: 1002,
  qK: -1003,
  accelX: 11,
  accelY: -12,
  accelZ: 13,
  velX: -21,
  velY: 22,
  velZ: -23,
  posX: 31,
  posY: -32,
  posZ: 33,
  latitude: 47.1164,
  longitude: -88.5385,
};
const telemetryPayload = encodePayload(telemetrySchema, telemetryValues);
assert.equal(telemetryPayload.length, TELEMETRY_PAYLOAD_SIZE);
const telemetryView = new DataView(telemetryPayload.buffer, telemetryPayload.byteOffset, telemetryPayload.byteLength);
assert.equal(telemetryView.getUint16(0, true), 1001);
assert.equal(telemetryView.getUint16(2, true), 2002);
assert.equal(telemetryView.getUint16(4, true), 65535);
assert.equal(telemetryView.getUint8(6), 77);
assert.equal(telemetryView.getUint8(7), 3);
assert.equal(telemetryView.getInt16(8, true), -100);
assert.equal(telemetryView.getUint8(16), 10);
assert.equal(telemetryView.getUint16(18, true), 16800);
assert.equal(telemetryView.getInt16(44, true), 33);
assert.ok(Math.abs(telemetryView.getFloat32(46, true) - 47.1164) < 0.00001);
assert.ok(Math.abs(telemetryView.getFloat32(50, true) - (-88.5385)) < 0.00001);

const decodedTelemetry = decodePayload(telemetrySchema, telemetryPayload);
assert.equal(decodedTelemetry.loopTimeAvg, 1001);
assert.equal(decodedTelemetry.runTime, 65535);
assert.equal(decodedTelemetry.gimbalPitch, -100);
assert.equal(decodedTelemetry.posZ, 33);
assert.ok(Math.abs(decodedTelemetry.latitude - 47.1164) < 0.00001);
assert.ok(Math.abs(decodedTelemetry.longitude - (-88.5385)) < 0.00001);
assert.throws(
  () => decodePayload(telemetrySchema, telemetryPayload.slice(0, 53)),
  /exactly 54 bytes/,
);
assert.throws(
  () => decodePayload(telemetrySchema, new Uint8Array(55)),
  /exactly 54 bytes/,
);

const telemetryFrame = buildPacket(0x4321, USB_MESSAGE_TYPES.TELEMETRY, telemetryPayload);
assert.equal(telemetryFrame.length, TELEMETRY_FRAME_SIZE);
assert.equal(telemetryFrame[LENGTH_OFFSET], TELEMETRY_PAYLOAD_SIZE);

const debugSchema = getSchemaById(USB_MESSAGE_TYPES.DEBUG_TEXT);
const debugPayload = new TextEncoder().encode('first chunk\nsecond chunk');
assert.equal(decodePayload(debugSchema, debugPayload).text, 'first chunk\nsecond chunk');
assert.equal(decodePayload(debugSchema, new Uint8Array([0x41, 0x00, 0x42])).text, 'A\u0000B');

const fragmentedParser = new PacketStreamParser();
const fragmentedPackets = [
  ...fragmentedParser.push(telemetryFrame.slice(0, 2)),
  ...fragmentedParser.push(telemetryFrame.slice(2, 7)),
  ...fragmentedParser.push(telemetryFrame.slice(7, 40)),
  ...fragmentedParser.push(telemetryFrame.slice(40)),
];
assert.equal(fragmentedPackets.length, 1);
assert.equal(fragmentedPackets[0].packetNumber, 0x4321);
assert.equal(fragmentedPackets[0].type, USB_MESSAGE_TYPES.TELEMETRY);
assert.equal(fragmentedPackets[0].payloadLength, TELEMETRY_PAYLOAD_SIZE);
assert.equal(fragmentedPackets[0].crcValid, true);
assert.deepEqual(Array.from(fragmentedPackets[0].payload), Array.from(telemetryPayload));

const corrupted = telemetryFrame.slice();
corrupted[PAYLOAD_OFFSET] ^= 0x01;
const nextFrame = buildPacket(0x1235, USB_MESSAGE_TYPES.COMMAND, commandPayload);
const noisyStream = new Uint8Array(4 + corrupted.length + nextFrame.length);
noisyStream.set([0x00, 0xff, 0xa5, 0x11], 0);
noisyStream.set(corrupted, 4);
noisyStream.set(nextFrame, 4 + corrupted.length);

const recoveryParser = new PacketStreamParser();
const recovered = recoveryParser.push(noisyStream);
assert.equal(recovered.length, 1);
assert.equal(recovered[0].packetNumber, 0x1235);
assert.equal(recovered[0].type, USB_MESSAGE_TYPES.COMMAND);
assert.ok(recoveryParser.crcErrors >= 1);
assert.ok(recoveryParser.badFrames >= 1);
assert.equal(recoveryParser.recentErrors.length, 1);
assert.equal(recoveryParser.recentErrors[0].kind, 'crc');

const wrongVersionFrame = buildPacket(9, USB_MESSAGE_TYPES.DEBUG_TEXT, new Uint8Array(0), 2);
const versionRecoveryParser = new PacketStreamParser();
const versionRecovered = versionRecoveryParser.push(new Uint8Array([...wrongVersionFrame, ...nextFrame]));
assert.equal(versionRecovered.length, 1);
assert.equal(versionRecovered[0].packetNumber, 0x1235);
assert.ok(versionRecoveryParser.versionErrors >= 1);

const configSchema = getSchemaById(USB_MESSAGE_TYPES.CONFIG);
assert.ok(!getOutboundSchemas().some((schema) => schema.id === USB_MESSAGE_TYPES.CONFIG));

const setRequestPayload = encodePayload(configSchema, {
  operation: CONFIG_OPS.SET,
  entries: [
    { key: 0, value: 20 },
    { key: 6, value: -5 },
  ],
});
assert.deepEqual(
  Array.from(setRequestPayload),
  [CONFIG_VERSION, CONFIG_OPS.SET, 2, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x06, 0x00, 0xfb, 0xff, 0xff, 0xff],
);

// READ request entries are still 6 bytes each (key + value), matching SET's
// stride; the firmware ignores the value field for a READ.
const readRequestPayload = encodePayload(configSchema, {
  operation: CONFIG_OPS.READ,
  entries: [{ key: 1 }, { key: 4 }],
});
assert.deepEqual(
  Array.from(readRequestPayload),
  [CONFIG_VERSION, CONFIG_OPS.READ, 2, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
);

const zeroAllPayload = encodePayload(configSchema, { operation: CONFIG_OPS.ZERO_ALL, entries: [] });
assert.deepEqual(Array.from(zeroAllPayload), [CONFIG_VERSION, CONFIG_OPS.ZERO_ALL, 0]);

assert.throws(
  () => encodePayload(configSchema, {
    operation: CONFIG_OPS.SET,
    entries: Array.from({ length: 10 }, (_, index) => ({ key: index, value: 0 })),
  }),
  /at most 9 entries/,
);
assert.throws(
  () => encodePayload(configSchema, {
    operation: CONFIG_OPS.READ,
    entries: Array.from({ length: 9 }, (_, index) => ({ key: index })),
  }),
  /at most 8 entries/,
);

const setResponsePayload = new Uint8Array([
  CONFIG_VERSION, CONFIG_OPS.SET_RESPONSE, 2, CONFIG_RESULTS.OK,
  0x00, 0x00, CONFIG_RESULTS.OK,
  0x06, 0x00, CONFIG_RESULTS.INVALID_VALUE,
]);
const decodedSetResponse = decodePayload(configSchema, setResponsePayload);
assert.equal(decodedSetResponse.operation, CONFIG_OPS.SET_RESPONSE);
assert.equal(decodedSetResponse.result, CONFIG_RESULTS.OK);
assert.equal(decodedSetResponse.statuses.length, 2);
assert.deepEqual(decodedSetResponse.statuses[0], { key: 0, result: CONFIG_RESULTS.OK });
assert.deepEqual(decodedSetResponse.statuses[1], { key: 6, result: CONFIG_RESULTS.INVALID_VALUE });

const readResponsePayload = new Uint8Array([
  CONFIG_VERSION, CONFIG_OPS.READ_RESPONSE, 2, CONFIG_RESULTS.OK,
  0x00, 0x00, CONFIG_RESULTS.OK, 0x14, 0x00, 0x00, 0x00,
  0x04, 0x00, CONFIG_RESULTS.OK, 0x5a, 0x00, 0x00, 0x00,
]);
const decodedReadResponse = decodePayload(configSchema, readResponsePayload);
assert.equal(decodedReadResponse.operation, CONFIG_OPS.READ_RESPONSE);
assert.equal(decodedReadResponse.statuses.length, 2);
assert.deepEqual(decodedReadResponse.statuses[0], { key: 0, result: CONFIG_RESULTS.OK, value: 20 });
assert.deepEqual(decodedReadResponse.statuses[1], { key: 4, result: CONFIG_RESULTS.OK, value: 90 });

const maxReadResponsePayload = new Uint8Array(4 + 8 * 7);
assert.equal(maxReadResponsePayload.byteLength, MAX_PAYLOAD_SIZE);

const configFrame = buildPacket(0x55, USB_MESSAGE_TYPES.CONFIG, setRequestPayload);
const configParser = new PacketStreamParser();
const configPackets = configParser.push(configFrame);
assert.equal(configPackets.length, 1);
assert.equal(configPackets[0].type, USB_MESSAGE_TYPES.CONFIG);
assert.deepEqual(Array.from(configPackets[0].payload), Array.from(setRequestPayload));

// --- RF-level message codecs (STATUS0-6, radio CONFIG, COMMAND reuse) ---

// STATUS0 carries no RSSI: the drone's StatusMsg0_t pads out its last byte and
// reports link strength from StatusMsg2_t instead.
const status0Bytes = encodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS0, {
  loopTimeAvg: 1000, loopTimeMax: 2000, runTime: 500, currentMode: 4, reserved: 0,
});
assert.deepEqual(Array.from(status0Bytes), [0xe8, 0x03, 0xd0, 0x07, 0xf4, 0x01, 0x04, 0x00]);
const decodedStatus0 = decodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS0, status0Bytes);
assert.equal(decodedStatus0.loopTimeAvg, 1000);
assert.equal(decodedStatus0.loopTimeMax, 2000);
assert.equal(decodedStatus0.runTime, 500);
assert.equal(decodedStatus0.currentMode, 4);
assert.equal(decodedStatus0.rssi, undefined);

// STATUS2's motor fields are 2 bytes each on the wire (matching the drone's
// real StatusMsg2_t) - values above 255 prove this isn't truncated to a byte
// the way the base station's current (buggy) mirror struct would. Its final
// field is the uint16 RSSI that StatusMsg0_t used to carry as a uint8.
const status2Bytes = encodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS2, {
  motor1Set: 513, motor2Set: 7, voltage: 16800, rssi: 80,
});
assert.deepEqual(Array.from(status2Bytes), [0x01, 0x02, 0x07, 0x00, 0xa0, 0x41, 0x50, 0x00]);
const decodedStatus2 = decodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS2, status2Bytes);
assert.equal(decodedStatus2.motor1Set, 513);
assert.equal(decodedStatus2.motor2Set, 7);
assert.equal(decodedStatus2.voltage, 16800);
assert.equal(decodedStatus2.rssi, 80);

const radioConfigBytes = encodeRadioMessage(RADIO_MESSAGE_TYPES.CONFIG, {
  version: CONFIG_VERSION, state: CONFIG_OPS.READ, configKey: 4, value: 90,
});
assert.deepEqual(Array.from(radioConfigBytes), [0x02, 0x01, 0x04, 0x00, 0x5a, 0x00, 0x00, 0x00]);
assert.deepEqual(decodeRadioMessage(RADIO_MESSAGE_TYPES.CONFIG, radioConfigBytes), {
  version: CONFIG_VERSION, state: CONFIG_OPS.READ, configKey: 4, value: 90,
});

assert.deepEqual(
  Array.from(encodeRadioMessage(RADIO_MESSAGE_TYPES.COMMAND, commandValues)),
  Array.from(encodePayload(getSchemaById(USB_MESSAGE_TYPES.COMMAND), commandValues)),
);

assert.equal(RADIO_MESSAGE_TYPE_NAMES[RADIO_MESSAGE_TYPES.STATUS0], 'Status0');
assert.equal(RADIO_HANDSHAKE.IDENTIFY_QUERY, 0x3f);
assert.equal(RADIO_HANDSHAKE.DEVICE_KIND_DRONE_DIRECT, 0x01);
assert.equal(RADIO_HANDSHAKE.DEVICE_KIND_BASE_STATION_RELAY, 0x02);

assert.equal(formatDroneState(DRONE_STATES.FLIGHT), 'Flight');
assert.equal(formatDroneState(DRONE_STATES.READY_ARMED), 'Ready / Armed');
assert.equal(formatDroneState(undefined), '--');
assert.equal(formatDroneState(99), 'Unknown (99)');

// --- RADIO_PACKET envelope: bidirectional, 11 (outbound) or 12 (inbound) bytes ---

const radioPacketSchema = getSchemaById(USB_MESSAGE_TYPES.RADIO_PACKET);
assert.ok(!getOutboundSchemas().some((schema) => schema.id === USB_MESSAGE_TYPES.RADIO_PACKET));

// Outbound "please transmit" instruction: 11 bytes, no rssi, packetNum is a
// placeholder the relay is expected to replace with its own.
const outboundEnvelope = encodePayload(radioPacketSchema, {
  radioMessageType: RADIO_MESSAGE_TYPES.CONFIG,
  message: radioConfigBytes,
});
assert.deepEqual(Array.from(outboundEnvelope), [1, 0, RADIO_MESSAGE_TYPES.CONFIG, ...radioConfigBytes]);

assert.deepEqual(Array.from(encodeRadioConfigEnvelope(CONFIG_OPS.READ, 4, 90)), Array.from(outboundEnvelope));
assert.deepEqual(
  Array.from(encodeRadioCommandEnvelope(commandValues)),
  [1, 0, RADIO_MESSAGE_TYPES.COMMAND, ...encodeRadioMessage(RADIO_MESSAGE_TYPES.COMMAND, commandValues)],
);
assert.deepEqual(
  Array.from(encodeRadioPacketEnvelope(RADIO_MESSAGE_TYPES.STATUS0, status0Bytes)),
  [1, 0, RADIO_MESSAGE_TYPES.STATUS0, ...status0Bytes],
);

// Inbound, received-from-radio: 12 bytes, real rssi.
const receivedEnvelope = new Uint8Array([0, 7, RADIO_MESSAGE_TYPES.STATUS0, ...status0Bytes, 55]);
const decodedReceived = decodePayload(radioPacketSchema, receivedEnvelope);
assert.equal(decodedReceived.direction, 'received');
assert.equal(decodedReceived.directionRaw, 0);
assert.equal(decodedReceived.radioPacketNumber, 7);
assert.equal(decodedReceived.radioMessageType, RADIO_MESSAGE_TYPES.STATUS0);
assert.equal(decodedReceived.radioMessageTypeName, 'Status0');
assert.equal(decodedReceived.radioPayload, bytesToHex(status0Bytes));
assert.deepEqual(decodedReceived.decodedMessage, decodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS0, status0Bytes));
assert.equal(decodedReceived.rssi, 55);

// Inbound, sent-confirmation: 12 bytes, rssi=0 (present, not meaningful).
const sentEnvelope = new Uint8Array([1, 9, RADIO_MESSAGE_TYPES.COMMAND,
  ...encodeRadioMessage(RADIO_MESSAGE_TYPES.COMMAND, commandValues), 0]);
const decodedSent = decodePayload(radioPacketSchema, sentEnvelope);
assert.equal(decodedSent.direction, 'sent');
assert.equal(decodedSent.rssi, 0);

// Inbound, 11 bytes (no rssi byte at all): rssi decodes as null, not 0.
const elevenByteEnvelope = new Uint8Array([1, 9, RADIO_MESSAGE_TYPES.COMMAND,
  ...encodeRadioMessage(RADIO_MESSAGE_TYPES.COMMAND, commandValues)]);
assert.equal(decodePayload(radioPacketSchema, elevenByteEnvelope).rssi, null);

assert.throws(
  () => decodePayload(radioPacketSchema, new Uint8Array(9)),
  /11 or 12 bytes/,
);

const radioPacketFrame = buildPacket(0x66, USB_MESSAGE_TYPES.RADIO_PACKET, receivedEnvelope);
const radioPacketParser = new PacketStreamParser();
const radioPacketFramePackets = radioPacketParser.push(radioPacketFrame);
assert.equal(radioPacketFramePackets.length, 1);
assert.equal(radioPacketFramePackets[0].type, USB_MESSAGE_TYPES.RADIO_PACKET);
assert.deepEqual(Array.from(radioPacketFramePackets[0].payload), Array.from(receivedEnvelope));

// --- radio-relay.js: incremental telemetry patching, no aggregation ---

const relayTelemetry = {};
applyRadioStatusToTelemetry(relayTelemetry, RADIO_MESSAGE_TYPES.STATUS0,
  decodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS0, status0Bytes));
assert.deepEqual(relayTelemetry, { loopTimeAvg: 1000, loopTimeMax: 2000, runTime: 500, currentMode: 4 });

applyRadioStatusToTelemetry(relayTelemetry, RADIO_MESSAGE_TYPES.STATUS2, decodedStatus2);
assert.equal(relayTelemetry.motor1Set, 513);
assert.equal(relayTelemetry.motor2Set, 7);
assert.equal(relayTelemetry.rssi, 80);
// A STATUS2 update must not disturb fields owned by the earlier STATUS0 update.
assert.equal(relayTelemetry.loopTimeAvg, 1000);
assert.equal(relayTelemetry.currentMode, 4);

const beforeCommandNoop = { ...relayTelemetry };
applyRadioStatusToTelemetry(relayTelemetry, RADIO_MESSAGE_TYPES.COMMAND, commandValues);
assert.deepEqual(relayTelemetry, beforeCommandNoop);

// --- radio-relay.js: sequential single-key CONFIG requests, never concurrent ---

let requestInFlight = false;
let overlapDetected = false;
const sequencedKeys = [];
const fakeRequestOneAndWait = async (operation, key, value) => {
  if (requestInFlight) overlapDetected = true;
  requestInFlight = true;
  sequencedKeys.push({ operation, key, value });
  await new Promise((resolve) => { setTimeout(resolve, 2); });
  requestInFlight = false;
  return key === 2 ? null : { version: CONFIG_VERSION, state: CONFIG_RESULTS.OK, configKey: key, value: value + 1 };
};

const sequenceResults = [];
await sendRadioConfigSequence(
  CONFIG_OPS.SET,
  [{ key: 0, value: 10 }, { key: 2, value: 20 }, { key: 4, value: 30 }],
  fakeRequestOneAndWait,
  (key, reply) => sequenceResults.push({ key, reply }),
);

assert.equal(overlapDetected, false);
assert.deepEqual(sequencedKeys.map((entry) => entry.key), [0, 2, 4]);
assert.equal(sequenceResults.length, 3);
assert.equal(sequenceResults[0].reply.value, 11);
assert.equal(sequenceResults[1].reply, null);
assert.equal(sequenceResults[2].reply.value, 31);

// READ entries carry no value, and the sequencer must send 0 for it (radio
// CONFIG ignores the value field on a READ, per the firmware).
const readValuesSent = [];
await sendRadioConfigSequence(
  CONFIG_OPS.READ,
  [{ key: 5 }],
  async (operation, key, value) => { readValuesSent.push(value); return null; },
  () => {},
);
assert.deepEqual(readValuesSent, [0]);

// --- Quaternion / accel / velocity: Q15 + mm-scale fixed point ---

const baseTelemetryValues = {
  loopTimeAvg: 0, loopTimeMax: 0, runTime: 0, rssi: 0, currentMode: 0,
  gimbalPitch: 0, gimbalYaw: 0, topServoSet: 0, bottomServoSet: 0,
  motor1Set: 0, motor2Set: 0, voltage: 0,
  qR: 0, qI: 0, qJ: 0, qK: 0,
  accelX: 0, accelY: 0, accelZ: 0,
  velX: 0, velY: 0, velZ: 0,
  posX: 0, posY: 0, posZ: 0, latitude: 0, longitude: 0,
};

// A normalized quaternion (not identity, to exercise all four components)
// and physically plausible accel/velocity values, round-tripped through the
// direct-wire TELEMETRY schema.
const motionValues = {
  ...baseTelemetryValues,
  qR: 0.7071, qI: 0.5, qJ: -0.5, qK: 0.0, // not unit length on purpose - only checks scale/round-trip, not normalization
  accelX: 1.234, accelY: -9.81, accelZ: 0.5,
  velX: -2.5, velY: 0, velZ: 12.345,
};
const motionPayload = encodePayload(telemetrySchema, motionValues);
const decodedMotion = decodePayload(telemetrySchema, motionPayload);
for (const key of ['qR', 'qI', 'qJ', 'qK']) {
  assert.ok(Math.abs(decodedMotion[key] - motionValues[key]) < 1 / 32767, `${key} round-trips within Q15 tolerance`);
}
for (const key of ['accelX', 'accelY', 'accelZ', 'velX', 'velY', 'velZ']) {
  assert.ok(Math.abs(decodedMotion[key] - motionValues[key]) < 1 / 1000, `${key} round-trips within mm-scale tolerance`);
}

// Same fields, same scale, through the RF STATUS3 (quaternion) and
// STATUS4/STATUS5 (accel/velocity) schemas used in relay mode.
const status3Bytes2 = encodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS3, { qR: 1, qI: -1, qJ: 0.5, qK: -0.25 });
const decodedStatus3b = decodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS3, status3Bytes2);
assert.ok(Math.abs(decodedStatus3b.qR - 1) < 1 / 32767);
assert.ok(Math.abs(decodedStatus3b.qI - -1) < 1 / 32767);
assert.ok(Math.abs(decodedStatus3b.qJ - 0.5) < 1 / 32767);
assert.ok(Math.abs(decodedStatus3b.qK - -0.25) < 1 / 32767);

const status4Bytes = encodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS4, { accelX: 3.5, accelY: -3.5, accelZ: 9.81, reserved: 0 });
const decodedStatus4 = decodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS4, status4Bytes);
assert.ok(Math.abs(decodedStatus4.accelX - 3.5) < 1 / 1000);
assert.ok(Math.abs(decodedStatus4.accelY - -3.5) < 1 / 1000);
assert.ok(Math.abs(decodedStatus4.accelZ - 9.81) < 1 / 1000);

const status5Bytes = encodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS5, { velX: 1.111, velY: -1.111, velZ: 0, reserved: 0 });
const decodedStatus5 = decodeRadioMessage(RADIO_MESSAGE_TYPES.STATUS5, status5Bytes);
assert.ok(Math.abs(decodedStatus5.velX - 1.111) < 1 / 1000);
assert.ok(Math.abs(decodedStatus5.velY - -1.111) < 1 / 1000);

// Out-of-range quaternion component clamps to [-1, 1] rather than wrapping
// the wire int16 (same clamp-before-scale mechanism as gimbal degrees).
const clampedQuatPayload = encodePayload(telemetrySchema, { ...baseTelemetryValues, qR: 5, qI: -5 });
const decodedClampedQuat = decodePayload(telemetrySchema, clampedQuatPayload);
assert.equal(decodedClampedQuat.qR, 1);
assert.equal(decodedClampedQuat.qI, -1);

// --- quaternionToEulerDegrees: matches the firmware's Gyro::quaternionToEuler ---

const identityEuler = quaternionToEulerDegrees(1, 0, 0, 0);
assert.ok(Math.abs(identityEuler.yaw) < 1e-9);
assert.ok(Math.abs(identityEuler.pitch) < 1e-9);
assert.ok(Math.abs(identityEuler.roll) < 1e-9);

// Pure 90-degree rotation about the K (Z) axis: qR=qK=cos/sin(45deg).
// Z is this vehicle's roll axis (confirmed with the user), so this should
// show up as roll, not yaw.
const half90 = Math.SQRT1_2;
const roll90 = quaternionToEulerDegrees(half90, 0, 0, half90);
assert.ok(Math.abs(roll90.roll - 90) < 1e-6, `expected roll ~90, got ${roll90.roll}`);
assert.ok(Math.abs(roll90.pitch) < 1e-6);
assert.ok(Math.abs(roll90.yaw) < 1e-6);

console.log('Protocol framing and payload decoder tests passed');
