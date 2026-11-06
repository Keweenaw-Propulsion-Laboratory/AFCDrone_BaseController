#!/usr/bin/env python3
"""AERE drone dashboard server and server-side serial bridge."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web
import serial
from serial import SerialException
from serial.tools import list_ports

import framing

ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger("aere-dashboard")


@web.middleware
async def no_cache_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    """Prevent an older protocol.js build from surviving a dashboard restart."""
    response = await handler(request)
    if request.path == "/" or request.path.endswith((".html", ".css", ".js")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


class SerialBridge:
    """Own one serial connection and broadcast received bytes to web clients."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.clients: set[web.WebSocketResponse] = set()
        self.serial: serial.Serial | None = None
        self.port: str | None = None
        self.baud_rate: int | None = None
        self._reader_thread: threading.Thread | None = None
        self._stop_reader = threading.Event()
        self._write_lock = threading.Lock()
        # Exactly one client may drive the vehicle: write to the serial port,
        # open/close it and send heartbeats. Everyone else is a read-only
        # viewer. Overlapping heartbeat streams from several tabs would
        # interleave requested states, and the firmware acts on every change.
        self.controller: web.WebSocketResponse | None = None
        # While set, the controller's writes are dropped (see emergency_stop).
        self.estop_latched = False
        # The controller's relay/direct verdict, so viewers (which never run
        # the identify handshake) can decode the same stream.
        self.link_mode: dict[str, Any] = {"mode": None, "known": False}
        # The Drone::States the controller is currently asserting in its
        # heartbeats, mirrored from the controller's tab. Whoever takes over
        # keeps asserting exactly this, so a handoff is a pure keepalive for
        # the firmware (no requested-state edge) and the mode survives it.
        self.requested_state: int | None = None
        # The one viewer waiting for the controller to approve a handoff.
        self.pending_request: web.WebSocketResponse | None = None
        # Clients recently demoted: their in-flight heartbeats are dropped
        # silently instead of each producing an error toast.
        self._demoted_until: dict[web.WebSocketResponse, float] = {}
        # One packet counter for every client. Each browser used to number its
        # own frames, so the drone saw interleaved, repeating sequences.
        self.tx_number = 0
        # Tracks the drone's mode from its telemetry so the server can refuse
        # config and log changes in flight no matter which client asks.
        self.rx = framing.RxScanner()
        # Last known config values, keyed by config key. Filled by whichever
        # client talks to the drone; served to everyone, including late joiners.
        self.config_cache: dict[int, int] = {}
        self.config_updated: float | None = None
        # Last heartbeat request echoed to clients. Heartbeats go out 40 times
        # a second, so only a changed request is worth a row on the wire log.
        self.last_echoed_heartbeat: int | None = None

    def config_message(self, entries: dict[int, int] | None = None, reset: bool = False) -> dict[str, Any]:
        source = self.config_cache if entries is None else entries
        return {
            "event": "configCache",
            "reset": reset,
            "updatedAt": self.config_updated,
            "entries": [{"key": key, "value": value} for key, value in source.items()],
        }

    async def update_config_cache(self, entries: Any) -> None:
        if not isinstance(entries, list):
            raise ValueError("configCache entries must be a list")
        merged: dict[int, int] = {}
        for item in entries[:256]:
            if not isinstance(item, dict):
                continue
            key, value = item.get("key"), item.get("value")
            if (isinstance(key, int) and not isinstance(key, bool) and 0 <= key <= 0xFFFF
                    and isinstance(value, int) and not isinstance(value, bool)
                    and -(2**31) <= value < 2**31):
                merged[key] = value
        if not merged:
            return
        self.config_cache.update(merged)
        self.config_updated = time.time()
        await self.broadcast_json(self.config_message(merged))

    async def clear_config_cache(self) -> None:
        if not self.config_cache and self.config_updated is None:
            return
        self.config_cache.clear()
        self.config_updated = None
        await self.broadcast_json(self.config_message({}, reset=True))

    async def echo_tx(self, frame: bytes, sender: web.WebSocketResponse) -> None:
        """Tell every client what actually went on the wire, as stamped."""
        request = framing.heartbeat_request(frame)
        if request is not None:
            if request == self.last_echoed_heartbeat:
                return
            self.last_echoed_heartbeat = request
        await self.broadcast_json({
            "event": "tx",
            "by": "controller" if sender is self.controller else "viewer",
            "frame": base64.b64encode(frame).decode("ascii"),
        })

    def stamp(self, data: bytes) -> bytes:
        """Give an outbound frame the next shared packet number."""
        frame = framing.restamp(data, self.tx_number)
        self.tx_number = (self.tx_number + 1) & 0xFFFF
        return frame

    def role_message(
        self,
        ws: web.WebSocketResponse,
        reason: str | None = None,
        inherited: int | None = None,
    ) -> dict[str, Any]:
        return {
            "event": "role",
            "reason": reason,
            "inheritedState": inherited if ws is self.controller else None,
            "role": "controller" if ws is self.controller else "viewer",
            "controllerPresent": self.controller is not None,
            "viewers": max(len(self.clients) - (1 if self.controller else 0), 0),
        }

    async def broadcast_roles(self, reason: str | None = None, inherited: int | None = None) -> None:
        for client in tuple(self.clients):
            try:
                await client.send_json(self.role_message(client, reason, inherited))
            except (ConnectionResetError, RuntimeError):
                pass

    # -- control handoff ---------------------------------------------------
    #
    # A viewer asks; the controller approves or declines; the viewer may
    # override. All three end in transfer_control, which flips the seat in a
    # single step: the old controller's later writes are dropped, the new
    # one's are accepted, and the new one is told which requested state to
    # keep asserting. Both tabs heartbeat the same value across the flip, so
    # the drone's watchdog never starves and its mode never changes.

    async def _notify_pending(self, ws: web.WebSocketResponse | None, state: str) -> None:
        if ws is None or ws.closed:
            return
        try:
            await ws.send_json({"event": "controlRequestState", "state": state})
        except (ConnectionResetError, RuntimeError):
            pass

    async def _notify_controller_of_request(self, active: bool) -> None:
        controller = self.controller
        if controller is None or controller.closed:
            return
        try:
            await controller.send_json({"event": "controlRequest", "active": active})
        except (ConnectionResetError, RuntimeError):
            pass

    async def clear_pending(self, state: str = "none") -> None:
        pending = self.pending_request
        self.pending_request = None
        await self._notify_pending(pending, state)
        await self._notify_controller_of_request(False)

    async def transfer_control(self, new: web.WebSocketResponse | None, reason: str) -> None:
        old = self.controller
        inherited = self.requested_state if new is not None else None
        pending = self.pending_request
        self.pending_request = None
        self.controller = new
        self.estop_latched = False
        if old is not None and old is not new:
            self._demoted_until[old] = time.monotonic() + 3.0
        if new is None:
            self.requested_state = None  # a vacant seat restarts from SAFE
        LOG.info("Control transferred (%s): %s -> %s", reason,
                 "client" if old else "none", "client" if new else "none")
        await self.broadcast_roles(reason, inherited)
        await self._notify_pending(pending, "none")
        if old is not None and old is not new:
            try:
                await old.send_json({"event": "controlRequest", "active": False})
            except (ConnectionResetError, RuntimeError):
                pass

    async def request_control(self, ws: web.WebSocketResponse) -> None:
        if self.controller is ws:
            return
        if self.controller is None or self.controller.closed:
            await self.transfer_control(ws, "vacant")
            return
        if self.pending_request is not None and self.pending_request is not ws and not self.pending_request.closed:
            raise RuntimeError("Another client has already asked for control")
        self.pending_request = ws
        await self._notify_pending(ws, "waiting")
        await self._notify_controller_of_request(True)

    async def respond_control(self, ws: web.WebSocketResponse, accept: bool) -> None:
        self.require_controller(ws)
        pending = self.pending_request
        if pending is None or pending.closed:
            await self.clear_pending()
            return
        if accept:
            await self.transfer_control(pending, "handoff")
        else:
            await self.clear_pending("declined")

    async def cancel_request(self, ws: web.WebSocketResponse) -> None:
        if self.pending_request is ws:
            await self.clear_pending("cancelled")

    async def override_control(self, ws: web.WebSocketResponse) -> None:
        if self.controller is ws:
            return
        await self.transfer_control(ws, "override")

    def set_requested_state(self, ws: web.WebSocketResponse, value: Any) -> None:
        self.require_controller(ws)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 255:
            self.requested_state = value

    def is_demoted(self, ws: web.WebSocketResponse) -> bool:
        until = self._demoted_until.get(ws)
        if until is None:
            return False
        if time.monotonic() > until:
            del self._demoted_until[ws]
            return False
        return True

    async def emergency_stop(self, ws: web.WebSocketResponse) -> None:
        """Any client may trigger an E-STOP; control never changes hands.

        Viewers cannot transmit, so the stop is carried out by the controller's
        own tab. As a backstop that does not depend on that tab being alive,
        the server also drops everything the controller writes until the tab
        acknowledges. With no heartbeats the drone's watchdog disarms it.
        """
        LOG.warning("EMERGENCY STOP requested")
        controller = self.controller
        if controller is None or controller.closed:
            await ws.send_json({"event": "estopResult", "delivered": False})
            return
        self.estop_latched = True
        await self.broadcast_json({"event": "estopNotice", "by": "self" if ws is controller else "viewer"})
        try:
            await controller.send_json({"event": "estop"})
        except (ConnectionResetError, RuntimeError):
            pass  # latch stays up; writes are dropped until control changes

    def acknowledge_estop(self, ws: web.WebSocketResponse) -> None:
        if ws is self.controller:
            self.estop_latched = False

    async def release_control(self, ws: web.WebSocketResponse) -> None:
        if self.controller is not ws:
            return
        # A viewer already waiting simply gets the seat they asked for.
        await self.transfer_control(self.pending_request, "released")

    def require_controller(self, ws: web.WebSocketResponse) -> None:
        if self.controller is not ws:
            raise PermissionError("Viewers are read-only - request control first")

    async def set_link_mode(self, mode: Any, known: Any) -> None:
        mode = mode if mode in ("direct", "relay") else None
        self.link_mode = {"mode": mode, "known": bool(known) and mode is not None}
        await self.broadcast_json({"event": "linkMode", **self.link_mode})

    @property
    def connected(self) -> bool:
        return bool(self.serial and self.serial.is_open)

    def status(self) -> dict[str, Any]:
        return {
            "event": "status",
            "connected": self.connected,
            "port": self.port,
            "baudRate": self.baud_rate,
        }

    @staticmethod
    def ports() -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for item in sorted(list_ports.comports(), key=lambda entry: entry.device):
            result.append(
                {
                    "device": item.device,
                    "description": item.description or item.device,
                    "manufacturer": item.manufacturer,
                    "product": item.product,
                    "serialNumber": item.serial_number,
                    "vid": item.vid,
                    "pid": item.pid,
                    "hwid": item.hwid,
                }
            )
        return result

    async def add_client(self, ws: web.WebSocketResponse) -> None:
        self.clients.add(ws)
        # A vacant seat goes to the first client in. Nobody is ever promoted
        # automatically while a controller exists, or after one leaves.
        if self.controller is None:
            self.controller = ws
        await ws.send_json(self.role_message(ws))
        await ws.send_json({"event": "linkMode", **self.link_mode})
        await ws.send_json(self.status())
        if self.config_cache:
            await ws.send_json(self.config_message(reset=True))
        await ws.send_json({"event": "ports", "ports": self.ports()})
        await self.broadcast_roles()  # refresh everyone's viewer count

    async def remove_client(self, ws: web.WebSocketResponse) -> None:
        self.clients.discard(ws)
        self._demoted_until.pop(ws, None)
        if self.pending_request is ws:
            self.pending_request = None
            await self._notify_controller_of_request(False)
        if self.controller is ws:
            # The seat is never filled automatically - except for a viewer
            # who had explicitly asked for it. The vehicle then restarts from
            # SAFE: the departed controller's state is not inherited.
            self.requested_state = None
            pending = self.pending_request
            self.pending_request = None
            self.controller = pending
            self.estop_latched = False
            LOG.info("Controller disconnected; control is %s", "passed to the requester" if pending else "vacant")
            await self.broadcast_roles("disconnected")
            await self._notify_pending(pending, "none")
        else:
            await self.broadcast_roles()

    async def broadcast_json(self, payload: dict[str, Any]) -> None:
        dead: list[web.WebSocketResponse] = []
        for client in tuple(self.clients):
            try:
                await client.send_json(payload)
            except (ConnectionResetError, RuntimeError):
                dead.append(client)
        for client in dead:
            self.clients.discard(client)

    async def broadcast_binary(self, data: bytes) -> None:
        dead: list[web.WebSocketResponse] = []
        for client in tuple(self.clients):
            try:
                await client.send_bytes(data)
            except (ConnectionResetError, RuntimeError):
                dead.append(client)
        for client in dead:
            self.clients.discard(client)

    async def connect(self, port: str, baud_rate: int) -> None:
        if not port:
            raise ValueError("A serial port must be selected")
        if baud_rate <= 0:
            raise ValueError("Baud rate must be greater than zero")

        await self.disconnect(notify=False)
        try:
            connection = await asyncio.to_thread(
                serial.Serial,
                port=port,
                baudrate=baud_rate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=0.1,
                write_timeout=1.0,
            )
        except (SerialException, OSError) as exc:
            raise RuntimeError(f"Unable to open {port}: {exc}") from exc

        self.rx.reset()
        self.last_echoed_heartbeat = None
        self.serial = connection
        self.port = port
        self.baud_rate = baud_rate
        self._stop_reader.clear()
        self._reader_thread = threading.Thread(
            target=self._read_loop,
            name="aere-serial-reader",
            daemon=True,
        )
        self._reader_thread.start()
        LOG.info("Connected to serial port %s at %d baud", port, baud_rate)
        await self.broadcast_json(self.status())
        await self.clear_config_cache()

    async def disconnect(self, notify: bool = True) -> None:
        self._stop_reader.set()
        connection = self.serial
        self.serial = None

        if connection is not None:
            try:
                await asyncio.to_thread(connection.close)
            except (SerialException, OSError):
                LOG.exception("Error while closing serial port")

        thread = self._reader_thread
        self._reader_thread = None
        if thread and thread.is_alive() and thread is not threading.current_thread():
            await asyncio.to_thread(thread.join, 1.0)

        was_port = self.port
        self.port = None
        self.baud_rate = None
        self.link_mode = {"mode": None, "known": False}
        self.rx.reset()
        self.last_echoed_heartbeat = None
        if was_port:
            LOG.info("Disconnected serial port %s", was_port)
        if notify:
            await self.broadcast_json(self.status())
            await self.broadcast_json({"event": "linkMode", **self.link_mode})
            await self.clear_config_cache()

    async def write(self, data: bytes) -> None:
        connection = self.serial
        if not connection or not connection.is_open:
            raise RuntimeError("Server serial port is not connected")
        if not data:
            return

        def do_write() -> None:
            with self._write_lock:
                connection.write(data)
                connection.flush()

        try:
            await asyncio.to_thread(do_write)
        except (SerialException, OSError) as exc:
            await self.disconnect()
            raise RuntimeError(f"Serial write failed: {exc}") from exc

    def _read_loop(self) -> None:
        while not self._stop_reader.is_set():
            connection = self.serial
            if not connection or not connection.is_open:
                return
            try:
                waiting = connection.in_waiting
                data = connection.read(waiting if waiting > 0 else 1)
                if data:
                    self.rx.feed(bytes(data))
                    asyncio.run_coroutine_threadsafe(
                        self.broadcast_binary(bytes(data)), self.loop
                    )
            except (SerialException, OSError) as exc:
                LOG.error("Serial read failed: %s", exc)
                asyncio.run_coroutine_threadsafe(
                    self._handle_reader_failure(str(exc)), self.loop
                )
                return

    async def _handle_reader_failure(self, message: str) -> None:
        await self.broadcast_json({"event": "error", "message": f"Serial read failed: {message}"})
        await self.disconnect()


async def index_handler(_: web.Request) -> web.FileResponse:
    return web.FileResponse(ROOT / "index.html")


async def stylesheet_handler(_: web.Request) -> web.FileResponse:
    return web.FileResponse(ROOT / "styles.css")


async def logo_handler(_: web.Request) -> web.FileResponse:
    return web.FileResponse(ROOT / "Aere.png")


async def ports_handler(request: web.Request) -> web.Response:
    bridge: SerialBridge = request.app["bridge"]
    return web.json_response({"ports": bridge.ports(), "status": bridge.status()})


async def status_handler(request: web.Request) -> web.Response:
    bridge: SerialBridge = request.app["bridge"]
    return web.json_response(bridge.status())


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    bridge: SerialBridge = request.app["bridge"]
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1024 * 1024)
    await ws.prepare(request)
    await bridge.add_client(ws)
    last_denied = 0.0

    try:
        async for message in ws:
            if message.type == WSMsgType.BINARY:
                data = bytes(message.data)
                is_controller = bridge.controller is ws
                if is_controller and bridge.estop_latched:
                    continue  # E-STOP backstop: starve the watchdog
                if not is_controller and bridge.is_demoted(ws):
                    continue  # late heartbeats from a just-demoted pilot
                problem = framing.check_outbound(
                    data, is_controller=is_controller, drone_mode=bridge.rx.mode)
                if problem:
                    # Config sequences send many frames; one notice a second.
                    if time.monotonic() - last_denied > 1.0:
                        last_denied = time.monotonic()
                        await ws.send_json({"event": "error", "message": problem})
                    continue
                try:
                    frame = bridge.stamp(data)
                    await bridge.write(frame)
                    await bridge.echo_tx(frame, ws)
                except Exception as exc:  # Converted to a client-facing error.
                    await ws.send_json({"event": "error", "message": str(exc)})
                continue

            if message.type != WSMsgType.TEXT:
                continue

            try:
                payload = json.loads(message.data)
                action = payload.get("action")
                if action == "connect":
                    bridge.require_controller(ws)
                    await bridge.connect(str(payload.get("port", "")), int(payload.get("baudRate", 115200)))
                elif action == "disconnect":
                    bridge.require_controller(ws)
                    await bridge.disconnect()
                elif action == "requestControl":
                    await bridge.request_control(ws)
                elif action == "respondControl":
                    await bridge.respond_control(ws, bool(payload.get("accept")))
                elif action == "cancelRequest":
                    await bridge.cancel_request(ws)
                elif action == "overrideControl":
                    await bridge.override_control(ws)
                elif action == "configCache":
                    await bridge.update_config_cache(payload.get("entries"))
                elif action == "requestedState":
                    bridge.set_requested_state(ws, payload.get("state"))
                elif action == "estop":
                    await bridge.emergency_stop(ws)
                elif action == "estopAck":
                    bridge.acknowledge_estop(ws)
                elif action == "releaseControl":
                    await bridge.release_control(ws)
                elif action == "linkMode":
                    bridge.require_controller(ws)
                    await bridge.set_link_mode(payload.get("mode"), payload.get("known"))
                elif action == "listPorts":
                    await ws.send_json({"event": "ports", "ports": bridge.ports()})
                elif action == "status":
                    await ws.send_json(bridge.status())
                elif action == "ping":
                    await ws.send_json({"event": "pong"})
                else:
                    raise ValueError(f"Unknown action: {action}")
            except (ValueError, TypeError, json.JSONDecodeError, RuntimeError, PermissionError) as exc:
                await ws.send_json({"event": "error", "message": str(exc)})
    finally:
        await bridge.remove_client(ws)

    return ws


async def on_cleanup(app: web.Application) -> None:
    bridge: SerialBridge = app["bridge"]
    await bridge.disconnect(notify=False)


def build_app(loop: asyncio.AbstractEventLoop) -> web.Application:
    app = web.Application(middlewares=[no_cache_middleware])
    app["bridge"] = SerialBridge(loop)
    app.router.add_get("/", index_handler)
    app.router.add_get("/index.html", index_handler)
    app.router.add_get("/styles.css", stylesheet_handler)
    app.router.add_get("/Aere.png", logo_handler)
    app.router.add_get("/api/serial/ports", ports_handler)
    app.router.add_get("/api/serial/status", status_handler)
    app.router.add_get("/ws", websocket_handler)
    app.router.add_static("/src", ROOT / "src", show_index=False)
    app.router.add_static("/assets", ROOT / "assets", show_index=False)
    app.on_cleanup.append(on_cleanup)
    return app


async def run_server(args: argparse.Namespace) -> None:
    loop = asyncio.get_running_loop()
    app = build_app(loop)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.http_port)
    await site.start()

    bridge: SerialBridge = app["bridge"]
    if args.serial_port:
        try:
            await bridge.connect(args.serial_port, args.baud)
        except Exception:
            LOG.exception("Could not auto-connect the requested serial port")

    shown_host = "localhost" if args.host in {"0.0.0.0", "::"} else args.host
    LOG.info("Dashboard available at http://%s:%d", shown_host, args.http_port)
    await asyncio.Event().wait()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the AERE dashboard and bridge a server-local serial port")
    parser.add_argument("--host", default="0.0.0.0", help="HTTP bind address (default: 0.0.0.0)")
    parser.add_argument("--http-port", type=int, default=8000, help="HTTP port (default: 8000)")
    parser.add_argument("--serial-port", help="Serial port to open at startup, such as COM3 or /dev/ttyACM0")
    parser.add_argument("--baud", type=int, default=115200, help="Startup serial baud rate (default: 115200)")
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        asyncio.run(run_server(args))
    except KeyboardInterrupt:
        LOG.info("Server stopped")


if __name__ == "__main__":
    main()
