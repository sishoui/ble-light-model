/**
 * BleLink：与传输实现无关的连接编排层（GLOSSARY / spec §1.1、§3.1）。
 *
 * 职责：扫描去重与超时、连接状态机（idle/scanning/connecting/discovering/subscribing/
 * ready/fault/reconnecting/suspended 全迁移）、服务 / 特征值发现与缓存、订阅启用、
 * 写串行化（并发写排队、每片 3s 超时、MTU 分片、notify 后 200ms 生效）、
 * 错误码 -> 领域错误映射、断连双路径（① onConnectionStateChange(connected:false)；
 * ② 读写 reject errCode 10006）、onHide/onShow 挂起恢复（隐藏时停扫描 / 停重连风暴）。
 *
 * 纯 TS：不引用任何 wx / Page / Component / getApp（CI check-purity 强制）。
 */

import {
  AlreadyConnectedError,
  BleDomainError,
  InvalidStateError,
  NoCharacteristicError,
  NoServiceError,
  NotConnectedError,
  TimeoutError,
  UnknownBleError,
  mapTransportFailure,
} from "./errors";
import { isBleTransportFailure } from "./transport";
import type {
  BleCharacteristicInfo,
  BleDeviceInfo,
  BleServiceInfo,
  Platform,
  Transport,
  WriteType,
} from "./transport";

/** 状态机状态（spec §1.1：连接状态机全迁移）。 */
export type LinkState =
  | "idle"
  | "scanning"
  | "connecting"
  | "discovering"
  | "subscribing"
  | "ready"
  | "fault"
  | "reconnecting"
  | "suspended";

/** 分片兜底：MTU 未知 / 协商失败时固定 20 字节 payload（spec §3.1，永不放弃）。 */
export const MIN_PAYLOAD = 20;
/** 默认扫描超时。 */
export const DEFAULT_SCAN_TIMEOUT_MS = 3000;
/** 每片写超时（spec §3.1；iOS 超限可能永无回调，必须自带看门狗）。 */
export const DEFAULT_WRITE_TIMEOUT_MS = 3000;
/** notify 使能成功后延迟再写（spec §3.1；规避部分安卓 10008）。 */
export const DEFAULT_NOTIFY_SETTLE_MS = 200;
/** 默认自动重连延迟。 */
export const DEFAULT_RECONNECT_DELAY_MS = 1000;
/** 安卓 setBLEMTU 请求值（success 回显不可信，真实值看 getBLEMTU / onBLEMTUChange）。 */
export const DEFAULT_REQUESTED_MTU = 247;

/** 显式指定目标服务 / 特征值（iOS 上 uuid 必须来自发现接口，不能硬编码；由上层配置注入）。 */
export interface BleTarget {
  serviceId: string;
  writeCharacteristicId?: string;
  notifyCharacteristicId?: string;
}

/** 解析后的目标（含按特征属性推断的写模式）。 */
export interface BleLinkTarget {
  serviceId: string;
  writeCharacteristicId: string;
  notifyCharacteristicId: string;
  writeType: WriteType;
}

export interface BleLinkOptions {
  platform?: Platform;
  scanTimeoutMs?: number;
  writeTimeoutMs?: number;
  notifySettleMs?: number;
  reconnectDelayMs?: number;
  autoReconnect?: boolean;
  requestedMtu?: number;
  writeType?: WriteType;
  target?: BleTarget;
}

interface ResolvedOptions {
  scanTimeoutMs: number;
  writeTimeoutMs: number;
  notifySettleMs: number;
  reconnectDelayMs: number;
  autoReconnect: boolean;
  requestedMtu: number;
  writeType: WriteType | undefined;
  target: BleTarget | undefined;
}

/** 安卓部分机型会多出这两个标准服务（wx-ble-facts §9.2），自动挑选时跳过。 */
function isReservedService(uuid: string): boolean {
  const normalized = uuid.toLowerCase();
  return normalized.startsWith("00001800") || normalized.startsWith("00001801");
}

function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase();
}

export class BleLink {
  private readonly transport: Transport;
  private readonly platform: Platform;
  private readonly options: ResolvedOptions;

  private currentState: LinkState = "idle";
  private currentDeviceId: string | undefined;
  private selected: BleLinkTarget | undefined;
  private readonly serviceCache = new Map<string, BleCharacteristicInfo[]>();
  private readonly foundDevices = new Map<string, BleDeviceInfo>();

  private adapterOpened = false;
  private hidden = false;
  private userClosed = false;
  private suspendReturn: "scanning" | "reconnecting" | undefined;

  private mtuPayload = MIN_PAYLOAD;
  private notifyReadyAt = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly stateListeners = new Set<(state: LinkState) => void>();
  private readonly notificationListeners = new Set<
    (notification: { deviceId: string; serviceId: string; characteristicId: string; value: ArrayBuffer }) => void
  >();

  constructor(transport: Transport, options: BleLinkOptions = {}) {
    this.transport = transport;
    this.platform = options.platform ?? transport.platform();
    this.options = {
      scanTimeoutMs: options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
      writeTimeoutMs: options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
      notifySettleMs: options.notifySettleMs ?? DEFAULT_NOTIFY_SETTLE_MS,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      autoReconnect: options.autoReconnect ?? true,
      requestedMtu: options.requestedMtu ?? DEFAULT_REQUESTED_MTU,
      writeType: options.writeType,
      target: options.target,
    };

    this.transport.onDeviceFound((devices) => {
      if (this.currentState !== "scanning") return;
      for (const device of devices) {
        // 去重：同 deviceId 的重复广播只保留最新一条。
        this.foundDevices.set(device.deviceId, device);
      }
    });
    this.transport.onConnectionStateChange((state) => {
      if (state.deviceId !== this.currentDeviceId) return;
      // 断连路径①：连接状态事件（主动 / 被动 / 设备丢失 / 系统回收）。
      if (!state.connected) this.handleUnexpectedDisconnect();
    });
    this.transport.onNotification((notification) => {
      if (notification.deviceId !== this.currentDeviceId) return;
      for (const listener of this.notificationListeners) listener(notification);
    });
    this.transport.onMtuChange((change) => {
      if (change.deviceId !== this.currentDeviceId) return;
      this.applyMtu(change.mtu);
    });
  }

  get state(): LinkState {
    return this.currentState;
  }

  get deviceId(): string | undefined {
    return this.currentDeviceId;
  }

  /** 当前真实 payload 分片大小（真实 MTU − 3，兜底 20）。 */
  get writePayloadSize(): number {
    return this.mtuPayload;
  }

  /** 已发现的目标（连接成功后可用）。 */
  get selectedTarget(): Readonly<BleLinkTarget> | undefined {
    return this.selected;
  }

  /** 已发现的服务缓存（只读）。 */
  get cachedServices(): readonly BleServiceInfo[] {
    return this.serviceList;
  }

  private serviceList: BleServiceInfo[] = [];

  onStateChange(listener: (state: LinkState) => void): void {
    this.stateListeners.add(listener);
  }

  onNotification(
    listener: (notification: {
      deviceId: string;
      serviceId: string;
      characteristicId: string;
      value: ArrayBuffer;
    }) => void,
  ): void {
    this.notificationListeners.add(listener);
  }

  /**
   * 扫描：开始发现 -> 去重收集 -> 超时停止，返回按发现顺序的设备列表。
   * 只允许 idle / fault / suspended 状态发起；扫描期间重复广播自动去重。
   */
  async scan(options: { timeoutMs?: number; services?: string[] } = {}): Promise<BleDeviceInfo[]> {
    if (this.currentState !== "idle" && this.currentState !== "fault" && this.currentState !== "suspended") {
      throw new InvalidStateError(`当前状态 ${this.currentState} 不可扫描`);
    }
    const timeoutMs = options.timeoutMs ?? this.options.scanTimeoutMs;
    this.suspendReturn = undefined;
    this.foundDevices.clear();
    this.setState("scanning");
    try {
      await this.ensureAdapter();
      await this.transport.startDiscovery(options.services);
    } catch (error) {
      this.fail(this.map(error));
    }
    await this.delay(timeoutMs);
    await this.stopDiscoverySafe();
    if (this.inState("scanning")) this.setState("idle");
    return [...this.foundDevices.values()];
  }

  /** 连接并完成发现 / 订阅，成功后状态为 ready。 */
  async connect(deviceId: string): Promise<void> {
    const allowed: readonly LinkState[] = ["idle", "scanning", "fault", "suspended", "reconnecting"];
    if (!allowed.includes(this.currentState)) {
      throw new InvalidStateError(`当前状态 ${this.currentState} 不可发起连接`);
    }
    this.userClosed = false;
    this.currentDeviceId = deviceId;
    if (this.currentState === "scanning") await this.stopDiscoverySafe();
    this.setState("connecting");
    try {
      await this.ensureAdapter();
      try {
        await this.transport.connect(deviceId);
      } catch (error) {
        const mapped = this.map(error);
        // -1 already connect：视为已连接，继续走发现 / 订阅。
        if (!(mapped instanceof AlreadyConnectedError)) throw mapped;
      }
    } catch (error) {
      this.fail(this.map(error));
    }
    await this.discoverAndSubscribe();
  }

  /** 用户主动断开；屏蔽自动重连。 */
  async disconnect(): Promise<void> {
    const deviceId = this.currentDeviceId;
    this.userClosed = true;
    this.clearReconnectTimer();
    this.currentDeviceId = undefined;
    this.selected = undefined;
    this.notifyReadyAt = 0;
    if (deviceId !== undefined) {
      try {
        await this.transport.disconnect(deviceId);
      } catch (error) {
        const mapped = this.map(error);
        if (!(mapped instanceof NotConnectedError)) {
          this.setState("idle");
          throw mapped;
        }
      }
    }
    this.setState("idle");
  }

  /**
   * 写串行队列：并发写按调用顺序排队，逐片写入；每片 3s 超时抛 TimeoutError（不自动重试）。
   * notify 使能后 200ms 内的首次写自动等待生效延迟。value 保证是 ArrayBuffer。
   */
  write(data: Uint8Array): Promise<void> {
    if (this.currentState !== "ready") {
      return Promise.reject(new InvalidStateError(`当前状态 ${this.currentState} 不可写`));
    }
    const bytes = data.slice();
    const run = this.writeChain.then(() => this.writeChunks(bytes));
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 进入后台：暂停扫描与自动重连（重连风暴防护）；ready 连接保留不主动断开。 */
  onHide(): void {
    this.hidden = true;
    this.clearReconnectTimer();
    if (this.currentState === "scanning") {
      this.suspendReturn = "scanning";
      this.setState("suspended");
      void this.stopDiscoverySafe();
    } else if (this.currentState === "reconnecting") {
      this.suspendReturn = "reconnecting";
      this.setState("suspended");
    }
  }

  /** 回到前台：扫描中挂起 -> idle（由用户重新发起）；重连中挂起 -> 恢复重连；ready -> 校验连接。 */
  async onShow(): Promise<void> {
    this.hidden = false;
    if (this.currentState === "suspended") {
      const suspendReturn = this.suspendReturn;
      this.suspendReturn = undefined;
      if (suspendReturn === "reconnecting") {
        this.scheduleReconnect();
      } else {
        this.setState("idle");
      }
      return;
    }
    if (this.currentState === "ready") await this.verifyConnection();
  }

  private async writeChunks(data: Uint8Array): Promise<void> {
    // notify 生效延迟：订阅成功后 200ms 内的写先等待（spec §3.1）。
    const waitMs = this.notifyReadyAt - this.now();
    if (waitMs > 0) await this.delay(waitMs);
    if (this.currentState !== "ready") {
      throw new InvalidStateError(`当前状态 ${this.currentState} 不可写`);
    }
    const target = this.selected;
    const deviceId = this.requireDeviceId();
    if (target === undefined) throw new InvalidStateError("尚未完成服务发现");
    const size = this.mtuPayload;
    for (let offset = 0; offset < data.length; offset += size) {
      const chunk = new Uint8Array(data.subarray(offset, offset + size));
      await this.writeChunk(deviceId, target, chunk);
    }
  }

  private async writeChunk(
    deviceId: string,
    target: BleLinkTarget,
    chunk: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    // value 必须是 ArrayBuffer（spec §3.1 硬约束；new Uint8Array 保证独立 ArrayBuffer）。
    const value: ArrayBuffer = chunk.buffer;
    try {
      await this.withTimeout(
        this.transport.write(deviceId, target.serviceId, target.writeCharacteristicId, value, target.writeType),
        this.options.writeTimeoutMs,
        "写特征值",
      );
    } catch (error) {
      const mapped = this.map(error);
      // 断连路径②：断连后写 reject 10006 -> 触发重连。
      if (mapped instanceof NotConnectedError) this.handleUnexpectedDisconnect();
      throw mapped;
    }
  }

  private async discoverAndSubscribe(): Promise<void> {
    const deviceId = this.requireDeviceId();
    this.setState("discovering");
    try {
      const services = await this.transport.getServices(deviceId);
      this.serviceList = services;
      const target = await this.selectTarget(services);
      this.selected = target;
      await this.negotiateMtu();
      this.setState("subscribing");
      await this.transport.setNotification(deviceId, target.serviceId, target.notifyCharacteristicId, true);
    } catch (error) {
      this.fail(this.map(error));
    }
    this.notifyReadyAt = this.now() + this.options.notifySettleMs;
    this.setState("ready");
  }

  private async selectTarget(services: BleServiceInfo[]): Promise<BleLinkTarget> {
    if (this.options.target !== undefined) return this.selectExplicitTarget(this.options.target, services);
    return this.selectAutoTarget(services);
  }

  private async selectAutoTarget(services: BleServiceInfo[]): Promise<BleLinkTarget> {
    for (const service of services) {
      if (isReservedService(service.uuid)) continue;
      const chars = await this.loadCharacteristics(service.uuid);
      const notifyChar = chars.find((c) => c.properties.notify || c.properties.indicate);
      if (notifyChar === undefined) continue;
      const writeChar = chars.find((c) => c.properties.write || c.properties.writeNoResponse);
      if (writeChar === undefined) continue;
      return this.buildTarget(service.uuid, writeChar, notifyChar);
    }
    throw new NoCharacteristicError({ errMsg: "未发现同时具备可写与通知特征的 GATT 服务" });
  }

  private async selectExplicitTarget(target: BleTarget, services: BleServiceInfo[]): Promise<BleLinkTarget> {
    const serviceId = normalizeUuid(target.serviceId);
    const service = services.find((s) => normalizeUuid(s.uuid) === serviceId);
    if (service === undefined) throw new NoServiceError({ errMsg: `未发现服务 ${target.serviceId}` });
    const chars = await this.loadCharacteristics(service.uuid);
    const notifyChar =
      target.notifyCharacteristicId !== undefined
        ? this.findChar(chars, target.notifyCharacteristicId)
        : chars.find((c) => c.properties.notify || c.properties.indicate);
    if (notifyChar === undefined) {
      throw new NoCharacteristicError({ errMsg: `服务 ${target.serviceId} 无可用的通知特征` });
    }
    const writeChar =
      target.writeCharacteristicId !== undefined
        ? this.findChar(chars, target.writeCharacteristicId)
        : chars.find((c) => c.properties.write || c.properties.writeNoResponse);
    if (writeChar === undefined) {
      throw new NoCharacteristicError({ errMsg: `服务 ${target.serviceId} 无可用的写特征` });
    }
    return this.buildTarget(service.uuid, writeChar, notifyChar);
  }

  private findChar(chars: BleCharacteristicInfo[], characteristicId: string): BleCharacteristicInfo {
    const found = chars.find((c) => normalizeUuid(c.uuid) === normalizeUuid(characteristicId));
    if (found === undefined) {
      throw new NoCharacteristicError({ errMsg: `未发现特征 ${characteristicId}` });
    }
    return found;
  }

  private buildTarget(
    serviceId: string,
    writeChar: BleCharacteristicInfo,
    notifyChar: BleCharacteristicInfo,
  ): BleLinkTarget {
    const writeType: WriteType =
      this.options.writeType ?? (writeChar.properties.write ? "write" : "writeNoResponse");
    return {
      serviceId,
      writeCharacteristicId: writeChar.uuid,
      notifyCharacteristicId: notifyChar.uuid,
      writeType,
    };
  }

  private async loadCharacteristics(serviceId: string): Promise<BleCharacteristicInfo[]> {
    const key = normalizeUuid(serviceId);
    const cached = this.serviceCache.get(key);
    if (cached !== undefined) return cached;
    const chars = await this.transport.getCharacteristics(this.requireDeviceId(), serviceId);
    this.serviceCache.set(key, chars);
    return chars;
  }

  private async negotiateMtu(): Promise<void> {
    const deviceId = this.currentDeviceId;
    if (deviceId === undefined) return;
    try {
      // 仅安卓尝试协商；iOS 系统固定 MTU。success 回显不可信，真实值看 getMtu / onMtuChange。
      if (this.platform === "android") {
        try {
          await this.transport.setMtu(deviceId, this.options.requestedMtu);
        } catch {
          // 协商失败不致命：继续用真实值或 20 字节兜底。
        }
      }
      this.applyMtu(await this.transport.getMtu(deviceId));
    } catch {
      this.applyMtu(undefined);
    }
  }

  private applyMtu(mtu: number | undefined): void {
    if (mtu === undefined || !Number.isFinite(mtu) || mtu <= MIN_PAYLOAD + 3) {
      this.mtuPayload = MIN_PAYLOAD;
      return;
    }
    this.mtuPayload = Math.max(MIN_PAYLOAD, mtu - 3);
  }

  /** 断连路径①的入口：只有 ready 状态的意外断连才触发重连 / fault。 */
  private handleUnexpectedDisconnect(): void {
    if (this.userClosed) return;
    if (this.currentState !== "ready") return;
    this.scheduleReconnect();
  }

  /** 重连风暴防护：单飞（reconnecting 状态互斥）+ 隐藏 / 主动断开 / 无设备时直接不排。 */
  private scheduleReconnect(): void {
    const deviceId = this.currentDeviceId;
    if (this.userClosed || this.hidden || deviceId === undefined) return;
    if (this.currentState === "reconnecting") return;
    if (!this.options.autoReconnect) {
      this.setState("fault");
      return;
    }
    this.setState("reconnecting");
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.autoReconnect(deviceId);
    }, this.options.reconnectDelayMs);
  }

  private async autoReconnect(deviceId: string): Promise<void> {
    try {
      await this.connect(deviceId);
    } catch {
      // connect 已把状态置为 fault；不自动循环重试，等 onShow / 用户操作。
    }
  }

  /** 回前台校验：挂起期间连接可能被系统回收；探测失败走重连路径。 */
  private async verifyConnection(): Promise<void> {
    const deviceId = this.currentDeviceId;
    if (deviceId === undefined) return;
    try {
      await this.transport.getServices(deviceId);
      await this.discoverAndSubscribe();
    } catch {
      this.scheduleReconnect();
    }
  }

  private async ensureAdapter(): Promise<void> {
    if (this.adapterOpened) return;
    await this.transport.openAdapter();
    this.adapterOpened = true;
  }

  private async stopDiscoverySafe(): Promise<void> {
    try {
      await this.transport.stopDiscovery();
    } catch {
      // 停止扫描失败不影响主流程。
    }
  }

  private requireDeviceId(): string {
    if (this.currentDeviceId === undefined) throw new InvalidStateError("尚未连接设备");
    return this.currentDeviceId;
  }

  /** 状态判断（经方法调用读取，避免 await 后 TS 对 this.currentState 的窄化误导）。 */
  private inState(...states: readonly LinkState[]): boolean {
    return states.includes(this.currentState);
  }

  private fail(error: BleDomainError): never {
    this.setState("fault");
    throw error;
  }

  private map(error: unknown): BleDomainError {
    if (error instanceof BleDomainError) return error;
    if (isBleTransportFailure(error)) return mapTransportFailure(error);
    const errMsg = error instanceof Error ? error.message : String(error);
    return new UnknownBleError({ errMsg, cause: error });
  }

  private setState(next: LinkState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    for (const listener of this.stateListeners) listener(next);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private now(): number {
    return Date.now();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, phase: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TimeoutError(phase, ms)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}