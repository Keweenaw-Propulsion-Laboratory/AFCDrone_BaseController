import queue
import struct
import threading
import time
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk
import serial
import serial.tools.list_ports

# ==============================================================================
# TX MESSAGE STRUCTURES
# ==============================================================================


class BaseMessageFrame(ttk.LabelFrame):
    """Abstract base frame for outgoing message structures."""

    def __init__(self, parent, title):
        super().__init__(parent, text=title, padding=12)

    def pack_data(self) -> bytes:
        raise NotImplementedError("Subclasses must implement pack_data()")


class CommandFrame(BaseMessageFrame):
    """UI Layout and Packing logic for Command_t (ID 1)."""

    def __init__(self, parent):
        super().__init__(parent, title="Command Struct Parameters (Command_t)")
        self.columnconfigure(1, weight=1)

        # Bitfield Flags
        flags_frame = ttk.LabelFrame(self, text="Bitfield Flags", padding=8)
        flags_frame.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 10))

        self.targ_slot_var = tk.BooleanVar(value=False)
        self.active_slot_var = tk.BooleanVar(value=False)

        ttk.Checkbutton(
            flags_frame, text="Target Slot (Bit 0)", variable=self.targ_slot_var
        ).pack(side="left", padx=10)
        ttk.Checkbutton(
            flags_frame,
            text="Active Slot (Bit 1)",
            variable=self.active_slot_var,
        ).pack(side="left", padx=10)

        # Fields Grid
        fields = [
            ("Gimbal X (-32768 to 32767):", "0", "gimbal_x"),
            ("Gimbal Y (-32768 to 32767):", "0", "gimbal_y"),
            ("Motor 0 Speed (0 to 255):", "0", "motor0"),
            ("Motor 1 Speed (0 to 255):", "0", "motor1"),
        ]

        self.entries = {}
        for idx, (label_text, default_val, key) in enumerate(fields, start=1):
            ttk.Label(self, text=label_text).grid(
                row=idx, column=0, sticky="w", pady=4, padx=5
            )
            entry = ttk.Entry(self)
            entry.insert(0, default_val)
            entry.grid(row=idx, column=1, sticky="ew", pady=4, padx=5)
            self.entries[key] = entry

    def pack_data(self) -> bytes:
        targ = 1 if self.targ_slot_var.get() else 0
        active = 1 if self.active_slot_var.get() else 0
        flags_byte = (targ & 0x01) | ((active & 0x01) << 1)

        try:
            gimbal_x = int(self.entries["gimbal_x"].get())
            gimbal_y = int(self.entries["gimbal_y"].get())
            motor0 = int(self.entries["motor0"].get())
            motor1 = int(self.entries["motor1"].get())
            empty0 = 0
        except ValueError:
            raise ValueError("All fields must contain valid integer numbers.")

        # Optional Header: Msg ID = 1, Length = 8 bytes
        header = struct.pack("<BB", 1, 8)
        payload = struct.pack(
            "<BhhBBB", flags_byte, gimbal_x, gimbal_y, motor0, motor1, empty0
        )
        return header + payload


# ==============================================================================
# RX TELEMETRY DASHBOARD WIDGET (STATUS ID = 3)
# ==============================================================================


class StatusDashboardFrame(ttk.LabelFrame):
    """UI Widget to display unpacked incoming Status_t (ID 3) Telemetry."""

    # Unpack String Matching C Struct:
    # 3H: loopTimeAvg, loopTimeMax, runTime
    # 2B: rssi, currentMode
    # 4h: gimbalPitch, gimbalYaw, topServoSet, bottomServoSet
    # 2B: motor1Set, motor2Set
    # 1H: voltage
    # 4h: qR, qI, qJ, qK
    # 3h: accelX, accelY, accelZ
    # 3h: velX, velY, velZ
    # 3h: posX, posY, posZ
    # 2f: latitude, longitude
    STRUCT_FORMAT = "<3H2B4h2BH4h3h3h3h2f"
    EXPECTED_SIZE = struct.calcsize(STRUCT_FORMAT)  # 54 bytes

    def __init__(self, parent):
        super().__init__(
            parent, text="Live Status Telemetry (ID: 3)", padding=10
        )

        self.vars = {}
        fields = [
            ("Run Time (ms)", "runTime"),
            ("Loop Avg/Max (us)", "loopTime"),
            ("RSSI / Mode", "rssiMode"),
            ("Voltage (mV)", "voltage"),
            ("Gimbal Pitch / Yaw", "gimbal"),
            ("Servos (Top/Bot)", "servos"),
            ("Motors (1 / 2)", "motors"),
            ("Accel (X, Y, Z)", "accel"),
            ("Vel (X, Y, Z)", "vel"),
            ("Pos (X, Y, Z)", "pos"),
            ("Quaternion (R,I,J,K)", "quat"),
            ("Lat / Long", "gps"),
        ]

        grid_frame = ttk.Frame(self)
        grid_frame.pack(fill="both", expand=True)

        for idx, (label_text, key) in enumerate(fields):
            row = idx // 2
            col = (idx % 2) * 2

            ttk.Label(
                grid_frame,
                text=f"{label_text}:",
                font=("Helvetica", 9, "bold"),
            ).grid(row=row, column=col, sticky="w", padx=5, pady=2)

            var = tk.StringVar(value="--")
            self.vars[key] = var
            ttk.Label(
                grid_frame,
                textvariable=var,
                foreground="#0066cc",
                font=("Consolas", 9, "bold"),
            ).grid(row=row, column=col + 1, sticky="w", padx=5, pady=2)

    def unpack_and_update(self, payload_bytes: bytes) -> str:
        """Unpacks byte payload and updates dashboard GUI fields."""
        if len(payload_bytes) < self.EXPECTED_SIZE:
            # Handle possible truncated packet
            payload_bytes = payload_bytes.ljust(self.EXPECTED_SIZE, b"\x00")

        unpacked = struct.unpack(
            self.STRUCT_FORMAT, payload_bytes[: self.EXPECTED_SIZE]
        )

        (
            loop_avg,
            loop_max,
            runtime,
            rssi,
            mode,
            g_pitch,
            g_yaw,
            top_s,
            bot_s,
            m1,
            m2,
            volts,
            qR,
            qI,
            qJ,
            qK,
            ax,
            ay,
            az,
            vx,
            vy,
            vz,
            px,
            py,
            pz,
            lat,
            lon,
        ) = unpacked

        # Update GUI Variables
        self.vars["runTime"].set(f"{runtime} ms")
        self.vars["loopTime"].set(f"{loop_avg} / {loop_max}")
        self.vars["rssiMode"].set(f"{rssi} dBm | Mode {mode}")
        self.vars["voltage"].set(f"{volts} mV")
        self.vars["gimbal"].set(f"P: {g_pitch} | Y: {g_yaw}")
        self.vars["servos"].set(f"T: {top_s} | B: {bot_s}")
        self.vars["motors"].set(f"M1: {m1} | M2: {m2}")
        self.vars["accel"].set(f"{ax}, {ay}, {az}")
        self.vars["vel"].set(f"{vx}, {vy}, {vz}")
        self.vars["pos"].set(f"{px}, {py}, {pz}")
        self.vars["quat"].set(f"{qR}, {qI}, {qJ}, {qK}")
        self.vars["gps"].set(f"{lat:.5f}, {lon:.5f}")

        return (
            f"Mode={mode}, Volts={volts}mV, Pos=({px},{py},{pz}),"
            f" GPS=({lat:.4f},{lon:.4f})"
        )


# ==============================================================================
# MAIN APPLICATION
# ==============================================================================


class SerialSenderApp(tk.Tk):

    def __init__(self):
        super().__init__()
        self.title("Serial USB Message Interface & Decoder")
        self.geometry("1100x700")
        self.minsize(900, 550)

        self.serial_port = None
        self.rx_thread = None
        self.stop_thread_event = threading.Event()
        self.rx_queue = queue.Queue()
        self.rx_stream_buffer = bytearray()

        self._build_ui()
        self.after(50, self._process_rx_queue)

    def _build_ui(self):
        paned_window = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        paned_window.pack(fill="both", expand=True, padx=10, pady=10)

        # ----------------------------------------------------------------------
        # LEFT PANEL (TX / Connection Controls)
        # ----------------------------------------------------------------------
        left_panel = ttk.Frame(paned_window)
        paned_window.add(left_panel, weight=1)

        # Serial Connection Frame
        conn_frame = ttk.LabelFrame(
            left_panel, text="Serial Connection", padding=10
        )
        conn_frame.pack(fill="x", pady=(0, 10))
        conn_frame.columnconfigure(1, weight=1)

        ttk.Label(conn_frame, text="Port:").grid(
            row=0, column=0, sticky="w", padx=5
        )
        self.port_combo = ttk.Combobox(conn_frame)
        self.port_combo.grid(row=0, column=1, sticky="ew", padx=5)

        refresh_btn = ttk.Button(
            conn_frame, text="↺ Refresh", command=self.refresh_ports
        )
        refresh_btn.grid(row=0, column=2, padx=5)

        ttk.Label(conn_frame, text="Baud:").grid(
            row=1, column=0, sticky="w", padx=5, pady=5
        )
        self.baud_combo = ttk.Combobox(
            conn_frame, values=[9600, 19200, 38400, 57600, 115200]
        )
        self.baud_combo.set(115200)
        self.baud_combo.grid(row=1, column=1, sticky="ew", padx=5, pady=5)

        self.connect_btn = ttk.Button(
            conn_frame, text="Connect", command=self.toggle_connection
        )
        self.connect_btn.grid(row=1, column=2, padx=5, pady=5)

        # Message Selector Frame
        select_frame = ttk.LabelFrame(
            left_panel, text="Outgoing Message Structure", padding=10
        )
        select_frame.pack(fill="x", pady=(0, 10))

        ttk.Label(select_frame, text="Select Command Type:").pack(
            side="left", padx=5
        )

        self.message_types = {"Command_t (ID: 1)": CommandFrame}
        self.struct_combo = ttk.Combobox(
            select_frame,
            values=list(self.message_types.keys()),
            state="readonly",
        )
        self.struct_combo.pack(side="left", fill="x", expand=True, padx=5)
        self.struct_combo.set("Command_t (ID: 1)")
        self.struct_combo.bind("<<ComboboxSelected>>", self._on_struct_changed)

        # Dynamic Message Struct Container
        self.container = ttk.Frame(left_panel)
        self.container.pack(fill="both", expand=True, pady=(0, 10))

        self.active_frame = None
        self._on_struct_changed(None)

        # Transmit Action Frame
        tx_action_frame = ttk.LabelFrame(
            left_panel, text="Transmitter Controls", padding=10
        )
        tx_action_frame.pack(fill="x")

        self.send_btn = ttk.Button(
            tx_action_frame,
            text="Send Message Over Serial ➔",
            command=self.send_message,
        )
        self.send_btn.pack(fill="x", pady=(0, 5))

        ttk.Label(tx_action_frame, text="Last Sent Hex Stream:").pack(
            anchor="w"
        )
        self.hex_display = ttk.Entry(tx_action_frame, state="readonly")
        self.hex_display.pack(fill="x")

        # ----------------------------------------------------------------------
        # RIGHT PANEL (RX Dashboard & Stream Log)
        # ----------------------------------------------------------------------
        right_panel = ttk.Frame(paned_window)
        paned_window.add(right_panel, weight=2)

        # Status Telemetry Dashboard
        self.status_dashboard = StatusDashboardFrame(right_panel)
        self.status_dashboard.pack(fill="x", pady=(0, 10))

        # Console Log Frame
        log_frame = ttk.LabelFrame(
            right_panel, text="Incoming Message Log (RX)", padding=10
        )
        log_frame.pack(fill="both", expand=True)

        rx_top_bar = ttk.Frame(log_frame)
        rx_top_bar.pack(fill="x", pady=(0, 5))

        clear_btn = ttk.Button(
            rx_top_bar, text="Clear Console", command=self.clear_rx_log
        )
        clear_btn.pack(side="right")

        self.rx_console = scrolledtext.ScrolledText(
            log_frame, wrap=tk.WORD, font=("Consolas", 10)
        )
        self.rx_console.pack(fill="both", expand=True)

        self.refresh_ports()

    # ==========================================================================
    # SERIAL PORT & RECEIVER THREADING
    # ==========================================================================

    def refresh_ports(self):
        ports = [p.device for p in serial.tools.list_ports.comports()]
        self.port_combo["values"] = ports
        if ports:
            self.port_combo.set(ports[0])

    def toggle_connection(self):
        if self.serial_port and self.serial_port.is_open:
            self.disconnect_serial()
        else:
            self.connect_serial()

    def connect_serial(self):
        port = self.port_combo.get()
        baud = self.baud_combo.get()
        if not port:
            messagebox.showerror("Error", "No serial port selected!")
            return

        try:
            self.serial_port = serial.Serial(port, int(baud), timeout=0.05)
            self.connect_btn.config(text="Disconnect")

            self.stop_thread_event.clear()
            self.rx_thread = threading.Thread(
                target=self._read_serial_worker, daemon=True
            )
            self.rx_thread.start()

            self.log_rx(f"*** Connected to {port} at {baud} Baud ***\n")
        except Exception as e:
            messagebox.showerror("Connection Error", str(e))

    def disconnect_serial(self):
        self.stop_thread_event.set()
        if self.serial_port and self.serial_port.is_open:
            self.serial_port.close()

        self.serial_port = None
        self.connect_btn.config(text="Connect")
        self.log_rx("*** Disconnected ***\n")

    def _read_serial_worker(self):
        while not self.stop_thread_event.is_set():
            if self.serial_port and self.serial_port.is_open:
                try:
                    data = self.serial_port.read(256)
                    if data:
                        self.rx_queue.put(data)
                except Exception:
                    break
            time.sleep(0.01)

    # ==========================================================================
    # RX PACKET PARSER & DECODER
    # ==========================================================================

    def _process_rx_queue(self):
        while not self.rx_queue.empty():
            self.rx_stream_buffer.extend(self.rx_queue.get())

        self._parse_rx_buffer()
        self.after(50, self._process_rx_queue)

    def _parse_rx_buffer(self):
        """Parses byte buffer looking for Message Header [ID (1B), LENGTH (1B)]."""
        HEADER_SIZE = 2

        while len(self.rx_stream_buffer) >= HEADER_SIZE:
            msg_id = self.rx_stream_buffer[0]
            payload_len = self.rx_stream_buffer[1]

            # If message is Status_t (ID: 3)
            if msg_id == 3:
                # Accept payload sizes up to 54 bytes
                expected_len = (
                    payload_len
                    if payload_len > 0
                    else StatusDashboardFrame.EXPECTED_SIZE
                )
                total_packet_size = HEADER_SIZE + expected_len

                if len(self.rx_stream_buffer) < total_packet_size:
                    break  # Wait for remaining packet bytes to arrive

                # Extract Payload
                payload = bytes(
                    self.rx_stream_buffer[
                        HEADER_SIZE:total_packet_size
                    ]
                )
                del self.rx_stream_buffer[:total_packet_size]

                # Update UI Dashboard & Log Output
                summary = self.status_dashboard.unpack_and_update(payload)
                timestamp = time.strftime("[%H:%M:%S]")
                self.log_rx(
                    f"{timestamp} RX [ID 3 Status] ({len(payload)}B):"
                    f" {summary}\n"
                )

            else:
                # If unknown ID or raw raw data stream, log first byte and step forward
                raw_b = self.rx_stream_buffer.pop(0)
                timestamp = time.strftime("[%H:%M:%S]")
                self.log_rx(f"{timestamp} RX Raw Byte: 0x{raw_b:02X}\n")

    # ==========================================================================
    # TX & UI HELPERS
    # ==========================================================================

    def _on_struct_changed(self, event):
        selected_name = self.struct_combo.get()
        if self.active_frame:
            self.active_frame.destroy()

        frame_cls = self.message_types[selected_name]
        self.active_frame = frame_cls(self.container)
        self.active_frame.pack(fill="both", expand=True)

    def send_message(self):
        try:
            payload = self.active_frame.pack_data()
        except Exception as err:
            messagebox.showerror("Packing Error", str(err))
            return

        if self.serial_port and self.serial_port.is_open:
            self.serial_port.write(payload)
        else:
            messagebox.showwarning(
                "Serial Warning",
                "Not connected to serial! Packet preview generated below.",
            )

        hex_str = " ".join(f"0x{b:02X}" for b in payload)
        self.hex_display.config(state="normal")
        self.hex_display.delete(0, tk.END)
        self.hex_display.insert(0, f"({len(payload)} bytes) [ {hex_str} ]")
        self.hex_display.config(state="readonly")

    def log_rx(self, message: str):
        self.rx_console.insert(tk.END, message)
        self.rx_console.see(tk.END)

    def clear_rx_log(self):
        self.rx_console.delete("1.0", tk.END)


if __name__ == "__main__":
    app = SerialSenderApp()
    app.mainloop()