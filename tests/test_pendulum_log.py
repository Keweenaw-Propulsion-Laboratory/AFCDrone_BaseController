import csv, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import framing as f
import pendulum_log as p


def build(ftype, payload):
    body = (7).to_bytes(2, "little") + bytes([ftype, len(payload)]) + bytes(payload)
    frame = f.SYNC + bytes([1]) + body
    return frame + f.crc16(frame[3:]).to_bytes(2, "little")


class PendulumLogTests(unittest.TestCase):
    def test_frames_reach_their_csv(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = p.PendulumLog(Path(tmp))
            rx = f.RxScanner()
            rx.on_frame = log.on_frame
            log.start()
            sync = p.TIMESYNC.pack(300, 1_000_000, 4_000_000_000, 1_002_000, 43, 812, 60)
            mag = p.PASS.pack(5, 2_000_500, 2_000_000, 2_001_000, 2_000_480, -12000, 30, 9, 210)
            # Split mid-frame to exercise reassembly
            stream = build(p.BASE_TIMESYNC, sync) + build(p.BASE_MAG_PASS, mag) + build(1, b"MAG 1 uT")
            rx.feed(stream[:10]); rx.feed(stream[10:])
            log.stop()

            files = {x.name.rsplit("_", 1)[1]: x for x in Path(tmp).iterdir()}
            rows = list(csv.DictReader(open(files["timesync.csv"])))
            self.assertEqual(rows[0]["seq"], "300")
            self.assertEqual(rows[0]["t2Us"], "4000000000")
            self.assertEqual(rows[0]["prevTxMinusRxUs"], "812")
            rows = list(csv.DictReader(open(files["passes.csv"])))
            self.assertEqual(rows[0]["centroidUs"], "2000500")
            self.assertEqual(rows[0]["peakRaw"], "-12000")
            rows = list(csv.DictReader(open(files["text.csv"])))
            self.assertEqual(rows[0]["text"], "MAG 1 uT")

    def test_nothing_written_before_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = p.PendulumLog(Path(tmp) / "x")
            log.on_frame(p.BASE_MAG_PASS, bytes(26))
            self.assertFalse((Path(tmp) / "x").exists())


if __name__ == "__main__":
    unittest.main()
