/*
 * 刷新周期调度实现（纯 C99，不依赖 IDF，不用动态内存，时间注入）。
 * 语义见 scheduler.h 文件头；符号缓冲由调用方（ports/app）持有并提供，
 * scheduler 只搬运指针 —— 它不知道符号内容，知道内容的只有编码层。
 */

#include "scheduler.h"

#include <string.h>

/* 动画类（每周期必发）vs 静态类（keep-alive 1s）。 */
#include "effect_engine.h"

void sched_init(sched_ctx_t *ctx, sched_transmit_fn transmit,
                sched_now_ms_fn now_ms, void *transmit_ctx)
{
    memset(ctx, 0, sizeof(*ctx));
    ctx->transmit = transmit;
    ctx->now_ms = now_ms;
    ctx->transmit_ctx = transmit_ctx;
    /* 零初始化后全部灯带视为 NONE（未设置）：active_id 0 不是合法
     * 灯效（0x00=OFF），全 0 即"无动作"，符合零初始化语义。 */
}

uint8_t sched_round_strip(uint8_t round, uint8_t channel)
{
    return (uint8_t)(round * 2u + channel);
}

uint8_t sched_strip_active(const sched_ctx_t *ctx, uint8_t strip)
{
    if (strip >= SCHED_STRIP_COUNT) {
        return 0u;
    }
    return ctx->active_id[strip] != EFFECT_ID_NONE &&
           ctx->active_id[strip] != EFFECT_ID_OFF;
}

/* 该条本轮是否该发：活跃条里，动画每周期发，静态首条即发、之后按
 * keep-alive 间隔发。 */
static uint8_t should_send(const sched_ctx_t *ctx, uint8_t strip, uint32_t now)
{
    if (!sched_strip_active(ctx, strip)) {
        return 0u;
    }
    if (ctx->active_id[strip] != EFFECT_ID_STATIC) {
        return 1u; /* 动画：每个刷新周期重发 */
    }
    if ((ctx->ever_sent & (uint8_t)(1u << strip)) == 0u) {
        return 1u; /* 静态首次：立即发（无间隔限制） */
    }
    /* 静态：距上次发送 >= 1s 才重发。 */
    return (uint8_t)((uint32_t)(now - ctx->last_sent_ms[strip]) >=
                     SCHED_KEEPALIVE_STATIC_MS);
}

uint8_t sched_tick(sched_ctx_t *ctx)
{
    uint32_t now;
    uint8_t sent = 0u;

    if (ctx->transmit == NULL || ctx->now_ms == NULL) {
        return 0u;
    }
    now = ctx->now_ms(ctx->transmit_ctx);
    if (now < ctx->next_round_ms) {
        return 0u;
    }

    for (uint8_t ch = 0u; ch < SCHED_CHANNELS; ch++) {
        uint8_t strip = sched_round_strip(ctx->round, ch);
        if (!should_send(ctx, strip, now)) {
            continue;
        }
        /* ports 通过 ctx->transmit_ctx 按 strip 取符号缓冲并启动 RMT；
         * scheduler 只编排，不认识符号内容。 */
        sched_item_t item;
        item.strip = strip;
        item.sym = NULL;
        item.sym_count = SCHED_BUF_SYMBOLS;
        ctx->transmit(ch, &item, ctx->transmit_ctx);
        ctx->last_sent_ms[strip] = now;
        ctx->ever_sent |= (uint8_t)(1u << strip);
        sent++;
    }

    ctx->round = (uint8_t)((ctx->round + 1u) % SCHED_ROUNDS);
    ctx->next_round_ms = now + SCHED_REFRESH_MS;
    return sent;
}

void sched_note_done(sched_ctx_t *ctx, size_t num_symbols)
{
    if (num_symbols != SCHED_EXPECTED_SYMBOLS) {
        ctx->glitch_count++;
    }
}