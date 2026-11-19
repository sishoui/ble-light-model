# 真机 automator（#18 B 场景）

手机 ↔ C3 全链路自动回归：`miniprogram-automator`（微信开发者工具自动化端口）+ COM6
串口 JSONL 事件断言，覆盖 spec `docs/spec/test-strategy.md` §3.4 的 6 条真机场景。
**不进 CI、不重试、等人**：脚本设计为人工在场跑；人工只做扫码 + 切后台 / 断蓝牙 / 断
C3 电等物理动作 + 看灯带颜色。

## 前提环境（每次开跑前固化）

1. **微信开发者工具常驻**：打开本项目（`miniprogram/`），登录；Windows 下执行
   `cli.bat auto --project "<repo>/miniprogram" --auto-port 9420` 开启自动化端口
   （路径按实际安装位置调整；Node ≥18.20 的 Windows 上 `automator.launch()` 有
   `spawn EINVAL` 坑，本脚本只 connect，不 launch）。
2. **真机调试已启用**：工具里开启真机调试，手机扫码连接（或与本脚本 `--remote qr`
   配合，脚本会打印二维码）。手机常亮：`adb shell svc power stayon true`；蓝牙 / 定位开启。
3. **C3 已上电**：烧 #15 固件，USB 接 PC（USB CDC 为 Espressif VID `0x303A`，默认
   COM6，可用 `--port` 覆盖）；**与 PC 集成测试（tests/pc_integration）不在同一板同时跑**
   （spec §3.3 进程模型）。
4. **手机与 C3 在范围内**；开发者工具真机调试窗口保持前台可扫码状态。

## 安装

```sh
cd tests/device_automator
npm install          # miniprogram-automator + serialport（prebuilds；Node 24 实测可直接加载）
npm test             # 纯逻辑单测（无硬件，30 个：协议解码 / 断言引擎 / 场景配置 / runner）
```

## 运行

```sh
# 看场景清单 / 校验配置（无硬件）
node run.js --list
node run.js --dry-run --scenario write_effects

# 真机跑单场景（人工扫码后）
node run.js --scenario cold_start
node run.js --scenario write_effects
node run.js --scenario status_refresh
node run.js --scenario disconnect_reconnect
node run.js --scenario background_resume
node run.js --scenario failure_path

# 连跑门槛（spec §3.4：场景 1/2/4 连续 3 次全过才算过；失败即停）
node run.js --scenario cold_start --repeat 3
node run.js --scenario write_effects --repeat 3
node run.js --scenario disconnect_reconnect --repeat 3

# 常用覆盖
node run.js --scenario failure_path --port COM7         # 换串口
node run.js --scenario cold_start --remote qr           # 打印二维码重新扫码
node run.js --scenario cold_start --remote off          # 复用已建立的会话
node run.js --scenario cold_start --delta-limit-ms 800  # 慢机放宽 Δ（默认 500；连接/重连固定 5s）
```

退出码：`0` 全过 / `1` 场景断言失败（证据在 runs/）/ `2` 环境或 harness 失败（等人处理，
如扫码超时、串口打不开、`Connection closed`）。

场景中需要人工的步骤（脚本会在终端打印 `>>> [人工操作] …` 并等回车）：

| 场景 | 人工动作 |
|---|---|
| ④ disconnect_reconnect | 关手机蓝牙 → 回车；开蓝牙 → 回车（之后脚本点设备行重连） |
| ⑤ background_resume | 切后台 5 秒 → 切回 → 回车；再切后台 30 秒 → 切回 → 回车 |
| ⑥ failure_path | 断 C3 电源 → 回车；恢复供电等 C3 启动 → 回车 |

灯带颜色 / 效果观感只由人工看，脚本不机器断言颜色。

## 断言口径（spec §3.4）

| 断言面 | 用法 |
|---|---|
| `page.data` | 公开 data 子集匹配（`state` / `connected` / `deviceName` / `mask` / `selectedEffect` / `brightness` / `fullPowerUnlocked` / `helloText` / `status.*` / `log` 等）；支持 `RegExp` 与 `__op`（includes / oneOf / gte / lte） |
| `element.attribute` | 只断 disabled 等状态类（`state: disabled/enabled` 容差判断） |
| `console` | 只断领域错误出现 / 不出现（`consoleClean`：无 error 类型 + 无禁忌模式）。注：生产代码目前不把领域错误写 console（#17 的 showError 只进页面 `data.log`），故领域错误的正向断言取 `page.data.log`，console 做负向兜底——偏差已记录 |
| COM6 事件 | `rx / ack / nak / status / gap` 事件级：seq 关联（`then` 里 `seq:'rx'`）+ Δ 默认 500ms（`--delta-limit-ms`），连接 / 重连步骤固定放宽 5s |
| BLE notify | `exposeFunction('onBLEFrame')` + `evaluate` 注入第二监听器回传 hex（不给生产代码加钩子）；按 type / seq / payload 断言（HELLO / ACK / NAK / STATUS） |
| strip_mask / payload | 固件 JSONL `rx` 事件只有 type/flags/len，没有掩码与载荷字节；掩码 / 灯效逐字段断言由 STATUS `active_effect` 兜底（与 PC harness `expect_status_fields` 同口径） |

## 目录结构

```
tests/device_automator/
├── package.json            # miniprogram-automator + serialport；npm test = node --test
├── effects.json            # 7 种灯效 payload 期望（语言无关；契约测试锁定，见下）
├── run.js                  # CLI 入口（--scenario / --repeat / --remote / --port / --dry-run）
├── src/
│   ├── protocol.mjs        # 协议 v1 解码（golden vectors 校验）+ STATUS/HELLO 载荷解析
│   ├── assert.mjs          # 断言纯逻辑（deepMatch / matchProblems / matchEvent / checkDelta）
│   ├── serial.mjs          # COM6：serialport + JSONL 解析 + 事件查询（VID 0x303A 可发现）
│   ├── session.mjs         # automator 会话：connect/remote 60s 看门狗、逐调用超时、
│   │                       #   exposeFunction 注入、清残留监听、`Connection closed` 不重试
│   ├── runner.mjs          # 步骤引擎（20 种 op，data-driven；失败即停）
│   ├── scenarios.mjs       # 场景 1–6（共享 connectPrelude：reLaunch→扫描→连接→HELLO→基线）
│   └── evidence.mjs        # runs/ 取证：summary（成功）/ failure + console + COM6 + notify + 快照（失败）+ §4 提示
├── test/                   # 纯逻辑单测（node:test，无硬件）
└── runs/                   # 每次运行取证（gitignore）
```

### effects.json 契约（防手抄漂移）

`effects.json` 是页面默认参数下 7 种灯效 SET_EFFECT payload 的唯一期望表。
`miniprogram/logic/device_effects_contract.test.ts`（进默认 `npm test`）逐条对照
`encodeEffectPayload` 的输出校验字节一致——改了页面默认参数或编码器必须同步改这里。

## 失败取证（runs/，spec §4 分层定位）

```
runs/<scenario>-<UTCstamp>/
├── summary.json          # 每轮步骤结果 / Δ / 配置
├── failure.json          # 失败步骤索引 + page.data 快照 + §4 定位提示
├── console.log           # 小程序 console 捕获
├── serial_raw.log        # 原始串口（PC 收到时刻 + 原文）
├── events.jsonl          # 解析出的 JSONL 事件
├── notify_timeline.json  # BLE notify hex + 解码
└── run.log               # 脚本自身日志
```

§4 对照：串口无输出 → USB CDC / 供电；串口无 rx → BLE 空口 / 固件；rx 在但 ACK 缺 →
RSP 订阅（CCCD）；串口有帧但 page.data 错 → 小程序逻辑层；Δ 超 → 串口排空延迟 / C3 高负载。

## 已知约束 / 偏差

- **无 iOS**（spec §5）：只在安卓真机跑。
- **remote(true) 无超时**：未扫码静默等待 → 每轮 60s 看门狗（`--remote qr` 打印二维码；
  `--remote off` 复用已建会话）。
- **`Connection closed` 不重试**：脚本退出码 2，等人恢复开发者工具 / 真机调试后重跑。
- **screenshot() 不可用**（remote 下）：不做截图断言。
- **evaluate 注入的 notify 监听器**在小程序重新编译 / 重启后失效：重跑 run.js 即可
  （脚本启动时会先清残留监听再注入）。
- **console 领域错误正向断言**：生产代码不写 console（无测试钩子约束），改用
  `page.data.log`；console 只做负向兜底（见上表）。
- **场景脚本组织**：6 个设备场景的 BLE 字节期望集中在 `effects.json`（语言无关）+
  契约测试；tests/scenarios/ 的 JSON schema 是 FakeTransport 面向的 BLE-only 序列，
  设备场景的 UI / 人工步骤（切后台 / 断蓝牙 / 断 C3 电）不在其表达范围内，未强行扩展。

## 不进 CI

本目录依赖物理硬件（安卓机 + C3 + 微信开发者工具 + 人工扫码），Linux CI 不跑；
纯逻辑单测（`npm test`，无硬件）在任意机器可跑，已验证 Node v24.14.0。