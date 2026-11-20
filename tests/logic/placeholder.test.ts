// 骨架占位测试（test-strategy.md 层 1 Node 侧）。
// 本文件只验证脚手架链路（workspace 解析 + 加载 dist 产物）通，不是真业务用例。
// 执行阶段在此目录按 `tests/scenarios/*.json` 写真实单测，vitest 测 `dist` 而非 `src`。

import { describe, expect, it } from "vitest";
import { LOGIC_LAYER_VERSION } from "@ble-light/logic";

describe("scaffold", () => {
  it("workspace 解析并加载 logic/dist", () => {
    expect(LOGIC_LAYER_VERSION).toBe("0.1.0");
  });
});