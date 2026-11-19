# 测试自动化事实底稿：miniprogram-automator + wxa-runner

- 日期：2026-11-19
- 范围：#8「测试自动化组合：真机 automator + wxa-runner/Playwright 的边界与接入时机」的事实核查
- 结论用途：B（真机层）与 C（UI 回归层）的设计依据；不替代 #8 决议

## 0. 结论摘要

1. **miniprogram-automator**：`connect({wsEndpoint})` 可以连接一个由人工先启用的真机调试会话；`wsEndpoint` 仍是开发者工具自动化端口，不是手机地址。`remote(true)` 在未扫码时会静默等待、无超时；`connect()` 也没有超时。真机 remote 下 `screenshot()` 不可用，`page.data()` / `page.callMethod()` / `element.attribute()` 官方未排除，真机示例在用。
2. **exposeFunction 方向是小程序 → 测试脚本**：在 `miniProgram` 上注册 AppService 全局函数，小程序侧按全局名调用；不支持返回值。脚本 → 页面用 `page.callMethod` / `element.callMethod` / `miniProgram.evaluate` / `miniProgram.callWxMethod`。
3. **BLE notify 帧推到脚本**：不需要生产代码的通道是“运行时 `evaluate` 注入第二个 `wx.onBLECharacteristicValueChange` 监听器 + `exposeFunction` 回传 hex”；所有通道受 JSON 序列化限制，不要传 `ArrayBuffer` 原样。
4. **wxa-runner**：不是腾讯官方产品；官方仓库已于 2026-11 应腾讯要求下线，npm 全部 `deprecated`，文档站 404，只剩社区 fork `hackwaly/wxa-runner`。蓝牙官方明确“不支持”；未实现 API 返回成功，`errors()` 会记录。
5. **C 层**：只能按有时限的 spike 处理——vendor/fork 固定 `wxa-runner@0.14.0` + baselib `3.7.0`，跑不通 1 条 BLE 页面 UI 回归就降级为人工 UI 清单 + B 真机。

---

## 1. miniprogram-automator

### 1.1 连接与会话生命周期

- **两种连接方式**：
  - `automator.launch(options)`：由 SDK 启动开发者工具并打开自动化端口，内部执行 `cli auto --project <projectPath> --auto-port <port>`。
  - `automator.connect({wsEndpoint})`：连接一个已经打开的、启用了自动化的项目窗口。
- **真机自动化的官方路径**：工具常驻 + 先手工启用真机调试，再运行测试脚本；脚本用 `automator.connect` 连接。官方原文：“如果工具是打开常驻并且使用 `automator.connect` 接口进行连接，那么可以先手工启用工具的真机调试功能后再运行测试脚本。”
- **`wsEndpoint` 是工具自动化端口**（如 `ws://127.0.0.1:9420`），不是手机侧地址。`connect` 本身不会调用 `Tool.enableRemoteDebug`；人工真机调试必须先在工具里启用。
- **`disconnect()` vs `close()`**：`disconnect()` 只断开自动化连接；`close()` 会关闭项目窗口。常驻工作流必须用 `disconnect()`，不能用 `close()`。
- **`projectConfig` 没有 automation 字段**：它只用于 `automator.launch()` 覆盖 `project.config.json`；`setting.autoAudits` 是“自动运行体验评分”，不是自动化端口。
- **电脑重启 / 工具完全退出后**：需要重新打开项目并开启自动化连接。

### 1.2 `remote(true)` 与真机调试

- `remote(options)` 每次调用都会发送 `Tool.enableRemoteDebug {auto}`；如果返回 `qrCode` 就打印二维码，然后等待 `Tool.onRemoteDebugConnected`，**没有超时**。
- `remote(true)` 只是把 `auto` 设为 `true`：按官方说明不打印二维码；源码仍然等待连接事件。**用户不扫码时会一直等待，不会主动抛“需要重新扫码”的错误。**
- **真机 remote 下 API 可用性**：
  - 官方真机示例使用了 `page.$()`、`element.attribute()`、`element.tap()`。
  - `page.data()`、`page.callMethod()` 是 Page 协议 API；官方没有把它们列为 remote 例外，也没有逐项说明真机行为——**没有权威信息**说明它们不可用。
  - 唯一明确排除的是 `miniProgram.screenshot()`：“目前只有开发者工具模拟器支持，客户端无法使用。”
- **会话断开判定**：
  - `connect` 失败统一报 `Failed connecting to <wsEndpoint>, check if target project window is opened with automation enabled`；原始错误（`ECONNREFUSED`、握手 404）被丢弃。
  - 连接建立后断开统一报 `Connection closed, check if wechat web devTools is still running`；没有公开的 `disconnect` / `close` 事件，未完成的请求会 reject；如果当时没有 pending 请求，脚本不会立刻知道，下一次调用才暴露。
  - **唯一直接的“需要扫码”信号是 `remote()` 打印二维码**。真机调试会话断开后，要重新取得二维码需要再次调用 `remote()`（每次都会重新发送 `Tool.enableRemoteDebug`），或在工具里手工重新启用真机调试。
  - 官方没有“真机会话过期”的专门错误码/错误文案，也没有自动化端口空闲断开的权威说明。

### 1.3 `exposeFunction`：方向、签名、示例

- **方向：小程序（AppService）→ 测试脚本**。官方原文：`miniProgram.exposeFunction` 是“在 AppService 全局暴露方法，供小程序侧调用测试脚本中的方法”。
- **签名**：

```ts
miniProgram.exposeFunction(
  name: string,
  bindingFunction: Function
): Promise<void>
```

- 它在 **`miniProgram`** 上，不在 `page` 上；官方没有 `page.exposeFunction`。
- **不支持小程序侧获取调用结果**：`bindingFunction` 的返回值不会回传。
- 源码注册时发送 `App.addBinding {name}`；小程序侧调用时触发 `App.bindingCalled`，SDK 执行 `bindingFunction(...args)`；重名会报 `Failed to expose function with name ...: already exists!`。
- 官方示例：

```js
await miniProgram.exposeFunction('onAppShow', options => {
  // 测试脚本侧收到
})

await miniProgram.evaluate(function () {
  wx.onAppShow(function (options) {
    onAppShow(options) // 小程序侧按全局名调用
  })
})
```

- 对应 BLE 的运行时写法（测试脚本注入，不需要生产代码）：

```js
await miniProgram.exposeFunction('onBLEFrame', hex => {
  frames.push(hex)
})

await miniProgram.evaluate(() => {
  wx.onBLECharacteristicValueChange(res => {
    const hex = Array.from(new Uint8Array(res.value))
      .map(b => ('0' + b.toString(16)).slice(-2))
      .join('')
    onBLEFrame(hex)
  })
})
```

`evaluate` 注入的是 AppService 代码；`onBLEFrame` 是 `exposeFunction` 注册的全局函数。`evaluate` 函数不能使用闭包，所以只能引用全局。

- **脚本 → 页面**调用函数用：
  - `page.callMethod(method, ...args)`
  - `element.callMethod(method, ...args)`（自定义组件）
  - `miniProgram.evaluate(fn, ...args)`
  - `miniProgram.callWxMethod(method, ...args)`

### 1.4 BLE notify 帧推到脚本的通道对比

**共同限制：JSON 序列化**。SDK 的 WebSocket 消息是 JSON（收 `JSON.parse`、发 `JSON.stringify`）；官方没有文档化 `ArrayBuffer` 可以直接穿过 `exposeFunction` / `page.callMethod` / `console`。实际应转成 hex / base64 / 普通数组。

| 通道 | 方向 / 触发 | 生产包是否需要测试专用代码 | 事实与限制 |
|---|---|---|---|
| `exposeFunction` + 运行时 `evaluate` 注册第二个 BLE 监听器 | 小程序 → 脚本；每帧 push | **不需要** | 依赖 app 本身使用标准 `wx.onBLECharacteristicValueChange` / `wx.notifyBLECharacteristicValueChange`；`wx.offBLECharacteristicValueChange()` 会清掉全部监听，包括测试监听器；需转 hex/数组；重连后需重新 `exposeFunction`。 |
| 小程序代码直接调用 `exposeFunction` 暴露的函数 | 小程序 → 脚本；每帧 push | **需要**（除非测试构建剥离） | 同样的序列化/全局名限制；无返回值。 |
| `page.callMethod()` 读页面里的 ring buffer | 脚本 → 页面；脚本轮询/批量拉取 | 视情况：ring buffer/方法本来就是业务代码则不需要；为测试新增则需要 | 页面必须提供如 `drainBleFrames()` 的方法并返回 JSON 可序列化数据；若 ring buffer 在页面 `data` 里，也可用 `page.data('bleFrames')`。 |
| `miniProgram.on('console')` 捕获日志 | 小程序 → 脚本；日志事件 push | 视情况：生产代码本来逐帧打日志则不需要；新增测试日志则需要 | 必须先注册 `on('console')`；`msg.type` / `msg.args`；DevTools 有“Console 日志长度上限”设置，长帧可能被截断；JSON 序列化；无确认/重放。 |
| 小程序侧 debug hook / `getApp().globalData` ring buffer + `evaluate` | 脚本 → AppService；脚本轮询/批量拉取 | **需要**（hook/buffer 进生产包，除非测试构建） | `evaluate` 可执行任意 AppService 代码并返回 JSON 结果；官方“测试环境”示例就是“小程序代码植入开关 + SDK 开启”的模式。 |
| `mockWxMethod` 包装 `onBLECharacteristicValueChange` | 小程序 → 脚本（通过 `exposeFunction`）；每帧 push | **不需要** | 必须在目标页面注册监听**之前**安装；用 `this.origin(wrappedCallback)` 保留真实注册；官方只文档化了 `mockWxMethod` 的通用用法和 `this.origin`，**没有文档化事件监听 mock**；测试后 `restoreWxMethod`。 |

`mockWxMethod` 包装法示例（源码层面可行，官方未给 BLE 示例）：

```js
await miniProgram.exposeFunction('onBLEFrame', hex => {
  frames.push(hex)
})

await miniProgram.mockWxMethod(
  'onBLECharacteristicValueChange',
  function (callback) {
    return this.origin(function (res) {
      const hex = Array.from(new Uint8Array(res.value))
        .map(b => ('0' + b.toString(16)).slice(-2))
        .join('')
      onBLEFrame(hex)
      callback(res)
    })
  }
)
```

**小结**：
- 不要求生产测试代码的 push 通道：① 运行时 `evaluate` 注入第二个 BLE 监听器 + `exposeFunction`；② 运行时 `mockWxMethod` 包装（未文档化）。
- 需要生产代码的通道：页面 ring buffer / `page.callMethod`、AppService debug hook / globalData。
- console 取决于生产代码是否本来逐帧打日志，且有日志长度上限。
- 所有通道都要处理 JSON 序列化，帧字节建议在小程序侧转 hex/base64/数组。

### 1.5 超时与错误形态汇总

| 场景 | 超时 |
|---|---|
| `automator.launch()` | 默认 30000ms（官方） |
| `automator.connect()` | 无超时参数；源码无定时器 |
| `remote()` | 无超时；等待 `Tool.onRemoteDebugConnected` |
| 单次 `Connection.send()` | 无 per-call 超时 |
| 自动化端口空闲断开 | 官方无说明；无权威信息 |

失败文案：
- `Failed connecting to <wsEndpoint>, check if target project window is opened with automation enabled`
- `Failed to launch wechat web devTools, please make sure http port is open`
- `Failed to launch wechat web devTools, please make sure cliPath is correctly specified`
- `Connection closed, check if wechat web DevTools is still running`

### 1.6 Windows 常驻与固定端口

推荐命令：

```bat
cli.bat auto --project "D:\path\to\project" --auto-port 9420
```

可选参数：`--auto-account <openid>`、`--trust-project`、`--port <IDE HTTP 服务端口>`。

- `--auto-port` 是自动化监听端口；`--port` 是工具 HTTP 服务端口，不是自动化端口。
- 每次测试：`automator.connect({wsEndpoint: 'ws://127.0.0.1:9420'})`。
- `launch({port: 9420})` 固定端口时，若 9420 被占用会报 `Port 9420 is in use`；未指定时可能另选端口。
- **Windows 已知问题**：Windows + Node ≥18.20 下，官方 `launch()` 可能抛 `spawn EINVAL (-4071)`（Node 对 `.bat` 的 spawn 限制），错误信息还可能误报成 `cliPath` 不对；常驻场景应改用 CLI `auto` + `connect`。`launch()` 要求工具先完全退出，否则可能报 `Failed to launch wechat web devTools`。

---

## 2. wxa-runner

### 2.1 状态与定位（关键）

- **不是腾讯/微信官方产品**：社区开源项目，GitHub 组织 `open-wxa`，npm 维护者 `zcd999`，MIT 协议；使用的是微信官方基础库与编译器，但项目本身不是官方发布。
- **已于 2026 年 11 月应腾讯公司要求下线**：官方仓库现在只剩下线说明，代码、文档、npm 包均停止提供；npm 包仍可安装但标记 `deprecated`。
- 官方文档站 `https://open-wxa.github.io/wxa-runner/` 现为 404；社区 fork `hackwaly/wxa-runner` 保留了源码与 docs。
- 最新版本 `wxa-runner@0.14.0`（2026-11-16），npm 上所有版本均 `deprecated`。

### 2.2 架构与基础库

- **运行方式**：CLI 启动开发服务器，浏览器里加载微信官方 `WAService.js` / `WAWebview.js` 基础库和官方 `wcc` / `wcsc` 编译器；wxa-runner 只实现“原生层”：消息桥、页面栈、原生 API、导航栏/tabBar/弹窗等。渲染、组件、`setData`、生命周期由官方基础库执行，不是 H5 重写。
- **不依赖 WASM**：`dist` 里 `wasm` 只出现在 MIME 类型表；编译器是原生 `wcc` / `wcsc` 子进程，基础库是 JS。查看器（viewer）包另外用 `esbuild-wasm`，不属于 dev server 运行时。
- **基础库来源**：本机微信开发者工具下载的 `.wxvpkg` 优先，解包缓存到 `~/.wxa-runner/baselib/<版本>`；没有开发者工具时用内置 `@open-wxa/wxa-baselib` 的 **3.7.0**。
- **版本选择**：默认选 **≤ 3.7.0 的最新兼容版本**；3.7.1 起不会自动选用，要 `--baselib` 或 `WXA_BASELIB` 指定，并提示超出已验证范围。已验证 2.32.3 / 3.3.4 / 3.5.8 / 3.7.0；3.7.1 / 3.8.8 全部测试通过但不是默认。

### 2.3 Linux CI

- **可以无头跑，不需要微信开发者工具**：官方路径是 Linux x86-64 + 系统 Google Chrome（`channel: 'chrome'`）。
- **Playwright 自带 Chromium 未被官方验证**；官方只验证本机 Chrome（`channel: 'chrome'` / `executablePath`）。
- **Node.js ≥ 18**。
- **安装依赖**：需要 `git` 且能访问 `github.com`，因为内置基础库 `@open-wxa/wxa-baselib` 是 optional dependency，从 GitHub 拉取；拉取失败时 pnpm 会静默跳过，启动时提示“没有找到基础库”。
- **Chrome 安装**：没有系统 Chrome 时运行 `npx playwright install --with-deps chrome`（安装 Chrome 及系统依赖）。
- **只支持 x86-64**：没有开发者工具时编译器 `miniprogram-compiler` 只有 x86-64；ARM 机器不行。
- **官方 Playwright 配置**：`use: { channel: 'chrome' }`；每个 worker 启动一个 dev server，每个用例一个新的 browser context；`npx playwright test` 默认 headless，`--headed` / `--ui` 可看界面。
- **官方 CI 示例**：GitHub Actions `ubuntu-latest` + `npx playwright test`；`@open-wxa/wxa-runner-playwright` 作为 devDependency，内置基础库和编译器随依赖安装。

### 2.4 对 wx.* BLE API 的支持现状

官方文档明确：**“蓝牙不支持”**；未实现的原生 API 调用后返回成功，避免打断业务代码；Playwright fixture 会把业务调用过的未实现 API 记进 `errors()`。

源码层面，`ApiRegistry.invoke` 对没有 handler 的 API 返回 `{ errMsg: "<api>:ok" }`，并打印 `[wxa-runner] wx.<api> 尚未实现，返回默认成功`；业务代码调用过的会记入 `errors()`。

| wx API | 3.7.0 基础库里的实现路径 | wxa-runner 默认结果 | setup/test mock |
|---|---|---|---|
| `wx.openBluetoothAdapter` | `Nke` → `vd("openBluetoothAdapter", ...)` → `WeixinJSBridge.invoke` | 无 handler → `{errMsg:"openBluetoothAdapter:ok"}`，控制台警告，`errors()` 记录 | 可按 `openBluetoothAdapter` mock |
| `wx.createBLEConnection` | `mEe` → `Uc` 校验 `deviceId` → `vd("createBLEConnection", ...)` | 无 handler → `{errMsg:"createBLEConnection:ok"}` | 可按 `createBLEConnection` mock |
| `wx.writeBLECharacteristicValue` | `AEe` → `Uc` → `vd("writeBLECharacteristicValue", { value: qk(value), serviceId/characteristicId 大写 })` | 无 handler → `{errMsg:"writeBLECharacteristicValue:ok"}` | 可 mock，但 **mock 收到的 `value` 是 base64 字符串**，不是原始 ArrayBuffer |
| `wx.notifyBLECharacteristicValueChange` | `SEe` → `vd("notifyBLECharacteristicValueChanged", ...)`（注意末尾多一个 `d`） | 无 handler → `{errMsg:"notifyBLECharacteristicValueChanged:ok"}` | **必须 mock `notifyBLECharacteristicValueChanged`”；mock wx 名 `notifyBLECharacteristicValueChange` 不生效** |
| `wx.onBLECharacteristicValueChange` | `TEe` → `zt("onBLECharacteristicValueChange", cb)` → `X` → `I.on` | 不走 `invoke`，只是注册一个事件监听；宿主没有 BLE 事件源，**回调永不触发**，也不会进 `errors()` | **`setup.mock` / `testApi.mock` 无法拦截**；只能直接替换 `wx.onBLECharacteristicValueChange`，或通过内部事件通道派发 |

补充事实：

- `wx.notifyBLECharacteristicValueChanged`（带 `d`）也是 `wx` 上的真实函数别名；因此未 mock 时 `errors()` 会以 `notifyBLECharacteristicValueChanged` 这个名字记录。
- `getBLEDeviceServices` / `getBLEDeviceCharacteristics` 未 mock 时，基础库的 `beforeSuccess` 会把结果补成空数组；`getBluetoothAdapterState` 未 mock 时返回空对象（`available` 为 `undefined`）。
- `onBLEConnectionStateChange` / `onBLEConnectionStateChanged` / `onBluetoothAdapterStateChange` 同样走 `zt` / `I.on`，`setup.mock` 同样不生效。
- `getSystemSetting` 固定返回 `bluetoothEnabled: true`，`getAppAuthorizeSetting` 固定返回 `bluetoothAuthorized: "authorized"`；依赖这些字段判断“无蓝牙”的逻辑不会走降级分支。
- `canIUse` 由基础库静态 schema 表判断，不走宿主 `ApiRegistry`；3.7.0 表里包含 BLE API，因此 `wx.canIUse('openBluetoothAdapter')` 等返回 true。

### 2.5 Mock / 注入点

**官方唯一受支持的注入点**：

- **`setup` 文件的 `mock`**：在 `App.onLaunch` 之前执行，按 API 名覆盖 `ApiRegistry`；值可以是对象或 `(args) => result` 函数。
- **测试 API `mock`**：`window.__wxa_test_api__.mock(api, impl)`；Playwright fixture 的 `miniProgram.mock()` 在 `open()` 前声明，页面加载时重放。
- **`__wxa_before_launch__`**：宿主在 setup 之后、`host.start()` 之前调用；官方示例用 `page.addInitScript` 定义它，再调用 `api.mock` / `api.route`。
- **mock 的排除项**：只有 `request` / `downloadFile` / `uploadFile` / `connectSocket`（任务型 API）和 `getStorage` 等存储 API 不能按名字 mock；BLE API 不在排除项里。
- **没有“自定义 API 注入插件”**：官方文档列出的扩展点是 setup、test API、`__wxa_before_launch__`；没有类似 `injectApi` / `customApi` 的运行时插件接口。

**其他技术路径（均非官方文档机制）**：

- **`page.addInitScript` 直接覆盖 `wx`**：官方 `addInitScript` 示例只用于定义 `__wxa_before_launch__`，不是直接改 `wx`。直接改 `wx` 的问题是：`addInitScript` 在 `WAService.js` 之前执行，此时 `window.wx` 还不存在；普通赋值会被基础库随后覆盖。若用 setter 拦截 `globalThis.wx` 赋值，依赖基础库具体写法，3.7.0 之外未验证。**无权威信息表明这是受支持做法。**
- **Playwright 拦截基础库脚本**：技术上可以用 `page.route('**/WAService.js*', ...)` 改写响应，但官方没有示例，且基础库是几 MB 压缩文件，版本一变就可能失效。更窄的源码级位置是拦截 `**/__wxa__/service-bootstrap.js` 或 `**/__wxa__/module/app.js`，在 `wx` 已存在、`App()` / 业务模块执行前 prepend 补丁；这是从源码结构推出的路径，**未官方验证**。
- **内部对象 `window.__wxaHost`**：源码把 `Host` 实例挂在 `window.__wxaHost`，`host.api` 是公开的 `ApiRegistry`，`host.emitToService(event, data)` 可向逻辑层派发任意原生事件。它们不是文档 API，但源码上可用于 `api.mock(...)` 和模拟 `onBLECharacteristicValueChange`。

**社区实际做法**：未找到公开的 wxa-runner BLE mock 专项示例；GitHub issues/PR 搜索没有命中蓝牙相关实现。找到的公开社区实践只是通用的 wxa-runner + Playwright 接入，例如 `wxhou/openspec-playwright` 的 mini-program target、`uni-helper/devtools` 的 mp-weixin E2E；两者都没有涉及 BLE mock。

### 2.6 `WxTransport`（1:1 薄壳）能否原样跑并驱动 `BleLink`

**结论：四个 invoke 型 BLE API 可以原样跑；`onBLECharacteristicValueChange` 不能只靠 setup mock。**

- `wx.openBluetoothAdapter`、`wx.createBLEConnection`、`wx.writeBLECharacteristicValue`、`wx.notifyBLECharacteristicValueChange` 都最终走 `WeixinJSBridge.invoke`；在 `ApiRegistry` 层 mock 后，`WxTransport` 仍然调用真实的 `wx.*` 函数，业务代码不需要改。
- `wx.onBLECharacteristicValueChange` 走 `I.on`，不经过 `ApiRegistry`；`setup.mock('onBLECharacteristicValueChange', fn)` **不会生效**。要驱动 `BleLink`，必须直接替换该 `wx` 方法，或用内部事件通道派发。
- `WxTransport` 若在模块加载时把 `wx.onBLECharacteristicValueChange` 解构/缓存成局部变量，之后替换 `wx` 方法不会影响它；补丁必须早于该模块执行。

已知坑：

1. **`wx` 不在顶层页面**：业务代码运行在隐藏的 `wxa-appservice` iframe；3.7.1+ 还在 `subcontext.html` 子上下文。Playwright 要从对应 frame 操作，不能直接在 top page 找 `wx`。
2. **挂载时机**：`__wxa_before_launch__` 在 `host.start()` 之前执行，此时 appservice iframe 还不存在，`wx` 也不存在；`addInitScript` 更早。直接替换 `wx` 的可靠时机是 appservice 的 `WAService.js` 之后、业务 `app.js` / `service-bootstrap.js` 执行之前（例如 route 改写）。
3. **`wx` 方法可写性**：3.7.0 的 `wx` 方法描述符是 `configurable: true, enumerable: true, writable: true`，直接赋值在该版本可行；跨基础库版本未逐一验证。
4. **`notify` 的原生名多一个 `d`**：wx 名是 `notifyBLECharacteristicValueChange`，实际 invoke 名是 `notifyBLECharacteristicValueChanged`；mock 必须用后者。
5. **写入值是 base64**：`writeBLECharacteristicValue` 在 invoke 前把 `value` 转成 base64；mock 函数收到的是 base64 字符串，要还原成原始字节需自行解码。
6. **通知值也是 base64**：`onBLECharacteristicValueChange` 的回调包装会把字符串 `value` 用 `zk` 转成 ArrayBuffer 再交给业务；如果直接替换 `wx.onBLECharacteristicValueChange`，这个转换要自己做。
7. **`off` 不会自动清理**：`offBLECharacteristicValueChange` 的实现是再注册一个空回调，不是从宿主注销；直接替换 `on` 时，假监听器不会被原 `off` 清掉。
8. **`canIUse` 不受 mock 影响**：`canIUse` 由基础库静态 schema 表判断，不走宿主 `ApiRegistry`；3.7.0 表里包含 BLE API，因此 `wx.canIUse('openBluetoothAdapter')` 等返回 true。
9. **系统信息伪装成“有蓝牙”**：wxa-runner 的 `getSystemSetting` 固定返回 `bluetoothEnabled: true`，`getAppAuthorizeSetting` 固定返回 `bluetoothAuthorized: "authorized"`；依赖这些字段判断“无蓝牙”的逻辑不会走降级分支。
10. **相关 API 也要 mock**：真实连接流程通常还会调用 `getBluetoothAdapterState`、`getBLEDeviceServices`、`getBLEDeviceCharacteristics`、`onBLEConnectionStateChange`；未 mock 时前者返回空对象，后两者返回空数组，事件型 `onBLEConnectionStateChange` 同样不走 `setup.mock`。

### 2.7 TypeScript 编译后的 logic 层

- **wxa-runner 不编译 TypeScript**：`MiniProgram.listFiles` 只收集 `.js` / `.wxml` / `.wxss` / `.json`，`.ts` 文件不会被当作小程序模块；`AppBuilder.getModuleScript` 只读取 `.js`，检测到 ESM 语法时用 esbuild 转成 CJS。
- **可以跑 ESM 或 CJS 编译产物**：编译后的 `.js` 放进小程序项目根目录（或 `project.config.json` 的 `miniprogramRoot`）即可；ESM 会被 esbuild 转成 CJS，CJS 原样包装进 `define`。
- **必须放进小程序产物/项目目录**：wxa-runner 只服务小程序项目根目录下的文件；项目外的独立 logic 包不会被加载。`miniprogram_npm` 也只解析项目内路径。
- **纯 TS、不依赖 wx 的 logic**：wxa-runner 没有为此提供特殊支持；直接在 Node 里用 vitest / tsx 跑是更短的路径。若要在小程序里跑，必须先用 `tsc` 或框架编译成 JS。
- **setup 文件例外**：`wxa.setup.ts` / `.mjs` 支持 TS，因为 setup 由 esbuild 单独打包；这不影响小程序逻辑层的 `.js` 限制。

### 2.8 页面 data / WXML / 点击 / exposeFunction

- **断言页面 data**：`expect(miniProgram).toHavePageData({ status: 'ok' })` 自动重试；`miniProgram.pageData(path?)` 返回当前页/指定页 `data` 的拷贝。
- **断言 WXML 渲染 / 点击**：`miniProgram.current` 是当前页渲染层，用法类似 `page.frameLocator()`；可以 `locator('#submit').click()`、`toHaveText`、`toHaveCount`、`toBeVisible` 等。
- **断言路由**：`expect(miniProgram).toHavePath('pages/result/result')`。
- **调用页面方法 / 读页面栈**：`callPageMethod(name, ...args)`、`currentPage()`、`pageStack()`、`waitForPage(path)`。
- **exposeFunction 类似能力**：有。Playwright fixture 的函数形式 `mock` / `route` 就是在 Node 里执行，浏览器经 `page.exposeFunction` 的通道按编号调用；用户也可以正常使用 Playwright 的 `page.exposeFunction`。
- **测试 API 不依赖 Playwright**：`window.__wxa_test_api__` 提供 `ready`、`pageData`、`mock`、`route`、`requests`、`errors` 等；任何能操作浏览器的工具都能用。

### 2.9 维护状态、已知限制、性能

- **维护状态**：官方仓库已应腾讯要求下线；代码、文档、npm 包停止提供；社区 fork 保留代码与文档。
- **已知限制**：
  - 不支持预览、上传、真机调试；这些仍要用微信开发者工具。
  - 不支持蓝牙等设备能力。
  - 插件只支持插件页面，要 `--devtools-login`；插件的自定义组件和 `requirePlugin` 不支持。
  - Worker 里不能用同步接口和网络请求。
  - 没有开发者工具时只支持 x86-64，编译器较旧（单页最多 16000 个节点），地区选择器不可用。
  - 未实现的 API 返回成功，测试里要靠 `errors()` 或 mock 发现。
  - 地图 `MapContext` 的部分方法没有网页实现。
- **性能**：基础库 `WAService.js` 是几 MB 的单行压缩文件；Playwright 通过 CDP 连接时 V8 要补源码位置，实测 `WAService.js` 执行从约 106–110ms 变为 332ms，其中 213ms 是 `V8.CollectSourcePositions`。fixture 会追加 `--js-flags=--no-enable-lazy-source-positions`，实测 352ms→132ms、首屏 1194ms→809ms。

---

## 3. 对 #8 的约束（供决议引用）

- B 的 notify 捕获：用 `exposeFunction('onBLEFrame', hex)` + 运行时 `evaluate` 注入第二个 `wx.onBLECharacteristicValueChange` 监听器；不给生产代码加钩子；重连后重新注入；所有帧转 hex。
- B 的会话：`cli.bat auto --project ... --auto-port 9420` 常驻 + 人工启用真机调试 + `connect({wsEndpoint})`；`remote(true)` 包 60s 看门狗；`connect()` / 每次调用包超时；`Connection closed` 不重试、等人；`disconnect()` 不 `close()`。
- B 的真机断言：`page.data()` / `element.attribute()` / `page.callMethod()` 可用；`screenshot()` 不可用，不做截图断言。
- C 的工具：wxa-runner 已下线，按 spike 处理；vendor `0.14.0` + baselib `3.7.0`；跑不通 1 条连接页 happy path 就降级。
- C 的 mock：invoke 型走 setup `mock`；事件型（`onBLECharacteristicValueChange` / `onBLEConnectionStateChange` / `onBluetoothAdapterStateChange` / `onBLEMTUChange`）必须在 app 代码前替换 `wx` 方法或用 `__wxaHost.emitToService` 派发；设备模型复用 `logic/` 的 `FakeTransport` 场景引擎；注意 notify 名多 `d`、write 值 base64、notify 回调转 `ArrayBuffer`、`off` 不清监听、`getSystemSetting` 固定有蓝牙。
- C 的产物：跑同一份 `dist/miniprogram/`（JS + WXML/WXSS/JSON），不另建打包。
- C 的 CI：Linux x86-64 + Node ≥18 + Google Chrome `channel:'chrome'`；`npx playwright install --with-deps chrome`；baselib 固定 3.7.0；spike 期 push smoke，通过后 nightly 全量。
- C 的断言：`toHavePageData` / `current` 定位 / `toHavePath` / `callPageMethod` / mock 调用日志；`errors()` 为空；不做像素/截图。

---

## 4. 主要来源

- miniprogram-automator 官方文档：
  - https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/miniprogram.html
  - https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/page.html
  - https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/element.html
  - https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/remote.html
  - https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/automator.html
  - https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html
  - https://developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.html
  - https://developers.weixin.qq.com/miniprogram/dev/devtools/settings.html
- miniprogram-automator 源码（0.13.0）：
  - https://unpkg.com/miniprogram-automator@0.13.0/out/MiniProgram.js
  - https://unpkg.com/miniprogram-automator@0.13.0/out/Connection.js
  - https://unpkg.com/miniprogram-automator@0.13.0/out/Launcher.js
- wxa-runner：
  - https://github.com/open-wxa/wxa-runner
  - https://github.com/hackwaly/wxa-runner
  - https://github.com/hackwaly/wxa-runner/blob/main/PROJECT_DESIGN.md
  - https://github.com/hackwaly/wxa-runner/blob/main/docs/ci.md
  - https://github.com/hackwaly/wxa-runner/blob/main/docs/setup.md
  - https://github.com/hackwaly/wxa-runner/blob/main/docs/test-api.md
  - https://github.com/hackwaly/wxa-runner/blob/main/docs/testing.md
  - https://github.com/hackwaly/wxa-runner/blob/main/docs/features.md
  - https://github.com/hackwaly/wxa-runner/blob/main/docs/faq.md
  - https://registry.npmjs.org/wxa-runner
  - https://registry.npmjs.org/@open-wxa/wxa-baselib
- 社区实践：
  - https://github.com/wxhou/openspec-playwright/pull/56
  - https://github.com/uni-helper/devtools/pull/12
  - https://github.com/Zi-Yi-Ming/miniprogram-auto-test/blob/main/docs/api-cheatsheet.md
  - https://github.com/KLKRL/wechat-miniprogram-cli-automation-guide