# 场景脚本（spec §3.6）

语言无关 JSON，BLE 交互序列（扫描 / 连接 / 发现 / 订阅 / 写 / 断连重连 / 挂起恢复）的**唯一用例源**。

- #2 小程序 Node 单测：`logic/test_utils/scenario_runner.ts` 驱动 `FakeTransport` + `BleLink`（`npm run test:logic` 每次提交跑）。
- #6 PC harness（Python，bleak）：`tests/pc_integration/scenario.py` 读带 `pc` 标记的步骤（`pc.frame` + `pc.expect`），驱动 `C3Harness`。
- #8 真机 B（automator）：设备模型复用 `FakeTransport`/`FakeLightDevice`，BLE 字节期望来自 `effects.json` + golden 向量（见下「共享矩阵」）。
- 修改协议行为时先改场景脚本，再让各端实现对齐；不要在某一端私加用例。

## Schema v1

```jsonc
{
  "version": 1,
  "name": "connect_scan_write",          // 必填，文件名之外的标识
  "description": "…",                    // 可选
  "environment": { "platform": "android", "mtu": 247 },  // 可选，传输环境默认值
  "steps": [
    {
      "action": "connect",               // 必填，见下表
      "deviceId": "C3-A1",               // connect / disconnect 用
      "hex": "AA55…",                    // write：写入的原始字节（hex）
      "frames": ["AA55…"],               // notify：设备侧推送的帧（hex 序列）
      "trigger": "remote",               // disconnect：local=主动断开 / remote=断连事件 / silent=静默断连（无事件）
      "timeoutMs": 40,                   // scan：扫描超时
      "script": { … },                   // 可选，传输侧编排（FakeTransport 在动作前应用）
      "expect": { … },                   // 可选，可观察断言（FakeTransport 侧）
      "pc": { … }                        // 可选，PC harness 专属期望（见下「pc 扩展」）
    }
  ]
}
```

### action

| action | 驱动 | 说明 |
|---|---|---|
| `scan` | `BleLink.scan` | 返回设备列表；`expect.devices` 断去重后的 deviceId 序列 |
| `connect` | `BleLink.connect` | 含发现 / 订阅；`expect.state` 通常为 `ready` |
| `write` | `BleLink.write` | `expect.chunks` 断分片大小序列，`expect.values` 断每片 hex，`expect.writeCalls` 断 Transport 写次数（超时 / 不重试用） |
| `notify` | `Transport.emitNotification` | 设备主动推帧；`expect.notifications` 断 BleLink 收到的帧 |
| `disconnect` | 按 trigger | `expect.state` 断状态；`expect.connectCalls` 断重连次数（风暴防护用） |
| `hide` / `show` | `BleLink.onHide` / `onShow` | 挂起恢复 |
| `waitForState` | 轮询 `BleLink.state` | 必须带 `expect.state`；超时 3s 报错 |

### script（FakeTransport 编排）

| 字段 | 说明 |
|---|---|
| `fail: { phase, errCode, times? }` | 让 `phase` 阶段接下来 `times` 次调用 reject `{ errCode }`（默认 1 次）。phase 取值同 `FailPhase`：openAdapter / discovery / connect / services / characteristics / notify / write / setMtu / getMtu 等 |
| `mtu` | 覆盖 `getBLEMTU` 返回的真实 ATT_MTU |
| `advertiseRepeats` | 每个设备重复广播次数（验证扫描去重） |
| `notifyHex` | `setNotification(true)` 成功后自动推送的帧（模拟 HELLO / STATUS） |

### expect（FakeTransport 侧断言）

`state` / `devices` / `chunks` / `values` / `notifications` / `error`（领域错误 code，如 `NOT_CONNECTED`）/ `connectCalls` / `writeCalls`。全部可选；hex 比较大小写不敏感。

### pc 扩展（PC harness 侧，向后兼容）

带 `pc` 键的步骤会被 `tests/pc_integration/scenario.py` 读取；FakeTransport 忽略 `pc`（前向兼容，未知字段不影响 Node 侧）。用于表达 PC 侧需要的期望字段（期望 notify / 串口事件 / Δ）：

```jsonc
{
  "action": "write",
  "hex": "AA55…",                        // FakeTransport 侧写入字节（双跑用）
  "expect": { "state": "ready" },         // FakeTransport 侧断言
  "pc": {
    "frame": { "type": "setEffect", "flags": 1, "strip_mask": 1, "payloadHex": "01FF0000" },
    "expect": "ack",                      // ack | status | error（对应 checks.check_step 的 expect）
    "statusFields": { "active_effect": [1, 0, 0, 0, 0, 0, 0, 0] },  // 可选，STATUS 字段比对
    "deltaLimitMs": 500                  // 可选，Δ 上限（默认取 harness 配置）
  }
}
```

`pc.frame.type` 用 `FRAME_TYPES` 的键名（setEffect / getStatus / setBrightness / setPowerLimit / unlockFullPower 等）；`payloadHex` 为效果参数 / 亮度 / 限流等 payload 字节。`pc.reconnect: true` 标记断连重连步骤（harness 调 `reconnect()`）。

## 共享矩阵（谁读什么）

| 资产 | FakeTransport（Node 单测） | PC harness（Python） | device_automator（真机 B） |
|---|---|---|---|
| `tests/scenarios/*.json` | 读全部 steps（action / hex / expect） | 读带 `pc` 的步骤（frame / expect / statusFields / Δ） | **不读**（见下） |
| `tests/protocol/vectors.json`（golden） | 编解码契约 | 编解码契约 | 编解码契约（`protocol.mjs` 解析） |
| `tests/device_automator/effects.json` | —（`device_effects_contract.test.ts` 对照） | — | BLE 字节期望（7 灯效 SET_EFFECT payload） |
| UI / 人工步骤（扫码 / 看灯带） | — | — | 不入 JSON（automator 自有 `scenarios.mjs`，人工步骤无法语言无关表达） |

**为什么 device_automator 不读场景 JSON**：真机 B 的断言面是 `page.data` / `element.attribute` / COM6 串口，含大量 UI 与人工步骤（扫码、看灯带颜色），这些无法用语言无关的 BLE 交互序列表达；其 BLE 字节期望已来自 `effects.json`（页面默认参数下 7 灯效 payload）+ golden 向量，与场景 JSON 的传输编排是不同维度。故 device_automator 不做结构改造，共享矩阵在此写明理由。

## 现有场景

| 文件 | 覆盖 |
|---|---|
| `connect_scan_write.json` | 扫描去重（重复广播）→ 连接 → 发现 → 订阅 → 写 SET_EFFECT → C3 通知 |
| `android_mtu_write.json` | 安卓 MTU 协商：真实值 247 → payload 244，500 字节分 3 片 |
| `disconnect_reconnect.json` | 断连路径①：连接状态事件 → reconnecting → 自动重连 ready |
| `write_drop_reconnect.json` | 断连路径②：静默掉线 → 写 reject 10006 → NotConnectedError → 自动重连 |
| `suspend_resume.json` | 挂起恢复：onHide 保留连接 → onShow 校验（无重连风暴）→ 继续可写 |
| `pc_connect_write_status.json` | PC smoke：连接 + 写 SET_EFFECT(ACK) + GET_STATUS(STATUS) |
| `pc_disconnect_reconnect.json` | PC 断连重连：断连 → 重连 → HELLO → 重连后 STATUS |

## 不在本 schema 内

3s 写超时、200ms notify 生效延迟等依赖假计时器的断言留在 Node 单测（`logic/ble_link.test.ts`）；跨端场景只放确定性的 BLE 交互序列。