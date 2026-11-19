"""协议 v1 Python 复刻（PC 集成侧，spec §1.3 第三侧）。

与 `miniprogram/logic/codec.ts`、`firmware/proto/ble_proto.c` 逐字节对齐，
由 `tests/protocol/vectors.json` golden 向量锁定（不跨语言复用代码，只对齐
字节）。纯标准库，不依赖 bleak / pyserial —— 无硬件也能跑向量校验。

帧格式（多字节小端）：
    AA 55 | ver(1) | seq(2) | type(1) | flags(1) | strip_mask(1)
          | param_len(1) | payload(N) | crc16(2)
CRC-16/CCITT-FALSE 覆盖 ver..payload。

feed 语义（与 C / JS 侧一致）：
- 输入可含任意粘包 / 半帧；末尾未完成帧的 remainder 由调用方拼到下一次
  feed 前面（保持 feed 为纯函数）。
- 非帧垃圾、孤立 0xAA 静默丢弃；半帧后遇到新的 AA 55 丢弃半帧。
- CRC 错但帧内出现 AA 55 视为错位垃圾静默重同步；否则 crc_error（NAK 1）。
- 校验顺序：CRC -> 版本(0x08) -> type(0x02) -> SET_EFFECT 灯效(0x03)
  -> 长度(0x04)。
- param_len >= 1 + 期望效果参数长度接受、多余忽略；短则 length_mismatch。
- seq 错不是协议错误：帧照常解出，本层不产生 ACK（匹配/重传归上层）。
"""

from __future__ import annotations

# ---- 常量（与 vectors.json constants 一致） ----

PROTOCOL_VERSION = 1
HEADER_SIZE = 9
MAX_PAYLOAD = 255
MAX_FRAME_SIZE = HEADER_SIZE + MAX_PAYLOAD + 2
MAGIC = b"\xaa\x55"

FRAME_TYPES = {
    "hello": 0x01,
    "setEffect": 0x02,
    "setBrightness": 0x03,
    "setPowerLimit": 0x04,
    "unlockFullPower": 0x05,
    "getStatus": 0x06,
    "ack": 0x07,
    "nak": 0x08,
    "status": 0x09,
}
_KNOWN_TYPE_MIN = FRAME_TYPES["hello"]
_KNOWN_TYPE_MAX = FRAME_TYPES["status"]

NAK = {
    "crc": 0x01,
    "unknownType": 0x02,
    "unknownEffect": 0x03,
    "lengthMismatch": 0x04,
    "invalidParam": 0x05,
    "notUnlocked": 0x06,
    "busy": 0x07,
    "badVersion": 0x08,
}
# NAK 码 -> feed 错误 kind 名（与 vectors.json expect_errors.kind 对齐）。
_NAK_KIND = {
    NAK["crc"]: "crc_error",
    NAK["unknownType"]: "unknown_type",
    NAK["unknownEffect"]: "unknown_effect",
    NAK["lengthMismatch"]: "length_mismatch",
    NAK["badVersion"]: "bad_version",
}

# 灯效效果参数期望长度（只数效果参数、不含 effect_id 字节）。
_EFFECT_PARAM_LENGTHS = (0, 3, 7, 10, 3, 7, 5)


# ---- CRC ----


def crc16_ccitt_false(data: bytes) -> int:
    """CRC-16/CCITT-FALSE：poly=0x1021 init=0xFFFF，无反射/无自出。"""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


# ---- encode ----


def encode(frame: dict) -> bytes:
    """帧 dict -> 线格式字节。

    frame: {"ver": int, "seq": int, "type": int, "flags": int,
            "strip_mask": int, "payload": bytes}
    payload 超过 255 字节抛 ValueError。
    """
    payload = bytes(frame["payload"])
    if len(payload) > MAX_PAYLOAD:
        raise ValueError(f"payload 长度 {len(payload)} 超过上限 {MAX_PAYLOAD}")

    out = bytearray(
        [
            0xAA,
            0x55,
            frame["ver"] & 0xFF,
            frame["seq"] & 0xFF,
            (frame["seq"] >> 8) & 0xFF,
            frame["type"] & 0xFF,
            frame["flags"] & 0xFF,
            frame["strip_mask"] & 0xFF,
            len(payload),
        ]
    )
    out += payload
    crc = crc16_ccitt_false(out[2:])
    out.append(crc & 0xFF)
    out.append((crc >> 8) & 0xFF)
    return bytes(out)


# ---- feed ----


def _effect_param_length(effect_id: int) -> int | None:
    if 0 <= effect_id < len(_EFFECT_PARAM_LENGTHS):
        return _EFFECT_PARAM_LENGTHS[effect_id]
    return None


def _find_magic(buf: bytes, from_: int, until: int) -> int:
    for j in range(from_, until - 1):
        if buf[j] == 0xAA and buf[j + 1] == 0x55:
            return j
    return -1


def feed(data: bytes, pending: bytes = b"") -> tuple[list[dict], list[dict], bytes]:
    """字节流 -> (frames, errors, remainder)。

    frames: [{"ver","seq","type","flags","strip_mask","payload"(bytes)}]
    errors: [{"kind","error"(NAK 码),"seq","type"}]（顺序敏感）
    remainder: 末尾未完成帧字节，拼到下一次 feed 前面。
    """
    buf = pending + data
    frames: list[dict] = []
    errors: list[dict] = []
    i = 0
    n = len(buf)

    while i < n:
        if buf[i] != 0xAA:
            i += 1
            continue
        if i + 1 >= n:
            break  # 末尾半个 magic，留作 remainder
        if buf[i + 1] != 0x55:
            i += 1  # 孤立 0xAA，垃圾
            continue

        # 候选帧头不完整：后面若还有新 magic，丢弃半帧从新 magic 重来。
        if i + HEADER_SIZE > n:
            j = _find_magic(buf, i + 1, n)
            if j >= 0:
                i = j
                continue
            break

        version = buf[i + 2]
        seq = buf[i + 3] | (buf[i + 4] << 8)
        type_ = buf[i + 5]
        flags = buf[i + 6]
        strip_mask = buf[i + 7]
        param_len = buf[i + 8]
        frame_size = HEADER_SIZE + param_len + 2

        # 整帧不完整：同样先找新 magic 重同步，否则留作 remainder。
        if i + frame_size > n:
            j = _find_magic(buf, i + 1, n)
            if j >= 0:
                i = j
                continue
            break

        crc_calc = crc16_ccitt_false(buf[i + 2 : i + HEADER_SIZE + param_len])
        crc_recv = buf[i + HEADER_SIZE + param_len] | (
            buf[i + HEADER_SIZE + param_len + 1] << 8
        )
        if crc_calc != crc_recv:
            # 帧内出现新 magic 视为错位垃圾，静默重同步；否则真正的 CRC 错。
            j = _find_magic(buf, i + 1, i + frame_size)
            if j >= 0:
                i = j
                continue
            errors.append(
                {"kind": "crc_error", "error": NAK["crc"], "seq": seq, "type": type_}
            )
            i += frame_size
            continue

        if version != PROTOCOL_VERSION:
            errors.append(
                {
                    "kind": "bad_version",
                    "error": NAK["badVersion"],
                    "seq": seq,
                    "type": type_,
                }
            )
            i += frame_size
            continue
        if type_ < _KNOWN_TYPE_MIN or type_ > _KNOWN_TYPE_MAX:
            errors.append(
                {
                    "kind": "unknown_type",
                    "error": NAK["unknownType"],
                    "seq": seq,
                    "type": type_,
                }
            )
            i += frame_size
            continue
        if type_ == FRAME_TYPES["setEffect"]:
            if param_len < 1:
                errors.append(
                    {
                        "kind": "length_mismatch",
                        "error": NAK["lengthMismatch"],
                        "seq": seq,
                        "type": type_,
                    }
                )
                i += frame_size
                continue
            expected = _effect_param_length(buf[i + HEADER_SIZE])
            if expected is None:
                errors.append(
                    {
                        "kind": "unknown_effect",
                        "error": NAK["unknownEffect"],
                        "seq": seq,
                        "type": type_,
                    }
                )
                i += frame_size
                continue
            # 期望长度只数效果参数，payload 还要含 effect_id 字节。
            if param_len < 1 + expected:
                errors.append(
                    {
                        "kind": "length_mismatch",
                        "error": NAK["lengthMismatch"],
                        "seq": seq,
                        "type": type_,
                    }
                )
                i += frame_size
                continue
            # param_len 更长：接受，多余字节忽略（向后兼容）。

        frames.append(
            {
                "ver": version,
                "seq": seq,
                "type": type_,
                "flags": flags,
                "strip_mask": strip_mask,
                "payload": buf[i + HEADER_SIZE : i + HEADER_SIZE + param_len],
            }
        )
        i += frame_size

    return frames, errors, buf[i:]


# ---- 响应帧 payload 解析（PC 侧 notify 断言用） ----


def ack_seq(payload: bytes) -> int | None:
    """ACK payload = echo_seq(2 LE)；长度不足返回 None。"""
    if len(payload) < 2:
        return None
    return payload[0] | (payload[1] << 8)


def nak_seq_err(payload: bytes) -> tuple[int, int] | None:
    """NAK payload = echo_seq(2 LE) + err(1)；长度不足返回 None。"""
    if len(payload) < 3:
        return None
    return payload[0] | (payload[1] << 8), payload[2]


def status_payload_to_dict(payload: bytes) -> dict | None:
    """STATUS payload（24 字节，#4 第 4 节，小端）-> dict；不足返回 None。"""
    if len(payload) < 24:
        return None
    return {
        "uptime_s": int.from_bytes(payload[0:4], "little"),
        "temp_c": int.from_bytes(payload[4:5], "little", signed=True),
        "current_ma_est": int.from_bytes(payload[5:7], "little"),
        "thermal_status": payload[7],
        "glitch_count": int.from_bytes(payload[8:10], "little"),
        "drop_count": int.from_bytes(payload[10:12], "little"),
        "brightness": payload[12],
        "power_limit_ma": int.from_bytes(payload[13:15], "little"),
        "strip_fault": payload[15],
        "active_effect": list(payload[16:24]),
    }