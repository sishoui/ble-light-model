/*
 * 灯效引擎单测（native / Unity）。
 *
 * 断言基准：参数布局来自 #4 决议第 3 节；动画色轮（hue→RGB）用逐通道字面量
 * 手算（与实现同源的 FastLED CHSV 色轮是独立事实源）。时间全部注入，测试不
 * 依赖真实时钟。
 */

#include <string.h>

#include <unity.h>

#include "effect_engine.h"

void setUp(void)
{
}

void tearDown(void)
{
}

#define LEDS EFFECT_LEDS_PER_STRIP
#define RGB(i, r, g, b) TEST_ASSERT_EQUAL_UINT8(r, out[(i) * 3 + 0]); \
                        TEST_ASSERT_EQUAL_UINT8(g, out[(i) * 3 + 1]); \
                        TEST_ASSERT_EQUAL_UINT8(b, out[(i) * 3 + 2])

static void render(effect_ctx_t *ctx, uint8_t strip, uint32_t now_ms, uint8_t *out)
{
    memset(out, 0, LEDS * 3);
    effect_render(ctx, strip, now_ms, out);
}

/* ---------- 初始状态 ---------- */

static void test_init_all_strips_off(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    uint8_t s;

    effect_init(&ctx);
    for (s = 0; s < EFFECT_STRIP_COUNT; s++) {
        TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, effect_active_id(&ctx, s));
        render(&ctx, s, 0, out);
        TEST_ASSERT_EACH_EQUAL_UINT8(0, out, LEDS * 3);
    }
}

/* ---------- 0x00 关灯 ---------- */

static void test_effect_off_blacks_out_previous_effect(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    static const uint8_t on[] = {EFFECT_ID_STATIC, 255, 0, 0};
    /* 0x00 关灯：只有 effect_id 一个字节（期望参数长度 0），mask 选中的灯带全灭。 */
    static const uint8_t off[] = {EFFECT_ID_OFF};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, on, sizeof(on), 0));
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, off, sizeof(off), 100));
    render(&ctx, 0, 100, out);
    TEST_ASSERT_EACH_EQUAL_UINT8(0, out, LEDS * 3);
    /* 关灯后 effect_id 仍是 0x00（active_effect 语义：当前效果是"关"）。 */
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_OFF, effect_active_id(&ctx, 0));
}

/* ---------- 0x01 静态 ---------- */

static void test_effect_static_fills_strip_with_rgb(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    static const uint8_t p[] = {EFFECT_ID_STATIC, 12, 200, 34};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 0));
    render(&ctx, 0, 0, out);
    TEST_ASSERT_EQUAL_UINT8(12, out[0]);
    TEST_ASSERT_EQUAL_UINT8(200, out[1]);
    TEST_ASSERT_EQUAL_UINT8(34, out[2]);
    /* 所有灯珠同色，逻辑 RGB 顺序：out[i*3] 始终是 R。 */
    TEST_ASSERT_EQUAL_UINT8(12, out[(LEDS - 1) * 3 + 0]);
    TEST_ASSERT_EQUAL_UINT8(200, out[(LEDS - 1) * 3 + 1]);
    TEST_ASSERT_EQUAL_UINT8(34, out[(LEDS - 1) * 3 + 2]);
}

/* ---------- 0x02 呼吸 ---------- */

static void test_effect_breath_period_and_scale(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    /* R=200, period=1000ms, min=0, max=255：半周期 500ms 到峰值。 */
    static const uint8_t p[] = {EFFECT_ID_BREATH, 200, 0, 0, 0xE8, 0x03, 0x00, 0xFF};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 1000));

    /* t=0：三角形波起点 = min。 */
    render(&ctx, 0, 1000, out);
    TEST_ASSERT_EQUAL_UINT8(0, out[0]);

    /* t=250ms（1/4 周期）：scale = 127/255 ≈ 0.498 → R=99。 */
    render(&ctx, 0, 1250, out);
    TEST_ASSERT_EQUAL_UINT8(99, out[0]);

    /* t=500ms（半周期）：峰值 = max → R=200（底色 R=200 × max）。 */
    render(&ctx, 0, 1500, out);
    TEST_ASSERT_EQUAL_UINT8(200, out[0]);

    /* t=750ms：对称回落 → R=99。 */
    render(&ctx, 0, 1750, out);
    TEST_ASSERT_EQUAL_UINT8(99, out[0]);

    /* t=1000ms：整周期回到 min。 */
    render(&ctx, 0, 2000, out);
    TEST_ASSERT_EQUAL_UINT8(0, out[0]);
}

/* ---------- 0x03 渐变 ---------- */

static void test_effect_gradient_two_colors_along_strip(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    /* 红→蓝，period=1000，direction=0（正向），末尾 1 保留字节。 */
    static const uint8_t p[] = {EFFECT_ID_GRADIENT, 255, 0, 0, 0, 0, 255, 0xE8, 0x03, 0x00, 0x00};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 0));

    /* 时间无关：渲染结果对 now_ms 不变（静态渐变）。 */
    render(&ctx, 0, 0, out);
    RGB(0, 255, 0, 0);
    /* 中点 i=30：位置 30/59 → R=255*29/59=125, B=255*30/59=129。 */
    RGB(30, 125, 0, 129);
    /* 末端 i=59：B 满 → (0,0,255)。 */
    RGB(59, 0, 0, 255);

    render(&ctx, 0, 12345, out);
    RGB(0, 255, 0, 0);
    RGB(30, 125, 0, 129);
}

static void test_effect_gradient_reverse_direction(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    static const uint8_t p[] = {EFFECT_ID_GRADIENT, 255, 0, 0, 0, 0, 255, 0xE8, 0x03, 0x01, 0x00};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 0));
    render(&ctx, 0, 0, out);
    /* 反向：头部是第二色、尾部是第一色。 */
    RGB(0, 0, 0, 255);
    RGB(30, 129, 0, 125);
    RGB(59, 255, 0, 0);
}

/* ---------- 0x04 彩虹 ---------- */

static void test_effect_rainbow_hue_wheel_and_speed(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    /* speed=0（冻结）、saturation=255、direction=0。 */
    static const uint8_t p[] = {EFFECT_ID_RAINBOW, 0, 255, 0};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 0));

    /* 满色轮：hue 0 = 红；i=40 → hue 40*256/60=170（区域 3）→ (0,3,255)。 */
    render(&ctx, 0, 0, out);
    RGB(0, 255, 0, 0);
    RGB(40, 0, 3, 255);

    /* 彩虹随 now_ms 流动：speed=255 时 1000ms 推进 255*1000/16=15937 色步，
     * 15937 & 0xFF = 65 → 头部色轮 65（绿区）→ (0,255,0)。 */
    static const uint8_t p2[] = {EFFECT_ID_RAINBOW, 255, 255, 0};
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p2, sizeof(p2), 0));
    render(&ctx, 0, 0, out);
    TEST_ASSERT_EQUAL_UINT8(255, out[0]);
    render(&ctx, 0, 1000, out);
    /* flow = 255*1000/16 = 15937，15937 & 0xFF = 65 → 区域 1（黄→绿）→ (121,255,0)。 */
    RGB(0, 121, 255, 0);
}

static void test_effect_rainbow_reverse_mirrors_direction(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    static const uint8_t p[] = {EFFECT_ID_RAINBOW, 0, 255, 1};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 0));
    render(&ctx, 0, 0, out);
    /* 反向：头部是色轮尾段 hue=251（洋红偏红）→ (255,0,29)；尾部 hue=0 → 红。 */
    RGB(0, 255, 0, 29);
    RGB(LEDS - 1, 255, 0, 0);
}

/* ---------- 0x05 流水 ---------- */

static void test_effect_flow_moves_head_along_strip(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    /* R=255，speed=1（每 16ms 一步），length=3，direction=0，末尾 1 保留。 */
    static const uint8_t p[] = {EFFECT_ID_FLOW, 255, 0, 0, 1, 3, 0, 0};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 100));

    /* t=100ms：头在 i=0，覆盖 i=0..2。 */
    render(&ctx, 0, 100, out);
    TEST_ASSERT_EQUAL_UINT8(255, out[0]);
    TEST_ASSERT_EQUAL_UINT8(255, out[2 * 3 + 0]);
    TEST_ASSERT_EQUAL_UINT8(0, out[3 * 3 + 0]);
    TEST_ASSERT_EQUAL_UINT8(0, out[(LEDS - 1) * 3 + 0]);

    /* t=116ms（+16ms 一步）：头移到 i=1。 */
    render(&ctx, 0, 116, out);
    TEST_ASSERT_EQUAL_UINT8(0, out[0]);
    TEST_ASSERT_EQUAL_UINT8(255, out[1 * 3 + 0]);
    TEST_ASSERT_EQUAL_UINT8(255, out[3 * 3 + 0]);
    TEST_ASSERT_EQUAL_UINT8(0, out[4 * 3 + 0]);

    /* 反向：头从尾部向头部走。 */
    static const uint8_t pr[] = {EFFECT_ID_FLOW, 255, 0, 0, 1, 3, 1, 0};
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, pr, sizeof(pr), 200));
    render(&ctx, 0, 200, out);
    TEST_ASSERT_EQUAL_UINT8(255, out[(LEDS - 1) * 3 + 0]);
    TEST_ASSERT_EQUAL_UINT8(255, out[(LEDS - 3) * 3 + 0]);
    TEST_ASSERT_EQUAL_UINT8(0, out[(LEDS - 4) * 3 + 0]);
    render(&ctx, 0, 216, out);
    TEST_ASSERT_EQUAL_UINT8(0, out[(LEDS - 1) * 3 + 0]);
    TEST_ASSERT_EQUAL_UINT8(255, out[(LEDS - 2) * 3 + 0]);
}

/* ---------- 0x06 星闪 ---------- */

static void test_effect_twinkle_sparse_lights_change_with_frames(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    /* R=255，density=64（点亮概率 64/256=25%），speed=0。 */
    static const uint8_t p[] = {EFFECT_ID_TWINKLE, 255, 0, 0, 64, 0};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 0));

    render(&ctx, 0, 0, out);
    /* 确定性 LCG 抽取：约 1/4 灯珠点亮（不是全亮也不是全灭）。 */
    int lit = 0;
    for (unsigned i = 0; i < LEDS; i++) {
        if (out[i * 3 + 0] != 0) lit++;
    }
    TEST_ASSERT_TRUE_MESSAGE(lit > 0 && (unsigned)lit < LEDS / 2u, "density=64 应稀疏点亮");

    /* 全部亮灯同色（单色星闪）。 */
    for (unsigned i = 0; i < LEDS; i++) {
        if (out[i * 3 + 0] != 0) {
            TEST_ASSERT_EQUAL_UINT8(255, out[i * 3 + 0]);
            TEST_ASSERT_EQUAL_UINT8(0, out[i * 3 + 1]);
            TEST_ASSERT_EQUAL_UINT8(0, out[i * 3 + 2]);
        }
    }
}

static void test_effect_twinkle_density_max_lights_all(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    /* density=255：几乎必亮，全部灯珠点亮。 */
    static const uint8_t p[] = {EFFECT_ID_TWINKLE, 0, 255, 0, 255, 0};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 0));
    render(&ctx, 0, 0, out);
    for (unsigned i = 0; i < LEDS; i++) {
        TEST_ASSERT_EQUAL_UINT8(0, out[i * 3 + 0]);
        TEST_ASSERT_EQUAL_UINT8(255, out[i * 3 + 1]);
        TEST_ASSERT_EQUAL_UINT8(0, out[i * 3 + 2]);
    }
}

static void test_effect_twinkle_density_zero_is_dark(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    static const uint8_t p[] = {EFFECT_ID_TWINKLE, 255, 255, 255, 0, 100};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, p, sizeof(p), 0));
    render(&ctx, 0, 0, out);
    TEST_ASSERT_EACH_EQUAL_UINT8(0, out, LEDS * 3);
}

/* ---------- 参数校验 ---------- */

static void test_effect_apply_length_too_short_is_length_mismatch(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    /* 呼吸需要 7 参数，只给 3。 */
    static const uint8_t short_p[] = {EFFECT_ID_BREATH, 1, 2, 3};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ERR_LENGTH_MISMATCH,
                            effect_apply(&ctx, 0x01, short_p, sizeof(short_p), 0));
    /* 失败不改状态：灯带仍是 off。 */
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, effect_active_id(&ctx, 0));
    render(&ctx, 0, 0, out);
    TEST_ASSERT_EACH_EQUAL_UINT8(0, out, LEDS * 3);
}

static void test_effect_apply_length_overlong_ignores_extra(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    /* 静态需要 3 参数，给 6（多 3 个垃圾字节）。 */
    static const uint8_t long_p[] = {EFFECT_ID_STATIC, 10, 20, 30, 0xDE, 0xAD, 0xBE};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, long_p, sizeof(long_p), 0));
    render(&ctx, 0, 0, out);
    TEST_ASSERT_EQUAL_UINT8(10, out[0]);
    TEST_ASSERT_EQUAL_UINT8(20, out[1]);
    TEST_ASSERT_EQUAL_UINT8(30, out[2]);
}

static void test_effect_apply_unknown_effect_id(void)
{
    effect_ctx_t ctx;
    static const uint8_t p[] = {0x07, 1, 2, 3};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ERR_UNKNOWN_EFFECT,
                            effect_apply(&ctx, 0x01, p, sizeof(p), 0));
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, effect_active_id(&ctx, 0));
}

static void test_effect_apply_empty_payload_for_effect_with_params(void)
{
    effect_ctx_t ctx;
    static const uint8_t only_id[] = {EFFECT_ID_BREATH};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ERR_LENGTH_MISMATCH,
                            effect_apply(&ctx, 0x01, only_id, sizeof(only_id), 0));
}

static void test_effect_apply_invalid_param_semantics(void)
{
    effect_ctx_t ctx;

    effect_init(&ctx);
    /* direction 只有 0/1 合法。 */
    static const uint8_t bad_dir[] = {EFFECT_ID_GRADIENT, 255, 0, 0, 0, 0, 255, 0xE8, 0x03, 2, 0x00};
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ERR_INVALID_PARAM,
                            effect_apply(&ctx, 0x01, bad_dir, sizeof(bad_dir), 0));
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, effect_active_id(&ctx, 0));
}

/* ---------- strip_mask 隔离 ---------- */

static void test_strip_mask_only_updates_selected(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    static const uint8_t red[] = {EFFECT_ID_STATIC, 255, 0, 0};
    static const uint8_t blue[] = {EFFECT_ID_STATIC, 0, 0, 255};

    effect_init(&ctx);
    /* L0 = 红。 */
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, red, sizeof(red), 0));
    /* mask 0x06 只动 L1/L2：设蓝。 */
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x06, blue, sizeof(blue), 10));

    render(&ctx, 0, 0, out);
    TEST_ASSERT_EQUAL_UINT8(255, out[0]);
    TEST_ASSERT_EQUAL_UINT8(0, out[2]);
    render(&ctx, 1, 0, out);
    TEST_ASSERT_EQUAL_UINT8(0, out[0]);
    TEST_ASSERT_EQUAL_UINT8(255, out[2]);
    render(&ctx, 2, 0, out);
    TEST_ASSERT_EQUAL_UINT8(0, out[0]);
    TEST_ASSERT_EQUAL_UINT8(255, out[2]);
    /* 未选中的 L3 仍是 off。 */
    render(&ctx, 3, 0, out);
    TEST_ASSERT_EACH_EQUAL_UINT8(0, out, LEDS * 3);
}

static void test_strips_keep_independent_effects(void)
{
    effect_ctx_t ctx;
    uint8_t out[LEDS * 3];
    static const uint8_t red[] = {EFFECT_ID_STATIC, 255, 0, 0};
    static const uint8_t breath[] = {EFFECT_ID_BREATH, 100, 0, 0, 0xE8, 0x03, 0x00, 0xFF};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x01, red, sizeof(red), 0));
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x02, breath, sizeof(breath), 0));

    render(&ctx, 0, 500, out); /* L0 静态：不随时间变。 */
    TEST_ASSERT_EQUAL_UINT8(255, out[0]);
    render(&ctx, 1, 500, out); /* L1 呼吸半周期：level=255，底色 R=100。 */
    TEST_ASSERT_EQUAL_UINT8(100, out[0]);
}

static void test_strip_mask_zero_is_noop_ok(void)
{
    effect_ctx_t ctx;
    static const uint8_t red[] = {EFFECT_ID_STATIC, 255, 0, 0};

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0x00, red, sizeof(red), 0));
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, effect_active_id(&ctx, 0));
}

/* ---------- 引擎 ↔ 协议层集成（SET_EFFECT 帧 → 渲染） ---------- */

static void test_proto_frame_set_effect_then_render(void)
{
    effect_ctx_t ctx;
    ble_proto_frame_t frame;
    ble_proto_feed_t feed;
    ble_proto_frame_t frames[1];
    ble_proto_error_t errors[1];
    size_t errs = 0;
    uint8_t out[LEDS * 3];

    /* 手拼一帧 SET_EFFECT：L0 静态绿。payload = 01 00 255 00。 */
    memset(&frame, 0, sizeof(frame));
    frame.version = 1;
    frame.seq = 7;
    frame.type = BLE_PROTO_TYPE_SET_EFFECT;
    frame.strip_mask = 0x01;
    frame.payload_len = 4;
    frame.payload[0] = EFFECT_ID_STATIC;
    frame.payload[1] = 0;
    frame.payload[2] = 255;
    frame.payload[3] = 0;

    uint8_t bytes[BLE_PROTO_MAX_FRAME];
    size_t n = ble_proto_encode(&frame, bytes, sizeof(bytes));
    TEST_ASSERT_TRUE(n > 0);

    memset(&feed, 0, sizeof(feed));
    TEST_ASSERT_EQUAL_UINT32(1, ble_proto_feed(&feed, bytes, n, frames, 1, errors, 1, &errs));
    TEST_ASSERT_EQUAL_UINT32(0, errs);

    effect_init(&ctx);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK,
                            effect_apply(&ctx, frames[0].strip_mask,
                                         frames[0].payload, frames[0].payload_len, 0));
    render(&ctx, 0, 0, out);
    TEST_ASSERT_EQUAL_UINT8(0, out[0]);
    TEST_ASSERT_EQUAL_UINT8(255, out[1]);
    TEST_ASSERT_EQUAL_UINT8(0, out[2]);
}

/* ---------- render_all 帧周期 ---------- */

static void test_render_all_renders_every_strip(void)
{
    effect_ctx_t ctx;
    uint8_t out[EFFECT_STRIP_COUNT * LEDS * 3];
    static const uint8_t red[] = {EFFECT_ID_STATIC, 255, 0, 0};

    effect_init(&ctx);
    /* 全掩码：8 路都设红，验证 render_all 逐路输出。 */
    TEST_ASSERT_EQUAL_UINT8(EFFECT_OK, effect_apply(&ctx, 0xFF, red, sizeof(red), 0));

    effect_render_all(&ctx, 0, out, sizeof(out));
    for (uint8_t s = 0; s < EFFECT_STRIP_COUNT; s++) {
        TEST_ASSERT_EQUAL_UINT8(255, out[(s * LEDS) * 3 + 0]);
        TEST_ASSERT_EQUAL_UINT8(0, out[(s * LEDS) * 3 + 1]);
        TEST_ASSERT_EQUAL_UINT8(0, out[(s * LEDS) * 3 + 2]);
    }
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_init_all_strips_off);
    RUN_TEST(test_effect_off_blacks_out_previous_effect);
    RUN_TEST(test_effect_static_fills_strip_with_rgb);
    RUN_TEST(test_effect_breath_period_and_scale);
    RUN_TEST(test_effect_gradient_two_colors_along_strip);
    RUN_TEST(test_effect_gradient_reverse_direction);
    RUN_TEST(test_effect_rainbow_hue_wheel_and_speed);
    RUN_TEST(test_effect_rainbow_reverse_mirrors_direction);
    RUN_TEST(test_effect_flow_moves_head_along_strip);
    RUN_TEST(test_effect_twinkle_sparse_lights_change_with_frames);
    RUN_TEST(test_effect_twinkle_density_max_lights_all);
    RUN_TEST(test_effect_twinkle_density_zero_is_dark);
    RUN_TEST(test_effect_apply_length_too_short_is_length_mismatch);
    RUN_TEST(test_effect_apply_length_overlong_ignores_extra);
    RUN_TEST(test_effect_apply_unknown_effect_id);
    RUN_TEST(test_effect_apply_empty_payload_for_effect_with_params);
    RUN_TEST(test_effect_apply_invalid_param_semantics);
    RUN_TEST(test_strip_mask_only_updates_selected);
    RUN_TEST(test_strips_keep_independent_effects);
    RUN_TEST(test_strip_mask_zero_is_noop_ok);
    RUN_TEST(test_proto_frame_set_effect_then_render);
    RUN_TEST(test_render_all_renders_every_strip);
    return UNITY_END();
}