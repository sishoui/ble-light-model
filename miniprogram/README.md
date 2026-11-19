# miniprogram

微信原生小程序工程（TypeScript）：C3 灯带的 BLE 控制器。

## 分层（spec §1.1，四层单向依赖）

| 目录 | 层 | 允许引用 |
|---|---|---|
| `transport/` | `WxTransport`：wx.* BLE API 的 1:1 薄壳 | 仅 `wx`（经 `transport/wx_api.ts` 注入） |
| `logic/` | `BleLink` 连接编排 / 错误映射 / `Codec` 帧编解码 / `LightService` 灯带业务 | `Transport` 接口，纯 TS |
| `pages/` | 页面 UI（`LightService` 之上） | `BleLink` / `LightService` / `WxTransport` |

- `logic/**` 禁 `wx` / `Page` / `Component` / `getApp`：`npm run check:purity` 强制。
- `logic/test_utils/`：`FakeTransport`（内存传输替身）与场景脚本执行器，只被测试引用。
- `transport/` 是唯一允许触碰微信运行时的目录（`WxTransport`）。

## 命令（在 `miniprogram/` 下）

- `npm run typecheck`：`tsc --noEmit`（开发者工具 TS 编译只剥类型，类型检查必须靠 CI）。
- `npm test`：`vitest run`，默认开启 v8 覆盖率，行覆盖阈值 90%（不达标直接失败）。
- `npm run check:purity`：逻辑层纯度检查。

## 测试

- 单测：`logic/**/*.test.ts`（BleLink 状态机 / 写策略 / 错误映射 / Codec golden / LightService）。
- 场景脚本：`tests/scenarios/*.json`（见 `tests/scenarios/README.md`），由 `logic/scenarios.test.ts` 驱动 FakeTransport 全量执行。
- 真机 / 页面相关冒烟（#16）不进 Node 单测，靠真机调试（见下）。

## 真机前置说明（#16 tracer bullet）

页面 `pages/index` 实现最小链路：扫描 → 连接 → 发现 → 订阅 → 设一个灯效。

**开发者工具导入**：用微信开发者工具导入本目录（`miniprogram/`），`project.config.json` 的 appid 为 `touristappid`（测试号），可直接打开预览。

**真机调试步骤**：
1. 安卓手机蓝牙开启、定位开启（安卓 6.0+ 扫描需要）。
2. C3 上电（设备名 `BLELight-C3`，广播中）。
3. 开发者工具点"真机调试"，手机微信扫码。
4. 页面点"扫描设备"→ 列表出现 `BLELight-C3` → 点设备连接。
5. 连接成功后状态显示"已就绪"，收到 C3 HELLO（固件版本 / 灯路数）。
6. 选灯效（7 种）+ 拖颜色滑条 → 点"应用到整灯带（mask 0xFF）"→ 对应灯带按所选效果变化。
7. 断连（手机蓝牙关 / C3 断电）后页面进入"重连中…"，恢复后自动回到"已就绪"。

**注意**：
- 开发者工具模拟器不支持真实 BLE（官方："完整功能请使用真机调试"）。
- iOS 不在本期范围（spec §5：不做 iOS）。
- 写串行 / 分片 / 超时 / 重连 / MTU 协商都在 `BleLink`，页面只编排 UI。