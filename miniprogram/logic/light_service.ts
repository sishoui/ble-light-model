/**
 * LightService：8 路灯带业务层（GLOSSARY / spec §1.1 四层单向依赖的最上层）。
 *
 * 本工单（#16 tracer bullet）只实现最小面：连接生命周期观察 + setEffect（编码走
 * Codec、写走 BleLink 串行队列）+ 状态查询（GET_STATUS → STATUS 解析）。#17 在
 * 此之上扩展完整 UI 业务（亮度 / 限流 / 解锁 / 场景），接口保持可扩展：
 * - 状态订阅：`onStateChange`（转发 BleLink 状态机，供页面渲染连接态）。
 * - 设备事件：`hello` / `status` 属性 + `onStatus` 回调（#17 UI 可直接订阅）。
 *
 * 写结果语义（#4 决议第 4 节）：
 * - setEffect 帧 flags bit0=1 请求 ACK；收到同 seq ACK → resolve。
 * - 收到 NAK → 立即 reject（不自动重试，协议口径）。
 * - 500ms 无 ACK → reject TimeoutError（发送端超时，只发一次）。
 * - 写失败（如断连 10006）由 BleLink 先行 reject，等 ACK 的 Promise 随之 settle。
 *
 * 纯 TS：不引用任何 wx / Page / Component / getApp（CI check-purity 强制）。
 */

import type { BleLink, LinkState } from "./ble_link";
import { encode, feed, FRAME_TYPES, PROTOCOL_VERSION } from "./codec";
import type { Frame } from "./codec";
import { BleDomainError, InvalidStateError, TimeoutError } from "./errors";

/** 协议常量：ACK 等待超时（#4 决议第 4 节）。 */
export const ACK_TIMEOUT_MS = 500;

/** C3 未设置过的灯带在 STATUS 里的 active_effect 值（firmware EFFECT_ID_NONE）。 */
export const EFFECT_ID_NONE = 0xff;

/** RGB 颜色。 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 灯效参数（按 #4 决议第 3 节；effect 字段即 effect_id 的语义名）。 */
export type EffectParams =
  | { effect: "off" }
  | { effect: "static"; color: Rgb }
  | { effect: "breath"; color: Rgb; periodMs: number; min: number; max: number }
  | { effect: "gradient"; from: Rgb; to: Rgb; periodMs: number; direction: 0 | 1 }
  | { effect: "rainbow"; speed: number; saturation: number; direction: 0 | 1 }
  | { effect: "flow"; color: Rgb; speed: number; length: number; direction: 0 | 1 }
  | { effect: "twinkle"; color: Rgb; density: number; speed: number };

/** 灯效语义名 -> effect_id（#4 决议第 3 节）。 */
export const EFFECT_IDS: Readonly<Record<EffectParams["effect"], number>> = {
  off: 0x00,
  static: 0x01,
  breath: 0x02,
  gradient: 0x03,
  rainbow: 0x04,
  flow: 0x05,
  twinkle: 0x06,
};

/** 灯效参数编码错误（缺参数 / 越界 / 非法 direction），setEffect 在编码前抛。 */
export class EffectParamError extends BleDomainError {
  constructor(message: string) {
    super("EFFECT_PARAM", `灯效参数非法：${message}`);
  }
}

/** C3 回的 NAK（#4 决议第 4 节错误码表）。 */
export class ServiceNakError extends BleDomainError {
  readonly nakCode: number;

  constructor(nakCode: number, seq: number) {
    super("SERVICE_NAK", `C3 拒绝命令（NAK 0x${nakCode.toString(16).padStart(2, "0")}，seq=${seq}）`);
    this.nakCode = nakCode;
  }
}

/** HELLO payload（#4 决议第 2 节）。 */
export interface HelloInfo {
  protocolVersion: number;
  fwVersion: string;
  stripCount: number;
  ledsPerStrip: number;
  maxCurrentMa: number;
  powerLimitMa: number;
  thermalWarningC: number;
  thermalShutdownC: number;
  caps: number;
  /** 16 字节 effect_bitmap，覆盖 effect_id 0–127。 */
  effectBitmap: Uint8Array;
}

/** STATUS payload（#4 决议第 4 节，24 字节）。 */
export interface LightStatus {
  uptimeS: number;
  tempC: number;
  currentMaEst: number;
  /** 0 正常，1 警告，2 关闭输出。 */
  thermalStatus: number;
  glitchCount: number;
  dropCount: number;
  brightness: number;
  powerLimitMa: number;
  stripFault: number;
  /** 每路当前 effect_id；0xff 表示未设置。 */
  activeEffect: number[];
}

/** C3 支持某灯效（effect_bitmap 置位）。 */
export function supportsEffect(hello: HelloInfo, effectId: number): boolean {
  if (effectId < 0 || effectId > 127) return false;
  const byte = hello.effectBitmap[effectId >> 3];
  if (byte === undefined) return false;
  return (byte & (1 << (effectId & 7))) !== 0;
}

function assertByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new EffectParamError(`${name}=${value} 超出 0–255`);
  }
}

function assertU16(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new EffectParamError(`${name}=${value} 超出 0–65535`);
  }
}

function encodeColor(color: Rgb): number[] {
  assertByte(color.r, "color.r");
  assertByte(color.g, "color.g");
  assertByte(color.b, "color.b");
  return [color.r, color.g, color.b];
}

function encodeDirection(direction: 0 | 1, name: string): number {
  if (direction !== 0 && direction !== 1) {
    throw new EffectParamError(`${name}=${direction} 必须为 0 或 1`);
  }
  return direction;
}

/** EffectParams -> SET_EFFECT payload（effect_id + 效果参数）；参数非法抛 EffectParamError。 */
export function encodeEffectPayload(params: EffectParams): Uint8Array {
  const effectId = EFFECT_IDS[params.effect];
  switch (params.effect) {
    case "off":
      return new Uint8Array([effectId]);
    case "static":
      return new Uint8Array([effectId, ...encodeColor(toRgb(params.color, "color"))]);
    case "breath": {
      const color = toRgb(params.color, "color");
      assertU16(params.periodMs, "periodMs");
      assertByte(params.min, "min");
      assertByte(params.max, "max");
      return new Uint8Array([
        effectId,
        ...encodeColor(color),
        params.periodMs & 0xff,
        (params.periodMs >> 8) & 0xff,
        params.min,
        params.max,
      ]);
    }
    case "gradient": {
      const from = toRgb(params.from, "from");
      const to = toRgb(params.to, "to");
      assertU16(params.periodMs, "periodMs");
      // canonical 渐变参数长度 = 10（golden vectors / 固件）：9 个字段 + 末尾 1 保留字节。
      // direction 在 params[8]，params[9] 为保留位（固件忽略）。
      return new Uint8Array([
        effectId,
        ...encodeColor(from),
        ...encodeColor(to),
        params.periodMs & 0xff,
        (params.periodMs >> 8) & 0xff,
        encodeDirection(params.direction, "direction"),
        0x00,
      ]);
    }
    case "rainbow":
      assertByte(params.speed, "speed");
      assertByte(params.saturation, "saturation");
      return new Uint8Array([
        effectId,
        params.speed,
        params.saturation,
        encodeDirection(params.direction, "direction"),
      ]);
    case "flow": {
      const color = toRgb(params.color, "color");
      assertByte(params.speed, "speed");
      assertByte(params.length, "length");
      // canonical 流水参数长度 = 7（golden vectors / 固件 effect_param_lengths）：
      // R,G,B,speed,length,direction(6) + 末尾 1 保留字节（固件 render_chase 只读
      // params[0..5]，长度校验要求 1+7；缺保留字节会被 C3 NAK 0x04）。
      return new Uint8Array([
        effectId,
        ...encodeColor(color),
        params.speed,
        params.length,
        encodeDirection(params.direction, "direction"),
        0x00,
      ]);
    }
    case "twinkle": {
      const color = toRgb(params.color, "color");
      assertByte(params.density, "density");
      assertByte(params.speed, "speed");
      return new Uint8Array([effectId, ...encodeColor(color), params.density, params.speed]);
    }
  }
}

/** 取 RGB 字段；缺失 / 形状非法抛 EffectParamError（而非 TypeError）。 */
function toRgb(value: unknown, name: string): Rgb {
  if (typeof value !== "object" || value === null) {
    throw new EffectParamError(`缺少 ${name}`);
  }
  const rgb = value as Record<string, unknown>;
  const r = rgb.r;
  const g = rgb.g;
  const b = rgb.b;
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") {
    throw new EffectParamError(`${name} 必须含数值 r/g/b`);
  }
  return { r, g, b };
}

interface PendingWrite {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * 灯带业务层。生命周期：构造时挂 BleLink 状态 / 通知监听；页面持有单例，
 * 调 connect / setEffect / requestStatus，用 onStateChange / onStatus 订阅渲染数据。
 */
export class LightService {
  private readonly link: BleLink;
  private readonly ackTimeoutMs: number;
  private nextSeq = 0;
  private remainder: Uint8Array = new Uint8Array(0);
  /** 按 seq 索引的待决写（并发 setEffect 各自等自己的 ACK；写本身由 BleLink 串行）。 */
  private readonly pending = new Map<number, PendingWrite>();

  private readonly stateListeners = new Set<(state: LinkState) => void>();
  private readonly statusListeners = new Set<(status: LightStatus) => void>();
  private readonly helloListeners = new Set<(hello: HelloInfo) => void>();

  private helloValue: HelloInfo | undefined;
  private statusValue: LightStatus | undefined;
  private lastDeviceId: string | undefined;

  constructor(link: BleLink, options: { ackTimeoutMs?: number } = {}) {
    this.link = link;
    this.ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    link.onStateChange((state) => {
      for (const listener of this.stateListeners) listener(state);
    });
    link.onNotification((notification) => {
      this.onNotificationBytes(new Uint8Array(notification.value));
    });
  }

  /** 当前连接状态（BleLink 状态机镜像）。 */
  get state(): LinkState {
    return this.link.state;
  }

  /** 最近一次 HELLO（连接建立 + 订阅后由 C3 主动下发）。 */
  get hello(): HelloInfo | undefined {
    return this.helloValue;
  }

  /** 最近一次 STATUS 快照（周期 2s notify 或 requestStatus 刷新）。 */
  get status(): LightStatus | undefined {
    return this.statusValue;
  }

  /** 连接状态订阅（页面渲染连接中 / ready / fault 用）。 */
  onStateChange(listener: (state: LinkState) => void): void {
    this.stateListeners.add(listener);
  }

  /** STATUS 订阅（#17 UI 跟随 C3 状态用）。 */
  onStatus(listener: (status: LightStatus) => void): void {
    this.statusListeners.add(listener);
  }

  /** HELLO 订阅（连接建立 + 订阅后由 C3 主动下发，供页面显示固件版本 / 能力）。 */
  onHello(listener: (hello: HelloInfo) => void): void {
    this.helloListeners.add(listener);
  }

  /** 扫描（BleLink 去重收集，超时停止）；记下首个设备供 connect() 省略参数时使用。 */
  async scan(
    options: { timeoutMs?: number; services?: string[] } = {},
  ): Promise<{ deviceId: string; name?: string; rssi?: number }[]> {
    const devices = await this.link.scan(options);
    const first = devices[0];
    if (first !== undefined) this.lastDeviceId = first.deviceId;
    return devices.map((device) => ({
      deviceId: device.deviceId,
      ...(device.name === undefined ? {} : { name: device.name }),
      ...(device.RSSI === undefined ? {} : { rssi: device.RSSI }),
    }));
  }

  /**
   * 连接 + 发现 + 订阅；成功后 state 为 ready。
   * deviceId 省略时用上次 scan 的第一个设备（页面单设备场景）。
   */
  async connect(deviceId?: string): Promise<void> {
    const target = deviceId ?? this.lastDeviceId;
    if (target === undefined) throw new InvalidStateError("connect 需要 deviceId（先扫描）");
    this.helloValue = undefined;
    this.statusValue = undefined;
    await this.link.connect(target);
  }

  /** 主动断开（屏蔽自动重连）。 */
  async disconnect(): Promise<void> {
    this.settlePending(new InvalidStateError("连接已断开"));
    await this.link.disconnect();
  }

  /** 页面 onHide：暂停扫描 / 自动重连（重连风暴防护），ready 连接保留不主动断开。 */
  onHide(): void {
    this.link.onHide();
  }

  /** 页面 onShow：恢复挂起的重连 / 校验连接（挂起期间可能被系统回收）。 */
  async onShow(): Promise<void> {
    await this.link.onShow();
  }

  /**
   * 设置灯效：编码 SET_EFFECT（flags bit0=1 请求 ACK）→ BleLink 串行写 → 等 ACK。
   * stripMask 选择灯带（0xFF = 全部）。ACK 超时 / NAK / 写失败均 reject。
   */
  async setEffect(stripMask: number, params: EffectParams): Promise<void> {
    assertByte(stripMask, "stripMask");
    const payload = encodeEffectPayload(params);
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) & 0xffff;
    const frame = encode({
      version: PROTOCOL_VERSION,
      seq,
      type: FRAME_TYPES.setEffect,
      flags: 0x01,
      stripMask,
      payload,
    });
    await this.writeAndWaitAck(frame, seq);
  }

  /**
   * 查询状态：GET_STATUS → 等 C3 回 STATUS；返回解析后的快照。
   * 先挂 STATUS 等待再写：C3 可能在 write 完成后极快回 STATUS（同步设备模型 / 真机
   * 低延迟），等待者必须先就位，否则会丢帧。写失败则清理等待者并抛出原始错误。
   */
  async requestStatus(): Promise<LightStatus> {
    if (this.link.state !== "ready") {
      throw new InvalidStateError(`当前状态 ${this.link.state} 不可查询状态`);
    }
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) & 0xffff;
    const frame = encode({
      version: PROTOCOL_VERSION,
      seq,
      type: FRAME_TYPES.getStatus,
      flags: 0,
      stripMask: 0,
      payload: new Uint8Array(0),
    });
    const statusPromise = new Promise<LightStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusWaiter = undefined;
        reject(new TimeoutError("STATUS", this.ackTimeoutMs));
      }, this.ackTimeoutMs);
      this.statusWaiter = { resolve, reject, timer };
    });
    try {
      await this.link.write(frame);
    } catch (error) {
      const waiter = this.statusWaiter;
      this.statusWaiter = undefined;
      if (waiter?.timer !== undefined) clearTimeout(waiter.timer);
      waiter?.reject(error);
      await statusPromise.catch(() => undefined);
      throw error;
    }
    return statusPromise;
  }

  /**
   * 设置全局亮度（SET_BRIGHTNESS，#4 §2）：payload = brightness(1)，strip_mask 必须 0xFF。
   * flags bit0=1 请求 ACK。超 50%（>127）且未解锁时 C3 回 NAK 0x06，此处原样 reject
   * ServiceNakError(nakCode=0x06)，由上层（页面 / business_service）决定提示。
   */
  async setBrightness(brightness: number): Promise<void> {
    assertByte(brightness, "brightness");
    await this.sendGlobalCommand(FRAME_TYPES.setBrightness, new Uint8Array([brightness]));
  }

  /**
   * 设置全局限流（SET_POWER_LIMIT，#4 §2）：payload = power_limit_ma(2) 小端，
   * strip_mask 必须 0xFF。超过 15000mA 且未解锁时 C3 回 NAK 0x06；超过 30000mA（硬件
   * 上限）回 NAK 0x05。原样 reject ServiceNakError。
   */
  async setPowerLimit(powerLimitMa: number): Promise<void> {
    assertU16(powerLimitMa, "powerLimitMa");
    const payload = new Uint8Array([powerLimitMa & 0xff, (powerLimitMa >> 8) & 0xff]);
    await this.sendGlobalCommand(FRAME_TYPES.setPowerLimit, payload);
  }

  /**
   * 满功率解锁（UNLOCK_FULL_POWER，#4 §2/§4）：payload = unlock(1) 0/1，strip_mask 必须 0xFF。
   * =1 解锁（不持久化，C3 重启后回落受限）；=0 立即夹回 50% / 15000mA。
   */
  async unlockFullPower(unlock: boolean): Promise<void> {
    await this.sendGlobalCommand(FRAME_TYPES.unlockFullPower, new Uint8Array([unlock ? 1 : 0]));
  }

  /** 全局命令（SET_BRIGHTNESS / SET_POWER_LIMIT / UNLOCK）统一编码：strip_mask 固定 0xFF、flags bit0=1。 */
  private async sendGlobalCommand(type: number, payload: Uint8Array): Promise<void> {
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) & 0xffff;
    const frame = encode({
      version: PROTOCOL_VERSION,
      seq,
      type,
      flags: 0x01,
      stripMask: 0xff,
      payload,
    });
    await this.writeAndWaitAck(frame, seq);
  }

  private statusWaiter: { resolve: (status: LightStatus) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> | undefined } | undefined;

  private async writeAndWaitAck(frame: Uint8Array, seq: number): Promise<void> {
    // 先挂 ACK 等待再写：C3 可能在 write 完成后极快回 ACK，pending 必须先就位。
    const waiter: PendingWrite = { resolve: () => undefined, reject: () => undefined, timer: undefined };
    const ackPromise = new Promise<void>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new TimeoutError("ACK", this.ackTimeoutMs));
      }, this.ackTimeoutMs);
      this.pending.set(seq, waiter);
    });
    try {
      await this.link.write(frame);
    } catch (error) {
      // 写失败：清理 pending，消费 ackPromise 避免悬挂 unhandled，再抛出原始错误。
      this.pending.delete(seq);
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
      await ackPromise.catch(() => undefined);
      throw error;
    }
    return ackPromise;
  }

  /** 通知字节流入口：粘包 / 半帧重组 -> 帧 / 错误分发（Codec.feed 纯函数，状态是 remainder）。 */
  private onNotificationBytes(bytes: Uint8Array): void {
    const combined = new Uint8Array(this.remainder.length + bytes.length);
    combined.set(this.remainder, 0);
    combined.set(bytes, this.remainder.length);
    const result = feed(combined);
    this.remainder = result.remainder;
    for (const frame of result.frames) this.onFrame(frame);
  };

  private onFrame(frame: Frame): void {
    switch (frame.type) {
      case FRAME_TYPES.hello: {
        const hello = parseHello(frame.payload);
        if (hello === undefined) return;
        this.helloValue = hello;
        for (const listener of this.helloListeners) listener(hello);
        return;
      }
      case FRAME_TYPES.status: {
        const status = parseStatus(frame.payload);
        if (status !== undefined) this.publishStatus(status);
        return;
      }
      case FRAME_TYPES.ack: {
        const waiter = this.pending.get(frame.seq);
        if (waiter === undefined) return;
        this.pending.delete(frame.seq);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.resolve();
        return;
      }
      case FRAME_TYPES.nak: {
        if (frame.payload.length < 3) return;
        const nakSeq = frame.payload[0]! | (frame.payload[1]! << 8);
        const waiter = this.pending.get(nakSeq);
        if (waiter === undefined) return;
        this.pending.delete(nakSeq);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.reject(new ServiceNakError(frame.payload[2]!, nakSeq));
        return;
      }
      default:
        return;
    }
  }

  private publishStatus(status: LightStatus): void {
    this.statusValue = status;
    const waiter = this.statusWaiter;
    if (waiter !== undefined) {
      this.statusWaiter = undefined;
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(status);
    }
    for (const listener of this.statusListeners) listener(status);
  }

  /** 待决写 / 等待者统一收敛（主动断开时用）。 */
  private settlePending(error: unknown): void {
    for (const waiter of this.pending.values()) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    const waiter = this.statusWaiter;
    this.statusWaiter = undefined;
    if (waiter?.timer !== undefined) clearTimeout(waiter.timer);
    waiter?.reject(error);
  }
}

/** HELLO payload（23 字节）解析（#4 决议第 2 节）；长度不符返回 undefined。 */
export function parseHello(payload: Uint8Array): HelloInfo | undefined {
  // 固件 gatt_build_hello 产出 23 字节（effect_bitmap[10]，覆盖 0x00–0x79）；
  // 协议决议写的是 effect_bitmap[16]（总 29 字节）。两者都接受，按各自长度截 bitmap。
  if (payload.length !== 23 && payload.length !== 29) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const bitmapLen = payload.length - 13;
  const effectBitmap = new Uint8Array(16);
  effectBitmap.set(payload.slice(13, 13 + bitmapLen));
  return {
    protocolVersion: payload[0]!,
    fwVersion: `${payload[1]!}.${payload[2]!}.${payload[3]!}`,
    stripCount: payload[4]!,
    ledsPerStrip: payload[5]!,
    maxCurrentMa: view.getUint16(6, true),
    powerLimitMa: view.getUint16(8, true),
    thermalWarningC: payload[10]!,
    thermalShutdownC: payload[11]!,
    caps: payload[12]!,
    effectBitmap,
  };
}

/** STATUS payload（24 字节）解析（#4 决议第 4 节）；长度不符返回 undefined。 */
export function parseStatus(payload: Uint8Array): LightStatus | undefined {
  if (payload.length !== 24) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    uptimeS: view.getUint32(0, true),
    tempC: view.getInt8(4),
    currentMaEst: view.getUint16(5, true),
    thermalStatus: payload[7]!,
    glitchCount: view.getUint16(8, true),
    dropCount: view.getUint16(10, true),
    brightness: payload[12]!,
    powerLimitMa: view.getUint16(13, true),
    stripFault: payload[15]!,
    activeEffect: Array.from(payload.slice(16, 24)),
  };
}