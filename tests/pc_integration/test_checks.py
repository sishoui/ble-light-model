"""交叉断言逻辑单测（checks.check_step，纯数据驱动，无 I/O）。

覆盖 spec §3.3 的断言面：
- ACK 步骤两侧齐全才算过；单侧缺失报对应矛盾（抓两类 bug）；
- Δ 默认 500ms 上限 / 慢机 1s 放宽 / 超限失败；
- STATUS 步骤 notify × 日志内容配对 + 字段比对；
- NAK 步骤 err 一致性；
- HELLO 版本校验。
"""

from __future__ import annotations

import pc_protocol
from ble_link import NotifyRecord
from checks import (
    CONNECT_DELTA_MS,
    DEFAULT_DELTA_MS,
    SLOW_DELTA_MS,
    check_step,
    measure_delta_ms,
)

FT = pc_protocol.FRAME_TYPES

T0 = 100.0


def rec(ts: float, frame: dict) -> NotifyRecord:
    return NotifyRecord(ts, ts, bytes(frame["payload"]).hex(), frame, [])


def ack_rec(ts: float, seq: int) -> NotifyRecord:
    return rec(ts, {
        "ver": 1, "seq": 0, "type": FT["ack"], "flags": 0, "strip_mask": 0,
        "payload": seq.to_bytes(2, "little"),
    })


def nak_rec(ts: float, seq: int, err: int) -> NotifyRecord:
    return rec(ts, {
        "ver": 1, "seq": 0, "type": FT["nak"], "flags": 0, "strip_mask": 0,
        "payload": bytes([seq & 0xFF, (seq >> 8) & 0xFF, err]),
    })


def status_rec(ts: float, brightness: int = 128, glitch: int = 0,
               drop: int = 0, effects=None) -> NotifyRecord:
    effects = effects if effects is not None else [0x00] * 8
    p = bytearray(24)
    p[0:4] = (1).to_bytes(4, "little")
    p[8:10] = glitch.to_bytes(2, "little")
    p[10:12] = drop.to_bytes(2, "little")
    p[12] = brightness
    p[13:15] = (15000).to_bytes(2, "little")
    p[16:24] = bytes(effects)
    return rec(ts, {
        "ver": 1, "seq": 0, "type": FT["status"], "flags": 0, "strip_mask": 0,
        "payload": bytes(p),
    })


def hello_rec(ts: float, ver: int = 1) -> NotifyRecord:
    p = bytearray(23)
    p[0] = ver
    return rec(ts, {
        "ver": 1, "seq": 0, "type": FT["hello"], "flags": 0, "strip_mask": 0,
        "payload": bytes(p),
    })


def ev(ts: float, event: dict):
    return (ts, event)


def rx_ev(ts: float, seq: int, type_: int = FT["setEffect"]):
    return ev(ts, {"t_ms": int(ts * 1000), "seq": seq, "ev": "rx",
                   "type": type_, "flags": 1, "len": 4})


def ack_ev(ts: float, seq: int):
    return ev(ts, {"t_ms": int(ts * 1000), "seq": seq, "ev": "ack"})


def nak_ev(ts: float, seq: int, err: int):
    return ev(ts, {"t_ms": int(ts * 1000), "seq": seq, "ev": "nak",
                   "err": err})


def status_ev(ts: float, brightness: int = 128, glitch: int = 0, drop: int = 0):
    return ev(ts, {"t_ms": int(ts * 1000), "seq": 0, "ev": "status",
                   "brightness": brightness, "glitch": glitch, "drop": drop})


# ---- ACK 步骤 ----


def test_ack_step_all_sides_present_ok():
    out = check_step(
        "set_effect", "ack", 1, T0,
        timeline=[ack_rec(T0 + 0.15, 1)],
        serial_events=[rx_ev(T0 + 0.1, 1), ack_ev(T0 + 0.15, 1)],
    )
    assert out.ok, out.detail
    assert out.delta_ms is not None
    assert abs(out.delta_ms - 100.0) < 1.0  # Δ 取 RX 事件


def test_ack_step_missing_ack_notify_fails():
    # 串口两侧齐全但无 ACK notify —— "固件动作了但 ACK 没发"。
    out = check_step(
        "set_effect", "ack", 1, T0,
        timeline=[],
        serial_events=[rx_ev(T0 + 0.1, 1), ack_ev(T0 + 0.15, 1)],
    )
    assert not out.ok
    assert "未收到 ACK notify" in out.detail
    assert "固件动作了但 ACK 没发" in out.detail


def test_ack_step_missing_rx_event_fails():
    # ACK notify 到了但串口无 RX —— "ACK 说成功但固件没动作"方向矛盾。
    out = check_step(
        "set_effect", "ack", 1, T0,
        timeline=[ack_rec(T0 + 0.15, 1)],
        serial_events=[ack_ev(T0 + 0.15, 1)],
    )
    assert not out.ok
    assert "两侧矛盾" in out.detail


def test_ack_step_missing_ack_event_fails():
    out = check_step(
        "set_effect", "ack", 1, T0,
        timeline=[ack_rec(T0 + 0.15, 1)],
        serial_events=[rx_ev(T0 + 0.1, 1)],
    )
    assert not out.ok
    assert "ACK 事件" in out.detail


def test_ack_step_wrong_seq_ack_ignored():
    # 旧连接的 ACK（seq=1）不算本步（seq=2）的响应。
    out = check_step(
        "set_effect", "ack", 2, T0,
        timeline=[ack_rec(T0 + 0.1, 1)],
        serial_events=[rx_ev(T0 + 0.05, 2), ack_ev(T0 + 0.1, 1)],
    )
    assert not out.ok
    assert "未收到 ACK notify" in out.detail


# ---- Δ 时序 ----


def test_ack_step_delta_within_500ms_ok():
    out = check_step(
        "set_effect", "ack", 1, T0,
        timeline=[ack_rec(T0 + 0.55, 1)],
        serial_events=[rx_ev(T0 + 0.45, 1), ack_ev(T0 + 0.55, 1)],
    )
    assert out.ok, out.detail
    assert abs(out.delta_ms - 450.0) < 1.0


def test_ack_step_delta_exceeded_fails():
    out = check_step(
        "set_effect", "ack", 1, T0,
        timeline=[ack_rec(T0 + 0.8, 1)],
        serial_events=[rx_ev(T0 + 0.7, 1), ack_ev(T0 + 0.8, 1)],
    )
    assert not out.ok
    assert "超过上限" in out.detail


def test_ack_step_delta_slow_machine_relaxed_ok():
    # 慢机放宽到 1s：700ms 通过。
    out = check_step(
        "set_effect", "ack", 1, T0,
        timeline=[ack_rec(T0 + 0.8, 1)],
        serial_events=[rx_ev(T0 + 0.7, 1), ack_ev(T0 + 0.8, 1)],
        delta_limit_ms=SLOW_DELTA_MS,
    )
    assert out.ok, out.detail


def test_delta_limits_constants():
    assert DEFAULT_DELTA_MS == 500
    assert SLOW_DELTA_MS == 1000
    assert CONNECT_DELTA_MS == 5000


def test_measure_delta_ms():
    assert abs(measure_delta_ms(100.0, 100.25) - 250.0) < 1e-9


# ---- STATUS 步骤 ----


def test_status_step_pair_ok():
    out = check_step(
        "get_status", "status", 3, T0,
        timeline=[status_rec(T0 + 0.15, brightness=100)],
        serial_events=[rx_ev(T0 + 0.1, 3, FT["getStatus"]),
                       status_ev(T0 + 0.15, brightness=100)],
        expect_status_fields={"brightness": 100},
    )
    assert out.ok, out.detail


def test_status_step_pair_with_periodic_interleave_ok():
    # 周期 STATUS（brightness=128）与 GET_STATUS 触发 STATUS（100）交错：
    # 内容配对应挑出一致的一对（100）。
    out = check_step(
        "get_status", "status", 3, T0,
        timeline=[
            status_rec(T0 + 0.05, brightness=128),   # 周期
            status_rec(T0 + 0.2, brightness=100),    # 触发
        ],
        serial_events=[
            status_ev(T0 + 0.05, brightness=128),
            rx_ev(T0 + 0.1, 3, FT["getStatus"]),
            status_ev(T0 + 0.2, brightness=100),
        ],
        expect_status_fields={"brightness": 100},
    )
    assert out.ok, out.detail
    assert "brightness=100" in out.detail


def test_status_step_field_mismatch_fails():
    # notify 说 128，日志说 200 —— 没有内容一致的一对。
    out = check_step(
        "get_status", "status", 3, T0,
        timeline=[status_rec(T0 + 0.15, brightness=128)],
        serial_events=[rx_ev(T0 + 0.1, 3, FT["getStatus"]),
                       status_ev(T0 + 0.15, brightness=200)],
    )
    assert not out.ok
    assert "没有内容一致的一对" in out.detail


def test_status_step_expected_fields_violated_fails():
    out = check_step(
        "get_status", "status", 3, T0,
        timeline=[status_rec(T0 + 0.15, brightness=128)],
        serial_events=[rx_ev(T0 + 0.1, 3, FT["getStatus"]),
                       status_ev(T0 + 0.15, brightness=128)],
        expect_status_fields={"brightness": 100},
    )
    assert not out.ok
    assert "STATUS 字段 brightness" in out.detail


def test_status_step_missing_notify_fails():
    out = check_step(
        "get_status", "status", 3, T0,
        timeline=[],
        serial_events=[status_ev(T0 + 0.15)],
    )
    assert not out.ok
    assert "未收到 STATUS notify" in out.detail


# ---- ERROR（NAK）步骤 ----


def test_error_step_nak_ok():
    out = check_step(
        "nak_unknown_effect", "error", 4, T0,
        timeline=[nak_rec(T0 + 0.15, 4, 3)],
        serial_events=[rx_ev(T0 + 0.1, 4), nak_ev(T0 + 0.15, 4, 3)],
    )
    assert out.ok, out.detail
    assert abs(out.delta_ms - 100.0) < 1.0


def test_error_step_err_mismatch_fails():
    out = check_step(
        "nak", "error", 4, T0,
        timeline=[nak_rec(T0 + 0.15, 4, 3)],
        serial_events=[rx_ev(T0 + 0.1, 4), nak_ev(T0 + 0.15, 4, 4)],
    )
    assert not out.ok
    assert "NAK err 不一致" in out.detail


def test_error_step_missing_nak_fails():
    out = check_step(
        "nak", "error", 4, T0,
        timeline=[],
        serial_events=[rx_ev(T0 + 0.1, 4)],
    )
    assert not out.ok
    assert "未收到 NAK notify" in out.detail


# ---- HELLO ----


def test_hello_step_ok():
    out = check_step(
        "connect", "hello", 0, T0,
        timeline=[hello_rec(T0 + 0.5)],
        serial_events=[],
        delta_limit_ms=CONNECT_DELTA_MS,
    )
    assert out.ok, out.detail


def test_hello_step_wrong_version_fails():
    out = check_step(
        "connect", "hello", 0, T0,
        timeline=[hello_rec(T0 + 0.5, ver=2)],
        serial_events=[],
    )
    assert not out.ok
    assert "HELLO 版本" in out.detail


def test_hello_step_missing_fails():
    out = check_step(
        "connect", "hello", 0, T0, timeline=[], serial_events=[],
    )
    assert not out.ok
    assert "未收到 HELLO" in out.detail