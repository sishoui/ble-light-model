import { defineConfig } from "vitest/config";

// 层 1 Node 单测（test-strategy.md §1/§2）。vitest 测 `dist` 产物而非 `src`，
// 因此每测必须 import 自 @ble-light/logic（main -> dist/index.js），产物过期会立刻红。
export default defineConfig({
  test: {
    include: ["tests/logic/**/*.test.ts"],
    environment: "node",
  },
});