/*
 * WS2812 编码单测（native / Unity）。
 *
 * 断言基准：时序字面量按 WS2812 标准（T=1.25µs，0 码 0.40/0.85µs、
 * 1 码 0.80/0.45µs，C3 800kHz 侧）与 1 tick = 12.5ns（80MHz）独立手算：
 *   0 码：32 ticks 高 + 68 ticks 低；1 码：64 高 + 36 低；EOF：100 低。
 * GRB 顺序、MSB 先、亮度缩放均为规格断言，不依赖实现内部。
 */

#include <string.h>

#include <unity.h>

#include "ws2812.h"

void setUp(void)
{
}

void tearDown(void)
{
}

/* 位域解包（与硬件语义独立的手算工具）。 */
static uint16_t dur0(ws2812_symbol_t s)
{
    return (uint16_t)(s & 0x7FFFu);
}
static uint8_t lvl0(ws2812_symbol_t s)
{
    return (uint8_t)((s >> 15) & 1u);
}
static uint16_t dur1(ws2812_symbol_t s)
{
    return (uint16_t)((s >> 16) & 0x7FFFu);
}
static uint8_t lvl1(ws2812_symbol_t s)
{
    return (uint8_t)((s >> 31) & 1u);
}

/* ---------- 单码符号时序字面量 ---------- */

static void test_bit0_symbol_timing(void)
{
    ws2812_symbol_t s = ws2812_encode_bit0();

    /* 0 码：高 0.40µs（32 ticks @12.5ns），低 0.85µs（68 ticks）。 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(s));
    TEST_ASSERT_EQUAL_UINT8(1, lvl0(s));
    TEST_ASSERT_EQUAL_UINT16(68, dur1(s));
    TEST_ASSERT_EQUAL_UINT8(0, lvl1(s));
}

static void test_bit1_symbol_timing(void)
{
    ws2812_symbol_t s = ws2812_encode_bit1();

    /* 1 码：高 0.80µs（64 ticks），低 0.45µs（36 ticks）。 */
    TEST_ASSERT_EQUAL_UINT16(64, dur0(s));
    TEST_ASSERT_EQUAL_UINT8(1, lvl0(s));
    TEST_ASSERT_EQUAL_UINT16(36, dur1(s));
    TEST_ASSERT_EQUAL_UINT8(0, lvl1(s));
}

static void test_eof_symbol_is_low(void)
{
    ws2812_symbol_t s = ws2812_encode_eof();

    TEST_ASSERT_EQUAL_UINT8(0, lvl0(s));
    TEST_ASSERT_EQUAL_UINT8(0, lvl1(s));
}

/* ---------- 字节编码：MSB 先 ---------- */

static void test_encode_byte_msb_first(void)
{
    ws2812_symbol_t sym[8];

    ws2812_encode_byte(0xA5u, sym); /* 1010 0101 */

    /* 位序 MSB→LSB 映射到 bit0(0)/bit1(1) 符号。 */
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[0])); /* 1 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[1])); /* 0 */
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[2])); /* 1 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[3])); /* 0 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[4])); /* 0 */
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[5])); /* 1 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[6])); /* 0 */
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[7])); /* 1 */
}

static void test_encode_byte_zero_all_bit0(void)
{
    ws2812_symbol_t sym[8];

    ws2812_encode_byte(0x00u, sym);
    for (unsigned i = 0; i < 8; i++) {
        TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[i]));
    }
}

static void test_encode_byte_ff_all_bit1(void)
{
    ws2812_symbol_t sym[8];

    ws2812_encode_byte(0xFFu, sym);
    for (unsigned i = 0; i < 8; i++) {
        TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[i]));
    }
}

/* ---------- GRB 顺序 ---------- */

static void test_grb_order_linear_rgb(void)
{
    /* R=0x12, G=0x34, B=0x56 → 线上先 G 后 R 后 B。 */
    uint8_t rgb[3] = {0x12, 0x34, 0x56};
    ws2812_symbol_t sym[24 + 1];

    size_t n = ws2812_encode(rgb, 1, 255, sym, 25);

    TEST_ASSERT_EQUAL_UINT32(25, n);
    /* 第 1 字节（线上第 1 个发送字节）= G = 0x34 = 0011 0100。 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[0])); /* 0 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[1])); /* 0 */
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[2])); /* 1 */
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[3])); /* 1 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[4])); /* 0 */
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[5])); /* 1 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[6])); /* 0 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[7])); /* 0 */
    /* 第 2 字节 = R = 0x12 = 0001 0010。 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[8]));
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[9]));
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[10]));
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[11]));
    /* 第 3 字节 = B = 0x56 = 0101 0110（抽头一位）。 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[16]));
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[17]));
}

/* ---------- 亮度缩放 ---------- */

static void test_brightness_scales_each_channel(void)
{
    /* R=200, G=100, B=0；brightness=128 → (200*128)/255=100, (100*128)/255=50, 0。 */
    uint8_t rgb[3] = {200, 100, 0};
    ws2812_symbol_t sym[25];

    TEST_ASSERT_EQUAL_UINT32(25, ws2812_encode(rgb, 1, 128, sym, 25));

    /* 线上字节序 G,R,B = 50,100,0。50=0011 0010，第一位 0。 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[0]));
    /* 100=0110 0100，第一位 0；取 R 首字节首位的反例：第 9 个符号
     * （R 的 MSB）= 0。 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[8]));
}

static void test_brightness_zero_blacks_out(void)
{
    uint8_t rgb[3] = {255, 255, 255};
    ws2812_symbol_t sym[25];

    TEST_ASSERT_EQUAL_UINT32(25, ws2812_encode(rgb, 1, 0, sym, 25));
    /* 全 0 数据 → 24 个 bit0 符号 + EOF。 */
    for (unsigned i = 0; i < 24; i++) {
        TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[i]));
    }
}

static void test_brightness_full_is_identity(void)
{
    uint8_t rgb[3] = {1, 2, 3};
    ws2812_symbol_t sym[25];

    TEST_ASSERT_EQUAL_UINT32(25, ws2812_encode(rgb, 1, 255, sym, 25));
    /* G=2 的 MSB（第 7 位）为 0；B=3 首字节…直接对比全亮度 0x03 的
     * 末字节编码：byte 3 = 0000 0011 → 前 6 个 bit0 后 2 个 bit1。 */
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[16]));
    TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[17]));
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[22]));
    TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[23]));
}

/* ---------- 多颗 + EOF + 容量 ---------- */

static void test_multi_led_layout_and_eof(void)
{
    /* 2 颗：颗 0 全黑，颗 1 全白（brightness 255）。 */
    uint8_t rgb[6] = {0, 0, 0, 255, 255, 255};
    ws2812_symbol_t sym[49];

    TEST_ASSERT_EQUAL_UINT32(49, ws2812_encode(rgb, 2, 255, sym, 49));
    /* 颗 0 的 24 符号全 bit0。 */
    for (unsigned i = 0; i < 24; i++) {
        TEST_ASSERT_EQUAL_UINT16(32, dur0(sym[i]));
    }
    /* 颗 1 的 24 符号全 bit1（GRB 都 FF）。 */
    for (unsigned i = 24; i < 48; i++) {
        TEST_ASSERT_EQUAL_UINT16(64, dur0(sym[i]));
    }
    /* 末尾 EOF。 */
    TEST_ASSERT_EQUAL_UINT8(0, lvl0(sym[48]));
    TEST_ASSERT_EQUAL_UINT8(0, lvl1(sym[48]));
}

static void test_capacity_short_returns_zero(void)
{
    uint8_t rgb[3] = {1, 2, 3};
    ws2812_symbol_t sym[10];

    /* 需要 25，只有 10 → 返回 0（不写）。 */
    TEST_ASSERT_EQUAL_UINT32(0, ws2812_encode(rgb, 1, 255, sym, 10));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_bit0_symbol_timing);
    RUN_TEST(test_bit1_symbol_timing);
    RUN_TEST(test_eof_symbol_is_low);
    RUN_TEST(test_encode_byte_msb_first);
    RUN_TEST(test_encode_byte_zero_all_bit0);
    RUN_TEST(test_encode_byte_ff_all_bit1);
    RUN_TEST(test_grb_order_linear_rgb);
    RUN_TEST(test_brightness_scales_each_channel);
    RUN_TEST(test_brightness_zero_blacks_out);
    RUN_TEST(test_brightness_full_is_identity);
    RUN_TEST(test_multi_led_layout_and_eof);
    RUN_TEST(test_capacity_short_returns_zero);
    return UNITY_END();
}