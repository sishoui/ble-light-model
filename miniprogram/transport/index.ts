// miniprogram/transport 导出入口。
// 供 app.ts（组合根）与 tests/logic/fake-transport.ts 引用同一组生产 Transport 实现。
// 不编译进 logic/dist（logic workspace 只编 src/）；本目录由小程序打包器 / Node 影子跑消费。

export { createTransport, createWxTransport, createFakeTransport } from "./factory";
export type { CreateTransportOptions } from "./factory";

export { WxTransport, GATT_SERVICE_UUID, GATT_CMD_UUID, GATT_RSP_UUID, mapWxError } from "./wx-transport";
export type { WxTransportOptions } from "./wx-transport";

export { PcBleTransport } from "./pc-transport";
export type { PcBleTransportOptions } from "./pc-transport";

export { FakeTransport } from "./fake-transport";
export type { FakeTransportOptions } from "./fake-transport";