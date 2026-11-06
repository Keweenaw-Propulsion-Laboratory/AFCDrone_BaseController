import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import framing as f


def build(number, ftype, payload):
    body = number.to_bytes(2, "little") + bytes([ftype, len(payload)]) + bytes(payload)
    head = f.SYNC + bytes([1])
    frame = head + body
    return frame + f.crc16(frame[3:]).to_bytes(2, "little")


def radio(inner, message=b"\0" * 8):
    return build(1, f.USB_RADIO_PACKET, bytes([1, 0, inner]) + bytes(message))


class FramingTests(unittest.TestCase):
    def test_crc_check_value(self):
        self.assertEqual(f.crc16(b"123456789"), 0x29B1)

    def test_restamp_keeps_frame_valid(self):
        frame = build(5, f.USB_CONFIG, [1, 1, 0])
        stamped = f.restamp(frame, 4242)
        self.assertEqual(int.from_bytes(stamped[3:5], "little"), 4242)
        self.assertIsNotNone(f.parse_frame(stamped))

    def test_smuggled_second_frame_rejected(self):
        self.assertIsNone(f.parse_frame(build(1, f.USB_CONFIG, [1, 1, 0]) + build(1, 10, [11] + [0] * 7)))

    def test_viewer_scope(self):
        ok = dict(is_controller=False, drone_mode=4)
        self.assertIsNone(f.check_outbound(build(1, f.USB_CONFIG, [1, 1, 0]), **ok))
        self.assertIsNone(f.check_outbound(radio(f.RADIO_LOG_CONTROL, [3] + [0] * 7), **ok))
        self.assertIsNotNone(f.check_outbound(build(1, 10, [11] + [0] * 7), **ok))
        self.assertIsNotNone(f.check_outbound(radio(10), **ok))

    def test_flight_gating_for_everyone(self):
        for ctrl in (True, False):
            kw = dict(is_controller=ctrl, drone_mode=11)
            self.assertIsNotNone(f.check_outbound(build(1, f.USB_CONFIG, [1, f.CONFIG_SET, 0]), **kw))
            self.assertIsNotNone(f.check_outbound(build(1, f.USB_CONFIG, [1, f.CONFIG_ZERO_ALL, 0]), **kw))
            self.assertIsNotNone(f.check_outbound(build(1, f.USB_LOG_CONTROL, [f.LOG_START] + [0] * 7), **kw))
            self.assertIsNotNone(f.check_outbound(radio(f.RADIO_CONFIG, [3, f.CONFIG_SET, 0, 0, 0, 0, 0, 0]), **kw))
            self.assertIsNone(f.check_outbound(build(1, f.USB_CONFIG, [1, 1, 0]), **kw))  # read
            self.assertIsNone(f.check_outbound(build(1, f.USB_LOG_CONTROL, [f.LOG_MARK] + [0] * 7), **kw))

    def test_motors_only_in_flight(self):
        gimbal_only = build(1, f.USB_COMMAND, [0, 1, 2, 3, 4, 0, 0, 0])
        motors_on = build(1, f.USB_COMMAND, [0, 1, 2, 3, 4, 90, 0, 0])
        radio_motors = radio(f.RADIO_COMMAND, [0, 1, 2, 3, 4, 0, 50, 0])
        kw = dict(is_controller=True)
        self.assertIsNone(f.check_outbound(gimbal_only, drone_mode=10, **kw))      # armed: gimbal only
        self.assertIsNotNone(f.check_outbound(motors_on, drone_mode=10, **kw))     # armed: motors refused
        self.assertIsNotNone(f.check_outbound(radio_motors, drone_mode=10, **kw))
        self.assertIsNone(f.check_outbound(motors_on, drone_mode=11, **kw))        # flight: motors fine
        self.assertIsNone(f.check_outbound(radio_motors, drone_mode=12, **kw))
        self.assertIsNotNone(f.check_outbound(gimbal_only, drone_mode=4, **kw))    # safe: nothing

    def test_commands_need_an_armed_state(self):
        usb = build(1, f.USB_COMMAND, [0] * 8)
        rad = radio(f.RADIO_COMMAND)
        for frame in (usb, rad):
            self.assertIsNotNone(f.check_outbound(frame, is_controller=True, drone_mode=4))   # SAFE
            self.assertIsNone(f.check_outbound(frame, is_controller=True, drone_mode=10))     # READY_ARMED
            self.assertIsNone(f.check_outbound(frame, is_controller=True, drone_mode=11))     # MAN_FLIGHT
            self.assertIsNone(f.check_outbound(frame, is_controller=True, drone_mode=None))   # unknown

    def test_armed_allows_changes(self):
        kw = dict(is_controller=True, drone_mode=10)
        self.assertIsNone(f.check_outbound(build(1, f.USB_CONFIG, [1, f.CONFIG_SET, 0]), **kw))
        self.assertIsNone(f.check_outbound(build(1, f.USB_LOG_CONTROL, [f.LOG_START] + [0] * 7), **kw))

    def test_rx_scanner_tracks_mode_across_chunks_and_noise(self):
        telem = build(9, f.USB_TELEMETRY, [0] * 7 + [11] + [0] * 40)
        stream = b"\x00\xa5junk" + telem
        scanner = f.RxScanner()
        for i in range(0, len(stream), 5):
            scanner.feed(stream[i:i + 5])
        self.assertEqual(scanner.mode, 11)
        scanner.feed(radio(f.RADIO_STATUS0, [0, 0, 0, 0, 0, 0, 4, 0]))
        self.assertEqual(scanner.mode, 4)


if __name__ == "__main__":
    unittest.main()
