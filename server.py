#!/usr/bin/env python3
"""AERE drone dashboard server and server-side serial bridge."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web
import serial
from serial import SerialException
from serial.tools import list_ports

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
        await ws.send_json(self.status())
        await ws.send_json({"event": "ports", "ports": self.ports()})

    def remove_client(self, ws: web.WebSocketResponse) -> None:
        self.clients.discard(ws)

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
        if was_port:
            LOG.info("Disconnected serial port %s", was_port)
        if notify:
            await self.broadcast_json(self.status())

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

    try:
        async for message in ws:
            if message.type == WSMsgType.BINARY:
                try:
                    await bridge.write(bytes(message.data))
                except Exception as exc:  # Converted to a client-facing error.
                    await ws.send_json({"event": "error", "message": str(exc)})
                continue

            if message.type != WSMsgType.TEXT:
                continue

            try:
                payload = json.loads(message.data)
                action = payload.get("action")
                if action == "connect":
                    await bridge.connect(str(payload.get("port", "")), int(payload.get("baudRate", 115200)))
                elif action == "disconnect":
                    await bridge.disconnect()
                elif action == "listPorts":
                    await ws.send_json({"event": "ports", "ports": bridge.ports()})
                elif action == "status":
                    await ws.send_json(bridge.status())
                elif action == "ping":
                    await ws.send_json({"event": "pong"})
                else:
                    raise ValueError(f"Unknown action: {action}")
            except (ValueError, TypeError, json.JSONDecodeError, RuntimeError) as exc:
                await ws.send_json({"event": "error", "message": str(exc)})
    finally:
        bridge.remove_client(ws)

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
    app.router.add_get("/api/serial/ports", ports_handler)
    app.router.add_get("/api/serial/status", status_handler)
    app.router.add_get("/ws", websocket_handler)
    app.router.add_static("/src", ROOT / "src", show_index=False)
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
