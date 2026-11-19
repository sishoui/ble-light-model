"""交叉断言核心（纯逻辑，无 I/O，无时钟——全部输入显式传入）。

spec §3.3：断言锚点 = COM6 JSONL 事件（固件内部地面真相）× RSP notify
（空口 ground truth）两侧交叉，抓两类 bug：
- "ACK 说成功但固件没动作"：ACK notify 到了，但后续 GET_STATUS 的
  active_effect 与所发 SET_EFFECT 不符 —— 由场景级步骤（SET_EFFECT 后
  紧跟 GET_STATUS 比对）捕获；
- "固件动作了但 ACK 没发"：串口有 RX 事件（C3 收到并解出帧）但收不到
  ACK notify —— 本模块 expect="ack" 分支直接报"两侧矛盾"。

关联键：seq 回显。时序：PC 写 BLE 前记 t0（PC 单调时钟），收同 seq 的
串口事件算 Δ = ts_mono − t0，断言 Δ < delta_limit_ms（默认 500ms，连接/
重连步骤放宽 5s，慢机可配置 1s）。C3 的 t_ms 只用于日志排序，不作跨机
断言基准。

输入（调用方从 serial_log.lines / ble_link.timeline 提取）：
- timeline: ble_link.NotifyRecord 列表（.ts_mono / .frame / .payload）；
- serial_events: [(ts_mono, event_dict)] —— 串口行里解析出的 JSON 事件。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import pc_protocol

FT = pc_protocol.FRAME_TYPES

DEFAULT_DELTA_MS = 500    # 默认 Δ 上限（spec §3.3）
SLOW_DELTA_MS = 1000      # 慢机 / 高 RMT 负载放宽档
CONNECT_DELTA_MS = 5000   # 连接 / 重连步骤放宽档


@dataclass
class StepOutcome:
    """一个步骤的交叉断言结果（成功/失败 + 证据摘要）。"""

    name: str
    ok: bool
    delta_ms: Optional[float] = None   # 串口侧关联事件的 Δ（若有）
    detail: str = ""                   # 失败原因 / 成功摘要
    evidence: list[str] = field(default_factory=list)


# ---- timeline / serial_events 查询辅助 ----


def _status_payload(rec) -> Optional[dict]:
    f = rec.frame
    if f is None or f["type"] != FT["status"]:
        return None
    return pc_protocol.status_payload_to_dict(f["payload"])


def _iter_status_notifies(timeline: list, t0: float):
    for rec in timeline:
        if rec.ts_mono < t0 - 1e-6:
            continue
        st = _status_payload(rec)
        if st is not None:
            yield rec, st


def _iter_status_events(serial_events: list, t0: float):
    for ts, ev in serial_events:
        if ts < t0 - 1e-6:
            continue
        if ev.get("ev") == "status":
            yield ts, ev


def _find_ack_notify(timeline: list, seq: int, t0: float):
    for rec in timeline:
        f = rec.frame
        if f is None or f["type"] != FT["ack"]:
            continue
        if rec.ts_mono < t0 - 1e-6:
            continue
        if pc_protocol.ack_seq(f["payload"]) == seq:
            return rec
    return None


def _find_nak_notify(timeline: list, seq: int, t0: float):
    for rec in timeline:
        f = rec.frame
        if f is None or f["type"] != FT["nak"]:
            continue
        if rec.ts_mono < t0 - 1e-6:
            continue
        ne = pc_protocol.nak_seq_err(f["payload"])
        if ne is not None and ne[0] == seq:
            return rec
    return None


def _find_hello_notify(timeline: list, t0: float):
    for rec in timeline:
        f = rec.frame
        if f is not None and f["type"] == FT["hello"] and rec.ts_mono >= t0 - 1e-6:
            return rec
    return None


def _first_serial_event(serial_events: list, ev: str, seq: Optional[int],
                        t0: float):
    for ts, e in serial_events:
        if ts < t0 - 1e-6:
            continue
        if e.get("ev") != ev:
            continue
        if seq is not None and e.get("seq") != seq:
            continue
        return ts, e
    return None


# ---- 主入口 ----


def check_step(
    name: str,
    expect: str,
    seq: int,
    t0: float,
    *,
    timeline: list,
    serial_events: list,
    delta_limit_ms: float = DEFAULT_DELTA_MS,
    expect_status_fields: Optional[dict] = None,
) -> StepOutcome:
    """对一条已发送命令做两侧交叉断言。

    expect:
    - "ack"    SET_* 类命令：ACK notify + 串口 RX/ACK 事件 + Δ；
    - "status" GET_STATUS：STATUS notify 与 STATUS 事件按内容配对
               （brightness/glitch/drop 全等）+ Δ + 可选字段比对；
    - "error"  错误帧：NAK notify 与 NAK 事件 (seq, err) 一致 + Δ；
    - "hello"  连接后 HELLO notify（无 Δ，连接阶段口径）。
    """
    problems: list[str] = []
    evidence: list[str] = []
    delta: Optional[float] = None

    if expect == "ack":
        ack_rec = _find_ack_notify(timeline, seq, t0)
        rx = _first_serial_event(serial_events, "rx", seq, t0)
        ack_ev = _first_serial_event(serial_events, "ack", seq, t0)

        if ack_rec is not None:
            evidence.append(f"ACK notify (t={ack_rec.ts_mono - t0:+.3f}s)")
        if rx is not None:
            delta = (rx[0] - t0) * 1000.0
            evidence.append(f"RX 事件 Δ={delta:.0f}ms")
        if ack_ev is not None:
            evidence.append("ACK 事件在串口日志")
            if rx is None:
                delta = (ack_ev[0] - t0) * 1000.0

        # 空口侧缺失。
        if ack_rec is None:
            if rx is not None:
                problems.append(
                    "未收到 ACK notify，但串口有 RX 事件 —— "
                    "疑似'固件动作了但 ACK 没发'（检查 RSP 订阅/CCCD）"
                )
            else:
                problems.append("未收到 ACK notify（空口侧缺失）")
        # 串口侧缺失。
        if rx is None:
            if ack_rec is not None:
                problems.append(
                    "ACK notify 到了但串口无 RX 事件 —— 两侧矛盾"
                    "（ACK 说成功但固件没收到帧？）"
                )
            else:
                problems.append("串口无 RX 事件（C3 未收到帧 / JSONL 日志缺失）")
        if ack_ev is None and rx is not None:
            problems.append("串口有 RX 但无 ACK 事件（ACK 发出但日志没记？）")

    elif expect == "status":
        # 内容配对：notify payload 与 JSONL 事件的 brightness/glitch/drop
        # 全等才算一致（周期 STATUS 与 GET_STATUS 触发 STATUS 交错时也能
        # 正确配对；两边都在但没有任何一对全等 -> 字段不一致 bug）。
        pairs = []
        for rec, st in _iter_status_notifies(timeline, t0):
            for ts, ev in _iter_status_events(serial_events, t0):
                if (
                    st["brightness"] == ev.get("brightness")
                    and st["glitch_count"] == ev.get("glitch")
                    and st["drop_count"] == ev.get("drop")
                ):
                    pairs.append((rec, ts, ev, st))
                    break
        if not pairs:
            has_notify = any(True for _ in _iter_status_notifies(timeline, t0))
            has_event = any(True for _ in _iter_status_events(serial_events, t0))
            if has_notify and not has_event:
                problems.append("STATUS notify 到了但串口无 STATUS 事件")
            elif has_event and not has_notify:
                problems.append("串口有 STATUS 事件但未收到 STATUS notify")
            else:
                problems.append(
                    "STATUS 两侧都有但没有内容一致的一对 —— "
                    "brightness/glitch/drop 字段不一致（STATUS 说 X 日志说 Y）"
                )
        else:
            rec, ts, ev, st = pairs[-1]  # 取最后一对（GET_STATUS 触发的）
            delta = (ts - t0) * 1000.0
            evidence.append(
                f"STATUS 配对 Δ={delta:.0f}ms brightness={st['brightness']} "
                f"glitch={st['glitch_count']} drop={st['drop_count']}"
            )
            for k, v in (expect_status_fields or {}).items():
                got = st.get(k)
                if got != v:
                    problems.append(f"STATUS 字段 {k}: 期望 {v} 实际 {got}")

    elif expect == "error":
        nak_rec = _find_nak_notify(timeline, seq, t0)
        rx = _first_serial_event(serial_events, "rx", seq, t0)
        nak_ev = _first_serial_event(serial_events, "nak", seq, t0)
        if nak_rec is None:
            problems.append("未收到 NAK notify（预期错误响应）")
        else:
            n_err = nak_rec.frame["payload"][2]
            evidence.append(f"NAK notify err={n_err:#04x}")
        # Δ 口径与 ack 分支一致：同 seq 首条串口行（rx 优先）。
        if rx is not None:
            delta = (rx[0] - t0) * 1000.0
            evidence.append(f"RX 事件 Δ={delta:.0f}ms")
        elif nak_ev is not None:
            delta = (nak_ev[0] - t0) * 1000.0
            evidence.append(f"NAK 事件 Δ={delta:.0f}ms")
        if nak_ev is None:
            problems.append("串口无 NAK 事件（NAK 发出但日志没记？）")
        elif nak_rec is not None:
            n_err = nak_rec.frame["payload"][2]
            l_err = nak_ev[1].get("err")
            if n_err != l_err:
                problems.append(
                    f"NAK err 不一致: notify={n_err:#04x} 日志={l_err}"
                )

    elif expect == "hello":
        h_rec = _find_hello_notify(timeline, t0)
        if h_rec is None:
            problems.append("未收到 HELLO notify（订阅后 C3 应主动发）")
        else:
            ver = h_rec.frame["payload"][0]
            evidence.append(f"HELLO notify protocol_ver={ver}")
            if ver != pc_protocol.PROTOCOL_VERSION:
                problems.append(f"HELLO 版本 {ver} != 协议版本 {pc_protocol.PROTOCOL_VERSION}")

    else:
        problems.append(f"未知 expect 类型: {expect}")

    # Δ 上限（hello 不参与：连接阶段口径由连接超时管）。
    if delta is not None and delta > delta_limit_ms:
        problems.append(f"Δ={delta:.0f}ms 超过上限 {delta_limit_ms:.0f}ms")

    ok = not problems
    detail = "; ".join(problems) if problems else "; ".join(evidence)
    return StepOutcome(name=name, ok=ok, delta_ms=delta, detail=detail,
                       evidence=evidence)


# ---- Δ 测量口径（供 harness/测试直接引用） ----


def measure_delta_ms(t0: float, ts_mono: float) -> float:
    """Δ = 事件 PC 收到时刻 − 写 BLE 前 t0（毫秒）。"""
    return (ts_mono - t0) * 1000.0