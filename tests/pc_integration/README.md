# PC 集成测试（#15）

PC 当 BLE 中心直连 C3 做日常回归：发指令 → 读 COM 串口 JSONL 事件日志 →
订阅 RSP notify → 两侧交叉断言（spec `docs/spec/test-strategy.md` §3.3）。
**不进 CI**（依赖物理 C3 + PC 蓝牙适配器）。

## 工具链与安装

需要 Python 3.12（本机已备 3.12.10）。首次：

```sh
cd tests/pc_integration
py -3.12 -m venv .venv            # 或 python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
```

（Windows；Linux/macOS 用 `bin/python`。`.venv/` 与 `runs/` 已 gitignore，
`requirements.txt` 入库。）

## 快速开始

```sh
# 1) 无硬件部分（默认）：协议 golden 向量 + harness fake 逻辑测试
.venv/Scripts/python.exe -m pytest

# 2) 真 C3 全量（需要硬件）
.venv/Scripts/python.exe -m pytest -m hardware

# 3) 真 C3 <1min 冒烟子集
.venv/Scripts/python.exe -m pytest -m smoke
.venv/Scripts/python.exe smoke.py          # 等价独立脚本
```

真机先决条件：

- C3 已烧 #15 固件并上电（断连/重启后会自动重启广播）；
- PC 蓝牙适配器开启（Windows 同时只支持一个活动 radio，勿插第二个）；
- C3 的 USB CDC 在设备管理器可见（Espressif VID `0x303A`，Win10/11 由
  `usbser` 自动枚举为 COM 口）——**不硬编码 COM6**，按 VID/PID 自动发现，
  发现多个 Espressif 串口时可用 `HarnessConfig.port_name` 覆盖；
- 改过 GATT 布局的旧缓存：PC 上删除/忘记该蓝牙设备可清系统服务缓存
  （research/pc-ble-central.md §6）。

## 目录结构

```
tests/pc_integration/
├── pytest.ini               # addopts=-m "not hardware"；markers 声明
├── requirements.txt         # bleak / pyserial / pytest
├── pc_protocol.py           # 协议 v1 Python 复刻（encode/feed/payload 解析）
├── serial_log.py            # 串口：VID/PID 发现、DTR 复位、行读取、事件查询
├── ble_link.py              # bleak 封装：扫描/连接/订阅/写、notify 时间线
├── checks.py                # 交叉断言纯逻辑（seq 关联 + Δ + 两侧记账）
├── harness.py               # 编排：startup 确定性前置、步骤、run 目录取证
├── scenario.py              # 场景脚本（basic 全量 / smoke <1min）
├── fakes.py                 # 测试替身（FakeClock/FakeSerial/fake bleak/设备脚本）
├── test_protocol_vectors.py # golden 向量（tests/protocol/vectors.json，默认跑）
├── test_checks.py           # 交叉断言逻辑单测（默认跑）
├── test_harness_fakes.py    # harness 集成（fake，默认跑）
├── test_pc_integration.py   # 真机用例（@pytest.mark.hardware）
├── smoke.py                 # <1min 独立冒烟脚本
└── runs/                    # 每次运行的取证目录（gitignore）
```

## GATT / 串口接入参数（#14 定稿）

| 项 | 值 |
|---|---|
| 设备名 | `BLELight-C3` |
| Service | `0xFFE0`（`0000ffe0-0000-1000-8000-00805f9b34fb`） |
| CMD 写 | `0xFFE1`，write-without-rsp（`response=False`） |
| RSP notify | `0xFFE2`，CCCD 由 `start_notify` 使能 |
| MTU | 被动跟随（PC WinRT 自动协商；`mtu_size` 仅诊断，帧长 <20B 无需分片） |
| 串口 | USB CDC，波特率 115200（仅参数位，CDC 实际不受波特率影响） |
| 端口发现 | `serial.tools.list_ports` 按 VID=`0x303A`（Espressif）枚举；多设备报错要求 `HarnessConfig.port_name` 覆盖 |
| DTR 复位 | 打开串口后：`setDTR(False)` → 100ms → `setDTR(True)`（复位脉冲 100ms）→ `setDTR(False)` → 清输入缓冲 → 等启动日志 |

## JSONL 事件 schema（固件侧，ports/esp32/event_log_port.c）

每行一条 JSON（USB CDC，与 ESP_LOG* 文本混流——PC 侧解析失败的行按原始
日志保留，不影响断言）：

| ev | 字段（除通用 `t_ms` / `seq`） | 触发点 |
|---|---|---|
| `boot` | `fw` | 上电装配完成 |
| `gap` | `what`=connect/disconnect/subscribe/mtu（+ `reason`/`notify`/`mtu`） | GAP 事件 |
| `rx` | `type` `flags` `len` | CMD 帧解出（`seq` = 帧序号，Δ 计时锚） |
| `ack` | — | ACK notify 发出（`seq` 回显） |
| `nak` | `err` | NAK notify 发出（`seq` 回显 + NAK 码） |
| `status` | `brightness` `glitch` `drop` | STATUS 帧发出（`seq` = 触发帧序号，周期 STATUS 为 0） |
| `nvs` | `op`=save `rc` | NVS 场景保存完成 |
| `drop` | `reason`=feed_overflow/parse（+`err`） | 协议层丢帧 |
| `glitch` | `count` | 调度 glitch 累计值变化 |

通用字段：`t_ms`（C3 单调毫秒，仅供 PC 排序日志，**不作跨机断言基准**）、
`seq`（关联键；无关联帧的事件为 0）。定长缓冲（单行 ≤160B、环 8 行，
无动态内存；超长丢行、满则丢最旧并计数）。

## 交叉断言口径（checks.py）

- **关联键**：PC 分配发送帧 `seq`（回显进 ACK/NAK/STATUS 事件与 notify）；
- **Δ 时序**：写 BLE 前记 `time.monotonic()` t0，串口同 seq 首条事件
  `Δ = ts − t0`，断言 `< 500ms`（默认）；连接/重连步骤放宽 **5s**；
  慢机/高 RMT 负载可配置 `delta_limit_ms=1000`；
- **两侧记账**（expect=ack）：ACK notify（空口）+ RX/ACK 事件（串口）
  必须同时存在；单侧缺失报具体矛盾——
  - RX 在、ACK 缺 → "固件动作了但 ACK 没发"（查 RSP 订阅/CCCD）；
  - ACK 在、RX 缺 → "ACK 说成功但固件没收到帧"；
  - ACK 两侧齐全但后续 STATUS 灯效不符 → "ACK 说成功但固件没动作"（场景级，
    SET_EFFECT 后紧跟 GET_STATUS 比对 active_effect）；
- **expect=status**：STATUS notify 与 STATUS 事件按 `brightness/glitch/drop`
  内容配对（周期 STATUS 与 GET_STATUS 交错也能配对），并可断言 payload 字段
  （`active_effect` 等）；
- **expect=error**：NAK notify 与 NAK 事件的 `(seq, err)` 完全一致。

## 失败取证（run 目录）

每次跑落 `runs/<UTC时间戳>/`（时间戳命名，gitignore）：

| 文件 | 内容 |
|---|---|
| `serial_raw.log` | 原始串口（PC 收到时刻 + wall 时间 + 原文，含 ESP_LOG* 行） |
| `events.jsonl` | 解析出的 JSONL 事件（含 PC 收到时刻） |
| `notify_timeline.json` | BLE notify 时间线（原始 hex + 解出的帧） |
| `summary.json` | 成功：每步结果 / Δ / 配置 |
| `failure.json` | 失败：失败步骤索引 + 步骤明细 + §4 分层定位提示 |

失败定位（spec §4 口径）：串口无任何输出 → USB CDC/DTR；串口有输出但无
RX 事件 → BLE 空口/固件；RX 在但 ACK 缺 → RSP 订阅/CCCD；两侧都有但
STATUS 字段不一致 → 固件组帧/状态机。原始串口 + BLE 时间线两份独立证据对照。

## Windows 备注（research/pc-ble-central.md）

- bleak 用 WinRT 后端（纯 pip 无原生编译）；Win11 为 tier-1，Win10 实测可用；
- Windows 自动请求大 MTU，应用不可设——C3 侧被动跟随，帧长 <20B 不受影响；
- 重连时 Windows 可能往 CCCD 写 `0x80`（NimBLE-Arduino #850）——固件已按
  `cur_notify` 语义位规范化，PC 侧照常 `start_notify`；
- Windows 蓝牙栈同时只支持一个活动 radio——harness 只连一个 C3；
- 服务缓存：改过 GATT 布局后在系统蓝牙设置里删除设备可强制刷新。

## 不进 CI

本目录全部依赖物理硬件（BLE 适配器 + C3），Linux CI 不跑；无硬件可跑项
（协议 golden 向量、harness fake 逻辑）已并入默认 `pytest`，可在任何机器
验证 codec 与 harness 逻辑。