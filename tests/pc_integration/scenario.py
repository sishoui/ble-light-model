"""真机场景脚本（spec §3.3 验收面：连接/写/ACK/STATUS/断连重连）。

场景步骤定义已迁出到 `tests/scenarios/*.json`（schema v1，与 FakeTransport /
device_automator 共读同一份用例源，见 `tests/scenarios/README.md` 共享矩阵）。本模块只负责
把带 `pc` 标记的步骤装载为 `C3Harness.Step`，并组装 `basic_scenario` / `smoke_scenario`。

smoke 子集（<1min 冒烟）= `tests/scenarios/pc_connect_write_status.json` 的前两步
（连接后写 SET_EFFECT + GET_STATUS，期望 ACK / STATUS）。basic 在 smoke 基础上追加
PC 专属深度断言（亮度 / 限流 / 解锁 / 未知灯效 NAK / 终态），再做断连重连。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import pc_protocol
from harness import C3Harness, Step
from checks import StepOutcome

FT = pc_protocol.FRAME_TYPES
V = pc_protocol.PROTOCOL_VERSION

SCENARIOS_DIR = Path(__file__).resolve().parent.parent / "scenarios"


def _frame(type_: int, *, flags: int = 0, strip_mask: int = 0,
           payload: bytes = b"") -> dict:
    return {
        "ver": V,
        "type": type_,
        "flags": flags,
        "strip_mask": strip_mask,
        "payload": payload,
    }


def _pc_step_from(pc: dict, name: str) -> Step:
    """把 scenario JSON 的 `pc` 字段转成 C3Harness Step。"""
    frame = pc["frame"]
    type_ = FT[frame["type"]]
    payload = bytes.fromhex(frame.get("payloadHex", "") or "")
    return Step(
        name,
        {
            "ver": V,
            "type": type_,
            "flags": frame.get("flags", 0),
            "strip_mask": frame.get("strip_mask", 0),
            "payload": payload,
        },
        pc["expect"],
        delta_limit_ms=pc.get("deltaLimitMs"),
        expect_status_fields=pc.get("statusFields"),
    )


def _load_pc_scenario(filename: str) -> tuple[list[Step], bool]:
    """读 tests/scenarios/<filename>，返回 (pc 标记的写步骤, 是否含断连重连标记)。"""
    data = json.loads((SCENARIOS_DIR / filename).read_text(encoding="utf-8"))
    steps: list[Step] = []
    reconnect = False
    for i, raw in enumerate(data.get("steps", [])):
        pc = raw.get("pc")
        if pc is None:
            continue
        if pc.get("reconnect"):
            reconnect = True
        if "frame" in pc:
            steps.append(_pc_step_from(pc, f"{data['name']}#{i}"))
    return steps, reconnect


# ---- 场景：从 JSON 共读 -----------------------------------------------------

def smoke_steps() -> list[Step]:
    """<1min 冒烟子集：connect + 一条写 + ACK + STATUS。

    步骤来自 `tests/scenarios/pc_connect_write_status.json`（pc 标记的
    setEffect/ack + getStatus/status）。
    """
    steps, _ = _load_pc_scenario("pc_connect_write_status.json")
    return steps


def _extra_steps() -> list[Step]:
    """basic 专属深度断言（亮度 / 限流 / 解锁 / 未知灯效 NAK / 终态）。

    这些是 PC 特有的 Δ/串口交叉断言，language-neutral 场景 JSON 不便
    表达，保留在 scenario.py 里（文档化在 tests/scenarios/README.md 共享矩阵）。
    """
    return [
        Step("set_brightness_100",
             _frame(FT["setBrightness"], flags=1, strip_mask=0xFF, payload=bytes([100])),
             "ack"),
        Step("get_status_brightness",
             _frame(FT["getStatus"]),
             "status",
             expect_status_fields={"brightness": 100}),
        Step("set_power_limit_10000",
             _frame(FT["setPowerLimit"], flags=1, strip_mask=0xFF,
                    payload=(10000).to_bytes(2, "little")),
             "ack"),
        Step("unlock_full_power",
             _frame(FT["unlockFullPower"], flags=1, strip_mask=0xFF, payload=bytes([0x01])),
             "ack"),
        Step("set_brightness_200_unlocked",
             _frame(FT["setBrightness"], flags=1, strip_mask=0xFF, payload=bytes([200])),
             "ack"),
        Step("nak_unknown_effect",
             _frame(FT["setEffect"], flags=1, strip_mask=0x01,
                    payload=bytes([0x07])),
             "error"),
        Step("get_status_final",
             _frame(FT["getStatus"]),
             "status",
             expect_status_fields={"brightness": 200}),
    ]


def basic_steps() -> list[Step]:
    """全量 basic 场景 = smoke（JSON）+ PC 专属深度断言。"""
    return smoke_steps() + _extra_steps()


def _post_reconnect_step() -> Optional[Step]:
    """断连重连后 GET_STATUS（pc 标记步骤来自 pc_disconnect_reconnect.json）。"""
    steps, _ = _load_pc_scenario("pc_disconnect_reconnect.json")
    return steps[0] if steps else None


# ---- 场景入口 ---------------------------------------------------------------

async def basic_scenario(h: C3Harness) -> list[StepOutcome]:
    outcomes = await h.run_steps(basic_steps())
    if all(o.ok for o in outcomes):
        # 断连重连（连接阶段口径）+ 重连后仍可 STATUS。
        rec = await h.reconnect()
        outcomes.append(rec)
        if rec.ok:
            post = _post_reconnect_step()
            if post is not None:
                outcomes.append(
                    await h._run_step(
                        Step(
                            post.name,
                            post.frame,
                            post.expect,
                            delta_limit_ms=h.cfg.connect_delta_limit_ms,
                            expect_status_fields=post.expect_status_fields,
                        )
                    )
                )
    return outcomes


async def smoke_scenario(h: C3Harness) -> list[StepOutcome]:
    return await h.run_steps(smoke_steps())


# 供 run_scenario(config, scenario=...) / pytest -m hardware 直接调用。
__all__ = ["basic_scenario", "smoke_scenario", "smoke_steps", "basic_steps",
           "_load_pc_scenario"]
