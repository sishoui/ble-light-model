# miniprogram

微信原生小程序工程（TypeScript）。当前里程碑只包含可单测的逻辑层与传输抽象，页面 / 组件在后续工单接入。

## 分层（spec §1.1，四层单向依赖）

| 目录 | 层 | 允许引用 |
|---|---|---|
| `transport/` | `WxTransport`：wx.* BLE API 的 1:1 薄壳 | 仅 `wx`（经 `transport/wx_api.ts` 注入） |
| `logic/` | `BleLink` 连接编排 / 错误映射 / `Codec` 帧编解码 | `Transport` 接口，纯 TS |
| （页面） | `LightService` 等 | `BleLink` |

- `logic/**` 禁 `wx` / `Page` / `Component` / `getApp`：`npm run check:purity` 强制。
- `logic/test_utils/`：`FakeTransport`（内存传输替身）与场景脚本执行器，只被测试引用。

## 命令（在 `miniprogram/` 下）

- `npm run typecheck`：`tsc --noEmit`（开发者工具 TS 编译只剥类型，类型检查必须靠 CI）。
- `npm test`：`vitest run`，默认开启 v8 覆盖率，行覆盖阈值 90%（不达标直接失败）。
- `npm run check:purity`：逻辑层纯度检查。

## 测试

- 单测：`logic/**/*.test.ts`（BleLink 状态机 / 写策略 / 错误映射 / Codec golden）。
- 场景脚本：`tests/scenarios/*.json`（见 `tests/scenarios/README.md`），由 `logic/scenarios.test.ts` 驱动 FakeTransport 全量执行。
- 真机 / 页面相关冒烟（#16）不进 Node 单测。