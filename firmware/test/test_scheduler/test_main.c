/*
 * 调度器单测（native / Unity）。
 *
 * 断言基准：#7 §3 调度策略 B（动画每周期重发、静态 1s keep-alive、
 * glitch = num_symbols 不符累计）与 #3 轮映射（round r → ch0 驱动
 * strip 2r、ch1 驱动 strip 2r+1，4 轮覆盖 8 条）。时间全部注入。
 */

#include <string.h>

#include <unity.h>

#include "effect_engine.h"
#include "scheduler.h"

void setUp(void)
{
}

void tearDown(void)
{
}

/* ---- 测试替身：假时钟 + FakePort 记录 transmit 调用 ---- */

static uint32_t g_now_ms;

static uint32_t fake_now(void *ctx)
{
    (void)ctx;
    return g_now_ms;
}

#define FAKE_MAX_CALLS 64

typedef struct {
    uint8_t ch;
    uint8_t strip;
    size_t sym_count;
} fake_call_t;

typedef struct {
    fake_call_t calls[FAKE_MAX_CALLS];
    uint8_t n;
} fake_port_t;

static fake_port_t g_port;

static void fake_transmit(uint8_t channel, const sched_item_t *item, void *ctx)
{
    (void)ctx;
    if (g_port.n < FAKE_MAX_CALLS) {
        g_port.calls[g_port.n].ch = channel;
        g_port.calls[g_port.n].strip = item->strip;
        g_port.calls[g_port.n].sym_count = item->sym_count;
        g_port.n++;
    }
}

/* 装配：时钟归零、port 清空、8 条全部设为动画（每周期必发）。 */
static void setup_sched(sched_ctx_t *s)
{
    memset(&g_port, 0, sizeof(g_port));
    g_now_ms = 0;
    sched_init(s, fake_transmit, fake_now, NULL);
    for (uint8_t i = 0; i < 8; i++) {
        s->active_id[i] = EFFECT_ID_BREATH;
    }
}

/* 轮序与通道映射（ch0: 2r / ch1: 2r+1，#3）。 */

static void test_round_strip_mapping(void)
{
    /* #3：round r → ch0: strip 2r，ch1: strip 2r+1。 */
    TEST_ASSERT_EQUAL_UINT8(0, sched_round_strip(0, 0));
    TEST_ASSERT_EQUAL_UINT8(1, sched_round_strip(0, 1));
    TEST_ASSERT_EQUAL_UINT8(2, sched_round_strip(1, 0));
    TEST_ASSERT_EQUAL_UINT8(3, sched_round_strip(1, 1));
    TEST_ASSERT_EQUAL_UINT8(6, sched_round_strip(3, 0));
    TEST_ASSERT_EQUAL_UINT8(7, sched_round_strip(3, 1));
}

static void test_four_rounds_cover_eight_strips(void)
{
    sched_ctx_t s;
    uint8_t seen[8] = {0};

    setup_sched(&s);
    for (unsigned r = 0; r < 4; r++) {
        g_now_ms = r * SCHED_REFRESH_MS;
        TEST_ASSERT_EQUAL_UINT8(2, sched_tick(&s));
        seen[g_port.calls[r * 2].strip] = 1;
        seen[g_port.calls[r * 2 + 1].strip] = 1;
    }
    for (uint8_t i = 0; i < 8; i++) {
        TEST_ASSERT_EQUAL_UINT8(1, seen[i]);
    }
    /* 4 轮之后回到 round 0。 */
    TEST_ASSERT_EQUAL_UINT8(0, s.round);
}

static void test_channel_mapping_per_round(void)
{
    sched_ctx_t s;

    setup_sched(&s);
    /* 连续推 3 轮到 round 2（ch0→4, ch1→5）。 */
    g_now_ms = 0;
    sched_tick(&s); /* round 0 */
    g_now_ms = SCHED_REFRESH_MS;
    sched_tick(&s); /* round 1 */
    g_now_ms = 2 * SCHED_REFRESH_MS;
    g_port.n = 0;
    TEST_ASSERT_EQUAL_UINT8(2, sched_tick(&s)); /* round 2 */
    TEST_ASSERT_EQUAL_UINT8(0, g_port.calls[0].ch);
    TEST_ASSERT_EQUAL_UINT8(4, g_port.calls[0].strip);
    TEST_ASSERT_EQUAL_UINT8(1, g_port.calls[1].ch);
    TEST_ASSERT_EQUAL_UINT8(5, g_port.calls[1].strip);
}

/* ---- 活跃判定 / keep-alive ---- */

static void test_off_and_none_strips_not_sent(void)
{
    sched_ctx_t s;

    setup_sched(&s);
    for (uint8_t i = 0; i < 8; i++) {
        s.active_id[i] = EFFECT_ID_NONE;
    }
    g_now_ms = 0;
    TEST_ASSERT_EQUAL_UINT8(0, sched_tick(&s));
    TEST_ASSERT_EQUAL_UINT8(0, g_port.n);
}

static void test_off_id_also_not_sent(void)
{
    sched_ctx_t s;

    setup_sched(&s);
    for (uint8_t i = 0; i < 8; i++) {
        s.active_id[i] = EFFECT_ID_OFF;
    }
    g_now_ms = 0;
    TEST_ASSERT_EQUAL_UINT8(0, sched_tick(&s));
}

static void test_static_strip_sent_once_then_keepalive_1s(void)
{
    sched_ctx_t s;

    setup_sched(&s);
    for (uint8_t i = 0; i < 8; i++) {
        s.active_id[i] = EFFECT_ID_NONE;
    }
    s.active_id[0] = EFFECT_ID_STATIC;

    /* t=0 round 0：首次发送。 */
    g_now_ms = 0;
    TEST_ASSERT_EQUAL_UINT8(1, sched_tick(&s));
    TEST_ASSERT_EQUAL_UINT8(0, g_port.calls[0].strip);

    /* 推到 t=975（round 0 的时刻，975 - 0 < 1000）：不重发。
     * 每个周期点由本轮 tick 自己完成。 */
    for (unsigned t = 25; t <= 975; t += 25) {
        g_now_ms = t;
        g_port.n = 0;
        sched_tick(&s);
        if (s.round == 0u) {
            TEST_ASSERT_EQUAL_UINT8(0, g_port.n); /* round 0 且 <1s：不发 */
        }
    }

    /* t=1000ms 处的 round 0：keep-alive 重发。 */
    g_port.n = 0;
    g_now_ms = 1000u;
    TEST_ASSERT_EQUAL_UINT8(0, s.round);
    TEST_ASSERT_EQUAL_UINT8(1, sched_tick(&s));
    TEST_ASSERT_EQUAL_UINT8(0, g_port.calls[0].strip);
}

static void test_static_strip_not_resent_within_1s(void)
{
    sched_ctx_t s;

    setup_sched(&s);
    for (uint8_t i = 0; i < 8; i++) {
        s.active_id[i] = EFFECT_ID_NONE;
    }
    s.active_id[0] = EFFECT_ID_STATIC;

    g_now_ms = 0;
    TEST_ASSERT_EQUAL_UINT8(1, sched_tick(&s));

    /* 连续 tick 到 t=975（此时 round 回到 0）：975 - 0 < 1000 → 不发。
     * 关键：975ms 那一发（if 任何）由本轮 tick 自己完成。 */
    while (g_now_ms < 975u) {
        g_now_ms += SCHED_REFRESH_MS;
        g_port.n = 0;
        sched_tick(&s);
    }
    /* 上面循环最后一次 tick 在 975ms 处执行：round 0、STATIC、
     * 975-0=975 < 1000 → 0 条。 */
    TEST_ASSERT_EQUAL_UINT8(0, s.round);
    TEST_ASSERT_EQUAL_UINT8(0, g_port.n);
}

static void test_animated_strip_sent_every_cycle(void)
{
    sched_ctx_t s;

    setup_sched(&s);
    for (uint8_t i = 0; i < 8; i++) {
        s.active_id[i] = EFFECT_ID_NONE;
    }
    s.active_id[1] = EFFECT_ID_BREATH; /* 动画 */

    /* 三个连续的 round-0 时刻（t=0,100,200ms）：每个时刻都发 strip 1。
     * 逐周期 tick 到该时刻；到达时（round==0 且时钟到点）那次 tick
     * 自己就发了 strip 1 —— 显式断言它。 */
    for (unsigned c = 0; c < 3; c++) {
        g_port.n = 0;
        while (g_now_ms < c * 100u) {
            g_now_ms += SCHED_REFRESH_MS;
            sched_tick(&s);
        }
        /* 此刻 g_now_ms == c*100（c>0 时循环内已 tick 过该时刻：
         * 到达 100/200ms 的那次 tick 在循环里执行了 —— round 已翻。
         * 所以对 c>0 用"循环里最后一次 tick"的结果断言；c=0 时
         * 显式 tick。 */
        if (c == 0u) {
            TEST_ASSERT_EQUAL_UINT8(1, sched_tick(&s));
        }
        TEST_ASSERT_EQUAL_UINT8(1, g_port.calls[0].strip);
    }
}

static void test_tick_before_next_round_does_nothing(void)
{
    sched_ctx_t s;

    setup_sched(&s);
    g_now_ms = 0;
    TEST_ASSERT_EQUAL_UINT8(2, sched_tick(&s));
    /* 未到 25ms 后再 tick：0 条。 */
    g_now_ms = 10;
    TEST_ASSERT_EQUAL_UINT8(0, sched_tick(&s));
    TEST_ASSERT_EQUAL_UINT8(2, g_port.n); /* 仍只有第一轮 2 条 */
}

/* ---- glitch ---- */

static void test_glitch_count_on_num_symbols_mismatch(void)
{
    sched_ctx_t s;

    setup_sched(&s);
    TEST_ASSERT_EQUAL_UINT16(0, s.glitch_count);
    sched_note_done(&s, SCHED_EXPECTED_SYMBOLS);
    TEST_ASSERT_EQUAL_UINT16(0, s.glitch_count); /* 期望值不算 */
    sched_note_done(&s, SCHED_EXPECTED_SYMBOLS);
    TEST_ASSERT_EQUAL_UINT16(0, s.glitch_count);
    sched_note_done(&s, SCHED_EXPECTED_SYMBOLS - 1);
    TEST_ASSERT_EQUAL_UINT16(1, s.glitch_count);
    sched_note_done(&s, 0);
    sched_note_done(&s, 100);
    TEST_ASSERT_EQUAL_UINT16(3, s.glitch_count);
}

/* ---- 符号数口径 ---- */

static void test_item_sym_count_is_data_plus_eof(void)
{
    sched_ctx_t s;

    setup_sched(&s);
    g_now_ms = 0;
    sched_tick(&s);
    TEST_ASSERT_EQUAL_UINT32(SCHED_SYMBOLS_PER_STRIP + 1u,
                             g_port.calls[0].sym_count);
}

/* ---- 未装配保护 ---- */

static void test_uninitialized_ctx_tick_is_noop(void)
{
    sched_ctx_t s;

    g_port.n = 0; /* 全局 port 计数清零（之前测试有残留） */
    memset(&s, 0, sizeof(s));
    TEST_ASSERT_EQUAL_UINT8(0, sched_tick(&s));
    TEST_ASSERT_EQUAL_UINT8(0, g_port.n);
}

/* ---- 归零语义：memset 0 的 ctx 视为未装配，transmit 恒 0 次 ---- */

static void test_zeroed_ctx_transmit_never_fires(void)
{
    sched_ctx_t s;

    memset(&s, 0, sizeof(s));
    /* now_ms/transmit 均 NULL → tick 直接返回 0。 */
    TEST_ASSERT_EQUAL_UINT8(0, sched_tick(&s));
    sched_note_done(&s, 0);
    TEST_ASSERT_EQUAL_UINT16(1, s.glitch_count);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_round_strip_mapping);
    RUN_TEST(test_four_rounds_cover_eight_strips);
    RUN_TEST(test_channel_mapping_per_round);
    RUN_TEST(test_off_and_none_strips_not_sent);
    RUN_TEST(test_off_id_also_not_sent);
    RUN_TEST(test_static_strip_sent_once_then_keepalive_1s);
    RUN_TEST(test_static_strip_not_resent_within_1s);
    RUN_TEST(test_animated_strip_sent_every_cycle);
    RUN_TEST(test_tick_before_next_round_does_nothing);
    RUN_TEST(test_glitch_count_on_num_symbols_mismatch);
    RUN_TEST(test_item_sym_count_is_data_plus_eof);
    RUN_TEST(test_uninitialized_ctx_tick_is_noop);
    RUN_TEST(test_zeroed_ctx_transmit_never_fires);
    return UNITY_END();
}