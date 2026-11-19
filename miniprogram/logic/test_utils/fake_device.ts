/**
 * FakeLightDevice：Node 单测里的 C3 行为模型（spec §3.1 / §3.6「FakeTransport 设备模型」）。
 *
 * 挂在 FakeTransport 的 onWrite 钩子上，按协议 v1（#4 决议）对客户端写帧作出与真实固件
 * 一致的响应：SET_EFFECT / SET_BRIGHTNESS / SET_POWER_LIMIT / UNLOCK_FULL_POWER → ACK，
 * 受限态超限 → NAK 0x06，未知灯效 → NAK 0x03，长度不符 → NAK 0x04，非法参数 → NAK 0x05；
 * GET_STATUS → STATUS。设备状态（亮度 / 限流 / 解锁 / 每路灯效）可在用例中断言。
 *
 * 目的：
 * - 让业务层单测对着"会 NAK 的真设备"跑，而不是手工喂 ACK（断言 NAK 0x06 等真实路径）。
 * - 作为 #19（wxa-runner）wx-ble mock 的同源设备模型，不出现第二套假蓝牙。
 *
 * 纯内存实现，不引用任何 wx / Page / Component / getApp（check-purity 覆盖本文件）。
 */

import { encode, feed, FRAME_TYPES, effectParamLength, NAK } from "../codec";
import type { Frame } from "../codec";
import { FakeTransport, bytesToHex } from "./fake_transport";
import type { BleDeviceInfo } from "../transport";

/** 受限态阈值（与固件 gatt.h 对齐）。 */
export const BRIGHTNESS_LIMIT = 127;
export const POWER_LIMIT_MA = 15000;
export const POWER_LIMIT_MAX_MA = 30000;

/** 固件默认 HELLO 的 effect_bitmap 首字节：0x00–0x06 受支持（C3 bitmap=0x7F）。 */
const DEFAULT_EFFECT_BITMAP_BYTE0 = 0x7f;

export interface FakeLightDeviceOptions {
  deviceId?: string;
  /** 固件版本号（HELLO 广播）。 */
  fwVersion?: [number, number, number];
  stripCount?: number;
  ledsPerStrip?: number;
  maxCurrentMa?: number;
  /** 启动限流（受限态，默认 15000）。 */
  powerLimitMa?: number;
  /** 启动亮度（固件默认 128）。 */
  brightness?: number;
  /** HELLO effect_bitmap[10] 首字节（默认 0x7f，覆盖 effect_id 0–6）。 */
  effectBitmapByte0?: number;
  /** 初始解锁态（默认 false；真实固件启动恒受限，仅供用例构造特殊场景）。 */
  unlocked?: boolean;
}

/** 29 字节 HELLO payload（与固件 gatt_build_hello 对齐，effect_bitmap[16]，#4 第 2 节）。 */
export function buildHelloPayload(options: FakeLightDeviceOptions = {}): Uint8Array {
  const fw = options.fwVersion ?? [0, 1, 0];
  const stripCount = options.stripCount ?? 8;
  const ledsPerStrip = options.ledsPerStrip ?? 60;
  const maxCurrentMa = options.maxCurrentMa ?? 30000;
  const powerLimitMa = options.powerLimitMa ?? POWER_LIMIT_MA;
  const bitmap0 = options.effectBitmapByte0 ?? DEFAULT_EFFECT_BITMAP_BYTE0;
  const payload = new Uint8Array(29);
  payload[0] = 1; // protocol_ver
  payload[1] = fw[0];
  payload[2] = fw[1];
  payload[3] = fw[2];
  payload[4] = stripCount;
  payload[5] = ledsPerStrip;
  payload[6] = maxCurrentMa & 0xff;
  payload[7] = (maxCurrentMa >> 8) & 0xff;
  payload[8] = powerLimitMa & 0xff;
  payload[9] = (powerLimitMa >> 8) & 0xff;
  payload[10] = 70; // thermal_warning_c
  payload[11] = 85; // thermal_shutdown_c
  payload[12] = 0x07; // caps: bit0 解锁 / bit1 场景 / bit2 bitmap 有效
  payload[13] = bitmap0; // effect_bitmap[0]（覆盖 effect_id 0–7）
  // effect_bitmap[1..15] 保持 0（覆盖 effect_id 8–127，当前固件只需 byte0）。
  return payload;
}

/** 24 字节 STATUS payload（与固件 gatt_build_status 对齐）。 */
export function buildStatusPayload(state: {
  uptimeS: number;
  tempC: number;
  currentMaEst: number;
  thermalStatus: number;
  glitchCount: number;
  dropCount: number;
  brightness: number;
  powerLimitMa: number;
  stripFault: number;
  activeEffect: number[];
}): Uint8Array {
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  view.setUint32(0, state.uptimeS >>> 0, true);
  payload[4] = state.tempC & 0xff;
  view.setUint16(5, state.currentMaEst & 0xffff, true);
  payload[7] = state.thermalStatus & 0xff;
  view.setUint16(8, state.glitchCount & 0xffff, true);
  view.setUint16(10, state.dropCount & 0xffff, true);
  payload[12] = state.brightness & 0xff;
  view.setUint16(13, state.powerLimitMa & 0xffff, true);
  payload[15] = state.stripFault & 0xff;
  for (let i = 0; i < 8; i += 1) payload[16 + i] = state.activeEffect[i] ?? 0xff;
  return payload;
}

export class FakeLightDevice {
  private readonly transport: FakeTransport;
  private readonly deviceId: string;
  private readonly stripCount: number;
  private readonly maxCurrentMa: number;
  private remainder: Uint8Array = new Uint8Array(0);
  private txSeq = 0;

  /** 设备状态（用例可断言）。 */
  brightness: number;
  powerLimitMa: number;
  unlocked: boolean;
  readonly activeEffect: number[];

  constructor(transport: FakeTransport, options: FakeLightDeviceOptions = {}) {
    this.transport = transport;
    this.deviceId = options.deviceId ?? "C3-A1";
    this.stripCount = options.stripCount ?? 8;
    this.maxCurrentMa = options.maxCurrentMa ?? 30000;
    this.brightness = options.brightness ?? 128;
    this.powerLimitMa = options.powerLimitMa ?? POWER_LIMIT_MA;
    this.unlocked = options.unlocked ?? false;
    this.activeEffect = new Array<number>(this.stripCount).fill(0xff);

    // HELLO 在订阅（setNotification(true)）后由 C3 主动下发；FakeTransport 会在每次
    // setNotification(true) 时重推 notifyFrames，正好覆盖重连后重新发 HELLO。
    // 用 this.txSeq++ 消费一个序号：C3 的 HELLO/ACK/NAK/STATUS 用独立 tx seq，
    // 帧头 seq 与客户端 seq 解耦（#4 口径，LightService 按 payload ack_seq 关联）。
    this.transport.setNotifyFrames([
      bytesToHex(
        encode({
          version: 1,
          seq: this.txSeq++,
          type: FRAME_TYPES.hello,
          flags: 0,
          stripMask: 0,
          payload: buildHelloPayload(options),
        }),
      ),
    ]);
  }

  /** 当前 HELLO 里广播的灯路数（供用例断言）。 */
  get ledCount(): number {
    return this.stripCount;
  }

  /** 供用例断言 / 触发的只读设备信息快照。 */
  deviceInfo(): BleDeviceInfo {
    return { deviceId: this.deviceId, name: "BLELight-C3", RSSI: -50 };
  }

  /**
   * 模拟断电重启（#4 §4）：恢复保存的 scene，但先限 50%（亮度
   * min(saved,127)）/ 15000mA（限流 min(saved,15000)）；解锁态不恢复。
   * 灯效作为保存的 scene 恢复、继续跑（与固件 nvs_store 恢复口径一致）。
   */
  reboot(): void {
    this.brightness = Math.min(this.brightness, BRIGHTNESS_LIMIT);
    this.powerLimitMa = Math.min(this.powerLimitMa, POWER_LIMIT_MA);
    this.unlocked = false;
  }

  /** 主动推一条 STATUS（模拟周期 notify 或 GET_STATUS 响应）。 */
  emitStatus(uptimeS = 0): void {
    const payload = buildStatusPayload({
      uptimeS,
      tempC: 30,
      currentMaEst: this.estimateCurrent(),
      thermalStatus: 0,
      glitchCount: 0,
      dropCount: 0,
      brightness: this.brightness,
      powerLimitMa: this.powerLimitMa,
      stripFault: 0,
      activeEffect: this.activeEffect,
    });
    this.transport.emitNotification(
      bytesToHex(
        encode({ version: 1, seq: this.txSeq++, type: FRAME_TYPES.status, flags: 0, stripMask: 0, payload }),
      ),
    );
  }

  /** FakeTransport onWrite 钩子入口：累积分片 -> feed -> 逐帧处理（与 LightService 同款重组）。 */
  onWrite(bytes: Uint8Array): void {
    const combined = new Uint8Array(this.remainder.length + bytes.length);
    combined.set(this.remainder, 0);
    combined.set(bytes, this.remainder.length);
    const result = feed(combined);
    this.remainder = result.remainder;
    for (const frame of result.frames) this.handleFrame(frame);
  }

  private handleFrame(frame: Frame): void {
    switch (frame.type) {
      case FRAME_TYPES.setEffect:
        this.handleSetEffect(frame);
        return;
      case FRAME_TYPES.setBrightness:
        this.handleSetBrightness(frame);
        return;
      case FRAME_TYPES.setPowerLimit:
        this.handleSetPowerLimit(frame);
        return;
      case FRAME_TYPES.unlockFullPower:
        this.handleUnlock(frame);
        return;
      case FRAME_TYPES.getStatus:
        this.emitStatus(this.uptime());
        return;
      default:
        return;
    }
  }

  private handleSetEffect(frame: Frame): void {
    if (frame.payload.length < 1) {
      this.sendNak(frame.seq, NAK.lengthMismatch);
      return;
    }
    const effectId = frame.payload[0]!;
    const expected = effectParamLength(effectId);
    if (expected === null) {
      this.sendNak(frame.seq, NAK.unknownEffect);
      return;
    }
    if (frame.payload.length < 1 + expected) {
      this.sendNak(frame.seq, NAK.lengthMismatch);
      return;
    }
    for (let lane = 0; lane < this.stripCount; lane += 1) {
      if ((frame.stripMask & (1 << lane)) !== 0) this.activeEffect[lane] = effectId;
    }
    this.sendAck(frame.seq);
  }

  private handleSetBrightness(frame: Frame): void {
    if (frame.payload.length < 1) {
      this.sendNak(frame.seq, NAK.lengthMismatch);
      return;
    }
    if (frame.stripMask !== 0xff) {
      this.sendNak(frame.seq, NAK.invalidParam);
      return;
    }
    const value = frame.payload[0]!;
    if (!this.unlocked && value > BRIGHTNESS_LIMIT) {
      this.sendNak(frame.seq, NAK.notUnlocked);
      return;
    }
    this.brightness = value;
    this.sendAck(frame.seq);
  }

  private handleSetPowerLimit(frame: Frame): void {
    if (frame.payload.length < 2) {
      this.sendNak(frame.seq, NAK.lengthMismatch);
      return;
    }
    if (frame.stripMask !== 0xff) {
      this.sendNak(frame.seq, NAK.invalidParam);
      return;
    }
    const limit = frame.payload[0]! | (frame.payload[1]! << 8);
    if (limit > POWER_LIMIT_MAX_MA) {
      this.sendNak(frame.seq, NAK.invalidParam);
      return;
    }
    if (!this.unlocked && limit > POWER_LIMIT_MA) {
      this.sendNak(frame.seq, NAK.notUnlocked);
      return;
    }
    this.powerLimitMa = limit;
    this.sendAck(frame.seq);
  }

  private handleUnlock(frame: Frame): void {
    if (frame.payload.length < 1 || frame.payload[0]! > 1 || frame.stripMask !== 0xff) {
      this.sendNak(frame.seq, NAK.invalidParam);
      return;
    }
    this.unlocked = frame.payload[0] === 1;
    if (!this.unlocked) {
      // =0 立即夹回受限：亮度 50%（127）/ 限流 15000。
      if (this.brightness > BRIGHTNESS_LIMIT) this.brightness = BRIGHTNESS_LIMIT;
      this.powerLimitMa = POWER_LIMIT_MA;
    }
    this.sendAck(frame.seq);
  }

  private estimateCurrent(): number {
    // 粗略估算：每颗 20mA × 亮度比例 × 灯数（仅用于 STATUS 字段，用例不严格断言）。
    const perLed = (this.brightness / 255) * 20;
    return Math.round(perLed * this.ledCount * this.stripCount);
  }

  private uptime(): number {
    return Math.floor(Date.now() / 1000);
  }

  private sendAck(seq: number): void {
    const payload = new Uint8Array([seq & 0xff, (seq >> 8) & 0xff]);
    this.transport.emitNotification(
      bytesToHex(
        encode({ version: 1, seq: this.txSeq++, type: FRAME_TYPES.ack, flags: 0, stripMask: 0, payload }),
      ),
    );
  }

  private sendNak(seq: number, error: number): void {
    const payload = new Uint8Array([seq & 0xff, (seq >> 8) & 0xff, error]);
    this.transport.emitNotification(
      bytesToHex(
        encode({ version: 1, seq: this.txSeq++, type: FRAME_TYPES.nak, flags: 0, stripMask: 0, payload }),
      ),
    );
  }
}