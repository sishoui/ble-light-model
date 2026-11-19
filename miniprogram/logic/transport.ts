/**
 * Transport 接口（spec §1.1 四层单向依赖的最底层抽象）：
 * 逻辑层与微信运行时之间唯一的字节通道。Transport 只负责字节进出、连接状态事件与
 * MTU，不含任何协议语义；协议语义在 Codec，连接编排在 BleLink。
 *
 * 本文件是纯类型 + 类型守卫，不引用任何 wx / Page / Component / getApp（CI 强制）。
 * 微信实现 `WxTransport` 在 `miniprogram/transport/`，是唯一允许触碰 wx 的模块。
 *
 * 失败语义：所有异步方法失败时 reject 原始失败形状 `{ errCode, errMsg }`（errCode 原样
 * 保留，见 GLOSSARY「领域错误」），由 BleLink 统一映射为领域错误；调用方不应裸判 errCode。
 */

/** 扫描 / 连接目标设备（wx 的 getBluetoothDevices 与 onBluetoothDeviceFound 的归一形状）。 */
export interface BleDeviceInfo {
  deviceId: string;
  name?: string;
  localName?: string;
  RSSI?: number;
  advertisData?: ArrayBuffer;
}

/** GATT 服务。 */
export interface BleServiceInfo {
  uuid: string;
  isPrimary: boolean;
}

/** GATT 特征属性（wx 的 getBLEDeviceCharacteristics 的 properties 归一形状）。 */
export interface BleCharacteristicProperties {
  read: boolean;
  write: boolean;
  writeNoResponse: boolean;
  notify: boolean;
  indicate: boolean;
}

/** GATT 特征。 */
export interface BleCharacteristicInfo {
  uuid: string;
  properties: BleCharacteristicProperties;
}

/** 特征值通知（wx 的 onBLECharacteristicValueChange 的归一形状）。 */
export interface BleNotification {
  deviceId: string;
  serviceId: string;
  characteristicId: string;
  value: ArrayBuffer;
}

/** 连接状态事件（wx 的 onBLEConnectionStateChange 的归一形状，无 errCode）。 */
export interface BleConnectionState {
  deviceId: string;
  connected: boolean;
}

/** MTU 变化事件（wx 的 onBLEMTUChange 的归一形状，仅安卓触发）。 */
export interface BleMtuChange {
  deviceId: string;
  /** ATT_MTU，含 3 字节 ATT header；真实 payload = mtu − 3。 */
  mtu: number;
}

/** 写模式（wx 的 writeBLECharacteristicValue 的 writeType，基础库 2.22.0+）。 */
export type WriteType = "write" | "writeNoResponse";

/** 平台标识（决定是否尝试安卓 MTU 协商）。 */
export type Platform = "android" | "ios" | "other";

/** wx BLE API 的原始失败形状；errCode 必须原样保留。 */
export interface BleTransportFailure {
  errCode: number;
  errMsg?: string;
}

export function isBleTransportFailure(value: unknown): value is BleTransportFailure {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { errCode?: unknown };
  return typeof candidate.errCode === "number";
}

/**
 * 传输层接口。实现者：`WxTransport`（wx 薄壳）、`FakeTransport`（Node 单测替身）。
 * 事件监听在构造期一次性注册（wx 的 onXxx 无对应 off 返回句柄），实现需保证同一监听
 * 函数可重复注册且长期有效；BleLink 在构造时注册，生命周期与自身一致。
 */
export interface Transport {
  /** 当前平台；BleLink 据此决定是否做安卓 MTU 协商。 */
  platform(): Platform;

  /** 初始化蓝牙适配器（wx 的 openBluetoothAdapter）。 */
  openAdapter(): Promise<void>;
  /** 关闭蓝牙适配器（wx 的 closeBluetoothAdapter）。 */
  closeAdapter(): Promise<void>;

  /** 开始扫描（wx 的 startBluetoothDevicesDiscovery）；services 为空表示不过滤。 */
  startDiscovery(services?: string[]): Promise<void>;
  /** 停止扫描（wx 的 stopBluetoothDevicesDiscovery）。 */
  stopDiscovery(): Promise<void>;
  /** 已扫到的设备（wx 的 getBluetoothDevices）。 */
  getDevices(): Promise<BleDeviceInfo[]>;

  /** 连接设备（wx 的 createBLEConnection）；errCode -1（already connect）视为已连接由上层处理。 */
  connect(deviceId: string): Promise<void>;
  /** 主动断开（wx 的 closeBLEConnection）。 */
  disconnect(deviceId: string): Promise<void>;

  /** 发现服务（wx 的 getBLEDeviceServices）。 */
  getServices(deviceId: string): Promise<BleServiceInfo[]>;
  /** 发现特征（wx 的 getBLEDeviceCharacteristics）。 */
  getCharacteristics(deviceId: string, serviceId: string): Promise<BleCharacteristicInfo[]>;

  /** 开关通知（wx 的 notifyBLECharacteristicValueChange）。 */
  setNotification(
    deviceId: string,
    serviceId: string,
    characteristicId: string,
    enabled: boolean,
  ): Promise<void>;

  /**
   * 写特征值（wx 的 writeBLECharacteristicValue）。
   * value 必须是 ArrayBuffer（官方硬约束）；串行化 / 超时 / 分片由 BleLink 负责，
   * Transport 只做一次原样写入。
   */
  write(
    deviceId: string,
    serviceId: string,
    characteristicId: string,
    value: ArrayBuffer,
    writeType?: WriteType,
  ): Promise<void>;

  /** 协商 MTU（wx 的 setBLEMTU，仅安卓 5.1+ 有效；success 回显不可信）。 */
  setMtu(deviceId: string, mtu: number): Promise<void>;
  /** 读取真实 ATT_MTU（wx 的 getBLEMTU）；payload = mtu − 3。 */
  getMtu(deviceId: string): Promise<number>;

  /** 扫描到设备（含重复广播；去重由 BleLink 负责）。 */
  onDeviceFound(listener: (devices: BleDeviceInfo[]) => void): void;
  /** 连接状态变化（含主动 / 被动断连；这是断连路径①）。 */
  onConnectionStateChange(listener: (state: BleConnectionState) => void): void;
  /** 特征值通知数据。 */
  onNotification(listener: (notification: BleNotification) => void): void;
  /** MTU 协商完成（仅安卓；断连路径之外的分片依据）。 */
  onMtuChange(listener: (change: BleMtuChange) => void): void;
}