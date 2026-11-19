"""scenario.py JSON 场景装载测试（无硬件，默认跑）。

验证 spec §3.6：PC 场景从 tests/scenarios/*.json 共读（schema v1 + pc 扩展），
scenario.py 只做装载、不自定义场景步骤（basic 的 PC 专属深度断言除外，已在
README 共享矩阵说明理由）。
"""

from __future__ import annotations

import pc_protocol
from scenario import _load_pc_scenario, basic_steps, smoke_steps

FT = pc_protocol.FRAME_TYPES


def test_smoke_steps_from_json():
    steps = smoke_steps()
    # smoke = 连接后写 SET_EFFECT(ack) + GET_STATUS(status)。
    assert [s.expect for s in steps] == ["ack", "status"]
    se, gs = steps
    assert se.frame["type"] == FT["setEffect"]
    assert se.frame["flags"] == 1
    assert se.frame["strip_mask"] == 1
    assert se.frame["payload"] == bytes([0x01, 0xFF, 0x00, 0x00])
    assert gs.frame["type"] == FT["getStatus"]
    assert gs.frame["flags"] == 0
    assert gs.expect_status_fields == {"active_effect": [1, 0, 0, 0, 0, 0, 0, 0]}


def test_basic_steps_smoke_plus_extra():
    steps = basic_steps()
    # 前两步来自 JSON smoke；其余为 PC 专属深度断言。
    assert steps[0].expect == "ack"
    assert steps[1].expect == "status"
    types = [s.frame["type"] for s in steps]
    assert FT["setBrightness"] in types
    assert FT["setPowerLimit"] in types
    assert FT["unlockFullPower"] in types
    # 含一个未知灯效 NAK 步骤（expect=error）。
    assert any(s.expect == "error" for s in steps)


def test_reconnect_scenario_marker():
    steps, do_reconnect = _load_pc_scenario("pc_disconnect_reconnect.json")
    assert do_reconnect is True
    # pc 标记的写步骤 = 重连后 GET_STATUS。
    assert steps and steps[0].expect == "status"
    assert steps[0].frame["type"] == FT["getStatus"]


def test_load_ignores_non_pc_steps():
    # pc_connect_write_status.json 含 scan/connect/notify 等非 pc 步骤，装载应跳过。
    steps, do_reconnect = _load_pc_scenario("pc_connect_write_status.json")
    assert do_reconnect is False
    assert [s.expect for s in steps] == ["ack", "status"]