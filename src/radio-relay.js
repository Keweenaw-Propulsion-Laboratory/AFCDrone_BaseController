import {
  RADIO_MESSAGE_TYPES,
  USB_MESSAGE_TYPES,
  CONFIG_OPS,
  PROTOCOL_VERSION,
  encodeRadioMessage,
  encodePayload,
  getSchemaById,
} from './protocol.js';

const radioPacketSchema = getSchemaById(USB_MESSAGE_TYPES.RADIO_PACKET);

export function encodeRadioPacketEnvelope(radioMessageType, message) {
  return encodePayload(radioPacketSchema, { radioMessageType, message });
}

export function encodeRadioCommandEnvelope(commandValues) {
  const message = encodeRadioMessage(RADIO_MESSAGE_TYPES.COMMAND, commandValues);
  return encodeRadioPacketEnvelope(RADIO_MESSAGE_TYPES.COMMAND, message);
}

export function encodeRadioConfigEnvelope(operation, key, value = 0) {
  const message = encodeRadioMessage(RADIO_MESSAGE_TYPES.CONFIG, {
    version: PROTOCOL_VERSION,
    state: operation,
    configKey: key,
    value,
  });
  return encodeRadioPacketEnvelope(RADIO_MESSAGE_TYPES.CONFIG, message);
}

/**
 * Patches only the fields owned by one incoming STATUS0-STATUS6 message onto
 * a persistent telemetry-shaped object, mirroring the base station's current
 * applyRadioStatus(). Call this and re-render per packet as it arrives -
 * there is no buffering or aggregation step.
 */
export function applyRadioStatusToTelemetry(telemetry, radioMessageType, decodedMessage) {
  switch (radioMessageType) {
    case RADIO_MESSAGE_TYPES.STATUS0:
      telemetry.loopTimeAvg = decodedMessage.loopTimeAvg;
      telemetry.loopTimeMax = decodedMessage.loopTimeMax;
      telemetry.runTime = decodedMessage.runTime;
      telemetry.currentMode = decodedMessage.currentMode;
      // The drone's own self-reported uplink RSSI - distinct from the base
      // station's downlink RSSI, which comes from the RADIO_PACKET envelope.
      telemetry.rssi = decodedMessage.rssi;
      break;
    case RADIO_MESSAGE_TYPES.STATUS1:
      telemetry.gimbalPitch = decodedMessage.gimbalPitch;
      telemetry.gimbalYaw = decodedMessage.gimbalYaw;
      telemetry.topServoSet = decodedMessage.topServoSet;
      telemetry.bottomServoSet = decodedMessage.bottomServoSet;
      break;
    case RADIO_MESSAGE_TYPES.STATUS2:
      telemetry.motor1Set = decodedMessage.motor1Set;
      telemetry.motor2Set = decodedMessage.motor2Set;
      telemetry.voltage = decodedMessage.voltage;
      break;
    case RADIO_MESSAGE_TYPES.STATUS3:
      telemetry.qR = decodedMessage.qR;
      telemetry.qI = decodedMessage.qI;
      telemetry.qJ = decodedMessage.qJ;
      telemetry.qK = decodedMessage.qK;
      break;
    case RADIO_MESSAGE_TYPES.STATUS4:
      telemetry.accelX = decodedMessage.accelX;
      telemetry.accelY = decodedMessage.accelY;
      telemetry.accelZ = decodedMessage.accelZ;
      break;
    case RADIO_MESSAGE_TYPES.STATUS5:
      telemetry.velX = decodedMessage.velX;
      telemetry.velY = decodedMessage.velY;
      telemetry.velZ = decodedMessage.velZ;
      break;
    case RADIO_MESSAGE_TYPES.STATUS6:
      telemetry.posX = decodedMessage.posX;
      telemetry.posY = decodedMessage.posY;
      telemetry.posZ = decodedMessage.posZ;
      break;
    default:
      break;
  }
  return telemetry;
}

export const RADIO_CONFIG_REQUEST_TIMEOUT_MS = 750;
// A relay link can be saturated with STATUS0-6 telemetry, so a single
// request/reply is easy to lose in the noise - retry before giving up.
export const RADIO_CONFIG_MAX_ATTEMPTS = 3;

/**
 * Radio CONFIG only carries one key per message, so a batched Read/Apply
 * request from the Config tab becomes a sequence of single-key requests,
 * sent one at a time. requestOneAndWait(operation, key, value) must send the
 * request and resolve with the decoded reply (or null on timeout) before the
 * next entry is sent - the link is half-duplex and the relay's RX window
 * only opens every ~10ms, so entries are never sent concurrently.
 */
export async function sendRadioConfigSequence(operation, entries, requestOneAndWait, onEntryResult) {
  for (const entry of entries) {
    const value = operation === CONFIG_OPS.SET ? entry.value : 0;
    const reply = await requestOneAndWait(operation, entry.key, value);
    if (onEntryResult) onEntryResult(entry.key, reply);
  }
}
