// 灯效引擎实现（firmware/effects，effects.md §6 公式的整数版本）。
// 纯 C99：无 Arduino / ESP-IDF、无 malloc、无 float、无 stdio（driver.md §5.1）。
//
// 取整/定点口径（全文件统一，供 t9 golden 对拍参考）：
//   - 颜色始终为逻辑 R,G,B（0..255）；亮度体现在 RGB 幅度里，无独立亮度字段。
//   - HSV 由 RGB 反解：s = round(d*255/Cmax)；色相先算 0..359°（整数除法截断），
//     再 h255 = round(deg*255/360) = (deg*255+180)/360。
//   - HSV→RGB：C = round(v*s/255)；X = round(C*factor/255)；m = v - C；
//     输出 = 通道 + m，钳到 0..255。factor 为扇区内分数（0..255 表示 0..1）。
//   - 相位：p255 = frac(phase)*255 取整；速度类 phase = frac(t*speed/denom)，
//     denom 见各效果（由 §4.2 的 cps_max 推出）。周期类按 strip 偏移 strip*255/8。
//   - 呼吸正弦用 129 项查表（p=0..128），p>128 镜像（w(1-p)=w(p)）；表值
//     = round((0.5-0.5*cos(2πp))*255)，即 0..255 的明度因子。
//   - 星闪 hash32 严格照 effects.md §6.8（uint32 环绕乘法）。

#include <stddef.h>

#include "effect_engine.h"

/* ---------- 小工具 ---------- */

static uint8_t clamp_u8(int v)
{
    if (v < 0) return 0;
    if (v > 255) return 255;
    return (uint8_t)v;
}

static uint8_t min3_u8(uint8_t a, uint8_t b, uint8_t c)
{
    uint8_t m = a < b ? a : b;
    return m < c ? m : c;
}

static uint8_t max3_u8(uint8_t a, uint8_t b, uint8_t c)
{
    uint8_t m = a > b ? a : b;
    return m > c ? m : c;
}

static uint16_t rd_le16(const uint8_t *p)
{
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

/* ---------- §3.1 RGB -> HSV（整数） ---------- */

static void rgb_to_hsv(uint8_t r, uint8_t g, uint8_t b,
                       uint8_t *h, uint8_t *s, uint8_t *v)
{
    uint8_t cmax = max3_u8(r, g, b);
    uint8_t cmin = min3_u8(r, g, b);
    uint8_t d = (uint8_t)(cmax - cmin);

    *v = cmax;
    *s = (cmax == 0) ? 0 : (uint8_t)(((uint32_t)d * 255u + cmax / 2u) / cmax);

    if (d == 0) {
        *h = 0;
        return;
    }

    int deg; /* 0..359，整数除法截断 */
    if (cmax == r) {
        deg = (int)(g - b) * 60 / d;
        if (deg < 0) deg += 360;
    } else if (cmax == g) {
        deg = 120 + (int)(b - r) * 60 / d;
    } else {
        deg = 240 + (int)(r - g) * 60 / d;
    }
    *h = (uint8_t)(((uint32_t)deg * 255u + 180u) / 360u);
}

/* ---------- §6.1 HSV -> RGB（整数） ---------- */

static void hsv_to_rgb(uint8_t h, uint8_t s, uint8_t v,
                       uint8_t *r, uint8_t *g, uint8_t *b)
{
    uint32_t C = ((uint32_t)v * s + 127u) / 255u; /* 0..255 */
    uint32_t m = (uint32_t)v - C;                 /* 0..255 */

    uint32_t num = (uint32_t)h * 6u; /* 0..1530 */
    uint32_t sector = num / 255u;    /* 0..6 */
    uint32_t rem = num % 255u;       /* 0..254 */
    if (sector >= 6u) {              /* h=255 视为 0°，归扇区 0 */
        sector = 0u;
        rem = 0u;
    }
    uint32_t factor = (sector & 1u) ? (255u - rem) : rem; /* 0..255 */
    uint32_t X = (C * factor + 127u) / 255u;               /* 0..255 */

    uint32_t rr, gg, bb;
    switch (sector) {
    case 0u: rr = C; gg = X; bb = 0u; break;
    case 1u: rr = X; gg = C; bb = 0u; break;
    case 2u: rr = 0u; gg = C; bb = X; break;
    case 3u: rr = 0u; gg = X; bb = C; break;
    case 4u: rr = X; gg = 0u; bb = C; break;
    default: rr = C; gg = 0u; bb = X; break; /* sector 5 */
    }

    *r = clamp_u8((int)(rr + m));
    *g = clamp_u8((int)(gg + m));
    *b = clamp_u8((int)(bb + m));
}

/* ---------- 相位工具 ---------- */

/* p255 = frac(t_ms / period_ms) * 255；period_ms == 0 时恒 0（冻结）。 */
static uint32_t phase_from_period(uint32_t t_ms, uint16_t period_ms)
{
    if (period_ms == 0u) return 0u;
    uint32_t r = t_ms % period_ms;
    return ((uint32_t)r * 255u) / period_ms;
}

/* p255 = frac(t_ms * speed / denom) * 255；speed==0 ⇒ 0（冻结）。 */
static uint32_t phase_from_speed(uint32_t t_ms, uint8_t speed, uint32_t denom)
{
    if (speed == 0u) return 0u;
    uint64_t num = (uint64_t)t_ms * (uint64_t)speed;
    uint64_t r = num % (uint64_t)denom;
    return (uint32_t)((r * 255u) / (uint64_t)denom);
}

/* 周期类相位错开：frac(phase + strip/8)。 */
static uint32_t add_strip_phase(uint32_t p255, uint8_t strip)
{
    uint32_t off = ((uint32_t)strip * 255u) / 8u; /* 0,31,63,...,223 */
    return (p255 + off) % 255u;
}

/* ---------- 呼吸正弦表（p=0..128，p>128 镜像） ---------- */
/* w[p] = round((0.5 - 0.5*cos(2*pi*p/256)) * 255)，p 为 0..128。 */
static const uint8_t kWave[129] = {
    0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 4, 5,
    5, 6, 7, 9, 10, 11, 12, 14, 15, 17, 18, 20,
    21, 23, 25, 27, 29, 31, 33, 35, 37, 40, 42, 44,
    47, 49, 52, 54, 57, 59, 62, 65, 67, 70, 73, 76,
    79, 82, 85, 88, 90, 93, 97, 100, 103, 106, 109, 112,
    115, 118, 121, 124, 127, 131, 134, 137, 140, 143, 146, 149,
    152, 155, 158, 162, 165, 167, 170, 173, 176, 179, 182, 185,
    188, 190, 193, 196, 198, 201, 203, 206, 208, 211, 213, 215,
    218, 220, 222, 224, 226, 228, 230, 232, 234, 235, 237, 238,
    240, 241, 243, 244, 245, 246, 248, 249, 250, 250, 251, 252,
    253, 253, 254, 254, 254, 255, 255, 255, 255
};

/* 返回 w(p)*255，p255 为 frac*255（0..254）。 */
static uint32_t breath_wave(uint32_t p255)
{
    uint32_t k = p255 % 256u;
    if (k > 128u) k = 255u - k; /* 镜像 w(1-p) == w(p) */
    return (uint32_t)kWave[k];
}

/* ---------- 星闪 hash32（effects.md §6.8，公开为 effect_sparkle_hash） ---------- */

static uint32_t sparkle_hash32(uint32_t i, uint32_t slot, uint32_t strip)
{
    uint32_t x = (i * 0x9E3779B1u) ^ (slot * 0x85EBCA6Bu) ^ (strip * 0xC2B2AE35u);
    x ^= x >> 16;
    x *= 0x7FEB352Du;
    x ^= x >> 15;
    x *= 0x846CA68Bu;
    x ^= x >> 16;
    return x;
}

uint32_t effect_sparkle_hash(uint32_t i, uint32_t slot, uint32_t strip)
{
    return sparkle_hash32(i, slot, strip);
}

/* ---------- 各效果 ---------- */

static void render_off(uint8_t *rgb)
{
    for (int k = 0; k < LIGHT_RGB_BYTES; k++) rgb[k] = 0;
}

static void render_static(const uint8_t *params, uint8_t *rgb)
{
    uint8_t r = params[0], g = params[1], b = params[2];
    for (int i = 0; i < LIGHT_LEDS; i++) {
        rgb[i * 3 + 0] = r;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = b;
    }
}

static void render_breath(const uint8_t *params, uint32_t t_ms, uint8_t *rgb)
{
    uint8_t h, s, v0;
    rgb_to_hsv(params[0], params[1], params[2], &h, &s, &v0);

    uint16_t period = rd_le16(&params[3]);
    uint8_t lo = params[5];
    uint8_t hi = params[6];

    uint32_t p255 = phase_from_period(t_ms, period); /* 不错开 */
    uint32_t w = breath_wave(p255);                   /* w*255, 0..255 */

    /* level = lo + (hi-lo)*w/255 */
    uint32_t level;
    if (hi >= lo) {
        level = (uint32_t)lo + ((uint32_t)(hi - lo) * w + 127u) / 255u;
    } else {
        level = (uint32_t)lo - ((uint32_t)(lo - hi) * w + 127u) / 255u;
    }
    /* V = V0 * level / 255 */
    uint32_t v = ((uint32_t)v0 * level + 127u) / 255u;

    uint8_t r, g, b;
    hsv_to_rgb(h, s, clamp_u8((int)v), &r, &g, &b);
    for (int i = 0; i < LIGHT_LEDS; i++) {
        rgb[i * 3 + 0] = r;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = b;
    }
}

static void render_gradient(const uint8_t *params, uint8_t strip,
                            uint32_t t_ms, uint8_t *rgb)
{
    uint8_t h1, s1, v1, h2, s2, v2;
    rgb_to_hsv(params[0], params[1], params[2], &h1, &s1, &v1);
    rgb_to_hsv(params[3], params[4], params[5], &h2, &s2, &v2);

    uint16_t period = rd_le16(&params[6]);
    uint8_t dir = (params[8] == 1u) ? 1u : 0u;

    uint32_t p255 = add_strip_phase(phase_from_period(t_ms, period), strip);

    /* delta = ((h2-h1+128) mod 256) - 128，落在 (-128,128]。 */
    int d = (int)h2 - (int)h1;
    int m = ((d + 128) % 256 + 256) % 256;
    int delta = m - 128;

    uint32_t drift_units = (dir == 0u) ? (p255 * 255u) : (uint32_t)(-(int32_t)(p255 * 255u));

    for (int i = 0; i < LIGHT_LEDS; i++) {
        uint32_t u255 = (uint32_t)i * 255u / (LIGHT_LEDS - 1); /* i/99 *255 */
        if (dir == 1u) u255 = 255u - u255;

        /* hue_i = frac((h1+delta*u_i)/255 + drift) * 255 */
        int64_t A = (int64_t)h1 * 255 + (int64_t)delta * (int64_t)u255;
        int64_t S = A + (int64_t)(int32_t)drift_units;
        int64_t mod = S % 65025;
        if (mod < 0) mod += 65025;
        uint8_t hue = (uint8_t)(mod / 255);

        /* sat_i = s1 + (s2-s1)*u_i */
        int ds = (int)s2 - (int)s1;
        int prod = ds * (int)u255;
        int sat;
        if (prod >= 0) sat = (int)s1 + (prod + 127) / 255;
        else sat = (int)s1 - ((-prod + 127) / 255);

        uint8_t r, g, b;
        hsv_to_rgb(hue, clamp_u8(sat), v1, &r, &g, &b);
        rgb[i * 3 + 0] = r;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = b;
    }
}

static void render_rainbow(const uint8_t *params, uint8_t strip,
                           uint32_t t_ms, uint8_t *rgb)
{
    uint8_t speed = params[0];
    uint8_t sat = params[1];
    uint8_t dir = (params[2] == 1u) ? 1u : 0u;

    /* cps_max = 0.5 ⇒ denom = 255*2000 = 510000 */
    uint32_t p255 = add_strip_phase(phase_from_speed(t_ms, speed, 510000u), strip);

    for (int i = 0; i < LIGHT_LEDS; i++) {
        uint32_t base = (uint32_t)i * 255u / (LIGHT_LEDS - 1); /* i/99 *255 */
        uint32_t t255;
        if (dir == 0u) {
            t255 = (base + p255) % 255u;
        } else {
            t255 = (base + 255u - p255) % 255u;
        }
        uint8_t r, g, b;
        hsv_to_rgb((uint8_t)t255, sat, 255u, &r, &g, &b); /* V 内部固定全亮 */
        rgb[i * 3 + 0] = r;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = b;
    }
}

static void render_flow(const uint8_t *params, uint8_t strip,
                        uint32_t t_ms, uint8_t *rgb)
{
    uint8_t h, s, v0;
    rgb_to_hsv(params[0], params[1], params[2], &h, &s, &v0);

    uint8_t speed = params[3];
    uint8_t length = params[4];
    uint8_t dir = (params[5] == 1u) ? 1u : 0u;
    if (length < 1u) length = 1u; /* §3：length=0 按 1 处理 */

    /* cps_max = 2.0 ⇒ denom = 255*500 = 127500 */
    uint32_t p255 = add_strip_phase(phase_from_speed(t_ms, speed, 127500u), strip);

    /* 头位置以 1/255 LED 为单位；head_units = p255 * 100 */
    uint32_t head_units = p255 * (uint32_t)LIGHT_LEDS; /* 0..25400 */
    uint32_t span_units = (uint32_t)LIGHT_LEDS * 255u; /* 100*255 = 25500 */
    uint32_t len_units = (uint32_t)length * 255u;

    for (int i = 0; i < LIGHT_LEDS; i++) {
        uint32_t i_units = (uint32_t)i * 255u;
        uint32_t d_units;
        if (dir == 0u) {
            d_units = (i_units + span_units - (head_units % span_units)) % span_units;
        } else {
            d_units = ((head_units % span_units) + span_units - i_units) % span_units;
        }

        uint8_t r, g, b;
        if (d_units < len_units) {
            /* k = 1 - d/length；V = V0 * k^2 */
            uint32_t k255 = ((len_units - d_units) * 255u + len_units / 2u) / len_units;
            uint32_t v = ((uint32_t)v0 * k255 * k255 + 32512u) / 65025u;
            hsv_to_rgb(h, s, clamp_u8((int)v), &r, &g, &b);
        } else {
            r = g = b = 0;
        }
        rgb[i * 3 + 0] = r;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = b;
    }
}

static void render_sparkle(const uint8_t *params, uint8_t strip,
                           uint32_t t_ms, uint8_t *rgb)
{
    uint8_t h, s, v0;
    rgb_to_hsv(params[0], params[1], params[2], &h, &s, &v0);

    uint8_t density = params[3];
    uint8_t speed = params[4];

    /* slots_hz = 32 * speed/255 ⇒ u = t_ms*32*speed/(255*1000) = t_ms*32*speed/255000 */
    uint64_t num = (uint64_t)t_ms * 32u * (uint64_t)speed;
    uint64_t slot = num / 255000u;
    uint32_t rem = (uint32_t)(num % 255000u);
    uint32_t q255 = rem / 1000u; /* frac*255，0..255 */

    /* spark ⇔ h32/2^32 < density/(255*160) */
    uint64_t thresh = ((uint64_t)0x100000000ULL * (uint64_t)density) / 40800u;

    for (int i = 0; i < LIGHT_LEDS; i++) {
        uint32_t h32 = sparkle_hash32((uint32_t)i, (uint32_t)slot, (uint32_t)strip);
        uint8_t r, g, b;
        if ((uint64_t)h32 < thresh) {
            /* k = (1-q)^2；V = V0 * k */
            uint32_t k255 = 255u - q255;
            uint32_t v = ((uint32_t)v0 * k255 * k255 + 32512u) / 65025u;
            hsv_to_rgb(h, s, clamp_u8((int)v), &r, &g, &b);
        } else {
            r = g = b = 0;
        }
        rgb[i * 3 + 0] = r;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = b;
    }
}

/* ---------- 公共接口 ---------- */

void effect_render(uint8_t effect_id, const uint8_t *params, uint8_t strip,
                   uint32_t t_ms, uint8_t rgb[LIGHT_RGB_BYTES])
{
    if (effect_id == EFFECT_OFF || params == NULL) {
        render_off(rgb);
        return;
    }

    switch (effect_id) {
    case EFFECT_STATIC:   render_static(params, rgb);                break;
    case EFFECT_BREATH:   render_breath(params, t_ms, rgb);          break;
    case EFFECT_GRADIENT: render_gradient(params, strip, t_ms, rgb); break;
    case EFFECT_RAINBOW:  render_rainbow(params, strip, t_ms, rgb);  break;
    case EFFECT_FLOW:     render_flow(params, strip, t_ms, rgb);     break;
    case EFFECT_SPARKLE:  render_sparkle(params, strip, t_ms, rgb);  break;
    default:              render_off(rgb);                           break; /* 未知 id 按关灯 */
    }
}

bool effect_is_time_varying(uint8_t effect_id, const uint8_t *params)
{
    if (effect_id == EFFECT_OFF || effect_id == EFFECT_STATIC) return false;
    if (params == NULL) return false;

    switch (effect_id) {
    case EFFECT_BREATH:
        return rd_le16(&params[3]) > 0u;      /* period_ms > 0 */
    case EFFECT_GRADIENT:
        return rd_le16(&params[6]) > 0u;      /* period_ms > 0 */
    case EFFECT_RAINBOW:
        return params[0] > 0u;                /* speed */
    case EFFECT_FLOW:
        return params[3] > 0u;                /* speed */
    case EFFECT_SPARKLE:
        return params[4] > 0u;                /* speed */
    default:
        return false;                         /* 未知 id 按静态 */
    }
}