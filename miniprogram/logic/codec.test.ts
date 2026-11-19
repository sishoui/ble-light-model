import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FRAME_TYPES,
  NAK,
  PROTOCOL_VERSION,
  effectParamLength,
  encode,
  feed,
  type Frame,
} from "./codec";

// ---------- hex 工具 ----------

function toBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------- golden 向量类型（tests/protocol/vectors.json 的子集） ----------

interface VectorFrame {
  ver: number;
  seq: number;
  type: number;
  flags: number;
  strip_mask: number;
  payload: string;
}

interface VectorError {
  kind: string;
  error: number;
  seq: number;
  type: number;
}

interface EncodeVector {
  id: string;
  kind: "encode";
  desc: string;
  frame: VectorFrame;
  expect_hex: string;
}

interface FeedVector {
  id: string;
  kind: "feed";
  desc: string;
  writes: string[];
  expect_frames: VectorFrame[];
  expect_errors: VectorError[];
  expect_remainders: string[];
  last_outstanding_seq?: number;
  expect_ack_generated?: boolean;
}

type Vector = EncodeVector | FeedVector;

interface VectorsDoc {
  version: number;
  vectors: Vector[];
}

const vectorsPath = fileURLToPath(new URL("../../tests/protocol/vectors.json", import.meta.url));
const doc = JSON.parse(readFileSync(vectorsPath, "utf8")) as VectorsDoc;

const encodeVectors = doc.vectors.filter((v): v is EncodeVector => v.kind === "encode");
const feedVectors = doc.vectors.filter((v): v is FeedVector => v.kind === "feed");

function toFrame(f: VectorFrame): Frame {
  return {
    version: f.ver,
    seq: f.seq,
    type: f.type,
    flags: f.flags,
    stripMask: f.strip_mask,
    payload: toBytes(f.payload),
  };
}

// ---------- encode ----------

describe("encode", () => {
  // 手算锚点：GET_STATUS（ver=1, seq=3, type=0x06, flags=0, strip=0, 空 payload）。
  // CRC 覆盖字节 01 03 00 06 00 00 00，CRC-16/CCITT-FALSE = 0xA0D6，小端追加 D6 A0。
  // 该字面量不经 vectors.json / 生成器，用于钉死帧布局与 CRC 覆盖范围。
  it("按 spec 帧布局编码 GET_STATUS（手算字面量）", () => {
    const frame: Frame = {
      version: 1,
      seq: 3,
      type: 0x06,
      flags: 0,
      stripMask: 0,
      payload: new Uint8Array(0),
    };

    expect(toHex(encode(frame))).toBe("AA5501030006000000D6A0");
  });

  for (const v of encodeVectors) {
    it(`golden ${v.id}：${v.desc}`, () => {
      expect(toHex(encode(toFrame(v.frame)))).toBe(v.expect_hex);
    });
  }

  it("payload 超过 255 字节抛 RangeError", () => {
    const frame: Frame = {
      version: 1,
      seq: 1,
      type: 2,
      flags: 1,
      stripMask: 0xff,
      payload: new Uint8Array(256),
    };

    expect(() => encode(frame)).toThrow(RangeError);
  });
});

// ---------- feed ----------

describe("feed", () => {
  for (const v of feedVectors) {
    it(`golden ${v.id}：${v.desc}`, () => {
      const frames: Frame[] = [];
      const errors: unknown[] = [];
      let pending: Uint8Array = new Uint8Array(0);

      v.writes.forEach((write, index) => {
        const result = feed(concat(pending, toBytes(write)));
        expect(toHex(result.remainder), `第 ${index + 1} 次写入后的 remainder`).toBe(
          v.expect_remainders[index],
        );
        frames.push(...result.frames);
        errors.push(...result.errors);
        pending = result.remainder;
      });

      expect(frames).toHaveLength(v.expect_frames.length);
      v.expect_frames.forEach((expected, index) => {
        const actual = frames[index];
        if (actual === undefined) throw new Error(`缺少第 ${index + 1} 帧`);
        expect(actual.version, `frames[${index}].version`).toBe(expected.ver);
        expect(actual.seq, `frames[${index}].seq`).toBe(expected.seq);
        expect(actual.type, `frames[${index}].type`).toBe(expected.type);
        expect(actual.flags, `frames[${index}].flags`).toBe(expected.flags);
        expect(actual.stripMask, `frames[${index}].stripMask`).toBe(expected.strip_mask);
        expect(toHex(actual.payload), `frames[${index}].payload`).toBe(expected.payload);
      });

      expect(errors).toHaveLength(v.expect_errors.length);
      v.expect_errors.forEach((expected, index) => {
        const actual = errors[index] as { kind: string; error: number; seq: number; type: number };
        expect(actual.kind, `errors[${index}].kind`).toBe(expected.kind);
        expect(actual.error, `errors[${index}].error`).toBe(expected.error);
        expect(actual.seq, `errors[${index}].seq`).toBe(expected.seq);
        expect(actual.type, `errors[${index}].type`).toBe(expected.type);
      });

      if (v.expect_ack_generated !== undefined) {
        // seq 错 / ACK 回显场景：Codec 不得自行产生 ACK 帧（匹配与重传归 BleLink）。
        // 输入里的 ACK 回显帧照常解出，输出 ACK 数量 = 输入 ACK 数量。
        expect(v.expect_ack_generated).toBe(false);
        const ackIn = v.expect_frames.filter((f) => f.type === FRAME_TYPES.ack).length;
        expect(frames.filter((f) => f.type === FRAME_TYPES.ack)).toHaveLength(ackIn);
      }
    });
  }

  it("纯垃圾字节全部丢弃，无帧无错无残留", () => {
    const result = feed(toBytes("002AF00AA"));

    expect(result.frames).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.remainder).toHaveLength(0);
  });

  it("末尾半个 magic 保留为 remainder", () => {
    const result = feed(toBytes("AA5501"));

    expect(result.frames).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(toHex(result.remainder)).toBe("AA5501");
  });
});

// ---------- 交叉性质：encode 的帧都能被 feed 原样解回 ----------

describe("encode / feed 往返", () => {
  for (const v of encodeVectors) {
    it(`${v.id} 编码后再喂入可还原`, () => {
      const bytes = toBytes(v.expect_hex);
      const result = feed(bytes);

      expect(result.errors).toHaveLength(0);
      expect(result.frames).toHaveLength(1);
      const frame = result.frames[0];
      if (frame === undefined) throw new Error("未解出帧");
      expect(frame.version).toBe(v.frame.ver);
      expect(frame.seq).toBe(v.frame.seq);
      expect(frame.type).toBe(v.frame.type);
      expect(toHex(frame.payload)).toBe(v.frame.payload);
    });
  }
});

// ---------- 常量表 ----------

describe("协议常量", () => {
  it("与 spec / #4 决议一致", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(FRAME_TYPES.setEffect).toBe(0x02);
    expect(FRAME_TYPES.ack).toBe(0x07);
    expect(FRAME_TYPES.nak).toBe(0x08);
    expect(NAK.crc).toBe(0x01);
    expect(NAK.unknownType).toBe(0x02);
    expect(NAK.unknownEffect).toBe(0x03);
    expect(NAK.lengthMismatch).toBe(0x04);
    expect(NAK.badVersion).toBe(0x08);
    // 灯效参数长度表：0x00 关灯=0、0x01 静态=3、0x02 呼吸=7、0x03 渐变=10、
    // 0x04 彩虹=3、0x05 流水=7、0x06 星闪=5；0x07 及以上未知（null）。
    expect(effectParamLength(0)).toBe(0);
    expect(effectParamLength(1)).toBe(3);
    expect(effectParamLength(2)).toBe(7);
    expect(effectParamLength(3)).toBe(10);
    expect(effectParamLength(4)).toBe(3);
    expect(effectParamLength(5)).toBe(7);
    expect(effectParamLength(6)).toBe(5);
    expect(effectParamLength(7)).toBeNull();
    expect(effectParamLength(0xff)).toBeNull();
  });
});