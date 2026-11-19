/**
 * 首页（完整控制 UI，工单 #17）：扫描 → 连接 → 7 种灯效 × 单/多 strip_mask 控制 ×
 * 亮度 / 限流 / 满功率解锁 × STATUS 实时显示 × 后台恢复。
 *
 * 页面层可自由用 wx / Page（spec §1.1：check-purity 只管 logic/**）。页面只做 UI 编排，
 * 所有协议 / 连接 / 门禁逻辑在 LightBusinessService → LightService → BleLink → WxTransport
 * 链路里，页面不重复任何协议 / 连接细节。真机前提：安卓蓝牙开启、C3 上电、开发者工具真机调试扫码。
 */

import { BleLink } from "../../logic/ble_link";
import { LightBusinessService, NeedsUnlockError, isNotUnlocked } from "../../logic/business_service";
import { EFFECT_IDS, LightService } from "../../logic/light_service";
import type { EffectParams, HelloInfo, LightStatus, Rgb } from "../../logic/light_service";
import type { LinkState } from "../../logic/ble_link";
import { WxTransport } from "../../transport/wx_transport";

/** BLELight-C3 的 Service / 特征值（#14 GATT 布局）：显式锁定，不依赖自动挑选。 */
const SERVICE_ID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const CMD_CHAR_ID = "0000ffe1-0000-1000-8000-00805f9b34fb";
const RSP_CHAR_ID = "0000ffe2-0000-1000-8000-00805f9b34fb";

/** 扫描过滤：只扫 C3 的服务（广播里带 0xFFE0），减少噪声。 */
const SCAN_SERVICE = "0000FFE0-0000-1000-8000-00805F9B34FB";

interface DeviceRow {
  deviceId: string;
  name: string;
  rssi: number;
}

interface EffectRow {
  key: EffectParams["effect"];
  name: string;
  needsColor: boolean;
  needsColor2: boolean;
  /** 主参数滑条标签（null = 该效果无主参数）。 */
  paramLabel: string | null;
}

/** slider change 事件的最小形状（detail.value）。 */
interface SliderEvent {
  detail: { value: number };
}

/** switch change 事件的最小形状（detail.value）。 */
interface SwitchEvent {
  detail: { value: boolean };
}

const EFFECTS: EffectRow[] = [
  { key: "off", name: "关灯", needsColor: false, needsColor2: false, paramLabel: null },
  { key: "static", name: "静态", needsColor: true, needsColor2: false, paramLabel: null },
  { key: "breath", name: "呼吸", needsColor: true, needsColor2: false, paramLabel: "周期(ms)" },
  { key: "gradient", name: "渐变", needsColor: true, needsColor2: true, paramLabel: "周期(ms)" },
  { key: "rainbow", name: "彩虹", needsColor: false, needsColor2: false, paramLabel: "速度" },
  { key: "flow", name: "流水", needsColor: true, needsColor2: false, paramLabel: "长度" },
  { key: "twinkle", name: "星闪", needsColor: true, needsColor2: false, paramLabel: "密度" },
];

/** BleLink 状态 -> 中文提示。 */
const STATE_TEXT: Record<LinkState, string> = {
  idle: "未连接",
  scanning: "扫描中…",
  connecting: "连接中…",
  discovering: "发现服务…",
  subscribing: "订阅…",
  ready: "已就绪",
  fault: "故障",
  reconnecting: "重连中…",
  suspended: "已挂起",
};

interface StatusRow {
  uptime: string;
  temp: string;
  current: string;
  thermal: string;
  brightness: string;
  powerLimit: string;
  glitch: string;
  drop: string;
  stripFault: string;
  active: string;
}

interface PageData {
  devices: DeviceRow[];
  scanning: boolean;
  state: LinkState;
  stateText: string;
  /** 是否处于断连重连（断连双路径①的体现）。 */
  reconnecting: boolean;
  deviceName: string;
  connected: boolean;

  effects: EffectRow[];
  selectedEffect: number;
  effectName: string;
  selectedNeedsColor: boolean;
  selectedNeedsColor2: boolean;
  effectParamLabel: string;
  effectParam: number;

  lanes: boolean[];
  mask: number;
  maskText: string;
  allLanesSelected: boolean;

  colorR: number;
  colorG: number;
  colorB: number;
  color2R: number;
  color2G: number;
  color2B: number;

  brightness: number;
  powerLimit: number;
  fullPowerUnlocked: boolean;
  applying: boolean;

  helloText: string;
  status: StatusRow | null;
  log: string[];
}

interface PageCustom {
  service: LightBusinessService | undefined;
  logBuffer: string[];
  onScan(): void;
  onSelectDevice(event: WechatMiniprogram.TouchEvent): void;
  onDisconnect(): void;
  onSelectEffect(event: WechatMiniprogram.TouchEvent): void;
  onToggleLane(event: WechatMiniprogram.TouchEvent): void;
  onSelectAllLanes(event: WechatMiniprogram.TouchEvent): void;
  onColorR(event: SliderEvent): void;
  onColorG(event: SliderEvent): void;
  onColorB(event: SliderEvent): void;
  onColor2R(event: SliderEvent): void;
  onColor2G(event: SliderEvent): void;
  onColor2B(event: SliderEvent): void;
  onEffectParam(event: SliderEvent): void;
  onBrightness(event: SliderEvent): void;
  onPowerLimit(event: SliderEvent): void;
  onToggleUnlock(event: SwitchEvent): void;
  onApplyEffect(): void;
  onApplyBrightness(): void;
  onApplyPowerLimit(): void;
  onRefreshStatus(): void;
  buildParams(effect: EffectRow): EffectParams;
  lanesToMask(): number;
  refreshMask(): void;
  formatStatus(status: LightStatus): StatusRow;
  pushLog(message: string): void;
  formatTime(): string;
  showError(title: string, error: unknown): void;
  describeError(error: unknown): string;
}

Page<PageData, PageCustom>({
  data: {
    devices: [],
    scanning: false,
    state: "idle",
    stateText: STATE_TEXT.idle,
    reconnecting: false,
    deviceName: "",
    connected: false,

    effects: EFFECTS,
    selectedEffect: 1,
    effectName: EFFECTS[1]!.name,
    selectedNeedsColor: true,
    selectedNeedsColor2: false,
    effectParamLabel: "",
    effectParam: 2000,

    lanes: [false, false, false, false, false, false, false, false],
    mask: 0,
    maskText: "未选择",
    allLanesSelected: false,

    colorR: 255,
    colorG: 0,
    colorB: 0,
    color2R: 0,
    color2G: 80,
    color2B: 255,

    brightness: 128,
    powerLimit: 15000,
    fullPowerUnlocked: false,
    applying: false,

    helloText: "",
    status: null,
    log: [],
  },

  service: undefined,
  logBuffer: [],

  onLoad() {
    const link = new BleLink(new WxTransport(), {
      // 显式锁定 #14 GATT 布局，避免自动挑选误选系统服务。
      target: { serviceId: SERVICE_ID, writeCharacteristicId: CMD_CHAR_ID, notifyCharacteristicId: RSP_CHAR_ID },
    });
    const service = new LightBusinessService(new LightService(link));
    this.service = service;
    this.logBuffer = [];
    this.refreshMask();

    service.onStateChange((state) => {
      this.setData({
        state,
        stateText: STATE_TEXT[state],
        connected: state === "ready",
        reconnecting: state === "reconnecting",
      });
      this.pushLog(`状态: ${state}`);
      if (state === "reconnecting") this.pushLog("连接断开，重连中…");
      if (state === "ready") this.pushLog("已就绪");
    });

    service.onStatus((status: LightStatus) => {
      this.setData({ status: this.formatStatus(status) });
    });

    service.onHello((hello: HelloInfo) => {
      const bitmap = hello.effectBitmap[0] ?? 0;
      this.setData({
        helloText: `固件 ${hello.fwVersion} · 协议 v${hello.protocolVersion} · ${hello.stripCount} 路 × ${hello.ledsPerStrip} 颗 · 限流上限 ${hello.powerLimitMa}mA · 灯效位图 0x${bitmap
          .toString(16)
          .padStart(2, "0")}`,
      });
    });
  },

  onUnload() {
    this.service = undefined;
  },

  onHide() {
    // 后台：停扫描 / 暂停自动重连（重连风暴防护）；ready 连接保留不主动断开。
    this.service?.onHide();
  },

  onShow() {
    // 回前台：校验连接 / 恢复挂起的重连；无重复连接风暴（BleLink 单飞 + fault 兜底）。
    void this.service?.onShow();
  },

  onScan() {
    const service = this.service;
    if (service === undefined || this.data.scanning) return;
    if (this.data.connected) {
      wx.showToast({ title: "请先断开", icon: "none" });
      return;
    }
    this.setData({ scanning: true, devices: [] });
    void service
      .scan({ timeoutMs: 5000, services: [SCAN_SERVICE] })
      .then((devices) => {
        this.setData({
          scanning: false,
          devices: devices.map((d) => ({
            deviceId: d.deviceId,
            name: d.name ?? "未知设备",
            rssi: d.rssi ?? 0,
          })),
        });
        this.pushLog(`扫描到 ${devices.length} 个设备`);
      })
      .catch((error: unknown) => {
        this.setData({ scanning: false });
        this.showError("扫描失败", error);
      });
  },

  onSelectDevice(event: WechatMiniprogram.TouchEvent) {
    const deviceId = event.currentTarget.dataset["deviceId"] as string | undefined;
    const service = this.service;
    if (deviceId === undefined || service === undefined) return;
    if (this.data.connected) {
      wx.showToast({ title: "已连接", icon: "none" });
      return;
    }
    const device = this.data.devices.find((d) => d.deviceId === deviceId);
    this.setData({ deviceName: device?.name ?? deviceId });
    void service
      .connect(deviceId)
      .then(() => {
        this.pushLog("连接成功，等待 C3 HELLO…");
        wx.showToast({ title: "已连接", icon: "success" });
      })
      .catch((error: unknown) => this.showError("连接失败", error));
  },

  onDisconnect() {
    const service = this.service;
    if (service === undefined) return;
    void service.disconnect().then(() => this.pushLog("已断开"));
  },

  onSelectEffect(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset["index"] ?? 0);
    const effect = EFFECTS[index];
    if (effect === undefined) return;
    this.setData({
      selectedEffect: index,
      effectName: effect.name,
      selectedNeedsColor: effect.needsColor,
      selectedNeedsColor2: effect.needsColor2,
      effectParamLabel: effect.paramLabel ?? "",
      effectParam: effect.paramLabel === "周期(ms)" ? 2000 : effect.paramLabel === null ? 0 : 5,
    });
  },

  onToggleLane(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset["index"] ?? -1);
    if (index < 0 || index > 7) return;
    const lanes = this.data.lanes.slice();
    lanes[index] = !lanes[index];
    this.setData({ lanes });
    this.refreshMask();
  },

  onSelectAllLanes(event: WechatMiniprogram.TouchEvent) {
    const all = event.currentTarget.dataset["all"] === true || event.currentTarget.dataset["all"] === "true";
    this.setData({ lanes: new Array<boolean>(8).fill(all) });
    this.refreshMask();
  },

  onColorR(event: SliderEvent) {
    this.setData({ colorR: event.detail.value });
  },
  onColorG(event: SliderEvent) {
    this.setData({ colorG: event.detail.value });
  },
  onColorB(event: SliderEvent) {
    this.setData({ colorB: event.detail.value });
  },
  onColor2R(event: SliderEvent) {
    this.setData({ color2R: event.detail.value });
  },
  onColor2G(event: SliderEvent) {
    this.setData({ color2G: event.detail.value });
  },
  onColor2B(event: SliderEvent) {
    this.setData({ color2B: event.detail.value });
  },
  onEffectParam(event: SliderEvent) {
    this.setData({ effectParam: event.detail.value });
  },
  onBrightness(event: SliderEvent) {
    this.setData({ brightness: event.detail.value });
  },
  onPowerLimit(event: SliderEvent) {
    this.setData({ powerLimit: event.detail.value });
  },

  onToggleUnlock(event: SwitchEvent) {
    const service = this.service;
    if (service === undefined) return;
    if (!this.data.connected) {
      wx.showToast({ title: "请先连接", icon: "none" });
      return;
    }
    const unlock = event.detail.value;
    void service
      .unlockFullPower(unlock)
      .then(() => {
        this.setData({ fullPowerUnlocked: unlock });
        this.pushLog(unlock ? "已满功率解锁" : "已恢复受限（50% / 15000mA）");
      })
      .catch((error: unknown) => this.showError("解锁失败", error));
  },

  onApplyEffect() {
    const service = this.service;
    if (service === undefined) return;
    if (!this.data.connected) {
      wx.showToast({ title: "请先连接设备", icon: "none" });
      return;
    }
    if (this.data.mask === 0) {
      wx.showToast({ title: "请至少选择一路灯带", icon: "none" });
      return;
    }
    const effect = EFFECTS[this.data.selectedEffect]!;
    const params = this.buildParams(effect);
    this.setData({ applying: true });
    void service
      .setEffect(this.data.mask, params)
      .then(() => {
        this.setData({ applying: false });
        this.pushLog(`已应用: ${effect.name} → mask 0x${this.data.mask.toString(16)}`);
      })
      .catch((error: unknown) => {
        this.setData({ applying: false });
        this.showError("应用灯效失败", error);
      });
  },

  onApplyBrightness() {
    const service = this.service;
    if (service === undefined) return;
    if (!this.data.connected) {
      wx.showToast({ title: "请先连接设备", icon: "none" });
      return;
    }
    void service
      .setBrightness(this.data.brightness)
      .then(() => this.pushLog(`亮度 → ${this.data.brightness}`))
      .catch((error: unknown) => this.showError("设置亮度失败", error));
  },

  onApplyPowerLimit() {
    const service = this.service;
    if (service === undefined) return;
    if (!this.data.connected) {
      wx.showToast({ title: "请先连接设备", icon: "none" });
      return;
    }
    void service
      .setPowerLimit(this.data.powerLimit)
      .then(() => this.pushLog(`限流 → ${this.data.powerLimit}mA`))
      .catch((error: unknown) => this.showError("设置限流失败", error));
  },

  onRefreshStatus() {
    const service = this.service;
    if (service === undefined || !this.data.connected) return;
    void service
      .requestStatus()
      .then((status) => this.setData({ status: this.formatStatus(status) }))
      .catch((error: unknown) => this.showError("查询状态失败", error));
  },

  buildParams(effect: EffectRow): EffectParams {
    const color: Rgb = { r: this.data.colorR, g: this.data.colorG, b: this.data.colorB };
    const param = this.data.effectParam;
    switch (effect.key) {
      case "off":
        return { effect: "off" };
      case "static":
        return { effect: "static", color };
      case "breath":
        return { effect: "breath", color, periodMs: clamp(param, 100, 65000), min: 0, max: 255 };
      case "gradient":
        return {
          effect: "gradient",
          from: color,
          to: { r: this.data.color2R, g: this.data.color2G, b: this.data.color2B },
          periodMs: clamp(param, 100, 65000),
          direction: 0,
        };
      case "rainbow":
        return { effect: "rainbow", speed: clamp(param, 0, 255), saturation: 255, direction: 0 };
      case "flow":
        return { effect: "flow", color, speed: 5, length: clamp(param, 1, 60), direction: 0 };
      case "twinkle":
        return { effect: "twinkle", color, density: clamp(param, 0, 255), speed: 5 };
    }
  },

  lanesToMask(): number {
    let mask = 0;
    for (let i = 0; i < this.data.lanes.length; i += 1) if (this.data.lanes[i]) mask |= 1 << i;
    return mask;
  },

  refreshMask() {
    const mask = this.lanesToMask();
    const count = mask === 0 ? 0 : popcount(mask);
    const maskText =
      mask === 0xff ? "全路（0xFF）" : count === 0 ? "未选择" : `${count} 路（0x${mask.toString(16).padStart(2, "0")}）`;
    this.setData({ mask, maskText, allLanesSelected: mask === 0xff });
  },

  formatStatus(status: LightStatus): StatusRow {
    const thermal = status.thermalStatus === 0 ? "正常" : status.thermalStatus === 1 ? "警告" : "关闭输出";
    const active = status.activeEffect
      .map((id, i) => (id === 0xff ? `L${i}:—` : `L${i}:${effectName(id)}`))
      .join("  ");
    return {
      uptime: `${status.uptimeS}s`,
      temp: `${status.tempC}℃`,
      current: `${status.currentMaEst}mA`,
      thermal,
      brightness: `${status.brightness}`,
      powerLimit: `${status.powerLimitMa}mA`,
      glitch: `${status.glitchCount}`,
      drop: `${status.dropCount}`,
      stripFault: `0x${status.stripFault.toString(16).padStart(2, "0")}`,
      active,
    };
  },

  pushLog(message: string) {
    const log = [...this.logBuffer, `${this.formatTime()} ${message}`].slice(-30);
    this.logBuffer = log;
    this.setData({ log });
  },

  formatTime(): string {
    const now = new Date();
    return `${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
  },

  showError(title: string, error: unknown) {
    // 断连双路径②：10006 → "断开，重连中…"；NAK 0x06 → "需满功率解锁"。
    if (isNotUnlocked(error) || error instanceof NeedsUnlockError) {
      this.pushLog("需满功率解锁");
      wx.showToast({ title: "需满功率解锁", icon: "none", duration: 2500 });
      return;
    }
    const detail = this.describeError(error);
    this.pushLog(`${title}: ${detail}`);
    if (detail.includes("断开") || detail.includes("NOT_CONNECTED") || detail.includes("10006")) {
      this.pushLog("连接断开，重连中…");
    }
    wx.showToast({ title: `${title}: ${detail}`, icon: "none", duration: 3000 });
  },

  describeError(error: unknown): string {
    if (typeof error === "object" && error !== null) {
      const e = error as { code?: string; message?: string };
      return e.message ?? e.code ?? "未知错误";
    }
    return String(error);
  },
});

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** 置位计数（mask 选了几路）。 */
function popcount(mask: number): number {
  let n = 0;
  for (let i = 0; i < 8; i += 1) if (mask & (1 << i)) n += 1;
  return n;
}

/** effect_id -> 中文名（STATUS active_effect 展示）。 */
function effectName(effectId: number): string {
  for (const effect of EFFECTS) {
    if (EFFECT_IDS[effect.key] === effectId) return effect.name;
  }
  return `0x${effectId.toString(16)}`;
}