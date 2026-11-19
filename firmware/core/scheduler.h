#ifndef BLE_LIGHT_SCHEDULER_H
#define BLE_LIGHT_SCHEDULER_H

#include <stddef.h>
#include <stdint.h>

#include "ws2812.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 刷新周期调度（纯 C99，不依赖 IDF，不用动态内存，时间注入）。
 *
 * 几何：8 条灯带（L0–L7）、2 个 RMT 通道（ch0/ch1），每轮 2 条并行，
 * 4 轮（round 0..3）覆盖全部 8 条 = 一个刷新周期。工程目标 30–50fps。
 *
 * 轮内映射：round r → 通道 0 驱动 strip 2r，通道 1 驱动 strip 2r+1。
 *
 * 活跃判定 / keep-alive（#7 §3 调度策略 B）：
 * - 动画条（effect_id != STATIC/OFF/NONE）每个刷新周期都重发（无需 keep-alive）；
 * - 静态条（STATIC）每 SCHED_KEEPALIVE_STATIC_MS 重发一次（常量可调）；
 * - OFF / NONE 条不重发（输出保持全 0，无需喂）。
 *
 * glitch_count（#7 §3）：RMT done 回调的 edata.num_symbols 与期望不符
 * （期望 = 数据符号数 + 1 个 EOF）的累计次数。弱信号、不可检测欠载的
 * 唯一近似口径，进 STATUS 上报。由 ports 在回调里调 scheduler_note_done。
 *
 * 本层只决定"哪轮该发哪条"，实际 RMT transmit 通过注入的 port 回调完成
 * （ports/esp32 提供真实实现，测试用 FakePort 记录调用序列）。
 */

/* keep-alive：静态条重发周期（#7 常量可调）。1s。 */
#define SCHED_KEEPALIVE_STATIC_MS 1000u
/* 刷新周期目标（工程 30–50fps，取 40fps = 25ms 作为调度基准）。 */
#define SCHED_REFRESH_MS 25u

/* 每轮每通道 1 条；数据符号 = 60 颗 × 24 = 1440，+1 个 EOF。 */
#define SCHED_STRIP_COUNT 8u
#define SCHED_CHANNELS 2u
#define SCHED_ROUNDS 4u
#define SCHED_SYMBOLS_PER_STRIP (60u * 24u)
/* 缓冲容量：ws2812_encode 写入 1440 数据符号 + 1 个 EOF 占位。 */
#define SCHED_BUF_SYMBOLS (SCHED_SYMBOLS_PER_STRIP + 1u)
/* done 回调期望值：num_symbols = 应用符号数 + 驱动追加 1 EOF，
 * 期望 = 1441 + 1。 */
#define SCHED_EXPECTED_SYMBOLS (SCHED_BUF_SYMBOLS + 1u)

/* 每轮两条的发送请求（transmit 回调的入参）。 */
typedef struct {
    uint8_t strip;               /* 灯带号 0..7（观测/断言用） */
    const ws2812_symbol_t *sym;  /* 符号缓冲 */
    size_t sym_count;            /* 符号数（= 数据 + 1 EOF） */
} sched_item_t;

/*
 * port 接口（注入）：
 * - transmit(ch, item)：把一条灯带的发送请求交给通道 ch（0/1）。实现
 *   自行按 item->strip 取符号缓冲并启动 RMT 事务（符号内容归 ports /
 *   app 层，scheduler 不感知）。立即或异步启动均可。
 * - now_ms：返回单调毫秒时钟（ports 注入 esp_timer；测试注入假时钟）。
 * transmit/now_ms 为 NULL 时 scheduler_tick 直接返回（未装配）。
 */
typedef void (*sched_transmit_fn)(uint8_t channel, const sched_item_t *item,
                                  void *ctx);
typedef uint32_t (*sched_now_ms_fn)(void *ctx);

typedef struct {
    /* 注入 */
    sched_transmit_fn transmit;
    sched_now_ms_fn now_ms;
    void *transmit_ctx;  /* 传给 transmit 的上下文（ports 或 FakePort） */

    /* 状态（调用方零初始化即可，sched_init 会显式复位）。 */
    uint8_t round;                /* 下一轮要跑的轮号 0..3 */
    uint32_t next_round_ms;       /* 下一轮最早开始时间 */
    /* 每路灯带最近一次已发送的时间 + 当前灯效（keep-alive 判定）。 */
    uint32_t last_sent_ms[SCHED_STRIP_COUNT];
    uint8_t active_id[SCHED_STRIP_COUNT];
    /* ever_sent 位图：bit i = 灯带 i 至少发过一次（首次发送无 keep-alive
     * 间隔限制 —— last_sent_ms 零初始化无法区分"t=0 发过"与"从未发过"）。 */
    uint8_t ever_sent;
    /* glitch：done 回调上报 num_symbols != 期望的次数（16 位回绕，与 STATUS 字段同宽）。 */
    uint16_t glitch_count;
} sched_ctx_t;

/* 复位调度状态。 */
void sched_init(sched_ctx_t *ctx, sched_transmit_fn transmit,
                sched_now_ms_fn now_ms, void *transmit_ctx);

/*
 * 推进调度：把到点的轮次通过 transmit 发出去。
 * 行为：
 * - now < next_round_ms：不发，返回 0；
 * - 到点：发出本轮 2 条中"该发"的条（活跃判定见文件头），next_round_ms
 *   前进 SCHED_REFRESH_MS，round 前进 1（模 4）。
 * 返回本次 transmit 调用的条数（0..2）。
 */
uint8_t sched_tick(sched_ctx_t *ctx);

/*
 * done 回调上报：ports 在 RMT on_trans_done（ISR 上下文可调用，本函数
 * 无锁、无阻塞）里把 edata.num_symbols 与期望比对，不符则 glitch_count++。
 */
void sched_note_done(sched_ctx_t *ctx, size_t num_symbols);

/* 测试/ports 观测：某一轮映射到的通道条带（round*2 / round*2+1）。 */
uint8_t sched_round_strip(uint8_t round, uint8_t channel);

/* 某路灯带当前是否活跃（供 ports/测试判定）。 */
uint8_t sched_strip_active(const sched_ctx_t *ctx, uint8_t strip);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_SCHEDULER_H */