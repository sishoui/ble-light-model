/**
 * wx.* BLE API 的最小类型声明与访问器（仅覆盖 WxTransport 用到的 API 面）。
 *
 * 官方不提供 @types/weixin-app；这里按 research/wx-ble-facts.md 核查过的官方文档形状
 * 手写（异步 API 在基础库 2.10.2+ 支持 Promise 风格，无需 success/fail 回调）。
 * 真机薄壳的完整实现（错误回调归一、兼容处理等）是工单 #16 的事；本文件只保证
 * WxTransport 可以脱离微信运行时被 tsc 检查。
 */

/** wx 异步 API 的失败形状（与 Transport 的原始失败形状一致）。 */
export interface WxFailure {
  errCode: number;
  errMsg: string;
}

export interface WxBluetoothDevice {
  deviceId: string;
  name?: string;
  localName?: string;
  RSSI?: number;
  advertisData?: ArrayBuffer;
}

export interface WxBleService {
  uuid: string;
  isPrimary: boolean;
}

export interface WxBleCharacteristicProperties {
  read: boolean;
  write: boolean;
  writeNoResponse: boolean;
  notify: boolean;
  indicate: boolean;
}

export interface WxBleCharacteristic {
  uuid: string;
  properties: WxBleCharacteristicProperties;
}

export interface WxBleNotificationResult {
  deviceId: string;
  serviceId: string;
  characteristicId: string;
  value: ArrayBuffer;
}

export interface WxBleConnectionStateResult {
  deviceId: string;
  connected: boolean;
}

export interface WxBleMtuChangeResult {
  deviceId: string;
  mtu: number;
}

/** WxTransport 用到的 wx.* BLE API 子集（全部为 Promise 风格）。 */
export interface WxApi {
  getDeviceInfo?(): { platform?: string };
  openBluetoothAdapter(): Promise<unknown>;
  closeBluetoothAdapter(): Promise<unknown>;
  startBluetoothDevicesDiscovery(options: { allowDuplicatesKey?: boolean; services?: string[] }): Promise<unknown>;
  stopBluetoothDevicesDiscovery(): Promise<unknown>;
  getBluetoothDevices(): Promise<{ devices: WxBluetoothDevice[] }>;
  createBLEConnection(options: { deviceId: string }): Promise<unknown>;
  closeBLEConnection(options: { deviceId: string }): Promise<unknown>;
  getBLEDeviceServices(options: { deviceId: string }): Promise<{ services: WxBleService[] }>;
  getBLEDeviceCharacteristics(options: {
    deviceId: string;
    serviceId: string;
  }): Promise<{ characteristics: WxBleCharacteristic[] }>;
  notifyBLECharacteristicValueChange(options: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    state: boolean;
  }): Promise<unknown>;
  writeBLECharacteristicValue(options: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    value: ArrayBuffer;
    writeType?: "write" | "writeNoResponse";
  }): Promise<unknown>;
  setBLEMTU(options: { deviceId: string; mtu: number }): Promise<{ mtu: number }>;
  getBLEMTU(options: { deviceId: string }): Promise<{ mtu: number }>;
  onBluetoothDeviceFound(callback: (result: { devices: WxBluetoothDevice[] }) => void): void;
  onBLEConnectionStateChange(callback: (result: WxBleConnectionStateResult) => void): void;
  onBLECharacteristicValueChange(callback: (result: WxBleNotificationResult) => void): void;
  onBLEMTUChange(callback: (result: WxBleMtuChangeResult) => void): void;
}

/** 取全局 wx；宿主未提供时抛错（Node 单测不加载本文件，由 FakeTransport 顶替）。 */
export function getWx(): WxApi {
  const candidate = (globalThis as { wx?: WxApi }).wx;
  if (candidate === undefined) {
    throw new Error("当前宿主没有 wx 对象（WxTransport 只在微信小程序运行时可用）");
  }
  return candidate;
}