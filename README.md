# BLE Light Model

8 路 WS2812 灯带（ESP32-C3）通过 BLE 暴露给原生微信小程序控制的系统。

## 目录

- `miniprogram/`：小程序工程。`logic/` 是纯 TS(ESM) 逻辑层，禁止引用 `wx` / `Page` / `Component` / `getApp`（`docs/spec/test-strategy.md` §1.1）。
- `firmware/`：PlatformIO 工程（ESP-IDF v5.5.3）。`proto/` 是纯 C99 协议层；`test/` 是 Unity host 单测。
- `tests/protocol/`：JS / C / Python 三侧共用的 golden 向量契约。
- `tests/pc_integration/`：PC 蓝牙 + COM6 集成测试（依赖硬件，不进 CI）。
- `docs/spec/test-strategy.md`：测试体系 spec（单一事实源）。

## 常用命令

小程序依赖：`cd miniprogram && npm install`。固件需要 PlatformIO（`pio` 在 PATH，或用 `~/.platformio/penv/Scripts/pio`）。

从仓库根目录：

- 类型检查：`npm run typecheck`
- 逻辑层纯度检查：`npm run check:purity`
- 小程序单测：`npm run test:logic`
- 固件 host 单测：`npm run test:firmware`
- 固件编译：`npm run build:native` / `npm run build:esp32c3`
- 全量本地门槛：`npm test`

## CI

`.github/workflows/ci.yml` 在每次 push / PR 上跑类型检查、逻辑层纯度检查、小程序单测、固件 native 单测。ESP32-C3 编译与 PC 集成在本地 / 发布前跑。