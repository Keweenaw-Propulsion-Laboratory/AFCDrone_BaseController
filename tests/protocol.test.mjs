import assert from 'node:assert/strict';
import {
  USB_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  FRAME_OVERHEAD,
  COMMAND_PAYLOAD_SIZE,
  TELEMETRY_PAYLOAD_SIZE,
  COMMAND_FRAME_SIZE,
  TELEMETRY_FRAME_SIZE,
  PACKET_NUMBER_OFFSET,
  TYPE_OFFSET,
  LENGTH_OFFSET,
  PAYLOAD_OFFSET,
  CRC_DATA_OFFSET,
  CRC_SIZE,
  getSchemaById,
  encodePayload,
  decodePayload,
  buildPacket,
  crc16CcittFalse,
} from '../src/protocol.js';
import { PacketStreamParser } from '../src/serial-link.js';

assert.equal(crc16CcittFalse(new TextEncoder().encode('123456789')), 0x29b1);
assert.equal(FRAME_OVERHEAD, 9);
assert.equal(COMMAND_FRAME_SIZE, 17);
assert.equal(TELEMETRY_FRAME_SIZE, 63);

const commandSchema = getSchemaById(USB_MESSAGE_TYPES.COMMAND);
const commandValues = {
  flags: { targSlot: true, activeSlot: false },
  gimbalX: -1234,
  gimbalY: 2345,
  motor0Speed: 67,
  motor1Speed: 89,
  unused: 0,
};
const commandPayload = encodePayload(commandSchema, commandValues);
assert.equal(commandPayload.length, COMMAND_PAYLOAD_SIZE);
assert.deepEqual(Array.from(commandPayload), [0x01, 0x2e, 0xfb, 0x29, 0x09, 0x43, 0x59, 0x00]);

const decodedCommand = decodePayload(commandSchema, commandPayload);
assert.equal(decodedCommand.flags._raw, 0x01);
assert.equal(decodedCommand.flags.targSlot, true);
assert.equal(decodedCommand.flags.activeSlot, false);
assert.equal(decodedCommand.flags._reserved, 0);
assert.equal(decodedCommand.gimbalX, -1234);
assert.equal(decodedCommand.gimbalY, 2345);
assert.equal(decodedCommand.motor0Speed, 67);
assert.equal(decodedCommand.motor1Speed, 89);
assert.equal(decodedCommand.unused, 0);

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

console.log('Protocol framing and payload decoder tests passed');
