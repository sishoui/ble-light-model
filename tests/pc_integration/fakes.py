"""测试替身（fakes）：fake 串口 / fake bleak 对象 / 受控时钟 / 设备脚本。

harness 逻辑（交叉断言 / Δ / run 目录 / DTR 序列 / 断连重连）无硬件覆盖：
- FakeClock：统一单调时钟（harness 的 t0 与两侧事件时间戳同源）；
- FakeSerial：pyserial 替身（readline 从队列取行；setDTR 记录序列）；
- FakeBle{Scanner,Client,Device}：bleak 替身（BleakLink 真实逻辑照跑，
  notify 重组走真实 pc_protocol.feed）；
- Bench：把三者接线 —— 设备侧 responder 脚本（写 -> notify + 串口
  JSONL 行），测试用 make_device_responder 等辅助函数编排设备行为。
"""

from __future__ import annotations

import json
import time
from collections import deque
from typing import Callable, Optional

import serial

import pc_protocol

FT = pc_protocol.FRAME_TYPES


# ---- 受控时钟 -----------------------------------------------------------


class FakeClock:
    """手动推进的单调时钟（秒）。harness/SerialLog/BleakLink 共用。"""

    def __init__(self, t0: float = 1000.0):
        self.t = float(t0)

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt

    async def asleep(self, dt: float) -> None:
        """SerialLog 注入用 sleep（推进时钟而不是真等）。"""
        self.t += dt


# ---- fake 串口（pyserial 替身） ------------------------------------------


class FakeSerial:
    """readline 从队列取预置行；空队列时短暂睡眠（避免忙转）。

    关闭后 readline 抛 serial.SerialException（与真实 pyserial 语义一致，
    SerialLog._read_loop 据此退出）。
    """

    def __init__(self, clock: FakeClock):
        self.clock = clock
        self._queue: deque[str] = deque()
        self.dtr_log: list[tuple[bool, float]] = []
        self.reset_buffer_calls = 0
        self.written = b""
        self.closed = False

    # pyserial 接口
    def setDTR(self, state: bool) -> None:
        self.dtr_log.append((state, self.clock()))

    def setRTS(self, state: bool) -> None:
        pass

    def reset_input_buffer(self) -> None:
        self.reset_buffer_calls += 1

    def readline(self) -> bytes:
        if self.closed:
            raise serial.SerialException("fake serial closed")
        try:
            return self._queue.popleft().encode("utf-8")
        except IndexError:
            time.sleep(0.005)
            return b""

    def write(self, data: bytes) -> int:
        self.written += data
        return len(data)

    def close(self) -> None:
        self.closed = True

    # 测试侧
    def push_line(self, text: str) -> None:
        self._queue.append(text)


# ---- fake bleak 对象 ------------------------------------------------------


class FakeBleDevice:
    def __init__(self, name: str, address: str = "AA:BB:CC:DD:EE:FF"):
        self.name = name
        self.address = address


class FakeBleClient:
    """bleak.BleakClient 替身：真实 BleakLink 的调用序列照走，行为由
    responder / on_subscribe / on_connect / on_disconnect 钩子脚本化。"""

    def __init__(self, device, disconnected_callback=None, **kwargs):
        self.device = device
        self._disc_cb = disconnected_callback
        self.is_connected = False
        self.mtu_size = 247
        self.writes: list[bytes] = []
        self.notifications: list[bytes] = []
        self.responder: Optional[Callable[[bytes], None]] = None
        self.on_subscribe: Optional[Callable[[], None]] = None
        self.on_connect: Optional[Callable[[], None]] = None
        self.on_disconnect: Optional[Callable[[], None]] = None
        self._notify_cb = None

    async def connect(self):
        self.is_connected = True
        if self.on_connect is not None:
            self.on_connect()

    async def start_notify(self, uuid, callback):
        self._notify_cb = callback
        if self.on_subscribe is not None:
            self.on_subscribe()

    async def stop_notify(self, uuid):
        pass

    async def write_gatt_char(self, char_specifier, data, response=None):
        self.writes.append(bytes(data))
        if self.responder is not None:
            self.responder(bytes(data))

    async def disconnect(self):
        self.is_connected = False
        self._notify_cb = None
        if self.on_disconnect is not None:
            self.on_disconnect()

    # 测试侧：模拟 C3 发 notify
    def emit_notify(self, frame_bytes: bytes) -> None:
        self.notifications.append(bytes(frame_bytes))
        cb = self._notify_cb
        if cb is not None:
            cb(None, bytearray(frame_bytes))


def make_scanner_factory(devices: list) -> Callable[[], object]:
    class _Scanner:
        async def discover(self, timeout: float = 5.0, **kwargs):
            return list(devices)

    return lambda: _Scanner()


# ---- 测试台（接线 + 设备脚本） ------------------------------------------


class Bench:
    """把 fake 串口 / fake 时钟 / 当前 fake client 接在一起。

    测试通过 bench.responder 编排设备侧行为（默认 make_device_responder）；
    client_factory 每次新建 client 时自动挂上 responder 与
    hello_on_subscribe（订阅后发 HELLO，连接/重连共用）。
    """

    def __init__(self, device_name: str = "BLELight-C3"):
        self.clock = FakeClock()
        self.serial = FakeSerial(self.clock)
        self.device_name = device_name
        self.current_client: Optional[FakeBleClient] = None
        self.responder: Optional[Callable[[bytes], None]] = None
        self.hello_on_subscribe: bool = True
        # BleakLink 注入用：调用后返回 scanner 实例。
        self.scanner_factory = make_scanner_factory(
            [FakeBleDevice(self.device_name)]
        )
        self.clients: list[FakeBleClient] = []

    def client_factory(self, device, disconnected_callback=None, **kwargs):
        """BleakLink 注入用：按 (device, disconnected_callback) 建 client。"""
        c = FakeBleClient(device, disconnected_callback, **kwargs)
        c.responder = self.responder
        if self.hello_on_subscribe:
            c.on_subscribe = lambda: self.emit_notify(hello_frame())
        c.on_connect = lambda: self.push_serial(
            {"t_ms": int(self.clock() * 1000), "seq": 0, "ev": "gap",
             "what": "connect"}
        )
        c.on_disconnect = lambda: self.push_serial(
            {"t_ms": int(self.clock() * 1000), "seq": 0, "ev": "gap",
             "what": "disconnect", "reason": 0}
        )
        self.current_client = c
        self.clients.append(c)
        return c

    # 设备侧行为
    def emit_notify(self, frame_bytes: bytes) -> None:
        assert self.current_client is not None, "尚未连接（client_factory 未调用）"
        self.current_client.emit_notify(frame_bytes)

    def push_serial(self, obj: dict) -> None:
        self.serial.push_line(json.dumps(obj))

    def push_raw(self, text: str) -> None:
        self.serial.push_line(text)


# ---- 设备侧帧构造（与固件组帧同口径） ------------------------------------


def ack_frame(seq: int) -> bytes:
    return pc_protocol.encode(
        {"ver": 1, "seq": 0, "type": FT["ack"], "flags": 0, "strip_mask": 0,
         "payload": seq.to_bytes(2, "little")}
    )


def nak_frame(seq: int, err: int) -> bytes:
    return pc_protocol.encode(
        {"ver": 1, "seq": 0, "type": FT["nak"], "flags": 0, "strip_mask": 0,
         "payload": bytes([seq & 0xFF, (seq >> 8) & 0xFF, err])}
    )


def hello_frame() -> bytes:
    payload = bytearray(23)
    payload[0] = 1          # protocol_ver
    payload[1] = 0          # fw_major
    payload[2] = 1          # fw_minor
    payload[3] = 0          # fw_patch
    payload[4] = 8          # strip_count
    payload[5] = 60         # leds_per_strip
    payload[6:8] = (30000).to_bytes(2, "little")
    payload[8:10] = (15000).to_bytes(2, "little")
    payload[10] = 70
    payload[11] = 85
    payload[12] = 0x07      # caps
    for i in range(7):
        payload[13 + i // 8] |= 1 << (i % 8)
    return pc_protocol.encode(
        {"ver": 1, "seq": 0, "type": FT["hello"], "flags": 0,
         "strip_mask": 0, "payload": bytes(payload)}
    )


def status_frame(
    *,
    brightness: int = 128,
    glitch: int = 0,
    drop: int = 0,
    power_limit: int = 15000,
    effects: Optional[list] = None,
    seq: int = 0,
) -> bytes:
    effects = effects if effects is not None else [0x00] * 8
    p = bytearray(24)
    p[0:4] = (1).to_bytes(4, "little")     # uptime_s
    p[4] = 0                                # temp_c
    p[5:7] = (0).to_bytes(2, "little")     # current_ma_est
    p[7] = 0                                # thermal
    p[8:10] = glitch.to_bytes(2, "little")
    p[10:12] = drop.to_bytes(2, "little")
    p[12] = brightness
    p[13:15] = power_limit.to_bytes(2, "little")
    p[15] = 0                               # strip_fault
    p[16:24] = bytes(effects)
    return pc_protocol.encode(
        {"ver": 1, "seq": seq, "type": FT["status"], "flags": 0,
         "strip_mask": 0, "payload": bytes(p)}
    )


def make_device_responder(
    bench: Bench,
    *,
    rx_serial_delay_s: float = 0.1,   # 写后多久出串口行（Δ 的主体）
    omit_ack_notify: bool = False,    # 脚本：不发 ACK notify（故障注入）
    omit_rx_serial: bool = False,     # 脚本：不发 rx 串口行（故障注入）
    omit_ack_serial: bool = False,    # 脚本：不发 ack 串口行（故障注入）
    nak_err_override: Optional[int] = None,  # 脚本：NAK err 覆盖（不一致注入）
    apply_effects: bool = True,       # 脚本：ACK 但不落地灯效（故障注入）
    apply_brightness: bool = True,    # 脚本：ACK 但不落地亮度（故障注入）
) -> Callable[[bytes], None]:
    """有状态设备模型（与固件口径一致）：

    - 写 CMD -> (延迟) -> rx 串口行 -> ACK notify + ack 串口行
      （flags bit0 置位才 ACK）；
    - SET_EFFECT effect_id 越界（>=7）-> NAK 0x03（feed 层校验口径）；
    - 受限门禁：亮度 >127 / 限流 >15000 且未解锁 -> NAK 0x06；
    - GET_STATUS -> STATUS notify + status 串口行（内容取当前状态）；
    - SET_EFFECT / SET_BRIGHTNESS 落地更新状态（apply_* 注入可阻断，
      用于"ACK 说成功但固件没动作"的故障注入）。

    故障注入参数用于 fake 测试覆盖交叉断言的失败分支。
    """
    state = {"brightness": 128, "power_limit": 15000, "unlocked": False,
             "effects": [0x00] * 8}

    def respond(data: bytes) -> None:
        frames, errors, _rem = pc_protocol.feed(data)
        # feed 层错误（CRC / 版本 / 未知 type / 未知灯效 / 长度）：固件走
        # errors 路径回 NAK（无 rx 事件，有 drop(parse) 事件）。
        for e in errors:
            bench.clock.advance(rx_serial_delay_s)
            t_ms = int(bench.clock() * 1000)
            err = e["error"] if nak_err_override is None else nak_err_override
            bench.emit_notify(nak_frame(e["seq"], err))
            bench.push_serial({"t_ms": t_ms, "seq": e["seq"], "ev": "nak",
                               "err": err})
            bench.push_serial({"t_ms": t_ms, "seq": 0, "ev": "drop",
                               "reason": "parse", "err": err})
        for f in frames:
            seq = f["seq"]
            typ = f["type"]
            wants_ack = (f["flags"] & 0x01) != 0
            bench.clock.advance(rx_serial_delay_s)
            t_ms = int(bench.clock() * 1000)

            if not omit_rx_serial:
                bench.push_serial({"t_ms": t_ms, "seq": seq, "ev": "rx",
                                   "type": typ, "flags": f["flags"],
                                   "len": len(f["payload"])})

            nak_err = None
            effect_id = None
            mask = f["strip_mask"]
            if typ == FT["getStatus"]:
                bench.emit_notify(
                    status_frame(brightness=state["brightness"],
                                 effects=state["effects"],
                                 power_limit=state["power_limit"])
                )
                bench.push_serial({
                    "t_ms": t_ms, "seq": 0, "ev": "status",
                    "brightness": state["brightness"],
                    "glitch": 0, "drop": 0,
                })
                continue
            if typ == FT["setEffect"]:
                effect_id = f["payload"][0] if f["payload"] else None
                if effect_id is None or effect_id >= 7:
                    nak_err = 3  # unknown_effect（feed 层口径）
            elif typ == FT["setBrightness"]:
                b = f["payload"][0] if f["payload"] else None
                if b is None:
                    nak_err = 4
                elif b > 127 and not state["unlocked"]:
                    nak_err = 6  # not_unlocked
            elif typ == FT["setPowerLimit"]:
                lim = (int.from_bytes(f["payload"][:2], "little")
                       if len(f["payload"]) >= 2 else None)
                if lim is None or lim > 30000:
                    nak_err = 5
                elif lim > 15000 and not state["unlocked"]:
                    nak_err = 6
            elif typ == FT["unlockFullPower"]:
                if not f["payload"] or f["payload"][0] > 1:
                    nak_err = 5

            if nak_err is not None:
                err = nak_err if nak_err_override is None else nak_err_override
                bench.emit_notify(nak_frame(seq, err))
                bench.push_serial({"t_ms": t_ms, "seq": seq, "ev": "nak",
                                   "err": err})
                continue

            # 成功路径：落地状态（apply_* 注入可阻断）。
            if typ == FT["setEffect"] and apply_effects:
                for i in range(8):
                    if mask & (1 << i):
                        state["effects"][i] = effect_id
            elif typ == FT["setBrightness"] and apply_brightness:
                state["brightness"] = f["payload"][0]
            elif typ == FT["setPowerLimit"]:
                state["power_limit"] = int.from_bytes(f["payload"][:2],
                                                      "little")
            elif typ == FT["unlockFullPower"]:
                state["unlocked"] = f["payload"][0] == 1

            if wants_ack:
                if not omit_ack_notify:
                    bench.emit_notify(ack_frame(seq))
                if not omit_ack_serial:
                    bench.push_serial({"t_ms": t_ms, "seq": seq, "ev": "ack"})

    return respond


def wire_default_boot(bench: Bench) -> None:
    """预置启动日志（boot JSONL + ready 行），startup 的等启动步骤用。"""
    t_ms = int(bench.clock() * 1000)
    bench.push_serial({"t_ms": t_ms, "seq": 0, "ev": "boot", "fw": "0.1.0"})
    bench.push_raw("ready")