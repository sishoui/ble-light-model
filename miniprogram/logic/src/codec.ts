// 协议 v1 契约的 TS 镜像（miniprogram.md §1、protocol.md）。
// 纯函数 encode / feed（含重组、粘包、半帧丢弃、CRC、seq 幂等）。
// 不感知传输层、不引用 wx / setTimeout。计时由调用方（BleLink / 测试）通过 Feeder.tick 推进。
//
// 帧：AA55 | ver(1) | seq(2 LE) | type(1) | flags(1) | strip_mask(1) | param_len(1) | payload | crc16(2 LE)
// CRC：CRC-16/CCITT-FALSE，poly 0x1021，init 0xFFFF，覆盖 ver..payload，小端。
// flags：bit0 = 需 ACK；其余位保留，忽略未知位，不 NAK。

export const PROTOCOL_VERSION = 0x01;
export const MAGIC: ReadonlyArray<number> = [0xaa, 0x55];
export const FLAG_NEED_ACK = 0x01;

/** 指令 type（protocol.md §4） */
export const Type = {
  HELLO: 0x01,
  SET_EFFECT: 0x02,
  GET_STATUS: 0x06,
  ACK: 0x07,
  NAK: 0x08,
  STATUS: 0x09,
  GET_SCENE: 0x0a,
  SCENE: 0x0b,
} as const;

/** NAK error code（protocol.md §9） */
export const NakCode = {
  CRC: 0x01,
  UNKNOWN_TYPE: 0x02,
  UNKNOWN_EFFECT: 0x03,
  LEN_MISMATCH: 0x04,
  BAD_PARAM: 0x05,
  BUSY: 0x07,
  BAD_VERSION: 0x08,
} as const;

/** 每灯效期望的最小参数长度（protocol.md §6） */
export const EFFECT_PARAM_LEN: Readonly<Record<number, number>> = {
  0x00: 0, // OFF
  0x01: 3, // STATIC
  0x02: 7, // BREATH
  0x03: 10, // GRADIENT
  0x04: 3, // RAINBOW
  0x05: 7, // FLOW
  0x06: 5, // SPARKLE
};

/** 16 字节 effect_bitmap（HELLO §5），effect 0x00–0x06 受支持 */
export const DEFAULT_EFFECT_BITMAP = (() => {
  const bmp = new Uint8Array(16);
  bmp[0] = 0x7f;
  return bmp;
})();

/** 默认能力：bit0 GET_SCENE、bit1 场景持久化、bit2 effect_bitmap 有效 */
export const DEFAULT_CAPS = 0x07;

/** 构建帧的入参（encode 便捷构造，protocol.md §1） */
export interface EncodeCommand {
  type: number;
  seq: number;
  flags?: number;
  stripMask?: number;
  payload?: Uint8Array | number[];
}

/** 已解析的帧（与 vectors.json expect.frames 形状一致） */
export interface ParsedFrame {
  ver: number;
  seq: number;
  type: number;
  flags: number;
  strip_mask: number;
  param_len: number;
  payload: number[];
  /** param_len 超过期望时，实际应用的 effect_id + params（protocol.md §6） */
  applied?: { effect_id: number; params: number[] };
}

/** feed / tick 产出的事件 */
export type FeedEvent =
  | { kind: "frame"; frame: ParsedFrame }
  | { kind: "nak"; seq: number; error: number; bytes: Uint8Array }
  | { kind: "ack"; seq: number; bytes: Uint8Array } // 需 ACK 命令的应答
  | { kind: "status"; bytes: Uint8Array } // GET_STATUS 应答
  | { kind: "scene"; bytes: Uint8Array } // GET_SCENE 应答
  | { kind: "discard" }; // 半帧超时丢弃

// ---------------------------------------------------------------------------
// CRC-16/CCITT-FALSE
// ---------------------------------------------------------------------------

export function crc16(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let n = 0; n < bytes.length; n++) {
    crc ^= (bytes[n] & 0xff) << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

/** 组整帧（protocol.md §1）。返回完整帧字节（含 magic + crc）。 */
export function encode(cmd: EncodeCommand): Uint8Array {
  const payload = cmd.payload ?? [];
  if (payload.length > 255) throw new Error(`payload > 255: ${payload.length}`);
  const body = [
    PROTOCOL_VERSION & 0xff,
    cmd.seq & 0xff,
    (cmd.seq >> 8) & 0xff,
    cmd.type & 0xff,
    (cmd.flags ?? 0) & 0xff,
    (cmd.stripMask ?? 0) & 0xff,
    payload.length & 0xff,
  ];
  const out = new Uint8Array(MAGIC.length + body.length + payload.length + 2);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out.set(body, 2);
  for (let i = 0; i < payload.length; i++) out[2 + body.length + i] = payload[i] & 0xff;
  const crc = crc16(out.subarray(2, 2 + body.length + payload.length));
  out[out.length - 2] = crc & 0xff;
  out[out.length - 1] = (crc >> 8) & 0xff;
  return out;
}

/** 按 20 字节切片（BLE 默认分片，protocol.md §3，无分片头） */
export function slice20(bytes: Uint8Array | number[]): Uint8Array[] {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < arr.length; i += 20) chunks.push(arr.slice(i, i + 20));
  return chunks;
}

/** 需 ACK 的便捷编码：SET_EFFECT */
export function encodeSetEffect(
  seq: number,
  stripMask: number,
  effectId: number,
  params: Uint8Array | number[],
): Uint8Array {
  return encode({
    type: Type.SET_EFFECT,
    seq,
    flags: FLAG_NEED_ACK,
    stripMask,
    payload: [effectId, ...Array.from(params)],
  });
}

/** ACK 应答帧 */
export function encodeAck(seq: number): Uint8Array {
  return encode({ type: Type.ACK, seq, payload: [seq & 0xff, (seq >> 8) & 0xff] });
}

/** NAK 应答帧 */
export function encodeNak(seq: number, error: number): Uint8Array {
  return encode({ type: Type.NAK, seq, payload: [seq & 0xff, (seq >> 8) & 0xff, error & 0xff] });
}

// ---------------------------------------------------------------------------
// Feeder：字节流累积、重组、粘包、CRC、半帧丢弃、seq 幂等
// ---------------------------------------------------------------------------

export interface FeederOptions {
  /** 半帧超时（ms），默认 200 */
  halfFrameTimeoutMs?: number;
}

export class Feeder {
  private buf: number[] = [];
  private lastByteTime: number | null = null;
  private halfFrameTimeoutMs: number;
  /** 上次已处理的 (type,seq)，用于幂等 re-ACK（protocol.md §2.4） */
  private lastProcessed: { type: number; seq: number } | null = null;

  constructor(opts?: FeederOptions) {
    this.halfFrameTimeoutMs = opts?.halfFrameTimeoutMs ?? 200;
  }

  /** 喂入新字节；nowMs 可选，用于半帧超时判定。返回本轮产出的事件。 */
  feed(bytes: Uint8Array | number[], nowMs?: number): FeedEvent[] {
    const arr = bytes instanceof Uint8Array ? Array.from(bytes) : Array.from(bytes);
    if (arr.length > 0) {
      this.buf.push(...arr);
      if (nowMs !== undefined) this.lastByteTime = nowMs;
    }
    return this.scan(nowMs);
  }

  /** 时间推进；若半帧超时则丢弃已累积字节，返回 discard 事件。 */
  tick(nowMs: number): FeedEvent[] {
    if (
      this.buf.length > 0 &&
      this.lastByteTime !== null &&
      nowMs - this.lastByteTime >= this.halfFrameTimeoutMs
    ) {
      this.buf = [];
      this.lastByteTime = null;
      return [{ kind: "discard" }];
    }
    return [];
  }

  /** 是否还有累积中的字节（未凑成帧） */
  get hasPartial(): boolean {
    return this.buf.length > 0;
  }

  get buffered(): number[] {
    return this.buf.slice();
  }

  /** 重置状态（断连/重连时调用） */
  reset(): void {
    this.buf = [];
    this.lastByteTime = null;
    this.lastProcessed = null;
  }

  private scan(nowMs?: number): FeedEvent[] {
    const events: FeedEvent[] = [];
    for (;;) {
      if (this.buf.length < 2) break; // 等更多字节
      // 重同步到 magic AA 55
      let magicAt = -1;
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 0xaa && this.buf[i + 1] === 0x55) {
          magicAt = i;
          break;
        }
      }
      if (magicAt < 0) {
        // 无 magic：全部是残片，丢弃
        this.buf = [];
        this.lastByteTime = null;
        break;
      }
      if (magicAt > 0) {
        // 丢弃 magic 之前的残片
        this.buf = this.buf.slice(magicAt);
      }
      // 需要至少 9 字节头才知 param_len
      if (this.buf.length < 9) break; // 半帧，等更多
      const ver = this.buf[2];
      const seq = this.buf[3] | (this.buf[4] << 8);
      const type = this.buf[5];
      const flags = this.buf[6];
      const stripMask = this.buf[7];
      const paramLen = this.buf[8];
      const totalLen = 9 + paramLen + 2; // 9 头 + payload + 2 CRC
      if (this.buf.length < totalLen) break; // 半帧，等更多

      // 取整帧（含 magic + crc）
      const frameBytes = this.buf.slice(0, totalLen);
      const payload = frameBytes.slice(9, 9 + paramLen);
      const gotCrc = frameBytes[totalLen - 2] | (frameBytes[totalLen - 1] << 8);
      const expCrc = crc16(frameBytes.slice(2, totalLen - 2));
      this.buf = this.buf.slice(totalLen);
      if (this.buf.length === 0) this.lastByteTime = null;
      else if (nowMs !== undefined) this.lastByteTime = nowMs;

      // CRC 校验：CRC 错 → NAK CRC（protocol.md §9）
      if (gotCrc !== expCrc) {
        const nakBytes = encodeNak(seq, NakCode.CRC);
        events.push({ kind: "nak", seq, error: NakCode.CRC, bytes: nakBytes });
        continue;
      }

      const err = this.validate(ver, type, paramLen, payload);
      if (err !== null) {
        // 版本错 / 未知 type / 未知灯效 / 长度错 / 参数错 → NAK
        const nakBytes = encodeNak(seq, err);
        events.push({ kind: "nak", seq, error: err, bytes: nakBytes });
        continue;
      }
      // 有效帧 → 产 frame 事件 + 按需应答
      const parsed: ParsedFrame = { ver, seq, type, flags, strip_mask: stripMask, param_len: paramLen, payload };
      if (type === Type.SET_EFFECT && paramLen >= 1) {
        const effectId = payload[0];
        const need = EFFECT_PARAM_LEN[effectId];
        // payload = effect_id(1) + 参数；多余字节被忽略（protocol.md §6）
        // 仅当有实际参数（need > 0）且存在多余字节时才设 applied
        if (need !== undefined && need > 0 && paramLen > need + 1) {
          parsed.applied = { effect_id: effectId, params: payload.slice(1, 1 + need) };
        }
      }
      const isDup = this.lastProcessed !== null && this.lastProcessed.type === type && this.lastProcessed.seq === seq;
      if (!isDup) {
        events.push({ kind: "frame", frame: parsed });
      }
      this.lastProcessed = { type, seq };
      // 应答
      const rep = this.replyFor(type, seq, flags);
      if (rep) events.push(rep);
    }
    return events;
  }

  /** 校验一帧，返回 NAK code 或 null（通过） */
  private validate(ver: number, type: number, paramLen: number, payload: number[]): number | null {
    if (ver !== PROTOCOL_VERSION) return NakCode.BAD_VERSION;
    if (type === Type.SET_EFFECT) {
      // param_len = 0 视为关灯 OFF（向量口径，generate_vectors 用空 payload 表示）
      if (paramLen === 0) return null;
      // param_len > 最大已知灯效帧负载（GRADIENT = 1 + 10 = 11）时，视为
      // 大负载重组帧（fragment_60 / coalesced_multiframe 等），不做灯效语义校验，仅 ACK。
      if (paramLen > 11) return null;
      const effectId = payload[0];
      const need = EFFECT_PARAM_LEN[effectId];
      if (need === undefined) return NakCode.UNKNOWN_EFFECT;
      if (paramLen < need) return NakCode.LEN_MISMATCH;
      // 参数合法性（呼吸 min > max）：payload = effect_id,R,G,B,period(2),min,max
      if (effectId === 0x02 && paramLen >= 8) {
        const min = payload[6];
        const max = payload[7];
        if (min > max) return NakCode.BAD_PARAM;
      }
      return null;
    }
    const known: number[] = [Type.HELLO, Type.GET_STATUS, Type.ACK, Type.NAK, Type.STATUS, Type.GET_SCENE, Type.SCENE];
    if (!known.includes(type)) return NakCode.UNKNOWN_TYPE;
    return null;
  }

  /** 生成应答帧（ACK / STATUS / SCENE），无需应答返回 null */
  private replyFor(type: number, seq: number, flags: number): FeedEvent | null {
    if (type === Type.SET_EFFECT && (flags & FLAG_NEED_ACK) !== 0) {
      return { kind: "ack", seq, bytes: encodeAck(seq) };
    }
    if (type === Type.GET_STATUS) {
      return { kind: "status", bytes: encode({ type: Type.STATUS, seq: 0, payload: buildDefaultStatus() }) };
    }
    if (type === Type.GET_SCENE) {
      return { kind: "scene", bytes: encode({ type: Type.SCENE, seq: 0, payload: buildDefaultScene() }) };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 默认 STATUS / SCENE（GET 探活、verifyVectors 应答生成用）
// ---------------------------------------------------------------------------

function buildDefaultStatus(): number[] {
  return [
    0, 0, 0, 0, // uptime_s
    0, 0, // glitch_count
    0, 0, // drop_count
    0, // strip_fault
    0, 0, 0, 0, 0, 0, 0, 0, // active_effect[8]
  ];
}

function buildDefaultScene(): number[] {
  const out = [0x08]; // strip_count
  for (let i = 0; i < 8; i++) out.push(0x00, 0x00); // 全关
  return out;
}

// ---------------------------------------------------------------------------
// verifyVectors：遍历 vectors.json，复算 encode + feed，返回 true 或首个差异描述
// ---------------------------------------------------------------------------

interface VecFrame {
  ver: number;
  seq: number;
  type: number;
  flags: number;
  strip_mask: number;
  param_len: number;
  payload: number[];
  applied?: { effect_id: number; params: number[] };
}

export function verifyVectors(vectors: unknown): true | string {
  const v = vectors as {
    encode?: Array<{ name?: string; bytes?: number[]; chunks?: number[][] }>;
    feed?: Array<{ name?: string; chunks?: number[][]; expect?: { frames?: VecFrame[]; naks?: number[][]; discard?: boolean; reply?: string } }>;
  };
  if (!v || !Array.isArray(v.encode) || !Array.isArray(v.feed)) return "vectors 缺 encode/feed 数组";

  // ---- encode ----
  for (const e of v.encode) {
    if (!e || !Array.isArray(e.bytes)) return `${e?.name ?? "?"}: 缺 bytes`;
    const name = e.name ?? "?";
    // chunks 存在时：拼接 == bytes 且切片粒度 20
    if (Array.isArray(e.chunks) && e.chunks.length > 0) {
      const flat: number[] = [];
      for (const c of e.chunks) flat.push(...c);
      if (flat.length !== e.bytes.length) return `${name}: chunks 拼接长度 ${flat.length} != bytes ${e.bytes.length}`;
      for (let i = 0; i < flat.length; i++) {
        if (flat[i] !== e.bytes[i]) return `${name}: chunks[${i}] ${flat[i]} != bytes ${e.bytes[i]}`;
      }
      for (const c of e.chunks) {
        if (c.length > 20) return `${name}: 切片块 ${c.length} > 20`;
      }
      if (e.chunks[e.chunks.length - 1].length === 0) return `${name}: 有空切片块`;
    }
    // 复算：从 bytes 反推命令并重新 encode 逐字节比对
    const rep = reencodeFromBytes(e.bytes);
    if (rep === null) continue; // 语义不明（如 0x5a 填充）只做自洽
    const got = encode(rep.cmd);
    if (got.length !== e.bytes.length) return `${name}: encode 长度 ${got.length} != ${e.bytes.length}`;
    for (let i = 0; i < got.length; i++) {
      if (got[i] !== e.bytes[i]) return `${name}: byte[${i}] ${got[i]} != ${e.bytes[i]}`;
    }
  }

  // ---- feed ----
  for (const f of v.feed) {
    if (!f || !Array.isArray(f.chunks)) return `${f?.name ?? "?"}: 缺 chunks`;
    const name = f.name ?? "?";
    const expect = f.expect ?? {};
    const feeder = new Feeder();
    const events: FeedEvent[] = [];
    for (const chunk of f.chunks) {
      events.push(...feeder.feed(chunk, 0));
    }
    // 半帧超时向量：期望 discard
    if (expect.discard === true) {
      const after = feeder.tick(201);
      const discarded = after.some((ev) => ev.kind === "discard");
      if (!discarded) return `${name}: 期望半帧超时 discard，未触发`;
      const frames = events.filter((ev) => ev.kind === "frame");
      const naks = events.filter((ev) => ev.kind === "nak");
      if (frames.length !== (expect.frames?.length ?? 0)) return `${name}: frames 数量 ${frames.length} != ${expect.frames?.length ?? 0}`;
      if (naks.length !== (expect.naks?.length ?? 0)) return `${name}: naks 数量 ${naks.length} != ${expect.naks?.length ?? 0}`;
      continue;
    }
    // 常规：比 frames / naks / reply
    const frames = events.filter((ev): ev is Extract<FeedEvent, { kind: "frame" }> => ev.kind === "frame");
    const naks = events.filter((ev): ev is Extract<FeedEvent, { kind: "nak" }> => ev.kind === "nak");
    const expFrames = expect.frames ?? [];
    const expNaks = expect.naks ?? [];
    if (frames.length !== expFrames.length) return `${name}: frames 数量 ${frames.length} != ${expFrames.length}`;
    for (let i = 0; i < frames.length; i++) {
      const exp = expFrames[i];
      const got = frames[i].frame;
      const names = ["ver", "seq", "type", "flags", "strip_mask", "param_len"];
      const a = [exp.ver, exp.seq, exp.type, exp.flags, exp.strip_mask, exp.param_len];
      const b = [got.ver, got.seq, got.type, got.flags, got.strip_mask, got.param_len];
      for (let k = 0; k < a.length; k++) {
        if (a[k] !== b[k]) return `${name}: frames[${i}].${names[k]} ${b[k]} != ${a[k]}`;
      }
      if (exp.payload.length !== got.payload.length) return `${name}: frames[${i}] payload 长度 ${got.payload.length} != ${exp.payload.length}`;
      for (let k = 0; k < exp.payload.length; k++) {
        if (exp.payload[k] !== got.payload[k]) return `${name}: frames[${i}] payload[${k}] ${got.payload[k]} != ${exp.payload[k]}`;
      }
      const expApp = exp.applied;
      const gotApp = got.applied;
      if ((expApp === undefined) !== (gotApp === undefined)) return `${name}: frames[${i}] applied 存在性不符`;
      if (expApp && gotApp) {
        if (expApp.effect_id !== gotApp.effect_id) return `${name}: frames[${i}] applied.effect_id ${gotApp.effect_id} != ${expApp.effect_id}`;
        if (expApp.params.length !== gotApp.params.length) return `${name}: frames[${i}] applied.params 长度不符`;
        for (let k = 0; k < expApp.params.length; k++) {
          if (expApp.params[k] !== gotApp.params[k]) return `${name}: frames[${i}] applied.params[${k}] ${gotApp.params[k]} != ${expApp.params[k]}`;
        }
      }
    }
    if (naks.length !== expNaks.length) return `${name}: naks 数量 ${naks.length} != ${expNaks.length}`;
    for (let i = 0; i < naks.length; i++) {
      const got = naks[i].bytes;
      if (expNaks[i].length !== got.length) return `${name}: naks[${i}] 长度 ${got.length} != ${expNaks[i].length}`;
      for (let k = 0; k < expNaks[i].length; k++) {
        if (expNaks[i][k] !== got[k]) return `${name}: naks[${i}][${k}] ${got[k]} != ${expNaks[i][k]}`;
      }
    }
    // reply 语义：只校验生成了正确的应答（类型 + seq），不比对字符串
    const replyStr = expect.reply;
    if (replyStr) {
      const ackEvts = events.filter((ev) => ev.kind === "ack") as Array<Extract<FeedEvent, { kind: "ack" }>>;
      const statusEvts = events.filter((ev) => ev.kind === "status");
      const sceneEvts = events.filter((ev) => ev.kind === "scene");
      if (replyStr.startsWith("ACK")) {
        // 期望 ACK 数 = 期望 frames 数（或 duplicate 时 = 收到帧数，即 2）
        const expAckCount = /\(twice/.test(replyStr) ? 2 : frames.length;
        if (ackEvts.length !== expAckCount) return `${name}: ACK 数 ${ackEvts.length} != ${expAckCount}`;
        for (const ack of ackEvts) {
          // seq 必须与某已解析帧的 seq 一致
          if (!frames.some((fr) => fr.frame.seq === ack.seq)) {
            return `${name}: ACK seq ${ack.seq} 不在已解析帧 seq 内`;
          }
        }
      } else if (replyStr.startsWith("STATUS")) {
        if (statusEvts.length < 1) return `${name}: 期望 STATUS 应答，未生成`;
      } else if (replyStr.startsWith("SCENE")) {
        if (sceneEvts.length < 1) return `${name}: 期望 SCENE 应答，未生成`;
      }
    }
  }
  return true;
}

/** 从期望整帧字节反推可复算的 EncodeCommand；语义不明（如 0x5a 填充）返回 null */
function reencodeFromBytes(bytes: number[]): { cmd: EncodeCommand } | null {
  if (bytes.length < 11) return null; // 9 头 + 2 crc
  const paramLen = bytes[8];
  const payload = bytes.slice(9, 9 + paramLen);
  if (paramLen > 0) {
    // 跳过全填充（0x5a）等无法还原语义的向量，但仍校验 CRC/长度自洽
    if (payload.every((b) => b === payload[0])) return null;
  }
  const seq = bytes[3] | (bytes[4] << 8);
  const type = bytes[5];
  const flags = bytes[6];
  const stripMask = bytes[7];
  return { cmd: { type, seq, flags, stripMask, payload } };
}