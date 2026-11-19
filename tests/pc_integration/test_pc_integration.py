"""真 C3 集成测试（spec §3.3 验收面：连接 / 写 / ACK / STATUS / 断连重连）。

标记：全部 @pytest.mark.hardware —— 默认 `pytest`（addopts -m "not hardware"）
不跑；人工在真 C3 上跑：

    pytest -m hardware      # 全量 basic 场景（连接 + 4 组写/ACK/STATUS + NAK + 断连重连）
    pytest -m smoke         # <1min 冒烟子集
    python smoke.py         # 独立脚本等价

先决条件：PC 蓝牙适配器已开，C3 在广播（BLELight-C3），USB CDC COM 口可按
VID=0x303A 发现（不硬编码 COM6）。单进程同开 BLE + COM6。
步骤定义见 scenario.py（basic_scenario / smoke_scenario）。
"""

from __future__ import annotations

import asyncio

import pytest

from harness import HarnessConfig, run_scenario
from scenario import basic_scenario, smoke_scenario

pytestmark = [pytest.mark.hardware]


def test_full_scenario():
    """connect -> HELLO -> 基线全灭 -> 写灯效/亮度/限流/解锁/高亮度
    -> 未知灯效 NAK 0x03 -> 终态 STATUS -> 断连重连 -> 重连后 STATUS。"""
    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(HarnessConfig(), scenario=basic_scenario)
    )
    assert ok, (
        f"run dir: {run_dir}\nerror: {err}\n"
        + "\n".join(f"  [{i}] {o.name}: {o.detail}" for i, o in enumerate(outcomes))
    )


@pytest.mark.smoke
def test_smoke_scenario():
    """<1min 冒烟：connect -> HELLO -> 一条写 + ACK + STATUS（灯效生效）。"""
    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(HarnessConfig(), scenario=smoke_scenario)
    )
    assert ok, (
        f"run dir: {run_dir}\nerror: {err}\n"
        + "\n".join(f"  [{i}] {o.name}: {o.detail}" for i, o in enumerate(outcomes))
    )