# 小程序可测性与无手机影子运行

> 状态：已定稿（对应 issue #25）
> 适用范围：原生微信小程序逻辑层与设备页、Node 影子跑、Python BLE 桥、页面模拟测试
> 边界：帧字节、命令、CRC、分片/重组由 `docs/spec/protocol.md` 定；灯效语义、参数、页面交互语义由 `docs/spec/effects.md` 定。本文定**分层、Transport 接口、桥协议、连接状态机、页面接缝与测试接缝**。
> 冲突时：字节布局以 `protocol.md` 为准，灯效与交互语义以 `effects.md` 为准，其余以本文为准。

本文把「同一份小程序 TS 逻辑如何在没有手机时跑在 Node 里、经 PC 蓝牙桥直连真机 C3」钉死到可以直接照写的程度。

---

## 1. 分层与依赖方向

```text
        ┌──────────────────────────────┐
        │ pages/device（WXML + 薄 Page）│  只渲染快照、转发点击
        └──────────────┬───────────────┘
                       │ ViewState / 动作
        ┌──────────────▼───────────────┐
        │ DeviceController             │  8 条 + 总开关 + 乐观更新/回滚
        └──────────────┬───────────────┘
                       │ 场景、命令
        ┌──────────────▼───────────────┐
        │ BleLink                      │  状态机 + 命令会话 + 分片 + 写队列
        └───────┬──────────────┬───────┘
                │              │
        ┌───────▼──────┐  ┌────▼────────┐
        │ Codec（纯）  │  │ Transport   │  ← 接口（只有类型）
        └──────────────┘  └────┬────────┘
                               │
              ┌────────────────┼─────────────────┐
              │                │                 │
     ┌────────▼──────┐ ┌───────▼────────┐ ┌──────▼─────────┐
     │ WxTransport   │ │ PcBleTransport │ │ FakeTransport  │
     │ 小程序        │ │ Node / 桥客户端│ │ 测试           │
     └───────────────┘ └───────┬────────┘ └────────────────┘
                               │ stdio JSONL
                       ┌───────▼────────┐
                       │ Python 桥      │  bleak，只用适配器
                       └───────┬────────┘
                               │ BLE GATT
                          ┌────▼────┐
                          │ C3 固件 │
                          └─────────┘
```

依赖**只能向下**，不能反向或跨层回调：

| 模块 | 职责 | 允许引用 |
|---|---|---|
| `pages/device` | 渲染 `/pages/device/index.wxml`、把点击转成 controller 调用 | `logic` 的 `DeviceController`、`ViewState` |
| `DeviceController` | 场景镜像、8 行状态、总开关、乐观更新与回滚、错误文案 | `BleLink`、`effects`/`protocol` 的纯类型与常量 |
| `BleLink` | 扫描与连接策略、状态机、命令会话（seq/ACK/重传）、分片、写串行、超时、错误映射 | `Transport` 接口、`Codec`、`Clock` |
| `Codec` | 纯函数 `encode` / `feed`（含重组、粘包、半帧丢弃、CRC） | 无 |
| `Transport` | 单条 BLE 链路的字节通道：扫描、连接+发现+订阅、单包写、MTU、通知、断连 | 无 |
| `WxTransport` | `wx.*` BLE API 薄壳，回调转 Promise | `wx`、`Transport` 类型 |
| `PcBleTransport` | 桥客户端，JSONL 请求/事件 | `Transport` 类型、Node `child_process` |
| `FakeTransport` | 可编排的内存实现 | `Transport` 类型 |

**硬约束**：`miniprogram/logic/src/**` 内禁止出现 `wx`、`Page(`、`Component(`、`getApp(`、`App(`、DOM、`process.env`、裸 `setTimeout`（计时一律走注入的 `Clock`）。CI 用 grep/ESLint 强制；只有 `transport/wx-transport.ts`、`transport/factory.ts`、页面与 `app.ts` 能引用 `wx`。

---

## 2. 目录与同源构建

```text
miniprogram/
  app.ts                      # 组合根：组装 transport → link → controller
  logic/
    src/
      transport.ts            # 接口、错误类型、DeviceAdvertisement
      clock.ts                # Clock/Timers 接口 + 真实实现
      codec.ts                # protocol.md 的 TS 镜像
      ble-link.ts
      device-controller.ts
      view-state.ts
      index.ts                # 唯一导出入口
    tsconfig.build.json
    package.json              # "main": "dist/index.js"
    dist/                     # 唯一产物（tsc 生成，勿手改）
  transport/
    factory.ts                # 组合根选择 wx / fake
    wx-transport.ts
  test/
    fake-transport.ts
    page-scenarios.ts         # 命名场景（happy/nak/timeout/disconnect-recover）
  pages/device/
    index.ts / index.wxml / index.wxss / index.json
tools/
  shadow/
    bridge-client.ts          # stdio JSONL 客户端
    pc-transport.ts
    run.ts                    # 影子跑 CLI
bridge/
  ble_bridge/__main__.py
  requirements.txt            # bleak==3.1.*
tests/
  logic/                      # vitest，Fake
  scenarios/                  # 共享场景函数
  shadow/                     # Node 影子跑（需要有板子）
  page/                       # miniprogram-automator
```

**同源保证**：`logic/src` 是唯一事实源；`npm run build:logic` 用 `tsc` 产出 **CJS / ES2017 / sourcemap / d.ts** 到 `logic/dist`。小程序页面、Node 影子跑、`vitest` **都加载这同一个 `dist/index.js`**，Node 20 直接 `require`。三层的差异只在组合根（谁 new 哪个 Transport），逻辑本身没有第二份编译。

- `tsc -p logic/tsconfig.build.json`（`module: commonjs`、`target: es2017`、`declaration`、`sourceMap`）。
- 页面用 `require('../../logic/dist')`；Node 用同一路径或 `package.json` 的 `main`。
- `vitest` 直接测 `dist`（不是 `src`），并跑 `tests/protocol/vectors.json`：**产物过期会立刻红**。
- CI 先 `npm run build:logic`，再 `tsc --noEmit`、grep 约束、`vitest run`。

---

## 3. Transport 接口

```ts
export type DeviceId = string

export interface DeviceAdvertisement {
  deviceId: DeviceId          // 不透明：wx 是什么就是什么，Windows 是地址
  name: string
  rssi: number
}

export type TransportErrorKind =
  | 'not-initialized' | 'unsupported' | 'adapter-unavailable' | 'permission-denied'
  | 'not-found' | 'connect-failed' | 'service-missing' | 'characteristic-missing'
  | 'not-connected' | 'timeout' | 'invalid-data' | 'busy'
  | 'bridge-unavailable' | 'system'

export class TransportError extends Error {
  readonly kind: TransportErrorKind
  readonly code?: number        // 平台原始错误码，仅供诊断
}

export type Unsubscribe = () => void

export interface Transport {
  startScan(filter: { serviceUuid: string; namePrefix?: string }): void
  stopScan(): void
  onDeviceFound(cb: (adv: DeviceAdvertisement) => void): Unsubscribe

  /** 连接 + 服务/特征发现 + 订阅通知；resolve 时链路可用 */
  connect(deviceId: DeviceId, opts?: { timeoutMs?: number }): Promise<void>
  disconnect(): Promise<void>

  /** 写一个 BLE 包；调用方保证 bytes.length <= mtuPayloadBytes */
  writePacket(bytes: Uint8Array): Promise<void>
  onNotify(cb: (chunk: Uint8Array) => void): Unsubscribe
  /** 仅非预期断连；显式 disconnect() 不触发 */
  onDisconnect(cb: (err: TransportError) => void): Unsubscribe

  /** 可用负载字节数；未连接时为保守回退值（20） */
  readonly mtuPayloadBytes: number

  /** 断连 + 关适配器/杀桥；幂等 */
  dispose(): Promise<void>
}
```

语义钉死：

- `startScan` 幂等，按 `deviceId` 去重；重复广播只用于刷新 `rssi`；不会自动停止。
- `connect` 成功即「服务已发现、两个特征已校验、notify 已订阅」。已连接同一设备时直接 resolve。失败必须抛 `TransportError`，且不残留订阅。
- `disconnect` 幂等，不触发 `onDisconnect`，不做重连。
- `writePacket` 只写一个包；超过 `mtuPayloadBytes` 由 Transport 拒绝（`invalid-data`）。串行化由 `BleLink` 负责，Transport 内部也必须自己串行（平台并行写会失败）。
- `onNotify` 的块边界无意义（可能是半帧、粘包、正好一帧）；顺序即到达顺序。
- `mtuPayloadBytes` 在连接后有效：wx 为 `getBLEMTU()−3` 或 20；PC 为 `mtu_size−3`（`None` 时 20）；Fake 可配。
- `deviceId` 不跨 Transport 比较、不持久化、不写进日志当唯一键（日志用 name）。

---

## 4. 三个实现

### 4.1 WxTransport

- 适配器懒加载：首次 `startScan`/`connect` 时 `openBluetoothAdapter`；`dispose` 时 `closeBluetoothAdapter`。
- 扫描：`startBluetoothDevicesDiscovery({ services: [uuid], allowDuplicatesKey: true })`，在 `onBluetoothDeviceFound` 里按 `namePrefix` 过滤、按 deviceId 去重后上抛。
- 连接：`createBLEConnection({ timeout: 12000 })` → `getBLEDeviceServices` → 精确匹配服务 UUID → `getBLEDeviceCharacteristics` → 校验 CMD 可写、RSP 可 notify → `notifyBLECharacteristicValueChange` → **再等 200ms** 才 resolve（规避部分安卓 notify 使能后立刻写报 10008）。
- 写：`value` 必须是 **ArrayBuffer**（由 `Uint8Array` 的精确切片复制而来）；不显式传 `writeType`，交给平台默认（iOS 走 write、Android 走 writeNoResponse），协议 ACK 兜底。
- MTU：只被动跟随。`wx.canIUse('getBLEMTU')` 时连接后读取 `getBLEMTU()` 并用其值−3；监听 `onBLEMTUChange` 更新；读不到、iOS 报 0 或异常一律回退 20。**不调用 `setBLEMTU`**（`protocol.md` §3）。
- 断连双路径：① `onBLEConnectionStateChange(connected:false)` → `onDisconnect(not-connected)`；② 断连后读写 reject `errCode === 10006` → 同样的 `onDisconnect(not-connected)`。两条都接，缺一不可。
- 错误映射见 §7；`errCode === -1`（已在连接）视为成功。

### 4.2 PcBleTransport（Node）

- 首次使用时 `spawn('python', ['-m', 'ble_bridge'], { cwd: bridge/, stdio: ['pipe','pipe','pipe'] })`；等 `ready` 握手（5s）。
- 每个 Transport 方法翻译成一个桥请求：`scan.start` / `scan.stop` / `connect` / `disconnect` / `write` / `mtu.get`。
- notify 的 base64 在 Node 侧解码成 `Uint8Array` 后原样交给 `onNotify`。
- 桥进程死亡、握手失败、请求超时 → `bridge-unavailable`；连接期间桥崩 → 先触发 `onDisconnect`，再让后续调用失败。
- `dispose`：关 stdin → 等 2s → 未退出则 kill；幂等。
- 错误必须是桥归一后的 `kind`，Node 不解析 bleak 的异常字符串。

### 4.3 FakeTransport

- 内存实现，可编排：设备列表与 RSSI、连接失败、每步延迟、MTU、notify 帧序列、主动断连、写失败码；记录调用时序（断言串行、重试次数、分片大小）。
- 测试可直接构造；页面模拟通过 §9.2 的命名场景构造。
- Fake 只模拟「页面/逻辑需要看见的行为」，不做协议正确性；协议正确性由 `vectors.json` 保证。

---

## 5. 桥协议（Node ↔ Python）

### 5.1 承载与握手

- **stdio + JSONL**：一行一条 JSON；stdout 只走协议，日志走 stderr。
- Python 启动后第一行：`{"event":"ready","protocol":1,"bleak":"3.1.x"}`。
- Node 是父进程，负责拉起与关闭；Python 读到 stdin EOF 即自行退出。

### 5.2 消息形状

```jsonl
{"id":1,"op":"connect","args":{"deviceId":"AA:BB:CC:DD:EE:FF","timeoutMs":15000}}
{"id":1,"ok":true,"result":{"mtuPayloadBytes":244}}
{"id":2,"op":"write","args":{"data":"qgUBAAAC..."}}
{"id":2,"error":{"kind":"not-connected","message":"device disconnected"}}
{"event":"device","data":{"deviceId":"AA:BB:CC:DD:EE:FF","name":"BLE-Light-1A2B","rssi":-52}}
{"event":"notify","data":"qgUBAAAC..."}
{"event":"disconnect","data":{"kind":"not-connected","message":"link lost"}}
{"event":"overflow","data":{"queued":1024}}
```

- `id`：Node 单调递增整数；响应必须回带；未知 `id` 丢弃。
- 二进制一律 base64（比 hex 省一半）；`deviceId` 用平台原生字符串。
- 请求超时（Node 侧）：握手 5s、`connect` 15s、其余 5s。**任一请求超时 → 杀桥、链路进 FAILED**，不带着状态未知的电台继续跑。
- Python 侧串行执行 BLE 操作（asyncio lock）；`connect` 时若已连接返回 `busy`。
- notify 保序、不合并、不丢；积压超过 1024 条 → 发 `overflow` 并主动断开。Node 把 `overflow` 当链路失败处理，不展示给页面。

### 5.3 操作集

| op | args | result | 说明 |
|---|---|---|---|
| `scan.start` | `{serviceUuid, namePrefix?}` | `{}` | 开始发现；重复调用幂等 |
| `scan.stop` | `{}` | `{}` | 停止发现 |
| `connect` | `{deviceId, timeoutMs?}` | `{mtuPayloadBytes}` | 连接 + 服务/特征校验 + 订阅；自动停扫描 |
| `disconnect` | `{}` | `{}` | 断开并停通知；幂等 |
| `write` | `{data: base64}` | `{}` | 固定 `response=false` |
| `mtu.get` | `{}` | `{mtuPayloadBytes}` | 未连接时 20 |

事件：`ready`、`device`、`notify`、`disconnect`、`overflow`。

**桥是纯电台**：不编解码帧、不认灯效、不做重连/退避/超时重传。这些全在 `BleLink`。

### 5.4 bleak 语义与错误归一

- 扫描：`BleakScanner(service_uuids=[uuid])`；`device` 事件按地址去重。
- 连接：`BleakClient(device, timeout=timeoutMs/1000)`；`services` 校验两个特征都存在；`start_notify(RSP)` 成功后才回响应。MTU 读 `client.mtu_size`，`None` 或 <23 时按 23 处理，`mtuPayloadBytes = mtu − 3`。
- 写：`write_gatt_char(CMD, data, response=False)`；不实现 write-with-response 分支。
- 线程/apartment：入口设 `sys.coinit_flags = 0`（或不再 import pywin32），避免控制台 STA 卡死。
- 错误归一：

| bleak / 平台情况 | kind |
|---|---|
| 找不到设备 / 扫描不到 | `not-found` |
| 连接失败、连接被拒 | `connect-failed` |
| 适配器关闭 / 无适配器 | `adapter-unavailable` |
| 权限被拒 | `permission-denied` |
| 服务或特征缺失 | `service-missing` / `characteristic-missing` |
| 未连接时写 | `not-connected` |
| 平台超时 | `timeout` |
| 数据长度非法 | `invalid-data` |
| 其余 `BleakError` | `system` |

### 5.5 生命周期

- Node 拉起 Python；无 HTTP/WebSocket、无端口、无鉴权面。
- `dispose()`：关 stdin；Python 收到 EOF → 断开 BLE → 退出 0；2s 未退则 kill。
- 父进程被杀：Python 读 EOF 自行退出，不留孤儿。
- 场景开跑时允许重启一次桥（首次拉起失败）；跑中崩溃按 `bridge-unavailable` 失败，**不静默重连**。

---

## 6. BleLink

### 6.1 职责与 API

```ts
export type LinkState =
  | 'idle' | 'scanning' | 'connecting' | 'ready' | 'reconnecting' | 'failed'

export interface BleLink {
  readonly state: LinkState
  readonly caps: HelloCaps | null        // 来自 HELLO（effect_bitmap、fw 版本）
  start(): Promise<void>                // 扫描 + 自动连接
  stop(): Promise<void>                 // 显式断开 → idle
  retry(): Promise<void>                // failed → 重新开始
  setEffect(stripMask: number, effectId: number, params: Uint8Array): Promise<void>
  getStatus(): Promise<Status>
  getScene(): Promise<Scene>
  onState(cb: (s: LinkState) => void): Unsubscribe
  onStatus(cb: (s: Status) => void): Unsubscribe
  onScene(cb: (s: Scene) => void): Unsubscribe
}
```

- `BleLink` 不认识灯效语义；`SET_EFFECT` 的参数由 `DeviceController` 按 `protocol.md` §6 编码。
- 构造参数：`{ transport, clock, filter: { serviceUuid, namePrefix }, reconnectDelays?: number[] }`。
- 计时全部走 `clock`，单测用假时钟推进，不真等。

### 6.2 状态机

```text
idle ──start──► scanning ──设备匹配──► connecting ──连接+HELLO(≤1.5s)──► ready
                   │                        │
                   └─ 8s 无匹配 ─► failed    └─ 失败/超时 ─► failed（首连不自动重试）
ready ──断连事件 / 10006 / 写超时 / 10s 无帧──► reconnecting
reconnecting ──第 1..3 次成功 + HELLO──► ready
reconnecting ──3 次失败──► failed
failed ──retry()──► scanning
任意状态 ──stop()──► idle
```

| 迁移 | 条件 |
|---|---|
| `idle → scanning` | `start()`；`retry()` 从 `failed` 同路径 |
| `scanning → connecting` | 收到名称匹配的广播；多个候选取 RSSI 最强者 |
| `scanning → failed` | 8s 内无匹配 |
| `connecting → ready` | `transport.connect()` resolve **且** 收到 HELLO（≤1.5s）；`caps` 就位 |
| `connecting → failed` | 连接失败/超时/HELLO 超时（首连不自动重试） |
| `ready → reconnecting` | 非预期断连、写 10006、单包写超时、10s 无任何帧 |
| `reconnecting → ready` | 重新连接 + 重新订阅 + 收到 HELLO |
| `reconnecting → failed` | 3 次尝试都失败（等待 500/1000/2000ms 后进行每次尝试） |
| 任意 → `idle` | 显式 `stop()` |

- **READY 的准入是 HELLO**，不是连接成功；未收到 HELLO 不得假设能力（`protocol.md` §5）。
- `onNotify` 在发起 `connect` **之前**注册，HELLO 可能在 connect resolve 前到达；`BleLink` 先收下再判定。
- 10s 存活看门狗：`STATUS` 周期 2s，READY 后 10s 没有任何帧视为链路已死 → 主动断开并进 `reconnecting`。
- `onHide` 只停扫描，不断连；`onShow` 发一次 `GET_STATUS` 探活（2s 超时），失败则进 `reconnecting`。
- `FAILED` 是终点态：只等 `retry()`，不无限自动重连。

### 6.3 命令会话

- 每个方向各自 16 位 seq，从 0 起；`Codec.encode` 接收 seq。
- 命令队列**一次只允许一帧在途**（`protocol.md` §3 末条）：上一帧 ACK/NAK/超时才发下一帧。
- 需 ACK 的命令：发出后起 500ms 计时，超时整帧重发，最多 3 次（含首发共 4 次）；收到 NAK 立即失败，不重试。
- `GET_STATUS` / `GET_SCENE` 不 ACK，等对应 `STATUS`/`SCENE` 回归，超时 1s。
- 分片：`packetSize = max(20, transport.mtuPayloadBytes)`，按 `packetSize` 切片，逐包 `writePacket`，包间串行，单包超时 3s。**20 字节是永不放弃的兜底**。
- 单包写超时视为链路不可信：该命令失败、页面回滚，并主动断开进 `reconnecting`（迟到的包可能已写出半帧；固件 200ms 半帧丢弃能自愈，但继续发会踩序号）。
- 收到 ACK 后不停留：持久化在固件侧（去抖 1s），客户端不做写入去抖。
- ACK/NAK 由 `Codec.feed` 解析成事件；`BleLink` 只做 seq 关联，不解释灯效。

---

## 7. 错误映射与文案

### 7.1 平台 / 桥错误

| 来源 | kind | 档位 | 结果 |
|---|---|---|---|
| wx 10000 | `not-initialized` | 致命 | `failed` |
| wx 10001 / bleak 适配器关闭 | `adapter-unavailable` | 致命 | `failed`，提示开蓝牙 |
| wx 10009 / 10007 | `unsupported` | 致命 | `failed` |
| wx 10004 / 10005 | `service-missing` / `characteristic-missing` | 致命 | `failed`，提示固件/契约不符 |
| wx 10002 / 10003 | `not-found` / `connect-failed` | 首连致命；已 ready 后可重连 | 首连 `failed`；已 ready → `reconnecting` |
| wx 10006 | `not-connected` | 可重连 | `reconnecting` |
| wx 10012 / 10008 | `timeout` / `system` | 连接类致命；写类回滚+重连 | 见 §6.3 |
| wx 10013 | `invalid-data` | 致命 | `failed` |
| wx -1（已连接） | — | — | 视为成功 |
| 桥超时/崩溃/握手失败 | `bridge-unavailable` | 致命 | `failed` |
| wx 权限弹窗被拒 | `permission-denied` | 致命 | `failed`，提示授权 |

### 7.2 NAK → 单命令失败（不改链路状态）

| NAK code | 文案 |
|---|---|
| `0x01` | 数据校验失败 |
| `0x02` | 固件不支持该命令 |
| `0x03` | 固件不支持该灯效 |
| `0x04` | 固件版本不匹配 |
| `0x05` | 参数不合法 |
| `0x07` | 设备忙，请稍后 |
| `0x08` | 固件版本不支持 |

- NAK 永不自动重试；只回滚触发它的那条命令。
- 超时（500ms×3 后无 ACK/NAK）文案：**设备无响应**。

---

## 8. DeviceController 与设备页

### 8.1 状态

```ts
export interface ViewState {
  link: LinkState
  banner: string | null            // 「正在连接…」「重连中…」或错误文案
  allOn: boolean                   // 派生：任一 strip 的 effectId !== 0
  rows: RowView[]                  // 恒 8 条
}
export interface RowView {
  strip: number
  on: boolean                      // effectId !== 0
  effectId: number
  params: Uint8Array               // 当前效果参数（RGB 布局）
  pending: boolean                 // 乐观中，等 ACK
  error: string | null
}
```

Controller 内部持有：`strips[8] = { effectId, params, lastOn: {effectId, params} | null }`。

- `lastOn` 只在收到 ACK 后更新；`effectId === 0` 时保留上一次非关灯快照。
- 重连/启动时以 `GET_SCENE` 覆盖；`SCENE` 里 `effectId === 0` 的条目 `lastOn = null`（重连后无法得知上次开灯参数），再开灯走默认静态白 `0x01 + (128,128,128)`（`effects.md` §7）。

### 8.2 生命周期

1. `ready` → `getScene()` → 填 `strips` → `link = ready`、`banner = null`（此前的 banner 一直是「重连中」）。
2. `status` 事件只更新诊断，不覆盖场景。
3. `reconnecting` → 行置灰、保留最后已知值、`banner = 重连中`；进行中的命令全部回滚。
4. 重连成功 → 重新 `getScene()` 后才解除「重连中」。

### 8.3 乐观更新与回滚

点击行内开关：

```text
记下旧 RowView → 立即应用新状态（pending=true）→ setEffect
  ├─ resolve（ACK） → pending=false，提交 lastOn
  ├─ CommandRejected → 恢复旧 RowView，pending=false，行内 error=文案
  └─ 超时/链路失败 → 恢复旧 RowView，pending=false，error=「设备无响应」
```

- 开灯：`lastOn ?? { 0x01, [128,128,128] }`；关灯：`0x00`，`strip_mask` 单 bit。
- 总开关（`allOn` 为真）：一帧 `SET_EFFECT(0x00)`、`strip_mask = 0xFF`，8 行一起乐观关。
- 总开关（全关 → 全开）：**逐条一帧**按 `lastOn` 恢复；某条失败只回滚该行并显示错误，后续继续。
- 非 `ready` 状态点击：页面不响应（按钮 disabled），controller 里也直接 no-op。
- 参数页每次控件变化即时下发，同样走乐观更新；参数按 `effects.md` 语义编码成 `protocol.md` §6 的参数。

### 8.4 页面结构

- 一个总开关 + 8 行；每行 = 行内开关 + 右侧入口（点按进参数页，携带 `strip`）。
- `pages/device/index.wxml` 只读 `ViewState`；没有本地状态、没有 `wx.*` 调用、没有重试逻辑、没有协议错误解析（controller 已给文案）。
- 稳定测试标识：`data-test="master-switch"`、`data-test="strip-{i}"`、`data-test="toggle-strip-{i}"`、`data-test="open-strip-{i}"`、`data-test="banner"`、`data-test="row-error-{i}"`。
- 页面 `onLoad` 从 `getApp().ble.controller` 订阅快照并 `setData`；`onUnload` 退订。
- 断连表现：8 行 `disabled`（WXML 用 `link !== 'ready'`），banner「重连中…」，保留最后已知值，不假装成功。

---

## 9. 测试接缝

### 9.1 三层测试边界

| 层 | 载体 | 何时跑 | 覆盖 |
|---|---|---|---|
| 逻辑单测 | `vitest` + FakeTransport + 假时钟 | 每个 PR / CI | Codec 向量、状态机全迁移、命令会话、分片、错误映射、controller 乐观/回滚 |
| Node 影子跑 | `PcBleTransport` + 真桥 + 真 C3 | Windows + 板子，nightly/手动，**不进 Linux CI** | 真实 GATT/MTU/notify 时序、端到端控制、重连 |
| 页面模拟 | `miniprogram-automator` 0.13.0 + 开发者工具模拟器 + Fake | Windows GUI 常驻，nightly/手动，**不进 Linux CI** | 页面数据、点击、禁用态、错误文案、路由 |
| 真机冒烟 | Android 微信 + 人工清单 | 发版前 | 微信 BLE 栈、权限、后台/锁屏、iOS 差异 |

### 9.2 页面测试如何切 fake / real

- 组合根 `transport/factory.ts`：

```ts
export function createTransport(): Transport {
  if (wx.getStorageSync('__ble_transport') === 'fake') {
    return createFakeTransport(wx.getStorageSync('__ble_fake_scenario') || 'happy')
  }
  return createWxTransport()
}
```

- Fake 与命名场景放 `miniprogram/test/`，在 `project.config.json` 的 `packOptions.ignore` 中排除 `test/**`：本地开发者工具照常编译，但**永不随上传**。
- automator 流程：`cli.bat auto --project <repo>/miniprogram --auto-port 9420` → `connect` → `setStorageSync('__ble_transport','fake')` + 场景名 → `reLaunch('/pages/device/index')` → 等 `link === 'ready'` → 断言/点击 → 清理 storage 并重载。
- **不用 `mockWxMethod` 打桩**：安装时机早于页面 `onLoad` 不可保证；依赖注入是唯一稳的接缝。
- 场景字符串：`happy`、`nak`、`timeout`、`disconnect-recover`、`slow-connect`。页面测试只消费这些命名场景，不直接构造 Fake。

### 9.3 页面断言清单

1. 启动后自动连接，`link` 从 `connecting` 到 `ready`，banner 消失。
2. `GET_SCENE` 的 8 条映射到 8 行（effect 与参数摘要），`allOn` 派生正确。
3. 行开关打开：点击瞬间行变亮/开关态改变（乐观），ACK 后 `pending` 清除。
4. NAK 场景：行恢复原状态，`row-error-{i}` 显示对应文案。
5. 超时场景：行恢复原状态，显示「设备无响应」。
6. 断连：8 行 disabled、banner「重连中…」、最后已知状态保留。
7. 重连成功：`GET_SCENE` 覆盖后行状态更新，banner 消失。
8. 总开关：任一开 → 一帧全关（8 行立刻全灭）；全关 → 逐条恢复，`lastOn` 正确的行恢复原效果。
9. 非 `ready` 时点击行/总开关无任何下发，视图不变。
10. 点右侧入口进入参数页，页面参数携带正确 `strip`。

**页面层不测**：真实 BLE、GATT/MTU、权限弹窗、系统蓝牙开关、notify 时序、后台/锁屏存活、像素级视觉回归。这些归影子跑、Android 人工或云真机。

### 9.4 场景脚本与影子跑

- 场景写成纯 TS：`tests/scenarios/*.ts` 导出 `run(ctx: { link, controller, assert })`，断言用 `node:assert`，不绑 vitest。
- 同一份场景文件两个 runner：`vitest` 喂 `FakeTransport`（PR）；`npm run shadow -- --scenario happy` 喂 `PcBleTransport`（Windows + 板子，环境变量 `BLE_BRIDGE=1` 才跑，否则 skip）。
- 影子跑启动顺序：拉起桥 → 握手 → 连接设备 → 等 HELLO → 执行场景；结束时 `dispose`。
- 页面 automator 测试是第三套，只用命名 Fake 场景，不与场景脚本混用。

### 9.5 同源验收

- 小程序、Node、`vitest` 必须加载同一 `logic/dist/index.js`；CI 以 `dist` 跑向量与单测。
- `logic/src` 的禁用 API 检查在 CI 必过。
- 任何一层需要「绕过 Transport」才能测的逻辑，说明抽象漏了，回头补接口，不在页面里加测试钩子。

---

## 10. 时序摘要

### 10.1 首连

1. 页面挂载 → `controller.start()` → `link.start()` → `transport.startScan`。
2. 匹配广播 → `state = connecting` → `transport.connect`（连接+发现+订阅）。
3. C3 发 HELLO（可能在 connect resolve 前）→ `BleLink` 记录 caps。
4. `state = ready` → controller `getScene()` → `SCENE` → 渲染。
5. 之后 STATUS 每 2s 刷新看门狗。

### 10.2 断连重连

1. 断连事件 / 10006 / 写超时 / 10s 无帧 → `transport.disconnect()`，`state = reconnecting`，页面置灰。
2. 等待 500ms → 重新扫描/连接（最多 3 次，间隔 1000/2000ms）。
3. 成功 + HELLO → `ready`；controller 重新 `getScene()`；覆盖后解除「重连中」。
4. 3 次失败 → `failed`；页面显示「重连失败」+ 重试按钮（调 `retry()`）。

---

## 11. 验收

- [ ] 同一份 `logic/dist/index.js` 被小程序、Node 影子跑、`vitest` 加载；CI 跑的是产物。
- [ ] `logic/src` 无 `wx`/`Page`/`getApp`/`process.env`/裸 `setTimeout`。
- [ ] Transport 契约：connect 含发现+订阅；write 收单包；mtuPayloadBytes 可用；断连双路径。
- [ ] 状态机 6 状态全迁移、`FAILED` 只经 `retry()` 离开、10s 看门狗可复现。
- [ ] 命令会话：一帧在途、500ms×3、NAK 不重试、20 字节兜底、单包 3s。
- [ ] 桥：JSONL 形状、`id` 关联、base64、超时杀桥、overflow、stdio 生命周期。
- [ ] 错误映射表逐条可触发（Fake 注入）；NAK 文案与页面一致。
- [ ] 页面 10 条断言在 automator 下全过；Fake 只经 storage 注入，上传包不含 `test/**`。
- [ ] 影子跑 `--scenario` 在真板子上跑通 happy 与 disconnect-recover。
- [ ] 断连/重连的页面表现与 `effects.md` §8.5 一致。

---

## 12. 边界与后续

- `docs/spec/test-strategy.md`（#26）定「一条命令」的入口与测试金字塔；本文只定接缝，不抢命令名。
- GATT 承载（服务/特征 UUID、广播名、CCCD）见 `protocol.md` §16。
- 页面视觉与项目站点（#27）不在本文范围。
- 本 spec 不含发布合规、iOS 真机、云真机流程。
