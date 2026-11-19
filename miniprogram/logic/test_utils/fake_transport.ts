/**
 * FakeTransport：Node 单测里的内存 Transport 替身（GLOSSARY / spec §3.1）。
 *
 * 可编排：设备列表与重复广播、失败码（按阶段入队）、每阶段延迟、挂起不回调的写、
 * 真实 MTU 值与协商结果、通知帧序列、主动 / 静默断连。
 * 记录调用时序：所有操作进入 calls（op + at + detail），写额外进 writes（hex + ArrayBuffer），
 * 用于断言写串行、200ms 生效延迟、3s 超时与重试次数。
 *
 * 纯内存实现，不引用任何 wx / Page / Component / getApp（check-purity 覆盖本文件）。
 */

import type {
  BleCharacteristicInfo,
  BleConnectionState,
  BleDeviceInfo,
  BleMtuChange,
  BleNotification,
  BleServiceInfo,
  BleTransportFailure,
  Platform,
  Transport,
  WriteType,
} from "../transport";

/** 可编排失败 / 延迟的操作阶段，与 Transport 方法一一对应。 */
export type FailPhase =
  | "openAdapter"
  | "closeAdapter"
  | "discovery"
  | "stopDiscovery"
  | "getDevices"
  | "connect"
  | "disconnect"
  | "services"
  | "characteristics"
  | "notify"
  | "write"
  | "setMtu"
  | "getMtu";

/** 一次 write 调用的记录。 */
export interface FakeWriteRecord {
  deviceId: string;
  serviceId: string;
  characteristicId: string;
  hex: string;
  value: ArrayBuffer;
  writeType: WriteType | undefined;
  at: number;
}

/** 一次操作的时序记录。 */
export interface FakeCallRecord {
  op: FailPhase;
  detail: string;
  at: number;
}

export interface FakeTransportOptions {
  platform?: Platform;
  devices?: BleDeviceInfo[];
  services?: BleServiceInfo[];
  /** serviceId（小写归一）→ 特征列表。 */
  characteristics?: Record<string, BleCharacteristicInfo[]>;
  /** getMtu 返回的真实 ATT_MTU；缺省 23（ATT 默认，payload 20）。 */
  mtu?: number;
  /** 时钟注入；缺省 Date.now（vitest fake timers 下自动受控）。 */
  now?: () => number;
  /** 每个设备重复广播次数（默认 1）；>1 用于验证 BleLink 扫描去重。 */
  advertiseRepeats?: number;
  /** setNotification(true) 成功后自动推送的通知帧（hex），模拟 C3 的 HELLO / STATUS。 */
  notifyFrames?: string[];
  /** 各阶段延迟（ms），模拟慢速回调。 */
  delays?: Partial<Record<FailPhase, number>>;
  /**
   * 设备侧写拦截钩子（设备模型用）：每次 write 落盘后同步调用，参数为本次写入的原始字节。
   * 用于 FakeLightDevice 之类的 C3 行为模型在 write 时立即回 ACK / NAK / STATUS。
   */
  onWrite?: (bytes: Uint8Array) => void;
}

export const DEFAULT_DEVICE_ID = "C3-A1";
export const DEFAULT_SERVICE_ID = "0000fff0-0000-1000-8000-00805f9b34fb";
export const DEFAULT_NOTIFY_CHAR_ID = "0000fff1-0000-1000-8000-00805f9b34fb";
export const DEFAULT_WRITE_CHAR_ID = "0000fff2-0000-1000-8000-00805f9b34fb";

export function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase();
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`非法 hex：${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let hex = "";
  for (const byte of view) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function defaultCharacteristics(): Record<string, BleCharacteristicInfo[]> {
  return {
    [DEFAULT_SERVICE_ID]: [
      {
        uuid: DEFAULT_NOTIFY_CHAR_ID,
        properties: { read: false, write: false, writeNoResponse: false, notify: true, indicate: false },
      },
      {
        uuid: DEFAULT_WRITE_CHAR_ID,
        properties: { read: false, write: false, writeNoResponse: true, notify: false, indicate: false },
      },
    ],
  };
}

export class FakeTransport implements Transport {
  private readonly platformName: Platform;
  private readonly devices: BleDeviceInfo[];
  private readonly services: BleServiceInfo[];
  private readonly characteristics: Record<string, BleCharacteristicInfo[]>;
  private mtu: number;
  private readonly nowFn: () => number;
  private advertiseRepeats: number;
  private readonly notifyFrames: string[];
  private readonly delays = new Map<FailPhase, number>();
  private readonly failures = new Map<FailPhase, unknown[]>();
  private readonly deviceFoundListeners = new Set<(devices: BleDeviceInfo[]) => void>();
  private readonly connectionListeners = new Set<(state: BleConnectionState) => void>();
  private readonly notificationListeners = new Set<(notification: BleNotification) => void>();
  private readonly mtuListeners = new Set<(change: BleMtuChange) => void>();

  readonly calls: FakeCallRecord[] = [];
  readonly writes: FakeWriteRecord[] = [];

  private connected = false;
  private adapterOpened = false;
  private hangWrites = 0;
  private lastNotifyTarget: { deviceId: string; serviceId: string; characteristicId: string } | null = null;
  private readonly onWriteHook: ((bytes: Uint8Array) => void) | undefined;

  constructor(options: FakeTransportOptions = {}) {
    this.platformName = options.platform ?? "android";
    this.devices = options.devices ?? [{ deviceId: DEFAULT_DEVICE_ID, name: "C3", RSSI: -50 }];
    this.services =
      options.services ?? [{ uuid: DEFAULT_SERVICE_ID, isPrimary: true }];
    this.characteristics = options.characteristics ?? defaultCharacteristics();
    this.mtu = options.mtu ?? 23;
    this.nowFn = options.now ?? (() => Date.now());
    this.advertiseRepeats = options.advertiseRepeats ?? 1;
    this.notifyFrames = options.notifyFrames ?? [];
    this.onWriteHook = options.onWrite;
    for (const [phase, delay] of Object.entries(options.delays ?? {})) {
      this.delays.set(phase as FailPhase, delay);
    }
  }

  platform(): Platform {
    return this.platformName;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get isAdapterOpened(): boolean {
    return this.adapterOpened;
  }

  /** 按阶段入队失败：接下来第 times 次该阶段调用 reject { errCode }。 */
  enqueueFailure(phase: FailPhase, errCode: number, times = 1): void {
    const queue = this.failures.get(phase) ?? [];
    for (let i = 0; i < times; i += 1) queue.push({ errCode, errMsg: `fake ${phase} failure` });
    this.failures.set(phase, queue);
  }

  /** 按阶段入队任意 reject 值（模拟非 wx 形状的异常，验证映射兜底）。 */
  enqueueRawFailure(phase: FailPhase, value: unknown, times = 1): void {
    const queue = this.failures.get(phase) ?? [];
    for (let i = 0; i < times; i += 1) queue.push(value);
    this.failures.set(phase, queue);
  }

  /** 接下来第 count 次 write 永不回调（模拟 iOS 超限静默挂起）。 */
  hangNextWrites(count = 1): void {
    this.hangWrites += count;
  }

  setDelay(phase: FailPhase, delayMs: number): void {
    this.delays.set(phase, delayMs);
  }

  /** 场景脚本用：运行时调整重复广播次数。 */
  setAdvertiseRepeats(repeats: number): void {
    this.advertiseRepeats = repeats;
  }

  /** 场景脚本用：覆盖 getMtu 返回的真实 ATT_MTU。 */
  setMtuValue(mtu: number): void {
    this.mtu = mtu;
  }

  /** 场景脚本用：替换 setNotification(true) 后自动推送的通知帧。 */
  setNotifyFrames(frames: string[]): void {
    this.notifyFrames.splice(0, this.notifyFrames.length, ...frames);
  }

  /** 模拟服务端主动断连；silent=true 不派发 onConnectionStateChange（逼出 10006 路径）。 */
  dropConnection(deviceId: string, options: { silent?: boolean } = {}): void {
    this.connected = false;
    if (!options.silent) this.emitConnection({ deviceId, connected: false });
  }

  /** 手动推送一条通知帧（设备侧主动发送）。 */
  emitNotification(hex: string, target?: { deviceId: string; serviceId: string; characteristicId: string }): void {
    const resolved = target ?? this.lastNotifyTarget ?? {
      deviceId: DEFAULT_DEVICE_ID,
      serviceId: DEFAULT_SERVICE_ID,
      characteristicId: DEFAULT_NOTIFY_CHAR_ID,
    };
    const value = hexToBytes(hex).buffer;
    const notification: BleNotification = {
      deviceId: resolved.deviceId,
      serviceId: resolved.serviceId,
      characteristicId: resolved.characteristicId,
      value,
    };
    for (const listener of this.notificationListeners) listener(notification);
  }

  /** 模拟安卓 MTU 协商完成事件（同时更新 getMtu 的真实值）。 */
  emitMtuChange(deviceId: string, mtu: number): void {
    this.mtu = mtu;
    const change: BleMtuChange = { deviceId, mtu };
    for (const listener of this.mtuListeners) listener(change);
  }

  opCount(op: FailPhase): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  callsOf(op: FailPhase): FakeCallRecord[] {
    return this.calls.filter((call) => call.op === op);
  }

  async openAdapter(): Promise<void> {
    await this.guard("openAdapter", "", () => {
      this.adapterOpened = true;
    });
  }

  async closeAdapter(): Promise<void> {
    await this.guard("closeAdapter", "", () => {
      this.adapterOpened = false;
    });
  }

  async startDiscovery(services?: string[]): Promise<void> {
    await this.guard("discovery", services?.join(",") ?? "", () => {
      for (let repeat = 0; repeat < this.advertiseRepeats; repeat += 1) {
        for (const device of this.devices) {
          for (const listener of this.deviceFoundListeners) listener([device]);
        }
      }
    });
  }

  async stopDiscovery(): Promise<void> {
    await this.guard("stopDiscovery", "", () => undefined);
  }

  /**
   * 已扫到的设备（微信 getBluetoothDevices 的归一形状）。
   * 注意：已从 Transport 接口移除（BleLink 用 onDeviceFound 事件跟踪设备，
   * 不调用本方法）；保留为 FakeTransport 的具体方法，供 ui_spike 的微信层
   * mock（getBluetoothDevices）复用同一设备模型。
   */
  async getDevices(): Promise<BleDeviceInfo[]> {
    return this.guard("getDevices", "", () => this.devices.slice());
  }

  async connect(deviceId: string): Promise<void> {
    await this.guard("connect", deviceId, () => {
      if (this.connected) throw { errCode: -1, errMsg: "already connect" } satisfies BleTransportFailure;
      this.connected = true;
      this.emitConnection({ deviceId, connected: true });
    });
  }

  async disconnect(deviceId: string): Promise<void> {
    await this.guard("disconnect", deviceId, () => {
      this.connected = false;
      this.emitConnection({ deviceId, connected: false });
    });
  }

  async getServices(deviceId: string): Promise<BleServiceInfo[]> {
    return this.guard("services", deviceId, () => {
      this.assertConnected();
      return this.services.slice();
    });
  }

  async getCharacteristics(deviceId: string, serviceId: string): Promise<BleCharacteristicInfo[]> {
    return this.guard("characteristics", `${deviceId}/${serviceId}`, () => {
      this.assertConnected();
      return (this.characteristics[normalizeUuid(serviceId)] ?? []).slice();
    });
  }

  async setNotification(
    deviceId: string,
    serviceId: string,
    characteristicId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.guard("notify", `${deviceId}/${characteristicId}/${String(enabled)}`, () => {
      this.assertConnected();
      this.lastNotifyTarget = { deviceId, serviceId, characteristicId };
      if (enabled) {
        for (const hex of this.notifyFrames) this.emitNotification(hex);
      }
    });
  }

  async write(
    deviceId: string,
    serviceId: string,
    characteristicId: string,
    value: ArrayBuffer,
    writeType?: WriteType,
  ): Promise<void> {
    await this.guard("write", `${characteristicId}/${bytesToHex(value)}`, async () => {
      this.assertConnected();
      if (this.hangWrites > 0) {
        this.hangWrites -= 1;
        return new Promise<void>(() => undefined);
      }
      this.writes.push({
        deviceId,
        serviceId,
        characteristicId,
        hex: bytesToHex(value),
        value,
        writeType,
        at: this.nowFn(),
      });
      // 设备模型拦截：把本次写入原始字节交给钩子（FakeLightDevice 在内部解码并回帧）。
      this.onWriteHook?.(new Uint8Array(value.slice(0)));
    });
  }

  async setMtu(deviceId: string, mtu: number): Promise<void> {
    await this.guard("setMtu", `${deviceId}/${mtu}`, () => {
      // success 回显不可信：这里只记录协商请求，真实值由 getMtu 给出。
      void mtu;
    });
  }

  async getMtu(deviceId: string): Promise<number> {
    return this.guard("getMtu", deviceId, () => {
      this.assertConnected();
      return this.mtu;
    });
  }

  onDeviceFound(listener: (devices: BleDeviceInfo[]) => void): void {
    this.deviceFoundListeners.add(listener);
  }

  onConnectionStateChange(listener: (state: BleConnectionState) => void): void {
    this.connectionListeners.add(listener);
  }

  onNotification(listener: (notification: BleNotification) => void): void {
    this.notificationListeners.add(listener);
  }

  onMtuChange(listener: (change: BleMtuChange) => void): void {
    this.mtuListeners.add(listener);
  }

  private emitConnection(state: BleConnectionState): void {
    for (const listener of this.connectionListeners) listener(state);
  }

  private assertConnected(): void {
    if (!this.connected) throw { errCode: 10006, errMsg: "no connection" } satisfies BleTransportFailure;
  }

  private async guard<T>(phase: FailPhase, detail: string, run: () => T | Promise<T>): Promise<T> {
    this.calls.push({ op: phase, detail, at: this.nowFn() });
    const delay = this.delays.get(phase) ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const queue = this.failures.get(phase);
    if (queue !== undefined && queue.length > 0) {
      const failure = queue.shift();
      if (queue.length === 0) this.failures.delete(phase);
      throw failure;
    }
    return run();
  }
}