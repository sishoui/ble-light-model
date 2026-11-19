# 固件工程

PlatformIO 工程，两个 env：

- `native`：host 编译与 Unity 单测，CI 跑这个。
- `esp32-c3`：ESP-IDF v5.5.3（`espressif32@6.13.0` 解析到 `framework-espidf 3.50503.0`）。

## 分层（#7 决议）

| 目录 | 内容 | 约束 |
|---|---|---|
| `proto/` | `ble_proto` 帧编解码（#10）、`effect_engine` 灯效引擎（#11） | 纯 C99、host 可编译、无动态内存 |
| `core/` | `ws2812`（RGB→GRB→RMT 符号，#13）、`scheduler`（刷新周期调度，#13）、`console`（串口测试指令解析，#13）、`scene`（场景状态迁移 + NVS blob 序列化，#14）、`gatt`（命令分发 + HELLO/STATUS/ACK/NAK 组帧，#14） | 纯 C99、**不 include IDF 头**、时间/日志注入、无动态内存、host 单测 |
| `ports/esp32/` | `rmt_driver`（双通道 RMT + simple encoder 桥接）、`rmt_switch`（切换机制可替换单元）、`led_task`（LED 任务 + NimBLE/#14 解耦点）、`nvs_store`（NVS 场景持久化 + 去抖保存，#14）、`nimble_gatt`（NimBLE GATT server，#14） | IDF v5.5.3 |
| `app/` | `app`（装配 + USB CDC 控制台 + 上电自检 + NVS 恢复 + BLE 启动） | IDF v5.5.3 |
| `src/` | `main.c` → `app_init()`；`src/CMakeLists.txt` 引用 ports/app 源 | — |

核心边界：`effect_engine` 只产逻辑 RGB；`core/ws2812` 负责 GRB/亮度缩放/符号编码；`ports` 只做硬件编排与符号桥接（符号位布局与 `rmt_symbol_word_t` 兼容，`rmt_new_simple_encoder` 回调直接拷贝，不做换算）。

## RMT 配置要点（#7 §3）

- 双通道 ch0/ch1，**各 `mem_block_symbols = 48`**（对称 48+48；C3 内存块连续分配，单通道加倍到 96 会导致第二个通道无法创建 —— 不加倍）。
- `intr_priority = 3`（LOWMED 档允许的最高值，创建后不可改）。
- 缓解包：编码回调 `RMT_ENCODER_FUNC_ATTR` + `CONFIG_RMT_ENCODER_FUNC_IN_IRAM`、`CONFIG_RMT_TX_ISR_CACHE_SAFE`（sdkconfig.defaults）。
- 通道↔灯带：ch0 → L0/2/4/6（GPIO0/3/4/5），ch1 → L1/3/5/7（GPIO1/6/7/10），#3 分配；轮 r 驱动 strip 2r/2r+1，4 轮覆盖 8 条 = 一个刷新周期（25ms 目标，40fps）。
- glitch：done 回调 `edata.num_symbols` vs 期望（1440 数据 + 1 EOF = 1441）不符累计，进 `sched_ctx_t.glitch_count`（随 STATUS 上报）。

## 切换机制（#7 §4）

默认实现方案①：单信号多引脚（GPIO Matrix），轮间只切输出使能（`gpio_set_direction` 的 INPUT/OUTPUT）。接口在 `ports/esp32/rmt_switch.h`（`rmt_switch_init/select_round/all_off`），换成方案② `rmt_tx_switch_gpio()` 只改 `rmt_switch.c` 实现，core 不感知。

## 串口测试指令（USB CDC，仅测试用，不进 BLE 协议 profile）

```
SET <mask> <effect_id> [params...]   # 例：SET ff 01 ff 00 00（全带静态红）
BRI <0-255>                          # 全局亮度
SELFTEST                             # 上电自检序列（L0→L7 逐条点亮）
?                                    # 帮助
```

每行回 `OK` / `ERR` / 事件行（`ready` / `SELFTEST`）。

## BLE GATT 布局（#14 定稿，PC/小程序共用）

| 项 | 值 |
|---|---|
| 设备名 | `BLELight-C3` |
| Service UUID | `0xFFE0`（16 位，`FFE0-0000-1000-8000-00805F9B34FB`） |
| CMD 特征 UUID | `0xFFE1`（WRITE + WRITE_NO_RSP，客户端→C3 协议帧，分片写入） |
| RSP 特征 UUID | `0xFFE2`（NOTIFY，CCCD 0x2902；C3→客户端 HELLO/ACK/NAK/STATUS） |
| MTU | 被动跟随（`CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU=256`；PC/安卓侧发起协商，payload = MTU−3） |
| 连接参数 | 连接建立后请求 50–100ms 间隔（外设侧 Connection Parameter Update） |
| 广播 | connectable undirected，断连后自动重启广播 |

行为口径：连接建立 + CCCD 订阅后 C3 主动发 HELLO（23 字节 payload：协议版本 1、fw 0.1.0、8 路 × 60 颗、max 30000mA / 默认 15000mA、thermal 70/85℃、caps=0x07、effect_bitmap 覆盖 0x00–0x06）；关键命令回 ACK（flags bit0 控制）；周期 STATUS 2s；满功率门禁（亮度 >127 / 限流 >15000 且未解锁 → NAK 0x06，解锁不持久化）；NVS `ble_light:scene` 存 last scene（ACK 后 1s 去抖保存，重启恢复，缺失/损坏全灭）；断连保持灯效继续跑。

> Windows 注意：ESP-IDF 构建要求工程路径不含非 ASCII 字符。CMake/Ninja 会以系统 ANSI 代码页写 `build.ninja`，PlatformIO 按 UTF-8 读取；路径含中文（如 `项目`）会报 `UnicodeDecodeError`。把仓库放到纯 ASCII 路径，或开启系统 UTF-8 选项。