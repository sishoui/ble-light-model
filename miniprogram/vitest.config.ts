import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["logic/**/*.test.ts"],
    coverage: {
      // 默认开启：CI 直接 npm test 即强制行覆盖阈值（spec §6 / 工单 #12）。
      enabled: true,
      provider: "v8",
      include: ["logic/**/*.ts"],
      exclude: ["logic/**/*.test.ts", "logic/test_utils/**"],
      thresholds: {
        // 逻辑层行覆盖 >= 90%（spec §3.1 / §6）。
        lines: 90,
      },
    },
  },
});