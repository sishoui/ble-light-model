/**
 * 协议 v1 Codec（小程序侧镜像，见 #4 决议与 docs/spec/test-strategy.md §3.2）：
 * 纯函数帧编解码，含粘包 / 分片重组 / CRC / 序号透传。不感知传输层与灯效语义。
 *
 * 帧格式（多字节小端）：
 *   AA 55 | ver(1) | seq(2) | type(1) | flags(1) | strip_mask(1) | param_len(1) | payload(N) | crc16(2)
 * CRC-16/CCITT-FALSE 覆盖 ver..payload。
 *
 * feed 语义（与 firmware/proto/ble_proto.c 逐字节对齐）：
 * - 输入可包含任意粘包 / 半帧；末尾未完成帧的字节放进 remainder，由调用方拼到下一次 feed 前面。
 * - 非帧垃圾、孤立 0xAA 静默丢弃；半帧后遇到新的 AA 55 magic 丢弃半帧（#4：接收端遇新 magic 丢半帧）。
 * - CRC 错但帧内出现 AA 55 视为错位垃圾，静默重同步；否则产出 crc_error（NAK 0x01）。
 * - 语义校验顺序：CRC -> 版本 0x08 -> type 0x02 -> SET_EFFECT 灯效 0x03 -> 长度 0x04。
 * - param_len >= 期望值接受、多余忽略；短于期望值 NAK 0x04（#4 param_len 向后兼容规则）。
 * - seq 错不是协议错误：帧照常解出、Codec 不自行产生 ACK；匹配 / 超时重传由 BleLink 负责。
 */

import { crc16 } from "./crc16";

/** 协议版本（#4 决议）。 */
export const PROTOCOL_VERSION = 1;

/** 帧头长度：AA 55 + ver + seq(2) + type + flags + strip_mask + param_len。 */
export const HEADER_SIZE = 9;

/** payload 上限；整帧最长 266 字节。 */
export const MAX_PAYLOAD = 255;
export const MAX_FRAME_SIZE = HEADER_SIZE + MAX_PAYLOAD + 2;

/** 指令集（#4 决议第 2 节）。 */
export const FRAME_TYPES = {
  hello: 0x01,
  setEffect: 0x02,
  setBrightness: 0x03,
  setPowerLimit: 0x04,
  unlockFullPower: 0x05,
  getStatus: 0x06,
  ack: 0x07,
  nak: 0x08,
  status: 0x09,
} as const;

const KNOWN_TYPE_MIN = FRAME_TYPES.hello;
const KNOWN_TYPE_MAX = FRAME_TYPES.status;

/** NAK 错误码（#4 决议第 4 节）。 */
export const NAK = {
  crc: 0x01,
  unknownType: 0x02,
  unknownEffect: 0x03,
  lengthMismatch: 0x04,
  invalidParam: 0x05,
  notUnlocked: 0x06,
  busy: 0x07,
  badVersion: 0x08,
} as const;

/**
 * 灯效效果参数期望长度表（#4 决议第 3 节），索引即 effect_id，只数效果参数、不含 effect_id 字节
 * （SET_EFFECT payload = effect_id(1) + 效果参数）。协议层只懂长度、不懂灯效语义；未知返回 null。
 */
const EFFECT_PARAM_LENGTHS: readonly (number | null)[] = [0, 3, 7, 10, 3, 7, 5];

export function effectParamLength(effectId: number): number | null {
  if (effectId < 0 || effectId >= EFFECT_PARAM_LENGTHS.length) return null;
  return EFFECT_PARAM_LENGTHS[effectId] ?? null;
}

/** 协议帧（解码结果 / encode 输入）。 */
export interface Frame {
  version: number;
  seq: number;
  type: number;
  flags: number;
  stripMask: number;
  payload: Uint8Array;
}

export type FeedErrorKind =
  | "crc_error"
  | "unknown_type"
  | "unknown_effect"
  | "length_mismatch"
  | "bad_version";

/** 需要回 NAK 的帧错误；error 即 NAK 错误码，seq 为出错帧序号（回显用）。 */
export interface FeedError {
  kind: FeedErrorKind;
  error: number;
  seq: number;
  type: number;
}

export interface FeedResult {
  frames: Frame[];
  errors: FeedError[];
  /** 末尾未完成帧的字节；调用方拼到下一次 feed 前面（保持 feed 为纯函数）。 */
  remainder: Uint8Array;
}

/**
 * 帧 -> 线格式字节。payload 超过 255 字节抛 RangeError；
 * seq / version 按无符号取模编码（是否合法由接收端 feed 判定）。
 */
export function encode(frame: Frame): Uint8Array {
  const paramLen = frame.payload.length;
  if (paramLen > MAX_PAYLOAD) {
    throw new RangeError(`payload 长度 ${paramLen} 超过上限 ${MAX_PAYLOAD}`);
  }

  const out = new Uint8Array(HEADER_SIZE + paramLen + 2);
  out[0] = 0xaa;
  out[1] = 0x55;
  out[2] = frame.version & 0xff;
  out[3] = frame.seq & 0xff;
  out[4] = (frame.seq >> 8) & 0xff;
  out[5] = frame.type & 0xff;
  out[6] = frame.flags & 0xff;
  out[7] = frame.stripMask & 0xff;
  out[8] = paramLen;
  out.set(frame.payload, HEADER_SIZE);

  const crc = crc16(out.subarray(2, HEADER_SIZE + paramLen));
  out[HEADER_SIZE + paramLen] = crc & 0xff;
  out[HEADER_SIZE + paramLen + 1] = (crc >> 8) & 0xff;
  return out;
}

/** 在 [from, until) 内找 AA 55（需 j+1 落在范围内），找不到返回 -1。 */
function findMagic(bytes: Uint8Array, from: number, until: number): number {
  for (let j = from; j + 1 < until; j += 1) {
    if (bytes[j] === 0xaa && bytes[j + 1] === 0x55) return j;
  }
  return -1;
}

/**
 * 字节流 -> 帧 / 错误 / remainder。纯函数：重组状态由调用方用 remainder 传递。
 * 具体规则见文件头注释；与 C 侧 ble_proto_feed 行为逐字节一致（golden 向量验证）。
 */
export function feed(bytes: Uint8Array): FeedResult {
  const frames: Frame[] = [];
  const errors: FeedError[] = [];
  let i = 0;
  const len = bytes.length;

  while (i < len) {
    if (bytes[i] !== 0xaa) {
      i += 1;
      continue;
    }
    if (i + 1 >= len) break; // 末尾半个 magic，留作 remainder
    if (bytes[i + 1] !== 0x55) {
      i += 1; // 孤立 0xAA，垃圾
      continue;
    }

    // 候选帧头不完整：后面若还有新 magic，丢弃半帧从新 magic 重来。
    if (i + HEADER_SIZE > len) {
      const j = findMagic(bytes, i + 1, len);
      if (j >= 0) {
        i = j;
        continue;
      }
      break;
    }

    const version = bytes[i + 2]!;
    const seq = bytes[i + 3]! | (bytes[i + 4]! << 8);
    const type = bytes[i + 5]!;
    const flags = bytes[i + 6]!;
    const stripMask = bytes[i + 7]!;
    const paramLen = bytes[i + 8]!;
    const frameSize = HEADER_SIZE + paramLen + 2;

    // 整帧不完整：同样先找新 magic 重同步，否则留作 remainder 等后续字节。
    if (i + frameSize > len) {
      const j = findMagic(bytes, i + 1, len);
      if (j >= 0) {
        i = j;
        continue;
      }
      break;
    }

    const crcCalc = crc16(bytes.subarray(i + 2, i + HEADER_SIZE + paramLen));
    const crcRecv = bytes[i + HEADER_SIZE + paramLen]! | (bytes[i + HEADER_SIZE + paramLen + 1]! << 8);
    if (crcCalc !== crcRecv) {
      // 帧内出现新 magic 视为错位垃圾，静默重同步；否则是真正的 CRC 错 -> NAK 0x01。
      const j = findMagic(bytes, i + 1, i + frameSize);
      if (j >= 0) {
        i = j;
        continue;
      }
      errors.push({ kind: "crc_error", error: NAK.crc, seq, type });
      i += frameSize;
      continue;
    }

    if (version !== PROTOCOL_VERSION) {
      errors.push({ kind: "bad_version", error: NAK.badVersion, seq, type });
      i += frameSize;
      continue;
    }
    if (type < KNOWN_TYPE_MIN || type > KNOWN_TYPE_MAX) {
      errors.push({ kind: "unknown_type", error: NAK.unknownType, seq, type });
      i += frameSize;
      continue;
    }
    if (type === FRAME_TYPES.setEffect) {
      const payloadStart = i + HEADER_SIZE;
      if (paramLen < 1) {
        errors.push({ kind: "length_mismatch", error: NAK.lengthMismatch, seq, type });
        i += frameSize;
        continue;
      }
      const effectId = bytes[payloadStart]!;
      const expected = effectParamLength(effectId);
      if (expected === null) {
        errors.push({ kind: "unknown_effect", error: NAK.unknownEffect, seq, type });
        i += frameSize;
        continue;
      }
      // 期望长度只数效果参数，payload 还要含 effect_id 字节。
      if (paramLen < 1 + expected) {
        errors.push({ kind: "length_mismatch", error: NAK.lengthMismatch, seq, type });
        i += frameSize;
        continue;
      }
      // paramLen > 1 + expected：接受，多余字节忽略（#4 向后兼容规则）。
    }

    frames.push({
      version,
      seq,
      type,
      flags,
      stripMask,
      payload: bytes.slice(i + HEADER_SIZE, i + HEADER_SIZE + paramLen),
    });
    i += frameSize;
  }

  return { frames, errors, remainder: bytes.slice(i) };
}