# 驱动调度与刷新策略

> 状态：已定稿（对应 issue #24；硬约束来自 issue #23 的 RMT 事实核查）
> 适用范围：ESP32-C3 固件驱动层 `firmware/driver/` + 灯效引擎 `firmware/effects/` + host 单测
> 边界：本文定**什么时候把哪一条的哪一帧送到哪个引脚**。像素值怎么算见 `docs/spec/effects.md`，帧字节怎么排见 `docs/spec/protocol.md`。

把「8 条灯带在 2 个 RMT 通道上怎么调度、什么时候可以偷懒不刷、切换怎么做、30 µs 怎么保、代码怎么分层」钉死到可以直接开写、且 core 能脱离硬件在 host 上跑单测。

---

## 0. 硬约束与命名

### 0.1 引脚 / 通道 / 槽位（固定表）

| 灯带 | GPIO | RMT 通道 | 槽位 |
|---|---|---|---|
| 0 | 0 | A（TX0） | 0 |
| 1 | 1 | A | 1 |
| 2 | 3 | A | 2 |
| 3 | 4 | A | 3 |
| 4 | 5 | B（TX1） | 0 |
| 5 | 6 | B | 1 |
| 6 | 7 | B | 2 |
| 7 | 10 | B | 3 |

槽位 `k` 的两条（灯带 `k` 与灯带 `k+4`）**同时**开始发送。通道归属由引脚决定，不可运行时改派。

### 0.2 命名

| 词 | 含义 |
|---|---|
| 帧 | 一条灯带一次完整送数：100 颗 × 24 bit = **2400 symbol**。 |
| 帧周期 | 同一条灯带两次发送之间的最小间隔；**上限 12.5 ms**（= 80 Hz）。 |
| 槽位 | 通道内 4 条灯带的固定位置 0–3，决定串行顺序。 |
| 活动条 | 输出随 `t_ms` 变化的灯带，按帧周期持续重绘。 |
| 静态条 | 输出不随时间变化（静态/冻结/关灯）的灯带，只在心跳或脏重绘时发送。 |
| 心跳 | 静态条为纠错自愈而做的低频重发，**200 ms** 一次。 |
| 补数窗口 | RMT ping-pong 半区 = **24 symbol / 30 µs**；一帧需补数 100 次。 |

### 0.3 不可协商的硬约束（来自 #23）

- 单条 3.000 ms（2400 × 1.25 µs）；两通道 4+4 一轮 12.0–12.4 ms → **80–82 Hz**，上限 83.3 Hz。
- **验收底线 60 Hz（16.67 ms）**，76 Hz 只是参考。
- 补数窗口 30 µs，两通道时无法加大；无 DMA。必须预编码 + `copy_encoder`。
- `CONFIG_RMT_TX_ISR_CACHE_SAFE=y` 必须开；`intr_priority = 3`。
- `rmt_tx_switch_gpio` 只能在通道 `rmt_disable()` 的 INIT 态调用。

---

## 1. 刷新模型与调度伪代码

### 1.1 结论：按需重绘 + 心跳

不采用「固定轮转全 8 条」。8 条全静态时固定轮转仍要 98% 的 RMT 时间、约 6.4 万次/秒补数 ISR；而本项目唯一无法量化的致命风险正是 BLE 临界区撕开 30 µs，ISR 越密越危险。按需重绘让「设好颜色就不动」这一最常见状态把 RMT 压到近乎静默。

三类发送动机，互相独立：

| 动机 | 触发 | 周期 |
|---|---|---|
| 周期重绘 | 活动条 | 12.5 ms 上限（≤80 Hz） |
| 脏重绘 | `SET_EFFECT` 到达（任何灯带） | 立即，下一个发送机会 |
| 心跳 | 静态条 | 200 ms |

### 1.2 活动 / 静态判定

由灯效层回答（它才知道参数布局），驱动不解析 `params`：

```
effect_is_time_varying(effect_id, params):
  OFF(0x00)                       -> false   # 根本不发（见 §1.3）
  STATIC(0x01)                    -> false
  BREATH/GRADIENT/RAINBOW/
  FLOW/SPARKLE                    -> speed > 0
```

- `speed = 0` 一律按静态处理：相位恒为 0（`effects.md` §4.2），画面本来就冻结。
- 例外：呼吸 `min == max` 时理论上也静态，仍按活动处理（不做额外优化）。
- 静态条在心跳时重新渲染，因相位恒定，输出与首次逐字节相同 —— **心跳不产生可见跳变**。心跳的价值是纠错自愈：某帧被噪声破坏后，最迟 200 ms 内被正确的同一帧覆盖。
- 心跳不是「WS2812 需要定期送数才不灭」：WS2812 是锁存显示，不送数也保持。别把心跳当显示前提。

### 1.3 关灯（OFF）

`effect_id = 0x00`：**立即发一帧全黑，然后该条进入 IDLE，不再发送**（`effects.md` §6.2）。IDLE 条不参与心跳、不参与周期、不进调度候选。再次收到非 OFF 配置 → 按 §1.2 重新分类并置脏。

### 1.4 帧周期与帧率

- 活动条：`period = 12.5 ms`。这是**上限**，不是目标：4 条同通道时自然排成 0/3/6/9 ms 的阶梯，每条自身仍 12.5 ms 一次。
- 静态条：`period = 200 ms`。
- 单条或少量活动时**不加速**（不因为「反正闲着」就超 80 Hz），保证 ISR 负载与 BLE 共存余量可预测。
- 最坏情形（8 条全活动）= 每通道 4 帧 × 3.0 ms ≈ 12.0–12.2 ms → 80–82 Hz，仍在 12.5 ms 内。
- 60 Hz 底线对应 16.67 ms；按 12.5 ms 设计留 4.2 ms 余量给切换、编码迟到与 ISR 抖动。

### 1.5 调度伪代码

每通道独立流水，没有全局栅栏；`tx_busy[ch]` 是该通道在飞的传输数（队列深度 2）。

```c
/* 任务上下文，循环调用；ISR 只在 tx_done 时给信号量 */
poll(core, now):
  submitted = false

  for ch in 0..1:
    if core->tx_busy[ch] >= 2:            /* 队列满，等 tx_done */
      continue

    s = argmin{ due[ch][k] : k in 0..3, due[ch][k] <= now }   /* 同值按槽位序 */
    if s == NONE:
      continue

    /* 1) 渲染（t_ms 决定相位，帧率抖动不改变动画速度） */
    effect_render(cfg[s], s, now, rgb[ch])

    /* 2) 编码成 2400 个 symbol，写进当前空闲缓冲 */
    ws_encode(rgb[ch], sym[ch][core->next_free[ch]])

    /* 3) 路由：扇出 + OE，两条寄存器写（<1 µs） */
    ports->route(ch, slot_of(s))

    /* 4) 非阻塞提交；trans_queue_depth = 2 */
    ports->tx_submit(ch, sym[ch][core->next_free[ch]], 2400)
    core->next_free[ch] ^= 1
    core->tx_busy[ch] += 1

    due[ch][slot_of(s)] = now + period_of(s)   /* 12.5 ms 或 200 ms */
    submitted = true

  if submitted: return POLL_AGAIN
  if core->tx_busy == 0 and 无 due 候选: return SLEEP(min(due) - now)
  return SLEEP(min(due) - now)                 /* ≥1 slot 在飞时睡眠被 tx_done 打断 */
```

`tx_done(ch)`（任务上下文，来自 ISR 信号量）：`tx_busy[ch] -= 1`，唤醒 poll。

`due` 用 `int32_t` 差值比较（`(int32_t)(due - now) <= 0`），避免 `uint32` 49 天回绕。

### 1.6 不变式（host 单测直接照这个断言）

1. 任意 12.5 ms 窗口内，同一条灯带最多发送一次 → 帧率 ≤80 Hz。
2. 任意 12.5 ms 窗口内，同一通道最多 4 次传输 → ≤12.2 ms，不超周期。
3. 一个符号缓冲区在收到它的 `tx_done` 之前不被改写。
4. 进入 OFF 之后只发一帧全黑，之后永不发送。
5. 同一 `(t_ms, strip, cfg)` 的编码结果逐字节确定（无 `rand()`、无开机种子）。
6. core 只在任务上下文被调用，`port` 回调不反向调用 core。

---

## 2. 时间预算表

### 2.1 单条

| 项 | 数值 | 备注 |
|---|---|---|
| symbol 数 | 2400 | 100 × 24 bit |
| 位周期 | 1.25 µs | T0H 0.4 / T0L 0.85，T1H 0.8 / T1L 0.45 |
| 传数耗时 | **3.000 ms** | 2400 × 1.25 µs |
| 补数次数 | 100 | 每 24 symbol 一次 |
| 补数窗口 | **30 µs** | 24 × 1.25 µs |
| 渲染 + 编码 | 12–50 µs | 在任务里，与上一条的传输重叠（双缓冲） |

### 2.2 每通道最坏（4 条全活动）

| 项 | 数值 |
|---|---|
| 传数 | 12.000 ms（4 × 3.000） |
| 路由（扇出+OE） | <0.004 ms（4 × 2 次寄存器写） |
| 提交开销 | <0.040 ms（4 次非阻塞调用） |
| 编码 | 0（与传输重叠） |
| 合计 | **≈12.05 ms** |
| 帧周期上限 | 12.5 ms（80 Hz） |
| 余量 | 0.45 ms |

### 2.3 ISR 负载（估算，上板核实）

| 场景 | 补数频率 | 估算 CPU |
|---|---|---|
| 8 条全活动 | 400 次/通道/12.5 ms → 64 k/s | 8–12%（按 1.5 µs/次） |
| 8 条全静态 | 8 帧/200 ms → 4 k/s | ≈0.6% |
| 只有 2 条活动 | 200 次/s 级 | ≈1–2% |

这就是按需重绘的实际收益：最常见状态把补数中断压低一个数量级。

### 2.4 60 Hz 底线

| 项 | 数值 |
|---|---|
| 底线周期 | 16.67 ms |
| 相对 12.05 ms 的余量 | **4.6 ms** |
| 可容忍的额外延迟 | 一次完整切换 + 一次编码迟到 + 一次 ISR 阻塞（1–2 ms 量级） |

---

## 3. 切换时序图

### 3.1 主路径：一信号扇出 4 脚 + 只切 `GPIO_ENABLE`

- 初始化时把 TX0 的 `tx_sig` 接到 GPIO 0/1/3/4，TX1 接到 5/6/7/10（GPIO Matrix 允许同一信号接多个焊盘）。
- 通道全程 `enable`，不调用 `rmt_disable()`；切换只做 `gpio_output_disable(旧槽)` + `gpio_output_enable(新槽)`，<1 µs。
- 新脚被使能时，RMT 输出正处于帧间空闲低电平 → 首 symbol 从干净的静止低开始（扇出相对 `switch_gpio` 的核心优势）。

### 3.2 时序

```text
时间(ms)   0        3.0      6.0      9.0      12.0   12.5
TX0      | s0     | s1     | s2     | s3     | 空     | s0 ...
         |        |        |        |        |        |
TX1      | s4     | s5     | s6     | s7     | 空     | s4 ...
          ^        ^        ^        ^
OE_A      仅 GPIO0 | 仅 GPIO1 | 仅 GPIO3 | 仅 GPIO4   （同一时刻只有一个脚被使能）
OE_B      仅 GPIO5 | 仅 GPIO6 | 仅 GPIO7 | 仅 GPIO10
          <- 槽0 -> <- 槽1 -> <- 槽2 -> <- 槽3 -> <- 余量 0.45ms ->
```

单次切换放大：

```text
t0         tx_done(s0) → 队列取 s1（已在上一条传输期间编码好）
t0 + 0     route: DISABLE(GPIO0) ; ENABLE(GPIO1)      ← 2 条寄存器写
t0 + 0     tx_submit(TX0, sym, 2400)                  ← 非阻塞，队列深度 2
t0 + 3.000 tx_done(s1)
```

### 3.3 不需要逐条 reset

同一通道的下一条在**另一根脚**上，互不影响；同一根脚两次发送之间至少隔 12.5 ms，远大于 WS2812 的 ≥280 µs 复位窗口。**因此不插任何显式 reset，也不留固定空档**（#23 已示警：逐条插 reset 会把帧率打到 69–74 Hz）。

### 3.4 可选守卫：无下拉时的 300 µs 静默（v1 不启用）

扇出+OE 在非活动期把脚置为高阻，帧尾的复位低电平由外部下拉维持。若硬件侧确认没有下拉，固件兜底是：每条传完后保持该脚使能（继续驱动低）≥300 µs 再切换。代价 = 4 × 300 µs = 1.2 ms/轮 → 13.4 ms → **74.6 Hz**（仍高于 60 Hz 底线）。

电气是否加下拉、加串阻，属硬件侧评估（用户决定），本文不设验收项；这一节只记录固件侧存在这个旋钮。

### 3.5 对照实现：`rmt_tx_switch_gpio`

藏在同一个 `ports->route(ch, slot)` 后面：`rmt_disable()` → `rmt_tx_switch_gpio()` → `rmt_enable()` → `tx_submit()`。代价是排空队列、重挂 GPIO Matrix、反复申请/释放 PM 锁（#23 §2.4），旧脚在 `gpio_output_disable()` 后同样变高阻。它只作为 A/B 对照与主路径门禁失败时的降级路径（§8 B0/B9）。

---

## 4. 保命清单（30 µs 窗口）

编译期：

1. `CONFIG_RMT_TX_ISR_CACHE_SAFE=y` —— 默认 `n`，必须显式开（它 select `RMT_TX_ISR_HANDLER_IN_IRAM` + `RMT_ENCODER_FUNC_IN_IRAM`）。不开则任何 flash 写（NVS、日志、OTA）期间补数必迟到 → 那帧必错色。
2. `intr_priority = 3`，与 BLE 控制器同级，避免互相抢占。
3. `CONFIG_PM_ENABLE=n`：不做 DFS/APB 变频，symbol 时基才是常数。
4. 发布与调试固件都把 `rmt` 组件日志压到 `ESP_LOG_INFO` 以下（运行时 `esp_log_level_set("rmt", ESP_LOG_INFO)`）。`rmt_tx_switch_gpio()` 里有 `ESP_LOGD`，Debug 级别下一次切换就吃掉几十 µs。
5. `trans_queue_depth = 2`；`mem_block_symbols` 用默认 `{1,1}`（不为 RX 强行改内存块）。

运行期：

6. 预编码：ISR 里只有驱动自己的 24 次 symbol 拷贝，**不在 ISR 里做 HSV/编码**。
7. `on_trans_done` 标 `IRAM_ATTR`，只做 `xSemaphoreGiveFromISR` + `portYIELD_FROM_ISR`，不打印、不分配、不调 core。
8. 双缓冲 38.4 KB：编码始终在上一条传输的影子期完成，编码抖动不进帧率。
9. 帧路径零 malloc、零 flash、零阻塞 I/O、零 `portENTER_CRITICAL`。
10. 帧任务优先级建议 4（低于 NimBLE host 任务、高于 idle；具体值上板用 `uxTaskPriorityGet` 核对该板 host 任务优先级后再定）。任务只做 poll + sleep，靠 `tx_done` 信号量唤醒。
11. `due` 比较用 `int32_t` 差值，防 49 天回绕。
12. NVS 落盘（1 s 去抖）在独立任务，不在帧任务里；靠第 1 条兜住 flash 写期间的补数。

---

## 5. 分层与接口

### 5.1 目录

```text
firmware/
  driver/              # 纯 C99，无 IDF / 无 malloc / 无 float / 无 stdio
    include/light_core.h
    src/sched.c        # 活动/静态分类、due、帧周期、心跳
    src/frame.c        # 双缓冲交接、队列深度、glitch 计数
    src/encode.c       # rgb8[100] -> 2400 symbol
  effects/             # 纯 C99（effects.md §6 公式）
    src/effect_engine.c
  proto/               # 纯 C99（protocol.md §12）
  ports/               # 只有这里出现 ESP-IDF
    rmt_tx.c route.c clock.c log.c nvs.c
  main/app_main.c      # 任务循环、ISR 注册、启动顺序
```

`driver` 依赖 `effects`（要 `effect_render` / `effect_is_time_varying`），不认识 `proto`；`proto` 只写 scene 状态，不认识 `driver`。

### 5.2 core 公共接口（host 可测）

```c
/* 纯 C99 */
#define LIGHT_STRIP_COUNT 8
#define LIGHT_LEDS        100
#define LIGHT_SYMBOLS     (LIGHT_LEDS * 24)

typedef struct { uint8_t effect_id, param_len, params[10]; } light_cfg_t;

typedef struct {
  uint32_t (*now_ms)(void);
  bool     (*tx_submit)(uint8_t ch, const uint32_t *sym, size_t n); /* 非阻塞、不拷贝 */
  void     (*route)(uint8_t ch, uint8_t slot);                      /* 扇出+OE 或 switch_gpio */
  void     (*log)(uint8_t level, const char *msg);
} light_ports_t;

typedef struct light_core light_core_t;          /* 不透明，内存由调用方静态给 */
typedef enum { LIGHT_POLL_AGAIN, LIGHT_POLL_SLEEP } light_poll_t;

void         light_core_init(light_core_t *c, const light_ports_t *p, uint32_t now_ms);
void         light_core_set(light_core_t *c, uint8_t strip, const light_cfg_t *cfg, uint32_t now_ms);
void         light_core_tx_done(light_core_t *c, uint8_t ch);        /* 任务上下文 */
light_poll_t light_core_poll(light_core_t *c, uint32_t now_ms, uint32_t *sleep_ms);
uint16_t     light_core_glitch_count(const light_core_t *c);
```

灯效层接口：

```c
void effect_render(uint8_t effect_id, const uint8_t *params, uint8_t strip,
                   uint32_t t_ms, uint8_t rgb[LIGHT_LEDS * 3]);   /* 逻辑 RGB */
bool effect_is_time_varying(uint8_t effect_id, const uint8_t *params);
```

编码器接口：

```c
void ws_encode(const uint8_t rgb[LIGHT_LEDS * 3], uint32_t sym[LIGHT_SYMBOLS]);
```

### 5.3 symbol 布局对齐

core 不 include IDF 头，输出 `uint32_t`，位布局固定为 RMT 的 `duration0:15 | level0:1 | duration1:15 | level1:1`（#23 已核：`hal/rmt_types.h:31-35`）。ports 侧在 boot 自检里做一次逐字节断言（构造已知 symbol，与 `rmt_symbol_word_t` 比较），位域布局若被编译器改掉会立刻暴露，而不是变成偶发错色。

### 5.4 任务与 ISR

```c
static void IRAM_ATTR on_tx_done(rmt_channel_handle_t ch,
                                 const rmt_tx_done_event_data_t *ed, void *ctx) {
  BaseType_t hp = pdFALSE;
  xSemaphoreGiveFromISR(g_done[(uintptr_t)ctx], &hp);   /* 只做这一件事 */
  portYIELD_FROM_ISR(hp);
}

void frame_task(void *arg) {
  for (;;) {
    uint32_t sleep_ms;
    if (light_core_poll(g_core, port_now_ms(), &sleep_ms) == LIGHT_POLL_SLEEP)
      xSemaphoreTake(g_wake, pdMS_TO_TICKS(sleep_ms));   /* tx_done 也会唤醒 */
    else
      taskYIELD();
  }
}
```

`tx_done` 由 ISR → 信号量 → 任务里调 `light_core_tx_done()`；core 永远只在任务上下文被改。

### 5.5 与协议层 / 灯效层的边界

| 层 | 知道什么 | 不知道什么 |
|---|---|---|
| `proto` | 帧、CRC、seq、ACK/NAK、scene 状态 | 灯效参数语义、引脚、RMT |
| `driver` | 哪条何时发、几个 symbol、路由哪根脚 | BLE、帧格式、参数含义（只调 `effects` 问） |
| `effects` | 参数布局、逐像素公式、是否随时间变化 | 引脚、符号、帧率 |
| `ports` | IDF 句柄、寄存器、信号量 | 调度策略 |

`STATUS.glitch_count` 的来源是 `light_core_glitch_count()`，由协议层取用；`strip_fault` v1 恒 `0x00`（无逐线反馈通道）。

---

## 6. 测试遥测（T: 行）

机器可读的驱动层遥测契约，供层 4 PC 影子跑 runner 解析做**交叉断言**，而非人眼读串口日志。遥测流只出现在 dev/test 构建；release 编译期关闭。**它不替代 STATUS**：`glitch_count` / `drop_count` 已是 `STATUS` 字段（`protocol.md` §7），常驻、release 也保留；遥测行只在 dev/test 下作为更高频、更细粒度的补充观测源。

### 6.1 行格式

单行一条，`T:` 前缀，`\n` 结尾：

```text
T:<key>=<value>
```

- `key` 用 snake_case，`value` 为十进制整数或浮点（无单位）。
- 一行一个键值，不在一行拼多个；解析器按 `^T:` 行匹配，`key=value` 用 `=` 切一次。
- 出现顺序不保证；runner 按 key 取值，不依赖行序。
- 例：

```text
T:glitch_count=0
T:drop_count=0
T:frame_ms=12.4
T:ack_seq=17
T:ch0_slot=2
```

### 6.2 字段集合

| key | 类型 | 单位 | 出现时机 | 含义 / 断言用途 |
|---|---|---|---|---|
| `glitch_count` | `uint16` | 次 | 每当变化（与 STATUS 同口径） | 帧起点迟到计数；层 4 断言窗口内 `== 0`。 |
| `drop_count` | `uint16` | 次 | 每当变化（与 STATUS 同口径） | 半帧超时丢弃的接收帧计数。 |
| `frame_ms` | `float` | ms | 每帧（聚合时取最近值） | 实际帧周期实测；层 4 只断言 `≥ 60Hz`（≤16.7 ms），不断言 80 Hz。 |
| `ack_seq` | `uint16` | — | 每当收到/发出 ACK/NAK | 最后 ACK/NAK seq；层 4 与协议层预期 seq 对拍。 |
| `ch0_slot` / `ch1_slot` | `uint8` | 槽位 | 每当切换 | 当前正在发送的槽位；断言与调度阶梯一致。 |
| `heartbeat_ms` | `uint32` | ms | 每当静态条心跳 | 相邻两次心跳间隔；断言 `200ms ±5ms`。 |
| `strip_state` | `uint8` | — | 每当活动/静态/IDLE 分类变化 | bit 布局见下；断言灯带分类符合 §1.2。 |

`strip_state` bit i = 第 i 条状态：`0=IDLE`，`1=活动`，`2=静态`（每条 2 bit，8 条共 16 bit，按 `uint32` 输出）。

`glitch_count` / `drop_count` 与 STATUS 共用同一计数器（`light_core_glitch_count()`），遥测行只是把它们更频繁地外放；STATUS 仍是 release 唯一常驻出口。

### 6.3 输出时机与节流

避免刷屏：dev/test 下默认**每秒聚合一行**（或每帧只更新，按秒发出最近一组值）。`ch0_slot`/`ch1_slot` 与 `heartbeat_ms` 仅按需（变化时）发出。每行单独成行；禁止把多个字段拼进一行。按秒聚合的 1 Hz 流量对 115200 波特串口可忽略。

### 6.4 编译期开关

release 关闭、dev/test 打开：

```c
#ifdef LIGHT_TELEMETRY
  /* 输出 T: 行 */
#else
  /* 不输出遥测行 */
#endif
```

- 宏名：`LIGHT_TELEMETRY`（与 §4 保命清单 `CONFIG_RMT_TX_ISR_CACHE_SAFE` 同风格的编译期开关）。
- 默认：**未定义 = 关闭**。release env（`platformio.ini` `[env:esp32c3]` 的发布变体）不定义；dev/test env（host `[env:native]`、上板调试构建）用 `-D LIGHT_TELEMETRY` 打开。
- 关闭时遥测路径编译为死代码，零运行期开销；`glitch_count` / `drop_count` 不受此开关影响，**常驻**（STATUS 字段，release 保留）。

### 6.5 与层 4 runner 的接口

- `T:` 行由端口层输出（见 6.6），层 4 runner（`test-strategy.md` §1 层 4、§5 定位决策树）解析 `T:` 行做交叉断言，**不解析人读日志**。
- runner 把 `T:` 行与 notify 时间线、场景脚本语义动作对拍：例如场景断言 `glitch_count==0`、`frame_ms≤16.7`、`ack_seq` 与协议层预期一致。
- 原始串口日志仍整体落 `serial-raw.log`（`test-strategy.md` §6 证据留存），`T:` 行只是其上的结构化子集。

### 6.6 归属与约束

遥测输出属于 `firmware/ports/log.c`（端口层，可访问 IDF `esp_rom_printf` / ESP_LOG），**core 不含 stdio**（保持 §5.1「core 无 stdio」约束）：core 只向 `ports->log()` 回调报事件，`log.c` 在 `LIGHT_TELEMETRY` 下格式化为 `T:` 行；`glitch_count` 值从 core 的 `light_core_glitch_count()` 读取。

---

## 7. host 单测清单

放 `tests/driver/`，与 `firmware/driver`、`firmware/effects` 同源编译（C99，无 IDF），用假 `light_ports_t` + 假时钟驱动。测试框架选型归 #26 / #28 定，本文只定用例与断言。

| # | 用例 | 断言 |
|---|---|---|
| D1 | 编码 0x00 / 0xFF / 0x55 | 每 bit 的 `(d0,l0,d1,l1)` 与 golden 一致；恰 2400 个字；总时长 3.000 ms |
| D2 | 线序 GRB | 逻辑 RGB 落到 WS2812 的 G,R,B 顺序 |
| D3 | 7 灯效帧确定性 | 同 `(t_ms,strip,cfg)` 两次渲染逐字节相同 |
| D4 | `speed=0` 冻结 | 任意 `t_ms` 与 `t=0` 输出相同，且被判为静态 |
| D5 | 活动判定表 | 6 个灯效 × `speed=0/≠0` 全部分类正确 |
| D6 | 全 OFF | `poll` 永不 `tx_submit` |
| D7 | OFF 转换 | 恰好一帧全黑，之后该条永不提交 |
| D8 | 8 条全活动 | 每条每 12.5 ms 一次；槽序 0→3；两通道并行；单轮 ≤12.5 ms |
| D9 | 单条活动 | 该条 80 Hz（不超），其余静默 |
| D10 | 静态心跳 | 每 200 ms ±1 ms 一次；帧字节与首次相同 |
| D11 | 心跳不抢活动 | 3 活动 + 1 静态的通道内，活动条周期仍 12.5 ms |
| D12 | 脏重绘时延 | `light_core_set` 后 ≤12.5 ms 内发出，且先于该条下一次心跳 |
| D13 | 双缓冲 | 未 `tx_done` 的缓冲区不被改写；队列满时 `poll` 不提交 |
| D14 | 迟到 / 丢失 `tx_done` | 迟到 12.5 ms 不错帧；丢失时不死锁（有超时恢复并计 `glitch_count`） |
| D15 | 时基回绕 | `now_ms` 跨 2³² 回绕后 due 比较与心跳仍正确 |
| D16 | `glitch_count` 口径 | 帧起点迟到 >2 ms 计 1，否则不变 |

---

## 8. 上板实测项

与 #23 的 11 项对齐：去掉 `{1,2}` 内存跨块（不采用，用默认 `{1,1}`），新增按需重绘/心跳行为；第 10 项改为「扇出+OE 门禁 + A/B 对照」。

| # | 项 | 方法 | 通过判据 |
|---|---|---|---|
| B0 | **扇出+OE 门禁**（前置） | 4 脚接同一 `tx_sig`，只切 `GPIO_ENABLE`；读回 `oen_sel` 行为；示波器看指定脚是否随 OE 输出 | 只有被使能的脚输出；不成立则主路径降级为 `switch_gpio` |
| B1 | **补数 ISR 是否被撕开**（核心） | 阈值 ISR 首尾翻一个空脚，逻辑分析仪量脉宽分布 | 单次入口延迟 <20 µs；10 min 内 0 次 >30 µs |
| B2 | **端到端位流** | RMT RX 环回（boot 自检或 Y 点并线），逐 symbol 比对期望 | 每帧 0 symbol 偏差，连跑 30 min |
| B3 | **切换毛刺** | 逻辑分析仪同接 4 脚，量旧脚释放、新脚起始、首 symbol | 旧脚无 >100 ns 尖峰；新脚起始为稳定低 ≥280 µs |
| B4 | **首颗 LED 吞位 / 错色** | 首颗红其余蓝的静态图案，切 100 轮 | 100% 正确 |
| B5 | **帧率与抖动** | 帧起点翻 GPIO，统计 1 万帧 | 均值 ≥80 Hz（≤12.5 ms），p99 ≤16.7 ms，最大 ≤20 ms |
| B6 | **按需重绘与心跳** | 8 条全静态：量 RMT 占空与心跳间隔；再混 4 动 4 静 | 心跳 200 ms ±5 ms 且无可见跳变；活动条仍 80 Hz；静态时补数中断降一个数量级 |
| B7 | **BLE 压力** | 主机连接间隔 15 ms、每事件多条 notify 持续 1 h，同时全速动画 | 0 次断连；notify 丢包 <0.1% |
| B8 | **NVS / flash 写期间错色** | 动画中每 5 s 写一次 NVS；`ISR_CACHE_SAFE` = n / y 对照 | `y` 0 次错色；`n` 能复现（证明该项有效） |
| B9 | **优先级与位周期旋钮** | `intr_priority` 0 vs 3 比延迟分布；1.25 / 1.40 / 1.50 µs 各测 | 3 级显著降低 >10 µs 尾部；找到「窗口够大且仍 ≥70 Hz」的拐点 |

B2 的硬件前提：数据线要能被 RX 通道采到（WS2812 输入高阻，可在首颗 LED 前并 Y 点，或临时飞线到另一个 GPIO）；默认 `{1,1}` 内存配置下 RX 可用块 2/3。

---

## 9. 风险与未证实项

| 风险 | 现状 | 处置 |
|---|---|---|
| `oen_sel` 恒 0（扇出+OE 的前置条件） | 由 `esp_rom_gpio` 只覆写 ESP32/S2 反推，未在 TRM 逐字确认 | B0 门禁；不成立即降级 `switch_gpio` |
| BLE 临界区最坏时长 | 官方无上界 | B1 实测；接受尾部风险，靠双缓冲把影响限制在「单帧重播旧数据」 |
| WS2812B 位周期上限 | 按 1.25 µs 标称；具体批次手册未归档 | B9 找拐点，手册入仓 |
| `rmt_symbol_word_t` 位域布局随编译器变化 | 未验证 | boot 逐字节断言 + D1 golden |
| 无逐线故障反馈 | 硬件上做不到 | `strip_fault` v1 恒 0；`glitch_count` 只数「帧起点迟到」 |
| 非活动期引脚高阻 → 帧尾复位低电平不受固件控制 | 需要外部下拉 | **硬件侧评估（用户决定），本文不设验收项**；固件兜底是 §3.4 的 300 µs 守卫 |
| 帧任务优先级 | 本仓库的 PIO 包内 NimBLE 子模块未落地，无法核对 host 任务默认优先级 | 先定 4；上板第 6 项期间用 `uxTaskPriorityGet` 核对 |
| 四线 QIO SPI（166 Hz、零 ISR） | 无官方例程，属自研 | 不在本文路径内；作为独立 spike 保留，RMT 4+4 是主线 |
