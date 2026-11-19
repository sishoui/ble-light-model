"""真机场景脚本（spec §3.3 验收面：连接/写/ACK/STATUS/断连重连）。

basic_scenario —— pytest -m hardware 与手工全量跑用：
  写灯效(ACK) -> GET_STATUS(校验灯效生效) -> 写亮度(ACK) -> GET_STATUS
  -> 限流(ACK) -> 解锁(ACK) -> 高亮度(ACK) -> 未知灯效(NAK 0x03)
  -> GET_STATUS(终态) -> 断连重连(gap 事件 + HELLO) -> GET_STATUS
smoke_scenario —— <1min 冒烟（连接 + HELLO + 一条写 + ACK + STATUS）。

步骤断言口径见 checks.check_step：seq 回显关联 + PC 单调时钟 Δ（默认
<500ms）+ JSONL × notify 两侧交叉。
"""

from __future__ import annotations

import pc_protocol
from harness import C3Harness, Step
from checks import StepOutcome

FT = pc_protocol.FRAME_TYPES
V = pc_protocol.PROTOCOL_VERSION


def _frame(type_: int, *, flags: int = 0, strip_mask: int = 0,
           payload: bytes = b"") -> dict:
    return {
        "ver": V,
        "type": type_,
        "flags": flags,
        "strip_mask": strip_mask,
        "payload": payload,
    }


def basic_steps() -> list[Step]:
    return [
        Step(
            "set_effect_static_red_L0",
            _frame(FT["setEffect"], flags=1, strip_mask=0x01,
                   payload=bytes([0x01, 0xFF, 0x00, 0x00])),
            "ack",
        ),
        Step(
            "get_status_effect_applied",
            _frame(FT["getStatus"]),
            "status",
            expect_status_fields={"active_effect": [0x01] + [0x00] * 7},
        ),
        Step(
            "set_brightness_100",
            _frame(FT["setBrightness"], flags=1, strip_mask=0xFF,
                   payload=bytes([100])),
            "ack",
        ),
        Step(
            "get_status_brightness",
            _frame(FT["getStatus"]),
            "status",
            expect_status_fields={"brightness": 100},
        ),
        Step(
            "set_power_limit_10000",
            _frame(FT["setPowerLimit"], flags=1, strip_mask=0xFF,
                   payload=(10000).to_bytes(2, "little")),
            "ack",
        ),
        Step(
            "unlock_full_power",
            _frame(FT["unlockFullPower"], flags=1, strip_mask=0xFF,
                   payload=bytes([0x01])),
            "ack",
        ),
        Step(
            "set_brightness_200_unlocked",
            _frame(FT["setBrightness"], flags=1, strip_mask=0xFF,
                   payload=bytes([200])),
            "ack",
        ),
        Step(
            "nak_unknown_effect",
            _frame(FT["setEffect"], flags=1, strip_mask=0x01,
                   payload=bytes([0x07])),
            "error",
        ),
        Step(
            "get_status_final",
            _frame(FT["getStatus"]),
            "status",
            expect_status_fields={"brightness": 200},
        ),
    ]


def smoke_steps() -> list[Step]:
    """<1min：连接 + HELLO + 一条写 + ACK + STATUS。"""
    return [
        Step(
            "set_effect_static_red_L0",
            _frame(FT["setEffect"], flags=1, strip_mask=0x01,
                   payload=bytes([0x01, 0xFF, 0x00, 0x00])),
            "ack",
        ),
        Step(
            "get_status_effect_applied",
            _frame(FT["getStatus"]),
            "status",
            expect_status_fields={"active_effect": [0x01] + [0x00] * 7},
        ),
    ]


async def basic_scenario(h: C3Harness) -> list[StepOutcome]:
    outcomes = await h.run_steps(basic_steps())
    if all(o.ok for o in outcomes):
        # 断连重连（连接阶段口径）+ 重连后仍可 STATUS。
        rec = await h.reconnect()
        outcomes.append(rec)
        if rec.ok:
            outcomes.append(
                await h._run_step(
                    Step(
                        "get_status_after_reconnect",
                        _frame(FT["getStatus"]),
                        "status",
                        delta_limit_ms=h.cfg.connect_delta_limit_ms,
                    )
                )
            )
    return outcomes


async def smoke_scenario(h: C3Harness) -> list[StepOutcome]:
    return await h.run_steps(smoke_steps())