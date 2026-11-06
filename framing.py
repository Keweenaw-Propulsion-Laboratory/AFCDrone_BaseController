"""Wire-frame helpers for the dashboard server.

The server stamps every outbound frame with one shared packet number, decides
which frames each role may send, refuses config/log changes while the vehicle
is in flight, and tracks the drone's reported mode from its telemetry. The
frame layout mirrors src/protocol.js.
"""

from __future__ import annotations

SYNC = b"\xa5\x5a"
PREFIX = 7  # sync(2) version(1) packet number(2) type(1) length(1)
CRC_SIZE = 2
NUMBER_OFFSET = 3
TYPE_OFFSET = 5
LENGTH_OFFSET = 6

USB_RADIO_PACKET = 2
USB_TELEMETRY = 3
USB_CONFIG = 5
USB_LOG_CONTROL = 7

RADIO_STATUS0 = 1
RADIO_CONFIG = 9
RADIO_LOG_CONTROL = 14

CONFIG_SET = 0x02
CONFIG_ZERO_ALL = 0xFF
LOG_START, LOG_STOP, LOG_MARK = 1, 2, 3

# Drone::States that fly the vehicle (MAN_FLIGHT, AUTO_FLIGHT).
FLIGHT_STATES = (11, 12)
# READY_ARMED and the flight states: the only ones that may move the gimbal.
ARMED_STATES = (10, 11, 12)

USB_COMMAND = 4
RADIO_COMMAND = 8
# COMMAND payload: flags(1) pitch(2) yaw(2) top motor(1) bottom motor(1) pad(1).
COMMAND_MOTOR_OFFSETS = (5, 6)

# Payload offsets of currentMode: TELEMETRY, and the 8-byte STATUS0 message
# inside a RADIO_PACKET (whose message starts at payload byte 3).
TELEMETRY_MODE_OFFSET = 7
RADIO_STATUS0_MODE_OFFSET = 3 + 6


def crc16(data: bytes) -> int:
    """CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as in protocol.js."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def parse_frame(data: bytes) -> tuple[int, bytes] | None:
    """Return (type, payload) for exactly one CRC-valid frame, else None."""
    if len(data) < PREFIX + CRC_SIZE or data[:2] != SYNC:
        return None
    length = data[LENGTH_OFFSET]
    if len(data) != PREFIX + length + CRC_SIZE:
        return None  # also rejects a second frame smuggled behind the first
    end = PREFIX + length
    if crc16(data[NUMBER_OFFSET:end]) != int.from_bytes(data[end:end + 2], "little"):
        return None
    return data[TYPE_OFFSET], data[PREFIX:end]


def restamp(data: bytes, number: int) -> bytes:
    """Rewrite the packet number and fix the CRC. Expects a valid frame."""
    frame = bytearray(data)
    frame[NUMBER_OFFSET:NUMBER_OFFSET + 2] = (number & 0xFFFF).to_bytes(2, "little")
    end = PREFIX + frame[LENGTH_OFFSET]
    frame[end:end + 2] = crc16(bytes(frame[NUMBER_OFFSET:end])).to_bytes(2, "little")
    return bytes(frame)


def _command_motors(frame_type: int, payload: bytes) -> tuple[int, int] | None:
    """The (top, bottom) motor bytes of a COMMAND frame, else None."""
    base = 0 if frame_type == USB_COMMAND else 3  # radio message starts at 3
    top, bottom = (base + o for o in COMMAND_MOTOR_OFFSETS)
    if len(payload) <= bottom:
        return None
    return payload[top], payload[bottom]


def _classify(frame_type: int, payload: bytes) -> tuple[str, int | None]:
    """Name what a frame does: ('config', op), ('log', action), ('command', None)
    or ('other', None)."""
    if frame_type == USB_COMMAND:
        return "command", None
    if frame_type == USB_CONFIG and len(payload) >= 2:
        return "config", payload[1]
    if frame_type == USB_LOG_CONTROL and payload:
        return "log", payload[0]
    if frame_type == USB_RADIO_PACKET and len(payload) >= 4:
        inner, message = payload[2], payload[3:]
        if inner == RADIO_CONFIG and len(message) >= 2:
            return "config", message[1]  # ConfigPacket: version, state(op), ...
        if inner == RADIO_LOG_CONTROL and message:
            return "log", message[0]
        if inner == RADIO_COMMAND:
            return "command", None
    return "other", None


USB_HEARTBEAT = 10
RADIO_HEARTBEAT = 10


def heartbeat_request(data: bytes) -> int | None:
    """The requestedState a heartbeat frame carries, or None if it is not one."""
    parsed = parse_frame(data)
    if parsed is None:
        return None
    frame_type, payload = parsed
    if frame_type == USB_HEARTBEAT and payload:
        return payload[0]
    if frame_type == USB_RADIO_PACKET and len(payload) >= 4 and payload[2] == RADIO_HEARTBEAT:
        return payload[3]
    return None


def check_outbound(data: bytes, *, is_controller: bool, drone_mode: int | None) -> str | None:
    """Return why a client frame must be refused, or None to forward it."""
    parsed = parse_frame(data)
    if parsed is None:
        return "Malformed frame"
    frame_type, payload = parsed
    kind, op = _classify(frame_type, payload)

    # Viewers may only configure and log; nothing that moves the vehicle.
    if not is_controller and kind == "other":
        return "Viewers may only change config and SD logging - request control first"

    # The gimbal only moves when armed. A COMMAND carries gimbal targets, so
    # while the drone reports a state below READY_ARMED it is not sent at all.
    # An unknown mode (no telemetry yet) is not blocked.
    if kind == "command" and drone_mode is not None and drone_mode not in ARMED_STATES:
        return "Nothing moves in Safe: commands are only accepted when the vehicle is Ready/Armed or flying"

    # The motors only turn in flight: READY_ARMED moves the gimbal alone.
    if kind == "command" and drone_mode is not None and drone_mode not in FLIGHT_STATES:
        motors = _command_motors(frame_type, payload)
        if motors is None or any(motors):
            return "Motors only run in flight - send zero motor speed while merely armed"

    # Nobody changes config or starts/stops logging in flight. Reads and log
    # marks are fine at any time.
    if drone_mode in FLIGHT_STATES:
        if kind == "config" and op in (CONFIG_SET, CONFIG_ZERO_ALL):
            return "Config changes are blocked while the vehicle is in flight"
        if kind == "log" and op in (LOG_START, LOG_STOP):
            return "Log start/stop is blocked while the vehicle is in flight (marks are still allowed)"
    return None


class RxScanner:
    """Finds CRC-valid frames in the drone's byte stream and tracks its mode."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self.mode: int | None = None

    def reset(self) -> None:
        self._buffer.clear()
        self.mode = None

    def feed(self, data: bytes) -> None:
        self._buffer.extend(data)
        buf = self._buffer
        while True:
            start = buf.find(SYNC)
            if start < 0:
                del buf[:-1]  # keep a lone trailing 0xA5 that may start a sync
                return
            if start:
                del buf[:start]
            if len(buf) < PREFIX:
                return
            total = PREFIX + buf[LENGTH_OFFSET] + CRC_SIZE
            if len(buf) < total:
                return
            frame = bytes(buf[:total])
            if parse_frame(frame) is None:
                del buf[:2]  # false sync; resume the search after it
                continue
            del buf[:total]
            self._track(frame[TYPE_OFFSET], frame[PREFIX:total - CRC_SIZE])

    def _track(self, frame_type: int, payload: bytes) -> None:
        if frame_type == USB_TELEMETRY and len(payload) > TELEMETRY_MODE_OFFSET:
            self.mode = payload[TELEMETRY_MODE_OFFSET]
        elif (frame_type == USB_RADIO_PACKET and len(payload) > RADIO_STATUS0_MODE_OFFSET
              and payload[2] == RADIO_STATUS0):
            self.mode = payload[RADIO_STATUS0_MODE_OFFSET]
