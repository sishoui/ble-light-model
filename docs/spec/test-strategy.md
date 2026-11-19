# 测试体系 Spec

> 来源：从 wayfinder 地图 #1 的子任务决议提炼（#2 小程序可测性 / #4 BLE 协议 / #6 PC 集成 / #8 测试自动化），协议细节以 #4 决议与 `tests/protocol/vectors.json` 为单一事实源。
> 状态：spec 阶段定稿（2026-11-19）。实现另开会话照本 spec 落地。

## 0. 定位

本 spec 锁定"无手机 PC 闭环测试"的可测性约束，并定义四层测试金字塔：每一层测什么、用什么、什么时候跑、断言什么、进不进 CI。产品实现（小程序 + 固件）另开会话，但必须满足本 spec 的可测性约束，否则测试链路建不起来。

配套实现决议：硬件 #3、协议 #4、固件 #7、合规 #5。本 spec 只覆盖"怎么测"，不重复这些设计内容，只引用其可测性相关约束。

## 1. 可测性约束（贯穿所有层，实现必须遵守）

### 1.1 小程序层：Transport 抽象

四层单向依赖，上层可测、下层隔离运行时：

| 层 | 职责 | 允许引用 |
|---|---|---|
| `WxTransport` | `wx.*` BLE API 的 1:1 薄壳，回调转 Promise，失败 reject `{ errCode, errMsg }`（保留原始码） | 仅 `wx` |
| `BleLink` | 扫描 / 连接 / 服务与特征值发现 / 订阅 / 写串行化 / 连接状态机 / 重连 / 错误码→领域错误映射 | Transport 接口 |
| `Codec` | 纯函数 `encode(frame): Uint8Array` / `feed(bytes): Frame[]`，含分片 / 粘包 / CRC / 序号 | 无（不 import 传输类型） |
| `LightService` | 8 路灯带业务 | BleLink |

- 目录边界：`miniprogram/logic/**` 为纯 TS，**禁止** `wx` / `Page` / `Component` / `getApp`，用 ESLint `no-restricted-globals` 或 CI grep 强制。
- 页面 / 组件不进单测，靠真机冒烟。
- 工程约束：logic 用 ESM；`verbatimModuleSyntax` + 显式 `import type`；禁 `enum` / `namespace` / 参数属性；`tsc --noEmit` 进 CI（开发者工具的 TS 编译只剥类型，不做类型检查）。

### 1.2 固件层：platform-agnostic 协议层

- `firmware/proto/` 纯 C99，不依赖 Arduino / IDF，不用动态内存；`ble_proto_encode/feed` 只处理帧、分片、CRC、seq。
- 效果引擎单独放 `effect_engine.c`，协议层不认识具体灯效。
- 目的：协议层可 host 编译（`platform = native`）单测，不依赖 C3 硬件。

### 1.3 golden 向量（跨语言契约）

- `tests/protocol/vectors.json` 是 JS / C / Python 三侧的**唯一编解码契约**（不跨语言复用代码，只对齐字节）。
- 至少覆盖：正常帧、分片、粘包、CRC 错、seq 错、未知 type、未知灯效、param_len 过长 / 过短。
- 三侧（小程序 `codec.ts`、固件 `firmware/proto/`、PC `tests/pc_integration/` 的 Python 复刻）各跑同一组向量，字节一致即通过。

## 2. 测试金字塔

| 层 | 测什么 | 工具 | 触发 | 断言面 | 进 CI |
|---|---|---|---|---|---|
| Node 单测（#2） | logic 纯函数 / 状态机 / 错误映射 | Node + vitest + `FakeTransport` | 每次提交 | 函数返回、状态迁移、调用时序 | 是 |
| 协议 golden（#4） | 编解码跨语言一致 | `tests/protocol/vectors.json` | 每次提交 | 两侧对同一输入字节相同 | 是 |
| 固件 host 单测（#7） | 协议层 / 效果引擎逻辑 | Unity（`pio test -e native`） | 每次提交 | 编码 / feed / 效果输出 | 是 |
| PC 集成（#6） | C3 / 协议 / GATT 真机 | Python + bleak + pyserial + pytest | 日常回归 / 发布前 | COM6 JSONL + RSP notify 交叉 | 否（依赖硬件） |
| 真机 B（#8） | 手机 → C3 全链路 | miniprogram-automator + COM6 | 改 BLE 后 / 发布前 | `page.data` / `element.attribute` / COM6 | 否（依赖硬件 + 人工扫码） |
| UI 回归 C（#8） | 页面渲染 / data 绑定 / 按钮 / 跳转 | wxa-runner + Playwright | spike 期每 push / 通过后 nightly | page data / WXML / 页面路径 / mock 调用日志 | spike（best-effort） |

## 3. 各层细则

### 3.1 小程序 Node 单测（#2）

- `FakeTransport`：内存 Transport 替身，可编排设备列表、失败码、超时、断连、通知帧序列、MTU 结果、延迟与批量回调；记录调用时序（断言串行、去抖、重试次数）。
- **场景脚本**（语言无关 JSON，见 §3.6）：扫描 / 连接 / 发现 / 订阅 / 写 / 断连重连 / 挂起恢复，同一份喂 FakeTransport 与真机 / PC 集成环境，行为不一致即抽象漏了。
- 覆盖清单：扫描去重与超时、连接状态机全迁移、服务 / 特征值发现与缓存、订阅启用、写串行与并发保护、MTU 协商与分片、粘包 / 半帧 / CRC 错 / 序号错、错误码映射全覆盖、断连与重连、onHide / onShow 生命周期。
- 硬指标：逻辑层行覆盖 ≥ 90%，状态机分支全覆盖。

**写策略硬约束**（实现必须照做）：
- 写串行队列（官方：并行多次写可能失败）。
- 每片写超时 3s（官方：iOS 单次写过长可能无任何回调，Promise 永久挂起）；超时抛 `TimeoutError`，不自动重试。
- 分片：起步 20 字节；安卓 `setBLEMTU` 后用 `getBLEMTU` / `onBLEMTUChange` 的真实值 −3 作 payload（success 返回的 mtu 是回显，不可信）；iOS 用系统值 −3；20 字节兜底永不放弃。
- notify 使能成功后延迟 200ms 再写（规避部分安卓 10008）。
- `value` 必须是 `ArrayBuffer`。
- 断连双路径：① 被动断连走 `onBLEConnectionStateChange(connected:false)`；② 断连后读写 reject `errCode===10006`。只处理一个是错的。

### 3.2 协议 golden 向量（#4）

帧格式（多字节小端）：

```text
AA 55 | ver(1) | seq(2) | type(1) | flags(1) | strip_mask(1) | param_len(1) | payload(N) | crc16(2)
```

- `crc16`：CRC-16/CCITT-FALSE，poly `0x1021`，init `0xFFFF`，覆盖 `ver` 到 `payload`。
- `flags` bit0 = 需要 ACK；其余保留，接收端忽略未知位。
- 未知 type → NAK `0x02`；未知灯效 → NAK `0x03`；版本不支持 → NAK `0x08`；长度不符 → NAK `0x04`。
- golden 向量即 §1.3 所列清单的字节级样例。

### 3.3 PC 集成测试（#6）

- **定位**：测 C3 / 协议层。PC 蓝牙适配器当 BLE 中心（GATT Client）直连 C3，发指令 → C3 响应 → COM6 串口打印 → PC 自动断言。
- **断言锚点**：COM6 串口日志（JSONL，事件级，固件内部地面真相）+ 订阅 RSP 特征值（ACK / STATUS）交叉，抓"ACK 说成功但固件没动作"与"固件动作了但 ACK/STATUS 没发"两类 bug。
- **时序**：seq 回显为关联键；PC 写 BLE 前记 t0（单调时钟），收同 seq 串口行算 `Δ = now − t0`，断言 `Δ < 500ms`（慢机 / 高 RMT 负载放宽到 1s）。C3 的 `t_ms` 只用于日志排序，不作跨机断言基准。
- **进程模型**：单进程同时开 BLE + COM6；#6 与 #8 的 B 不在同板同时跑。
- **确定性前置**：开 COM6 后拉 DTR 复位 C3，等启动日志，再写一条 `SET_EFFECT` 基线；不依赖上次 NVS 状态。
- **工具链**：Python + bleak + pyserial + pytest（bleak WinRT 后端 Windows 最稳、纯 pip 无原生编译）。协议编解码 Python 复刻（约百行），用 golden vector 校验，不复用 JS。
- **失败取证**：每次跑落 run 目录（原始串口 + 解析 JSONL + BLE notify 时间线 + 失败步骤索引）。
- **组织**：独立 `tests/pc_integration/`，Windows 本地一条命令跑，不进 Linux CI；附 <1min smoke 子集。
- **事实约束**（`research/pc-ble-central.md`）：Windows 中心自动请求大 MTU（应用不可设，C3 侧配 `CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU` + 处理 `BLE_GAP_EVENT_MTU`）；Windows 重连可能往 CCCD 写 `0x80`（NimBLE-Arduino #850），固件要重订阅；改 GATT 布局后 PC 要清服务缓存；Windows 蓝牙栈同时只支持一个活动 radio。

### 3.4 真机 automator（#8 B）

- **定位**：手机 ↔ C3 全链路，人工只负责扫码 + 看灯带。
- **场景清单（6 条）**：

| # | 场景 | UI 断言 | COM6 串口断言 |
|---|---|---|---|
| 1 | 冷启动连接：扫描→连接→发现→订阅→HELLO | `page.data` 连接态 / 设备名；按钮 disabled 态 | HELLO（caps/effect_bitmap）、ACK、首条 STATUS |
| 2 | 写灯效：单 / 多 `strip_mask`、7 种效果切换、亮度 0/100 边界 | `page.data` 当前效果 / 亮度 | 帧类型 / 掩码 / 参数逐字段 + ACK |
| 3 | 通知刷新：C3 周期 STATUS → 页面状态跟随 | `page.data` 状态字段 | C3 发出的 STATUS 内容与周期 |
| 4 | 被动断连 + 重连：手机蓝牙关→开 | 5s 内进入 fault / 未连接态；重连后 ready | 断连日志；重连后连接事件 |
| 5 | 后台恢复：`onHide` 短 / 长两种 | `onShow` 后 ready；无重复连接风暴 | 连接 / 断连序列与 #2 状态机一致 |
| 6 | 失败路径：C3 断电 / 写无 ACK | 3s 超时 → `TimeoutError`；不自动重试 | 无 ACK；恢复后重连 |

- **断言口径**：`page.data` 只断公开 data；`element.attribute` 只断可访问性 / 状态类；`console` 只断领域错误出现 / 不出现；COM6 事件级断言（Δ 默认 500ms，连接 / 重连放宽 5s）；灯带颜色只由人工看，不机器断言。
- **BLE notify 推到脚本**：`exposeFunction('onBLEFrame', hex=>...)` + `evaluate` 注入第二个 `wx.onBLECharacteristicValueChange` 监听器，hex 回传；**不给生产代码加测试钩子**。注意 JSON 序列化、`off` 清全部监听需重注入、`remote` 下 `screenshot()` 不可用但 `page.data()` 可用。
- **环境固化**：专用安卓机常亮（`svc power stayon true`）、蓝牙常开、开发者工具常驻、端口固定 `9420`；`cli auto` + `connect`；`remote(true)` 未扫码静默等待无超时 → 每轮 60s 看门狗；`connect()` 无内置超时 → 每次包超时；`Connection closed` 不重试、等人。
- **连跑门槛**：场景 1 / 2 / 4 连续跑 3 次。
- **产物**：成功留 summary；失败落 run 目录（automator 日志 + console + COM6 JSONL + 失败步骤 `page.data` 快照）。
- **不进 CI、不重试、等人。**

### 3.5 UI 回归 spike（#8 C，best-effort）

- **工具状态**：`wxa-runner` 非官方，2026-11 应腾讯要求下线，npm 全 deprecated。决策：fork `hackwaly/wxa-runner@0.14.0` + baselib `3.7.0`，vendor 进仓库，作**有时限 spike**。
- **BLE mock**：`wx-ble-mock.js` 覆盖 `WxTransport` 用到的全部 BLE API，内部复用 `logic/` 的 `FakeTransport` 场景引擎（设备模型同源，不出现第二套假蓝牙）；mock 在 `wx` 层，不绕过 `WxTransport`。invoke 型走 setup `mock`，事件型在 `app.js` 前替换 `wx` 方法或 `__wxaHost.emitToService` 派发。
- **产物**：跑 `dist/miniprogram/`（与开发者工具 / 真机同一份构建），不另建打包。Linux x86-64 + Node ≥18 + Chrome（`channel:'chrome'`）。
- **接入时机**：logic 单测完成后搭骨架，页面能渲染即接连接页 / 控制页。
- **kill 标准**：spike 内跑不通 1 条连接页 happy path，就砍掉 C，退回"人工 UI 清单 + B 真机"。不阻塞 B / #2 / #6。

### 3.6 场景脚本（跨层唯一用例源）

- 语言无关 JSON，BLE 交互序列（扫描 / 连接 / 发现 / 订阅 / 写 / 断连重连）的唯一用例源。
- #2 的 FakeTransport、#6 的 PC harness、#8 的 B 共读同一份；C 的 UI 用例复用其 BLE 行为与 `FakeTransport` 设备模型。

## 4. 失败定位（跨层）

真机 B 每次运行落三方时间线（automator 日志 + 小程序 console + COM6 JSONL），按下表定位：

| 现象 | 归属层 |
|---|---|
| UI 错且串口无帧 | 小程序 UI / 逻辑层 |
| 串口有帧但 UI 状态错 | 小程序逻辑层 |
| 串口无帧 | BLE 空口 / 固件 |
| C3 收到帧但灯不对 | 固件灯效 / RMT |

PC 集成（#6）分层定位靠"原始串口 + BLE 时间线"两份独立证据对照。

## 5. 边界与不做

- **不进 CI**：PC 集成（依赖物理 BLE 适配器 + C3）、真机 B（依赖硬件 + 人工扫码）。
- **A 零人工升级**（发布后 URL Scheme + 应用内自检 + 结果回传）：本 effort 只预留 `envVersion` 门控 + `Reporter` 接口，实现 out-of-scope，另开 effort。
- **不做**：iOS 真机（用户只有 Android）、OTA 固件升级、BLE 逐帧像素流、多设备寻址。
- **C UI 回归**为有时限 spike，失败按 kill 标准降级，不阻塞发布。

## 6. 验收（Definition of Done）

**最小闭环**：Node 单测 + 固件 host 单测 + 协议 golden 全绿 → PC 集成日常回归跑通 → 真机 B 关键场景（1/2/4）连跑 3 次通过 → 人工点一遍 8 路灯带效果正确。

| 层 | 通过标准 |
|---|---|
| Node 单测 | vitest 全绿，行覆盖 ≥90%，状态机分支全覆盖 |
| 协议 golden | JS / C / Python 三侧对同一向量字节一致 |
| 固件 host 单测 | `pio test -e native` 全绿 |
| PC 集成 | 连接 / 写 / ACK / STATUS / 断连重连全绿 + <1min smoke |
| 真机 B | 场景 1/2/4 连跑 3 次通过；6 场景完整回归 |
| UI 回归 C | spike 期 ≥1 条连接页 happy path 绿；否则按 kill 标准降级 |