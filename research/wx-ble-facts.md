# 微信小程序 BLE 事实核查报告

> 调研目标：为 ble-light-model（ESP32-C3 + 8 路 WS2812 + BLE 外设，微信原生小程序控制器）抽取可注入 Transport 接口、在 Node + vitest 单测提供事实依据。
> 核查日期：2026-11-19。所有官方文档均通过 `developers.weixin.qq.com` 的 `.md` 版本端点核对（微信官方提供「复制给 LLM / 查看 Markdown」链接）。
> 可信度标注：**[高]** = 官方文档原文；**[中]** = 官方文档间接说明 / 官方工具仓库；**[低]** = 社区经验，未经官方确认，需实测。

---

## 0. 与本项目假设的冲突速览（先看这个）

| 我们的假设 | 核查结论 | 冲突程度 |
|---|---|---|
| `writeBLECharacteristicValue` 有单次长度上限 | **不成立（严格意义上）**。官方原文："小程序不会对写入数据包大小做限制，但系统与蓝牙设备会限制蓝牙 4.0 单次传输的数据大小，超过最大字节数后会发生写入错误，建议每次写入不超过 20 字节。" 即：API 层无硬上限，限制来自 OS/对端，20 是**建议值**。 | ⚠️ 需修正表述 |
| `setBLEMTU` 可协商 MTU | **部分成立**。**仅安卓 5.1+ 有效，iOS 因系统限制不支持**（官方原文）。且 success 回调返回的 mtu "与传入参数一致"（安卓客户端 8.0.9+），不代表对端真实能力。 | ⚠️ 需加平台条件 |
| 开发者工具模拟器不支持真实 BLE | **成立**。官方原文："开发者工具上只能模拟部分蓝牙接口能力，完整功能请使用真机调试。" | ✅ 无冲突 |
| Node 可直接 import 纯 TS 源码 | **成立，但分平台**。小程序侧是 **CommonJS**（`module.exports`/`exports` + `require`），官方文档未提供 ESM 方案；Node 侧从 v22.18 / v23.6 起原生支持类型擦除执行 `.ts`，但要求**仅可擦除语法**、import 必须带 `.ts` 扩展名、类型导入需 `import type`。 | ⚠️ 需按模块格式分治 |

---

## 1. 小程序 BLE 相关 `wx.*` API 完整清单

### 1.1 适配器（bluetooth 目录）

| API | 基础库起始版本 | Promise 化 | 出处 |
|---|---|---|---|
| `wx.openBluetoothAdapter` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.openBluetoothAdapter.md) |
| `wx.closeBluetoothAdapter` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.closeBluetoothAdapter.md) |
| `wx.getBluetoothAdapterState` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getBluetoothAdapterState.md) |
| `wx.onBluetoothAdapterStateChange` | 1.1.0 | 事件监听型，不适用 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.onBluetoothAdapterStateChange.md) |

### 1.2 扫描（bluetooth 目录）

| API | 基础库起始版本 | Promise 化 | 出处 |
|---|---|---|---|
| `wx.startBluetoothDevicesDiscovery` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.startBluetoothDevicesDiscovery.md) |
| `wx.stopBluetoothDevicesDiscovery` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.stopBluetoothDevicesDiscovery.md) |
| `wx.getBluetoothDevices` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getBluetoothDevices.md) |
| `wx.getConnectedBluetoothDevices` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getConnectedBluetoothDevices.md) |
| `wx.onBluetoothDeviceFound` | 1.1.0 | 事件监听型，不适用 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.onBluetoothDeviceFound.md) |

### 1.3 连接与 GATT（bluetooth-ble 目录）

| API | 基础库起始版本 | Promise 化 | 出处 |
|---|---|---|---|
| `wx.createBLEConnection` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.createBLEConnection.md) |
| `wx.closeBLEConnection` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.closeBLEConnection.md) |
| `wx.getBLEDeviceServices` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEDeviceServices.md) |
| `wx.getBLEDeviceCharacteristics` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEDeviceCharacteristics.md) |
| `wx.readBLECharacteristicValue` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.readBLECharacteristicValue.md) |
| `wx.writeBLECharacteristicValue` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.md) |
| `wx.notifyBLECharacteristicValueChange` | 1.1.0 | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.notifyBLECharacteristicValueChange.md) |
| `wx.onBLEConnectionStateChange` | 1.1.0 | 事件监听型，不适用 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLEConnectionStateChange.md) |
| `wx.onBLECharacteristicValueChange` | 1.1.0 | 事件监听型，不适用 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLECharacteristicValueChange.md) |

### 1.4 MTU / RSSI（较新，注意兼容）

| API | 基础库起始版本 | Promise 化 | 出处 |
|---|---|---|---|
| `wx.setBLEMTU` | **2.11.0** | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.setBLEMTU.md) |
| `wx.getBLEDeviceRSSI` | **2.11.0** | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEDeviceRSSI.md) |
| `wx.getBLEMTU` | **2.20.1** | 支持 | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEMTU.md) |
| `wx.onBLEMTUChange` | **2.20.1** | 事件监听型，不适用（仅安卓触发） | [链接](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLEMTUChange.md) |
| `wx.offBLEMTUChange` | 2.20.1 | — | 同上目录 |

### 1.5 Promise 化的版本结论 [高]

官方《API》文档原文：

> **异步 API 返回 Promise** — 基础库 **2.10.2** 开始支持，低版本需做兼容处理。
> 异步 API 支持 callback & promise 两种调用方式。当接口参数 Object 对象中**不包含 success/fail/complete** 时将默认返回 promise，否则仍按回调方式执行，无返回值。

出处：[https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/api.md](https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/api.md)

要点：
- **所有异步 API 的 Promise 化都是基础库 2.10.2 起**，不是每个 API 单独标注的版本。每个 API 页面上的「以 Promise 风格 调用：支持」是**能力声明**，不是版本声明。
- 部分接口（`downloadFile`、`request`、`uploadFile`、`connectSocket`、`createCamera`）**本身有返回值，官方明确说其 promisify 需开发者自行封装**——BLE 这批 API 不在其列，可直接 `await`。
- 失败时若未 catch 会报 `Uncaught (in promise)`，可用 `wx.onUnhandledRejection` 兜底。

> **对 Transport 抽象的含义**：`await wx.xxx({...})` 是官方支持的调用方式，逻辑层可以写成 `async/await` 风格，无需自己包一层 Promise。但**必须保证 2.10.2+**（实际业务基本都远高于此）。

---

## 2. BLE 错误码表 [高]

官方**所有** BLE API 页面挂的是**同一张**错误码表（逐字一致），非各 API 独有：

| errCode | errMsg | 含义 |
|---|---|---|
| 0 | ok | 正常 |
| -1 | already connect | 已连接 |
| 10000 | not init | 未初始化蓝牙适配器 |
| 10001 | not available | 当前蓝牙适配器不可用 |
| 10002 | no device | 没有找到指定设备 |
| 10003 | connection fail | 连接失败 |
| 10004 | no service | 没有找到指定服务 |
| 10005 | no characteristic | 没有找到指定特征 |
| **10006** | **no connection** | **当前连接已断开** |
| 10007 | property not support | 当前特征不支持此操作 |
| 10008 | system error | 其余所有系统上报的异常 |
| 10009 | system not support | Android 系统特有，系统版本低于 4.3 不支持 BLE |
| 10012 | operate time out | 连接超时 |
| 10013 | invalid_data | 连接 deviceId 为空或者是格式不正确 |

出处示例（每个 BLE API 页面末尾均重复此表）：[wx.writeBLECharacteristicValue#错误](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.md)

### 2.1 关键澄清：10006 不是"断连事件" [高]

- **10006 是 reject/fail 错误码**，语义是「当前连接已断开」，官方原文在 `createBLEConnection` 注意事项里：

  > 若对**未连接的设备或已断开连接的设备**调用**数据读写操作**的接口，会返回 **10006** 错误，建议进行重连操作。

  出处：[wx.createBLEConnection#注意](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.createBLEConnection.md)

- **"断连事件"是另一个东西**：`wx.onBLEConnectionStateChange`，回调参数为 `{ deviceId, connected: boolean }`，**没有 errCode**。官方原文：

  > 监听蓝牙低功耗连接状态改变事件。包括开发者主动连接或断开连接，设备丢失，连接异常断开等等

  出处：[wx.onBLEConnectionStateChange](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLEConnectionStateChange.md)

> **对 Transport 抽象的含义**：必须**同时**处理两条路径 —
> ① 主动/被动断连 → `onBLEConnectionStateChange(connected:false)`；
> ② 断连后继续读写 → 各 API reject 带 `errCode:10006`。
> 二者**不是同一事件**，不能只监听一个。Transport 应把 ① 映射为 `onDisconnect` 回调，把 ② 映射为可重连的 `NotConnectedError`（携带 code 10006）。

### 2.2 各错误码的实际上报位置（社区实测，非官方逐条归属）[低]

官方没有给出「哪个码由哪个 API 抛」的矩阵。社区普遍观察（**需自行实测验证**）：
- `10000` — 未 `openBluetoothAdapter` 就调其他 API（官方 `openBluetoothAdapter` 注意里明确说了）。
- `10001` — 手机蓝牙开关未开 / 不支持；官方说明此时**适配器已初始化完成**，仍可调其他 API 并通过 `onBluetoothAdapterStateChange` 监听。
- `10003 / 10012` — `createBLEConnection` 连接失败 / 超时。
- `10006` — 对已断开设备做读写。
- `10007` — 对不支持该操作的特征调用（如向只读特征 write）。
- `10008` — 系统层异常，常见于安卓 GATT ERROR / notify 后立即 write。
- `10013` — deviceId 为空或格式非法。

---

## 3. `writeBLECharacteristicValue` 的约束 [高]

### 3.1 `value` 类型

- **必须是 `ArrayBuffer`**。官方参数表：`value | ArrayBuffer | 是 | 蓝牙设备特征对应的二进制值`。
- 示例代码用 `new ArrayBuffer(1)` + `DataView.setUint8()`。
- 传入 `Uint8Array` / `number[]` 会失败，社区统一做法是用 `uint8array.buffer`。

### 3.2 单次写入长度上限 —— **重要修正**

官方「注意」原文（逐字）：

> - 并行调用多次会存在写失败的可能性。
> - **小程序不会对写入数据包大小做限制**，但系统与蓝牙设备会限制蓝牙 4.0 单次传输的数据大小，超过最大字节数后会发生写入错误，**建议每次写入不超过 20 字节**。
> - 若单次写入数据过长，**iOS 上存在系统不会有任何回调的情况（包括错误回调）**。
> - 安卓平台上，在调用 `wx.notifyBLECharacteristicValueChange` 成功后立即调用本接口，在部分机型上会发生 10008 系统错误。

出处：[wx.writeBLECharacteristicValue#注意](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.md)

结论：
1. **API 层不限制长度**（没有硬编码 20 字节检查），超限是 OS/对端拒绝，表现为 `fail` 或 `10008`。
2. **20 字节是官方"建议值"**，不是硬上限。
3. **iOS 上超限可能完全无回调** —— 这是最危险的一条：Promise **永不 settle**，Transport 必须自己加超时。

### 3.3 `writeType`（writeWithoutResponse）

- 参数名 **`writeType`**（不是 `type`），基础库 **2.22.0** 开始支持。
- 合法值：`"write"`（强制有回复写）/ `"writeNoResponse"`（强制无回复写）。
- 默认行为：**iOS 优先 write，安卓优先 writeNoResponse**。
- 官方说明"不支持时报错"——即若强制指定的模式特征不支持，直接失败。

出处：[wx.writeBLECharacteristicValue#参数](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.md)

> **对 ESP32-C3 的含义**：如果 C3 侧特征只支持 `write_no_response`（很多透传服务如此），安卓默认能通但 iOS 默认走 `write` 会失败。**建议 Transport 暴露 `writeType` 配置**，由协议层根据 `getBLEDeviceCharacteristics` 返回的 `properties.writeNoResponse` / `properties.writeDefault` 决定。

---

## 4. MTU

### 4.1 ATT 默认 MTU

- **ATT_MTU 默认 23 字节，有效 payload 20 字节**（3 字节 ATT header: OpCode 1B + Attribute Handle 2B）。
- 官方 `wx.getBLEMTU` 注意事项原文：

  > 小程序中 MTU 为 **ATT_MTU**，包含 Op-Code 和 Attribute Handle 的长度，**实际可以传输的数据长度为 `ATT_MTU - 3`**

  出处：[wx.getBLEMTU#注意](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEMTU.md)

### 4.2 `wx.setBLEMTU` 平台差异 [高]

官方原文（`setBLEMTU` 功能描述）：

> 协商设置蓝牙低功耗的最大传输单元 (Maximum Transmission Unit, MTU)。需在 `wx.createBLEConnection` 调用成功后调用。**仅安卓系统 5.1 以上版本有效，iOS 因系统限制不支持。**

- 参数范围：`(22, 512)` 区间内，单位 bytes（**注意是开区间，实际最小 23**）。
- `success` 回调返回 `{ mtu }`：**"最终协商的 MTU 值，与传入参数一致。安卓客户端 8.0.9 开始支持。"**
- `fail` 回调也可能带 `{ mtu }`："最终协商的 MTU 值。**如果协商失败则无此参数**。安卓客户端 8.0.9 开始支持。"

出处：[wx.setBLEMTU](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.setBLEMTU.md)

⚠️ **"与传入参数一致"意味着返回值不可信**：它回显你请求的值，而不是对端真实接受的协商结果。真实 MTU 需通过 `wx.getBLEMTU` 或 `wx.onBLEMTUChange` 获取。

### 4.3 `wx.getBLEMTU` / `wx.onBLEMTUChange`

- `getBLEMTU`（2.20.1+）返回 `{ mtu }`，且带一个 **iOS 特有参数 `writeType`**（默认 `write`）——说明 iOS 下 write / writeNoResponse 两条链路的 MTU 不同。
- 官方注意原文：**"iOS 系统中 MTU 为固定值；安卓系统中，MTU 会在系统协商成功之后发生改变，建议使用 `wx.onBLEMTUChange` 监听。"**
- `onBLEMTUChange`（2.20.1+）：**"仅安卓触发"**。

出处：[wx.getBLEMTU](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEMTU.md)、[wx.onBLEMTUChange](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLEMTUChange.md)

### 4.4 notify 是否受 MTU 影响

- **官方没有一句话直接说 notify 受 MTU 影响**，但 `getBLEMTU` 的注意事项把 MTU 定义为所有传输的实际上限（"实际可以传输的数据长度为 ATT_MTU - 3"），而 BLE 规范中 notification 与 write-without-response 共用同一 ATT payload 上限。[高，推导 + 规范]
- 社区普遍报告：**notify 接收同样受 MTU 限制**，默认 20 字节/包，超过需设备端分包 + 小程序端拼接。[低]

> **对 Transport 的含义**：
> - **不能假设 `setBLEMTU` 在 iOS 上可用**。必须做平台分支：`Platform.isAndroid && canIUse('setBLEMTU')` 才尝试协商，且要用 `getBLEMTU`/`onBLEMTUChange` 拿**真实值**。
> - 真实可用 payload = `真实MTU - 3`，且**受对端 C3 固件支持的最小值约束**（BLE 规范：双方取 min(Client Rx MTU, Server Rx MTU)）。
> - 因此**分片逻辑必须保留 20 字节兜底**，不能只依赖 MTU 协商。

---

## 5. 开发者工具模拟器 vs 真机调试

### 5.1 官方原话 [高]

《蓝牙 (Bluetooth)》文档 3.2 调试：

> 由于操作系统本身的限制，部分能力无法保证完全一致，请开发者注意文档中的注意事项，并在各端的真机都进行调试。**开发者工具上只能模拟部分蓝牙接口能力，完整功能请使用真机调试。**

出处：[https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.md](https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.md)

注意官方用词是 **"只能模拟部分蓝牙接口能力"**，**没有出现"不支持真实 BLE"这句绝对表述**。所以：
- ✅ 我们的假设"模拟器不支持真实 BLE"在**实践上成立**（模拟器跑在 PC 上，PC 无手机蓝牙栈对接，无法连接真实 BLE 外设）。
- ⚠️ 但**官方没有这样绝对地说**，报告里应引用原文「只能模拟部分蓝牙接口能力，完整功能请使用真机调试」，不要伪造"官方说不支持 BLE"。

### 5.2 真机调试前提条件 [中/高]

官方《真机调试 2.0》要求：
- Android：微信客户端 **8.0.6+**，基础库 **2.18.1+**
- iOS：微信客户端 **8.0.8+**，基础库 **2.18.1+**
- 开发者工具 **1.05.2107221 RC** 起支持

出处：[https://developers.weixin.qq.com/miniprogram/dev/devtools/remote-debug-2.md](https://developers.weixin.qq.com/miniprogram/dev/devtools/remote-debug-2.md)

 BLE 相关的额外硬前提（来自 BLE 文档 + openBluetoothAdapter 文档）：
- **安卓 6.0+**：无**定位权限**或**定位开关未打开**时**无法搜索设备**（8.0.16 之前静默失败，之后返回错误）。
- **iOS**：`serviceId` / `characteristicId` 必须来自 `getBLEDeviceServices` / `getBLEDeviceCharacteristics`，**不能硬编码**，否则 read/write/notify 全失败。
- **deviceId 不能硬编码**：Android 是 MAC（相对稳定），iOS 是系统生成的 UUID（会因系统蓝牙重启、忽略配对等变化）。
- 上线后蓝牙失效的高频原因：**隐私保护指引未声明蓝牙/位置用途**（社区高频坑，[低]）。

---

## 6. 官方单元测试方案

### 6.1 官方文档怎么说 [高]

《单元测试》（自定义组件扩展）：

> 小程序的运行环境比较特殊……它采用的是双线程的架构。而在进行单元测试时，我们并不需要用到这样复杂的架构……因此我们提供了一个测试工具集以支持自定义组件在 nodejs 单线程中也能运行起来。
> 我们先安装一下测试工具集——`miniprogram-simulate`

出处：[https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/unit-test.md](https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/unit-test.md)

**关键限制（官方 PS 原文）**：

> PS：测试工具集中的 **wx 对象和内置组件都不会实现真正的功能**，如果需要测试一些特殊场景的话，**可以自行覆盖掉测试工具集中的 api 接口和内置组件**。

这句是官方对「能否 mock wx 全局 API」的**唯一直接表态**：wx 对象存在但**是空壳**，需要自行覆盖。

### 6.2 miniprogram-simulate 的实际能力 [高]

官方仓库 [wechat-miniprogram/miniprogram-simulate](https://github.com/wechat-miniprogram/miniprogram-simulate)：

- 定位原文："**小程序自定义组件测试工具集**"。
- 机制原文："将原本小程序自定义组件双线程分离运行的机制调整成单线程模拟运行，**利用 dom 环境进行渲染**，借此来完成整个自定义组件树的搭建。"
- 运行依赖原文："运行此工具集需要依赖 js 运行环境和 dom 环境，因此可以采用 **jsdom + nodejs（如 jest）**，也可以采用真实浏览器环境（如 karma）。"
- API：`load()` / `render()` / `match()` / `sleep()` / `scroll()` / `Component.querySelector` / `setData` / `dispatchEvent` / `triggerLifeTime` / `RootComponent.attach`。
- **暂不支持**：抽象节点、插件；JS 模拟 wxml 编译器不支持 `template`、外链 wxs、外链 wxml。

结论：
1. ✅ **能渲染组件**（这是它的核心能力，能建 DOM 树、attach 触发 attached 钩子、断言 `dom.innerHTML` 与 computed style）。
2. ⚠️ **能 mock wx 全局 API —— 但不是"内置能力"，而是"需要你手动覆盖"**。官方只说 wx 对象不实现真实功能、可自行覆盖，**没有提供 `simulate.mockWx()` 之类的官方 API**。
3. ❌ **不适合纯 logic 层测试**：整个工具是围绕**自定义组件**设计的，`load()` 的入参是组件路径/定义，没有"加载任意 js 模块"的接口。

出处：[docs/api.md](https://raw.githubusercontent.com/wechat-miniprogram/miniprogram-simulate/master/docs/api.md)、[docs/todo.md](https://raw.githubusercontent.com/wechat-miniprogram/miniprogram-simulate/master/docs/todo.md)

### 6.3 社区常用做法（jest + 手动 mock `global.wx`）[低]

- 社区主流是 jest + `testEnvironment: 'jsdom'` + `miniprogram-simulate`，用 `jest.mock()` 打桩业务模块。
- 「手动 mock `global.wx`」在博客里非常普遍，但**官方文档没有推荐这种做法，也没有给出示例**。
- 官方文档中**唯一**与"替换 wx 实现"相关的表述就是那句 PS「可以自行覆盖掉测试工具集中的 api 接口和内置组件」——**这是覆盖 miniprogram-simulate 内的 wx，不是全局 `global.wx`**。

> **对本项目的直接结论**：
> 我们**不应该**依赖 miniprogram-simulate。它是**组件渲染器**，而我们要测的是 **logic 层 Transport 实现 + 协议编解码**，没有组件。官方也没有"logic 层单测方案"。
> 正确姿势就是我们原本的设想：**Transport 接口注入 + 纯 Node 环境跑协议/编解码**，wx 只在最外层适配器里被引用。这样单测完全不碰微信运行时，**也不需要 mock wx**。
> 如果一定要测 `WxBleTransport` 本身，则在 Node 里 `globalThis.wx = fakeWx` 即可——这是社区做法，**非官方推荐**，需在报告里如实标注。

---

## 7. 小程序 TypeScript 支持与 Node 互操作

### 7.1 开发者工具编译 TS [高]

官方《原生支持 TypeScript》：

> 从开发者工具 **1.05.2109101** 以上开始……支持以编译插件的形式，扩展编译功能。
> 旧项目：在 `project.config.json` 中修改 `setting.useCompilerPlugins` 为 `["typescript"]`。
> 新项目：创建时选 TypeScript / TypeScript + Less / TypeScript + Sass 模板。
> 目前的 ts 代码转换成 js 代码的逻辑，是由 **`@babel/plugin-transform-typescript`** 插件进行处理的，因此在编译过程中，**仅仅是移除了 ts 代码中类型声明等信息**。类型错误这类信息，**在编译过程是没有提示的**，只在编辑器中给予提示。
> 启用 typescript 编译插件后，js 文件也是支持的，如果存在同名的 ts 和 js 文件，则**优先使用 ts 文件**。
> miniprogram-ci 从 **1.6.1** 版本开始，也支持此功能。

出处：[https://developers.weixin.qq.com/miniprogram/dev/devtools/compilets.md](https://developers.weixin.qq.com/miniprogram/dev/devtools/compilets.md)

⚠️ 关键：**编译期不做类型检查**（只剥类型）。所以 `tsc --noEmit` 必须进 CI，不能指望开发者工具。

### 7.2 npm 构建 [高]

- 基础库 2.2.1+、工具 1.02.1808300+ 支持 npm。
- 必须 `工具 → 构建 npm`，生成 `miniprogram_npm` 目录。
- 直接 `require('node_modules/...')` **不生效**。
- 其他 npm 包约束：**只支持纯 js 包，不支持自定义组件**；不支持依赖 C++ addon 与 Node 内置库（`http`、`fs` 等）；不允许把 `require` 赋值给变量后使用、不允许 `require(变量)`。

出处：[https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.md](https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.md)

### 7.3 模块格式：小程序是 CommonJS [高]

官方《模块化》：

> 模块**只有通过 `module.exports` 或者 `exports`** 才能对外暴露接口。
> 在需要使用这些模块的文件中，使用 `require` 将公共代码引入。
> 在小程序中**直接引入 `node_modules` 并不会生效**。

出处：[https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/module.md](https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/module.md)

官方**只文档化了 CommonJS**（`exports.x = ...` / `require(...)`）。**没有**任何页面说明小程序原生支持 ESM `import`/`export`。
（`import`/`export` 在开发者工具里能用，是因为「将 JS 代码编译成 ES5」走了 babel preset-env 转换；这属于编译产物，不是运行时原生 ESM。[中]）

### 7.4 Node 直接 import 纯 TS [高，Node 官方]

- Node **v22.6.0** 引入 `--experimental-strip-types`。
- **v22.18.0（LTS）** 起**默认开启**类型擦除，`node example.ts` 直接可跑。
- **v23.6.0** 起默认开启（非 LTS 线）。
- 限制（官方原文）：
  - 只支持**可擦除语法**（type annotations、interfaces、type aliases、`import type`）；`enum`、`namespace`（含运行时代码）、构造函数参数属性**不支持**，需要 `--experimental-transform-types`。
  - import/require **必须写显式文件扩展名**（`./a.ts`）。
  - **必须 `import type`** 导入纯类型，否则会被当成值导入导致运行时 `ERR_MODULE_NOT_FOUND`。
  - **不做类型检查**，需 `tsc --noEmit` 单独跑。
  - `node_modules` 下的 TS 默认不擦除。

出处：[Node.js Learn — Running TypeScript Natively](https://nodejs.org/learn/typescript/run-natively)、[Node.js 22.6.0 Release](https://nodejs.org/en/blog/release/v22.6.0)、[Modules: TypeScript — Node.js Docs](https://nodejs.org/api/typescript.html)

> **对项目的直接结论**：
> 1. 「Node 可直接 import 纯 TS 源码」**在 Node ≥ 22.18 上成立**，vitest 本身用 esbuild 转译，**任何时候都成立**（vitest 不依赖 Node 原生擦除）。
> 2. 但**小程序侧是 CommonJS**。所以：
>    - 若 logic 层用 **ESM**（`export function`）→ 小程序需靠 babel 转 CJS，Node 侧天然 ESM，双向都通，但**要确认 `useCompilerPlugins` / ES6转ES5 开着**。
>    - 若 logic 层用 **CJS**（`module.exports`）→ Node 侧 `import()` CJS 也能用（default 导出），但 vitest 里 `import { foo } from './x.cjs'` 的具名导出依赖静态分析，**可能不稳**。
>    - **推荐：logic 层用 ESM 写，让小程序侧 babel 降级**。这样 Node/vitest 零配置，且是唯一两端都干净工作的格式。
> 3. 代码里**必须避免** `enum`、`namespace`、参数属性，否则 Node 原生擦除会挂（vitest 不会，但 CI 若用 `node --test` 或 tsx 之外的路径会挂）。
> 4. `import type` 必须显式写，建议开 `verbatimModuleSyntax`。

---

## 8. 切后台 / onHide 与 BLE 行为

### 8.1 官方运行机制 [高]

《小程序运行机制》：

> **前台与后台**：小程序启动后，界面被展示给用户，此时小程序处于「前台」状态。当用户「关闭」小程序时，小程序并没有真正被关闭，而是进入了「后台」状态，**此时小程序还可以短暂运行一小段时间，但部分 API 的使用会受到限制**。
> **挂起**：小程序进入「后台」状态一段时间后（**目前是 5 秒**），微信会**停止小程序 JS 线程的执行**，小程序进入「挂起」状态。此时小程序的内存状态会被保留，但**开发者代码执行会停止，事件和接口回调会在小程序再次进入「前台」时触发**。
> 当使用了**后台音乐播放、后台地理位置**等能力时，小程序可以在「后台」持续运行，不会进入到「挂起」状态。

出处：[https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/operating-mechanism.md](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/operating-mechanism.md)

### 8.2 BLE 适配器生命周期 [高]

《蓝牙 (Bluetooth)》：

> 要使用蓝牙能力（Beacon 除外）必须首先调用 `wx.openBluetoothAdapter` 初始化蓝牙适配器模块，**其生效周期为调用 `wx.openBluetoothAdapter` 至调用 `wx.closeBluetoothAdapter` 或小程序被销毁为止**。只有在小程序蓝牙适配器模块生效期间，开发者才能够正常调用蓝牙相关的小程序 API，并收到蓝牙模块相关的事件回调（**绑定监听不受此限制**）。

出处：[bluetooth.md](https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.md)

### 8.3 结论（区分官方确认 / 推断）

| 问题 | 结论 | 可信度 |
|---|---|---|
| 切后台后 BLE 连接是否立即断开？ | **官方未说明**。官方只说"部分 API 的使用会受到限制"和 5 秒后挂起。**没有任何官方文档说切后台会主动断开 BLE**。 | 官方**无表态** |
| 挂起后 notify 还会收到吗？ | **不会实时收到**。5 秒后 JS 线程停止，**事件和接口回调会推迟到再次进入前台时触发**（官方原文）。这意味着通知会**堆积/延迟**，不是丢失就是延迟，取决于系统缓冲区。 | [高]（由"回调会在再次进入前台时触发"直接推出） |
| 10006 的触发时机？ | 对**已断开**设备调用 read/write 时 reject `10006`。断连来源包括：开发者主动 `closeBLEConnection`、设备丢失、连接异常断开、系统回收。 | [高]（官方原文 + onBLEConnectionStateChange 描述） |
| 断连事件的正确监听方式？ | `wx.onBLEConnectionStateChange`，`connected:false`。**不是** 10006。 | [高] |

> **对 Transport 的含义**：
> - **不要在 `onHide` 里 `closeBLEConnection`**（除非产品要断）。但**必须**在 `onHide` 里 `stopBluetoothDevicesDiscovery`（官方明确扫描耗资源）。
> - **必须实现「回前台重连/状态校验」**：挂起期间的通知可能延迟批量到达，且连接可能已被系统回收。回前台时应 `getBLEDeviceServices` 或直接 `onBLEConnectionStateChange` 校验 `connected`，失败则走 10006 重连路径。
> - **Transport 的 `notifications` 流必须容忍「回前台后一次性涌入多条」**，不能假设实时性。

---

## 9. "单次写入 20 字节" 坑 & 官方对写长度的说明

### 9.1 官方说明汇总 [高]

| 出处 | 原文 |
|---|---|
| `wx.writeBLECharacteristicValue` | "小程序**不会**对写入数据包大小做限制，但系统与蓝牙设备会限制蓝牙 4.0 单次传输的数据大小，超过最大字节数后会发生写入错误，**建议每次写入不超过 20 字节**。" |
| 同上 | "若单次写入数据过长，**iOS 上存在系统不会有任何回调的情况（包括错误回调）**。" |
| `framework/device/ble.html` 注意事项 | "在与蓝牙设备传输数据时，需要注意 MTU（最大传输单元）。**如果数据量超过 MTU 会导致错误**，建议根据蓝牙设备协议进行分片传输。**安卓设备可以调用 `wx.setBLEMTU` 进行 MTU 协商**。在 **MTU 未知的情况下，建议使用 20 字节为单位传输**。" |

出处：[writeBLECharacteristicValue](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.md)、[BLE 指南](https://developers.weixin.qq.com/miniprogram/dev/framework/device/ble.md)

### 9.2 已知坑（社区，非官方）[低，但多源交叉一致]

1. **iOS 超限静默无回调** —— 官方已承认（见上），这是最致命的坑：`await` 永久挂起。**必须自己加超时。**
2. **安卓 notify 后立即 write 触发 10008** —— 官方已承认（"在部分机型上会发生 10008 系统错误"）。需要在 notify 成功后**加延时/串行化**再写。
3. **并行 write 会失败** —— 官方已承认（"并行调用多次会存在写失败的可能性"）。Transport **必须串行化写队列**。
4. **`setBLEMTU` 在部分机型（如 OPPO ColorOS 15）报 `setBLEMTU:fail:internal error`** —— 微信开放社区有开发者反馈（[链接](https://developers.weixin.qq.com/community/develop/doc/00062aa2864e805cbe14e111761400)）。需 try/catch 并回退到 20 字节。
5. **安卓 GATT ERROR / status 133** —— 连接未配对释放导致；官方 BLE 指南已提示"建立连接和关闭连接必须要成对调用"。
6. **iOS 的 `serviceId`/`characteristicId` 必须来自发现接口，不能硬编码** —— 官方原文。
7. **iOS deviceId 是动态 UUID** —— 官方原文，不能持久化后直接复用。
8. **安卓部分机型会多出 `00001800` / `00001801` 服务** —— 官方原文，"注意不要使用这两个服务"。

### 9.3 一个被广泛误引的说法，需要纠正 [中]

社区大量博客（含 CSDN、博客园）声称：
> "微信小程序 BLE API 默认单次接收的数据长度限制为 20 字节……如果设备发送超过 20 字节，`onBLECharacteristicValueChange` 会自动截断，仅返回前 20 字节。"

**这个说法在官方文档中找不到任何依据**，且逻辑上可疑（截断是 GATT 层行为，不是 API 层）。官方对**接收**长度**完全没有**给出限制说明。→ 报告中应标注为「社区传言，未获官方确认，需实测」。

---

## 10. 对 Transport 设计的直接建议（基于上述事实）

1. **接口必须暴露 `writeType`**，并按 `properties.writeNoResponse` / `properties.writeDefault` 决定默认值，不要写死。
2. **写入必须串行化**（官方承认并行会失败），单条写操作**必须有超时**（官方承认 iOS 超限无回调）。
3. **分片默认 20 字节**，仅在 `canIUse('setBLEMTU') && 平台为安卓` 时尝试协商，并用 `getBLEMTU()` / `onBLEMTUChange` 取**真实值**再放大分片。**真实 payload = 真实MTU - 3**。
4. **断连必须双路径**：`onBLEConnectionStateChange(connected:false)` → `onDisconnect`；读写 reject `errCode===10006` → `NotConnectedError`（可重连）。
5. **错误码归一化为可辨识的 error 类型**（`NotInitializedError` / `AdapterUnavailableError` / `DeviceNotFoundError` / `NotConnectedError` / `TimeoutError` / `SystemError`），不要在业务层裸判 `errCode`。
6. **`onHide` 停扫描**，`onShow` 校验连接有效性。
7. **单测只测纯逻辑**（协议编解码 + 分片策略 + 状态机），**不引入 miniprogram-simulate**。wx 适配器单独用手写 fake `wx` 覆盖测试，不依赖官方工具。
8. **logic 层用 ESM**，配置 `verbatimModuleSyntax` + 显式 `import type`，避免 `enum`/`namespace`/参数属性；`tsc --noEmit` 进 CI。

---

## 附：本报告引用的官方 URL 全清单

**API 文档（.md 端点，官方提供）**
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.openBluetoothAdapter.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.closeBluetoothAdapter.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getBluetoothAdapterState.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.onBluetoothAdapterStateChange.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.startBluetoothDevicesDiscovery.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.stopBluetoothDevicesDiscovery.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getBluetoothDevices.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.getConnectedBluetoothDevices.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.onBluetoothDeviceFound.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.createBLEConnection.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.closeBLEConnection.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEDeviceServices.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEDeviceCharacteristics.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.readBLECharacteristicValue.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.notifyBLECharacteristicValueChange.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLEConnectionStateChange.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLECharacteristicValueChange.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.setBLEMTU.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEMTU.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLEMTUChange.md
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEDeviceRSSI.md

**指南 / 框架**
- https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.md
- https://developers.weixin.qq.com/miniprogram/dev/framework/device/ble.md
- https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/api.md
- https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/module.md
- https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/operating-mechanism.md
- https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/js-support.md
- https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/unit-test.md

**工具**
- https://developers.weixin.qq.com/miniprogram/dev/devtools/compilets.md
- https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.md
- https://developers.weixin.qq.com/miniprogram/dev/devtools/remote-debug-2.md

**官方 GitHub**
- https://github.com/wechat-miniprogram/miniprogram-simulate
- https://raw.githubusercontent.com/wechat-miniprogram/miniprogram-simulate/master/docs/api.md
- https://raw.githubusercontent.com/wechat-miniprogram/miniprogram-simulate/master/docs/todo.md

**Node.js 官方**
- https://nodejs.org/learn/typescript/run-natively
- https://nodejs.org/en/blog/release/v22.6.0
- https://nodejs.org/api/typescript.html

**社区（低可信度，仅作线索）**
- https://developers.weixin.qq.com/community/develop/doc/00062aa2864e805cbe14e111761400 （setBLEMTU internal error / 10008 反馈）
- https://developers.weixin.qq.com/community/minihome/doc/00046490d24928267d81b45eb61c00 （miniprogram-ci 不支持 TS 编译，注意：compilets.md 已声明 1.6.1+ 支持，此帖可能过期）