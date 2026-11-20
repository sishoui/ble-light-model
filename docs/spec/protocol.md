# BLE 协议 v1 契约

> 状态：已定稿（对应 issue #22；基础决议来自 issue #4，本文为其落地工件）
> 适用范围：ESP32-C3 固件协议层 + 原生微信小程序逻辑层 + Python 校验工具
> 边界：本文定**帧字节布局与无线行为**。灯效是什么、逐像素怎么算，见 `docs/spec/effects.md`。
> 冲突时：灯效**语义**以 `effects.md` 为准，**字节布局**以本文为准。`effects.md` §3 的参数表在线上按本文 §6 的 RGB 布局编码（本次对账见 §14）。

本文把「字节怎么排、命令怎么走、失败了怎么退、旧固件遇到新字段怎么办」钉死到 C / TS / Python 三端可各自独立实现、并用同一批 golden 向量互相验证。

---

## 1. 帧格式

```text
AA 55 | ver(1) | seq(2) | type(1) | flags(1) | strip_mask(1) | param_len(1) | payload(N) | crc16(2)
```

| 字段 | 宽度 | 说明 |
|---|---|---|
| magic | 2 | 固定 `AA 55`。接收端以它做帧边界重同步。 |
| ver | 1 | 协议版本，v1 = `0x01`。 |
| seq | 2 | 发送方帧序号，16 位循环，小端。 |
| type | 1 | 命令类型，见 §4。 |
| flags | 1 | bit0 = 需要 ACK；其余位保留。**接收端忽略未知位，不 NAK。** |
| strip_mask | 1 | 目标灯带位图，bit i = 第 i 条；`0xFF` = 全部 8 条。 |
| param_len | 1 | payload 字节数，`0–255`。 |
| payload | N | 命令参数，见各命令。 |
| crc16 | 2 | CRC-16/CCITT-FALSE，小端，覆盖 `ver` 到 `payload` 末尾（**不含 magic**）。 |

- 多字节字段一律小端。
- 单帧最长 `9 + 255 + 2 = 266` 字节。
- CRC 参数：poly `0x1021`，init `0xFFFF`，无反射，xorout `0x0000`。
- 颜色字节为逻辑 **RGB**（见 §6）；C3 负责转 WS2812 的 GRB 发送序。

---

## 2. 序列号、ACK / NAK、超时重传、幂等

### 2.1 序列号

- 每个方向各自维护 16 位递增序号，回绕到 0 继续。
- 命令帧用发送方 seq；`ACK` 回显被确认帧的 seq；`NAK` 回显被拒帧的 seq。
- C3 主动发的 `HELLO` / `STATUS` / `SCENE` 用 C3 自己的 tx seq。
- `GET_STATUS` / `GET_SCENE` 的应答就是回执，不需要 `ACK`。

### 2.2 哪些命令要 ACK

| 需要 ACK（flags bit0=1） | 不需要 ACK |
|---|---|
| `SET_EFFECT` | `HELLO`（C3 主动） |
| | `GET_STATUS` → 回 `STATUS` |
| | `GET_SCENE` → 回 `SCENE` |
| | `STATUS` / `SCENE`（周期/应答，不 ACK） |

### 2.3 重传规则（发送端）

- 发出需 ACK 的帧后启动 **500 ms** 超时。
- 超时未收到 `ACK`/`NAK` → **整帧原样重传**，最多 **3 次**（含首发共 4 次）。
- 收到 `NAK` → **立即停止，不自动重试**，把错误上抛给 UI（UI 负责回滚与提示）。
- 收到 `ACK` → 停止计时，进入去抖持久化（§11）。

### 2.4 幂等

- 同一 `(seq, type, strip_mask, payload)` 的重复帧，接收端**重新回 ACK**，但**不重复应用**（命令应用必须幂等）。
- 重复帧判定只在「上一次已处理的 seq 窗口」内生效；序号回绕后按新帧处理。
- 因此断线重连后重发整帧是安全的。

---

## 3. BLE 分片与重组

BLE 单次写没有 API 级长度上限，但 iOS / 部分安卓超过 20 字节会静默失败，所以：

- **发送端默认按 20 字节切片**写 characteristic（20 字节 = 默认 ATT MTU 23 − 3 头）。
- 安卓协商 MTU 后，按 `getBLEMTU() − 3` 切片；iOS 用系统值。**MTU 只被动跟随**，不主动 `setBLEMTU` 强制。
- 分片**没有分片头**：接收端靠 magic + `param_len` + CRC 重组整帧。
- 接收端在缓冲区里累积字节；凑够一帧（`9 + param_len + 2`）且 CRC 通过即交付。
- **半帧超时 200 ms**：超过 200 ms 未凑齐，丢弃已累积字节，静默丢弃**不发 NAK**。
- 累积中遇到新的 `AA 55`：视为上一帧残片，丢弃并从新 magic 重新开始。
- 粘包：一次读入含多帧时，逐帧切分并逐帧交付（见 §13 `feed/coalesced`）。

> 发送端下一帧必须等上一帧的 ACK/NAK 或超时之后才发（或等上一帧的回报），避免在途多帧互相踩序号。

---

## 4. 指令集

| type | 名称 | 方向 | 需要 ACK | payload |
|---|---|---|---|---|
| `0x01` | 握手 `HELLO` | C3 → 客户端 | 否 | 见 §5 |
| `0x02` | 设置灯效 `SET_EFFECT` | 客户端 → C3 | 是 | `effect_id(1) + params`，见 §6 |
| `0x03` | 保留 | — | — | 勿用（原全局亮度，已按 ADR-0001 移除） |
| `0x04` | 保留 | — | — | 勿用（原限流，已移除） |
| `0x05` | 保留 | — | — | 勿用（原满功率解锁，已移除） |
| `0x06` | 获取状态 `GET_STATUS` | 客户端 → C3 | 否 | 空；C3 回 `STATUS` |
| `0x07` | 确认 `ACK` | C3 → 客户端 | 否 | `ack_seq(2)` |
| `0x08` | 否定 `NAK` | C3 → 客户端 | 否 | `nak_seq(2) + error(1)` |
| `0x09` | 状态 `STATUS` | C3 → 客户端 | 否 | 见 §7；周期 notify |
| `0x0A` | 获取场景 `GET_SCENE` | 客户端 → C3 | 否 | 空；C3 回 `SCENE` |
| `0x0B` | 场景 `SCENE` | C3 → 客户端 | 否 | 见 §8；`GET_SCENE` 应答 |
| `0x0C–0xFF` | 未来扩展 | — | — | 旧端收到未知 type → `NAK 0x02` |

- `SET_EFFECT` 的 `strip_mask` 选择目标灯带；某条未选中的灯带保持原灯效。
- 要让多条跑不同灯效，分帧逐条下发（`strip_mask` 单 bit）。
- 本轮**没有**全局亮度、限流、解锁、定时、场景收藏命令：亮度随效果参数走（§6），物理安全不归固件兜底（ADR-0001）。

---

## 5. HELLO 握手与能力

BLE 连接建立后，C3 主动发一次 `HELLO`（flags=0，不需 ACK）。

payload（23 字节）：

```text
ver(1)=1, fw_major(1), fw_minor(1), fw_patch(1),
strip_count(1)=8, leds_per_strip(1)=100,
caps(1), effect_bitmap[16]
```

- `caps`：bit0 = 支持 `GET_SCENE`；bit1 = 支持场景持久化；bit2 = `effect_bitmap` 有效；其余保留（0）。
- `effect_bitmap`：16 字节位图，覆盖 `effect_id 0–127`。`effect_id = e` 支持 ⇔ `effect_bitmap[e>>3] & (1<<(e&7))` 非零。`0x80–0xFF` 保留，不置位。
- 客户端按 `effect_bitmap` 决定可选灯效；不支持的灯效**不应下发**（下发会被 `NAK 0x03`）。
- 客户端未收到 `HELLO` 时不得擅自假设能力，等 `HELLO` 或用 `GET_STATUS` 探活。

---

## 6. 灯效参数布局（RGB）

`SET_EFFECT` payload = `effect_id(1) + 参数`。颜色为逻辑 **R,G,B**（各 0–255），亮度体现在 RGB 幅度里，**没有独立的亮度字段**。

| id | 名称 | 参数（顺序即编码） | 字节数 |
|---|---|---|---|
| `0x00` | 关灯 OFF | 无 | 0 |
| `0x01` | 静态 STATIC | `R, G, B` | 3 |
| `0x02` | 呼吸 BREATH | `R, G, B, period_ms(2, LE), min(1), max(1)` | 7 |
| `0x03` | 渐变 GRADIENT | `R1,G1,B1, R2,G2,B2, period_ms(2, LE), direction(1)` | 10 |
| `0x04` | 彩虹 RAINBOW | `speed(1), saturation(1), direction(1)` | 3 |
| `0x05` | 流水 FLOW | `R,G,B, speed(1), length(1), direction(1)` | 7 |
| `0x06` | 星闪 SPARKLE | `R,G,B, density(1), speed(1)` | 5 |

规则：

- `direction`：`0` 正向（索引增大），`1` 反向；其它值按 `0` 处理。
- `period_ms = 0` 或 `speed = 0` ⇒ **画面冻结**（停在相位 0 那帧）；与 `effects.md` 的“`speed=0` 冻结”一致。
- `min ≤ max`（呼吸），否则 `NAK 0x05`。
- `length ≥ 1`（流水），`0` 按 `1` 处理（不报错）。
- `param_len` 兼容：**`param_len ≥ 期望字节数` 接受，多余字节忽略**；短于期望值 → `NAK 0x04`。
- `0x07–0x7F` 预留，`0x80–0xFF` 调试；未在 `effect_bitmap` 中的 id → `NAK 0x03`。
- `0x00` 是合法 `effect_id`（关灯），不是“无操作”。

---

## 7. STATUS

`STATUS` payload（17 字节），周期 notify（每 2 s 或状态变化时），不 ACK：

```text
uptime_s(4, LE), glitch_count(2, LE), drop_count(2, LE),
strip_fault(1), active_effect[8]
```

| 字段 | 含义 |
|---|---|
| `uptime_s` | 开机秒数，`uint32`。 |
| `glitch_count` | 驱动层补数/切换异常计数（诊断用）。 |
| `drop_count` | 因半帧超时丢弃的接收帧计数。 |
| `strip_fault` | bit i = 第 i 条灯带故障（数据线无响应等）。 |
| `active_effect[i]` | 第 i 条当前 `effect_id`（不含参数）。 |

- v1 **不**上报电流、电压、温度、亮度、限流：无电流估算/温控（ADR-0001）。
- 需要每条完整参数时用 `GET_SCENE`（§8），不要指望 `STATUS`。

---

## 8. GET_SCENE / SCENE

`GET_SCENE`（type `0x0A`，空 payload）→ C3 回 `SCENE`（type `0x0B`）。用于重连回读全量场景。

`SCENE` payload：

```text
strip_count(1)=8,
重复 8 次: effect_id(1), param_len(1), params(param_len)
```

- `param_len` 为该路效果参数长度（按 §6）；`param_len = 0` 表示关灯。
- 单帧最大：`1 + 8 × (2 + 10) = 97` 字节，远低于 255，无需二次分片（除 BLE 20 字节切片外）。
- `SCENE` 不 ACK；客户端据此覆盖本地缓存。
- 重连流程：先 `GET_SCENE` 覆盖本地，再恢复正常交互。

---

## 9. 错误码（NAK error）

| code | 含义 | 触发 |
|---|---|---|
| `0x01` | CRC 错 | 帧 CRC 不匹配 |
| `0x02` | 未知 type | type 不在 §4 定义内 |
| `0x03` | 未知灯效 | `effect_id` 未在 `effect_bitmap` |
| `0x04` | 长度不符 | `param_len` 小于该命令/灯效的期望值 |
| `0x05` | 参数非法 | 如呼吸 `min > max` |
| `0x06` | 保留 | 原“未解锁”，已随 ADR-0001 移除 |
| `0x07` | 忙 | 暂时无法处理，稍后重试 |
| `0x08` | 协议版本不支持 | `ver ≠ 1` |

- NAK 是诊断信号：接收端报错，发送端**不自动重试**，由上层决定。
- CRC 错 / 未知 type / 版本不支持后，接收端从下一个 magic 重新同步。

---

## 10. 版本兼容策略

v1 的向前兼容手段（旧固件遇到新东西时**忽略而非崩溃**）：

1. **保留位**：`flags` 未定义位、`caps` 未定义位一律忽略，不 NAK。
2. **参数追加**：给已有灯效追加参数时，老固件按 `param_len ≥ 期望值接受、忽略多余字节`；新固件对老帧（短）报 `NAK 0x04`。
3. **新命令**：用 `0x0C+` 新 type；老固件回 `NAK 0x02`，客户端据此降级。
4. **能力发现**：`HELLO.caps` + `effect_bitmap` 在连接时广播，客户端不猜。
5. **持久化**：NVS scene 带 `scene_version + length`，旧固件遇未知版本按“无记录”处理（全关），不解析错位。
6. **版本不兼容**：`ver` 只做等值检查；`ver ≠ 1` 一律 `NAK 0x08`。要破坏性改动就开 v2，不在 v1 里硬塞。

---

## 11. 持久化

- NVS blob 键：`ble_light:scene`。
- 格式：`scene_version(1) + length(2, LE) + payload`；payload 同 §8 的 `SCENE` payload（每路 `effect_id + param_len + params`）。
- 写入时机：收到 `SET_EFFECT` 的 `ACK` 后起 **1 s 去抖**；期间再收到命令则重新计时；到点写一次。**动画帧不进 NVS。**
- 启动：加载并继续跑；缺失 / `scene_version` 不支持 / `length` 不符 / 校验失败 → 8 条全关。
- 断连：C3 保持当前灯效继续跑，不灭、不重置。
- 无“保存”按钮：每次操作即时下发、即时生效、去抖落盘。

---

## 12. 平台无关层与三端实现

- 固件：`firmware/proto/` 纯 **C99**，不依赖 Arduino / ESP-IDF，不用动态内存；`ble_proto_encode` / `ble_proto_feed` 只负责帧、分片、CRC、seq、ACK/NAK 状态机。效果引擎单独放 `effect_engine.c`，协议层不认识具体灯效。
- 小程序：`miniprogram/logic/codec.ts` 手写镜像；纯函数 `encode(cmd): Uint8Array`、`feed(bytes): Event[]`，不感知传输层。
- Python：`tests/protocol/` 下的校验工具，读取同一份 `vectors.json` 独立复算。
- **单一事实源**：`tests/protocol/vectors.json` + 本文。三端跑同一批向量，字节必须逐一致。
- `tests/protocol/generate_vectors.mjs` 是**向量的定义工具**（生成 `vectors.json`），不是生产 codec；`vectors.json` 视为生成物，勿手改。

> 测试策略与无手机回归见 `docs/spec/test-strategy.md`（后续 spec）。

---

## 13. golden 向量清单

生成：`node tests/protocol/generate_vectors.mjs > tests/protocol/vectors.json`。
`expect` 的 `naks` 为该端必须回发的 NAK 整帧字节；`frames` 为解析出的帧；`reply` 为必须生成的应答。

### 13.1 encode（固定输入 → 期望整帧字节）

| 向量 | 长度 | 期望字节（hex） | 说明 |
|---|---|---|---|
| encode/set_effect_static_off | 12B | `aa 55 01 00 00 02 01 01 01 00 db 40` | strip0 关灯，seq=0，需 ACK |
| encode/set_effect_static_white | 15B | `aa 55 01 01 00 02 01 ff 04 01 ff ff ff a5 2d` | 全条静态白，seq=1 |
| encode/set_effect_breath | 19B | `aa 55 01 34 12 02 01 03 08 02 ff 00 00 e8 03 00 ff 1d f0` | strip0-1 呼吸红，period=1000ms，seq=0x1234 |
| encode/set_effect_gradient | 21B | `aa 55 01 02 00 02 01 0f 0a 03 ff 00 00 00 00 ff e8 03 00 8a 1f` | 红→蓝渐变，period=1000ms |
| encode/set_effect_rainbow | 15B | `aa 55 01 03 00 02 01 f0 04 04 ff ff 00 99 94` | strip4-7 彩虹，speed=255,sat=255,dir=0 |
| encode/set_effect_flow | 18B | `aa 55 01 04 00 02 01 10 07 05 ff 00 00 80 10 00 87 99` | 流水红，speed=128,length=16,dir=0 |
| encode/set_effect_sparkle | 17B | `aa 55 01 05 00 02 01 20 06 06 ff ff ff 20 40 86 91` | 星闪白，density=32,speed=64 |
| encode/get_status | 11B | `aa 55 01 06 00 06 00 00 00 d7 e3` | GET_STATUS，seq=6，flags=0 |
| encode/get_scene | 11B | `aa 55 01 07 00 0a 00 00 00 45 e9` | GET_SCENE，seq=7，flags=0 |
| encode/ack | 13B | `aa 55 01 08 00 07 00 00 02 34 12 88 b0` | ACK 回显 seq=0x1234 |
| encode/nak_unknown_effect | 14B | `aa 55 01 34 12 08 00 00 03 34 12 03 e5 10` | NAK seq=0x1234 error=0x03 |
| encode/hello | 34B | `aa 55 01 00 00 01 00 00 17 01 00 01 00 08 64 07 7f 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 c0 cf` | HELLO 23B：ver,fw0.1.0,8条,100颗,caps=0x07,effect_bitmap=0x7F |
| encode/status | 28B | `aa 55 01 01 00 09 00 00 11 10 00 00 00 00 00 00 00 00 00 01 00 02 00 03 00 00 7f 1e` | STATUS 17B |
| encode/scene | 66B | `aa 55 01 02 00 0b 00 00 37 08 00 00 01 03 ff 40 20 02 07 02 ff 00 00 e8 03 00 ff 03 0a 03 ff 00 00 00 00 ff e8 03 00 04 03 04 ff ff 00 05 07 05 ff 00 00 80 10 00 06 05 06 ff ff ff 20 40 00 00 98 89` | SCENE 全量回读，8 条 |
| encode/param_len_255 | 266B | `aa 55 01 09 00 02 01 ff ff` + 255×`5a` + crc `38 44` | 最大 payload 255，整帧 266 |
| encode/fragment_20 | 19B | `aa 55 01 34 12 02 01 03 08 02 ff 00 00 e8 03 00 ff 1d f0` | 与 breath 同帧，另含按 20 字节切片的 `chunks`（19B < 20，单块） |
| encode/fragment_60 | 51B | `aa 55 01 00 20 02 01 ff 28 40 41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50 51 52 53 54 55 56 57 58 59 5a 5b 5c 5d 5e 5f 60 61 62 63 64 65 66 67 0b 62` | 40B payload → 整帧 51B，`chunks` 按 20B 切为 **20/20/11 三块**（真实多块拆分） |
| encode/fragment_boundary_19 | 19B | `aa 55 01 00 30 02 01 ff 08 00 01 02 03 04 05 06 07 08 67` | 8B payload → 19B，1 块（<20） |
| encode/fragment_boundary_20 | 20B | `aa 55 01 01 30 02 01 ff 09 00 01 02 03 04 05 06 07 08 f0 54` | 9B payload → 20B，恰 1 个 20B 块 |
| encode/fragment_boundary_21 | 21B | `aa 55 01 02 30 02 01 ff 0a 00 01 02 03 04 05 06 07 08 09 ef eb` | 10B payload → 21B，`chunks` 20/1 跨 20B 边界 |

### 13.2 feed（字节流 → 帧 / NAK / 丢弃）

| 向量 | 输入（chunks） | 期望 |
|---|---|---|
| feed/normal | `aa 55 01 10 00 02 01 01 04 01 ff ff ff 69 c7` | frames=1；ACK seq=0x0010 |
| feed/fragmented | `aa 55 01 11 00 02 01 01 08 02 ff 00 00 e8 03 00 ff ee a9` | frames=1；ACK seq=0x0011（19B 帧 < 20，单块） |
| feed/coalesced | `aa 55 01 12 00 02 01 01 00 02 31 aa 55 01 13 00 02 01 01 04 01 ff ff ff a6 76` | frames=2；ACK 0x0012, ACK 0x0013 |
| feed/fragment_60_reassembly | `aa 55 01 1f 00 02 01 ff 28 40 41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50 51 52 53 54 55 56 57 58 59 5a 5b 5c 5d 5e 5f 60 61 62 63 64 65 66 67 2b 06` | frames=1；ACK seq=0x001f（51B 帧按 **20/20/11 三块**逐个喂入重组） |
| feed/fragment_boundary_21 | `aa 55 01 22 00 02 01 ff 0a 00 01 02 03 04 05 06 07 08 09 65 7e` | frames=1；ACK seq=0x0022（21B 帧 20/1 跨边界喂入重组） |
| feed/coalesced_multiframe | `aa 55 01 20 00 02 01 ff 28 40 41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50 51 52 53 54 55 56 57 58 59 5a 5b 5c 5d 5e 5f 60 61 62 63 64 65 66 67 a4 08` + `aa 55 01 21 00 02 01 ff 28 80 81 82 83 84 85 86 87 88 89 8a 8b 8c 8d 8e 8f 90 91 92 93 94 95 96 97 98 99 9a 9b 9c 9d 9e 9f a0 a1 a2 a3 a4 a5 a6 a7 98 71` | frames=2；ACK 0x0020, ACK 0x0021（两条 51B 帧连段喂入，粘包切两帧，跨 20B 边界） |
| feed/crc_error | `aa 55 01 14 00 02 01 01 04 01 ff ff ff 5c 95` | NAK `aa 55 01 14 00 08 00 00 03 14 00 01 9e c6` |
| feed/unknown_type | `aa 55 01 15 00 7f 00 01 00 80 b5` | NAK `aa 55 01 15 00 08 00 00 03 15 00 02 ee 2a` |
| feed/unknown_effect | `aa 55 01 16 00 02 01 01 03 7f 00 00 fd 67` | NAK `aa 55 01 16 00 08 00 00 03 16 00 03 db 4e` |
| feed/param_len_short | `aa 55 01 17 00 02 01 01 03 02 ff 00 78 15` | NAK `aa 55 01 17 00 08 00 00 03 17 00 04 2f e2` |
| feed/param_len_over | `aa 55 01 18 00 02 01 01 06 01 ff 00 00 aa bb c2 69` | frames=1；ACK seq=0x0018（多余 0xAA 0xBB 忽略） |
| feed/version_bad | `aa 55 02 19 00 02 01 01 04 01 ff ff ff 9d 9a` | NAK `aa 55 01 19 00 08 00 00 03 19 00 08 d5 4b` |
| feed/half_frame_timeout | `aa 55 01 1a 00 02 01 01 08 02` | 200ms 未凑齐 → 丢弃，不发 NAK |
| feed/duplicate_seq | `aa 55 01 1b 00 02 01 01 04 01 ff ff ff ed 3c` ×2 | frames=1；重发回 ACK，不重复应用 |
| feed/get_status | `aa 55 01 1c 00 06 00 00 00 51 7f` | frames=1；生成 STATUS |
| feed/get_scene | `aa 55 01 1d 00 0a 00 00 00 c3 75` | frames=1；生成 SCENE |
| feed/bad_param | `aa 55 01 1e 00 02 01 01 08 02 ff 00 00 64 00 80 20 d3 d8` | NAK `aa 55 01 1e 00 08 00 00 03 1e 00 05 43 ae` |

> 覆盖：正常帧、分片（含 51B 多块重组、21B 跨边界）、粘包（含两条 >20B 帧连段切两帧）、CRC 错、seq 重复、未知 type、未知灯效、param_len 过长/过短、版本错、半帧丢弃、非法参数、GET_STATUS/GET_SCENE 应答。

---

## 14. 与 `effects.md` 的对账（本次消除的冲突）

`effects.md`（#21，master）与 #4 旧协议之间存在三处不一致，v1 定稿按下列裁决收敛：

1. **颜色参数编码**：改为**以本文 RGB 布局为准**（#4 + 已实现向量口径）。`effects.md` §3 表里的 `h,s,b` / `h,s` 在**线上**一律按本文 §6 的 `R,G,B` 传递；灯效逐像素**算法**仍按 `effects.md` §6，固件把收到的 `R,G,B` 作为该效果的基色，`effects.md` 里的 `hsv(h,s,v)` 仅作引擎内部推导（彩虹的色相环在固件内部生成）。
2. **回读全量场景**：新增 `GET_SCENE` / `SCENE`（§8），补齐 `effects.md` §10.3 要求的“重连能拿到每条完整 effect_id + params”；`STATUS` 仍只带 `active_effect[8]`。
3. **全局亮度 / 限流 / 解锁**：按 `docs/adr/0001` 与 #21 决策**移除** `SET_BRIGHTNESS` / `SET_POWER_LIMIT` / `UNLOCK_FULL_POWER`（及 HELLO/STATUS 里的电流温度字段），亮度只随效果参数走。

> 后续应同步修订 `effects.md` §3 与 §6 的记号，使两文读起来一致；本次不改其算法语义。

---

## 15. 验收

- [ ] 三端（C99 / TS / Python）各自实现 `encode` / `feed`，对 `tests/protocol/vectors.json` 全部 29+ 条向量逐字节一致。
- [ ] CRC-16/CCITT-FALSE（poly 0x1021, init 0xFFFF）三端一致。
- [ ] 分片：默认 20 字节切片、安卓 MTU−3、无分片头、200 ms 半帧丢弃不 NAK。
- [ ] 粘包逐帧交付；重发同 seq 回 ACK 不重复应用。
- [ ] 未知 type / 未知灯效 / 长度不符 / 非法参数 / 版本错分别回 `0x02/0x03/0x04/0x05/0x08`。
- [ ] `GET_SCENE` 能取回 8 条完整 `effect_id + params`；`SCENE` 可被 C3 自身与三端解析。
- [ ] 需 ACK 命令 500 ms 超时、最多重传 3 次；NAK 不自动重试。
- [ ] 收到 ACK 后 1 s 去抖写 NVS；重启恢复；缺失/版本错全关。

---

## 16. GATT 承载

帧在 BLE 上的落点（客户端实现见 `docs/spec/miniprogram.md` §4）：

| 项 | 值 |
|---|---|
| 服务 UUID | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| CMD 特征（客户端 → C3） | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`，属性 `write` + `writeWithoutResponse` |
| RSP 特征（C3 → 客户端） | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`，属性 `notify`，必须有 CCCD `0x2902` |
| 广播名 | `BLE-Light-` + MAC 后 4 位（大写 hex） |
| 广播内容 | connectable undirected；带服务 UUID；断连后重新广播 |

- 客户端发现服务后必须校验两个特征都存在；缺失按致命错误处理，不降级。
- 写：整帧按 §3 切片后逐包写入 CMD。不要求 write-with-response（协议 ACK 兜底），平台可用默认写类型；每次写的数据长度不超过（协商 MTU − 3）。
- 通知：C3 只从 RSP 发；客户端必须先完成订阅再开始写。HELLO 可能在 BLE 连接后立刻到达，订阅必须发生在连接流程内，不能等页面加载完。
- MTU：仅作传输上限，C3 配置 `CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU`（建议 256），Windows 中心自动协商；**客户端不主动 `setBLEMTU`**（§3）。
- CCCD 兼容：容忍 Windows 重连后写 `0x0080`；重连后重新订阅（NimBLE 已知问题），不依赖上次订阅状态。
- 调试期改动 GATT 布局后，Windows 侧需删除/重新配对设备以清服务缓存。
