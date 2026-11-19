import { defineConfig } from "@playwright/test";
import type { WxaOptions } from "@open-wxa/wxa-runner-playwright";

export default defineConfig<WxaOptions>({
  testDir: "./e2e",
  // spike 单用例，串行足够：每个 worker 启动一个 wxa-runner dev server
  workers: 1,
  fullyParallel: false,
  use: {
    channel: "chrome",
    // 与开发者工具/真机同一份构建（dist/miniprogram，见 miniprogram/scripts/build-dist.mjs）
    wxaProject: "../../dist/miniprogram",
    wxaServerOptions: {
      baseLibVersion: "3.7.0", // vendored 内置基础库（同 vendor/wxa-baselib/3.7.0）
      setup: "./wxa.setup.ts",
      // 以安卓环境模拟，驱动 BleLink 的 MTU 协商分支（setBLEMTU/getBLEMTU/onBLEMTUChange）
      device: { platform: "android" },
      forwardConsole: "errors",
    },
    wxaCheckErrors: true, // 结束时断言 errors() 为空：保证没漏 mock 任何 wx 调用
  },
});