// 测试用 FakeTransport（miniprogram.md §4.3 / §9.2）。
// 复用 transport/fake-transport.ts 的生产可编排实现（同一份事实源），避免两份漂移。
// vitest 测 dist（@ble-light/logic），本文件只是转发。

export {
  FakeTransport,
} from "../../miniprogram/transport/fake-transport";
export type {
  FakeTransportOptions,
} from "../../miniprogram/transport/fake-transport";