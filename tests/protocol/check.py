#!/usr/bin/env python3
"""Python 端 golden 对拍（test-strategy.md §1 层 3）。

读取 tests/protocol/vectors.json，**独立**实现 protocol.md 的 encode + feed
（CRC / 组帧 / 分片重组 / seq 幂等 / ACK-NAK / 参数校验），逐条与期望比对。
这是三端对拍中的 Python 镜像，不 import 任何 TS/C 产物。

用法：python tests/protocol/check.py [vectors.json]
退出码：0 全绿 / 1 有差异。
"""

import json
import sys

MAGIC = (0xAA, 0x55)
VERSION = 0x01
FLAG_NEED_ACK = 0x01

T_HELLO = 0x01
T_SET_EFFECT = 0x02
T_GET_STATUS = 0x06
T_ACK = 0x07
T_NAK = 0x08
T_STATUS = 0x09
T_GET_SCENE = 0x0A
T_SCENE = 0x0B

NAK_CRC = 0x01
NAK_UNKNOWN_TYPE = 0x02
NAK_UNKNOWN_EFFECT = 0x03
NAK_LEN_MISMATCH = 0x04
NAK_BAD_PARAM = 0x05
NAK_BAD_VERSION = 0x08

# 每灯效期望参数字节数（不含 effect_id），protocol.md §6。
EFFECT_PARAM_LEN = {
    0x00: 0,   # OFF
    0x01: 3,   # STATIC
    0x02: 7,   # BREATH
    0x03: 10,  # GRADIENT
    0x04: 3,   # RAINBOW
    0x05: 7,   # FLOW
    0x06: 5,   # SPARKLE
}

KNOWN_TYPES = {T_HELLO, T_GET_STATUS, T_ACK, T_NAK, T_STATUS, T_GET_SCENE, T_SCENE}
HALF_FRAME_TIMEOUT_MS = 200


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= (b & 0xFF) << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def encode(seq, type_, flags, strip_mask, payload):
    """组整帧（含 magic + crc）。"""
    payload = bytes(payload)
    if len(payload) > 255:
        raise ValueError("payload > 255")
    body = bytes(
        [
            VERSION,
            seq & 0xFF,
            (seq >> 8) & 0xFF,
            type_ & 0xFF,
            flags & 0xFF,
            strip_mask & 0xFF,
            len(payload),
        ]
    ) + payload
    crc = crc16(body)
    return bytes(MAGIC) + body + bytes([crc & 0xFF, (crc >> 8) & 0xFF])


def encode_nak(seq, error):
    return encode(seq, T_NAK, 0, 0, [seq & 0xFF, (seq >> 8) & 0xFF, error])


def encode_ack(seq):
    return encode(seq, T_ACK, 0, 0, [seq & 0xFF, (seq >> 8) & 0xFF])


def validate_frame(ver, type_, param_len, payload):
    """返回 NAK code；0 表示通过。"""
    if ver != VERSION:
        return NAK_BAD_VERSION
    if type_ == T_SET_EFFECT:
        if param_len == 0:
            return 0
        # 大负载分片 golden：长度/CRC 合法即交付，只 ACK（三端统一口径）。
        if param_len > 11:
            return 0
        effect_id = payload[0]
        need = EFFECT_PARAM_LEN.get(effect_id)
        if need is None:
            return NAK_UNKNOWN_EFFECT
        if param_len < need:
            return NAK_LEN_MISMATCH
        # 呼吸 min > max
        if effect_id == 0x02 and param_len >= 8 and payload[6] > payload[7]:
            return NAK_BAD_PARAM
        return 0
    if type_ in KNOWN_TYPES:
        return 0
    return NAK_UNKNOWN_TYPE


class Feeder:
    """字节流累积、magic 重同步、粘包切帧、CRC、seq 幂等、应答。"""

    def __init__(self):
        self.buf = bytearray()
        self.last_byte_ms = None
        self.last_processed = None  # (type, seq)

    def reset(self):
        self.buf = bytearray()
        self.last_byte_ms = None
        self.last_processed = None

    def feed(self, chunk, now_ms=0):
        chunk = bytes(chunk)
        if chunk:
            self.buf.extend(chunk)
            self.last_byte_ms = now_ms
        return self._scan(now_ms)

    def tick(self, now_ms):
        if (
            self.buf
            and self.last_byte_ms is not None
            and now_ms - self.last_byte_ms >= HALF_FRAME_TIMEOUT_MS
        ):
            self.buf = bytearray()
            self.last_byte_ms = None
            return [{"kind": "discard"}]
        return []

    def _scan(self, now_ms):
        events = []
        while True:
            if len(self.buf) < 2:
                break
            magic_at = -1
            for i in range(len(self.buf) - 1):
                if self.buf[i] == 0xAA and self.buf[i + 1] == 0x55:
                    magic_at = i
                    break
            if magic_at < 0:
                self.buf = bytearray()
                self.last_byte_ms = None
                break
            if magic_at > 0:
                del self.buf[:magic_at]
            if len(self.buf) < 9:
                break
            param_len = self.buf[8]
            total = 9 + param_len + 2
            if len(self.buf) < total:
                break

            fb = bytes(self.buf[:total])
            del self.buf[:total]
            if not self.buf:
                self.last_byte_ms = None
            else:
                self.last_byte_ms = now_ms

            ver = fb[2]
            seq = fb[3] | (fb[4] << 8)
            type_ = fb[5]
            flags = fb[6]
            strip_mask = fb[7]
            payload = fb[9 : 9 + param_len]
            got_crc = fb[total - 2] | (fb[total - 1] << 8)
            exp_crc = crc16(fb[2 : total - 2])

            if got_crc != exp_crc:
                events.append({"kind": "nak", "seq": seq, "error": NAK_CRC, "bytes": encode_nak(seq, NAK_CRC)})
                continue

            err = validate_frame(ver, type_, param_len, payload)
            if err != 0:
                events.append({"kind": "nak", "seq": seq, "error": err, "bytes": encode_nak(seq, err)})
                continue

            frame = {
                "ver": ver,
                "seq": seq,
                "type": type_,
                "flags": flags,
                "strip_mask": strip_mask,
                "param_len": param_len,
                "payload": list(payload),
            }
            if type_ == T_SET_EFFECT and param_len >= 1:
                need = EFFECT_PARAM_LEN.get(payload[0])
                if need is not None and need > 0 and param_len > need + 1:
                    frame["applied"] = {"effect_id": payload[0], "params": list(payload[1 : 1 + need])}

            is_dup = self.last_processed == (type_, seq)
            if not is_dup:
                events.append({"kind": "frame", "frame": frame})
            self.last_processed = (type_, seq)

            if type_ == T_SET_EFFECT and (flags & FLAG_NEED_ACK):
                events.append({"kind": "ack", "seq": seq, "bytes": encode_ack(seq)})
            elif type_ == T_GET_STATUS:
                events.append({"kind": "status"})
            elif type_ == T_GET_SCENE:
                events.append({"kind": "scene"})
        return events


def _cmp_bytes(label, got, exp):
    if len(got) != len(exp):
        return f"{label} 长度 {len(got)} != {len(exp)}"
    for i, (a, b) in enumerate(zip(got, exp)):
        if a != b:
            return f"{label}[{i}] {a} != {b}"
    return None


def check_encode(vec):
    name = vec.get("name", "?")
    b = vec.get("bytes")
    if not isinstance(b, list) or len(b) < 11:
        return f"{name}: bytes 缺失或过短"
    param_len = b[8]
    if len(b) != 9 + param_len + 2:
        return f"{name}: 整帧长度 {len(b)} != 9+{param_len}+2"
    if b[0] != 0xAA or b[1] != 0x55:
        return f"{name}: magic 不符"

    chunks = vec.get("chunks")
    if isinstance(chunks, list) and chunks:
        flat = [x for c in chunks for x in c]
        d = _cmp_bytes(f"{name}: chunks 拼接", flat, b)
        if d:
            return d
        for i, c in enumerate(chunks):
            if len(c) == 0 or len(c) > 20:
                return f"{name}: chunks[{i}] 长度 {len(c)} 不在 1..20"
            if i + 1 < len(chunks) and len(c) != 20:
                return f"{name}: chunks[{i}] 非末块长度 {len(c)} != 20"

    seq = b[3] | (b[4] << 8)
    got = encode(seq, b[5], b[6], b[7], b[9 : 9 + param_len])
    return _cmp_bytes(f"{name}: encode", list(got), b)


def check_feed(vec):
    name = vec.get("name", "?")
    expect = vec.get("expect", {})
    feeder = Feeder()
    events = []
    for chunk in vec.get("chunks", []):
        events.extend(feeder.feed(chunk, 0))
    if expect.get("discard") is True:
        events.extend(feeder.tick(201))

    frames = [e for e in events if e["kind"] == "frame"]
    naks = [e for e in events if e["kind"] == "nak"]
    exp_frames = expect.get("frames", [])
    exp_naks = expect.get("naks", [])

    if len(frames) != len(exp_frames):
        return f"{name}: frames 数量 {len(frames)} != {len(exp_frames)}"
    for i, exp in enumerate(exp_frames):
        got = frames[i]["frame"]
        for field in ("ver", "seq", "type", "flags", "strip_mask", "param_len"):
            if got[field] != exp[field]:
                return f"{name}: frames[{i}].{field} {got[field]} != {exp[field]}"
        d = _cmp_bytes(f"{name}: frames[{i}].payload", got["payload"], exp["payload"])
        if d:
            return d
        exp_app = exp.get("applied")
        got_app = got.get("applied")
        if (exp_app is None) != (got_app is None):
            return f"{name}: frames[{i}] applied 存在性不符"
        if exp_app is not None and got_app is not None:
            if exp_app["effect_id"] != got_app["effect_id"]:
                return f"{name}: frames[{i}] applied.effect_id 不符"
            d = _cmp_bytes(f"{name}: frames[{i}].applied.params", got_app["params"], exp_app["params"])
            if d:
                return d

    if len(naks) != len(exp_naks):
        return f"{name}: naks 数量 {len(naks)} != {len(exp_naks)}"
    for i, exp in enumerate(exp_naks):
        d = _cmp_bytes(f"{name}: naks[{i}]", list(naks[i]["bytes"]), exp)
        if d:
            return d

    if expect.get("discard") is True and not any(e["kind"] == "discard" for e in events):
        return f"{name}: 期望 discard，未触发"

    reply = expect.get("reply")
    if reply:
        acks = [e for e in events if e["kind"] == "ack"]
        if reply.startswith("ACK"):
            exp_ack_count = 2 if "twice" in reply else len(frames)
            if len(acks) != exp_ack_count:
                return f"{name}: ACK 数 {len(acks)} != {exp_ack_count}"
            frame_seqs = {f["frame"]["seq"] for f in frames}
            for ack in acks:
                if ack["seq"] not in frame_seqs:
                    return f"{name}: ACK seq {ack['seq']} 不在已解析帧内"
                d = _cmp_bytes(f"{name}: ACK seq={ack['seq']} 字节", list(ack["bytes"]), list(encode_ack(ack["seq"])))
                if d:
                    return d
        elif reply.startswith("STATUS"):
            if not any(e["kind"] == "status" for e in events):
                return f"{name}: 期望 STATUS，未生成"
        elif reply.startswith("SCENE"):
            if not any(e["kind"] == "scene" for e in events):
                return f"{name}: 期望 SCENE，未生成"
    return None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "tests/protocol/vectors.json"
    with open(path, "r", encoding="utf-8") as f:
        vectors = json.load(f)

    enc = vectors.get("encode", [])
    feeds = vectors.get("feed", [])
    errors = []
    for v in enc:
        err = check_encode(v)
        if err:
            errors.append(err)
            break
    if not errors:
        for v in feeds:
            err = check_feed(v)
            if err:
                errors.append(err)
                break

    if errors:
        for e in errors:
            print(f"[py] FAIL: {e}", file=sys.stderr)
        return 1
    print(f"[py] ok: {len(enc)} encode + {len(feeds)} feed vectors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
