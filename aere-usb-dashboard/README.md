# AERE Drone Serial Dashboard

A web dashboard for the AFC drone USB serial protocol. The Python server owns the physical serial port, while browser clients receive telemetry and send commands through a WebSocket connection to that server.

This allows the dashboard to be opened from another computer without giving that client direct access to the drone's USB device. The drone must be connected to the computer running `server.py`.

## Architecture

```text
Drone USB serial
       |
       v
Python dashboard server
  - opens COM or /dev/tty port
  - serves the dashboard
  - bridges serial bytes over WebSocket
       |
       v
One or more browser clients
```

The server maintains one serial connection. All open dashboard clients can view the same incoming telemetry. Because command packets are also forwarded, access to the dashboard should be limited to trusted users and networks.

## Features

- Server-side serial port selection and connection
- Remote browser access without Web Serial support
- Live decoding of the telemetry payload defined in `PACKET_SCHEMAS`
- Client-side satellite map following telemetry latitude and longitude at zoom 22
- Current telemetry cards plus interactive loop-time and RSSI histories
- Selectable graph windows from 10 seconds through 30 minutes
- Hover readouts with exact values and browser receipt timestamps
- Command controls for target slot, active slot, gimbal values, and both motors
- Motor output interlock and a stop-motors action
- Optional continuous command transmission from 1 to 50 Hz
- Debug-text terminal
- Framed RX/TX packet monitor with CRC validation, decoded fields, and hexadecimal inspection
- Generic outbound packet builder generated from packet schemas
- Raw packet builder for testing new packet types
- Packet log export to JSON
- Demo mode for testing the UI without hardware

## Requirements

- Python 3.10 or newer
- A serial device connected to the server computer
- Network access from the browser to the server's HTTP port
- Internet access from each browser client for Leaflet and satellite imagery tiles

The included start scripts create a local `.venv` and install:

- `aiohttp`
- `pyserial`

## Start the server

### Windows

Double-click `start-dashboard.bat`, or run:

```powershell
start-dashboard.bat
```

Then open:

```text
http://localhost:8000
```

### Linux or macOS

```bash
chmod +x start-dashboard.sh
./start-dashboard.sh
```

Then open:

```text
http://localhost:8000
```

The server listens on all interfaces by default. From another computer, use the server computer's hostname or IP address:

```text
http://SERVER_ADDRESS:8000
```

## Telemetry graphs

The dashboard front page includes live graphs for:

- average and maximum control-loop time
- radio RSSI

Both graphs use timestamped samples captured when each telemetry packet reaches the browser. Use the **Time span** selector to display the latest 10 seconds, 30 seconds, 1 minute, 5 minutes, 15 minutes, or 30 minutes. Both selectors stay synchronized so the graphs use the same time window.

Hover over either graph to display the closest sample with its exact value and local browser timestamp. The loop-time tooltip shows both average and maximum values from the same telemetry interval. Current values are also shown directly above each graph.

The browser retains up to 30 minutes of chart history. Long time windows are downsampled for drawing performance while preserving the minimum and maximum points in each display bucket, so short loop-time spikes remain visible.

## Satellite position map

The **Flight position** panel reads the `latitude` and `longitude` fields from each telemetry packet. After the first non-zero, valid coordinate arrives, the map:

- places a marker at the latest position
- maintains a short flight trail
- centers the marker at zoom level 22 while **Follow drone** is enabled
- allows manual panning and zooming when follow mode is disabled
- returns to the latest coordinate with **Recenter**

Leaflet and Esri World Imagery are loaded directly by the browser; map traffic does not pass through `server.py`. The page therefore needs client-side internet access even when the serial bridge is running entirely on a local network.

The imagery layer uses native tiles through zoom 19 and digitally enlarges them through zoom 22. Actual ground resolution depends on imagery coverage at the reported coordinates. A coordinate of `0, 0` is treated as no GPS fix because the current firmware initializes unavailable telemetry fields to zero.

## Connect to the drone

1. Connect the drone controller over USB to the server computer.
2. Start the dashboard server.
3. Open the dashboard in a browser.
4. Select the serial device listed under **Server port**.
5. Select the baud rate.
6. Select **Connect Serial**.
7. Open the **Packets** tab to verify frames are arriving.

Use **Refresh Ports** after plugging in or removing a serial device.

## Start with a serial port already connected

The server can open a port during startup:

### Linux

```bash
./start-dashboard.sh --serial-port /dev/ttyACM0 --baud 115200
```

### Windows

```powershell
start-dashboard.bat --serial-port COM3 --baud 115200
```

Other server options:

```text
--host ADDRESS       HTTP bind address; default 0.0.0.0
--http-port PORT     Dashboard HTTP port; default 8000
--serial-port PORT   Port to open at startup
--baud RATE          Startup baud rate; default 115200
--verbose            Enable debug logging
```

## Linux serial permissions

The account running the server must have access to the serial device. On many distributions, add the account to the `dialout` group:

```bash
sudo usermod -aG dialout "$USER"
```

Log out and back in before trying again. The exact group may differ by distribution.

## Current USB protocol

All USB traffic uses the same framed wire format:

```text
byte 0      sync0       0xA5
byte 1      sync1       0x5A
byte 2      version     0x01
byte 3      packetNum   uint16 little-endian, low byte
byte 4      packetNum   uint16 little-endian, high byte
byte 5      type        uint8
byte 6      length      uint8; number of payload bytes, 0-60
byte 7..    payload     exactly length bytes
final - 2   CRC low     CRC-16/CCITT-FALSE, little-endian
final - 1   CRC high
```

The total frame size is always:

```text
9 + length bytes
```

Message types are:

| Value | Name |
|---:|---|
| 0 | RAW |
| 1 | DEBUG_TEXT |
| 2 | RADIO_PACKET |
| 3 | TELEMETRY |
| 4 | COMMAND |

All multibyte values are little-endian.

### CRC configuration

The dashboard uses **CRC-16/CCITT-FALSE** with:

- polynomial `0x1021`
- initial value `0xFFFF`
- no reflection
- no final XOR
- wire order: CRC low byte, then CRC high byte

CRC input is exactly:

```text
packetNum low | packetNum high | type | length | payload
```

The CRC excludes the two sync bytes and protocol-version byte.

### Parser behavior

The browser parser scans the serial byte stream for `A5 5A`, then validates:

1. protocol version is `1`
2. payload length is between `0` and `60`
3. the complete `9 + length` byte frame is available
4. the received CRC matches the calculated CRC

Malformed frames are ignored and the parser resumes scanning for the next `A5 5A` sequence. The parser handles frames split across arbitrary WebSocket or serial chunks.

### Command payload

Commands use type `4` and must contain exactly 8 payload bytes. A complete command frame is 17 bytes.

| Payload offset | Size | Field |
|---:|---:|---|
| 0 | 1 | Flags |
| 1 | 2 | `gimbalX`, signed int16 little-endian |
| 3 | 2 | `gimbalY`, signed int16 little-endian |
| 5 | 1 | `motor0Speed`, uint8 |
| 6 | 1 | `motor1Speed`, uint8 |
| 7 | 1 | Unused; always sent as zero |

Flags:

- bit 0: `targSlot`
- bit 1: `activeSlot`
- bits 2-7: reserved and always sent as zero

The current drone accepts inbound frames only when version is `1`, type is `COMMAND`, payload length is `8`, and the CRC is valid. It does not currently emit a USB ACK.

### Telemetry payload

Telemetry uses type `3` and exactly 54 payload bytes. A complete telemetry frame is 63 bytes. Telemetry is normally emitted about every 100 ms.

| Payload offset | Size | Field | Encoding/unit |
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
| 18 | 2 | `voltage` | uint16 LE |
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

`runTime` wraps after 65,536 seconds, approximately 18.2 hours.

### Debug text

Debug text uses type `1`. Its payload is decoded as raw text bytes without requiring a NUL terminator. Firmware may split a longer message into independent chunks of up to 60 bytes.

## Add a packet structure

Packet layouts are defined in `src/protocol.js` inside `PACKET_SCHEMAS`. Adding a fixed-length packet usually requires only one schema object:

```js
{
  id: 5,
  name: 'Configuration',
  direction: 'out',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'uint8', default: 0 },
    { key: 'gain', label: 'Gain', type: 'float32', default: 1.0 },
    { key: 'limit', label: 'Limit', type: 'int16', default: 0 },
  ],
}
```

The generic packet builder automatically creates inputs for outbound schemas. Incoming packets are decoded and shown in the packet monitor.

Supported field types:

- `uint8`, `int8`
- `uint16`, `int16`
- `uint32`, `int32`
- `float32`, `float64`
- `bitfield8`
- fixed-length `bytes`
- fixed-length `string`

For variable-length or unusual layouts, add a custom `decoder(payload)` or `encoder(values)` function to the schema.

## Files

- `server.py` - HTTP server, WebSocket endpoint, and server-side serial connection
- `requirements.txt` - Python runtime dependencies
- `index.html` - dashboard structure
- `styles.css` - responsive dashboard styling
- `src/protocol.js` - packet IDs, schemas, encoder, decoder, and frame builder
- `src/serial-link.js` - WebSocket client and streaming packet parser
- `src/app.js` - UI state and event handling

## Protocol tests

With Node.js installed, run the framing, CRC, fragmentation, and resynchronization tests with:

```bash
node --experimental-default-type=module tests/protocol.test.mjs
```
