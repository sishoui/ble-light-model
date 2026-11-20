// 设备页视图快照（miniprogram.md §8.1）。
// 纯类型 + 派生逻辑，无平台 API。

import { LinkState } from "./ble-link";

export interface RowView {
  strip: number;
  on: boolean; // effectId !== 0
  effectId: number;
  params: Uint8Array; // 当前效果参数（RGB 布局）
  pending: boolean; // 乐观中，等 ACK
  error: string | null;
}

export interface ViewState {
  link: LinkState;
  banner: string | null; // 「正在连接…」「重连中…」或错误文案
  allOn: boolean; // 派生：任一 strip 的 effectId !== 0
  rows: RowView[]; // 恒 8 条
}

export const STRIP_COUNT = 8;

export function allOnFromRows(rows: RowView[]): boolean {
  return rows.some((r) => r.effectId !== 0);
}

export function emptyRowView(strip: number): RowView {
  return {
    strip,
    on: false,
    effectId: 0,
    params: new Uint8Array(0),
    pending: false,
    error: null,
  };
}

/** 默认静态白（effects.md §7）：无 last_on 时的开灯默认 */
export const DEFAULT_ON_EFFECT_ID = 0x01;
export const DEFAULT_ON_PARAMS: ReadonlyArray<number> = [128, 128, 128];