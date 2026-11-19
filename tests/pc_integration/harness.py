"""PC 集成 harness 编排（spec §3.3）：单进程同开 BLE + COM6，跑命令步骤，
两侧交叉断言，失败落 run 目录。

流程（startup）：
1. 串口按 USB VID/PID（Espressif 0x303A）发现（或 config.port_name 覆盖）
   -> 打开 -> 拉 DTR 复位 C3 -> 等启动日志（boot JSONL 或 ready 行）；
2. BLE 按名扫描 -> 连接 -> 订阅 RSP -> 等 HELLO（连接阶段 5s 口径）；
3. 写基线 SET_EFFECT（全灭 ff..00）建立确定状态 -> GET_STATUS 校验全灭
   —— 不依赖上次 NVS 状态。

步骤（run_steps）：PC 分配 seq -> 记 t0（PC 单调时钟）-> 写 BLE ->
轮询两侧产物（ACK/NAK/STATUS notify + 串口 JSONL 事件）-> checks.check_step
交叉断言（Δ 默认 <500ms）。

取证（dump_run）：每次跑落 runs/<UTC 时间戳>/：
- serial_raw.log     原始串口（PC 收到时刻 + 行）
- events.jsonl       解析出的 JSONL 事件（含 PC 收到时刻）
- notify_timeline.json  BLE notify 时间线（原始 hex + 解出的帧）
- summary.json       成功：步骤结果 / Δ / 配置
- failure.json       失败：失败步骤索引 + 证据 + §4 分层定位提示

注入点（fake 测试用）：serial_log / ble_link 实例可直接注入（否则按 config
构造真实的 SerialLog / BleakLink）；clock 注入统一供两侧事件打时间戳。
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import pc_protocol
from ble_link import BleakLink
from checks import (
    CONNECT_DELTA_MS,
    DEFAULT_DELTA_MS,
    StepOutcome,
    check_step,
)
from serial_log import SerialLog, find_esp_port

RUNS_DIR = Path(__file__).resolve().parent / "runs"


@dataclass
class HarnessConfig:
    # BLE
    device_name: str = "BLELight-C3"
    scan_timeout_s: float = 10.0
    connect_timeout_s: float = 10.0
    # 串口
    port_name: Optional[str] = None    # None -> 按 VID/PID 自动发现
    esp_vid: int = 0x303A
    esp_pid: Optional[int] = None
    baudrate: int = 115200
    # 时序断言
    notify_timeout_s: float = 3.0      # 单步两侧产物等待超时
    delta_limit_ms: int = DEFAULT_DELTA_MS       # 默认 Δ 上限
    connect_delta_limit_ms: int = CONNECT_DELTA_MS  # 连接/重连放宽档
    poll_interval_s: float = 0.01
    # 启动
    dtr_reset: bool = True
    boot_timeout_s: float = 15.0
    # 取证
    run_root: Path = RUNS_DIR


@dataclass
class Step:
    """一条测试步骤：要发的帧 + 期望响应 + 断言参数。"""

    name: str
    frame: dict                        # 协议帧字段（seq 由 harness 分配）
    expect: str                        # "ack" | "status" | "error" | "hello"
    delta_limit_ms: Optional[int] = None   # None -> config.delta_limit_ms
    expect_status_fields: Optional[dict] = None  # status 步骤的 payload 字段比对


class BaselineError(RuntimeError):
    """确定性前置失败（启动 / HELLO / 基线全灭未建立）。"""


class RunDir:
    """一次运行的取证目录（时间戳命名）。"""

    def __init__(self, root: Path):
        self.root = Path(root)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.dir = self.root / stamp
        n = 2
        while self.dir.exists():
            self.dir = self.root / f"{stamp}-{n}"
            n += 1
        self.dir.mkdir(parents=True, exist_ok=True)

    def dump(self, *, serial_log: SerialLog, ble_link: BleakLink) -> None:
        # 原始串口（每行：PC 单调秒 \t wall ISO \t 原文）。
        with open(self.dir / "serial_raw.log", "w", encoding="utf-8") as f:
            for r in serial_log.lines:
                wall = datetime.fromtimestamp(r.ts_wall, timezone.utc).isoformat()
                f.write(f"{r.ts_mono:.6f}\t{wall}\t{r.raw}\n")
        # 解析出的 JSONL 事件。
        with open(self.dir / "events.jsonl", "w", encoding="utf-8") as f:
            for r in serial_log.lines:
                if r.event is None:
                    continue
                f.write(
                    json.dumps(
                        {
                            "ts_mono": r.ts_mono,
                            "ts_wall": r.ts_wall,
                            "event": r.event,
                        }
                    )
                    + "\n"
                )
        # BLE notify 时间线（frame.payload 转 hex —— JSON 可序列化）。
        timeline = []
        for rec in ble_link.timeline:
            frame = rec.frame
            if frame is not None:
                frame = {**frame, "payload": bytes(frame["payload"]).hex()}
            timeline.append(
                {
                    "ts_mono": rec.ts_mono,
                    "ts_wall": rec.ts_wall,
                    "hex": rec.hex,
                    "frame": frame,
                    "errors": rec.errors,
                }
            )
        with open(self.dir / "notify_timeline.json", "w", encoding="utf-8") as f:
            json.dump(timeline, f, indent=2)

    def write_summary(self, summary: dict) -> None:
        with open(self.dir / "summary.json", "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2, default=str)

    def write_failure(self, failure: dict) -> None:
        with open(self.dir / "failure.json", "w", encoding="utf-8") as f:
            json.dump(failure, f, indent=2, default=str)


class C3Harness:
    def __init__(
        self,
        config: Optional[HarnessConfig] = None,
        *,
        clock: Optional[Callable[[], float]] = None,
        serial_log: Optional[SerialLog] = None,
        ble_link: Optional[BleakLink] = None,
    ):
        self.cfg = config or HarnessConfig()
        self.clock = clock or time.monotonic
        self._serial = serial_log
        self._ble = ble_link
        self.seq = 0
        self.outcomes: list[StepOutcome] = []
        self.run_dir: Optional[RunDir] = None
        self.started_wall: Optional[float] = None

    # ---- 生命周期 -----------------------------------------------------

    @property
    def serial(self) -> SerialLog:
        if self._serial is None:
            port = self.cfg.port_name or find_esp_port(
                vid=self.cfg.esp_vid, pid=self.cfg.esp_pid
            )
            self._serial = SerialLog(
                port, self.cfg.baudrate, clock=self.clock
            )
        return self._serial

    @property
    def ble(self) -> BleakLink:
        if self._ble is None:
            self._ble = BleakLink(device_name=self.cfg.device_name,
                                  clock=self.clock)
        return self._ble

    async def startup(self) -> None:
        """确定性前置：串口 + DTR 复位 + 等启动 + BLE 连接 + HELLO +
        基线全灭。任一步失败抛 BaselineError。"""
        self.started_wall = time.time()
        self.run_dir = RunDir(self.cfg.run_root)

        # 1. 串口：发现 -> 打开 -> DTR 复位 -> 读线 -> 等启动日志。
        await self.serial.open()
        if self.cfg.dtr_reset:
            await self.serial.reset()
        await self.serial.start_reader()

        boot = await self._wait_for(
            lambda: (
                self.serial.find_event("boot") is not None
                or any("ready" in r.raw for r in self.serial.lines)
            ),
            self.cfg.boot_timeout_s,
            what="C3 启动日志（boot JSONL / ready）",
        )
        if not boot:
            raise BaselineError(
                f"{self.cfg.boot_timeout_s}s 内未等到 C3 启动日志"
                "（检查 USB CDC 连接 / DTR 复位）"
            )

        # 2. BLE：扫描 -> 连接 -> 订阅 -> 等 HELLO。
        await self.ble.connect(
            scan_timeout_s=self.cfg.scan_timeout_s,
            connect_timeout_s=self.cfg.connect_timeout_s,
        )
        hello = await self._wait_for(
            lambda: self.ble.find_notify(pc_protocol.FRAME_TYPES["hello"])
            is not None,
            self.cfg.connect_timeout_s,
            what="HELLO notify",
        )
        if not hello:
            raise BaselineError(
                "连接并订阅后未收到 HELLO notify（检查 CCCD / NimBLE 订阅）"
            )

        # 3. 基线：SET_EFFECT 全灭（ACK）+ GET_STATUS 校验全灭。
        base = Step(
            "baseline_set_effect_off",
            {
                "ver": pc_protocol.PROTOCOL_VERSION,
                "type": pc_protocol.FRAME_TYPES["setEffect"],
                "flags": 1,
                "strip_mask": 0xFF,
                "payload": bytes([0x00]),  # effect OFF
            },
            "ack",
            delta_limit_ms=self.cfg.connect_delta_limit_ms,
        )
        out = await self._run_step(base)
        self.outcomes.append(out)
        if not out.ok:
            raise BaselineError(f"基线 SET_EFFECT 失败: {out.detail}")

        st = await self._run_step(
            Step(
                "baseline_get_status",
                {
                    "ver": pc_protocol.PROTOCOL_VERSION,
                    "type": pc_protocol.FRAME_TYPES["getStatus"],
                    "flags": 0,
                    "strip_mask": 0,
                    "payload": b"",
                },
                "status",
                delta_limit_ms=self.cfg.connect_delta_limit_ms,
                expect_status_fields={"active_effect": [0x00] * 8},
            )
        )
        self.outcomes.append(st)
        if not st.ok:
            raise BaselineError(
                f"基线 GET_STATUS 未确认全灭: {st.detail}"
            )

    async def shutdown(self) -> None:
        try:
            await self.ble.disconnect()
        finally:
            await self.serial.stop()

    # ---- 步骤执行 -------------------------------------------------------

    def _next_seq(self) -> int:
        self.seq = (self.seq + 1) & 0xFFFF
        if self.seq == 0:
            self.seq = 1
        return self.seq

    async def _wait_for(
        self, pred: Callable[[], bool], timeout_s: float, *, what: str
    ) -> bool:
        deadline = time.monotonic() + timeout_s
        while not pred():
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(self.cfg.poll_interval_s)
        return True

    def _serial_events(self) -> list:
        return [
            (r.ts_mono, r.event) for r in self.serial.lines if r.event is not None
        ]

    def _artifacts_ready(self, expect: str, seq: int, t0: float) -> bool:
        ft = pc_protocol.FRAME_TYPES
        evs = self._serial_events()
        if expect == "ack":
            return (
                self.ble.find_notify(ft["ack"], seq, after_t0=t0) is not None
                and any(
                    e.get("ev") == "rx" and e.get("seq") == seq and ts >= t0 - 1e-6
                    for ts, e in evs
                )
                and any(
                    e.get("ev") == "ack" and e.get("seq") == seq and ts >= t0 - 1e-6
                    for ts, e in evs
                )
            )
        if expect == "status":
            return any(
                rec.frame is not None
                and rec.frame["type"] == ft["status"]
                and rec.ts_mono >= t0 - 1e-6
                for rec in self.ble.timeline
            ) and any(
                e.get("ev") == "status" and ts >= t0 - 1e-6 for ts, e in evs
            )
        if expect == "error":
            nak_ok = False
            for rec in self.ble.timeline:
                f = rec.frame
                if (
                    f is not None
                    and f["type"] == ft["nak"]
                    and rec.ts_mono >= t0 - 1e-6
                    and pc_protocol.nak_seq_err(f["payload"]) is not None
                    and pc_protocol.nak_seq_err(f["payload"])[0] == seq
                ):
                    nak_ok = True
                    break
            return nak_ok and any(
                e.get("ev") == "nak" and e.get("seq") == seq and ts >= t0 - 1e-6
                for ts, e in evs
            )
        if expect == "hello":
            return (
                self.ble.find_notify(ft["hello"], after_t0=t0) is not None
            )
        return False

    async def _run_step(self, step: Step) -> StepOutcome:
        seq = self._next_seq()
        frame = dict(step.frame)
        frame["seq"] = seq
        t0 = self.clock()
        await self.ble.write_cmd(pc_protocol.encode(frame))

        await self._wait_for(
            lambda: self._artifacts_ready(step.expect, seq, t0),
            self.cfg.notify_timeout_s,
            what=f"{step.name} 的两侧产物",
        )
        limit = (
            step.delta_limit_ms
            if step.delta_limit_ms is not None
            else self.cfg.delta_limit_ms
        )
        return check_step(
            step.name,
            step.expect,
            seq,
            t0,
            timeline=self.ble.timeline,
            serial_events=self._serial_events(),
            delta_limit_ms=limit,
            expect_status_fields=step.expect_status_fields,
        )

    async def run_steps(self, steps: list[Step]) -> list[StepOutcome]:
        """顺序跑步骤；首个失败即停（失败步骤索引 = len(outcomes)-1）。

        outcomes 在 startup 基线之后继续累积（dump 与失败索引都含基线）。
        """
        for step in steps:
            out = await self._run_step(step)
            self.outcomes.append(out)
            if not out.ok:
                break
        return self.outcomes

    # ---- 断连重连（连接阶段口径：Δ 放宽 5s） -----------------------------

    def _find_gap(self, what: str, after_mono: float):
        """串口 gap 事件（what=connect/disconnect/subscribe/mtu）。"""
        for ts, e in self._serial_events():
            if (
                ts >= after_mono - 1e-6
                and e.get("ev") == "gap"
                and e.get("what") == what
            ):
                return ts, e
        return None

    async def reconnect(self) -> StepOutcome:
        """PC 侧断连 -> C3 重启广播 -> 重连 -> 订阅 -> HELLO。

        断言：串口 gap disconnect + gap connect 事件（两侧日志），重连后
        HELLO notify（空口侧）。连接阶段口径：Δ 放宽到
        connect_delta_limit_ms（5s）。
        """
        name = "disconnect_reconnect"
        t0 = self.clock()
        problems: list[str] = []
        evidence: list[str] = []

        await self.ble.disconnect()
        got_disc = await self._wait_for(
            lambda: self._find_gap("disconnect", t0) is not None,
            self.cfg.connect_timeout_s,
            what="gap disconnect 事件",
        )
        if got_disc:
            evidence.append("串口 gap disconnect 事件")
        else:
            problems.append("断连后串口无 gap disconnect 事件（C3 未重启广播？）")

        await self.ble.connect(
            scan_timeout_s=self.cfg.scan_timeout_s,
            connect_timeout_s=self.cfg.connect_timeout_s,
        )
        got_hello = await self._wait_for(
            lambda: self.ble.find_notify(
                pc_protocol.FRAME_TYPES["hello"], after_t0=t0
            )
            is not None,
            self.cfg.connect_timeout_s,
            what="重连后 HELLO",
        )
        if got_hello:
            evidence.append("重连后 HELLO notify")
        else:
            problems.append("重连后未收到 HELLO notify")
        # 串口 gap connect 事件同样要等 reader 消费（HELLO 走 BLE 时间线
        # 是同步的，串口行需要 reader 任务调度）。
        got_conn = await self._wait_for(
            lambda: self._find_gap("connect", t0) is not None,
            self.cfg.connect_timeout_s,
            what="gap connect 事件",
        )
        if got_conn:
            evidence.append("串口 gap connect 事件")
        else:
            problems.append("重连后串口无 gap connect 事件")

        ok = not problems
        detail = "; ".join(problems) if problems else "; ".join(evidence)
        return StepOutcome(name=name, ok=ok,
                           delta_ms=None, detail=detail, evidence=evidence)

    # ---- 取证 -----------------------------------------------------------

    def _failure_hint(self, outcomes: list[StepOutcome]) -> str:
        """§4 分层定位提示（原始串口 + BLE 时间线两份独立证据对照）。"""
        serial_lines = self.serial.lines if self._serial else []
        rx_events = [
            r for r in serial_lines
            if r.event is not None and r.event.get("ev") == "rx"
        ]
        if not serial_lines:
            return (
                "串口无任何输出：检查 USB CDC 连接（VID/PID 发现是否正确）"
                "与 DTR 复位是否生效"
            )
        if not rx_events:
            return (
                "串口有输出但全程无 RX 事件：C3 未收到/未解出任何帧 —— "
                "§4 口径：串口无帧 -> BLE 空口 / 固件"
            )
        failed = outcomes[-1] if outcomes else None
        if failed is not None and "未收到 ACK notify" in failed.detail and rx_events:
            return (
                "串口有 RX 事件但未收到 ACK notify：检查 RSP 订阅（CCCD）、"
                "或固件 ACK 发送路径"
            )
        if failed is not None and failed.delta_ms is not None:
            return (
                f"Δ={failed.delta_ms:.0f}ms 超时：串口日志排空延迟（console "
                "任务 100ms flush）或 C3 高负载；慢机可放宽 delta_limit_ms"
            )
        return "见 failure.json 的步骤 detail 与 notify_timeline.json"

    def dump_run(self, *, ok: bool, outcomes: list[StepOutcome],
                 error: Optional[str] = None) -> RunDir:
        assert self.run_dir is not None, "dump_run 前需 startup()"
        rd = self.run_dir
        rd.dump(serial_log=self.serial, ble_link=self.ble)
        summary = {
            "ok": ok,
            "started_wall": self.started_wall,
            "duration_s": (
                time.time() - self.started_wall if self.started_wall else None
            ),
            "config": {
                "device_name": self.cfg.device_name,
                "port_name": self.cfg.port_name,
                "delta_limit_ms": self.cfg.delta_limit_ms,
            },
            "steps": [
                {
                    "index": i,
                    "name": o.name,
                    "ok": o.ok,
                    "delta_ms": o.delta_ms,
                    "detail": o.detail,
                    "evidence": o.evidence,
                }
                for i, o in enumerate(outcomes)
            ],
            "error": error,
        }
        if ok:
            rd.write_summary(summary)
        else:
            failed_idx = next(
                (i for i, o in enumerate(outcomes) if not o.ok), None
            )
            rd.write_failure(
                {
                    "failed_step_index": failed_idx,
                    "steps": summary["steps"],
                    "hint": self._failure_hint(outcomes),
                    "error": error,
                }
            )
        return rd


async def run_scenario(
    config: Optional[HarnessConfig] = None,
    steps: Optional[list[Step]] = None,
    *,
    scenario: Optional[Callable] = None,
    clock=None,
    serial_log=None,
    ble_link=None,
) -> tuple[bool, list[StepOutcome], Path, Optional[str]]:
    """完整跑一次：startup -> (scenario 或 run_steps) -> dump -> shutdown。

    scenario: async fn(harness) -> list[StepOutcome]（场景脚本，如
    scenario.basic_scenario；给了 scenario 则忽略 steps）。断连重连等需要
    控制流的场景走 scenario。

    返回 (ok, outcomes, run_dir, error)。不抛异常（硬件/驱动错误也落 run
    目录后再返回），调用方断言 ok。
    """
    h = C3Harness(config, clock=clock, serial_log=serial_log, ble_link=ble_link)
    error: Optional[str] = None
    outcomes: list[StepOutcome] = []
    try:
        await h.startup()
        if scenario is not None:
            outcomes = await scenario(h)
        else:
            outcomes = await h.run_steps(steps or [])
        ok = bool(outcomes) and all(o.ok for o in outcomes)
        rd = h.dump_run(ok=ok, outcomes=outcomes)
        return ok, outcomes, rd.dir, None
    except Exception as e:  # 硬件/驱动错误也要落盘再返回
        error = f"{type(e).__name__}: {e}"
        try:
            rd = h.dump_run(ok=False, outcomes=h.outcomes or outcomes,
                            error=error)
            return False, h.outcomes or outcomes, rd.dir, error
        except Exception:
            return False, outcomes, Path("<dump failed>"), error
    finally:
        try:
            await h.shutdown()
        except Exception:
            pass