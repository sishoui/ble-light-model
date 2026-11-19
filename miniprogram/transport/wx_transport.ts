/**
 * WxTransport：对 wx.* BLE API 的 1:1 薄壳（GLOSSARY / spec §1.1）。
 *
 * 整个工程里唯一允许触碰微信运行时的模块（位于 logic/ 之外，CI check-purity 不覆盖；
 * 逻辑层单测用 FakeTransport 顶替，不加载本文件）。职责边界：
 * - 回调 / Promise 归一：异步 API 直接用 Promise 风格（基础库 2.10.2+）。
 * - 失败原样 reject `{ errCode, errMsg }`（保留原始码，领域错误映射在 BleLink）。
 * - 不做写串行化 / 分片 / 超时 / 重连 —— 那些是 BleLink 的职责。
 *
 * 真机薄壳的完整实现（writeType 按特征属性推导的兜底、setBLEMTU 兼容性、iOS uuid
 * 处理、错误回调归一等打磨）是工单 #16 的事；本骨架保证接口完整、可编译。
 */

import type {
  BleCharacteristicInfo,
  BleConnectionState,
  BleDeviceInfo,
  BleMtuChange,
  BleNotification,
  BleServiceInfo,
  Platform,
  Transport,
  WriteType,
} from "../logic/transport";
import { getWx } from "./wx_api";
import type { WxApi } from "./wx_api";

export class WxTransport implements Transport {
  private readonly wxApi: WxApi;
  private readonly deviceFoundListeners = new Set<(devices: BleDeviceInfo[]) => void>();
  private readonly connectionListeners = new Set<(state: BleConnectionState) => void>();
  private readonly notificationListeners = new Set<(notification: BleNotification) => void>();
  private readonly mtuListeners = new Set<(change: BleMtuChange) => void>();

  constructor(wxApi: WxApi = getWx()) {
    this.wxApi = wxApi;
    this.wxApi.onBluetoothDeviceFound((result) => {
      for (const listener of this.deviceFoundListeners) listener(result.devices);
    });
    this.wxApi.onBLEConnectionStateChange((result) => {
      for (const listener of this.connectionListeners) listener(result);
    });
    this.wxApi.onBLECharacteristicValueChange((result) => {
      for (const listener of this.notificationListeners) listener(result);
    });
    this.wxApi.onBLEMTUChange((result) => {
      for (const listener of this.mtuListeners) listener(result);
    });
  }

  platform(): Platform {
    const platform = this.wxApi.getDeviceInfo?.().platform;
    if (platform === "android" || platform === "ios") return platform;
    return "other";
  }

  async openAdapter(): Promise<void> {
    await this.wxApi.openBluetoothAdapter();
  }

  async closeAdapter(): Promise<void> {
    await this.wxApi.closeBluetoothAdapter();
  }

  async startDiscovery(services?: string[]): Promise<void> {
    const options: { allowDuplicatesKey?: boolean; services?: string[] } = { allowDuplicatesKey: true };
    if (services !== undefined) options.services = services;
    await this.wxApi.startBluetoothDevicesDiscovery(options);
  }

  async stopDiscovery(): Promise<void> {
    await this.wxApi.stopBluetoothDevicesDiscovery();
  }

  async getDevices(): Promise<BleDeviceInfo[]> {
    const { devices } = await this.wxApi.getBluetoothDevices();
    return devices.map((device) => ({ ...device }));
  }

  async connect(deviceId: string): Promise<void> {
    await this.wxApi.createBLEConnection({ deviceId });
  }

  async disconnect(deviceId: string): Promise<void> {
    await this.wxApi.closeBLEConnection({ deviceId });
  }

  async getServices(deviceId: string): Promise<BleServiceInfo[]> {
    const { services } = await this.wxApi.getBLEDeviceServices({ deviceId });
    return services.map((service) => ({ uuid: service.uuid, isPrimary: service.isPrimary }));
  }

  async getCharacteristics(deviceId: string, serviceId: string): Promise<BleCharacteristicInfo[]> {
    const { characteristics } = await this.wxApi.getBLEDeviceCharacteristics({ deviceId, serviceId });
    return characteristics.map((characteristic) => ({
      uuid: characteristic.uuid,
      properties: { ...characteristic.properties },
    }));
  }

  async setNotification(
    deviceId: string,
    serviceId: string,
    characteristicId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.wxApi.notifyBLECharacteristicValueChange({
      deviceId,
      serviceId,
      characteristicId,
      state: enabled,
    });
  }

  async write(
    deviceId: string,
    serviceId: string,
    characteristicId: string,
    value: ArrayBuffer,
    writeType?: WriteType,
  ): Promise<void> {
    const options: {
      deviceId: string;
      serviceId: string;
      characteristicId: string;
      value: ArrayBuffer;
      writeType?: WriteType;
    } = { deviceId, serviceId, characteristicId, value };
    if (writeType !== undefined) options.writeType = writeType;
    await this.wxApi.writeBLECharacteristicValue(options);
  }

  async setMtu(deviceId: string, mtu: number): Promise<void> {
    // success 回显的 mtu 不可信，真实值由 getMtu / onBLEMTUChange 提供，这里丢弃返回值。
    await this.wxApi.setBLEMTU({ deviceId, mtu });
  }

  async getMtu(deviceId: string): Promise<number> {
    const { mtu } = await this.wxApi.getBLEMTU({ deviceId });
    return mtu;
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
}