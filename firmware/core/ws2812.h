#ifndef BLE_LIGHT_WS2812_H
#define BLE_LIGHT_WS2812_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * WS2812 编码层（纯 C99，不 include IDF 头，不用动态内存）。
 *
 * 边界：effect_engine 只产逻辑 RGB；本层负责 GRB 转换 + 全局亮度缩放
 * （0–255 线性）+ RMT 符号编码。符号用本文件自定义类型，位布局与 IDF
 * rmt_symbol_word_t 兼容（duration0/level0 先发），ports 可直接强转复用。
 * 不在这里 include driver/rmt_tx.h —— host 单测要能编译。
 */

typedef uint32_t ws2812_symbol_t;

/* WS2812 单码符号（T=1.25µs，C3 800kHz 侧：0 码 0.40/0.85µs，1 码 0.80/0.45µs）。 */
ws2812_symbol_t ws2812_encode_bit0(void);
ws2812_symbol_t ws2812_encode_bit1(void);
/* 帧尾低电平符号（复位占位为 1 个符号；>280µs 真复位由 ports 轮间间隔保证）。 */
ws2812_symbol_t ws2812_encode_eof(void);

/* 一个字节 → 8 个符号（MSB 先）。out 容量 >= 8。 */
void ws2812_encode_byte(uint8_t byte, ws2812_symbol_t *out);

/*
 * 逻辑 RGB 帧 → RMT 符号流（每颗 24 符号 + 1 个 EOF 符号）。
 * rgb 为 led_count × 3 的逻辑 RGB（r[i*3+0]=R，effect_render_all 的布局）；
 * brightness 全局 0–255 线性缩放；out 容量需 >= led_count*24+1。
 * 返回写入符号数；容量不足返回 0（不写）。
 */
size_t ws2812_encode(const uint8_t *rgb, size_t led_count, uint8_t brightness,
                     ws2812_symbol_t *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_WS2812_H */