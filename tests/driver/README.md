# C core host 单测（firmware/[env:native]）

层 1 C 侧。用例清单 D1–D16 见 `docs/spec/driver.md` §7。与 `firmware/driver`、`firmware/effects`、`firmware/proto` 同源编译（C99，无 IDF），用假 `light_ports_t` + 假时钟驱动。

## 运行

`npm run test:host`（root）。PlatformIO 不存在或本目录无测试时占位可绿（见 `scripts/run-host-test.mjs`）；CI 的 `firmware-host-test` job 装 PIO 后跑真测试。

## 状态

骨架阶段：目录就位，测试在执行阶段落地（D1–D16）。