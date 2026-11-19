"""COM 串口（USB CDC）：端口发现（Espressif VID/PID）、DTR 复位、行读取。

spec §3.3：PC 侧单进程同步打开 BLE + COM6；端口按 USB VID/PID（Espressif
0x303A）枚举，不硬编码 COM6；打开后拉 DTR 复位 C3、等启动日志、再写
基线 SET_EFFECT 确定状态。

本模块对第三方依赖只用 pyserial；全部 I/O 可被注入（open_serial / clock /
sleep），故无硬件也可测 DTR 序列与等待逻辑。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Callable, Optional

import serial
from serial.tools import list_ports

ESPRESSIF_VID = 0x303A  # Espressif 系设备（ESP32-C3 原生 USB CDC）
DEFAULT_BAUDRATE = 115200

# USB-Serial-JTAG：DTR 保持低电平为空闲，拉高一个脉冲触发芯片复位。
DEFAULT_DTR_LOW_MS = 100   # 建立空闲态
DEFAULT_DTR_PULSE_MS = 100  # 复位脉冲宽度
DEFAULT_READ_TIMEOUT = 1.0  # readline 超时（秒），超时返回 b""


class PortNotFoundError(RuntimeError):
    """按 VID/PID 未发现 Espressif 串口。"""


class PortAmbiguousError(RuntimeError):
    """发现多个 Espressif 串口，需通过 port_name 指定。"""


@dataclass
class LineRecord:
    ts_mono: float      # PC 单调时钟（读到这行的时刻，用于 Δ 计算）
    ts_wall: float      # time.time()
    raw: str            # 一行文本（不含 \r\n）
    event: Optional[dict]  # 解析出的 JSON 事件；非 JSON 行 / 损坏行为 None


def parse_jsonl_line(line: str) -> Optional[dict]:
    """把一行串口文本解析为 JSON 事件；非 JSON / 损坏返回 None（容错：原始
    日志里混有 ESP_LOG* 输出，PC 侧不能因此崩溃）。"""
    stripped = line.strip()
    if not stripped:
        return None
    try:
        import json

        return json.loads(stripped)
    except Exception:
        return None


def find_esp_port(
    *,
    vid: int = ESPRESSIF_VID,
    pid: Optional[int] = None,
    comports: Callable[[], list] = list_ports.comports,
) -> str:
    """按 USB VID/PID 枚举串口，返回匹配设备的设备名（如 "COM6"）。

    只匹配一个：多于一个时抛 PortAmbiguousError（调用方应用 port_name
    覆盖）；没有匹配时抛 PortNotFoundError。
    """
    matches = [
        p.device
        for p in comports()
        if getattr(p, "vid", None) == vid
        and (pid is None or getattr(p, "pid", None) == pid)
    ]
    if not matches:
        raise PortNotFoundError(
            f"未发现 USB VID={vid:#06x}" + (f" PID={pid:#06x}" if pid is not None else "") +
            " 的 Espressif 串口（请检查 C3 已接入，或用 --port 覆盖）"
        )
    if len(matches) > 1:
        raise PortAmbiguousError(
            f"发现多个 Espressif 串口：{matches}；请用 --port 指定"
        )
    return matches[0]


class SerialLog:
    """串口会话：打开、DTR 复位、后台读线、事件查询。"""

    def __init__(
        self,
        port_name: str,
        baudrate: int = DEFAULT_BAUDRATE,
        *,
        open_serial: Callable[[str, int], object] = serial.Serial,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], object] = asyncio.sleep,
        dtr_low_ms: int = DEFAULT_DTR_LOW_MS,
        dtr_pulse_ms: int = DEFAULT_DTR_PULSE_MS,
        read_timeout: float = DEFAULT_READ_TIMEOUT,
    ):
        self.port_name = port_name
        self.baudrate = baudrate
        self._open_serial = open_serial
        self._clock = clock
        self._sleep = sleep
        self._dtr_low_ms = dtr_low_ms
        self._dtr_pulse_ms = dtr_pulse_ms
        self._read_timeout = read_timeout

        self._ser = None
        self._reader_task: Optional[asyncio.Task] = None
        self._stop = False

        self.lines: list[LineRecord] = []
        # DTR 序列记录（供测试断言）：[(state_after_set, sleep_seconds)]。
        self.dtr_seq: list[tuple[bool, float]] = []

    # ---- 打开 / 复位 -------------------------------------------------

    async def open(self) -> None:
        self._ser = self._open_serial(self.port_name, self.baudrate,
                                      timeout=self._read_timeout)
        # 等 USB CDC 枚举稳定（设备插拔后串口需要一小会儿就绪）。
        await self._sleep(0.5)

    async def reset(self) -> None:
        """DTR 复位 C3：空闲态 -> 复位脉冲 -> 空闲态，随后清空输入缓冲。"""
        ser = self._ser
        ser.setDTR(False)
        self.dtr_seq.append((False, self._dtr_low_ms / 1000))
        await self._sleep(self._dtr_low_ms / 1000)
        ser.setDTR(True)
        self.dtr_seq.append((True, self._dtr_pulse_ms / 1000))
        await self._sleep(self._dtr_pulse_ms / 1000)
        ser.setDTR(False)
        self.dtr_seq.append((False, 0.0))
        ser.reset_input_buffer()
        await self._sleep(0.2)

    # ---- 后台读线 ---------------------------------------------------

    async def start_reader(self) -> None:
        self._stop = False
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        ser = self._ser
        while not self._stop and ser is not None:
            try:
                data = await asyncio.to_thread(ser.readline)
            except (serial.SerialException, OSError):
                break
            if not data:
                # 超时空返回：继续轮询
                continue
            try:
                raw = data.decode("utf-8", errors="replace").rstrip("\r\n")
            except Exception:
                raw = data.decode("latin-1", errors="replace").rstrip("\r\n")
            self.lines.append(
                LineRecord(
                    self._clock(),
                    time.time(),
                    raw,
                    parse_jsonl_line(raw),
                )
            )

    async def stop(self) -> None:
        self._stop = True
        if self._reader_task is not None:
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
            self._reader_task = None
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None

    # ---- 事件查询 ----------------------------------------------------

    def find_event(
        self,
        ev: Optional[str] = None,
        seq: Optional[int] = None,
        after_mono: Optional[float] = None,
    ) -> Optional[LineRecord]:
        """第一条匹配的 JSONL 事件（按收到顺序）。after_mono 为 PC 收到
        时刻下限（用于只统计写指令之后的行，即 Δ 计算）。"""
        for rec in self.lines:
            event = rec.event
            if event is None:
                continue
            if ev is not None and event.get("ev") != ev:
                continue
            if seq is not None and event.get("seq") != seq:
                continue
            if after_mono is not None and rec.ts_mono < after_mono:
                continue
            return rec
        return None

    @property
    def is_open(self) -> bool:
        return self._ser is not None