# miniprogram

微信原生小程序工程（TypeScript）：C3 灯带的 BLE 控制器。

## 分层（spec §1.1，四层单向依赖）

| 目录 | 层 | 允许引用 |
|---|---|---|
| `transport/` | `WxTransport`：wx.* BLE API 的 1:1 薄壳 | 仅 `wx`（经 `transport/wx_api.ts` 注入） |
| `logic/` | `BleLink` 连接编排 / 错误映射 / `Codec` 帧编解码 / `LightService` 协议业务 / `LightBusinessService` 页面级业务（亮度/限流门禁、解锁、strip_mask） | `Transport` 接口，纯 TS |
| `pages/` | 页面 UI（`LightBusinessService` 之上） | `BleLink` / `LightService` / `LightBusinessService` / `WxTransport` |

- `logic/**` 禁 `wx` / `Page` / `Component` / `getApp`：`npm run check:purity` 强制。
- `logic/test_utils/`：`FakeTransport`（内存传输替身）、`FakeLightDevice`（C3 行为模型）、场景脚本执行器，只被测试引用。
- `transport/` 是唯一允许触碰微信运行时的目录（`WxTransport`）。

## 命令（在 `miniprogram/` 下）

- `npm run typecheck`：`tsc --noEmit`（开发者工具 TS 编译只剥类型，类型检查必须靠 CI）。
- `npm test`：`vitest run`，默认开启 v8 覆盖率，行覆盖阈值 90%（不达标直接失败）。
- `npm run check:purity`：逻辑层纯度检查。

## 测试

- 单测：`logic/**/*.test.ts`（BleLink 状态机 / 写策略 / 错误映射 / Codec golden / LightService）。
- 场景脚本：`tests/scenarios/*.json`（见 `tests/scenarios/README.md`），由 `logic/scenarios.test.ts` 驱动 FakeTransport 全量执行。
- 真机 / 页面相关冒烟（#16）不进 Node 单测，靠真机调试（见下）。

## 真机前置说明（#16 tracer bullet，#17 完整 UI）

页面 `pages/index` 实现完整控制：扫描 → 连接 → 发现 → 订阅 → HELLO/STATUS →
7 种灯效 × 单/多 strip_mask × 颜色/渐变第二色/主参数 × 亮度/限流/满功率解锁。

**开发者工具导入**：用微信开发者工具导入本目录（`miniprogram/`），`project.config.json` 的 appid 为 `touristappid`（测试号），可直接打开预览。

**真机调试步骤**：
1. 安卓手机蓝牙开启、定位开启（安卓 6.0+ 扫描需要）。
2. C3 上电（设备名 `BLELight-C3`，广播中）。
3. 开发者工具点"真机调试"，手机微信扫码。
4. 页面点"扫描设备"→ 列表出现 `BLELight-C3` → 点设备连接。
5. 连接成功后状态显示"已就绪"，收到 C3 HELLO（固件版本 / 灯路数 / 灯效位图）。
6. **灯带选择**：点 L0–L7 选单路 / 多路，或"全选"选整灯（mask 0xFF）。
7. **灯效**：7 种效果切换，拖颜色 / 渐变第二色 / 主参数 → 点"应用灯效"→ 选路灯带按效果变化。
8. **亮度 / 限流**：拖亮度 / 限流滑条 → "应用"。超 50%（>127）或 15000mA 且未解锁 → 弹"需满功率解锁"（C3 NAK 0x06）。
9. **满功率解锁**：打开开关 → 解锁后可设 100% / 30000mA；关闭开关立即夹回 50% / 15000mA。
10. **STATUS**：设备状态区实时刷新（运行时长 / 温度 / 电流 / 亮度 / 限流 / 每路灯效）。
11. **断连恢复**：手机蓝牙关 / C3 断电 → 顶部横幅"连接断开，重连中…"；恢复后自动回到"已就绪"。
12. **后台恢复**：切后台再回前台 → onShow 校验连接，不出现重复连接风暴。

**注意**：
- 开发者工具模拟器不支持真实 BLE（官方："完整功能请使用真机调试"）。
- iOS 不在本期范围（spec §5：不做 iOS）。
- 写串行 / 分片 / 超时 / 重连 / MTU 协商都在 `BleLink`；亮度/限流门禁与解锁在 `LightBusinessService`；页面只编排 UI。
- 满功率解锁不持久化：断连 / C3 重启后回落受限（50% / 15000mA）。