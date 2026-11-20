// 驱动 core 公共头（firmware/driver）。
// 纯 C99：无 Arduino / ESP-IDF、无 malloc、无 float、无 stdio（docs/spec/driver.md §5.1）。
//
// 职责边界：本层只决定「什么时候把哪一条的哪一帧送到哪个引脚」。
//   像素怎么算 -> effects（effect_render / effect_is_time_varying）
//   帧字节怎么排 -> 本层 ws_encode（WS2812 GRB 位流）
//   RMT / GPIO / 时间 / 日志 -> ports 回调（core 不碰 IDF）
//
// 公共接口签名与 docs/spec/driver.md §5.2 一致；编码器 ws_encode 见 §5.2 末尾。

#ifndef LIGHT_CORE_H
#define LIGHT_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "effect_engine.h" /* LIGHT_STRIP_COUNT / LIGHT_LEDS / LIGHT_RGB_BYTES */

/* ---------- 固定常量（driver.md §0.1 / §2.1） ---------- */

#define LIGHT_CHANNEL_COUNT 2
#define LIGHT_SLOTS_PER_CH  4

/* 一条灯带一帧 = 100 颗 × 24 bit = 2400 个 symbol。 */
#define LIGHT_SYMBOLS (LIGHT_LEDS * 24)

/*
 * RMT 分辨率 20 MHz = 0.05 µs / tick。选它是因为：
 *   T0H 0.40 µs =  8 tick
 *   T0L 0.85 µs = 17 tick
 *   T1H 0.80 µs = 16 tick
 *   T1L 0.45 µs =  9 tick
 * 两种 bit 的 (H+L) 都 = 25 tick = 1.25 µs，一条 2400 symbol 恰好 3.000 ms。
 * 位周期严格 1.25 µs，无需四舍五入到别的时基（§0.3 / §2.1）。
 */
#define LIGHT_RMT_TICKS_PER_US 20u
#define LIGHT_SYM_T0H_TICKS    8u
#define LIGHT_SYM_T0L_TICKS    17u
#define LIGHT_SYM_T1H_TICKS    16u
#define LIGHT_SYM_T1L_TICKS    9u
#define LIGHT_BIT_TICKS        (LIGHT_SYM_T0H_TICKS + LIGHT_SYM_T0L_TICKS) /* 25 */
#define LIGHT_FRAME_TICKS      (LIGHT_SYMBOLS * LIGHT_BIT_TICKS)           /* 60000 = 3000 µs */
#define LIGHT_FRAME_US         (LIGHT_FRAME_TICKS / LIGHT_RMT_TICKS_PER_US) /* 3000 */

/* 调度周期（µs）。§1.4：活动上限 12.5 ms（80 Hz），静态心跳 200 ms。
 * 注：core 的时间入口是毫秒（light_ports_t.now_ms），所以 due 用 12500 µs 精确累加，
 * 实际发送落在整数毫秒上 -> 相邻两次发送 13 ms（76.9 Hz，≤80 Hz，满足 §1.6 不变式 1）。 */
#define LIGHT_ACTIVE_PERIOD_US 12500u
#define LIGHT_STATIC_PERIOD_US 200000u

/* 帧起点迟到阈值：> 2 ms 记一次 glitch（§7 D16）。 */
#define LIGHT_GLITCH_LATE_US 2000u

/* tx_done 丢失的恢复超时：两帧在飞最长 6 ms，给到 20 ms。 */
#define LIGHT_TX_TIMEOUT_US 20000u

/* ---------- 配置与端口 ---------- */

/* 一条灯带的配置：effect_id + 参数（protocol.md §6 布局，driver 不解析）。 */
typedef struct {
    uint8_t effect_id;
    uint8_t param_len;
    uint8_t params[10];
} light_cfg_t;

/*
 * 端口回调（core 只调用、不反向依赖）。
 *
 * now_ms:   单调毫秒时钟（允许 2^32 回绕，core 内部按 int32 差值比较）。
 * tx_submit: 非阻塞提交一帧；返回 false 表示该通道硬件队列暂不可接收（不拷贝、不算提交）。
 *            core 保证 `sym` 指向的缓冲在对应 light_core_tx_done(ch) 之前不被改写。
 * route:    选择 ch 通道上「下一帧」使能的槽位（扇出+OE，或 switch_gpio 降级）。
 *            必须由 port 在帧边界生效，不得干扰正在发送的那一帧（见 docs/spec/driver.md §3.1/§3.2）。
 * log:      人读/遥测日志出口（T: 行由 core 格式化后经此输出，见 §6）。
 */
typedef struct {
    uint32_t (*now_ms)(void);
    bool (*tx_submit)(uint8_t ch, const uint32_t *sym, size_t n);
    void (*route)(uint8_t ch, uint8_t slot);
    void (*log)(uint8_t level, const char *msg);
} light_ports_t;

/* log level（沿用常见数值，ports 自行映射到 ESP_LOGx）。 */
#define LIGHT_LOG_DEBUG 0
#define LIGHT_LOG_INFO  1
#define LIGHT_LOG_WARN  2

/* core 状态机（对外不暴露字段；light_core_t 不透明）。 */
typedef struct light_core light_core_t;

typedef enum {
    LIGHT_POLL_AGAIN = 0, /* 本次 poll 提交了帧，立刻再调一次 */
    LIGHT_POLL_SLEEP = 1  /* 无事可做，睡 *sleep_ms（或被 tx_done 信号量唤醒） */
} light_poll_t;

/*
 * core 的静态存储。core 自身不 malloc：调用方声明一个 light_core_storage_t
 * （建议 static，约 40 KB，含双通道双缓冲 symbol），再把地址强转成 light_core_t*。
 *
 *   static light_core_storage_t g_core_store;
 *   light_core_init((light_core_t *)&g_core_store, &ports, now_ms);
 */
#define LIGHT_CORE_STORAGE_BYTES 40960u

typedef union {
    uint64_t align_u64; /* 保证 8 字节对齐，足够容纳任意内部字段 */
    void *align_ptr;
    uint8_t bytes[LIGHT_CORE_STORAGE_BYTES];
} light_core_storage_t;

/* ---------- 公共接口 ---------- */

/* 初始化：清零全部状态，所有灯带进入 IDLE（全关、不发送）。 */
void light_core_init(light_core_t *c, const light_ports_t *p, uint32_t now_ms);

/*
 * 更新一条灯带的配置（SET_EFFECT）。
 *   OFF(0x00)          -> 若非 IDLE，发一帧全黑后进 IDLE（§1.3）。
 *   时间相关效果        -> 活动条，置脏，下一发送机会立即重绘。
 *   静态效果            -> 静态条，置脏，下一发送机会立即重绘，之后 200 ms 心跳。
 * now_ms 与 init/poll 同一时间基。
 */
void light_core_set(light_core_t *c, uint8_t strip, const light_cfg_t *cfg, uint32_t now_ms);

/* 一帧发送完成（任务上下文；来自 ISR 信号量）。ch 越界或被判为陈旧则安全忽略。 */
void light_core_tx_done(light_core_t *c, uint8_t ch);

/*
 * 调度一次：最多给每个通道提交一帧；返回 AGAIN（还有活）或 SLEEP（*sleep_ms 为建议睡眠）。
 * 必须在任务上下文调用；port 回调不反向调用 core（§1.6 不变式 6）。
 */
light_poll_t light_core_poll(light_core_t *c, uint32_t now_ms, uint32_t *sleep_ms);

/* 帧起点迟到计数（STATUS.glitch_count 的真源，常驻、release 也保留）。 */
uint16_t light_core_glitch_count(const light_core_t *c);

/* 因错过整周期而跳过的帧计数（STATUS 之外的补充诊断，常驻）。 */
uint16_t light_core_drop_count(const light_core_t *c);

/* ---------- 编码器（§5.2） ---------- */

/*
 * 逻辑 RGB（100 颗 × 3 字节）-> 2400 个 RMT symbol（GRB 发送序，MSB first）。
 * 每个 symbol 的位布局固定为 duration0:15 | level0:1 | duration1:15 | level1:1。
 * 每 bit: 0 = (T0H,T0L)，1 = (T1H,T1L)；一条 100 颗共 2400 symbol、总时长 3.000 ms。
 */
void ws_encode(const uint8_t rgb[LIGHT_RGB_BYTES], uint32_t sym[LIGHT_SYMBOLS]);

#endif /* LIGHT_CORE_H */
