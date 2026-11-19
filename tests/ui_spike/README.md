# UI 回归 spike（spec §3.5 / 工单 #19）

在浏览器里跑官方基础库 + mock wx BLE 的 UI 回归 **spike**：验证「wxa-runner + Playwright + wx 层
BLE mock」这条 C 路线是否走得通。跑不通 1 条连接页 happy path 就按 kill 标准降级人工 UI + B 真机。

## 结论

**绿（可用）**：连接页 happy path 通过（扫描 → 连接 → 就绪 → 应用灯效 → 查询状态），
Playwright + Chrome（`channel:'chrome'`）无头运行，Linux x86-64 路径成立（无开发者工具依赖，
baselib 用 vendored 3.7.0，编译器用 npm miniprogram-compiler）。详见下方「验收对照」。

## 结构

```
tests/ui_spike/
  vendor/                      wxa-runner 0.14.0 + baselib 3.7.0（来源/许可见 vendor/README.md）
  wx-ble-mock.ts               wx 层 BLE mock：invoke 型走 setup mock，事件型走 __wxaHost.emitToService
  wxa.setup.ts                 wxa-runner setup 文件（App.onLaunch 前注册 mock 表）
  playwright.config.ts         channel:chrome + wxaProject:../../dist/miniprogram + baseLibVersion:3.7.0
  e2e/connect-happy-path.spec.ts   唯一 spike 用例
```

数据流（mock 在 **wx 层**，不绕过 WxTransport）：

```
页面 onScan/onSelectDevice/…
  → LightBusinessService → LightService → BleLink → WxTransport（生产代码原样）
    → wx.*（真实基础库函数）
      → invoke 型：WeixinJSBridge.invoke → wxa-runner ApiRegistry → setup mock → FakeTransport
      → 事件型：FakeTransport 事件 → __wxaHost.emitToService → 基础库 on* 监听 → WxTransport 分发
    → FakeLightDevice（C3 行为模型，与 Node 单测同源）回 ACK / NAK / STATUS / HELLO
```

设备模型复用 `miniprogram/logic/test_utils/`（FakeTransport + FakeLightDevice），没有第二套假蓝牙。

## 运行

前置：Node ≥ 18、Chrome（系统安装，`channel:'chrome'` 用它，不用 Playwright 自带 Chromium）。

```bash
# 仓库根目录
npm run build:mp        # tsc 产出 dist/miniprogram（与开发者工具导入同一份源码）
npm run test:ui         # = build:mp + playwright test

# 或分开跑
npm --prefix tests/ui_spike run build:mp
npm --prefix tests/ui_spike run test          # 无头
npm --prefix tests/ui_spike run test:headed   # 有头（本机看界面用）
```

首次准备：`npm --prefix tests/ui_spike install`（vendor 目录以 `file:` 依赖装入，lockfile 已提交）。

Linux CI（无开发者工具）：

```bash
npx playwright install --with-deps chrome    # 系统 Chrome + 依赖
npm --prefix tests/ui_spike run build:mp && npm --prefix tests/ui_spike run test
```

`wxa.setup.ts` 的 mock 在 **App.onLaunch 之前**注册（wxa-runner setup 机制），BLE invoke 全部
在 setup 生效后才被页面触达，无时序问题；事件型 mock 在 `__wxaHost.emitToService` 派发，页面
的 `wx.on*` 注册走基础库真实路径。

## 覆盖的 wx.* API（对照 WxTransport / wx_api.ts 的 WxApi 全集）

| WxTransport 调用 | mock 键（原生 invoke 名） | 类型 |
|---|---|---|
| `openBluetoothAdapter` | `openBluetoothAdapter` | invoke |
| `closeBluetoothAdapter` | `closeBluetoothAdapter` | invoke |
| `startBluetoothDevicesDiscovery` | `startBluetoothDevicesDiscovery` | invoke |
| `stopBluetoothDevicesDiscovery` | `stopBluetoothDevicesDiscovery` | invoke |
| `getBluetoothDevices` | `getBluetoothDevices` | invoke |
| `createBLEConnection` | `createBLEConnection` | invoke |
| `closeBLEConnection` | `closeBLEConnection` | invoke |
| `getBLEDeviceServices` | `getBLEDeviceServices` | invoke |
| `getBLEDeviceCharacteristics` | `getBLEDeviceCharacteristics` | invoke |
| `notifyBLECharacteristicValueChange` | **`notifyBLECharacteristicValueChanged`**（基础库 invoke 名多一个 d） | invoke |
| `writeBLECharacteristicValue` | `writeBLECharacteristicValue`（mock 收到的 `value` 是 **base64 字符串**，需自行解码） | invoke |
| `setBLEMTU` | `setBLEMTU` | invoke |
| `getBLEMTU` | `getBLEMTU` | invoke |
| `onBluetoothDeviceFound` | `onBluetoothDeviceFound` | 事件（emitToService） |
| `onBLEConnectionStateChange` | `onBLEConnectionStateChange` | 事件（emitToService） |
| `onBLECharacteristicValueChange` | `onBLECharacteristicValueChange`（派发时 `value` 必须转 base64，基础库会转回 ArrayBuffer） | 事件（emitToService） |
| `onBLEMTUChange` | `onBLEMTUChange` | 事件（emitToService） |
| `getDeviceInfo` | 不需要 mock：`device:{platform:"android"}` 让基础库从宿主取平台 | 宿主提供 |

另外 mock 了 `showToast`（页面直接调用，wxa-runner 未实现它；不 mock 会被 fixture 的
`errors()` 检查拦下）。`getSystemSetting` / `getAppAuthorizeSetting` 由 wxa-runner 固定返回
「有蓝牙」，与本 mock 无冲突。

## 验收对照（工单 #19）

- [x] wxa-runner fork 0.14.0 + baselib 3.7.0 vendor 进仓库 → `vendor/`（sha512 校验见 vendor/README.md）
- [x] wx 层 mock 覆盖 WxTransport 全部 BLE API，复用 FakeTransport 设备模型 → 上表 17 个 BLE API + FakeLightDevice
- [x] 跑 dist/miniprogram；Playwright + Chrome channel；Linux 可跑 → `npm run test:ui`；Linux 无
      DevTools 时用 vendored baselib（本机 DevTools 无 3.7.0，测试实际就是走 vendored 3.7.0 验证的）
- [x] spike 用例 = 1 条连接页 happy path；kill 标准未触发（绿）

## 踩坑记录（对后续维护有价值）

1. **`notifyBLECharacteristicValueChange` 的 invoke 名带 `d`**：mock 键必须是
   `notifyBLECharacteristicValueChanged`，写 wx 名不生效（事实底稿 §2.4 已警示，实测确认）。
2. **write 的 `value` 是 base64**：基础库 invoke 前把 ArrayBuffer 转成 base64（`qk`），mock 必须
   自行解码；解码器注意 32 位移位溢出（长帧必须每字节 mask 掉已消费位）。
3. **通知 `value` 要转回 base64 再派发**：基础库收到后转 ArrayBuffer 给业务（`zk`），直接派发
   ArrayBuffer 会因跨 iframe 结构化克隆失败。
4. **事件型（on*）mock 不了 setup**：`setup.mock` 对 `on*` 不生效（不走 ApiRegistry）；本实现保留
   基础库真实 `on*` 注册，用 `__wxaHost.emitToService` 派发——页面代码零改动。
5. **FakeLightDevice 不自动挂 FakeTransport**：必须 `new FakeTransport({ onWrite: b => device.onWrite(b) })`
   显式接线（与 Node 单测相同），否则写进 transport 就丢了、永远等不到 ACK。
6. **wxa-runner 不编译 TS**：`dist/miniprogram` 由 `miniprogram/scripts/build-dist.mjs`（tsc）产出；
   `.ts` 不会被 wxa-runner 当模块收集。
7. **npm 对 `file:` 依赖会装其 devDependencies**：vendored 包的 devDeps 必须删（`@open-wxa/wxa-viewer@0.10.0`
   已 404，不删 install 直接失败）。
8. **`app.json` 里页面路径必须真实存在**：`miniProgram.open("pages/index/index")` 在页面不在
   app.json 时直接报错。
9. **Windows + Node ≥18 的 `launch()` spawn EINVAL 问题不适用本路径**：fixture 直接 new DevServer，
   不走 cli.bat（事实底稿 §1.6 的坑只影响 miniprogram-automator 的 launch）。

## 已知限制 / 待真机验证

- 只覆盖 happy path；失败路径（扫描失败 / 连接失败 / NAK 0x06 / 断连重连）的 mock 编排未做用例
  （FakeTransport 已支持，补用例是增量工作）。
- Linux 未在真机跑过（本机 Windows）：CI 上首次跑注意 `npx playwright install --with-deps chrome`
  与 x86-64 限制（wxa-runner 无开发者工具时编译器只有 x86-64）。
- 页面视觉（slider / switch 交互）只验证了按钮与 data，未做像素级断言（spec 也不要求）。