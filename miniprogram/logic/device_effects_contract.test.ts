/**
 * 真机 automator 灯效期望表契约（工单 #18）：tests/device_automator/effects.json
 * 的 7 种灯效 payload 必须与页面默认参数下 encodeEffectPayload 的输出逐字节一致，
 * 防止手抄漂移导致真机场景 2 的 COM6 / STATUS 断言对不上。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EFFECT_IDS, encodeEffectPayload } from "./light_service";
import { effectParamLength } from "./codec";
import type { EffectParams } from "./light_service";

interface EffectRow {
  index: number;
  key: EffectParams["effect"];
  name: string;
  effectId: number;
  payloadHex: string;
  golden: string | null;
}

const table = JSON.parse(
  readFileSync(new URL("../../tests/device_automator/effects.json", import.meta.url), "utf8"),
) as { effects: EffectRow[] };

/** 页面默认参数（miniprogram/pages/index/index.ts data 默认值 + buildParams）。 */
function pageDefaultParams(key: EffectParams["effect"]): EffectParams {
  const color = { r: 255, g: 0, b: 0 };
  switch (key) {
    case "off":
      return { effect: "off" };
    case "static":
      return { effect: "static", color };
    case "breath":
      return { effect: "breath", color, periodMs: 2000, min: 0, max: 255 };
    case "gradient":
      return { effect: "gradient", from: color, to: { r: 0, g: 80, b: 255 }, periodMs: 2000, direction: 0 };
    case "rainbow":
      return { effect: "rainbow", speed: 5, saturation: 255, direction: 0 };
    case "flow":
      return { effect: "flow", color, speed: 5, length: 5, direction: 0 };
    case "twinkle":
      return { effect: "twinkle", color, density: 5, speed: 5 };
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

describe.each(table.effects)("灯效 $key（真机 automator 期望表）", (row) => {
  it("encodeEffectPayload 与 effects.json payloadHex 一致", () => {
    expect(EFFECT_IDS[row.key]).toBe(row.effectId);
    const payload = encodeEffectPayload(pageDefaultParams(row.key));
    // payload = effect_id(1) + 效果参数（effectParamLength 只数参数）
    const paramLen = effectParamLength(row.effectId);
    if (paramLen === null) throw new Error(`未知灯效 ${row.key}`);
    expect(payload.length).toBe(paramLen + 1);
    expect(toHex(payload)).toBe(row.payloadHex.toLowerCase());
  });
});