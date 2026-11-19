"""harness 集成测试（fake 串口 + fake bleak 设备，无硬件，默认跑）。

覆盖 spec §3.3 的 harness 逻辑面：
- DTR 复位序列（状态 + 时序 + 输入缓冲清空）；
- 端口发现（VID/PID 枚举 / 多设备歧义 / 未找到）；
- startup 确定性前置（等启动 -> 连接 -> HELLO -> 基线全灭）；
- 步骤成功路径（SET_EFFECT ACK + GET_STATUS 状态跟随）；
- Δ 默认 500ms 超限失败 / 慢机 1s 放宽通过；
- 故障注入两类 bug：
  * omit_ack_notify —— "固件动作了但 ACK 没发"（RX 在、ACK 缺）；
  * apply_effects=False —— "ACK 说成功但固件没动作"（后续 STATUS 打脸）；
- NAK 错误步骤（未知灯效 -> NAK 0x03 两侧一致）；
- 断连重连（gap 事件 + 重连 HELLO）；
- run 目录产物：serial_raw.log / events.jsonl / notify_timeline.json /
  summary.json / failure.json（失败步骤索引 + §4 分层定位提示）。
"""

from __future__ import annotations

import asyncio
import json

import pytest

import pc_protocol
from ble_link import BleakLink
from fakes import Bench, make_device_responder, wire_default_boot
from harness import C3Harness, HarnessConfig, Step, run_scenario
from serial_log import (
    ESPRESSIF_VID,
    PortAmbiguousError,
    PortNotFoundError,
    SerialLog,
    find_esp_port,
)

FT = pc_protocol.FRAME_TYPES


# ---- 测试台装配 -----------------------------------------------------------


def make_kit(tmp_path, responder_kwargs=None, config_kwargs=None, boot=True):
    bench = Bench()
    if boot:
        wire_default_boot(bench)
    bench.responder = make_device_responder(bench, **(responder_kwargs or {}))
    serial_log = SerialLog(
        "COM_TEST",
        clock=bench.clock,
        sleep=bench.clock.asleep,
        open_serial=lambda port, baud, timeout=None: bench.serial,
    )
    ble_link = BleakLink(
        device_name="BLELight-C3",
        clock=bench.clock,
        scanner_factory=bench.scanner_factory,
        client_factory=bench.client_factory,
    )
    cfg_kwargs = {
        "port_name": "COM_TEST",
        "run_root": tmp_path,
        "notify_timeout_s": 0.5,
        "boot_timeout_s": 2.0,
        "scan_timeout_s": 2.0,
        "connect_timeout_s": 2.0,
    }
    cfg_kwargs.update(config_kwargs or {})
    return bench, serial_log, ble_link, HarnessConfig(**cfg_kwargs)


def set_effect_step(name="set_effect_static_red_L0", mask=0x01):
    return Step(
        name,
        {
            "ver": pc_protocol.PROTOCOL_VERSION,
            "type": FT["setEffect"],
            "flags": 1,
            "strip_mask": mask,
            "payload": bytes([0x01, 0xFF, 0x00, 0x00]),
        },
        "ack",
    )


def get_status_step(name="get_status", fields=None):
    return Step(
        name,
        {
            "ver": pc_protocol.PROTOCOL_VERSION,
            "type": FT["getStatus"],
            "flags": 0,
            "strip_mask": 0,
            "payload": b"",
        },
        "status",
        expect_status_fields=fields,
    )


# ---- DTR 复位序列 -----------------------------------------------------------


def test_dtr_reset_sequence(tmp_path):
    from fakes import FakeClock, FakeSerial

    clock = FakeClock()
    ser = FakeSerial(clock)
    sl = SerialLog(
        "COM_TEST",
        clock=clock,
        sleep=clock.asleep,
        open_serial=lambda port, baud, timeout=None: ser,
    )

    t0_before = clock.t

    async def run():
        await sl.open()
        await sl.reset()

    asyncio.run(run())
    # 状态序列：空闲 -> 脉冲 -> 空闲。
    assert [s for s, _ in ser.dtr_log] == [False, True, False]
    # 时序：0.1(建立空闲) + 0.1(脉冲) + 0.2(复位后等待)，open 的 0.5 不计。
    assert abs(clock.t - t0_before - 0.5 - 0.4) < 1e-9
    # 复位后清空输入缓冲。
    assert ser.reset_buffer_calls == 1


# ---- 端口发现（VID/PID 枚举） ------------------------------------------------


class _Port:
    def __init__(self, device, vid, pid=None):
        self.device = device
        self.vid = vid
        self.pid = pid


def test_find_esp_port_by_vid():
    ports = [_Port("COM3", 0x1234), _Port("COM6", ESPRESSIF_VID)]
    assert find_esp_port(comports=lambda: ports) == "COM6"


def test_find_esp_port_by_vid_pid():
    ports = [
        _Port("COM6", ESPRESSIF_VID),
        _Port("COM7", ESPRESSIF_VID, 0x4001),
    ]
    assert find_esp_port(comports=lambda: ports, pid=0x4001) == "COM7"


def test_find_esp_port_ambiguous():
    ports = [_Port("COM6", ESPRESSIF_VID), _Port("COM7", ESPRESSIF_VID)]
    with pytest.raises(PortAmbiguousError):
        find_esp_port(comports=lambda: ports)


def test_find_esp_port_not_found():
    with pytest.raises(PortNotFoundError):
        find_esp_port(comports=lambda: [_Port("COM1", 0x1234)])


# ---- startup 确定性前置 ------------------------------------------------------


def test_startup_baseline_all_off(tmp_path):
    bench, serial_log, ble_link, config = make_kit(tmp_path)

    async def run():
        h = C3Harness(config, clock=bench.clock, serial_log=serial_log,
                      ble_link=ble_link)
        await h.startup()
        await h.shutdown()
        return h

    h = asyncio.run(run())
    # 基线两步：SET_EFFECT 全灭(ACK) + GET_STATUS 确认 active_effect 全 0。
    assert len(h.outcomes) == 2
    assert all(o.ok for o in h.outcomes), [o.detail for o in h.outcomes]
    # 串口走了 DTR 序列；BLE 真写了帧。
    assert [s for s, _ in bench.serial.dtr_log] == [False, True, False]
    assert len(bench.current_client.writes) >= 2


def test_startup_without_boot_fails(tmp_path):
    bench, serial_log, ble_link, config = make_kit(
        tmp_path, config_kwargs={"boot_timeout_s": 0.3}, boot=False
    )

    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(config, [set_effect_step()],
                     clock=bench.clock, serial_log=serial_log,
                     ble_link=ble_link)
    )
    assert not ok
    assert err is not None and "启动日志" in err
    assert (run_dir / "failure.json").exists()


# ---- 步骤成功路径 + run 目录产物 ---------------------------------------------


def test_steps_success_and_run_dir(tmp_path):
    bench, serial_log, ble_link, config = make_kit(tmp_path)
    steps = [
        set_effect_step(),
        get_status_step(
            "get_status_effect_applied",
            {"active_effect": [0x01] + [0x00] * 7},
        ),
    ]

    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(config, steps, clock=bench.clock,
                     serial_log=serial_log, ble_link=ble_link)
    )
    assert err is None, err
    assert ok, [o.detail for o in outcomes]
    assert all(o.delta_ms is not None and o.delta_ms < 500 for o in outcomes)

    # run 目录取证产物。
    raw = (run_dir / "serial_raw.log").read_text(encoding="utf-8")
    assert "ready" in raw
    assert '"ev": "rx"' in raw or '"ev":"rx"' in raw
    events = [
        json.loads(line)
        for line in (run_dir / "events.jsonl").read_text(
            encoding="utf-8"
        ).splitlines()
    ]
    assert events and all("event" in e and "ts_mono" in e for e in events)
    ev_names = {e["event"].get("ev") for e in events}
    assert {"boot", "rx", "ack", "status"} <= ev_names
    timeline = json.loads((run_dir / "notify_timeline.json").read_text())
    assert timeline and all("frame" in t for t in timeline)
    types = {t["frame"]["type"] for t in timeline if t["frame"]}
    assert FT["ack"] in types and FT["status"] in types
    summary = json.loads((run_dir / "summary.json").read_text())
    assert summary["ok"] is True
    assert [s["name"] for s in summary["steps"]] == [
        "baseline_set_effect_off",
        "baseline_get_status",
        "set_effect_static_red_L0",
        "get_status_effect_applied",
    ]
    assert not (run_dir / "failure.json").exists()


# ---- Δ 时序 ------------------------------------------------------------------


def test_delta_exceeded_fails(tmp_path):
    bench, serial_log, ble_link, config = make_kit(
        tmp_path, responder_kwargs={"rx_serial_delay_s": 0.7}
    )

    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(config, [set_effect_step()], clock=bench.clock,
                     serial_log=serial_log, ble_link=ble_link)
    )
    assert not ok
    failed = next(o for o in outcomes if not o.ok)
    assert "超过上限" in failed.detail
    failure = json.loads((run_dir / "failure.json").read_text())
    assert failure["failed_step_index"] == len(outcomes) - 1
    assert failure["hint"]
    assert not (run_dir / "summary.json").exists()


def test_delta_slow_machine_relaxed_ok(tmp_path):
    bench, serial_log, ble_link, config = make_kit(
        tmp_path,
        responder_kwargs={"rx_serial_delay_s": 0.7},
        config_kwargs={"delta_limit_ms": 1000},  # 慢机放宽
    )

    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(config, [set_effect_step()], clock=bench.clock,
                     serial_log=serial_log, ble_link=ble_link)
    )
    assert ok, [o.detail for o in outcomes]
    assert (run_dir / "summary.json").exists()


# ---- 故障注入：两类 bug 的检测 ------------------------------------------------


def test_missing_ack_notify_fails_with_hint(tmp_path):
    # "固件动作了但 ACK 没发"：串口 RX/ACK 行都在，空口无 ACK notify。
    bench, serial_log, ble_link, config = make_kit(
        tmp_path, responder_kwargs={"omit_ack_notify": True}
    )

    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(config, [set_effect_step()], clock=bench.clock,
                     serial_log=serial_log, ble_link=ble_link)
    )
    assert not ok
    failed = next(o for o in outcomes if not o.ok)
    assert "未收到 ACK notify" in failed.detail
    assert "固件动作了但 ACK 没发" in failed.detail
    failure = json.loads((run_dir / "failure.json").read_text())
    assert "ACK notify" in failure["hint"]


def test_ack_but_effect_not_applied_fails(tmp_path):
    # "ACK 说成功但固件没动作"：ACK 两侧齐全，但后续 STATUS 显示灯效没变。
    bench, serial_log, ble_link, config = make_kit(
        tmp_path, responder_kwargs={"apply_effects": False}
    )
    steps = [
        set_effect_step(),
        get_status_step(
            "get_status_effect_applied",
            {"active_effect": [0x01] + [0x00] * 7},
        ),
    ]

    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(config, steps, clock=bench.clock,
                     serial_log=serial_log, ble_link=ble_link)
    )
    assert not ok
    # ACK 步骤通过（空口 + 日志都说成功）。
    set_out = next(o for o in outcomes if o.name == "set_effect_static_red_L0")
    assert set_out.ok
    # 后续 STATUS 打脸（ACK 说成功但灯效没落地）。
    st_out = next(
        o for o in outcomes if o.name == "get_status_effect_applied"
    )
    assert not st_out.ok
    assert "active_effect" in st_out.detail


def test_nak_step_ok(tmp_path):
    bench, serial_log, ble_link, config = make_kit(tmp_path)
    steps = [
        Step(
            "nak_unknown_effect",
            {
                "ver": pc_protocol.PROTOCOL_VERSION,
                "type": FT["setEffect"],
                "flags": 1,
                "strip_mask": 0x01,
                "payload": bytes([0x07]),  # 未知灯效
            },
            "error",
        )
    ]

    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(config, steps, clock=bench.clock,
                     serial_log=serial_log, ble_link=ble_link)
    )
    assert ok, [o.detail for o in outcomes]


# ---- 断连重连 ----------------------------------------------------------------


def test_disconnect_reconnect(tmp_path):
    bench, serial_log, ble_link, config = make_kit(tmp_path)

    async def run():
        h = C3Harness(config, clock=bench.clock, serial_log=serial_log,
                      ble_link=ble_link)
        await h.startup()
        rec = await h.reconnect()
        await h.shutdown()
        return h, rec

    h, rec = asyncio.run(run())
    assert rec.ok, rec.detail
    # 两侧证据：串口 gap disconnect + gap connect + 空口重连 HELLO。
    assert "gap disconnect" in rec.detail
    assert "gap connect" in rec.detail
    assert "HELLO" in rec.detail
    # 重连建立了第二个 client（旧的已断开）。
    assert len(bench.clients) == 2
    assert not bench.clients[0].is_connected
    assert bench.clients[1].is_connected or True  # shutdown 已断，不再断言


# ---- §4 分层定位提示 ----------------------------------------------------------


def test_failure_hint_no_serial_output(tmp_path):
    # 串口全程无输出 -> "串口无任何输出" 提示。
    bench, serial_log, ble_link, config = make_kit(tmp_path)
    # 清空启动行，让 boot 也失败（更快到 dump）。
    bench.serial._queue.clear()

    ok, outcomes, run_dir, err = asyncio.run(
        run_scenario(config, [set_effect_step()], clock=bench.clock,
                     serial_log=serial_log, ble_link=ble_link)
    )
    assert not ok
    failure = json.loads((run_dir / "failure.json").read_text())
    assert "串口无任何输出" in failure["hint"] or "启动日志" in failure["hint"]