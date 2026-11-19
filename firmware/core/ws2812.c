/*
 * WS2812 RMT 符号编码（纯 C99，不依赖 Arduino / IDF，不用动态内存）。
 *
 * 职责：逻辑 RGB（effect_engine 输出，r[i*3+0]=R）→ WS2812 线序 GRB →
 * 全局亮度缩放（0–255 线性，亮度由调用方注入）→ RMT 符号。
 * 本层不认识灯效、调度与硬件；符号类型是本文件自定义的
 * ws2812_symbol_t，语义与 IDF rmt_symbol_word_t 的位布局一致（低 32 位
 * 先发），但不 include 任何 IDF 头，host 单测直接逐符号断言。
 *
 * 时序：WS2812 每一位 = 高 t1H + 低 (T-t1H)，T=1.25µs（800kHz 侧）。
 * C3 参数：0 码 高 0.40µs / 低 0.85µs；1 码 高 0.80µs / 低 0.45µs。
 * RESET（EOF）= 低 >280µs，用 1 个符号（低 1.25µs）占位不够 —— 复位由
 * 帧间隔 / 通道空闲承担（EOF 符号保证帧尾有一段低电平，具体时长由 ports
 * 的轮间间隔 ≥280µs 保证）。
 */

#include "ws2812.h"

#include <string.h>

/* 符号位布局与 rmt_symbol_word_t 一致：bit0..14 duration0，bit15 level0，
 * bit16..30 duration1，bit31 level1。低 32 位先发。 */
#define SYM(dur0, lvl0, dur1, lvl1) \
    ((ws2812_symbol_t)((((uint32_t)(dur1) << 16) | ((uint32_t)(lvl1) << 31)) | \
                        ((uint32_t)(dur0) | ((uint32_t)(lvl0) << 15))))

/*
 * WS2812 标准时序（T=1.25µs = 1250ns，800kHz 侧）的 RMT tick 换算。
 * 1 tick = 1/80MHz = 12.5ns（C3 APB 80MHz，RMT 默认分频 1）。
 */
#define TICK_NS 12 /* 实际 12.5ns，整除误差 0.5ns，远小于容差 */

/* 0 码：高 400ns ≈ 32 ticks；低 850ns ≈ 68 ticks（共 100 ticks = 1.25µs）。 */
#define T0H 32u
#define T0L 68u
/* 1 码：高 800ns = 64 ticks；低 450ns = 36 ticks。 */
#define T1H 64u
#define T1L 36u
/* EOF（复位）：一个持低电平的符号；低时长须 >280µs 才算真复位，这里占位，
 * 真正的复位低电平由 ports 在轮间 / 帧间保证。用 1 个 1250ns 低电平符号。 */
#define TEOF 100u

ws2812_symbol_t ws2812_encode_bit0(void)
{
    return SYM(T0H, 1, T0L, 0);
}

ws2812_symbol_t ws2812_encode_bit1(void)
{
    return SYM(T1H, 1, T1L, 0);
}

ws2812_symbol_t ws2812_encode_eof(void)
{
    return SYM(TEOF, 0, 0, 0);
}

/* 一个字节 8 位，MSB 先（WS2812 线上顺序）。 */
void ws2812_encode_byte(uint8_t byte, ws2812_symbol_t *out)
{
    for (unsigned i = 0; i < 8u; i++) {
        out[i] = (byte & (uint8_t)(1u << (7u - i))) ? ws2812_encode_bit1()
                                                    : ws2812_encode_bit0();
    }
}

size_t ws2812_encode(const uint8_t *rgb, size_t led_count, uint8_t brightness,
                     ws2812_symbol_t *out, size_t out_cap)
{
    /* 每颗 3 通道 × 8 位 = 24 符号，外加 1 个 EOF。 */
    size_t need = led_count * 24u + 1u;
    size_t n = 0;

    if (need > out_cap) {
        return 0;
    }
    for (size_t i = 0; i < led_count; i++) {
        uint8_t ch[3];
        /* 逻辑 RGB → WS2812 线序 GRB。 */
        ch[0] = rgb[i * 3u + 1u];
        ch[1] = rgb[i * 3u + 0u];
        ch[2] = rgb[i * 3u + 2u];
        for (unsigned c = 0; c < 3u; c++) {
            uint8_t v = (uint8_t)((uint16_t)ch[c] * brightness / 255u);
            ws2812_encode_byte(v, out + n);
            n += 8u;
        }
    }
    out[n++] = ws2812_encode_eof();
    return n;
}