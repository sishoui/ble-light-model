"""协议 v1 Python 复刻的 golden 向量校验（spec §1.3 第三侧）。

`tests/protocol/vectors.json` 是 JS / C / Python 三侧唯一编解码契约：本测试
把每个向量喂给 `pc_protocol`（Python 复刻，不复用 JS 代码），断言与
`expect_hex` / `expect_frames` / `expect_errors` / `expect_remainders`
逐字节一致。无硬件依赖，默认 pytest 运行。
"""

import json
from pathlib import Path

import pytest

import pc_protocol

VECTORS_PATH = (
    Path(__file__).resolve().parents[2] / "tests" / "protocol" / "vectors.json"
)


def _load_vectors():
    with open(VECTORS_PATH, encoding="utf-8") as f:
        return json.load(f)


_DATA = _load_vectors()
ENCODE_VECTORS = [v for v in _DATA["vectors"] if v["kind"] == "encode"]
FEED_VECTORS = [v for v in _DATA["vectors"] if v["kind"] == "feed"]


def _frame_dict(f):
    """把 codec 帧对象规整成向量里的 JSON 形状（payload 转 hex）。"""
    return {
        "ver": f["ver"],
        "seq": f["seq"],
        "type": f["type"],
        "flags": f["flags"],
        "strip_mask": f["strip_mask"],
        "payload": bytes(f["payload"]).hex(),
    }


def _norm_frames(frame_dicts):
    """向量里 payload 是 hex（大小写不敏感），规整成小写 hex 比较。"""
    return [{**f, "payload": f["payload"].lower()} for f in frame_dicts]


# ---------- encode 向量 ----------


@pytest.mark.parametrize("vec", ENCODE_VECTORS, ids=lambda v: v["id"])
def test_encode_matches_golden(vec):
    frame = {
        "ver": vec["frame"]["ver"],
        "seq": vec["frame"]["seq"],
        "type": vec["frame"]["type"],
        "flags": vec["frame"]["flags"],
        "strip_mask": vec["frame"]["strip_mask"],
        "payload": bytes.fromhex(vec["frame"]["payload"]),
    }
    out = pc_protocol.encode(frame)
    assert out == bytes.fromhex(vec["expect_hex"]), vec["id"]


# ---------- feed 向量 ----------


@pytest.mark.parametrize("vec", FEED_VECTORS, ids=lambda v: v["id"])
def test_feed_matches_golden(vec):
    pending = b""
    frames = []
    errors = []
    remainders = []
    for write_hex, expect_rem in zip(vec["writes"], vec["expect_remainders"]):
        got_frames, got_errors, pending = pc_protocol.feed(
            bytes.fromhex(write_hex), pending
        )
        frames.extend(got_frames)
        errors.extend(got_errors)
        remainders.append(pending.hex())
    assert _norm_frames([_frame_dict(f) for f in frames]) == _norm_frames(
        vec["expect_frames"]
    ), vec["id"]
    assert errors == vec["expect_errors"], vec["id"]
    assert [r.lower() for r in remainders] == [
        r.lower() for r in vec["expect_remainders"]
    ], vec["id"]
    # Codec 不得自行产生 ACK（匹配/重传归上层 BleLink）。
    if "expect_ack_generated" in vec:
        assert vec["expect_ack_generated"] is False


# ---------- CRC 自检（生成器同口径） ----------


def test_crc16_ccitt_false_check_value():
    # CRC-16/CCITT-FALSE 标准检查值（"123456789" -> 0x29B1）。
    assert pc_protocol.crc16_ccitt_false(b"123456789") == 0x29B1


# ---------- 编解码往返与边界 ----------


def test_encode_then_feed_roundtrip():
    frame = {
        "ver": 1,
        "seq": 0x0102,
        "type": pc_protocol.FRAME_TYPES["setEffect"],
        "flags": 1,
        "strip_mask": 0xFF,
        "payload": bytes([0x01, 0x10, 0x20, 0x30]),
    }
    frames, errors, remainder = pc_protocol.feed(pc_protocol.encode(frame))
    assert errors == []
    assert remainder == b""
    assert [_frame_dict(f) for f in frames] == [_frame_dict(frame)]


def test_encode_payload_too_long_raises():
    frame = {
        "ver": 1,
        "seq": 1,
        "type": pc_protocol.FRAME_TYPES["getStatus"],
        "flags": 0,
        "strip_mask": 0,
        "payload": bytes(256),
    }
    with pytest.raises(ValueError):
        pc_protocol.encode(frame)


# ---------- 响应帧 payload 解析（notify 断言用） ----------


def test_ack_seq():
    # ACK payload = echo_seq(2 LE)。
    assert pc_protocol.ack_seq(bytes([0x34, 0x12])) == 0x1234
    assert pc_protocol.ack_seq(bytes([0x34])) is None


def test_nak_seq_err():
    assert pc_protocol.nak_seq_err(bytes([0x05, 0x00, 0x03])) == (5, 3)
    assert pc_protocol.nak_seq_err(bytes([0x05, 0x00])) is None


def test_status_payload_fields():
    # 24 字节 STATUS 布局（#4 第 4 节，小端）：uptime_s(4) temp_c(1)
    # current_ma_est(2) thermal(1) glitch(2) drop(2) brightness(1)
    # power_limit(2) strip_fault(1) active_effect[8]。
    payload = bytes(
        [0x44, 0x33, 0x22, 0x11, 0xFB, 0xD2, 0x04, 0x01]
        + [0x07, 0x00, 0x09, 0x00, 200, 0x20, 0x4E, 0x80]
        + [0x01, 0x02, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]
    )
    st = pc_protocol.status_payload_to_dict(payload)
    assert st["uptime_s"] == 0x11223344
    assert st["temp_c"] == -5
    assert st["current_ma_est"] == 1234
    assert st["thermal_status"] == 1
    assert st["glitch_count"] == 7
    assert st["drop_count"] == 9
    assert st["brightness"] == 200
    assert st["power_limit_ma"] == 20000
    assert st["strip_fault"] == 0x80
    assert st["active_effect"] == [0x01, 0x02] + [0xFF] * 6
    assert pc_protocol.status_payload_to_dict(bytes(23)) is None