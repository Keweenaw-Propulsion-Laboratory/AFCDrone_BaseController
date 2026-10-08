# AERE Drone USB Serial Dashboard

A browser-based control and telemetry dashboard for the AERE AFC drone.

The drone connects by USB serial to the computer running the dashboard server. The Python server owns the serial port and forwards framed USB traffic to browser clients over WebSocket. This allows the dashboard to be opened locally or from another computer on the same network without requiring browser-side USB access.

## Features

- Server-side USB serial connection for Windows, Linux, and macOS
- Live telemetry cards and a complete decoded telemetry table
- Control-loop and RSSI graphs with selectable time windows
- Hover readouts with exact values and browser receive timestamps
- Satellite position map using telemetry latitude and longitude
- Target-slot, gimbal, and motor command controls
- Emergency stop action
- Optional continuous command transmission from 1 to 50 Hz
- CRC-validated framed packet parser with automatic resynchronization
- RX/TX packet monitor with raw frame, payload, and decoded-field views
- Debug-text terminal
- JSON packet-log export
- Schema-generated packet builder for adding new outbound packet types
- Demo telemetry mode for UI development without connected hardware

## Architecture

```text
┌─────────────────────┐      USB serial      ┌────────────────────────┐
│   Teensy / Drone    │ ◄──────────────────► │  Python serial server  │
│                     │                      │                        │
│ Framed USB protocol │                      │ aiohttp + pyserial     │
└─────────────────────┘                      └───────────┬────────────┘
                                                       │
                                             HTTP + WebSocket
                                                       │
                                         ┌─────────────▼─────────────┐
                                         │      Browser dashboard     │
                                         │                           │
                                         │ Telemetry, graphs, map,   │
                                         │ commands, packet monitor  │
                                         └───────────────────────────┘
```

The server maintains one physical serial connection. Multiple browser clients may view the same incoming data. Commands sent by any connected browser are forwarded to the drone.

## Requirements

- Python 3.10 or newer
- A USB serial device connected to the server computer
- A modern browser with JavaScript and WebSocket support
- Network access between the browser and dashboard server
- Client-side internet access for Leaflet and Esri satellite imagery

Python dependencies are listed in `requirements.txt`:

- `aiohttp`
- `pyserial`

Node.js is only required to run the protocol tests.

## Quick start

### Windows

Run:

```powershell
start-dashboard.bat
```

The script creates a local Python virtual environment, installs missing dependencies, and starts the server.

Open:

```text
http://localhost:8000
```

### Linux or macOS

```bash
chmod +x start-dashboard.sh
./start-dashboard.sh
```

Open:

```text
http://localhost:8000
```

The server listens on all interfaces by default. To use the dashboard from another computer, open:

```text
http://SERVER_HOSTNAME_OR_IP:8000
```

## Connect to the drone

1. Connect the drone controller to the server computer over USB.
2. Start the dashboard server.
3. Open the dashboard in a browser.
4. Select the correct server-side serial port.
5. Select the baud rate used by the firmware.
6. Select **Connect Serial**.
7. Open the **Packets** tab and verify that telemetry frames are arriving.

Use **Refresh Ports** after connecting or removing a USB serial device.

## Server options

A serial port can be opened automatically when the server starts.

### Linux or macOS

```bash
./start-dashboard.sh --serial-port /dev/ttyACM0 --baud 115200
```

### Windows

```powershell
start-dashboard.bat --serial-port COM3 --baud 115200
```

Available options:

```text
--host ADDRESS       HTTP bind address; default: 0.0.0.0
--http-port PORT     Dashboard HTTP port; default: 8000
--serial-port PORT   Serial port to open at startup
--baud RATE          Startup baud rate; default: 115200
--verbose            Enable debug logging
```

The server may also be started manually:

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

## Dashboard

### Header: battery and flight mode

The header shows battery voltage and flight mode on every tab. On screens wider than 820 px it also stays pinned to the top of the page while you scroll.

- **Battery** shows the telemetry `voltage` in volts and as a percentage. The percentage is linear across 13.09–16.5 V (4S LiPo). It turns amber at or below 40% and red at or below 20%. A reading of `0` means the drone is not reporting voltage yet, and the header shows `--`.
- **Flight mode** is one control rather than two. The selector shows the drone's reported `Drone::States` and follows it whenever the drone changes state on its own. Requesting a mode switches the selector to the requested state and highlights it until telemetry confirms the change, so the request and the reported state can never silently disagree. Requesting either flight state asks for confirmation first. States the ground cannot request — `BOOT`, the setup states and `FAULT_ERROR` — appear as a disabled `(reported)` entry so the drone's real state is always visible.

Both chips dim when no telemetry has arrived for 2 seconds.

#### Releasing to Safe

The firmware acts on the heartbeat's requested state only when it **changes**, so the dashboard never leaves a stale flight request asserted:

- Disconnecting, stopping demo mode, or 2 seconds without telemetry releases the request to Safe, with a toast and a terminal line.
- Whenever the drone reports a state it reached on its own — a watchdog trip, a fault, its boot sequence — the selector follows it and the request is released to Safe.
- An armed state is never adopted automatically. Taking control again is always an explicit request, which is what produces the `SAFE` → flight edge the firmware honors and what clears a latched `TRIPPED`.

### Live telemetry

The front page displays the latest decoded telemetry, including:

- loop timing
- runtime
- RSSI
- current mode
- gimbal position and servo setpoints
- motor setpoints
- voltage
- quaternion values
- acceleration
- velocity
- position
- latitude and longitude
- comm watchdog

The **Comm watchdog** stat in the Latest telemetry panel heading shows the drone's `watchDog` flags: *Fed* (green) when a heartbeat arrived within the last 100 ms, *Starved* (amber) when one has not, and *Tripped* (red) when the watchdog expired while movement was allowed. Hover it for the full explanation. *Tripped* is latched by the firmware and clears only once the dashboard has released its request back to Safe, so the event survives the outage that caused it; the dashboard raises a toast and a terminal line on the latch, not on the mode transition.

### Telemetry graphs

The dashboard includes live graphs for:

- average and maximum control-loop time
- RSSI

Available time windows are:

- 10 seconds
- 30 seconds
- 1 minute
- 5 minutes
- 15 minutes
- 30 minutes

Hover over a graph to see the closest sample's exact value and local browser receive timestamp. Longer windows are downsampled using minimum and maximum values so short timing spikes remain visible.

The browser retains up to 30 minutes of graph history. This history is local to the open browser tab and is not persisted after the page is closed or refreshed.

### Satellite map

The map reads the telemetry `latitude` and `longitude` fields and displays the latest valid position over Esri World Imagery.

Map behavior includes:

- default follow zoom of 22
- current-position marker
- bounded flight trail
- follow-drone toggle
- recenter control
- clear-trail control

A coordinate of `0, 0` is treated as unavailable GPS data.

Leaflet and the imagery tiles load directly in the browser. The Python server does not proxy map traffic.

### Commands

The command panel sends type `4` command packets containing:

- target slot
- active slot
- gimbal pitch
- gimbal yaw
- top motor speed (percent, scaled to 0 to 255 on the wire)
- bottom motor speed (percent, scaled to 0 to 255 on the wire)

The motor sliders are entered in percent (0 to 100) and are scaled to the 0 to 255 wire value when the command is encoded. Motor output is gated by the drone's own state, so the dashboard no longer carries a separate output interlock. The **Stop Motors** action immediately sets both motor commands to zero and transmits a command frame.

Continuous transmission can be enabled at a configurable rate from 1 to 50 Hz.

### Packet monitor

The packet monitor records received and transmitted frames and shows:

- direction
- timestamp
- packet number
- message type
- payload length
- CRC state
- decoded summary

Selecting a packet opens its:

- complete frame bytes
- payload bytes
- decoded values

The packet log can be exported as JSON.

### Debug terminal

Type `1` packets are decoded as raw text and appended to the debug terminal. Debug payloads do not require a NUL terminator and may be split across multiple frames.

## USB protocol

All traffic uses the same framed wire format.

```text
byte 0      sync0       0xA5
byte 1      sync1       0x5A
byte 2      version     0x01
byte 3      packetNum   uint16 little-endian, low byte
byte 4      packetNum   uint16 little-endian, high byte
byte 5      type        uint8
byte 6      length      uint8; payload length from 0 to 60
byte 7..    payload     exactly length bytes
final - 2   CRC low     CRC-16/CCITT-FALSE, little-endian
final - 1   CRC high
```

Total frame size:

```text
9 + payload length
```

### Message types

| Value | Name | Direction | Payload |
|---:|---|---|---|
| 0 | `RAW` | Both | Variable, 0–64 bytes |
| 1 | `DEBUG_TEXT` | Drone to dashboard | Variable, 0–64 bytes |
| 2 | `RADIO_PACKET` | Drone to dashboard | Variable, 0–64 bytes |
| 3 | `TELEMETRY` | Drone to dashboard | Exactly 64 bytes |
| 4 | `COMMAND` | Dashboard to drone | Exactly 8 bytes |
| 5 | `CONFIG` | Both | Variable, 3–60 bytes |
| 10 | `HEARTBEAT` | Dashboard to drone | Exactly 8 bytes, every 25 ms |

All multibyte fields are little-endian.

The USB payload ceiling is **64 bytes**, so a maximum frame is **73 bytes** (9 framing + 64 payload). `CONFIG` deliberately did not grow with it: both requests and read responses stay at 60 bytes.

A relay that forwards these frames over a UART needs `SERIAL_TX_BUFFER_SIZE >= 74`. `availableForWrite()` can never exceed `SERIAL_TX_BUFFER_SIZE - 1`, so a frame larger than the buffer is never written, never popped, and permanently blocks everything queued behind it. A buffer sized for the old 69-byte maximum will wedge. The drone is set to 256.

### CRC

The protocol uses CRC-16/CCITT-FALSE:

```text
Polynomial:     0x1021
Initial value:  0xFFFF
Final XOR:      0x0000
Reflection:     none
Wire order:     low byte, then high byte
```

CRC input is exactly:

```text
packetNum low | packetNum high | type | length | payload
```

The CRC does not include the sync bytes or protocol-version byte.

### Parser behavior

The client parser:

1. scans the byte stream for `A5 5A`
2. validates protocol version `1`
3. validates a payload length from 0 to 60
4. waits for the complete `9 + length` byte frame
5. calculates and validates the CRC
6. emits the decoded packet

Malformed frames are discarded and the parser resumes searching for the next sync sequence. Frames may be divided across arbitrary serial reads or WebSocket messages.

## Command payload

Command packets use type `4` and an eight-byte payload.

| Payload offset | Size | Field | Encoding |
|---:|---:|---|---|
| 0 | 1 | `flags` | bitfield |
| 1 | 2 | `gimbalPitch` | int16 LE |
| 3 | 2 | `gimbalYaw` | int16 LE |
| 5 | 1 | `motorTopSpeed` | uint8 |
| 6 | 1 | `motorBottomSpeed` | uint8 |
| 7 | 1 | unused | always `0` |

Flag bits:

| Bit | Name | Meaning |
|---:|---|---|
| 0 | `targSlot` | `0` selects target slot 0; `1` selects target slot 1 |
| 1 | `activeSlot` | Active target-slot selection |
| 2–7 | Reserved | Always sent as `0` |

A complete command frame is 17 bytes.

The current drone accepts inbound packets only when:

```text
version == 1
type == 4
length == 8
CRC is valid
```

The firmware does not currently emit a USB acknowledgement.

## Heartbeat payload

While a serial link is up and its direct/relay mode is known, the dashboard sends a heartbeat every 25 ms. It is type `10` on both links: a bare USB frame in direct mode, and an RFM69 message inside a `RADIO_PACKET` in relay mode, with the same 8 bytes either way.

| Payload offset | Size | Field | Encoding |
|---:|---:|---|---|
| 0 | 1 | `requestedState` | uint8 `Drone::States` to request |
| 1 | 7 | reserved | always `0` |

**Only `HEARTBEAT` feeds the link watchdog**, and the watchdog expires 100 ms after the last one. `COMMAND` traffic does not feed it, so streaming commands without heartbeats gets the vehicle disarmed. The watchdog is only evaluated at or above `READY_ARMED`. On expiry the actuators fail closed within one 1 kHz tick, the drone drops to `SAFE`, `TRIPPED` latches, and a one-shot `DEBUG_TEXT` reads `DRONE: COMM WATCHDOG EXPIRED -> SAFE`.

### Requested state is edge triggered

The firmware acts on `requestedState` only when it **changes**. A repeat of the last requested state is a keepalive and nothing else, which is what feeds the watchdog.

This is why there is no "no request" value. A heartbeat sent before a dropout is byte-identical to one sent after it, so honoring repeats would let a reconnecting client silently re-arm the vehicle the moment the link returned. The dashboard therefore always asserts something, and what it asserts when it wants nothing is `SAFE`.

The consequences for any client:

- On link loss, set the requested state to `SAFE` and keep sending heartbeats requesting `SAFE` while down or reconnecting.
- To resume, request the flight state again. That `SAFE` → flight edge is what the firmware honors, and it clears `TRIPPED`.
- A client that keeps asserting its pre-dropout flight state stays in `SAFE` indefinitely with **no error response**, because the request is not a change.

An escalation out of `SAFE` is also refused until the vehicle has been in `SAFE` for 500 ms. The refusal does not consume the request: holding the new state gets it honored on the first heartbeat after the dwell passes, which is what the dashboard does.

To keep the packet monitor readable, it logs only the first heartbeat after connecting and each heartbeat whose `requestedState` has changed.

Browsers throttle timers in background tabs, so heartbeats can slow down or stop when the dashboard tab is not in the foreground — which, now that the watchdog is enforced, will disarm a flying vehicle.

### `Drone::States`

The same enum is reported as telemetry `currentMode` / RF `STATUS0` `currentMode` and requested in heartbeat byte 0. The values are deliberately non-contiguous: `0`–`4` are the boot sequence, `10`–`12` are the live states.

| Value | Name | Meaning | Requestable |
|---:|---|---|---|
| 0 | `BOOT` | Firmware start-up | No |
| 1 | `RADIO_SETUP` | Bringing up the radio | No |
| 2 | `SENSOR_SETUP` | Bringing up the sensors | No |
| 3 | `CONTROL_SETUP` | Bringing up flight control | No |
| 4 | `SAFE` | No movement allowed but all systems go | Yes |
| 10 | `READY_ARMED` | Gimbal movement allowed | Yes |
| 11 | `MAN_FLIGHT` | Manual motors and gimbal | Yes |
| 12 | `AUTO_FLIGHT` | Flight-control driven motors and gimbal | Yes |
| 255 | `FAULT_ERROR` | Unrecoverable error has occurred | No |

The dashboard treats `MAN_FLIGHT` and `AUTO_FLIGHT` as "flying": both ask for confirmation before being requested, and both suppress the automatic config read on connect.

## Telemetry payload

Telemetry packets use type `3` and a 64-byte payload. A complete telemetry frame is 73 bytes and is normally emitted about every 100 ms.

The record grew from 54 to 64 bytes at the tail. Every pre-existing field kept its offset, so a decoder that reads by offset keeps working; one that asserts a 54-byte payload length rejects every frame.

| Offset | Size | Field | Encoding / unit |
|---:|---:|---|---|
| 0 | 2 | `loopTimeAvg` | uint16 LE, microseconds |
| 2 | 2 | `loopTimeMax` | uint16 LE, microseconds |
| 4 | 2 | `runTime` | uint16 LE, seconds since boot |
| 6 | 1 | `rssi` | uint8 |
| 7 | 1 | `currentMode` | uint8 |
| 8 | 2 | `gimbalPitch` | int16 LE |
| 10 | 2 | `gimbalYaw` | int16 LE |
| 12 | 2 | `topServoSet` | int16 LE |
| 14 | 2 | `bottomServoSet` | int16 LE |
| 16 | 1 | `motor1Set` | uint8 |
| 17 | 1 | `motor2Set` | uint8 |
| 18 | 2 | `voltage` | uint16 LE, battery millivolts; `0` = not reported |
| 20 | 2 | `qR` | int16 LE |
| 22 | 2 | `qI` | int16 LE |
| 24 | 2 | `qJ` | int16 LE |
| 26 | 2 | `qK` | int16 LE |
| 28 | 2 | `accelX` | int16 LE |
| 30 | 2 | `accelY` | int16 LE |
| 32 | 2 | `accelZ` | int16 LE |
| 34 | 2 | `velX` | int16 LE |
| 36 | 2 | `velY` | int16 LE |
| 38 | 2 | `velZ` | int16 LE |
| 40 | 2 | `posX` | int16 LE |
| 42 | 2 | `posY` | int16 LE |
| 44 | 2 | `posZ` | int16 LE |
| 46 | 4 | `latitude` | IEEE-754 float32 LE |
| 50 | 4 | `longitude` | IEEE-754 float32 LE |
| 54 | 1 | `watchDog` | uint8 flag bits, see below |
| 55 | 9 | reserved | always `0` |

`runTime` wraps after 65,536 seconds, or approximately 18.2 hours.

### `watchDog` flags

The same byte and encoding appear at telemetry offset 54 and at offset 7 of the 8-byte RF `STATUS0` frame, which previously transmitted it as a zero pad. There is no radio wire-size change.

| Bit | Name | Meaning |
|---:|---|---|
| 0 | `FED` | A heartbeat arrived within the last 100 ms. Live and self-clearing. |
| 1 | `TRIPPED` | The watchdog expired while movement was allowed. **Latched** — cleared only when the client releases its requested state to `SAFE`. |
| 2–7 | — | Reserved, zero. |

Alert on `TRIPPED` rather than on the state transition. It is latched precisely so the event survives the outage that caused it: over the radio nothing arrives while the link is down, so the `currentMode` change and the drone's `DEBUG_TEXT` are already in the past by the time packets resume.

## Adding packet types

Packet definitions are centralized in `src/protocol.js` in `PACKET_SCHEMAS`.

A fixed-length packet schema can define:

```js
{
  id: 5,
  name: 'Example Packet',
  direction: 'out',
  payloadSize: 4,
  fields: [
    { key: 'value', label: 'Value', type: 'uint16' },
    { key: 'enabled', label: 'Enabled', type: 'uint8' },
    { key: 'reserved', label: 'Reserved', type: 'uint8', default: 0 },
  ],
}
```

Supported numeric field types include:

- `uint8`
- `int8`
- `uint16`
- `int16`
- `uint32`
- `int32`
- `float32`
- `float64`

The schema system also supports bitfields, fixed-length strings, byte arrays, and custom encoder or decoder functions.

For an outbound fixed-length schema, the generic packet builder automatically creates input controls and uses the schema to encode the payload. Add dedicated UI controls in `index.html` and `src/app.js` only when the packet needs a specialized workflow.

When adding a packet type:

1. Assign its message-type value.
2. Add its schema to `PACKET_SCHEMAS`.
3. Add custom UI handling if needed.
4. Add encode/decode tests to `tests/protocol.test.mjs`.
5. Keep the payload at or below 64 bytes (60 for `CONFIG`).

## Project structure

```text
.
├── index.html                 Dashboard markup
├── styles.css                Dashboard styling
├── server.py                 HTTP, WebSocket, and serial bridge
├── requirements.txt          Python dependencies
├── start-dashboard.sh        Linux/macOS launcher
├── start-dashboard.bat       Windows launcher
├── src/
│   ├── app.js                Dashboard state and UI behavior
│   ├── protocol.js           Packet schemas, CRC, encoding, and decoding
│   └── serial-link.js        WebSocket link and streaming frame parser
└── tests/
    └── protocol.test.mjs     Protocol and parser tests
```

## Testing

Run the JavaScript protocol tests with Node.js:

```bash
node tests/protocol.test.mjs
```

The tests cover:

- CRC-16/CCITT-FALSE reference vector
- command encoding and decoding
- telemetry field offsets and decoding
- exact command and telemetry frame lengths
- signed integer and float32 handling
- fragmented input
- CRC rejection and stream recovery
- protocol-version rejection

## Linux serial permissions

The server account must have access to the serial device. On many Linux distributions, add the user to the `dialout` group:

```bash
sudo usermod -aG dialout "$USER"
```

Log out and back in before trying again. Some distributions use a different serial-device group.

## Troubleshooting

### No serial ports appear

- Confirm the drone is connected to the server computer, not only the browser computer.
- Select **Refresh Ports**.
- Check Device Manager on Windows or `ls /dev/ttyACM* /dev/ttyUSB*` on Linux.
- Verify Linux serial permissions.

### The server connects but no packets appear

- Verify the baud rate matches the firmware.
- Confirm the firmware is emitting framed USB packets.
- Open the packet monitor and check parser-error diagnostics.
- Avoid sending unframed `Serial.print()` output on the same serial stream.

### CRC errors appear

Verify that the firmware and dashboard both use:

- CRC-16/CCITT-FALSE
- initial value `0xFFFF`
- polynomial `0x1021`
- no reflection
- no final XOR
- CRC input beginning at the packet-number low byte
- CRC bytes transmitted low byte first

### The satellite map is blank

- Confirm the browser client has internet access.
- Check that latitude and longitude are nonzero and within valid ranges.
- Check the browser developer console for blocked Leaflet or imagery requests.

### Another browser can control the drone

This is expected. The server broadcasts incoming serial data to every connected client and accepts outgoing bytes from every connected client. Run the dashboard only on a trusted network or place it behind an authenticated reverse proxy.

## Security notes

The built-in server does not provide authentication, authorization, or TLS. Anyone who can reach the server can potentially connect the serial port and send command packets to the drone.

Recommended deployment practices:

- use the dashboard only on a trusted private network
- bind to `127.0.0.1` when remote access is unnecessary
- use a firewall to restrict port 8000
- place the server behind an authenticated HTTPS reverse proxy for shared deployments
- do not expose the dashboard directly to the public internet
