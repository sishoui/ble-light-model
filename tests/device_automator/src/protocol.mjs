/**
 * 协议 v1 解码（真机 automator 侧，只读断言用）。
 *
 * 帧布局（与 miniprogram/logic/codec.ts、firmware/proto/、
 * tests/pc_integration/pc_protocol.py 同一 golden 契约，tests/protocol/vectors.json）：
 *   AA55 | ver(1) | seq(2 LE) | type(1) | flags(1) | strip_mask(1) | param_len(1) | payload(N) | crc16(2 LE)
 * crc16：CRC-16/CCITT-FALSE（poly 0x1021, init 0xFFFF），覆盖 ver..payload。
 *
 * 本模块只解码不编码：设备侧断言只需读懂 BLE notify（HELLO / ACK / NAK / STATUS）
 * 与 COM6 JSONL 事件里的 type / flags / len 字段；strip_mask / payload 本体不在
 * 固件 JSONL rx 事件里（固件 schema 见 firmware/ports/esp32/event_log_port.c），
 * 故掩码 / 灯效逐字段断言由 STATUS active_effect 兜底（与 PC harness
 * expect_status_fields 同口径）。
 */

export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 9;

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
};

export const TYPE_NAMES = {
  0x01: 'HELLO',
  0x02: 'SET_EFFECT',
  0x03: 'SET_BRIGHTNESS',
  0x04: 'SET_POWER_LIMIT',
  0x05: 'UNLOCK_FULL_POWER',
  0x06: 'GET_STATUS',
  0x07: 'ACK',
  0x08: 'NAK',
  0x09: 'STATUS',
};

/** NAK 错误码（#4 决议第 4 节）。 */
export const NAK_ERRORS = {
  0x01: 'crc_error',
  0x02: 'unknown_type',
  0x03: 'unknown_effect',
  0x04: 'length_mismatch',
  0x05: 'invalid_param',
  0x06: 'not_unlocked',
  0x07: 'busy',
  0x08: 'bad_version',
};

export const EFFECT_IDS = {
  off: 0x00,
  static: 0x01,
  breath: 0x02,
  gradient: 0x03,
  rainbow: 0x04,
  flow: 0x05,
  twinkle: 0x06,
};

export function hexToBytes(hex) {
  const clean = String(hex).trim().toLowerCase();
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += ('0' + bytes[i].toString(16)).slice(-2);
  return out;
}

/** CRC-16/CCITT-FALSE：poly 0x1021，init 0xFFFF，无反射，无最终异或。 */
export function crc16(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

/** 解码一条完整帧；多余尾部字节（粘包余留）静默忽略。 */
export function decodeFrame(hex) {
  const bytes = hexToBytes(hex);
  if (bytes === null) return { ok: false, error: '非法 hex' };
  if (bytes.length < HEADER_SIZE + 2) return { ok: false, error: '长度不足' };
  if (bytes[0] !== 0xaa || bytes[1] !== 0x55) return { ok: false, error: '帧头非 AA55' };
  const paramLen = bytes[8];
  const payloadEnd = HEADER_SIZE + paramLen;
  if (bytes.length < payloadEnd + 2) return { ok: false, error: '帧被截断' };
  const expectCrc = bytes[payloadEnd] | (bytes[payloadEnd + 1] << 8);
  const actualCrc = crc16(bytes.subarray(2, payloadEnd));
  if (expectCrc !== actualCrc) {
    return { ok: false, error: `CRC 错（期望 0x${actualCrc.toString(16).padStart(4, '0')} 实际 0x${expectCrc.toString(16).padStart(4, '0')}）` };
  }
  const seq = bytes[3] | (bytes[4] << 8);
  const payloadBytes = bytes.subarray(HEADER_SIZE, payloadEnd);
  return {
    ok: true,
    frame: {
      version: bytes[2],
      seq,
      type: bytes[5],
      typeName: TYPE_NAMES[bytes[5]] ?? `0x${bytes[5].toString(16)}`,
      flags: bytes[6],
      needsAck: (bytes[6] & 0x01) !== 0,
      stripMask: bytes[7],
      paramLen,
      payloadBytes,
      payloadHex: bytesToHex(payloadBytes),
    },
  };
}

/** ACK/NAK notify 里回显的 seq（payload 前 2 字节 LE）。 */
export function ackSeq(frame) {
  const p = frame.payloadBytes;
  if (p.length < 2) return null;
  return p[0] | (p[1] << 8);
}

/** NAK notify 里的 (seq, err)。 */
export function nakSeqErr(frame) {
  const p = frame.payloadBytes;
  if (p.length < 3) return null;
  return { seq: p[0] | (p[1] << 8), err: p[2] };
}

/** 解析 STATUS payload（24 字节）。不足长度返回 null。 */
export function parseStatusPayload(hex) {
  const bytes = hexToBytes(hex);
  if (bytes === null || bytes.length !== 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    uptimeS: view.getUint32(0, true),
    tempC: view.getInt8(4),
    currentMaEst: view.getUint16(5, true),
    thermalStatus: bytes[7],
    glitchCount: view.getUint16(8, true),
    dropCount: view.getUint16(10, true),
    brightness: bytes[12],
    powerLimitMa: view.getUint16(13, true),
    stripFault: bytes[15],
    activeEffect: Array.from(bytes.subarray(16, 24)),
  };
}

/** 解析 HELLO payload（23 或 29 字节）。 */
export function parseHelloPayload(hex) {
  const bytes = hexToBytes(hex);
  if (bytes === null || (bytes.length !== 23 && bytes.length !== 29)) return null;
  const bitmapLen = bytes.length - 13;
  const effectBitmap = new Uint8Array(16);
  effectBitmap.set(bytes.subarray(13, 13 + bitmapLen));
  return {
    protocolVersion: bytes[0],
    fwVersion: `${bytes[1]}.${bytes[2]}.${bytes[3]}`,
    stripCount: bytes[4],
    ledsPerStrip: bytes[5],
    maxCurrentMa: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(6, true),
    powerLimitMa: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(8, true),
    thermalWarningC: bytes[10],
    thermalShutdownC: bytes[11],
    caps: bytes[12],
    effectBitmapLen: bitmapLen,
    effectBitmap,
  };
}
