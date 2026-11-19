/*
 * 场景序列化单测（native / Unity）。
 *
 * 断言基准：#4 决议第 4 节 —— blob = scene_version(1)+length(2)+payload，
 * payload 每路 effect_id+param_len+params、brightness(1)、power_limit_ma(2)，
 * 多字节小端；缺失/版本不支持/CRC 无效 -> 全灭（EFFECT_ID_NONE 全灭、
 * brightness 128、power_limit 15000）。CRC-16/CCITT-FALSE 期望值用独立
 * 手算常量（与协议 crc16.c 同标准，实现不可自证）。
 */

#include <string.h>

#include <unity.h>

#include "scene.h"

void setUp(void)
{
}

void tearDown(void)
{
}

/* 独立手算的 CRC-16/CCITT-FALSE（不调用被测代码）。 */
static uint16_t ref_crc16(const uint8_t *data, size_t len)
{
    uint16_t crc = 0xFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000u) ? (uint16_t)((crc << 1) ^ 0x1021u)
                                  : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

static void fill_scene(scene_state_t *st)
{
    scene_init_state(st);
    /* 全带静态红 + 亮度 200 + 限流 20000。 */
    uint8_t payload[] = {EFFECT_ID_STATIC, 255, 0, 0};
    effect_apply(&st->effects, 0xFF, payload, sizeof(payload), 1234);
    st->brightness = 200;
    st->power_limit_ma = 20000;
}

/* ---------- 往返 ---------- */

static void test_encode_decode_roundtrip(void)
{
    scene_state_t a;
    scene_state_t b;
    uint8_t blob[SCENE_BLOB_MAX];
    size_t n;

    fill_scene(&a);
    n = scene_encode(&a, blob, sizeof(blob));
    TEST_ASSERT_TRUE(n > 0);
    TEST_ASSERT_TRUE(scene_decode(blob, n, &b));

    TEST_ASSERT_EQUAL_UINT8(200, b.brightness);
    TEST_ASSERT_EQUAL_UINT16(20000, b.power_limit_ma);
    for (uint8_t i = 0; i < EFFECT_STRIP_COUNT; i++) {
        TEST_ASSERT_EQUAL_UINT8(a.effects.strips[i].effect_id,
                                b.effects.strips[i].effect_id);
        TEST_ASSERT_EQUAL_UINT8(a.effects.strips[i].param_len,
                                b.effects.strips[i].param_len);
        TEST_ASSERT_EQUAL_MEMORY(a.effects.strips[i].params,
                                 b.effects.strips[i].params,
                                 a.effects.strips[i].param_len);
    }
}

static void test_encode_byte_layout(void)
{
    scene_state_t st;
    uint8_t blob[SCENE_BLOB_MAX];
    size_t n;

    scene_init_state(&st);
    uint8_t payload[] = {EFFECT_ID_STATIC, 0x11, 0x22, 0x33};
    effect_apply(&st.effects, 0x01, payload, sizeof(payload), 0);
    st.brightness = 7;
    st.power_limit_ma = 0x1234;

    n = scene_encode(&st, blob, sizeof(blob));
    TEST_ASSERT_TRUE(n > 0);

    /* 头：version=1, length(2) = payload 长度 = n - 5。 */
    TEST_ASSERT_EQUAL_UINT8(1, blob[0]);
    TEST_ASSERT_EQUAL_UINT16(n - 5, (uint16_t)(blob[1] | (blob[2] << 8)));
    /* 第一路：effect_id=1, param_len=3, params=11 22 33。 */
    TEST_ASSERT_EQUAL_UINT8(1, blob[3]);
    TEST_ASSERT_EQUAL_UINT8(3, blob[4]);
    TEST_ASSERT_EQUAL_UINT8(0x11, blob[5]);
    TEST_ASSERT_EQUAL_UINT8(0x22, blob[6]);
    TEST_ASSERT_EQUAL_UINT8(0x33, blob[7]);
    /* 其余 7 路全 NONE(0xFF)/param_len=0。 */
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, blob[8]);
    TEST_ASSERT_EQUAL_UINT8(0, blob[9]);
    /* 末尾：brightness + power_limit 小端 + CRC。 */
    TEST_ASSERT_EQUAL_UINT8(7, blob[n - 5]);
    TEST_ASSERT_EQUAL_UINT8(0x34, blob[n - 4]);
    TEST_ASSERT_EQUAL_UINT8(0x12, blob[n - 3]);
    /* CRC 覆盖 version..payload 末尾（n-2 字节）。 */
    uint16_t crc = ref_crc16(blob, n - 2);
    TEST_ASSERT_EQUAL_UINT8(crc & 0xFF, blob[n - 2]);
    TEST_ASSERT_EQUAL_UINT8(crc >> 8, blob[n - 1]);
}

static void test_encode_minimal_roundtrip(void)
{
    /* 全灭态编码 -> 解码往返（16 条 (FF,0) + 3 + 3 = 24 字节）。 */
    scene_state_t st;
    scene_state_t out;
    uint8_t blob[SCENE_BLOB_MAX];
    size_t n;

    scene_init_state(&st);
    n = scene_encode(&st, blob, sizeof(blob));
    TEST_ASSERT_EQUAL_UINT32(24, (uint32_t)n);
    TEST_ASSERT_TRUE(scene_decode(blob, n, &out));
    TEST_ASSERT_EQUAL_UINT8(SCENE_OFF_BRIGHTNESS, out.brightness);
    TEST_ASSERT_EQUAL_UINT16(SCENE_OFF_POWER_LIMIT_MA, out.power_limit_ma);
    for (uint8_t i = 0; i < EFFECT_STRIP_COUNT; i++) {
        TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, out.effects.strips[i].effect_id);
    }
}

/* ---------- 异常输入 -> 全灭语义 ---------- */

static void assert_all_off(const scene_state_t *st)
{
    TEST_ASSERT_EQUAL_UINT8(SCENE_OFF_BRIGHTNESS, st->brightness);
    TEST_ASSERT_EQUAL_UINT16(SCENE_OFF_POWER_LIMIT_MA, st->power_limit_ma);
    for (uint8_t i = 0; i < EFFECT_STRIP_COUNT; i++) {
        TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, st->effects.strips[i].effect_id);
    }
}

static void test_decode_empty_is_off(void)
{
    scene_state_t st;
    uint8_t garbage[SCENE_BLOB_MAX];

    fill_scene(&st);
    TEST_ASSERT_EQUAL_INT(0, scene_decode(NULL, 0, &st));
    assert_all_off(&st);
    TEST_ASSERT_EQUAL_INT(0, scene_decode(garbage, 0, &st));
    assert_all_off(&st);
    /* 小但非零的垃圾长度（< 5 字节头）同样全灭。 */
    TEST_ASSERT_EQUAL_INT(0, scene_decode(garbage, 3u, &st));
    assert_all_off(&st);
}

static void test_decode_bad_version_is_off(void)
{
    scene_state_t a;
    scene_state_t b;
    uint8_t blob[SCENE_BLOB_MAX];
    size_t n;

    fill_scene(&a);
    n = scene_encode(&a, blob, sizeof(blob));
    TEST_ASSERT_TRUE(n > 0);
    blob[0] = 2; /* 版本不支持 */

    TEST_ASSERT_EQUAL_INT(0, scene_decode(blob, n, &b));
    assert_all_off(&b);
}

static void test_decode_bad_crc_is_off(void)
{
    scene_state_t a;
    scene_state_t b;
    uint8_t blob[SCENE_BLOB_MAX];
    size_t n;

    fill_scene(&a);
    n = scene_encode(&a, blob, sizeof(blob));
    blob[n - 1] ^= 0xFFu; /* 破坏 CRC */

    TEST_ASSERT_EQUAL_INT(0, scene_decode(blob, n, &b));
    assert_all_off(&b);
}

static void test_decode_length_field_mismatch_is_off(void)
{
    scene_state_t a;
    scene_state_t b;
    uint8_t blob[SCENE_BLOB_MAX];
    size_t n;

    fill_scene(&a);
    n = scene_encode(&a, blob, sizeof(blob));
    blob[2] ^= 0xFFu; /* length 字段与实际不符 */

    TEST_ASSERT_EQUAL_INT(0, scene_decode(blob, n, &b));
    assert_all_off(&b);
}

static void test_decode_truncated_is_off(void)
{
    scene_state_t a;
    scene_state_t b;
    uint8_t blob[SCENE_BLOB_MAX];
    size_t n;

    fill_scene(&a);
    n = scene_encode(&a, blob, sizeof(blob));

    TEST_ASSERT_EQUAL_INT(0, scene_decode(blob, n - 1u, &b));
    assert_all_off(&b);
    TEST_ASSERT_EQUAL_INT(0, scene_decode(blob, 3u, &b));
    assert_all_off(&b);
}

/* ---------- 全灭默认态 ---------- */

static void test_init_state_all_off(void)
{
    scene_state_t st;

    scene_init_state(&st);
    assert_all_off(&st);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_encode_decode_roundtrip);
    RUN_TEST(test_encode_byte_layout);
    RUN_TEST(test_encode_minimal_roundtrip);
    RUN_TEST(test_decode_empty_is_off);
    RUN_TEST(test_decode_bad_version_is_off);
    RUN_TEST(test_decode_bad_crc_is_off);
    RUN_TEST(test_decode_length_field_mismatch_is_off);
    RUN_TEST(test_decode_truncated_is_off);
    RUN_TEST(test_init_state_all_off);
    return UNITY_END();
}