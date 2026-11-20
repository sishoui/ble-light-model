// 可编排的 FakeTransport（miniprogram.md §4.3 / §9.2）。测试用，非生产代码。
// 只模拟「逻辑层需要看见的行为」，不做协议正确性。
// vitest 测 dist（@ble-light/logic），本文件由 tests/logic 引用。

import { TransportError } from "@ble-light/logic";
import type { DeviceAdvertisement, DeviceId, Transport, TransportErrorKind, Unsubscribe } from "@ble-light/logic";

export interface FakeTransportOptions {
  mtuPayloadBytes?: number;
  failConnect?: boolean;
  connectError?: TransportError;
  /** 写一包时触发（记录 + 可选回发 notify） */
  onWrite?: (pkt: Uint8Array) => void;
  /** 写永不 resolve（测单包写超时） */
  writeHangs?: boolean;
  /** 写立即失败 */
  writeError?: TransportError;
}

export class FakeTransport implements Transport {
  mtuPayloadBytes: number;
  private opts: FakeTransportOptions;
  private deviceCbs: Array<(adv: DeviceAdvertisement) => void> = [];
  private notifyCbs: Array<(chunk: Uint8Array) => void> = [];
  private disconnectCbs: Array<(err: TransportError) => void> = [];
  private scanning = false;
  private connected = false;
  private disposed = false;
  private connectedId: DeviceId | null = null;

  writes: Uint8Array[] = [];
  connectCalls = 0;
  scanStarts = 0;
  scanStops = 0;
  disconnectCalls = 0;
  devices: DeviceAdvertisement[] = [];

  constructor(opts?: FakeTransportOptions) {
    this.opts = opts ?? {};
    this.mtuPayloadBytes = this.opts.mtuPayloadBytes ?? 20;
  }

  startScan(_filter: { serviceUuid: string; namePrefix?: string }): void {
    this.scanStarts++;
    this.scanning = true;
  }

  stopScan(): void {
    this.scanStops++;
    this.scanning = false;
  }

  onDeviceFound(cb: (adv: DeviceAdvertisement) => void): Unsubscribe {
    this.deviceCbs.push(cb);
    return () => {
      this.deviceCbs = this.deviceCbs.filter((x) => x !== cb);
    };
  }

  connect(deviceId: DeviceId): Promise<void> {
    this.connectCalls++;
    if (this.opts.failConnect || this.opts.connectError) {
      return Promise.reject(this.opts.connectError ?? new TransportError("connect-failed", "fake connect failed"));
    }
    if (this.connected && deviceId === this.connectedId) return Promise.resolve();
    this.connected = true;
    this.connectedId = deviceId;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connected = false;
    this.connectedId = null;
    return Promise.resolve();
  }

  writePacket(bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice();
    this.writes.push(copy);
    if (this.opts.onWrite) {
      this.opts.onWrite(copy);
    }
    if (this.opts.writeHangs) {
      return new Promise<void>(() => {
        /* 永不 resolve：触发单包写超时 */
      });
    }
    if (this.opts.writeError) {
      return Promise.reject(this.opts.writeError);
    }
    return Promise.resolve();
  }

  onNotify(cb: (chunk: Uint8Array) => void): Unsubscribe {
    this.notifyCbs.push(cb);
    return () => {
      this.notifyCbs = this.notifyCbs.filter((x) => x !== cb);
    };
  }

  onDisconnect(cb: (err: TransportError) => void): Unsubscribe {
    this.disconnectCbs.push(cb);
    return () => {
      this.disconnectCbs = this.disconnectCbs.filter((x) => x !== cb);
    };
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // 编排（测试用）
  // -------------------------------------------------------------------------

  get connectedDevice(): DeviceId | null {
    return this.connectedId;
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  addDevice(adv: DeviceAdvertisement): void {
    this.devices.push(adv);
    for (const cb of this.deviceCbs) cb(adv);
  }

  emitNotify(chunk: Uint8Array | number[]): void {
    const arr = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
    for (const cb of this.notifyCbs) cb(arr);
  }

  emitDisconnect(err?: TransportError): void {
    this.connected = false;
    this.connectedId = null;
    const e = err ?? new TransportError("not-connected" as TransportErrorKind, "fake disconnect");
    for (const cb of this.disconnectCbs) cb(e);
  }
}