# Windows BLE 中心工具链事实核查（ticket #6 底稿）

> 核查目标：为 #6「PC 直连 C3 的 BLE 集成测试」选定 PC 侧 BLE 中心（GATT Client）+ COM 串口 + 测试运行器。
> 核查日期：2026-11-19。所有结论附来源 URL。可信度：官方文档 / 源码 / 包注册表为主。

## 1. noble (Node.js)

**维护状态**
- 原仓库 `noble/noble` **2025-07-31 归档**（只读，215 open issues）；Windows 原生绑定依赖 `node-bluetooth-hci-socket` 同日归档。https://github.com/noble/noble
- 两个社区分叉：
  - `@abandonware/noble` — 最新 `1.9.2-26`（2025-02-09），之后停更。MIT。https://github.com/abandonware/noble
  - `@stoprocent/noble` — 最新 `2.8.0`（2026-08-20），活跃；`withBindings('win')` 选 WinRT 绑定、Windows `pairAsync()`、Promise/async iterator、TS 类型。MIT。https://github.com/stoprocent/noble

**Windows 实现（重要纠正）**
- Win10 build ≥ 15063 默认走**原生 WinRT 绑定**（`NobleWinrt` N-API 模块），不是 HCI。**默认 WinRT 绑定在正常 x64 Node 上无需原生编译**——`node-gyp-build` 加载预编译二进制。README 里的「windows-build-tools + Zadig WinUSB dongle」是 **HCI 旧路径**的说明，默认路径用不到。
- HCI 路径（强制时）才需要 **BLE 4.0/5.0 USB dongle + Zadig WinUSB**，会让适配器脱离 Windows 蓝牙栈。https://github.com/noble/node-bluetooth-hci-socket#windows

**GATT 客户端能力**
- 通知：`characteristic.subscribe()/unsubscribe()`，监听 `'data'`。✅
- 无响应写：`characteristic.write(data, withoutResponse[, cb])`，`withoutResponse=true` → ATT write command。✅
- MTU：WinRT 绑定**不暴露、不请求** MTU（`peripheral.mtu` 为 null，除非用 HCI 绑定）；无公开 `requestMtu` API。

**已知 Windows 限制**
- 旧 README 的适配器特定问题（"Command disallowed"、"Limited Resources"）主要与 HCI dongle 相关，WinRT 绑定基本规避。
- 最大并发连接数适配器相关（CSR 约 5）。
- 上游归档，修复靠分叉；`@abandonware` 停更、`@stoprocent` 单作者维护。
- 配对：仅 `@stoprocent` 有 `pairAsync()`（Windows WinRT）；`@abandonware` 无配对 API。

**许可证**：MIT（原仓库与两个分叉）。

## 2. bleak (Python)

- **活跃维护**：最新 **3.1.0（2026-11-07）**。MIT。https://github.com/hbldh/bleak/releases
- **Windows 后端**：用 **PyWinRT** 绑定 `Windows.Devices.Bluetooth.*`。https://bleak.readthedocs.io/en/latest/backends/windows.html
- **Python**：`>=3.10`，CI 测 3.10–3.14。
- **Windows 支持**：Tier 1 = Windows 11 22000+；历史上 0.12.1 支持 Win10 16299+，现行文档只列 Win11——**Win10 实测可用但非 tier-1 测试**，当作「能跑、不保证」。
- **GATT 客户端**：扫描 / 连接 / 读写特征与描述符 / `start_notify`/`stop_notify`（notify+indicate）/ `pair()`（平台相关）/ `mtu_size`（只读，Windows 自动协商，应用不可设）。
- **已知问题**（多为历史/已修）：控制台 STA/MTA 线程问题（`uninitialize_sta()` / `sys.coinit_flags=0` 规避）；`max_write_without_response_size` 竞态（0.22.2/0.22.3 修）；连接超时默认 30s；Win11 有时 `disconnect()` 后系统仍占用链路（bleak #1949，2026）。

## 3. C#/.NET (Windows.Devices.Bluetooth)

- **GATT 客户端完整**：`BluetoothLEDevice.FromBluetoothAddressAsync/FromIdAsync` + `GetGattServicesAsync`/`GetCharacteristicsAsync`；`ReadValueAsync`/`WriteValueAsync`/`WriteValueWithResultAsync(buffer, GattWriteOption.WriteWithResponse|WriteWithoutResponse)`；`WriteClientCharacteristicConfigurationDescriptorAsync(Notify)` + `GattCharacteristic.ValueChanged`。https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/gatt-client
- **无头控制台**：可以，但有 caveat。WinRT API 可从 Win32/桌面调用；.NET 5+ / CsWinRT 目标 `net8.0-windows10.0.19041.0` 可 `await`。但 `FromIdAsync` 文档说「必须在 UI 线程调用，因为可能弹同意框」——控制台在非提权、设备已缓存/配对时通常能跑，仍需处理 apartment/同意边界。
- **样板量**：高（async WinRT、`DataReader/DataWriter`、`GattCommunicationStatus`、事件 token、`GattSession.MaintainConnection`）。
- **从测试驱动**：编译小控制台 exe，测试 runner 调它，传设备地址/UUID/COM 口，读 stdout/退出码。可行但比 Python/Node 重。

## 4. Web Bluetooth (Chrome/Edge on Windows)

- `navigator.bluetooth.requestDevice()` 需 **HTTPS + 用户手势** + **原生设备选择器**，页面不能枚举/自动选。
- Puppeteer ≥ 21.4 有 `Page.waitForDevicePrompt()` + `DeviceRequestPrompt.select()` 可程序化选择器，但**必须 headful**（`headless: false`）。
- WebDriver/ChromeDriver 无蓝牙选择器钩子。
- 无头 Chrome：旧 headless 不支持；新 headless 可能可用但未验证。
- 连接：可按 `name`/`namePrefix` 过滤；页面只知道用户/Puppeteer 选中的设备。
- Chrome 有安全敏感设备（FIDO/HID）denylist，选择器弹前就拦。
- **CI 可行性低**：需真实有头浏览器 + 真实适配器 + Puppeteer 专属自动化，脆弱且重。仅适合人工/E2E 演示。

## 5. 各候选的串口/COM 访问

| 栈 | 库 | Windows 说明 |
|---|---|---|
| Node | `serialport` 13.0.0（2024-12） | 支持 Win10+；`prebuildify-cross` 预编译；node-gyp 回退需 VS build tools。https://serialport.io/docs/guide-installation |
| Python | `pyserial` 3.5 | 纯 Python，Win 下 ctypes 调 Win32；`serial.Serial("COM5", 115200, timeout=1)`。https://pyserial.readthedocs.io |
| C#/.NET | `System.IO.Ports.SerialPort`（内置） | `GetPortNames()`/`Open()`/`DataReceived`。https://learn.microsoft.com/en-us/dotnet/api/system.io.ports.serialport |
| Web Bluetooth | n/a | 需另开 Node/Python/C# helper 或 WebSocket 桥 |

ESP32-C3 原生 USB CDC（USB Serial/JTAG）在 Win10/11 枚举为标准 **COM 口**，`usbser` 驱动经 Windows Update 自动装；旧系统/离线需 Espressif 驱动。https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-guides/usb-serial-jtag-console.html

## 6. Windows BLE 适配器硬件要求 & ESP32 NimBLE 注意点

**内置适配器够用吗？**
- 对 WinRT 系栈（bleak、C#、Web Bluetooth、noble WinRT 绑定）：够。Win8/10 起就是 GATT 中心；任何蓝牙 4.0+ 内置射频（Intel/Realtek/Dell 等 + 厂商驱动）可带一个外设。
- 仅 noble **HCI 绑定**：内置射频一般不可用，需 USB BLE 4.0 dongle + Zadig WinUSB（会禁用 Windows 蓝牙设置里的适配器）。

**驱动**
- WinRT 路径：厂商蓝牙驱动（Windows Update）；缺适配器从 OEM 页重装。
- noble HCI：Zadig WinUSB。

**多适配器**
- **Windows 蓝牙栈同时只支持一个活动 radio**；插第二个 USB 适配器常与内置的冲突（Code 10 / 一个被禁用）。计划**一块适配器**。https://kb.plugable.com/bluetooth-adapter/

**ESP32 NimBLE 特定**
- NimBLE 外设 + Windows 中心可用，但有已知 bug：重连后订阅状态损坏（Windows 往 CCCD 写 `0x80` 而非 1/2，NimBLE-Arduino #850，2025-01）。**固件要防御性处理 CCCD 写 0x0080，或重连后重订阅**。https://github.com/h2zero/NimBLE-Arduino/issues/850
- Windows 可能自动重连已配对/绑定的 ESP32，固件广播/可连接状态不对会连-断循环。确保 C3 广播 connectable undirected 且断连后重启广播。
- **MTU**：Windows 自动请求大 MTU（常见 247，有时 527），**应用不可设**。配置 NimBLE `CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU`（如 256）并处理 `BLE_GAP_EVENT_MTU`；帧 ≤ 协商 MTU−3 或应用层分片。
- **CCCD 订阅**：四个栈都会替你做（bleak `start_notify`、noble `subscribe`、C# `WriteClientCharacteristicConfigurationDescriptorAsync(Notify)`、Web Bluetooth `startNotifications`）。NimBLE 必须创建 0x2902 描述符（加 `NIMBLE_PROPERTY::NOTIFY` 即可）；缺 CCCD 是「通知永远收不到」的经典原因。
- **配对/绑定**：Win10 1703+ GATT **不要求**配对；仅当外设要求加密时才配对（ConfirmOnly，无 MITM）。
- **服务缓存**：Windows 按设备缓存 GATT 结构；改固件 GATT 布局后缓存可能过期——在 PC 上 unpair/删除设备或改设备名可清缓存。https://bleak.readthedocs.io/en/latest/troubleshooting.html#handling-os-caching-of-ble-device-services

## 7. 对比表

| 维度 | noble (Node) | bleak (Python) | C#/.NET WinRT | Web Bluetooth |
|---|---|---|---|---|
| 维护 | 原仓库归档 2025-07；`@abandonware` 停更、`@stoprocent` 活跃 | 活跃（3.1.0，2026-11） | Microsoft，当前 | 规范在，仅 Chrome 实现 |
| Win10/11 | Win10 15063+（WinRT 绑定）；HCI 需 Zadig dongle | Tier-1 Win11；Win10 16299+ 实测 | Win10 1703+（未配对 GATT 15030+） | Win10 1703+（Chrome 70+） |
| 安装摩擦 | 中（原生模块/预编译；分叉） | **低**（`pip install bleak`，PyWinRT wheels） | 中（SDK/CsWinRT 工程） | 高（有头 Chrome、HTTPS、选择器） |
| GATT 中心 | 是 | 是 | 是 | 是 |
| 通知 | 是 | 是 | 是 | 是 |
| 无响应写 | 是 | 是 | 是 | 是 |
| MTU | 不暴露（WinRT）；HCI 请求 256 | `mtu_size` 只读；Windows 自动 | 不暴露 | 不暴露 |
| 配对 | 仅 `@stoprocent` | `pair()` | `DeviceInformationCustomPairing` | OS/选择器 |
| 无头/控制台 | 是 | 是 | 是（UI 线程 caveat） | 否（需有头浏览器） |
| 串口/COM | `serialport`（预编译） | `pyserial`（纯 Python） | `System.IO.Ports`（内置） | 需外部 helper |
| CI 鲁棒性 | 中 | **高** | 高（样板多） | 低 |
| 样板量 | 低–中 | **低** | 高 | 中 |
| 许可证 | MIT | MIT | OS API | n/a |

## 8. 结论

**首选：Python + bleak（+ pyserial）。** 最稳的 Windows BLE 中心自动化：
- 活跃维护、MIT、`pip install bleak` 带预编译 PyWinRT wheel——无原生工具链、无 dongle、无 Zadig。
- GATT 客户端齐全：按名扫描、连接、对 RSP `start_notify`、对 CMD `write_gatt_char(..., response=False)`、`mtu_size` 供诊断——全走内置适配器 WinRT。
- 控制台/无头友好（`asyncio.run(main())`），注意别 import pywin32 或设 `sys.coinit_flags=0`。
- pyserial 同进程同语言收 COM 日志，pytest 组织。一个进程、一种语言、一套依赖。
- 已知 Windows 怪癖（STA hang、max-PDU 竞态、"Unreachable"）文档齐全且新版已修；连接超时默认 30s。

**次选：`@stoprocent/noble`（Node）+ `serialport`。** 团队 Node-first 时选。唯一活跃 noble 分叉，原生 WinRT 绑定（无 dongle），支持 notify 与无响应写，`serialport` 有预编译 Windows 二进制。代价：维护者少、无 MTU API、社区小于 bleak、上游归档=押注单分叉。

**不推荐为主：**
- **C#/.NET WinRT**：样板最多、`FromIdAsync` 有 UI 线程/同意 caveat、迭代最慢；适合打包 GUI 工具，CI 里 overkill。
- **Web Bluetooth**：用户手势 + 原生选择器 + 需有头，天然不适合无人值守 CI；Puppeteer `waitForDevicePrompt` 仅 headful。留给人工/E2E 演示。

**选定机型的硬件/设置备注**
- 用 PC 内置蓝牙 4.0+ 适配器 + 厂商驱动；**只一块**（Windows 栈 = 一个 radio）。
- ESP32-C3：开 `CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU`（如 256）、notify 特征带 NOTIFY 属性以创建 CCCD、断连后重启 connectable 广播、容忍 Windows 写的 CCCD `0x0080`（NimBLE-Arduino #850）。
- 每帧 ≤（协商 MTU − 3）或固件分片；Windows 中心不会替你指定 MTU。
- Win10 1703+ 未配对 GATT 可用；仅固件要求加密时才配对。改 GATT 布局后在 PC 上 unpair/删除设备清服务缓存。
- 串口：C3 原生 USB CDC 在 Win10/11 用内置 `usbser` 枚举为 COM 口，pyserial 按固件波特率（常见 115200）打开并断言日志行。

**不确定项**：Web Bluetooth 在新 headless Chrome + Puppeteer 下用于 BLE CI 有可能但未验证；C# 控制台 GATT 可用但 `FromIdAsync` 的 UI 线程说明在某些 SKU 上可能需消息泵；bleak 3.x 的 Win10 支持是实测而非 tier-1。