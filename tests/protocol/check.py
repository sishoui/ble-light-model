# Python 端 golden 对拍（层 3，骨架占位）。
# 执行阶段：读取 vectors.json，对每条 encode.bytes 做 CRC/magic 校验、对 feed 做重组语义校验，
# 与 C/TS 两端逐字节一致。本文件目前只做 CRC 自洽，与 run-all.mjs 的 JS 校验等价。
import json
import sys


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "vectors.json"
    with open(path, "r", encoding="utf-8") as f:
        v = json.load(f)
    bad = 0
    for e in v.get("encode", []):
        b = bytes(e["bytes"])
        if b[0] != 0xAA or b[1] != 0x55:
            print(f"[py] FAIL {e['name']}: magic", file=sys.stderr)
            bad += 1
        elif crc16(b[2:-2]) != int.from_bytes(b[-2:], "little"):
            print(f"[py] FAIL {e['name']}: crc", file=sys.stderr)
            bad += 1
    print(f"[py] ok: {len(v.get('encode', []))} encode vectors self-consistent" if not bad else "[py] FAIL")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())