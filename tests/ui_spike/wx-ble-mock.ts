/**
 * wx-ble-mock：wxa-runner（浏览器）里的 BLE `wx.*` mock（spec §3.5 / 工单 #19）。
 *
 * 设计（按 research/test-automation-facts.md §2.4–§2.6 的机制）：
 * - mock 的是 **WxTransport 调用的 wx.* 函数**，不绕过 WxTransport：小程序仍走
 *   BleLink → WxTransport → wx.* 真实调用链，只是最底层的 wx 实现被替换。
 * - invoke 型（返回 Promise 的 API）：注册为 wxa-runner setup 的 `mock`，由
 *   ApiRegistry 拦截（键 = 基础库实际 invoke 的原生名，注意 notify 多个 `d`：
 *   wx.notifyBLECharacteristicValueChange → 原生 notifyBLECharacteristicValueChanged）。
 * - 事件型（on*）：保留基础库真实的 `wx.onXxx` 注册（WxTransport 构造期调用），
 *   由本 mock 在 FakeTransport 事件发生时经 `window.__wxaHost.emitToService`
 *   派发（事实底稿 §2.5 的官方外机制，源码验证可用）。
 * - 设备模型复用 `miniprogram/logic/test_utils/` 的 FakeTransport + FakeLightDevice
 *   （spec §3.6：设备模型同源，不出现第二套假蓝牙）。本文件由 wxa-runner 的
 *   esbuild 打进 wxa.setup.js，在浏览器里运行（可 import 小程序 TS 源码）。
 *
 * 运行环境：本文件只在浏览器（wxa.setup 打包产物）里执行，不被 Node 单测加载。
 */

import { FakeLightDevice } from "../../miniprogram/logic/test_utils/fake_device";
import { FakeTransport } from "../../miniprogram/logic/test_utils/fake_transport";
import type {
  BleCharacteristicInfo,
  BleDeviceInfo,
  BleServiceInfo,
} from "../../miniprogram/logic/transport";

/** 与页面（pages/index/index.ts，#14 GATT 布局）一致的 Service / 特征值。 */
export const SERVICE_ID = "0000ffe0-0000-1000-8000-00805f9b34fb";
export const CMD_CHAR_ID = "0000ffe1-0000-1000-8000-00805f9b34fb";
export const RSP_CHAR_ID = "0000ffe2-0000-1000-8000-00805f9b34fb";
export const DEVICE_ID = "C3-A1";
export const DEVICE_NAME = "BLELight-C3";

/** wxa-runner 宿主（browser 全局，非文档 API）；事件型 wx.on* 的派发通道。 */
interface WxaHostLike {
  emitToService(event: string, data: unknown, webviewId?: number): void;
}

export interface WxBleMock {
  /** setup `mock` 映射：键为原生 invoke 名（notify 带 d），值为 ApiRegistry handler。 */
  readonly invokeMocks: Record<string, (args: unknown) => Promise<unknown>>;
  readonly transport: FakeTransport;
  readonly device: FakeLightDevice;
}

/** 失败原样保留 errCode：baselib 收到 `{errCode, errMsg}` 会 reject 带 errCode 的 Error。 */
async function guard<T>(api: string, run: () => Promise<T>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    const failure = error as { errCode?: number; errMsg?: string };
    const errCode = typeof failure?.errCode === "number" ? failure.errCode : -1;
    const errMsg = failure?.errMsg ?? String(error);
    return { errCode, errMsg: `${api}:fail ${errMsg}` };
  }
}

function arg(args: unknown, key: string): unknown {
  if (typeof args !== "object" || args === null) return undefined;
  return (args as Record<string, unknown>)[key];
}

function str(args: unknown, key: string): string {
  const value = arg(args, key);
  return typeof value === "string" ? value : "";
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64 -> 原始字节（mock 收到的 write value 是 base64 字符串，见事实底稿 §2.6）。 */
export function fromBase64(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let pos = 0;
  for (const ch of clean) {
    const value = B64_ALPHABET.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos] = (buffer >> bits) & 0xff;
      pos += 1;
      // 只保留尚未成字节的低位，否则长输入会溢出 32 位整型
      buffer &= (1 << bits) - 1;
    }
  }
  return out.slice(0, pos);
}

/** 原始字节 -> base64（通知 value 必须转成 base64 字符串再派发，由基础库转回 ArrayBuffer）。 */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function toNativeDevice(device: BleDeviceInfo): Record<string, unknown> {
  const native: Record<string, unknown> = { deviceId: device.deviceId };
  if (device.name !== undefined) native["name"] = device.name;
  if (device.localName !== undefined) native["localName"] = device.localName;
  if (device.RSSI !== undefined) native["RSSI"] = device.RSSI;
  return native;
}

function emitToService(event: string, data: unknown): void {
  const host = (window as unknown as { __wxaHost?: WxaHostLike }).__wxaHost;
  if (host?.emitToService === undefined) {
    console.warn(`[wx-ble-mock] window.__wxaHost 不可用，丢弃事件 ${event}`);
    return;
  }
  host.emitToService(event, data);
}

/**
 * 创建一套 BLE mock 环境：FakeTransport + FakeLightDevice + wx 映射。
 * 在浏览器（wxa.setup 打包后）里调用一次，导出给 setup 的 mock 表使用。
 */
export function createWxBleMock(): WxBleMock {
  const services: BleServiceInfo[] = [{ uuid: SERVICE_ID, isPrimary: true }];
  const characteristics: Record<string, BleCharacteristicInfo[]> = {
    [SERVICE_ID]: [
      {
        uuid: CMD_CHAR_ID,
        properties: { read: false, write: false, writeNoResponse: true, notify: false, indicate: false },
      },
      {
        uuid: RSP_CHAR_ID,
        properties: { read: false, write: false, writeNoResponse: false, notify: true, indicate: false },
      },
    ],
  };
  const transport = new FakeTransport({
    platform: "android",
    devices: [{ deviceId: DEVICE_ID, name: DEVICE_NAME, RSSI: -50 }],
    services,
    characteristics,
    // 与 Node 单测相同的接线：写入字节流进 FakeLightDevice 的协议解析（不另建第二套假蓝牙）
    mtu: 247,
    onWrite: (bytes) => device.onWrite(bytes),
  });
  const device = new FakeLightDevice(transport, {});

  // 事件型 wx.on*：保留基础库真实注册，FakeTransport 事件经 __wxaHost.emitToService 派发。
  transport.onDeviceFound((devices) => {
    emitToService("onBluetoothDeviceFound", { devices: devices.map(toNativeDevice) });
  });
  transport.onConnectionStateChange((state) => {
    emitToService("onBLEConnectionStateChange", { deviceId: state.deviceId, connected: state.connected });
  });
  transport.onNotification((notification) => {
    emitToService("onBLECharacteristicValueChange", {
      deviceId: notification.deviceId,
      serviceId: notification.serviceId,
      characteristicId: notification.characteristicId,
      // 通知 value 必须转成 base64 字符串再派发，基础库会转回 ArrayBuffer（事实底稿 §2.6）
      value: toBase64(new Uint8Array(notification.value)),
    });
  });
  transport.onMtuChange((change) => {
    emitToService("onBLEMTUChange", { deviceId: change.deviceId, mtu: change.mtu });
  });

  // invoke 型 wx.*：键为原生 invoke 名（notify 带 d，write 的 value 是 base64）。
  const invokeMocks: Record<string, (args: unknown) => Promise<unknown>> = {
    openBluetoothAdapter: () => guard("openBluetoothAdapter", () => transport.openAdapter()),
    closeBluetoothAdapter: () => guard("closeBluetoothAdapter", () => transport.closeAdapter()),
    startBluetoothDevicesDiscovery: (args) =>
      guard("startBluetoothDevicesDiscovery", async () => {
        const services = arg(args, "services");
        await transport.startDiscovery(Array.isArray(services) ? (services as string[]) : undefined);
      }),
    stopBluetoothDevicesDiscovery: () => guard("stopBluetoothDevicesDiscovery", () => transport.stopDiscovery()),
    getBluetoothDevices: () =>
      guard("getBluetoothDevices", async () => ({ devices: (await transport.getDevices()).map(toNativeDevice) })),
    createBLEConnection: (args) => guard("createBLEConnection", () => transport.connect(str(args, "deviceId"))),
    closeBLEConnection: (args) => guard("closeBLEConnection", () => transport.disconnect(str(args, "deviceId"))),
    getBLEDeviceServices: (args) =>
      guard("getBLEDeviceServices", async () => ({ services: await transport.getServices(str(args, "deviceId")) })),
    getBLEDeviceCharacteristics: (args) =>
      guard("getBLEDeviceCharacteristics", async () => ({
        characteristics: await transport.getCharacteristics(str(args, "deviceId"), str(args, "serviceId")),
      })),
    notifyBLECharacteristicValueChanged: (args) =>
      guard("notifyBLECharacteristicValueChanged", () =>
        transport.setNotification(
          str(args, "deviceId"),
          str(args, "serviceId"),
          str(args, "characteristicId"),
          arg(args, "state") === true,
        ),
      ),
    writeBLECharacteristicValue: (args) =>
      guard("writeBLECharacteristicValue", () => {
        const writeType = arg(args, "writeType");
        return transport.write(
          str(args, "deviceId"),
          str(args, "serviceId"),
          str(args, "characteristicId"),
          fromBase64(str(args, "value")).buffer,
          writeType === "write" || writeType === "writeNoResponse" ? writeType : undefined,
        );
      }),
    setBLEMTU: (args) =>
      guard("setBLEMTU", () => {
        const mtu = arg(args, "mtu");
        return transport.setMtu(str(args, "deviceId"), typeof mtu === "number" ? mtu : 23);
      }),
    getBLEMTU: (args) =>
      guard("getBLEMTU", async () => ({ mtu: await transport.getMtu(str(args, "deviceId")) })),
  };

  return { invokeMocks, transport, device };
}