// Ambient declarations for the WeChat mini-program `wx` global, used only by the
// transport layer (miniprogram/transport/*.ts) per docs/spec/miniprogram.md §1.
// These are the minimal surface the transport needs; full typings live in the
// miniprogram SDK which is not available to the Node host typecheck.

declare namespace wx {
  interface Err {
    errCode?: number;
    errMsg?: string;
  }
  interface BleDevice {
    deviceId: string;
    name: string;
    RSSI: number;
  }
  interface Service {
    uuid: string;
  }
  interface Characteristic {
    uuid: string;
    properties: { read?: boolean; write?: boolean; notify?: boolean };
  }
  interface OnBluetoothDeviceFoundResult {
    devices: BleDevice[];
  }
  interface BLEMTUResult {
    mtu: number;
  }
  interface StateResult {
    state: "available" | "unavailable" | "unknown";
  }

  function openBluetoothAdapter(opts: {
    success?: () => void;
    fail?: (err: Err) => void;
  }): void;
  function closeBluetoothAdapter(opts?: { success?: () => void; fail?: (err: Err) => void }): void;
  function startBluetoothDevicesDiscovery(opts: {
    services?: string[];
    allowDuplicatesKey?: boolean;
    success?: () => void;
    fail?: (err: Err) => void;
  }): void;
  function stopBluetoothDevicesDiscovery(opts?: { success?: () => void; fail?: (err: Err) => void }): void;
  function onBluetoothDeviceFound(cb: (res: OnBluetoothDeviceFoundResult) => void): void;
  function offBluetoothDeviceFound(cb?: (res: OnBluetoothDeviceFoundResult) => void): void;
  function onBluetoothAdapterStateChange(cb: (res: StateResult) => void): void;
  function offBluetoothAdapterStateChange(cb?: (res: StateResult) => void): void;
  function createBLEConnection(opts: {
    deviceId: string;
    timeout?: number;
    success?: () => void;
    fail?: (err: Err) => void;
  }): void;
  function closeBLEConnection(opts: { deviceId: string; success?: () => void; fail?: (err: Err) => void }): void;
  function getBLEDeviceServices(opts: {
    deviceId: string;
    success?: (res: { services: Service[] }) => void;
    fail?: (err: Err) => void;
  }): void;
  function getBLEDeviceCharacteristics(opts: {
    deviceId: string;
    serviceId: string;
    success?: (res: { characteristics: Characteristic[] }) => void;
    fail?: (err: Err) => void;
  }): void;
  function notifyBLECharacteristicValueChange(opts: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    state: boolean;
    success?: () => void;
    fail?: (err: Err) => void;
  }): void;
  function writeBLECharacteristicValue(opts: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    value: ArrayBuffer;
    writeType?: string;
    success?: () => void;
    fail?: (err: Err) => void;
  }): void;
  function onBLECharacteristicValueChange(cb: (res: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    value: ArrayBuffer;
  }) => void): void;
  function offBLECharacteristicValueChange(cb?: (res: {
    deviceId: string;
    serviceId: string;
    characteristicId: string;
    value: ArrayBuffer;
  }) => void): void;
  function onBLEConnectionStateChange(cb: (res: { deviceId: string; connected: boolean }) => void): void;
  function offBLEConnectionStateChange(cb?: (res: { deviceId: string; connected: boolean }) => void): void;
  function getBLEMTU(opts: {
    deviceId: string;
    success?: (res: BLEMTUResult) => void;
    fail?: (err: Err) => void;
  }): void;
  function onBLEMTUChange(cb: (res: { deviceId: string; mtu: number }) => void): void;
  function offBLEMTUChange(cb?: (res: { deviceId: string; mtu: number }) => void): void;
  function canIUse(api: string): boolean;
  function getStorageSync(key: string): unknown;
}

declare const wx: typeof wx; // value for call sites: `wx.openBluetoothAdapter(...)`