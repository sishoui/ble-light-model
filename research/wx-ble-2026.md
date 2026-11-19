# 微信 BLE 与页面测试工具现状（2026-11）

> **Ticket**：[#29 微信 BLE 与页面测试工具现状 2026-11](https://github.com/sishoui/ble-light-model/issues/29)
> **核查日期**：2026-11-19
> **分支**：`research/wx-ble-2026`
> **方法**：微信官方文档（含官方 `.md` 端点）、npm registry 与 npm tarball 源码、GitHub API、微信开放社区帖子。
> **可信度标注**：
> - **[官方]** 官方文档原文；
> - **[源码]** 官方 npm 包 / 官方仓库源码；
> - **[社区]** 社区实践或帖子，未经官方确认；
> - **[推断]** 由文档/源码推导，未实测；
> - **[未验证]** 需要在本项目环境里做 spike。
>
> 本文与同仓库既有调研分支（`research/wx-ble-facts`、`research/test-automation-facts`、`research/pc-ble-central`）有重叠。本文以 2026-11 的最新版本复核这些事实，并重点回答 #29 的“页面层无手机方案”与取舍问题；结论以本文为准。

---

## 0. 结论（先看这一节）

### 0.1 一句话结论

**没有手机时，页面层可以做到“在开发者工具模拟器里跑真实页面 + 用可注入的 FakeTransport 或 `mockWxMethod` 打桩 BLE”，足以回归 UI、状态机、错误分支和路由；但真实微信 BLE 栈（扫描、连接、服务发现、MTU、notify 时序、后台/锁屏）无法覆盖，必须留给 Android 人工冒烟或云真机。**

### 0.2 推荐组合

| 层 | 推荐工具 | 版本（2026-11） | 无手机？ | 作用 |
|---|---|---|---|---|
| 纯逻辑 / 协议 / 分片 / 状态机 | Node + vitest + 手写 `FakeTransport` | 项目现有 | ✅ | 最快、最稳、可进 CI |
| 页面 UI / 数据 / 事件 / 错误分支 | `miniprogram-automator` + 微信开发者工具模拟器 | **0.13.0**（2026-10-15） | ✅ | 跑真实 WXML/页面逻辑，BLE 用桩 |
| PC 侧真实 BLE 链路 | Python `bleak` 本地桥接 C3 | 3.1.0（2026-11-07，既有调研） | ✅（需 PC 蓝牙） | 验证真实 GATT / MTU / notify |
| 展示型自定义组件单测 | `miniprogram-simulate` | **1.7.0**（2026-11-12） | ✅ | 仅组件，不跑页面 |
| 微信 BLE 栈真机行为 | Android 真机 + 人工清单 / MiniTest 云真机 | 官方 | ❌ / 云真机 | 权限、连接、后台、iOS 差异 |
| ~~页面层无头运行时~~ | ~~`wxa-runner`~~ | 已下线 | — | **不采用** |

### 0.3 必须记住的三条边界

1. **`miniprogram-automator` 不是“无头浏览器”**：它控制的是**微信开发者工具 GUI**（Windows/macOS 桌面版），不能像 Playwright 那样在 Linux 容器里无头跑。它可以在模拟器里跑页面，不需要手机；但需要一台开着开发者工具的 PC。
2. **`miniprogram-simulate` 不能跑页面**：它只注册 `Component`/`Behavior`，没有 `Page`；官方维护者也明确说页面测试应走开发者工具自动化（见 §2.1）。
3. **Skyline 没有官方 E2E**：官方文档没有承诺，automator 文档/源码也没有 Skyline 分支；不要把 Skyline 页面纳入自动化基线，除非先做 spike（见 §2.2）。

---

## 1. `miniprogram-automator`

### 1.1 版本与官方支持状态

| 事实 | 值 | 来源 |
|---|---|---|
| npm 最新版 | **0.13.0**，发布于 **2026-10-15** | [npm registry](https://registry.npmjs.org/miniprogram-automator) |
| 上一版 | 0.12.1，发布于 2023-11-07 | 同上 |
| npm `latest` dist-tag | 0.13.0 | 同上 |
| 维护者 | `wechat-miniprogram`（微信官方 npm 组织）+ `tidyzq` | 同上 |
| 官方文档最后编辑 | 2026-08-21（自动化首页/快速开始）；2026-04-17（真机自动化）；2026-07-04（Page） | 官方文档页脚 |
| 是否废弃 | 否；npm 未标记 deprecated | npm registry |
| 公开 changelog | **没有**；0.13.0 只有 npm 包，仓库在腾讯内网（`git.code.oa.com`） | [package.json](https://registry.npmjs.org/miniprogram-automator/latest) |
| 周下载量 | 约 24,500（npm 页面显示） | [npm 页面](https://www.npmjs.com/package/miniprogram-automator) |

**判断**：官方仍在维护，但节奏很慢（2023-11 到 2026-10 隔了近三年才有 0.13.0）。可以依赖，但应**锁定精确版本**（`"miniprogram-automator": "0.13.0"`），不要用 `^` 自动吃新版本，因为 0.13.0 没有公开 changelog，行为变化不可预期。

> **[未验证]** 0.13.0 相对 0.12.1 具体改了什么。可下载两个 tarball 做 diff；本次只确认了 API 表面没有明显删减。

### 1.2 是否强制真机调试？是否必须扫码/点“真机调试”？

**不强制真机。** automator 的默认工作对象就是开发者工具里的**模拟器**；`miniProgram.remote()` 才是可选的“切到真机”。

| 场景 | 是否需要手机 | 是否需要人工操作 | 说明 |
|---|---|---|---|
| 模拟器自动化 | ❌ | ❌（首次需在工具里开启 CLI/HTTP 调用） | `automator.launch()` 或 `connect()` 直接控制模拟器 |
| 真机自动化：手工路径 | ✅ | **需要**：在工具里点“真机调试”，等手机扫码/连接 | 官方原文：“如果工具是打开常驻并且使用 `automator.connect` 接口进行连接，那么可以先手工启用工具的真机调试功能后再运行测试脚本。” [官方](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/remote.html) |
| 真机自动化：`remote()` | ✅ | **需要扫码** | 调用后控制台打印二维码，扫码连接后脚本继续；源码在 `Tool.enableRemoteDebug` 后等待 `Tool.onRemoteDebugConnected`，**没有超时** [源码] |
| 真机自动化：`remote(true)` | ✅ | 官方称**无需扫码** | Page 文档：“auto 为 true 时，真机上会自动调起小程序，无需扫码，仅支持微信 7.0.6（安卓）、6.6.7（iOS）及以上版本。” [官方](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/miniprogram.html) |

**重要矛盾（需要实测）**：

- `remote(true)` 的官方描述是“自动调起、无需扫码”，但 `remote.md` 的通篇描述仍是“打印二维码、扫码连接”；两者在文档层面不一致。
- 0.13.0 源码里 `remote(auto)` 只是把 `auto` 传给 `Tool.enableRemoteDebug`，**不打印二维码**，然后 `await new Promise(... once('Tool.onRemoteDebugConnected'))`，**没有任何超时**。
- 所以 `remote(true)` 在“手机没连上/不在同一环境/微信版本不满足”时不会报错，而是**静默挂起**。

> **结论**：模拟器自动化完全不需要扫码；真机自动化至少需要一次“人工把手机接上”（扫码或工具内启用）。`remote(true)` 的免扫码能力标记为 **[未验证]**，不要把它作为无人值守方案的前提；如果要用，必须自己包 60s 看门狗。

### 1.3 `cli auto` 能否常驻？

官方 CLI 文档对 `cli auto` 的描述是“**开启小程序自动化功能**”，参数为：

```bash
cli auto --project /path/to/project --auto-port 9420
```

- `--auto-port` 是**自动化监听端口**（例如 9420），不是工具的 HTTP 服务端口；后者是 `--port`。
- `cli auto` 会打开指定项目并开启自动化端口；之后脚本用 `automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })` 连接。
- 官方把“工具打开常驻 + `connect`”作为真机自动化的推荐路径（见上一节）。这说明**可复用的是工具窗口里的自动化端口**，而不是 CLI 进程本身。
- 工具窗口关闭、工具退出、电脑重启后，端口消失，需要重新执行 `cli auto`；脚本侧 `connect()` **没有超时参数**，连不上会立刻抛 `Failed connecting to ...`（源码在 `Connection.create` 的 WebSocket error 上 reject）。
- 用 `disconnect()` 只断自动化连接；`close()` 会关闭项目窗口。常驻工作流必须用 `disconnect()`。

> **[社区]** Windows + Node ≥18.20 下，`automator.launch()` 可能因 Node 对 `.bat` 的 `spawn` 限制报 `spawn EINVAL (-4071)`，且错误可能误报成 `cliPath` 不对；常驻场景建议直接用 `cli.bat auto` + `connect`，绕开 `launch()`。

### 1.4 能断言什么

| API | 能做什么 | 版本门槛 | 备注 |
|---|---|---|---|
| `page.data(path?)` | 读取页面渲染数据，可带路径 | automator 0.6.0；基础库 **2.9.0** | 最常用的业务断言入口 |
| `page.setData(data)` | 改页面数据 | — | 会触发渲染更新 |
| `page.$ / page.$$` | 取页面元素/元素数组 | — | **不能选自定义组件内部元素**；组件内用 `element.$` |
| `element.attribute(name)` | 读标签特性（返回字符串） | — | 可读 `class` / `id` |
| `element.property(name)` | 读组件属性（类型不限） | automator 0.9.0；基础库 **2.9.5** | 读 `input.value` 等 |
| `element.text()/style()/size()/offset()/wxml()/outerWxml()/value()` | 文本、样式、尺寸、位置、WXML、值 | — | `style` 返回计算样式；`property`/`input` 的版本见上/下 |
| `element.tap()/longpress()/touchstart()/touchmove()/touchend()` | 真实手势 | touch 系列 0.8.0 / 2.9.1 | 比 `trigger` 更接近用户 |
| `element.trigger(type, detail)` | 触发绑定事件 | — | **不能改变组件状态**，也不能触达 `tap` 等用户操作 |
| `element.input(value)` | 输入文本 | 0.9.0 / 2.9.5 | 仅 `input` / `textarea` |
| `element.callMethod()/data()/setData()` | 调自定义组件方法/读写组件数据 | 0.6.0 / 2.9.0 | **仅自定义组件** |
| `miniProgram.evaluate(fn, ...args)` | 往 AppService 注入代码并返回结果 | — | 函数会被序列化，**不能用闭包**；返回值必须 JSON 可序列化 |
| `miniProgram.callWxMethod(method, ...args)` | 直接调 `wx.*` | — | 异步方法不用传 success/fail |
| `miniProgram.mockWxMethod(method, result/fn, ...args)` | 覆盖 `wx.*` 的返回 | 函数形式 0.9.0 / 2.9.5 | 函数内可用 `this.origin` 调原方法；**不能用闭包** |
| `miniProgram.restoreWxMethod(method)` | 撤销 mock | — | 测试后清理 |
| `miniProgram.exposeFunction(name, fn)` | 在 AppService 暴露全局函数，**小程序 → 脚本** | — | **不支持小程序侧取返回值** |
| `miniProgram.on('console', msg)` | 捕获 `console.log` 等 | — | `msg.type` / `msg.args`；有日志长度上限 |
| `miniProgram.on('exception', err)` | 捕获页面 JS 错误 | — | `message` / `stack` |
| `miniProgram.pageStack()/currentPage()/navigateTo()/reLaunch()/switchTab()` | 页面栈与路由 | — | `changeRoute` 内部会 `sleep(3s)` |
| `miniProgram.screenshot()` | 截图 | 0.9.0 / 2.9.5 / 工具 1.02.2001082 | **仅模拟器**；真机客户端不可用 |
| `miniProgram.testAccounts()` | 多账号 | 0.9.0 / 工具 1.02.2002272 | — |

**不能断言/不能做的**：

- 原生组件（`video`、`map` 等）的内部状态与原生交互；
- 系统权限弹窗、微信原生授权弹窗（除非用未文档化的 `native()`，见 §1.6）；
- 真实 BLE 适配器、GATT、MTU、系统蓝牙开关；
- 真机截图；
- 像素级/视觉回归（没有官方截图对比能力）。

### 1.5 支持的基础库 / 工具 / Node 版本

| 项目 | 最低要求 | 来源 |
|---|---|---|
| Node.js | **> 8.0** | 官方快速开始 |
| 微信开发者工具 | **1.02.1907232** | 官方快速开始 |
| 基础库（自动化整体） | **2.7.3** | 官方快速开始；源码 `checkVersion()` 会硬校验，低于 2.7.3 直接抛错 |
| `page.data` | 基础库 **2.9.0** | Page 文档 |
| `element.property` / `element.input` / `mockWxMethod` 函数形式 | 基础库 **2.9.5** | Element / MiniProgram 文档 |
| 插件 wx 方法 | 基础库 **2.19.3** | MiniProgram 文档 |
| 真机调试 2.0（如果使用） | Android 微信 **8.0.6+** / iOS **8.0.8+**，基础库 **2.18.1+** | 真机调试 2.0 文档 |

> **建议**：项目基础库钉在 **≥2.9.5**（实际大概率是 3.x），这样 `page.data`、`mockWxMethod` 函数形式、`element.property` 都可用；不要用 2.7.3 作为测试基线，否则一半断言 API 不可用。

### 1.6 对 BLE 真机行为的可观测性

**能观测到的**（都在“小程序代码能看到什么”这一层）：

| 通道 | 方向 | 是否需要生产代码加钩子 | 能拿到什么 | 限制 |
|---|---|---|---|---|
| `page.data()` | 脚本 ← 页面 | 否 | 连接状态、8 条灯带状态、错误提示等 UI 派生数据 | 只能看到页面 `data`，不是 GATT 原始层 |
| `miniProgram.evaluate()` 直接调 `wx.getBLEMTU` / `getBluetoothAdapterState` / `getConnectedBluetoothDevices` | 脚本 → AppService | 否 | MTU、适配器状态、已连设备列表（JSON 可序列化） | 只能调 `wx.*` 暴露的只读信息 |
| `evaluate()` 注册第二个 `wx.onBLECharacteristicValueChange` + `exposeFunction` | 小程序 → 脚本 | **否** | notify 帧的 hex/base64 | 所有数据要转 JSON 可序列化；`offBLECharacteristicValueChange()` 不带回调时可能清掉所有监听（需实测）；重连后要重新注入 |
| `mockWxMethod()` 替换 BLE API | 脚本 → 小程序 | 否 | 可以伪造连接/服务/特征/MTU/写入结果 | 只影响 `wx` 调用，不产生真实 BLE 行为；安装时机要早于页面 `onLoad` |
| `on('console')` | 小程序 → 脚本 | 视生产代码是否打日志 | 生产代码里已有的逐帧日志 | 有日志长度上限，长帧可能截断；JSON 序列化 |
| `native()`（源码存在，未文档化） | 脚本 → 工具 | 否 | `authorizeAllow()` / `authorizeCancel()` / `confirmModal()` 等原生弹窗操作 | 不在官方文档；跨工具版本未验证 |

**BLE notify 注入示例**（不要求生产代码加钩子）：

```js
const automator = require('miniprogram-automator')

const miniProgram = await automator.connect({
  wsEndpoint: 'ws://127.0.0.1:9420',
})

const frames = []
await miniProgram.exposeFunction('onBLEFrame', hex => {
  frames.push(hex)
})

await miniProgram.evaluate(() => {
  wx.onBLECharacteristicValueChange(res => {
    const hex = Array.from(new Uint8Array(res.value))
      .map(b => ('0' + b.toString(16)).slice(-2))
      .join('')
    onBLEFrame(hex) // exposeFunction 注册的全局名
  })
})
```

> 注意：`evaluate` 的函数不能用闭包；`onBLEFrame` 必须是 AppService 全局名；`ArrayBuffer` 不要原样穿过通道，先转 hex。

**观测不到的**：

- GATT 层实际协商的 MTU（只能读到微信给的 `getBLEMTU`，且 `setBLEMTU` 的 success 回显的是“你传的值”，不是对端真实值）；
- 系统为什么断连（`onBLEConnectionStateChange` 只给 `connected: boolean`，没有 reason）；
- iOS 上“写入超长但系统完全不回调”的底层原因；
- 通知在系统缓冲区里排队/丢弃的情况；
- App 切后台后的真实连接存活状态（只能回前台再校验）。

> 这些必须用 **PC 侧 `bleak` + C3 固件日志 + Android HCI snoop / 系统蓝牙日志** 来补，不能指望 automator。

### 1.7 已知坑（按严重程度）

1. **`connect()` / `remote()` / 单次 `send()` 都没有超时** [源码]。`remote()` 在没人扫码时会永久挂起；`connect()` 失败会立刻 reject，但连接建立后如果工具挂掉，只有下一次调用才会暴露。**所有调用都要包超时/看门狗。**
2. **`remote(true)` 的“免扫码”是文档承诺，不是稳定行为** [未验证]。源码只发 `auto: true` 然后等事件；不打印二维码，也不报错。
3. **`page.$` 选不到自定义组件内部元素** [官方]。必须 `element.$` 逐层进；复杂组件建议加稳定的 `class`/`id`。
4. **`screenshot()` 真机不可用** [官方]。真机回归不要做截图断言。
5. **`mockWxMethod` 装晚了会失效** [推断]。`automator.launch()` 会立刻启动小程序，`App.onLaunch` 可能已经跑过；如果连接逻辑在 `App.onLaunch`，先 `mock` 再 `reLaunch` 也救不了 App 级调用。**最稳的是在页面/Transport 层做依赖注入，不要依赖 `wx` mock 的时机。**
6. **Windows `launch()` 的 `spawn EINVAL`** [社区]。用 `cli.bat auto` + `connect`。
7. **真机 remote 下 `page.data` / `element.*` 官方没有逐项保证** [官方文档未排除 + 社区在用]。官方只明确排除了 `screenshot`；真机断言要实测，不要假设和模拟器完全一致。

---

## 2. 页面层替代方案

### 2.1 `miniprogram-simulate` 的真实能力

**结论：它是“自定义组件单元测试工具”，不是页面运行时。页面级 E2E 不能用它。**

#### 2.1.1 官方定位

- 官方 README 第一句：“**小程序自定义组件测试工具集**”。
- 官方单元测试文档：“我们提供了一个测试工具集以支持**自定义组件**在 nodejs 单线程中也能运行起来。” [官方](https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/unit-test.md)
- 机制：把双线程的自定义组件树压成单线程，用 DOM 环境渲染（jsdom + jest，或 karma + 真浏览器）。

#### 2.1.2 为什么不支持页面（硬证据）

1. **源码只注册 `global.Component` 和 `global.Behavior`，没有 `global.Page`** [源码]。`simulate.load(pagePath)` 会去 `require` 页面 JS，页面里的 `Page({...})` 直接 `ReferenceError: Page is not defined`。
2. 维护者在 issue #26（“只能测试自定义组件，小程序页面没有提供”）下回复：“目前这套主要针对自定义组件的单元测试……页面应该很少这种情况……开发者工具有提供一个自动化测试能力……可以做集成测试，这个就是标准的页面环境了。” [GitHub #26](https://github.com/wechat-miniprogram/miniprogram-simulate/issues/26)
3. 维护者在 issue #113 下再次回复：页面测试建议用开发者工具自动化（miniprogram-automator），那是标准页面环境。 [GitHub #113](https://github.com/wechat-miniprogram/miniprogram-simulate/issues/113)
4. `triggerPageLifeTime()` 只是“触发组件所挂载页面的生命周期”，不等于能跑一个 `Page`。

> 社区有一种 workaround：把页面逻辑改写成 `Component`，或自己定义 `global.Page` 做 shim，再 `simulate.load`。这能测“页面级组件”的一部分逻辑，但没有真实 `Page` 生命周期、路由、页面栈、`getCurrentPages()`，**不能当作页面 E2E**。

#### 2.1.3 能做什么

| 能力 | 支持 | 说明 |
|---|---|---|
| 加载自定义组件（路径或 definition） | ✅ | `simulate.load(path)` / `load(definition)` |
| WXML 渲染 | ✅ | 默认官方编译器（`wcc`）；也可用 JS 模拟编译器（`compiler: 'simulate'`） |
| WXSS / Less | ✅ | 可计算样式，`window.getComputedStyle` 可断言 |
| `setData` / `data` | ✅ | `comp.data`、`comp.setData()` |
| 事件模拟 | ✅ | `dispatchEvent('tap'/'touchstart'/'customevent')` |
| 生命周期 | ✅ | `triggerLifeTime('attached'/'ready'/'moved')` |
| 子组件查询 | ✅ | `querySelector` / `querySelectorAll` |
| 快照 | ✅ | `miniprogram-simulate/jest-snapshot-plugin` |
| 页面 / 路由 / 页面栈 | ❌ | 没有 `Page` 注册 |
| `getCurrentPages()` | ❌ | issue #98 / #49 报 `ReferenceError` |
| 抽象节点 / 插件 | ❌ | 官方 todo 明确不支持 |
| `template` / 外链 wxs / 外链 wxml（JS 编译器） | ❌ | 官方 todo 明确不支持 |
| 真实 `wx.*` | ❌ | 内置 `wx` 是桩：BLE API 返回 `ok`、空数组、`mtu: 0`；官方说“不会实现真正的功能，可以自行覆盖” |

#### 2.1.4 能否 mock `wx.*`

**能，但不是官方 API。**

- `definition.js` 里：

  ```js
  if (typeof global.wx === 'object') global.wx = Object.assign(api, global.wx)
  else global.wx = api
  ```

  也就是说：在 `require('miniprogram-simulate')` **之前**先把 `global.wx` 设成你的 fake，`Object.assign` 会保留你的字段；之后再改 `global.wx.xxx` 也可以。
- 官方文档只承诺“可以自行覆盖掉测试工具集中的 api 接口和内置组件”，没有 `simulate.mockWx()` 之类的 API。
- 但即使 mock 了 `wx`，**你仍然没有页面运行时**；这只对“组件内部调 wx”有意义。

#### 2.1.5 维护状态

| 事实 | 值 |
|---|---|
| 最新版 | **1.7.0**，2026-11-12 |
| 上一版 | 1.6.2，2026-06-29 |
| 最近提交 | 2026-11-12：`usingComponents` 路径找不到时改为抛错，不再静默渲染空节点 |
| 依赖 | `miniprogram-compiler`（npm 最新 0.2.3，2024-03-08）——编译器依赖较旧 |
| 结论 | 仍在维护，但**能力范围没变**：组件单测，不是页面 E2E |

> **[未验证]** 1.7.0 在 Windows + 当前官方编译器下对复杂 WXML（`wx:for`、`slot`、`wxs`）的覆盖度。建议只拿它测纯展示组件（灯带卡片、颜色选择器、状态徽标），不要测连接页。

### 2.2 Skyline 是否有官方 E2E？

**没有。**

- Skyline 官方文档、更新日志一直在更新（最新 **1.4.25，2026-11-12**），但没有“自动化测试/E2E”章节，也没有提到 miniprogram-automator。
- automator 的官方文档（Automator / MiniProgram / Page / Element / 真机自动化）**完全没有提 Skyline**。
- automator 0.13.0 的 `out/*.js` 里**没有任何 `skyline` 分支** [源码]。
- Skyline 是不同于 WebView 的渲染后端（独立渲染线程 + AppService 内 DOM 树创建），`page.$` 依赖渲染层节点树，因此**不能假设 `page.$` / `element.*` 在 Skyline 页面上可用** [推断]。
- `page.data` / `page.callMethod` / `evaluate` 走 AppService，理论上更可能不受渲染后端影响，但**没有官方承诺，未验证**。

**建议**：

1. 本项目（8 路灯带控制，页面简单）**继续用默认 WebView 渲染**，把可测试性放在性能之前；不要为了 Skyline 的动画/性能把主流程页面切过去。
2. 如果未来必须用 Skyline：把“页面数据/状态”断言作为基线（`page.data`），把“元素/点击”断言标记为不支持；先做一次 1 小时的 spike 验证 `page.$` 是否返回 null。
3. 不要把 Skyline 页面纳入发布门禁。

### 2.3 其它仍在维护的方案

| 方案 | 性质 | 最新版本/状态（2026-11） | 能否无手机 | 评价 |
|---|---|---|---|---|
| **Minium** | 腾讯微信团队官方 Python 测试框架 | PyPI **1.6.1**，2026-09-14；官方文档 2026-08-21 | 本地需开发者工具+手机；云测不需要自己的手机 | 能力与 automator 高度重叠（页面数据、注入 AppService、mock wx），但技术栈是 Python；适合作为云测/补充，不适合作为 JS 主链路 |
| **MiniTest 小程序云测** | 微信官方云真机服务 | 官方文档 2026-08-21；每周 150 分钟免费 | ✅ **不需要自己的手机** | 上传 Minium 脚本到云真机跑；适合发版前真机冒烟；需要登录、上传、配额，不是本地日常回归 |
| `miniprogram-automator` 社区封装（如 `miniprogram-automator-mcp`、`miniprogram-automator-extension`） | 社区 wrapper | 存在 2026 年的社区项目；更新状态未逐一核实 | 取决于底层 | 只是把 automator 包一层（MCP/链式 API），**不增加新运行时能力**；不建议作为架构依赖 |
| `@mpxjs/e2e` | Mpx 生态封装 | 最新 **0.0.13**，2022-11-24 | 否 | 已长期未更新，不推荐 |
| `wxa-runner` | 社区“浏览器里跑官方基础库” | 官方仓库已标明“**已应腾讯公司要求下线**”（2026-11-16 仍有 push）；社区 fork `hackwaly/wxa-runner` 仅 2 star | 原本可无头 | **不采用**，与 ticket 前提一致 |
| `miniprogram-ci` | 官方 CI 工具 | 持续维护 | — | 只能编译/预览/上传，**不能跑页面运行时**；可作为构建/上传环节，不是测试工具 |

> **结论**：2026-11 的页面层，**官方 `miniprogram-automator` 是唯一仍在维护、能跑真实页面的本地方案**。没有“wxa-runner 的合格替代品”；社区方案要么是 wrapper，要么已停更。无手机的真机替代只有**云真机（MiniTest）**。

### 2.4 推荐组合（页面层）

```text
【日常、无手机】
  vitest（logic/协议/分片/状态机）
    + miniprogram-automator 0.13.0（开发者工具模拟器，WebView 渲染）
    + 页面通过依赖注入使用 FakeTransport（首选）/ mockWxMethod（兜底）
    + miniprogram-simulate 1.7.0（仅纯展示组件，可选）

【有 PC、无手机，要碰真实 BLE】
  Python bleak 3.1.0 本地桥接 C3
    → 验证真实 GATT / MTU / notify / 分片
    → 不经过微信栈，不能替代微信侧验证

【发版前】
  Android 真机人工冒烟清单（§4.3）
    或 MiniTest 云真机（没有自己的手机时）
```

**CI 现实**：automator 依赖微信开发者工具 GUI，官方只提供 Windows/macOS 桌面版；**不能在 Linux 容器里无头跑**。因此：

- logic + bleak 可以在 CI/PC 上跑；
- 页面 E2E 放在一台常开的 Windows/macOS 机器上做 nightly，或本地手动触发；
- 不要把页面 E2E 放进 PR 必过门禁。

---

## 3. BLE API 现状（2026-11 复核）

> 本节所有“官方”结论均来自当前 API 文档；本次复核**未发现**这些 API 的版本号或注意事项相对既有调研有语义变化。API 页面没有标注“最后编辑时间”，核查日期为 2026-11-19。

### 3.1 `writeBLECharacteristicValue` 的长度上限与平台差异

| 事实 | 内容 | 来源 |
|---|---|---|
| 基础库 | **1.1.0** | 官方 API 页 |
| `value` 类型 | **必须是 `ArrayBuffer`** | 官方参数表 |
| API 层是否限制长度 | **不限制**。官方原文：“小程序不会对写入数据包大小做限制，但系统与蓝牙设备会限制蓝牙 4.0 单次传输的数据大小，超过最大字节数后会发生写入错误，**建议每次写入不超过 20 字节**。” | 官方“注意” |
| 20 字节是什么 | **建议值**，不是硬上限；真实上限由 OS/对端 MTU 决定 | 官方 |
| iOS 超长 | **可能完全没有任何回调（包括错误回调）**；`await` 会永久挂起 | 官方“注意” |
| Android 时序/超长 | 调用 `notifyBLECharacteristicValueChange` 成功后**立即**写，部分机型会报 **10008** 系统错误 | 官方“注意” |
| 并行写 | “并行调用多次会存在写失败的可能性” | 官方“注意” |
| `writeType` | 基础库 **2.22.0**；`"write"` 强制有回复写，`"writeNoResponse"` 强制无回复写；不支持时报错 | 官方参数表 |
| 默认写模式 | **iOS 优先 `write`，Android 优先 `writeNoResponse`** | 官方参数表 |

**对测试的含义**：

- 分片默认 **20 字节**是唯一安全基线；只有在 Android 上 `setBLEMTU` 成功且 `getBLEMTU` 读到真实值后，才把分片放大到 `MTU - 3`。
- Transport 必须**串行化写队列** + **每次写超时**；不能依赖 `await` 一定 settle。
- C3 固件如果只支持 `write_no_response`，Android 默认可通，iOS 默认 `write` 可能失败；Transport 必须能显式指定 `writeType`。

### 3.2 `setBLEMTU` / `getBLEMTU` / `onBLEMTUChange`

| API | 基础库 | 平台 | 关键事实 |
|---|---|---|---|
| `wx.setBLEMTU` | **2.11.0** | **仅 Android 5.1+** | 官方原文：“仅安卓系统 5.1 以上版本有效，iOS 因系统限制不支持。” 需在 `createBLEConnection` 成功后调用。`mtu` 范围 **(22, 512)**，单位 bytes。`success.mtu` **“与传入参数一致”**（Android 客户端 8.0.9+）——**这是回显，不是对端真实协商值**；`fail` 也可能带 `mtu`，协商失败则无此参数。 |
| `wx.getBLEMTU` | **2.20.1** | Android / iOS | 需连接成功后调用。iOS 有 **`writeType`** 参数（`write` / `writeNoResponse`，默认 `write`），说明 iOS 下两条写链路的 MTU 可能不同。官方注意：“**iOS 系统中 MTU 为固定值**；安卓系统中，MTU 会在系统协商成功之后发生改变，建议使用 `onBLEMTUChange` 监听。” |
| `wx.onBLEMTUChange` | **2.20.1** | **仅 Android 触发** | 回调 `{ deviceId, mtu }`。官方功能描述明确“（仅安卓触发）”。 |

**MTU 语义**：

- 小程序里的 MTU 是 **ATT_MTU**，包含 OpCode + Attribute Handle；**实际 payload = ATT_MTU - 3**。
- ATT 默认 MTU 23 → payload 20；这就是“20 字节”建议的来源。
- iOS 的固定 MTU 具体数值官方没给；**必须用 `getBLEMTU` 在目标机型上读**，不要硬编码。
- `setBLEMTU` 在部分 Android 机型会失败（社区有 `internal error` 反馈）；必须 try/catch 并回退 20 字节。

**测试含义**：

- 不能假设 `setBLEMTU` 在 iOS 可用；平台分支必须是 `Android && canIUse('setBLEMTU')`。
- 不能用 `setBLEMTU` 的 success 值做断言；真实值用 `getBLEMTU` / `onBLEMTUChange`。
- `onBLEMTUChange` 在 iOS 永远不触发，测试用例不要等它。

### 3.3 错误码 10006 的语义

官方错误码表（所有 BLE API 页面共用同一张表）：

| errCode | errMsg | 含义 |
|---|---|---|
| 10006 | no connection | **当前连接已断开** |

官方 `createBLEConnection` 的“注意”进一步明确：

> “若对**未连接的设备或已断开连接的设备**调用**数据读写操作**的接口，会返回 **10006** 错误，建议进行重连操作。”

**关键澄清**：

- **10006 是读写 API 的 fail/reject 错误码**，不是“断连事件”。
- **断连事件是 `wx.onBLEConnectionStateChange`**，回调 `{ deviceId, connected: boolean }`，**没有 errCode、没有 reason**。
- 两条路径必须都处理：
  - ① 主动/被动断连 → `onBLEConnectionStateChange(connected:false)`；
  - ② 断连后继续读写 → reject `errCode: 10006`。
- 不能只监听其中一个。Transport 应把 ① 映射为 `onDisconnect`，把 ② 映射为可重连的 `NotConnectedError`（携带 10006）。

其它常见码：

- `10000` 未初始化（没调 `openBluetoothAdapter`）；
- `10001` 适配器不可用（蓝牙开关未开/不支持；此时适配器已初始化，仍可监听状态变化）；
- `10003` 连接失败；
- `10012` 连接超时；
- `10008` 系统异常（Android GATT ERROR、notify 后立即写等）；
- `10009` Android 特有：系统低于 4.3 不支持 BLE；
- `10013` deviceId 为空或格式非法。

### 3.4 后台 / 锁屏时的连接行为

**官方明确写的**（[运行机制](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/operating-mechanism.html)，最后编辑 2026-08-10）：

- 切后台的方式**明确包括“小程序前台运行时直接锁屏”**。
- 进入后台后，小程序“还可以短暂运行一小段时间，但部分 API 的使用会受到限制”。
- 进入后台 **5 秒**后，微信停止 JS 线程执行，进入“挂起”；“开发者代码执行会停止，**事件和接口回调会在小程序再次进入前台时触发**”。
- 只有使用后台音乐播放、后台地理位置等能力时，才可能后台持续运行；**BLE 不在官方“后台保活”列表里**。

**官方没有写的**：

- 没有任何官方文档说“切后台会立即/延时断开 BLE 连接”；
- 没有任何官方文档说“锁屏后 GATT 连接一定保持/一定断开”；
- `onBLEConnectionStateChange` 在挂起期间是否触发、回前台是否补发，官方没有逐条说明。

**社区观察（[社区]，需实测）**：

- Android 上，GATT 连接有时由系统/蓝牙栈维持，JS 挂起期间连接可能还在，但回调延迟到回前台；
- iOS 上，小程序进入后台后连接更容易被系统回收；
- 各 OEM 的省电策略会杀后台，导致“看起来是 BLE 断连，实际是进程/连接被清理”；
- 回前台后可能一次性收到多条积压的 notify。

**设计结论**：

- **不要在 `onHide` 里主动 `closeBLEConnection`**（除非产品就要断）；
- **必须在 `onShow` 做状态校验**：`getBluetoothAdapterState` → 必要时 `getBLEDeviceServices` / `getConnectedBluetoothDevices`；失败走 10006 重连；
- **notify 流必须容忍“回前台后批量涌入”**，不能假设实时；
- 把“后台/锁屏”列为**人工冒烟必测项**，不要用模拟器推断。

### 3.5 Android 与 iOS 差异总表

| 维度 | Android | iOS | 可信度 |
|---|---|---|---|
| `deviceId` | 外围设备 MAC，相对固定 | 系统生成的 UUID；已连接过会稳定一段时间，系统蓝牙重启/忽略配对后会变 | [官方] |
| `serviceId` / `characteristicId` | 建议从发现接口取；Android 8.0.9+ 支持 16/32/128 位 UUID；8.0.9 以下只支持 128 位，需手动补位 | **必须**从 `getBLEDeviceServices` / `getBLEDeviceCharacteristics` 取，不能硬编码 | [官方] |
| 默认 `writeType` | 优先 `writeNoResponse` | 优先 `write` | [官方] |
| `setBLEMTU` | 5.1+ 可用；可协商 | **不支持**；MTU 固定 | [官方] |
| `getBLEMTU` | 可读协商后的值 | 可读固定值；`writeType` 影响结果 | [官方] |
| `onBLEMTUChange` | 触发 | **不触发** | [官方] |
| 扫描权限 | Android 6.0+ 无定位权限/定位开关关闭时**无法搜索**；新版 Android 还涉及“附近设备”权限 | 系统蓝牙授权；`scope.bluetooth` | [官方] + [社区] |
| 经典蓝牙 | 规划中 | 不支持 | [官方] |
| 10009 | Android 特有（<4.3） | 不适用 | [官方] |
| 多余服务 | 部分机型多出 `00001800` / `00001801`，不要用 | 通常没有 | [官方] |
| 后台连接 | 可能由系统维持，回调延迟；OEM 省电策略差异大 | 更容易被系统回收 | [社区]/[推断] |
| 超长写 | 可能 10008 或 fail | **可能完全无回调** | [官方] |

### 3.6 对 Transport / 测试的硬约束

1. 写队列**串行化**；每次写**超时**；失败分类（10006 / 10008 / timeout）。
2. 分片默认 **20**；Android 才尝试 MTU，且用 `getBLEMTU` 取真实值；payload = `MTU - 3`。
3. `writeType` 可配置，按 `properties.writeNoResponse` / `properties.writeDefault` 决定，不要写死。
4. 断连双路径：`onBLEConnectionStateChange` + 读写 10006。
5. `onShow` 重校验；`onHide` 停扫描；notify 容忍批量到达。
6. 设备 ID 不持久化复用（iOS UUID 会变）；服务/特征 UUID 不硬编码。
7. 上线前检查隐私保护指引是否声明蓝牙/位置（否则真机调试能用、上线后失效——社区高频坑）。

---

## 4. 取舍：没有手机时页面层能测到什么程度

### 4.1 能力矩阵

| 测试对象 | 无手机 | 工具 | 能测到什么 | 测不到什么 |
|---|---|---|---|---|
| 协议编解码、分片、状态机、重连策略 | ✅ 完全 | vitest + `FakeTransport` | 所有分支、边界、错误码映射 | 真实时序/系统行为 |
| 页面路由、`data`、WXML 渲染、按钮状态、列表 8 条灯带 | ✅ 完全 | automator + 模拟器 | 真实页面运行时、真实 WXML、真实 `setData` | 真实 BLE |
| 页面在“连接成功/失败/断连/重连/超时”下的 UI | ✅（用桩） | automator + FakeTransport / `mockWxMethod` | 你的代码对 BLE 的反应 | 微信 BLE 栈的真实反应 |
| 扫描列表 UI | ⚠️ 部分 | 开发者工具 | 官方说“只能模拟部分蓝牙接口能力” | 真实射频、权限、设备过滤 |
| 真实连接 / 服务发现 | ❌ | 必须真机 | — | 全部 |
| 真实 MTU / 写长度 / notify | ❌ | 真机或 bleak | — | 全部 |
| 后台 / 锁屏 / 系统回收 | ❌ | 真机 | — | 全部 |
| iOS 差异 | ❌ | iPhone | — | 全部 |
| 发版前全链路 | ❌ | Android 真机 / MiniTest | — | — |

### 4.2 页面层具体能断言什么（无手机）

以本项目的控制页为例，**用 FakeTransport 注入**后，automator 可以稳定断言：

- 初始态：未连接时按钮禁用、提示文案、8 条灯带的默认颜色/开关；
- 连接中：loading、按钮防重复点击；
- 连接成功：设备名、信号/状态、灯带列表渲染数量 = 8；
- 写命令：点击某条灯带 → `FakeTransport` 收到正确的 opcode/灯带索引/颜色；页面进入 pending；收到 ack 后 pending 清除；
- 错误分支：`10006` → 显示“连接已断开”+ 重连按钮；`10008` → 显示系统错误；超时 → 显示重试；
- 断连事件：FakeTransport 推 `connected:false` → UI 变灰、停止下发；
- 重连成功：状态恢复、未完成命令重发/丢弃策略；
- 路由：从列表进控制页、返回、`reLaunch`；
- 异常：`on('exception')` 为空；关键路径 `console.error` 为空；
- 存储：设备偏好、上次颜色。

**不能断言**：真实 BLE 是否真的连上、C3 是否真的收到、MTU 是多少、iOS 是否静默丢包。

> 这就是关键取舍：**页面层测的是“你的代码 + 页面”，不是“微信 + 手机 + C3”。** 前者已经能覆盖大部分回归价值；后者必须真机。

### 4.3 必须留给人工冒烟的项目

按优先级排序，建议做成 15 分钟清单：

1. **权限与隐私**：首次进入的蓝牙授权（`scope.bluetooth`）；Android 定位/附近设备权限；iOS 蓝牙授权；小程序隐私保护指引是否声明蓝牙/位置。
2. **扫描**：能发现 C3；设备名/信号合理；停止扫描后不再回调。
3. **连接/断开**：连接成功；`getBLEDeviceServices` / `getBLEDeviceCharacteristics` 正常；主动断开；C3 断电/走远后的断连事件；重连。
4. **写**：20 字节命令；协商 MTU 后的大包；连续快速写（串行化）；C3 只支持 `write_no_response` 时的 `writeType` 行为。
5. **notify**：开启 notify；8 条灯带状态回读；分片拼接；断连后重新 notify。
6. **后台/锁屏**：切后台 10s、锁屏 30s、回前台；连接是否还在；UI 是否重校验；是否有积压 notify。
7. **Android/iOS 差异**：同一套流程在两端各跑一遍；iOS 重点看 `deviceId` 变化、`write` 默认、MTU 固定、超长写无回调。
8. **发版形态**：体验版/正式版（不是开发版）再跑一遍；隐私弹窗、域名/权限配置在正式环境才暴露。

### 4.4 Fallback

| 情况 | Fallback |
|---|---|
| automator 无法启动 / 工具版本不兼容 | 只保留 vitest + `miniprogram-simulate`（组件）+ 人工页面清单；不要让页面 E2E 阻塞发版 |
| 没有 Windows/macOS 常开机器 | 页面 E2E 降级为“本地手动触发”；日常只跑 Node 测试 + bleak 集成 |
| 完全没有手机 | MiniTest 云真机跑发版前冒烟（每周 150 分钟免费）；或只做 bleak PC 链路 + 模拟器 UI |
| BLE 固件改动 | 以 bleak 集成测试为门禁；微信侧只做人工冒烟 |
| iOS 无法覆盖 | 明确记录“iOS 未测”，发版说明里标注；不要用 Android 结果推断 iOS |
| `remote(true)` 不可用 | 回到“人工扫码/工具内启用真机调试”，或直接人工冒烟 |

### 4.5 建议的决策

1. **页面层 E2E 做，但只做模拟器 + FakeTransport**，覆盖 UI/状态机/错误分支；不作为 BLE 正确性的证据。
2. **BLE 正确性用 PC bleak 集成测试兜底**（真实 GATT/MTU/notify），这是“无手机”能拿到的最强证据。
3. **微信 BLE 栈的真机行为只做人工冒烟**（Android 为主，iOS 尽量借一台设备或云真机）。
4. **不采用 wxa-runner**；**不把 Skyline 纳入自动化**；**不用 simulate 跑页面**。
5. **架构上把 Transport 注入到页面层**（不只是 logic 层）：页面通过工厂拿 Transport，测试构建注入 `FakeTransport`。这样 automator 不需要 `mockWxMethod`，也不受 mock 时机/序列化限制，是最稳的接缝。

---

## 5. 不确定项与待实测

| # | 不确定项 | 现状 | 建议验证 |
|---|---|---|---|
| 1 | `remote(true)` 是否真的免扫码 | 官方 Page 文档说免扫码；`remote.md` 说扫码；源码只等事件、无超时 | Android 微信 8.x 实测；包 60s 看门狗；失败就回退扫码 |
| 2 | `cli auto` 端口能常驻多久 | 官方只说“开启自动化”；无 TTL 说明 | 工具窗口放置 24h 后 `connect`；工具重启后重跑 |
| 3 | Skyline 页面 `page.$` / `page.data` | 无官方说明；源码无 Skyline 分支 | 建一个 Skyline 测试页，跑 `page.data` + `page.$` + `tap`，记录结果 |
| 4 | 模拟器到底支持哪些 BLE API | 官方“只能模拟部分”；社区称扫描可、连接报“不支持此 API” | 在模拟器里逐个调 open/scan/connect/getServices/write/notify，记录 errMsg |
| 5 | 后台/锁屏连接存活 | 官方只讲 JS 挂起；BLE 无表态 | 目标 Android 机型 + iOS 各跑 10s/30s/5min |
| 6 | iOS 固定 MTU 数值 | 官方只说“固定值” | 目标 iPhone 上分别用 `writeType: 'write'` 和 `'writeNoResponse'` 调 `getBLEMTU` |
| 7 | `setBLEMTU` 在目标 Android 机型是否成功 | 官方 5.1+，社区有机型失败 | 目标机型实测；失败回退 20 |
| 8 | `miniprogram-simulate` 1.7.0 在 Windows 的编译兼容 | 依赖 `miniprogram-compiler` 0.2.3（2024-03） | 用项目真实组件跑一次 |
| 9 | 0.13.0 相对 0.12.1 的变更 | 无 changelog | diff npm tarball；锁版本 |
| 10 | 真机 remote 下 `page.data` / `element.*` | 官方未排除，社区在用 | 真机跑一次完整断言集 |

---

## 6. 来源清单

### 6.1 官方文档（访问日期 2026-11-19）

**小程序自动化**
- https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/ （最后编辑 2026-08-21）
- https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/quick-start.html （2026-08-21）
- https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/automator.html
- https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/miniprogram.html
- https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/page.html （2026-07-04）
- https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/element.html
- https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/remote.html （2026-04-17）
- https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html
- https://developers.weixin.qq.com/miniprogram/dev/devtools/remote-debug-2.html （2026-04-17）
- https://developers.weixin.qq.com/miniprogram/dev/devtools/remote-debug.html

**BLE**
- https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.html （2026-08-10）
- https://developers.weixin.qq.com/miniprogram/dev/framework/device/ble.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/operating-mechanism.html （2026-08-10）
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.openBluetoothAdapter.html
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.createBLEConnection.html
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.html
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.setBLEMTU.html
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEMTU.html
- https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.onBLEMTUChange.html

**测试/云测**
- https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/unit-test.html
- https://developers.weixin.qq.com/miniprogram/dev/devtools/minitest （2026-08-21）
- https://developers.weixin.qq.com/miniprogram/dev/devtools/minitest/minium.html （2026-08-21）

**Skyline**
- https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/changelog.html （2026-11-13，1.4.25）
- https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/introduction.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/migration/best-practice.html

### 6.2 版本 / 源码

- npm `miniprogram-automator`：https://registry.npmjs.org/miniprogram-automator
  - 0.13.0 tarball：https://registry.npmjs.org/miniprogram-automator/-/miniprogram-automator-0.13.0.tgz
  - 关键源码：`out/MiniProgram.js`（`remote` / `checkVersion` / `evaluate` / `mockWxMethod`）、`out/Launcher.js`（`launch` 30s / `connect` 无超时）、`out/Connection.js`（`send` 无超时）、`out/Native.js`
- npm `miniprogram-simulate`：https://registry.npmjs.org/miniprogram-simulate
  - 1.7.0 tarball：https://registry.npmjs.org/miniprogram-simulate/-/miniprogram-simulate-1.7.0.tgz
  - 关键源码：`src/index.js`（只注册 `global.Component` / `global.Behavior`）、`src/definition.js`（`global.wx` 合并）、`src/api/mock.js`（BLE API 桩）
- GitHub `wechat-miniprogram/miniprogram-simulate`：
  - issue #26：https://github.com/wechat-miniprogram/miniprogram-simulate/issues/26
  - issue #113：https://github.com/wechat-miniprogram/miniprogram-simulate/issues/113
  - commits：https://github.com/wechat-miniprogram/miniprogram-simulate/commits/master
- npm `wxa-runner` / GitHub `open-wxa/wxa-runner`：https://github.com/open-wxa/wxa-runner （仓库描述“已应腾讯公司要求下线”；2026-11-16 仍有 push）
- PyPI `minium`：https://pypi.org/project/minium/ （1.6.1，2026-09-14）

### 6.3 社区（仅作线索，非官方）

- 微信开放社区：MacOS 开发者工具调用蓝牙连接报“开发者工具暂时不支持此 API 调试，请使用真机进行开发”（2025-09-16）：
  https://developers.weixin.qq.com/community/minihome/doc/0008c4ef07c0e855e0e3d8d7b66000
- 微信开放社区：`setBLEMTU` / 10008 反馈：
  https://developers.weixin.qq.com/community/develop/doc/00062aa2864e805cbe14e111761400
- 社区：Windows `launch()` 的 `spawn EINVAL` 讨论（既有调研引用）：
  https://github.com/KLKRL/wechat-miniprogram-cli-automation-guide

---

## 附录 A：可直接复制的命令 / 脚本骨架

### A.1 常驻开发者工具 + 连接

```bat
:: Windows；先确保 设置 -> 安全设置 -> 服务端口 已开启
"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" auto ^
  --project "C:\path\to\miniprogram" ^
  --auto-port 9420
```

```js
// test/page.e2e.js
const automator = require('miniprogram-automator')

async function main() {
  const miniProgram = await automator.connect({
    wsEndpoint: 'ws://127.0.0.1:9420',
  })

  // 1) 首选：页面通过注入的 FakeTransport 工作（测试构建开关）
  //    这样不需要 mock wx，也不受时机影响。
  const page = await miniProgram.reLaunch('/pages/control/index?fakeBle=1')
  await page.waitFor(300)

  console.log('connected =', await page.data('connected'))
  console.log('strips =', (await page.data('strips')).length) // 期望 8

  const btn = await page.$('.connect-btn')
  await btn.tap()
  await page.waitFor(200)
  console.log('after tap =', await page.data('status'))

  miniProgram.disconnect() // 不要 close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
```

### A.2 兜底：用 `mockWxMethod` 伪造 BLE

```js
const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })

await miniProgram.mockWxMethod('openBluetoothAdapter', { errMsg: 'openBluetoothAdapter:ok' })
await miniProgram.mockWxMethod('startBluetoothDevicesDiscovery', {
  errMsg: 'startBluetoothDevicesDiscovery:ok',
})
await miniProgram.mockWxMethod('createBLEConnection', {
  errMsg: 'createBLEConnection:ok',
})
await miniProgram.mockWxMethod('getBLEDeviceServices', {
  services: [{ uuid: '0000FFF0-0000-1000-8000-00805F9B34FB', isPrimary: true }],
})
await miniProgram.mockWxMethod('getBLEDeviceCharacteristics', {
  characteristics: [
    {
      uuid: '0000FFF1-0000-1000-8000-00805F9B34FB',
      properties: { write: true, writeNoResponse: true, notify: true },
    },
  ],
})
await miniProgram.mockWxMethod('writeBLECharacteristicValue', {
  errMsg: 'writeBLECharacteristicValue:ok',
})

// mock 装好后再 reLaunch，确保目标页 onLoad 走桩
const page = await miniProgram.reLaunch('/pages/control/index')
await page.waitFor(300)
```

> 事件型 API（`onBLECharacteristicValueChange` / `onBLEConnectionStateChange` / `onBLEMTUChange`）用 `mockWxMethod` 替换成“保存回调”的函数，再用 `evaluate` 手动触发；这是社区模式，**官方没有 BLE 事件 mock 示例**，需要实测。更稳的办法仍是 A.1 的 Transport 注入。

### A.3 真机 remote 的看门狗

```js
async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// remote() 本身没有超时；必须自己包
await withTimeout(miniProgram.remote(true), 60_000, 'remote(true)')
```

---

## 附录 B：一句话回答 ticket 的四个问题

1. **`miniprogram-automator`**：0.13.0（2026-10-15），官方仍在维护但节奏慢；不强制真机，模拟器即可；真机需扫码或工具内启用（`remote(true)` 宣称免扫码但未证实）；`cli auto` 开端口后可反复 `connect`，工具窗口常驻；能断言 `page.data` / element 属性 / console / exception / `evaluate` / `exposeFunction` / `mockWxMethod`；基础库 ≥2.7.3（完整断言建议 ≥2.9.5）；BLE 只能观测到小程序可见层，不能观测 GATT/MTU/断连原因。
2. **页面层无手机**：`miniprogram-simulate` 只能测自定义组件，不能跑页面；Skyline 无官方 E2E；社区没有仍在维护的独立页面运行时；唯一可用的本地页面方案是官方 automator + 开发者工具模拟器（Windows/macOS GUI，不能 Linux 无头）。推荐 automator + FakeTransport，simulate 只做展示组件，真机冒烟用 Android 或 MiniTest 云真机。
3. **BLE 现状**：写 API 不限制长度但建议 ≤20 字节；iOS 超长可能完全无回调；Android notify 后立即写可能 10008；`setBLEMTU` 仅 Android 5.1+，`getBLEMTU`/`onBLEMTUChange` 2.20.1，后者仅 Android；10006 = 当前连接已断开（读写错误码，不是断连事件）；后台 5 秒挂起、锁屏算后台，BLE 连接行为官方未说明，必须回前台重校验。
4. **取舍**：无手机时页面层能测 UI/状态机/错误分支/路由；真实 BLE 链路、权限、MTU、后台、iOS 差异必须人工冒烟；fallback 是 Node 逻辑测试 + bleak PC 集成 + MiniTest 云真机；不采用 wxa-runner，不把 Skyline 纳入自动化。
