// 组合根 transport/factory.ts（miniprogram.md §9.2）。
// 选择 wx / fake：读 `wx.getStorageSync('__ble_transport')`，等于 'fake' 走 Fake（按场景名
// 构造），否则走真实 WxTransport。本文件属于 transport/，允许引用 wx。

import type { Transport } from "@ble-light/logic";
import { FakeTransport, type FakeTransportOptions } from "./fake-transport";
import { WxTransport, type WxTransportOptions } from "./wx-transport";

/** 命名场景 -> 可编排选项（§9.2：happy / nak / timeout / disconnect-recover / slow-connect）。
 * 命名场景的细节由页面测试在消费侧配置；这里只给默认 happy。 */
const SCENARIO_DEFAULTS: Record<string, FakeTransportOptions> = {
  happy: {},
  "disconnect-recover": {},
};

export interface CreateTransportOptions {
  serviceUuid?: string;
  namePrefix?: string;
}

/** §9.2：wx 存储里选 fake/real。 */
export function createTransport(opts?: CreateTransportOptions): Transport {
  const mode = wx.getStorageSync("__ble_transport");
  if (mode === "fake") {
    const scenario = String(wx.getStorageSync("__ble_fake_scenario") || "happy");
    return createFakeTransport(scenario);
  }
  return createWxTransport(opts);
}

/** 显式构造真实 WxTransport（也可由 app.ts 直接调用）。 */
export function createWxTransport(opts?: CreateTransportOptions): WxTransport {
  return new WxTransport(opts);
}

/** 显式构造 Fake（按命名场景；未知名场景回退 happy）。 */
export function createFakeTransport(scenario?: string): FakeTransport {
  const name = scenario || "happy";
  const opts = SCENARIO_DEFAULTS[name] ?? SCENARIO_DEFAULTS.happy;
  return new FakeTransport(opts);
}

export type { WxTransportOptions } from "./wx-transport";
export type { FakeTransportOptions } from "./fake-transport";