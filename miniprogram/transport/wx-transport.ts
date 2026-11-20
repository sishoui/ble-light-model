// WxTransport（miniprogram.md §4.1）：用 `wx.*` BLE API 薄壳实现 Transport 接口。
//
// 本文件属于 transport/ 目录，允许引用 `wx`（lint 只查 logic/src）。
// 语义钉死在 §3 + §4.1：懒加载适配器、namePrefix 过滤 + deviceId 去重、连接含服务/特征
// 发现 + notify 订阅、写用 ArrayBuffer 精确切片、MTU 只被动跟随回退 20、断连双路径。

import { TransportError } from "@ble-light/logic";
import type { DeviceAdvertisement, DeviceId, Transport, TransportErrorKind, Unsubscribe } from "@ble-light/logic";

/** GATT 布局（protocol.md §16）。 */
export const GATT_SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
export const GATT_CMD_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
export const GATT_RSP_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";

const FALLBACK_MTU = 20;
const CONNECT_TIMEOUT_MS = 12000; // §4.1
const NOTIFY_SETTLE_MS = 200; // 规避部分安卓 notify 使能后立刻写报 10008
const DEFAULT_NAME_PREFIX = "BLE-Light-"; // protocol.md §16 广播名

/* wx.* 回调式 API -> Promise 的通用薄壳。 */
function call<T>(fn: (opts: {
  success?: (res: T) => void;
  fail?: (err: { errCode?: number; errMsg?: string }) => void;
}) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn({
      success: (res) => resolve(res),
      fail: (err) => reject(err),
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** wx errCode -> TransportErrorKind（miniprogram.md §7.1）。 */
export function mapWxError(err: { errCode?: number; errMsg?: string }): TransportError {
  const code = err.errCode ?? -1;
  let kind: TransportErrorKind;
  switch (code) {
    case 10000: kind = "not-initialized"; break;
    case 10001: kind = "adapter-unavailable"; break;
    case 10009:
    case 10007: kind = "unsupported"; break;
    case 10004: kind = "service-missing"; break;
    case 10005: kind = "characteristic-missing"; break;
    case 10002: kind = "not-found"; break;
    case 10003: kind = "connect-failed"; break;
    case 10006: kind = "not-connected"; break;
    case 10012: kind = "timeout"; break;
    case 10013: kind = "invalid-data"; break;
    case 10008: kind = "system"; break;
    default: kind = "system"; break;
  }
  return new TransportError(kind, err.errMsg ?? "wx BLE error", code);
}

export interface WxTransportOptions {
  serviceUuid?: string;
  namePrefix?: string;
}

export class WxTransport implements Transport {
  mtuPayloadBytes = FALLBACK_MTU;

  private readonly serviceUuid: string;
  private readonly namePrefix: string;
  private deviceId: DeviceId | null = null;
  private adapterOpened = false;
  private scanning = false;
  private disposed = false;

  private deviceCbs: Array<(adv: DeviceAdvertisement) => void> = [];
  private notifyCbs: Array<(chunk: Uint8Array) => void> = [];
  private disconnectCbs: Array<(err: TransportError) => void> = [];

  // 已发现设备去重表：deviceId -> last rssi
  private seen = new Map<DeviceId, number>();

  constructor(opts?: WxTransportOptions) {
    this.serviceUuid = opts?.serviceUuid ?? GATT_SERVICE_UUID;
    this.namePrefix = opts?.namePrefix ?? DEFAULT_NAME_PREFIX;
  }

  startScan(filter: { serviceUuid: string; namePrefix?: string }): void {
    if (this.scanning) return; // 幂等
    this.ensureAdapter();
    const uuid = filter.serviceUuid || this.serviceUuid;
    const prefix = filter.namePrefix ?? this.namePrefix;
    wx.startBluetoothDevicesDiscovery({
      services: [uuid],
      allowDuplicatesKey: true,
      fail: (err) => this.onUnexpectedErr(err),
    });
    this.scanning = true;
    wx.onBluetoothDeviceFound((res) => {
      for (const d of res.devices ?? []) {
        if (d.name && !d.name.startsWith(prefix)) continue; // namePrefix 过滤
        const id = d.deviceId;
        const prevRssi = this.seen.get(id);
        this.seen.set(id, d.RSSI);
        if (prevRssi === undefined) {
          // 新设备：上抛
          for (const cb of this.deviceCbs) cb({ deviceId: id, name: d.name, rssi: d.RSSI });
        } else {
          // 重复广播：仅刷新 rssi（§3：按 deviceId 去重）
          for (const cb of this.deviceCbs) cb({ deviceId: id, name: d.name, rssi: d.RSSI });
        }
      }
    });
  }

  stopScan(): void {
    if (!this.scanning) return;
    this.scanning = false;
    wx.stopBluetoothDevicesDiscovery({
      fail: (err) => this.onUnexpectedErr(err),
    });
  }

  onDeviceFound(cb: (adv: DeviceAdvertisement) => void): Unsubscribe {
    this.deviceCbs.push(cb);
    return () => { this.deviceCbs = this.deviceCbs.filter((x) => x !== cb); };
  }

  async connect(deviceId: DeviceId, opts?: { timeoutMs?: number }): Promise<void> {
    this.ensureAdapter();
    if (this.deviceId === deviceId) return; // 已连接同一设备：直接 resolve（§3）
    this.stopScan();
    const timeoutMs = opts?.timeoutMs ?? CONNECT_TIMEOUT_MS;

    try {
      // ① 建连
      await this.createConnection(deviceId, timeoutMs);
      // ② 发现服务 + 特征 + 校验 + 订阅
      await this.discoverAndSubscribe(deviceId);
      // ③ notify 使能后等 200ms 才 resolve
      await delay(NOTIFY_SETTLE_MS);
      this.deviceId = deviceId;
      // ④ 被动跟随 MTU（读不到一律回退 20）
      this.refreshMtu(deviceId);
    } catch (err) {
      const e = err instanceof TransportError ? err : mapWxError(err as { errCode?: number; errMsg?: string });
      if (e.kind === "not-connected") this.emitDisconnect(e);
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.deviceId) return;
    const id = this.deviceId;
    this.deviceId = null;
    this.mtuPayloadBytes = FALLBACK_MTU;
    try {
      await call<void>((o) => wx.closeBLEConnection({ deviceId: id, ...o }));
    } catch {
      /* 幂等：忽略已断连错误 */
    }
  }

  async writePacket(bytes: Uint8Array): Promise<void> {
    if (!this.deviceId) throw new TransportError("not-connected", "not connected");
    if (bytes.length > this.mtuPayloadBytes) {
      throw new TransportError("invalid-data", `packet ${bytes.length}B > mtu ${this.mtuPayloadBytes}B`);
    }
    // §4.1：value 必须是 ArrayBuffer，由 Uint8Array 精确切片复制而来；不显式传 writeType
    const buf = bytes.slice().buffer as ArrayBuffer;
    try {
      await call<void>((o) =>
        wx.writeBLECharacteristicValue({
          deviceId: this.deviceId!,
          serviceId: this.serviceUuid,
          characteristicId: GATT_CMD_UUID,
          value: buf,
          ...o,
        }),
      );
    } catch (err) {
      const e = err instanceof TransportError ? err : mapWxError(err as { errCode?: number; errMsg?: string });
      if (e.kind === "not-connected") this.emitDisconnect(e);
      throw e;
    }
  }

  onNotify(cb: (chunk: Uint8Array) => void): Unsubscribe {
    if (this.notifyCbs.length === 0) {
      wx.onBLECharacteristicValueChange((res) => {
        if (this.deviceId && res.deviceId === this.deviceId && res.characteristicId === GATT_RSP_UUID) {
          const chunk = new Uint8Array(res.value);
          for (const c of this.notifyCbs) c(chunk);
        }
      });
    }
    this.notifyCbs.push(cb);
    return () => { this.notifyCbs = this.notifyCbs.filter((x) => x !== cb); };
  }

  onDisconnect(cb: (err: TransportError) => void): Unsubscribe {
    if (this.disconnectCbs.length === 0) {
      // 断连双路径①：onBLEConnectionStateChange(connected:false)
      wx.onBLEConnectionStateChange((res) => {
        if (this.deviceId && res.deviceId === this.deviceId && !res.connected) {
          this.emitDisconnect(new TransportError("not-connected", "BLE link lost"));
        }
      });
    }
    this.disconnectCbs.push(cb);
    return () => { this.disconnectCbs = this.disconnectCbs.filter((x) => x !== cb); };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.scanning) { this.stopScan(); }
    if (this.deviceId) {
      try { await this.disconnect(); } catch { /* ignore */ }
    }
    if (this.adapterOpened) {
      try {
        await call<void>((o) => wx.closeBluetoothAdapter({ ...o }));
      } catch { /* ignore */ }
    }
    this.adapterOpened = false;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private ensureAdapter(): void {
    if (this.adapterOpened || this.disposed) return;
    wx.openBluetoothAdapter({
      fail: (err) => this.onUnexpectedErr(err),
    });
    this.adapterOpened = true;
  }

  private createConnection(deviceId: string, timeoutMs: number): Promise<void> {
    return call<void>((o) =>
      wx.createBLEConnection({
        deviceId,
        timeout: timeoutMs,
        ...o,
      }),
    ).then(
      () => undefined,
      (err: { errCode?: number; errMsg?: string }) => {
        // errCode === -1（已在连接）视为成功（§7.1）
        if (err?.errCode === -1) return;
        throw mapWxError(err);
      },
    );
  }

  private async discoverAndSubscribe(deviceId: string): Promise<void> {
    const svc = await call<{ services: Array<{ uuid: string }> }>((o) =>
      wx.getBLEDeviceServices({ deviceId, ...o }),
    );
    const services = svc.services ?? [];
    if (!services.some((s) => s.uuid === this.serviceUuid)) {
      throw new TransportError("service-missing", "service not found");
    }

    const chars = await call<{ characteristics: Array<{ uuid: string; properties: Record<string, boolean> }> }>((o) =>
      wx.getBLEDeviceCharacteristics({ deviceId, serviceId: this.serviceUuid, ...o }),
    );
    const cs = chars.characteristics ?? [];
    const cmd = cs.find((c) => c.uuid === GATT_CMD_UUID);
    const rsp = cs.find((c) => c.uuid === GATT_RSP_UUID);
    if (!cmd) throw new TransportError("characteristic-missing", "CMD characteristic not found");
    if (!rsp || !rsp.properties?.notify) throw new TransportError("characteristic-missing", "RSP notify characteristic not found");

    // 订阅 notify（§4.1 / protocol.md §16）
    await call<void>((o) =>
      wx.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId: this.serviceUuid,
        characteristicId: GATT_RSP_UUID,
        state: true,
        ...o,
      }),
    );
  }

  private refreshMtu(deviceId: string): void {
    if (!wx.canIUse("getBLEMTU")) return;
    wx.getBLEMTU({
      deviceId,
      success: (res) => {
        const mtu = res.mtu;
        this.mtuPayloadBytes = mtu > 0 ? mtu - 3 : FALLBACK_MTU;
      },
      fail: () => { this.mtuPayloadBytes = FALLBACK_MTU; },
    });
    wx.onBLEMTUChange((res) => {
      if (res.deviceId === deviceId) {
        this.mtuPayloadBytes = res.mtu > 0 ? res.mtu - 3 : FALLBACK_MTU;
      }
    });
  }

  private emitDisconnect(err: TransportError): void {
    this.deviceId = null;
    this.mtuPayloadBytes = FALLBACK_MTU;
    for (const cb of this.disconnectCbs) cb(err);
  }

  private onUnexpectedErr(err: { errCode?: number; errMsg?: string }): void {
    // 非预期错误：仅记录，不改变链路状态（页面看 onDisconnect）
    const e = mapWxError(err);
    if (e.kind === "not-connected") this.emitDisconnect(e);
  }
}