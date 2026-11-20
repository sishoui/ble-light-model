// Transport 接口、错误类型与 DeviceAdvertisement（miniprogram.md §3）。
// 只有类型：WxTransport / PcBleTransport / FakeTransport 各自实现本接口。
// 纯类型模块，无运行时代码、无 wx、无平台 API。

export type DeviceId = string;

export interface DeviceAdvertisement {
  deviceId: DeviceId; // 不透明：wx 是什么就是什么，Windows 是地址
  name: string;
  rssi: number;
}

export type TransportErrorKind =
  | "not-initialized"
  | "unsupported"
  | "adapter-unavailable"
  | "permission-denied"
  | "not-found"
  | "connect-failed"
  | "service-missing"
  | "characteristic-missing"
  | "not-connected"
  | "timeout"
  | "invalid-data"
  | "busy"
  | "bridge-unavailable"
  | "system";

export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly code?: number; // 平台原始错误码，仅供诊断

  constructor(kind: TransportErrorKind, message: string, code?: number) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    this.code = code;
  }
}

export type Unsubscribe = () => void;

export interface Transport {
  startScan(filter: { serviceUuid: string; namePrefix?: string }): void;
  stopScan(): void;
  onDeviceFound(cb: (adv: DeviceAdvertisement) => void): Unsubscribe;

  /** 连接 + 服务/特征发现 + 订阅通知；resolve 时链路可用 */
  connect(deviceId: DeviceId, opts?: { timeoutMs?: number }): Promise<void>;
  disconnect(): Promise<void>;

  /** 写一个 BLE 包；调用方保证 bytes.length <= mtuPayloadBytes */
  writePacket(bytes: Uint8Array): Promise<void>;
  onNotify(cb: (chunk: Uint8Array) => void): Unsubscribe;
  /** 仅非预期断连；显式 disconnect() 不触发 */
  onDisconnect(cb: (err: TransportError) => void): Unsubscribe;

  /** 可用负载字节数；未连接时为保守回退值（20） */
  readonly mtuPayloadBytes: number;

  /** 断连 + 关适配器/杀桥；幂等 */
  dispose(): Promise<void>;
}