// 灯效引擎 host 单测（firmware/effects，[env:native] Unity）。
// 覆盖 docs/spec/driver.md §7 的 D3/D4/D5 + 本票（#33）附加语义：
//   关灯全 0、周期类 strip/8 错开、星闪 hash 确定性。
// 断言走 effect_render / effect_is_time_varying 公共接口。

#include <unity.h>
#include <string.h>

#include "effect_engine.h"

#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

/* setUp/tearDown are defined once in test_driver.c (single test binary). */

/* ---------- 工具 ---------- */

/* 渲染一次并返回逐字节一致性：同 (t_ms,strip,cfg) 两次渲染必须逐字节相同。 */
static void render_twice_identical(uint8_t id, const uint8_t *params, uint8_t strip, uint32_t t_ms)
{
    uint8_t a[LIGHT_RGB_BYTES];
    uint8_t b[LIGHT_RGB_BYTES];
    memset(a, 0xAA, sizeof(a));
    memset(b, 0x55, sizeof(b));
    effect_render(id, params, strip, t_ms, a);
    effect_render(id, params, strip, t_ms, b);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(a, b, ARRAY_LEN(a));
}

/* 断言整条灯带全为 (r,g,b)（用于关灯 / 静态 / 冻结输出）。 */
static void assert_all_pixels(uint8_t id, const uint8_t *params, uint8_t strip,
                              uint32_t t_ms, uint8_t r, uint8_t g, uint8_t b)
{
    uint8_t rgb[LIGHT_RGB_BYTES];
    effect_render(id, params, strip, t_ms, rgb);
    for (int i = 0; i < LIGHT_LEDS; i++) {
        TEST_ASSERT_EQUAL_UINT8(r, rgb[i * 3 + 0]);
        TEST_ASSERT_EQUAL_UINT8(g, rgb[i * 3 + 1]);
        TEST_ASSERT_EQUAL_UINT8(b, rgb[i * 3 + 2]);
    }
}

/* 判断两条 render 输出逐字节是否一致。 */
static int render_equal(uint8_t id, const uint8_t *params, uint8_t s1, uint8_t s2, uint32_t t_ms)
{
    uint8_t a[LIGHT_RGB_BYTES];
    uint8_t b[LIGHT_RGB_BYTES];
    effect_render(id, params, s1, t_ms, a);
    effect_render(id, params, s2, t_ms, b);
    return memcmp(a, b, sizeof(a)) == 0;
}

/* ---------- D3: 7 灯效帧确定性 ---------- */

static void test_d3_all_effects_deterministic(void)
{
    /* 每个效果给一组典型参数，两次渲染逐字节相同。 */
    struct { uint8_t id; const uint8_t *params; } cases[] = {
        { EFFECT_OFF,        NULL },
        { EFFECT_STATIC,     (const uint8_t[]){ 0xFF, 0x80, 0x00 } },
        { EFFECT_BREATH,     (const uint8_t[]){ 0xFF, 0x00, 0x00, 0xE8, 0x03, 0x00, 0xFF } },
        { EFFECT_GRADIENT,   (const uint8_t[]){ 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xE8, 0x03, 0x00 } },
        { EFFECT_RAINBOW,    (const uint8_t[]){ 0xFF, 0xFF, 0x00 } },
        { EFFECT_FLOW,       (const uint8_t[]){ 0xFF, 0x00, 0x00, 0x80, 0x10, 0x00 } },
        { EFFECT_SPARKLE,    (const uint8_t[]){ 0xFF, 0xFF, 0xFF, 0x20, 0x40 } },
    };
    const uint32_t times[] = { 0u, 1u, 123u, 12345u, 4294967295u };
    for (unsigned c = 0; c < ARRAY_LEN(cases); c++) {
        for (uint8_t strip = 0; strip < LIGHT_STRIP_COUNT; strip++) {
            for (unsigned t = 0; t < ARRAY_LEN(times); t++) {
                render_twice_identical(cases[c].id, cases[c].params, strip, times[t]);
            }
        }
    }
}

/* ---------- 关灯全 0 ---------- */

static void test_off_all_zero(void)
{
    assert_all_pixels(EFFECT_OFF, NULL, 0, 0, 0, 0, 0);
    assert_all_pixels(EFFECT_OFF, NULL, 3, 4294967295u, 0, 0, 0);
    TEST_ASSERT_FALSE(effect_is_time_varying(EFFECT_OFF, NULL));
}

/* ---------- D4: speed=0 冻结 ---------- */

static void test_d4_speed_zero_freeze(void)
{
    /* 周期类效果 speed=0：任意 t_ms 输出与 t=0 相同，且判为静态。 */
    uint8_t frozen[LIGHT_RGB_BYTES];
    struct { uint8_t id; const uint8_t *params; } cases[] = {
        { EFFECT_BREATH,   (const uint8_t[]){ 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF } }, /* period_ms=0 */
        { EFFECT_GRADIENT, (const uint8_t[]){ 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00 } }, /* period_ms=0 */
        { EFFECT_RAINBOW,  (const uint8_t[]){ 0x00, 0xFF, 0x00 } },                          /* speed=0 */
        { EFFECT_FLOW,     (const uint8_t[]){ 0xFF, 0x00, 0x00, 0x00, 0x10, 0x00 } },        /* speed=0 */
        { EFFECT_SPARKLE,  (const uint8_t[]){ 0xFF, 0xFF, 0xFF, 0x20, 0x00 } },              /* speed=0 */
    };
    const uint32_t times[] = { 0u, 1u, 999u, 1000000u };
    for (unsigned c = 0; c < ARRAY_LEN(cases); c++) {
        for (uint8_t strip = 0; strip < LIGHT_STRIP_COUNT; strip++) {
            effect_render(cases[c].id, cases[c].params, strip, 0, frozen);
            for (unsigned t = 0; t < ARRAY_LEN(times); t++) {
                uint8_t now[LIGHT_RGB_BYTES];
                effect_render(cases[c].id, cases[c].params, strip, times[t], now);
                TEST_ASSERT_EQUAL_UINT8_ARRAY(frozen, now, ARRAY_LEN(now));
            }
            TEST_ASSERT_FALSE(effect_is_time_varying(cases[c].id, cases[c].params));
        }
    }
}

/* ---------- D5: 活动判定表 ---------- */

static void test_d5_activity_table(void)
{
    /* 6 个灯效 × speed=0/≠0 全部分类正确。
     * 静态/关灯恒 false；周期类 speed>0 才 true，speed=0 false。 */
    /* 静态、关灯恒 false： */
    TEST_ASSERT_FALSE(effect_is_time_varying(EFFECT_OFF, NULL));
    TEST_ASSERT_FALSE(effect_is_time_varying(EFFECT_STATIC, (const uint8_t[]){ 0xFF, 0x00, 0x00 }));

    /* 周期类 speed=0 → false，speed≠0 → true。 */
    TEST_ASSERT_FALSE(effect_is_time_varying(EFFECT_BREATH,   (const uint8_t[]){ 0, 0, 0, 0, 0, 0, 255 }));
    TEST_ASSERT_TRUE (effect_is_time_varying(EFFECT_BREATH,   (const uint8_t[]){ 0, 0, 0, 255, 0, 0, 255 }));

    TEST_ASSERT_FALSE(effect_is_time_varying(EFFECT_GRADIENT, (const uint8_t[]){ 0, 0, 0, 0, 0, 0, 0, 0, 0 }));
    TEST_ASSERT_TRUE (effect_is_time_varying(EFFECT_GRADIENT, (const uint8_t[]){ 0, 0, 0, 0, 0, 0, 255, 0, 0 }));

    TEST_ASSERT_FALSE(effect_is_time_varying(EFFECT_RAINBOW,  (const uint8_t[]){ 0, 255, 0 }));
    TEST_ASSERT_TRUE (effect_is_time_varying(EFFECT_RAINBOW,  (const uint8_t[]){ 1, 255, 0 }));

    TEST_ASSERT_FALSE(effect_is_time_varying(EFFECT_FLOW,     (const uint8_t[]){ 0, 0, 0, 0, 10, 0 }));
    TEST_ASSERT_TRUE (effect_is_time_varying(EFFECT_FLOW,     (const uint8_t[]){ 0, 0, 0, 1, 10, 0 }));

    TEST_ASSERT_FALSE(effect_is_time_varying(EFFECT_SPARKLE,  (const uint8_t[]){ 0, 0, 0, 32, 0 }));
    TEST_ASSERT_TRUE (effect_is_time_varying(EFFECT_SPARKLE,  (const uint8_t[]){ 0, 0, 0, 32, 64 }));
}

/* ---------- 周期类 strip/8 错开 ---------- */

static void test_strip8_phase_offset(void)
{
    /* 渐变 / 彩虹 / 流水是周期类，相位 frac(phase + strip/8)：
     * 同 t_ms 不同 strip 的帧必须不同。 */
    const uint32_t t = 5000u; /* 非冻结时刻 */

    /* 渐变：speed/period>0 */
    const uint8_t grad[] = { 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xE8, 0x03, 0x00 };
    TEST_ASSERT_TRUE(!render_equal(EFFECT_GRADIENT, grad, 0, 1, t));

    /* 彩虹 */
    const uint8_t rb[] = { 0xFF, 0xFF, 0x00 };
    TEST_ASSERT_TRUE(!render_equal(EFFECT_RAINBOW, rb, 0, 4, t));

    /* 流水 */
    const uint8_t flow[] = { 0xFF, 0x00, 0x00, 0x80, 0x10, 0x00 };
    TEST_ASSERT_TRUE(!render_equal(EFFECT_FLOW, flow, 0, 2, t));
}

/* ---------- 星闪 hash 确定性 ---------- */

static void test_sparkle_hash_deterministic(void)
{
    /* 星闪按 slot 推进：speed>0 时不同 t_ms 的帧可能不同；同 (t_ms,strip,cfg) 必相同（D3 已覆盖）。
     * 这里额外验证：同一 slot 边界内的相邻 t_ms 多数帧相同；且同 t 不同 strip 一般不同（hash 含 strip）。 */
    /* 这里额外验证两件事：
     *   1) 高密度下确实出现星点（否则测试空转）；
     *   2) hash 含 strip → 同 t 不同 strip 的星点分布不同，帧逐字节不同。
     * 用 density=255（最大）确保实际出现星点（density 过小时几乎全黑，帧可能恰相同）。 */
    const uint8_t spark[] = { 0xFF, 0x00, 0x00, 0xFF, 0x40 }; /* density=255, speed=64 */

    /* 1) t=0 时 strip0 至少出现一个非黑像素。 */
    uint8_t s0[LIGHT_RGB_BYTES];
    effect_render(EFFECT_SPARKLE, spark, 0, 0u, s0);
    int lit = 0;
    for (int i = 0; i < LIGHT_LEDS; i++) {
        if (s0[i * 3 + 0] || s0[i * 3 + 1] || s0[i * 3 + 2]) lit++;
    }
    TEST_ASSERT_TRUE(lit > 0);

    /* 2) 同 t=0 不同 strip：hash 不同 → 星点分布不同 → 帧逐字节不同。 */
    uint8_t s1[LIGHT_RGB_BYTES];
    effect_render(EFFECT_SPARKLE, spark, 1, 0u, s1);
    TEST_ASSERT_TRUE(memcmp(s0, s1, sizeof(s0)) != 0);
}

static void test_sparkle_hash_known_values(void)
{
    /* 锁定 effects.md §6.8 hash32 的字节值，防止实现漂移，给 t9 golden 一个对拍锚。 */
    TEST_ASSERT_EQUAL_UINT32(0x00000000u, effect_sparkle_hash(0, 0, 0));
    TEST_ASSERT_EQUAL_UINT32(0x6d523710u, effect_sparkle_hash(1, 0, 0));
    TEST_ASSERT_EQUAL_UINT32(0x1efee872u, effect_sparkle_hash(0, 1, 0));
    TEST_ASSERT_EQUAL_UINT32(0x61d77ce2u, effect_sparkle_hash(0, 0, 1));
    TEST_ASSERT_EQUAL_UINT32(0xc3cc0cffu, effect_sparkle_hash(5, 3, 2));
    TEST_ASSERT_EQUAL_UINT32(0x78c9f3f2u, effect_sparkle_hash(99, 7, 7));
}

/* ---------- 呼吸正弦：p=0 为最小、p=0.5 为最大 ---------- */

static void test_breath_sine_extremes(void)
{
    /* period=1000ms，min=0，max=255：p=0(t=0) ⇒ level=0 ⇒ 全黑；
     * p=0.5(t=500) ⇒ level=255 ⇒ 全条非黑且各像素一致（呼吸不错开，整条同色）。 */
    const uint8_t breath[] = { 0xFF, 0x00, 0x00, 0xE8, 0x03, 0x00, 0xFF };

    assert_all_pixels(EFFECT_BREATH, breath, 0, 0u, 0, 0, 0);

    uint8_t rgb[LIGHT_RGB_BYTES];
    effect_render(EFFECT_BREATH, breath, 0, 500u, rgb);
    /* 至少非全黑，且所有像素相同（呼吸整条同步）。 */
    int lit = 0;
    for (int i = 0; i < LIGHT_LEDS; i++) {
        if (rgb[i * 3 + 0] || rgb[i * 3 + 1] || rgb[i * 3 + 2]) lit++;
        TEST_ASSERT_EQUAL_UINT8(rgb[0], rgb[i * 3 + 0]);
        TEST_ASSERT_EQUAL_UINT8(rgb[1], rgb[i * 3 + 1]);
        TEST_ASSERT_EQUAL_UINT8(rgb[2], rgb[i * 3 + 2]);
    }
    TEST_ASSERT_EQUAL_INT(LIGHT_LEDS, lit);
}

/* ---------- 注册入口（由 test_driver.c 的统一 main 调用） ---------- */

/* 本文件定义全部灯效测试；main() 唯一性由 test_driver.c 统一持有。 */
void run_effects_tests(void)
{
    RUN_TEST(test_d3_all_effects_deterministic);
    RUN_TEST(test_off_all_zero);
    RUN_TEST(test_d4_speed_zero_freeze);
    RUN_TEST(test_d5_activity_table);
    RUN_TEST(test_strip8_phase_offset);
    RUN_TEST(test_sparkle_hash_deterministic);
    RUN_TEST(test_sparkle_hash_known_values);
    RUN_TEST(test_breath_sine_extremes);
}