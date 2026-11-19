/**
 * LightBusinessService：页面级"厚业务层"（工单 #17，GLOSSARY / spec §1.1 四层单向依赖
 * 的最上层之上）。在 LightService（协议业务）之上叠加页面直接需要的治理能力：
 *
 * - 满功率解锁的**页面级**状态（fullPowerUnlocked）：不持久化到 NVS，连接 / 重连后回落
 *   受限态（#4 §4「满功率解锁不持久化」）。
 * - strip_mask 单路 / 多路选择：8 路布尔 <-> 掩码字节的互转与校验。
 * - 亮度 / 限流的受限门禁提示：超限且锁定时 C3 回 NAK 0x06，这里归一成
 *   NeedsUnlockError（携带 nakCode），页面据此弹"需满功率解锁"。
 * - supportsEffect：按 HELLO effect_bitmap 判断灯效可用性（C3 bitmap=0x7F 覆盖 0–6）。
 *
 * 写策略 / 连接编排 / 编解码语义全部复用 LightService → BleLink → Codec，本层不重复。
 * 纯 TS：不引用任何 wx / Page / Component / getApp（CI check-purity 强制）。
 */

import type { LinkState } from "./ble_link";
import { NAK } from "./codec";
import {
  BRIGHTNESS_LIMIT,
  POWER_LIMIT_MA,
  POWER_LIMIT_MAX_MA,
  STRIP_COUNT,
  STRIP_MASK_ALL,
} from "./constants";
import { BleDomainError, InvalidStateError } from "./errors";
import { LightService, supportsEffect } from "./light_service";
import type { EffectParams, HelloInfo, LightStatus } from "./light_service";

/** 灯路数（strip_mask 8 位）。 */
export { STRIP_COUNT, STRIP_MASK_ALL };

/**
 * 受限态超限（C3 NAK 0x06 未解锁）：页面据此弹"需满功率解锁"。
 * 由 ServiceNakError(nakCode=0x06) 归一而来，原始错误保留在 cause。
 */
export class NeedsUnlockError extends BleDomainError {
  readonly nakCode = NAK.notUnlocked;

  constructor(message = "需满功率解锁后才能设置该亮度 / 限流", options?: { cause?: unknown }) {
    super("NEEDS_UNLOCK", message, options);
  }
}

/** 8 路布尔选择 -> strip_mask 字节（第 i 位对应 L{i}）。 */
export function stripMaskFromStrips(strips: readonly boolean[]): number {
  if (strips.length !== STRIP_COUNT) {
    throw new InvalidStateError(`灯带选择必须 ${STRIP_COUNT} 路，收到 ${strips.length}`);
  }
  let mask = 0;
  for (let i = 0; i < STRIP_COUNT; i += 1) if (strips[i]) mask |= 1 << i;
  return mask;
}

/** strip_mask 字节 -> 8 路布尔选择（第 i 位对应 L{i}）。 */
export function stripsFromStripMask(mask: number): boolean[] {
  const strips: boolean[] = [];
  for (let i = 0; i < STRIP_COUNT; i += 1) strips.push((mask & (1 << i)) !== 0);
  return strips;
}

/** 判断错误是否为"未解锁"（NAK 0x06）：ServiceNakError 或已归一的 NeedsUnlockError。 */
export function isNotUnlocked(error: unknown): error is NeedsUnlockError | { nakCode: number } {
  if (error instanceof NeedsUnlockError) return true;
  if (typeof error === "object" && error !== null) {
    const nakCode = (error as { nakCode?: unknown }).nakCode;
    return nakCode === NAK.notUnlocked;
  }
  return false;
}

export class LightBusinessService {
  private readonly light: LightService;
  private unlocked = false;

  constructor(light: LightService) {
    this.light = light;
    // 满功率解锁不持久化：每次进入 connecting（初次连接 / 自动重连都经过）即回落受限态。
    light.onStateChange((state) => {
      if (state === "connecting" || state === "idle") this.unlocked = false;
    });
  }

  /** 底层协议业务层（页面一般不直接用；测试 / 高级场景可透传）。 */
  get raw(): LightService {
    return this.light;
  }

  get state(): LinkState {
    return this.light.state;
  }

  get status(): LightStatus | undefined {
    return this.light.status;
  }

  get hello(): HelloInfo | undefined {
    return this.light.hello;
  }

  /** 页面级满功率解锁态（不持久化；连接 / 重连后回落 false）。 */
  get fullPowerUnlocked(): boolean {
    return this.unlocked;
  }

  onStateChange(listener: (state: LinkState) => void): void {
    this.light.onStateChange(listener);
  }

  onStatus(listener: (status: LightStatus) => void): void {
    this.light.onStatus(listener);
  }

  onHello(listener: (hello: HelloInfo) => void): void {
    this.light.onHello(listener);
  }

  /** C3 是否支持该灯效（按 HELLO effect_bitmap）；无 HELLO 时返回 false。 */
  supportsEffect(effectId: number): boolean {
    const hello = this.light.hello;
    return hello === undefined ? false : supportsEffect(hello, effectId);
  }

  async scan(
    options: { timeoutMs?: number; services?: string[] } = {},
  ): Promise<{ deviceId: string; name?: string; rssi?: number }[]> {
    return this.light.scan(options);
  }

  async connect(deviceId?: string): Promise<void> {
    this.unlocked = false;
    await this.light.connect(deviceId);
  }

  async disconnect(): Promise<void> {
    this.unlocked = false;
    await this.light.disconnect();
  }

  onHide(): void {
    this.light.onHide();
  }

  async onShow(): Promise<void> {
    await this.light.onShow();
  }

  /** 设置灯效（stripMask 选路，0xFF = 全路）。 */
  async setEffect(stripMask: number, params: EffectParams): Promise<void> {
    await this.light.setEffect(stripMask, params);
  }

  /**
   * 设置全局亮度（0–255）。超 127 且未解锁时 C3 回 NAK 0x06，归一为 NeedsUnlockError。
   * 值域非法抛 InvalidStateError（不发送）。
   */
  async setBrightness(value: number): Promise<void> {
    this.assertBrightness(value);
    await this.guardUnlock(() => this.light.setBrightness(value));
  }

  /**
   * 设置全局限流（mA）。超 15000 且未解锁 → NeedsUnlockError；超 30000 → InvalidStateError。
   */
  async setPowerLimit(ma: number): Promise<void> {
    if (!Number.isInteger(ma) || ma < 0 || ma > 0xffff) {
      throw new InvalidStateError(`限流 ${ma} 超出 0–65535mA`);
    }
    if (ma > POWER_LIMIT_MAX_MA) {
      throw new InvalidStateError(`限流 ${ma}mA 超过硬件上限 ${POWER_LIMIT_MAX_MA}mA`);
    }
    await this.guardUnlock(() => this.light.setPowerLimit(ma));
  }

  /**
   * 满功率解锁开 / 关。成功（C3 ACK）后更新页面级 unlocked 状态。
   * =false 时 C3 立即夹回 50% / 15000mA。
   */
  async unlockFullPower(unlock: boolean): Promise<void> {
    await this.light.unlockFullPower(unlock);
    this.unlocked = unlock;
  }

  /** GET_STATUS 主动查询（返回最新快照）。 */
  async requestStatus(): Promise<LightStatus> {
    return this.light.requestStatus();
  }

  private assertBrightness(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new InvalidStateError(`亮度 ${value} 超出 0–255`);
    }
  }

  /** 捕获 C3 的 NAK 0x06，归一为 NeedsUnlockError；其余错误原样上抛。 */
  private async guardUnlock(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (isNotUnlocked(error)) throw new NeedsUnlockError(undefined, { cause: error });
      throw error;
    }
  }
}