// 逻辑层唯一导出入口（miniprogram.md §2）。
// 导出 codec / BleLink / DeviceController / ViewState / Transport 类型 / Clock。
// run-all.mjs 依赖 `verifyVectors`，必须从此入口导出。

export {
  PROTOCOL_VERSION,
  MAGIC,
  FLAG_NEED_ACK,
  Type,
  NakCode,
  EFFECT_PARAM_LEN,
  DEFAULT_EFFECT_BITMAP,
  DEFAULT_CAPS,
  crc16,
  encode,
  slice20,
  encodeSetEffect,
  encodeAck,
  encodeNak,
  Feeder,
  verifyVectors,
} from "./codec";
export type { EncodeCommand, ParsedFrame, FeedEvent, FeederOptions } from "./codec";

export { BleLink, CommandError } from "./ble-link";
export type {
  LinkState,
  HelloCaps,
  Status,
  Scene,
  SceneStrip,
  CommandErrorKind,
  BleLinkOptions,
} from "./ble-link";

export { DeviceController, nakText, commandErrorText } from "./device-controller";
export type { DeviceControllerOptions } from "./device-controller";

export { STRIP_COUNT, allOnFromRows, emptyRowView, DEFAULT_ON_EFFECT_ID, DEFAULT_ON_PARAMS } from "./view-state";
export type { RowView, ViewState } from "./view-state";

export { RealClock, RealTimers, RealClockAndTimers, FakeClock } from "./clock";
export type { Clock, Timers, TimerHandle } from "./clock";

export { TransportError } from "./transport";
export type {
  DeviceId,
  DeviceAdvertisement,
  TransportErrorKind,
  Unsubscribe,
  Transport,
} from "./transport";

export const LOGIC_LAYER_VERSION = "0.1.0";