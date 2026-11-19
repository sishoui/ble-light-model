/**
 * 首页（tracer bullet，工单 #16）：扫描 → 连接 → 发现 → 订阅 → 设一个灯效。
 *
 * 页面层可自由用 wx / Page（spec §1.1：check-purity 只管 logic/**）。页面只做
 * UI 编排，业务在 LightService → BleLink → WxTransport → Codec 链路里，不重复
 * 任何协议 / 连接逻辑。真机前提：安卓蓝牙开启、C3 上电、微信开发者工具真机调试扫码。
 */

import { BleLink } from "../../logic/ble_link";
import { LightService } from "../../logic/light_service";
import type { EffectParams, HelloInfo, LightStatus } from "../../logic/light_service";
import { WxTransport } from "../../transport/wx_transport";

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
}

/** slider change 事件的最小形状（detail.value）。 */
interface SliderEvent {
  detail: { value: number };
}

const EFFECTS: EffectRow[] = [
  { key: "off", name: "关灯", needsColor: false, needsColor2: false },
  { key: "static", name: "静态", needsColor: true, needsColor2: false },
  { key: "breath", name: "呼吸", needsColor: true, needsColor2: false },
  { key: "gradient", name: "渐变", needsColor: true, needsColor2: true },
  { key: "rainbow", name: "彩虹", needsColor: false, needsColor2: false },
  { key: "flow", name: "流水", needsColor: true, needsColor2: false },
  { key: "twinkle", name: "星闪", needsColor: true, needsColor2: false },
];

/** BleLink 状态 -> 中文提示。 */
const STATE_TEXT: Record<string, string> = {
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

interface PageData {
  devices: DeviceRow[];
  scanning: boolean;
  state: string;
  stateText: string;
  deviceName: string;
  connected: boolean;
  effects: EffectRow[];
  selectedEffect: number;
  selectedNeedsColor: boolean;
  selectedNeedsColor2: boolean;
  colorR: number;
  colorG: number;
  colorB: number;
  color2R: number;
  color2G: number;
  color2B: number;
  applying: boolean;
  helloText: string;
  statusText: string;
  log: string[];
}

interface PageCustom {
  service: LightService | undefined;
  logBuffer: string[];
  onScan(): void;
  onSelectDevice(event: WechatMiniprogram.TouchEvent): void;
  onSelectEffect(event: WechatMiniprogram.TouchEvent): void;
  onColorR(event: SliderEvent): void;
  onColorG(event: SliderEvent): void;
  onColorB(event: SliderEvent): void;
  onColor2R(event: SliderEvent): void;
  onColor2G(event: SliderEvent): void;
  onColor2B(event: SliderEvent): void;
  onApply(): void;
  onDisconnect(): void;
  onRefreshStatus(): void;
  buildParams(effect: EffectRow): EffectParams;
  formatStatus(status: LightStatus): string;
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
    stateText: STATE_TEXT.idle!,
    deviceName: "",
    connected: false,
    effects: EFFECTS,
    selectedEffect: 1,
    selectedNeedsColor: true,
    selectedNeedsColor2: false,
    colorR: 255,
    colorG: 0,
    colorB: 0,
    color2R: 0,
    color2G: 80,
    color2B: 255,
    applying: false,
    helloText: "",
    statusText: "",
    log: [],
  },

  service: undefined,
  logBuffer: [],

  onLoad() {
    const link = new BleLink(new WxTransport());
    const service = new LightService(link);
    this.service = service;
    this.logBuffer = [];
    service.onStateChange((state) => {
      this.setData({
        state,
        stateText: STATE_TEXT[state] ?? state,
        connected: state === "ready",
      });
      this.pushLog(`状态: ${state}`);
      if (state === "reconnecting") {
        this.pushLog("连接断开，自动重连中…");
      }
    });
    service.onStatus((status: LightStatus) => {
      this.setData({ statusText: this.formatStatus(status) });
    });
    service.onHello((hello: HelloInfo) => {
      const bitmap = hello.effectBitmap[0] ?? 0;
      this.setData({
        helloText: `固件 ${hello.fwVersion} · 协议 v${hello.protocolVersion} · ${hello.stripCount} 路 × ${hello.ledsPerStrip} 颗 · 支持灯效 ${bitmap & 0x7f}`,
      });
    });
  },

  onUnload() {
    this.service = undefined;
  },

  onHide() {
    this.service?.onHide();
  },

  onShow() {
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
      .scan({ timeoutMs: 5000 })
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
      .catch((error: unknown) => {
        this.showError("连接失败", error);
      });
  },

  onSelectEffect(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset["index"] ?? 0);
    const effect = EFFECTS[index];
    if (effect === undefined) return;
    this.setData({
      selectedEffect: index,
      selectedNeedsColor: effect.needsColor,
      selectedNeedsColor2: effect.needsColor2,
    });
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

  onApply() {
    const service = this.service;
    if (service === undefined) return;
    if (!this.data.connected) {
      wx.showToast({ title: "请先连接设备", icon: "none" });
      return;
    }
    const effect = EFFECTS[this.data.selectedEffect]!;
    const params = this.buildParams(effect);
    this.setData({ applying: true });
    void service
      .setEffect(0xff, params)
      .then(() => {
        this.setData({ applying: false });
        this.pushLog(`已应用: ${effect.name}`);
        wx.showToast({ title: "已应用", icon: "success" });
      })
      .catch((error: unknown) => {
        this.setData({ applying: false });
        this.showError("应用灯效失败", error);
      });
  },

  onDisconnect() {
    const service = this.service;
    if (service === undefined) return;
    void service.disconnect().then(() => this.pushLog("已断开"));
  },

  onRefreshStatus() {
    const service = this.service;
    if (service === undefined || !this.data.connected) return;
    void service
      .requestStatus()
      .then((status) => this.setData({ statusText: this.formatStatus(status) }))
      .catch((error: unknown) => this.showError("查询状态失败", error));
  },

  buildParams(effect: EffectRow): EffectParams {
    const color = { r: this.data.colorR, g: this.data.colorG, b: this.data.colorB };
    switch (effect.key) {
      case "off":
        return { effect: "off" };
      case "static":
        return { effect: "static", color };
      case "breath":
        return { effect: "breath", color, periodMs: 2000, min: 10, max: 200 };
      case "gradient":
        return {
          effect: "gradient",
          from: color,
          to: { r: this.data.color2R, g: this.data.color2G, b: this.data.color2B },
          periodMs: 2000,
          direction: 0,
        };
      case "rainbow":
        return { effect: "rainbow", speed: 5, saturation: 200, direction: 0 };
      case "flow":
        return { effect: "flow", color, speed: 5, length: 10, direction: 0 };
      case "twinkle":
        return { effect: "twinkle", color, density: 100, speed: 5 };
    }
  },

  formatStatus(status: LightStatus): string {
    const temp = status.thermalStatus === 0 ? "正常" : status.thermalStatus === 1 ? "警告" : "关闭";
    return `运行 ${status.uptimeS}s · ${status.tempC}℃ · 亮度 ${status.brightness} · 温度${temp}`;
  },

  pushLog(message: string) {
    const log = [...this.logBuffer, `${this.formatTime()} ${message}`].slice(-20);
    this.logBuffer = log;
    this.setData({ log });
  },

  formatTime(): string {
    const now = new Date();
    return `${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
  },

  showError(title: string, error: unknown) {
    const detail = this.describeError(error);
    this.pushLog(`${title}: ${detail}`);
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