/*
 * C3 灯效引擎实现（纯 C99，不依赖 Arduino / IDF，不用动态内存）。
 *
 * 参数布局、灯效编号与期望长度以 #4 决议第 3 节为唯一事实源；期望长度直接
 * 复用 ble_proto_effect_param_length（proto/ 的长度表），本文件不维护第二份。
 * 协议层（proto/）不认识灯效语义：语义只在本文件。
 *
 * 时间模型：所有动画都是 now_ms 的纯函数（呼吸/渐变/彩虹/流水）或由
 * apply/render 调用次数推进的帧计数（星闪），不读任何时钟，host 单测可
 * 注入任意时刻断言中间帧。
 *
 * 输出：逻辑 RGB（out[i*3+0]=R），WS2812 的 GRB 转换、亮度缩放、限流在
 * 驱动层（#13/#14），本层不做。
 */

#include "effect_engine.h"

#include <string.h>

#include "ble_proto.h"

void effect_init(effect_ctx_t *ctx)
{
    memset(ctx, 0, sizeof(*ctx));
    for (uint8_t s = 0; s < EFFECT_STRIP_COUNT; s++) {
        ctx->strips[s].effect_id = EFFECT_ID_NONE;
    }
}

uint8_t effect_active_id(const effect_ctx_t *ctx, uint8_t strip)
{
    if (strip >= EFFECT_STRIP_COUNT) {
        return EFFECT_ID_NONE;
    }
    return ctx->strips[strip].effect_id;
}

/* ---------- 参数校验：语义越界 -> EFFECT_ERR_INVALID_PARAM ---------- */

static uint8_t validate_params(uint8_t effect_id, const uint8_t *params)
{
    switch (effect_id) {
    case EFFECT_ID_STATIC:
    case EFFECT_ID_OFF:
        return EFFECT_OK;
    case EFFECT_ID_BREATH:
        /* period 必须非零，否则相位取模除零。 */
        if (params[3] == 0 && params[4] == 0) {
            return EFFECT_ERR_INVALID_PARAM;
        }
        return EFFECT_OK;
    case EFFECT_ID_GRADIENT:
        if (params[8] > 1u) {
            return EFFECT_ERR_INVALID_PARAM;
        }
        return EFFECT_OK;
    case EFFECT_ID_RAINBOW:
    case EFFECT_ID_FLOW:
    case EFFECT_ID_TWINKLE:
        return EFFECT_OK;
    default:
        return EFFECT_ERR_UNKNOWN_EFFECT;
    }
}

uint8_t effect_apply(effect_ctx_t *ctx, uint8_t strip_mask,
                     const uint8_t *payload, uint8_t len, uint32_t now_ms)
{
    uint8_t effect_id;
    int expected;

    if (strip_mask == 0u) {
        /* 协议规定：mask 0 无动作，不是错误。 */
        return EFFECT_OK;
    }
    if (len < 1u) {
        return EFFECT_ERR_LENGTH_MISMATCH;
    }
    effect_id = payload[0];
    expected = ble_proto_effect_param_length(effect_id);
    if (expected < 0) {
        return EFFECT_ERR_UNKNOWN_EFFECT;
    }
    /* 短于 1+期望参数长度 -> 长度错；长于 -> 接受、多余忽略。 */
    if (len < (uint8_t)(1u + expected)) {
        return EFFECT_ERR_LENGTH_MISMATCH;
    }
    {
        const uint8_t *params = payload + 1;
        uint8_t rc = validate_params(effect_id, params);

        if (rc != EFFECT_OK) {
            return rc;
        }
        for (uint8_t s = 0; s < EFFECT_STRIP_COUNT; s++) {
            effect_strip_t *st;

            if ((strip_mask & (uint8_t)(1u << s)) == 0u) {
                continue;
            }
            st = &ctx->strips[s];
            st->effect_id = effect_id;
            st->param_len = (uint8_t)expected;
            memset(st->params, 0, sizeof(st->params));
            if (expected > 0) {
                memcpy(st->params, params, (size_t)expected);
            }
            st->start_ms = now_ms;
        }
    }
    return EFFECT_OK;
}

/* ---------- 像素输出公共工具 ---------- */

static void put_rgb(uint8_t *out, unsigned led, uint8_t r, uint8_t g, uint8_t b)
{
    out[led * 3u + 0u] = r;
    out[led * 3u + 1u] = g;
    out[led * 3u + 2u] = b;
}

static void fill_rgb(uint8_t *out, uint8_t r, uint8_t g, uint8_t b)
{
    for (unsigned i = 0; i < EFFECT_LEDS_PER_STRIP; i++) {
        put_rgb(out, i, r, g, b);
    }
}

/*
 * FastLED CHSV 同款色轮：饱和=满、value=满的 HSV 转 RGB（6 段线性）。
 * hue 输入 0–255 表示整圈；返回 (r,g,b) 各 0–255。
 * 色轮是这个文件里逐通道字面量断言（测试）所对齐的独立事实源。
 */
static void hue_to_rgb(uint8_t hue, uint8_t *r, uint8_t *g, uint8_t *b)
{
    uint8_t region = (uint8_t)((uint16_t)hue * 6u >> 8); /* 0..5 */
    uint8_t rem = (uint8_t)((uint16_t)hue * 6u - (uint16_t)region * 256u);
    uint8_t up, down;

    /* rem 是段内位置 0–255；线性项 (255-rem) 与 rem。 */
    up = (uint8_t)(255u - rem);
    down = rem;
    switch (region) {
    case 0: *r = 255; *g = down; *b = 0; break;   /* 红 -> 黄 */
    case 1: *r = up;   *g = 255; *b = 0; break;   /* 黄 -> 绿 */
    case 2: *r = 0;    *g = 255; *b = down; break; /* 绿 -> 青 */
    case 3: *r = 0;    *g = up;   *b = 255; break; /* 青 -> 蓝 */
    case 4: *r = down; *g = 0;    *b = 255; break; /* 蓝 -> 洋红 */
    default: *r = 255; *g = 0;    *b = up; break;  /* 洋红 -> 红 */
    }
}

/* ---------- 各灯效渲染 ---------- */

static void render_off(uint8_t *out)
{
    fill_rgb(out, 0, 0, 0);
}

static void render_static(const effect_strip_t *st, uint8_t *out)
{
    fill_rgb(out, st->params[0], st->params[1], st->params[2]);
}

static void render_breath(const effect_strip_t *st, uint32_t now_ms, uint8_t *out)
{
    /* params: R,G,B, period_ms(2 LE), min, max */
    uint32_t period = (uint32_t)st->params[3] | ((uint32_t)st->params[4] << 8);
    uint8_t min = st->params[5];
    uint8_t max = st->params[6];
    uint32_t phase = (now_ms - st->start_ms) % period; /* 0..period-1 */
    uint32_t half = period / 2u;
    uint32_t tri; /* 0..half：三角波，半周期处达峰 */
    uint32_t span = (uint32_t)max - (uint32_t)min;
    uint8_t level;

    if (phase < half) {
        tri = phase;
    } else {
        tri = period - phase;
    }
    /* 三角波线性插值 min..max（half 处正好 max）。 */
    level = (uint8_t)(min + (uint8_t)((span * tri) / (half != 0u ? half : 1u)));
    fill_rgb(out, (uint8_t)((uint16_t)st->params[0] * level / 255u),
             (uint8_t)((uint16_t)st->params[1] * level / 255u),
             (uint8_t)((uint16_t)st->params[2] * level / 255u));
}

static void render_gradient(const effect_strip_t *st, uint8_t *out)
{
    /* params: R1,G1,B1, R2,G2,B2, period_ms(2 LE), direction, 保留(1)。
     * 长度表（canonical）给渐变 10 个参数字节，字段清单只有 9 个 —— 末尾 1
     * 字节是保留位（忽略），direction 在 params[8]。 */
    uint8_t direction = st->params[8];

    for (unsigned i = 0; i < EFFECT_LEDS_PER_STRIP; i++) {
        /* t = i/(N-1) 的位置混合，方向翻转整条灯带。 */
        unsigned pos = direction == 0u ? i : (EFFECT_LEDS_PER_STRIP - 1u - i);
        uint8_t r = (uint8_t)(((uint16_t)st->params[0] * (EFFECT_LEDS_PER_STRIP - 1u - pos) +
                               (uint16_t)st->params[3] * pos) / (EFFECT_LEDS_PER_STRIP - 1u));
        uint8_t g = (uint8_t)(((uint16_t)st->params[1] * (EFFECT_LEDS_PER_STRIP - 1u - pos) +
                               (uint16_t)st->params[4] * pos) / (EFFECT_LEDS_PER_STRIP - 1u));
        uint8_t b = (uint8_t)(((uint16_t)st->params[2] * (EFFECT_LEDS_PER_STRIP - 1u - pos) +
                               (uint16_t)st->params[5] * pos) / (EFFECT_LEDS_PER_STRIP - 1u));
        put_rgb(out, i, r, g, b);
    }
}

static void render_rainbow(const effect_strip_t *st, uint32_t now_ms, uint8_t *out)
{
    /* params: speed, saturation, direction */
    uint8_t speed = st->params[0];
    uint8_t sat = st->params[1];
    uint8_t direction = st->params[2];
    uint32_t elapsed = now_ms - st->start_ms;

    for (unsigned i = 0; i < EFFECT_LEDS_PER_STRIP; i++) {
        /* 色轮相位：灯珠沿灯带铺开 + 随时间流动；speed=0 时冻结在初始排布。 */
        unsigned pos = direction == 0u ? i : (EFFECT_LEDS_PER_STRIP - 1u - i);
        uint32_t base = ((uint32_t)pos * 256u) / EFFECT_LEDS_PER_STRIP;
        uint32_t flow = ((uint32_t)speed * elapsed) / 16u; /* 每 16ms 走 speed 个色步 */
        uint8_t hue = (uint8_t)((base + flow) & 0xFFu);
        uint8_t r, g, b;

        hue_to_rgb(hue, &r, &g, &b);
        if (sat < 255u) {
            /* 饱和度缩放：向白色靠拢（业务上 v1 只会收到 255，防御性保留）。 */
            r = (uint8_t)(255u - ((255u - r) * sat) / 255u);
            g = (uint8_t)(255u - ((255u - g) * sat) / 255u);
            b = (uint8_t)(255u - ((255u - b) * sat) / 255u);
        }
        put_rgb(out, i, r, g, b);
    }
}

static void render_flow(const effect_strip_t *st, uint32_t now_ms, uint8_t *out)
{
    /* params: R,G,B, speed, length, direction */
    uint8_t speed = st->params[3];
    uint8_t length = st->params[4];
    uint8_t direction = st->params[5];
    uint32_t elapsed = now_ms - st->start_ms;
    unsigned step = (unsigned)(((uint32_t)speed * elapsed) / 16u); /* 每 16ms 走 speed 步 */
    unsigned head;

    fill_rgb(out, 0, 0, 0);
    if (length == 0u) {
        return; /* 长度 0：全灭（防御，业务侧应为 1..N）。 */
    }
    if (length > EFFECT_LEDS_PER_STRIP) {
        length = EFFECT_LEDS_PER_STRIP;
    }
    if (direction == 0u) {
        head = step % EFFECT_LEDS_PER_STRIP;
    } else {
        /* 反向：头从灯带尾部（N-1）起步，向头部方向走。 */
        head = (EFFECT_LEDS_PER_STRIP - 1u - step) % EFFECT_LEDS_PER_STRIP;
    }
    for (unsigned k = 0; k < length; k++) {
        unsigned led = direction == 0u ? (head + k) % EFFECT_LEDS_PER_STRIP
                                       : (head + EFFECT_LEDS_PER_STRIP - k) % EFFECT_LEDS_PER_STRIP;
        put_rgb(out, led, st->params[0], st->params[1], st->params[2]);
    }
}

static void render_twinkle(const effect_strip_t *st, uint8_t strip, uint32_t now_ms, uint8_t *out)
{
    /* params: R,G,B, density, speed。确定性 LCG 序列按 时间×speed 推进：
     * speed=0 冻结在第 0 帧；speed=255 时 1s 换 255 帧图案。灯带号参与种子，
     * 各灯带图案互相错开。 */
    uint8_t density = st->params[3];
    uint8_t speed = st->params[4];
    uint32_t elapsed = now_ms - st->start_ms;
    uint32_t frame = speed == 0u ? 0u : (elapsed * speed) / 1000u;
    uint32_t seed = frame * 2654435761u + (uint32_t)strip * 97u + 1u;

    fill_rgb(out, 0, 0, 0);
    if (density == 0u) {
        return;
    }
    for (unsigned i = 0; i < EFFECT_LEDS_PER_STRIP; i++) {
        /* LCG 抽取：[0,255] 均匀，阈值密度决定点亮概率。 */
        seed = seed * 1664525u + 1013904223u;
        if ((seed >> 24) < density) {
            put_rgb(out, i, st->params[0], st->params[1], st->params[2]);
        }
    }
}

/* ---------- 分发与帧周期 ---------- */

void effect_render(const effect_ctx_t *ctx, uint8_t strip,
                   uint32_t now_ms, uint8_t *out)
{
    const effect_strip_t *st;

    if (strip >= EFFECT_STRIP_COUNT) {
        return;
    }
    st = &ctx->strips[strip];

    switch (st->effect_id) {
    case EFFECT_ID_OFF:
    case EFFECT_ID_NONE:
        render_off(out);
        break;
    case EFFECT_ID_STATIC:
        render_static(st, out);
        break;
    case EFFECT_ID_BREATH:
        render_breath(st, now_ms, out);
        break;
    case EFFECT_ID_GRADIENT:
        render_gradient(st, out);
        break;
    case EFFECT_ID_RAINBOW:
        render_rainbow(st, now_ms, out);
        break;
    case EFFECT_ID_FLOW:
        render_flow(st, now_ms, out);
        break;
    case EFFECT_ID_TWINKLE:
        render_twinkle(st, strip, now_ms, out);
        break;
    default:
        render_off(out);
        break;
    }
}

void effect_render_all(const effect_ctx_t *ctx, uint32_t now_ms,
                       uint8_t *out, size_t out_len)
{
    size_t need = (size_t)EFFECT_STRIP_COUNT * EFFECT_LEDS_PER_STRIP * 3u;

    if (out_len < need) {
        return;
    }
    for (uint8_t s = 0; s < EFFECT_STRIP_COUNT; s++) {
        effect_render(ctx, s, now_ms, out + (size_t)s * EFFECT_LEDS_PER_STRIP * 3u);
    }
}