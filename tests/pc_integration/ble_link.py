"""bleak 封装：按名扫描、连接、订阅 RSP、写 CMD、记录 notify 时间线。

spec §3.3 事实约束（research/pc-ble-central.md）：
- Windows 用 WinRT 后端（bleak 默认），应用不可设 MTU（自动协商，仅诊断）；
- Windows 重连可能往 CCCD 写 0x80 —— NimBLE 侧已规范化（cur_notify），
  PC 侧照常 start_notify 即可；
- Windows 同时只支持一个活动 radio —— harness 只连一个 C3。

GATT 布局（#14 定稿）：设备名 BLELight-C3；service 0xFFE0；CMD 写 0xFFE1
（write-without-rsp）；RSP notify 0xFFE2。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Callable, Optional

from bleak import BleakClient, BleakScanner

import pc_protocol

DEVICE_NAME = "BLELight-C3"
SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
CMD_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
RSP_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"


class DeviceNotFoundError(RuntimeError):
    """扫描超时内未发现目标设备。"""


@dataclass
class NotifyRecord:
    ts_mono: float        # PC 单调时钟（收到 notify 的时刻）
    ts_wall: float
    hex: str              # 本次 notify 原始字节（hex，证据用）
    frame: Optional[dict] # 解出的协议帧（半帧时为 None，字节留 pending）
    errors: list[dict]    # 本 chunk 解出的协议错误（CRC 错等，证据用）


class BleakLink:
    """单连接 GATT 中心：扫描 -> 连接 -> 订阅 -> 写 / 断连。

    notify 数据经 pc_protocol.feed 增量重组（跨 notify 分片用 pending 传递），
    解出的帧进 self.timeline（PC 侧 notify 时间线，run 目录取证 + 交叉断言
    的 notify 侧锚点）。
    """

    def __init__(
        self,
        *,
        device_name: str = DEVICE_NAME,
        clock: Callable[[], float] = time.monotonic,
        scanner_factory: Callable[[], BleakScanner] = BleakScanner,
        client_factory: Callable[..., BleakClient] = BleakClient,
    ):
        self.device_name = device_name
        self._clock = clock
        self._scanner_factory = scanner_factory
        self._client_factory = client_factory

        self._client: Optional[BleakClient] = None
        self._pending = b""
        self.timeline: list[NotifyRecord] = []
        self.notify_errors: list[dict] = []

    # ---- 连接生命周期 -------------------------------------------------

    async def connect(
        self, *, scan_timeout_s: float = 10.0, connect_timeout_s: float = 10.0
    ) -> None:
        # 重连前丢弃上一条连接的半帧残留。
        self._pending = b""
        scanner = self._scanner_factory()
        devices = await asyncio.wait_for(
            scanner.discover(timeout=scan_timeout_s), connect_timeout_s
        )
        device = next((d for d in devices if d.name == self.device_name), None)
        if device is None:
            raise DeviceNotFoundError(
                f"扫描 {scan_timeout_s}s 未发现设备 {self.device_name!r}"
                f"（共 {len(devices)} 个设备）；确认 C3 在广播（断连后会自动重启"
                "广播）且 PC 蓝牙适配器只有一个活动 radio"
            )
        self._client = self._client_factory(
            device, disconnected_callback=self._on_disconnected
        )
        await asyncio.wait_for(self._client.connect(), connect_timeout_s)
        await self._client.start_notify(RSP_UUID, self._on_notify)

    async def disconnect(self) -> None:
        if self._client is None:
            return
        client, self._client = self._client, None
        try:
            await client.stop_notify(RSP_UUID)
        except Exception:
            pass
        try:
            await client.disconnect()
        except Exception:
            pass

    # ---- 读写 ---------------------------------------------------------

    async def write_cmd(self, data: bytes) -> None:
        """向 CMD 特征写协议帧（write-without-rsp，与小程序同口径）。"""
        if self._client is None:
            raise RuntimeError("未连接：write_cmd 前需 connect()")
        await self._client.write_gatt_char(CMD_UUID, data, response=False)

    @property
    def mtu_size(self) -> Optional[int]:
        if self._client is None:
            return None
        return self._client.mtu_size

    # ---- notify 处理 ---------------------------------------------------

    def _on_disconnected(self, client) -> None:
        # WinRT 断连回调；具体处理在 harness 层（状态记账/取证）。
        pass

    def _on_notify(self, sender, data: bytearray) -> None:
        frames, errors, remainder = pc_protocol.feed(bytes(data), self._pending)
        self._pending = remainder
        rec_hex = bytes(data).hex()
        for f in frames:
            self.timeline.append(
                NotifyRecord(self._clock(), time.time(), rec_hex, f, list(errors))
            )
        if errors:
            self.notify_errors.extend(errors)

    # ---- 时间线查询 -----------------------------------------------------

    def find_notify(
        self, type_: int, seq: Optional[int] = None, after_t0: Optional[float] = None
    ) -> Optional[NotifyRecord]:
        """第一条匹配的 notify 记录。type_ 为帧类型；ACK/NAK 帧再按 payload
        回显 seq 匹配。after_t0 为 PC 单调时钟下限。"""
        for rec in self.timeline:
            f = rec.frame
            if f is None or f["type"] != type_:
                continue
            if after_t0 is not None and rec.ts_mono < after_t0 - 1e-6:
                continue
            if seq is not None:
                if type_ == pc_protocol.FRAME_TYPES["ack"]:
                    if pc_protocol.ack_seq(f["payload"]) != seq:
                        continue
                elif type_ == pc_protocol.FRAME_TYPES["nak"]:
                    ne = pc_protocol.nak_seq_err(f["payload"])
                    if ne is None or ne[0] != seq:
                        continue
            return rec
        return None