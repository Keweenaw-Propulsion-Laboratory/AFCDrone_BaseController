"""CSV logger for the pendulum timing test.

The base-station relay (AFCDrone_BaseStation) reports two kinds of event of
its own, both timed by the Uno's micros():

  BASE_TIMESYNC (20)  one completed clock-sync exchange with the drone
  BASE_MAG_PASS (21)  one pass of the drone's magnet over the TMAG5273

This writes each kind to its own CSV, plus every DEBUG_TEXT line (sensor
setup, range, live field) to a third, so a test run leaves:

  <dir>/pendulum_<stamp>_timesync.csv
  <dir>/pendulum_<stamp>_passes.csv
  <dir>/pendulum_<stamp>_text.csv

Pair them with the drone's SD log (scripts/decode_log.py, then
scripts/pendulum_sync.py in AFC-Drone). The PC's clock is recorded for
reference only: serial and USB delays make it useless for timing.
"""

from __future__ import annotations

import csv
import logging
import struct
import threading
import time
from pathlib import Path
from typing import IO, Any

LOG = logging.getLogger("aere-dashboard.pendulum")

USB_DEBUG_TEXT = 1
BASE_TIMESYNC = 20
BASE_MAG_PASS = 21

TIMESYNC = struct.Struct("<HIIIBHB")
PASS = struct.Struct("<HIIIIhhHH")
assert TIMESYNC.size == 18 and PASS.size == 26

TIMESYNC_FIELDS = ["seq", "t1Us", "t2Us", "t4Us", "prevSeq", "prevTxMinusRxUs", "rssi"]
PASS_FIELDS = ["index", "centroidUs", "startUs", "endUs", "peakUs",
               "peakRaw", "baselineRaw", "samples", "maxGapUs"]


class PendulumLog:
    """Writes base-station test frames to CSV. Thread-safe; files open lazily."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self._lock = threading.Lock()
        self._files: dict[int, IO[str]] = {}
        self._writers: dict[int, Any] = {}
        self._stem: Path | None = None
        self.counts = {BASE_TIMESYNC: 0, BASE_MAG_PASS: 0}

    def start(self) -> None:
        """Begin a new set of files; called when the serial port opens."""
        with self._lock:
            self._close_locked()
            self.directory.mkdir(parents=True, exist_ok=True)
            self._stem = self.directory / time.strftime("pendulum_%Y%m%d_%H%M%S")
            self.counts = {BASE_TIMESYNC: 0, BASE_MAG_PASS: 0}
            LOG.info("Pendulum log: %s_*.csv", self._stem)

    def stop(self) -> None:
        with self._lock:
            self._close_locked()
            if self._stem is not None:
                LOG.info("Pendulum log closed: %d sync exchanges, %d passes",
                         self.counts[BASE_TIMESYNC], self.counts[BASE_MAG_PASS])
            self._stem = None

    def on_frame(self, frame_type: int, payload: bytes) -> None:
        if frame_type == BASE_TIMESYNC and len(payload) == TIMESYNC.size:
            self._write(frame_type, "timesync", TIMESYNC_FIELDS, TIMESYNC.unpack(payload))
        elif frame_type == BASE_MAG_PASS and len(payload) == PASS.size:
            self._write(frame_type, "passes", PASS_FIELDS, PASS.unpack(payload))
        elif frame_type == USB_DEBUG_TEXT:
            self._write(frame_type, "text", ["text"], (payload.decode("ascii", "replace"),))

    def _write(self, frame_type: int, name: str, fields: list[str], values: tuple) -> None:
        with self._lock:
            if self._stem is None:
                return
            writer = self._writers.get(frame_type)
            if writer is None:
                f = open(f"{self._stem}_{name}.csv", "w", newline="")
                writer = csv.writer(f)
                writer.writerow(["hostTime"] + fields)
                self._files[frame_type] = f
                self._writers[frame_type] = writer
            writer.writerow([f"{time.time():.6f}", *values])
            # A few rows a second: flushing each keeps a crash from losing any.
            self._files[frame_type].flush()
            if frame_type in self.counts:
                self.counts[frame_type] += 1

    def _close_locked(self) -> None:
        for f in self._files.values():
            f.close()
        self._files.clear()
        self._writers.clear()
