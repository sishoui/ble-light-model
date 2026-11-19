/*
 * BLE 控制面单测（native / Unity）：命令分发、满功率门禁、STATUS/HELLO
 * 组帧、ACK/NAK 字节级断言。
 *
 * 断言基准：#4 决议第 2/3/4 节。STATUS 24 字节与 HELLO 23 字节布局逐
 * 字节对照 spec 手算；ACK/NAK 经 ble_proto_encode 与 proto golden 向量
 * 同口径（真实帧字节，不是结构体断言）。
 */

#include <string.h>

#include <unity.h>

#include "ble_proto.h"
#include "effect_engine.h"
#include "gatt.h"

void setUp(void)
{
}

void tearDown(void)
{
}

/* 独立手算 CRC-16/CCITT-FALSE（不调用被测代码）。 */
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

/* ---------- 分发：SET_EFFECT ---------- */

static void test_dispatch_set_effect_returns_apply(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;
    uint8_t payload[] = {EFFECT_ID_STATIC, 1, 2, 3};

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_SET_EFFECT;
    f.flags = 1u;
    f.strip_mask = 0x0F;
    f.payload_len = sizeof(payload);
    memcpy(f.payload, payload, sizeof(payload));

    TEST_ASSERT_EQUAL_UINT32(1, gatt_dispatch(&d, &f, &act, 1));
    TEST_ASSERT_EQUAL_INT(GATT_ACT_APPLY_EFFECT, act.type);
    TEST_ASSERT_EQUAL_UINT8(0x0F, act.strip_mask);
    TEST_ASSERT_EQUAL_UINT8(sizeof(payload), act.payload_len);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_STATIC, act.payload[0]);
    /* mask=0 不是错误：dispatch 仍返回 apply（effect_apply 忽略）。 */
    f.strip_mask = 0;
    TEST_ASSERT_EQUAL_UINT32(1, gatt_dispatch(&d, &f, &act, 1));
    TEST_ASSERT_EQUAL_INT(GATT_ACT_APPLY_EFFECT, act.type);
}

/* ---------- 分发：SET_BRIGHTNESS + 满功率门禁 ---------- */

static void test_dispatch_brightness_ok(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_SET_BRIGHTNESS;
    f.flags = 1u;
    f.strip_mask = 0xFF;
    f.payload_len = 1;
    f.payload[0] = 100;

    TEST_ASSERT_EQUAL_UINT32(1, gatt_dispatch(&d, &f, &act, 1));
    TEST_ASSERT_EQUAL_INT(GATT_ACT_SET_BRIGHTNESS, act.type);
    TEST_ASSERT_EQUAL_UINT8(100, act.payload[0]);
}

static void test_dispatch_brightness_over_half_not_unlocked_nak06(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_SET_BRIGHTNESS;
    f.strip_mask = 0xFF;
    f.payload_len = 1;
    f.payload[0] = 128; /* > 127 */

    TEST_ASSERT_EQUAL_UINT32(1, gatt_dispatch(&d, &f, &act, 1));
    TEST_ASSERT_EQUAL_INT(GATT_ACT_NAK, act.type);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_NOT_UNLOCKED, act.error);
    TEST_ASSERT_EQUAL_UINT16(f.seq, act.seq);
}

static void test_dispatch_brightness_50pct_boundary_ok(void)
{
    /* 127 = 50% 口径内（>127 才受限），127 接受。 */
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_SET_BRIGHTNESS;
    f.strip_mask = 0xFF;
    f.payload_len = 1;
    f.payload[0] = 127;
    TEST_ASSERT_EQUAL_INT(GATT_ACT_SET_BRIGHTNESS,
                          gatt_dispatch(&d, &f, &act, 1) ? (int)act.type : -1);
    TEST_ASSERT_EQUAL_INT(GATT_ACT_SET_BRIGHTNESS, act.type);
}

static void test_dispatch_brightness_strip_mask_must_be_ff(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_SET_BRIGHTNESS;
    f.strip_mask = 0x01;
    f.payload_len = 1;
    f.payload[0] = 10;

    TEST_ASSERT_EQUAL_INT(GATT_ACT_NAK, gatt_dispatch(&d, &f, &act, 1) ? (int)act.type : -1);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_INVALID_PARAM, act.error);
}

static void test_dispatch_brightness_len_mismatch(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_SET_BRIGHTNESS;
    f.strip_mask = 0xFF;
    f.payload_len = 0;

    TEST_ASSERT_EQUAL_INT(GATT_ACT_NAK, gatt_dispatch(&d, &f, &act, 1) ? (int)act.type : -1);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_LENGTH_MISMATCH, act.error);
}

/* ---------- 分发：SET_POWER_LIMIT ---------- */

static void test_dispatch_power_limit_over_15000_not_unlocked_nak06(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_SET_POWER_LIMIT;
    f.strip_mask = 0xFF;
    f.payload_len = 2;
    f.payload[0] = 0x10; /* 0x2710 = 10000? 不对：0x4E20 = 20000 */
    f.payload[0] = 0x20;
    f.payload[1] = 0x4E; /* 20000 */

    TEST_ASSERT_EQUAL_INT(GATT_ACT_NAK, gatt_dispatch(&d, &f, &act, 1) ? (int)act.type : -1);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_NOT_UNLOCKED, act.error);
}

static void test_dispatch_power_limit_over_30000_nak05(void)
{
    gatt_dispatch_t d = {1u, 30000u}; /* 已解锁：仍不得超过 30000 */
    gatt_action_t act;
    ble_proto_frame_t f;

    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_SET_POWER_LIMIT;
    f.strip_mask = 0xFF;
    f.payload_len = 2;
    f.payload[0] = 0x31;
    f.payload[1] = 0x75; /* 30001 */

    TEST_ASSERT_EQUAL_INT(GATT_ACT_NAK, gatt_dispatch(&d, &f, &act, 1) ? (int)act.type : -1);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_INVALID_PARAM, act.error);
}

static void test_dispatch_power_limit_short_payload_nak04(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_SET_POWER_LIMIT;
    f.strip_mask = 0xFF;
    f.payload_len = 1;
    f.payload[0] = 0x10;

    TEST_ASSERT_EQUAL_INT(GATT_ACT_NAK, gatt_dispatch(&d, &f, &act, 1) ? (int)act.type : -1);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_LENGTH_MISMATCH, act.error);
}

/* ---------- 分发：UNLOCK_FULL_POWER ---------- */

static void test_dispatch_unlock_sets_unlocked(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_UNLOCK_FULL_POWER;
    f.strip_mask = 0xFF;
    f.payload_len = 1;
    f.payload[0] = 1;

    TEST_ASSERT_EQUAL_UINT32(1, gatt_dispatch(&d, &f, &act, 1));
    TEST_ASSERT_EQUAL_INT(GATT_ACT_SET_UNLOCK, act.type);
    TEST_ASSERT_EQUAL_UINT8(1, act.payload[0]);
}

static void test_dispatch_unlock_bad_arg_nak05(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_UNLOCK_FULL_POWER;
    f.strip_mask = 0xFF;
    f.payload_len = 1;
    f.payload[0] = 2; /* 非 0/1 */

    TEST_ASSERT_EQUAL_INT(GATT_ACT_NAK, gatt_dispatch(&d, &f, &act, 1) ? (int)act.type : -1);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_INVALID_PARAM, act.error);
}

static void test_dispatch_unlock_mask_must_be_ff(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_UNLOCK_FULL_POWER;
    f.strip_mask = 0x01;
    f.payload_len = 1;
    f.payload[0] = 1;

    TEST_ASSERT_EQUAL_INT(GATT_ACT_NAK, gatt_dispatch(&d, &f, &act, 1) ? (int)act.type : -1);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_INVALID_PARAM, act.error);
}

/* ---------- 分发：GET_STATUS / 方向类型 ---------- */

static void test_dispatch_get_status_returns_status(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_GET_STATUS;
    f.flags = 0u;

    TEST_ASSERT_EQUAL_UINT32(1, gatt_dispatch(&d, &f, &act, 1));
    TEST_ASSERT_EQUAL_INT(GATT_ACT_STATUS, act.type);
}

static void test_dispatch_server_types_nak02(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;
    uint8_t types[] = {BLE_PROTO_TYPE_HELLO, BLE_PROTO_TYPE_ACK,
                       BLE_PROTO_TYPE_NAK, BLE_PROTO_TYPE_STATUS};

    gatt_dispatch_init(&d);
    for (size_t i = 0; i < sizeof(types); i++) {
        memset(&f, 0, sizeof(f));
        f.type = types[i];
        TEST_ASSERT_EQUAL_INT(GATT_ACT_NAK,
                              gatt_dispatch(&d, &f, &act, 1) ? (int)act.type : -1);
        TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_UNKNOWN_TYPE, act.error);
    }
}

/* ---------- 分发：cap / seq ---------- */

static void test_dispatch_cap_zero_writes_nothing(void)
{
    gatt_dispatch_t d;
    gatt_action_t act;
    ble_proto_frame_t f;

    gatt_dispatch_init(&d);
    memset(&f, 0, sizeof(f));
    f.type = BLE_PROTO_TYPE_GET_STATUS;

    TEST_ASSERT_EQUAL_UINT32(0, gatt_dispatch(&d, &f, &act, 0));
}

/* ---------- HELLO ---------- */

static void test_hello_layout(void)
{
    uint8_t h[29];
    gatt_build_hello(h, GATT_CAP_FULL_POWER | GATT_CAP_SCENE_SAVE |
                            GATT_CAP_EFFECT_BITMAP,
                     EFFECT_STRIP_COUNT, EFFECT_LEDS_PER_STRIP);

    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_VERSION, h[0]);
    TEST_ASSERT_EQUAL_UINT8(0, h[1]); /* fw_major */
    TEST_ASSERT_EQUAL_UINT8(1, h[2]); /* fw_minor */
    TEST_ASSERT_EQUAL_UINT8(0, h[3]); /* fw_patch */
    TEST_ASSERT_EQUAL_UINT8(EFFECT_STRIP_COUNT, h[4]);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_LEDS_PER_STRIP, h[5]);
    TEST_ASSERT_EQUAL_UINT16(30000, h[6] | (h[7] << 8));
    TEST_ASSERT_EQUAL_UINT16(15000, h[8] | (h[9] << 8));
    TEST_ASSERT_EQUAL_UINT8(70, h[10]);
    TEST_ASSERT_EQUAL_UINT8(85, h[11]);
    TEST_ASSERT_EQUAL_UINT8(0x07, h[12]);
    /* effect_bitmap[16]：effect 0–6 置位 -> byte0=0x7F，byte1..15=0。 */
    TEST_ASSERT_EQUAL_UINT8(0x7F, h[13]);
    for (int i = 14; i < 29; i++) {
        TEST_ASSERT_EQUAL_UINT8(0, h[i]);
    }
    /* 恰好 29 字节（#4 第 2 节，覆盖 effect_id 0–127）。 */
    TEST_ASSERT_EQUAL_size_t(29, sizeof(h));
}

/* ---------- 受限恢复夹取（#4 §4：重启后先限 50% / 15000mA） ---------- */

static void test_clamp_restricted_clamps_over_limit(void)
{
    uint8_t brightness = 200;
    uint16_t limit = 30000;

    gatt_clamp_restricted(&brightness, &limit);
    TEST_ASSERT_EQUAL_UINT8(127, brightness);
    TEST_ASSERT_EQUAL_UINT16(15000, limit);
}

static void test_clamp_restricted_keeps_within_limit(void)
{
    uint8_t brightness = 127;
    uint16_t limit = 15000;

    gatt_clamp_restricted(&brightness, &limit);
    TEST_ASSERT_EQUAL_UINT8(127, brightness);
    TEST_ASSERT_EQUAL_UINT16(15000, limit);
}

static void test_clamp_restricted_boundary(void)
{
    /* 128 刚超限 -> 夹到 127；15001 刚超限 -> 夹到 15000。 */
    uint8_t brightness = 128;
    uint16_t limit = 15001;

    gatt_clamp_restricted(&brightness, &limit);
    TEST_ASSERT_EQUAL_UINT8(127, brightness);
    TEST_ASSERT_EQUAL_UINT16(15000, limit);
}

/* ---------- STATUS 字节级 ---------- */

static void test_status_layout(void)
{
    effect_ctx_t effects;
    uint8_t st[GATT_STATUS_PAYLOAD_LEN];
    uint8_t on[] = {EFFECT_ID_STATIC, 0, 0, 0};
    uint8_t off[] = {EFFECT_ID_OFF};

    effect_init(&effects);
    effect_apply(&effects, 0x01, on, sizeof(on), 0); /* L0 static */
    effect_apply(&effects, 0x02, off, sizeof(off), 0); /* L1 off */

    gatt_build_status(st, 0x11223344u, -5, 1234, 1, 7, 9, 200, 20000,
                      0x80, &effects);

    TEST_ASSERT_EQUAL_UINT8(0x44, st[0]); /* uptime 小端 */
    TEST_ASSERT_EQUAL_UINT8(0x33, st[1]);
    TEST_ASSERT_EQUAL_UINT8(0x22, st[2]);
    TEST_ASSERT_EQUAL_UINT8(0x11, st[3]);
    TEST_ASSERT_EQUAL_INT8(-5, (int8_t)st[4]);
    TEST_ASSERT_EQUAL_UINT16(1234, st[5] | (st[6] << 8));
    TEST_ASSERT_EQUAL_UINT8(1, st[7]);
    TEST_ASSERT_EQUAL_UINT16(7, st[8] | (st[9] << 8));
    TEST_ASSERT_EQUAL_UINT16(9, st[10] | (st[11] << 8));
    TEST_ASSERT_EQUAL_UINT8(200, st[12]);
    TEST_ASSERT_EQUAL_UINT16(20000, st[13] | (st[14] << 8));
    TEST_ASSERT_EQUAL_UINT8(0x80, st[15]);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_STATIC, st[16]);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_OFF, st[17]);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, st[18]);
    TEST_ASSERT_EQUAL_UINT8(EFFECT_ID_NONE, st[23]);
    /* 恰好 24 字节：无越界写。 */
    TEST_ASSERT_EQUAL_size_t(24, sizeof(st));
}

/* ---------- ACK / NAK 帧字节级（经真实 encode） ---------- */

static void test_ack_frame_bytes(void)
{
    ble_proto_frame_t ack;
    uint8_t buf[BLE_PROTO_MAX_FRAME];
    size_t n;

    memset(&ack, 0, sizeof(ack));
    ack.version = BLE_PROTO_VERSION;
    ack.seq = 0x1234;
    ack.type = BLE_PROTO_TYPE_ACK;
    ack.payload_len = 2;
    ack.payload[0] = 0x34;
    ack.payload[1] = 0x12; /* ack_seq 回显 */

    n = ble_proto_encode(&ack, buf, sizeof(buf));
    TEST_ASSERT_TRUE(n > 0);
    TEST_ASSERT_EQUAL_UINT8(0xAA, buf[0]);
    TEST_ASSERT_EQUAL_UINT8(0x55, buf[1]);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_VERSION, buf[2]);
    TEST_ASSERT_EQUAL_UINT8(0x34, buf[3]);
    TEST_ASSERT_EQUAL_UINT8(0x12, buf[4]);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_TYPE_ACK, buf[5]);
    TEST_ASSERT_EQUAL_UINT8(0, buf[6]); /* flags */
    TEST_ASSERT_EQUAL_UINT8(0, buf[7]); /* strip_mask */
    TEST_ASSERT_EQUAL_UINT8(2, buf[8]); /* param_len */
    TEST_ASSERT_EQUAL_UINT8(0x34, buf[9]);
    TEST_ASSERT_EQUAL_UINT8(0x12, buf[10]);
    /* CRC：独立手算 AA 55 之后 9 字节 = ver..payload（共 13 字节帧）。 */
    uint16_t crc = ref_crc16(buf + 2, 2u + 5u + 2u);
    TEST_ASSERT_EQUAL_UINT8(crc & 0xFF, buf[11]);
    TEST_ASSERT_EQUAL_UINT8(crc >> 8, buf[12]);
    TEST_ASSERT_EQUAL_UINT32(13, (uint32_t)n);
}

static void test_nak_frame_bytes(void)
{
    ble_proto_frame_t nak;
    uint8_t buf[BLE_PROTO_MAX_FRAME];
    size_t n;

    memset(&nak, 0, sizeof(nak));
    nak.version = BLE_PROTO_VERSION;
    nak.seq = 0x0005;
    nak.type = BLE_PROTO_TYPE_NAK;
    nak.payload_len = 3;
    nak.payload[0] = 0x05;
    nak.payload[1] = 0x00;
    nak.payload[2] = BLE_PROTO_NAK_NOT_UNLOCKED;

    n = ble_proto_encode(&nak, buf, sizeof(buf));
    TEST_ASSERT_TRUE(n > 0);
    TEST_ASSERT_EQUAL_UINT8(0x05, buf[3]);
    TEST_ASSERT_EQUAL_UINT8(0x00, buf[4]);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_TYPE_NAK, buf[5]);
    TEST_ASSERT_EQUAL_UINT8(3, buf[8]);
    TEST_ASSERT_EQUAL_UINT8(0x05, buf[9]);
    TEST_ASSERT_EQUAL_UINT8(0x00, buf[10]);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_NAK_NOT_UNLOCKED, buf[11]);
    uint16_t crc = ref_crc16(buf + 2, 3u + 7u);
    TEST_ASSERT_EQUAL_UINT8(crc & 0xFF, buf[12]);
    TEST_ASSERT_EQUAL_UINT8(crc >> 8, buf[13]);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_dispatch_set_effect_returns_apply);
    RUN_TEST(test_dispatch_brightness_ok);
    RUN_TEST(test_dispatch_brightness_over_half_not_unlocked_nak06);
    RUN_TEST(test_dispatch_brightness_50pct_boundary_ok);
    RUN_TEST(test_dispatch_brightness_strip_mask_must_be_ff);
    RUN_TEST(test_dispatch_brightness_len_mismatch);
    RUN_TEST(test_dispatch_power_limit_over_15000_not_unlocked_nak06);
    RUN_TEST(test_dispatch_power_limit_over_30000_nak05);
    RUN_TEST(test_dispatch_power_limit_short_payload_nak04);
    RUN_TEST(test_dispatch_unlock_sets_unlocked);
    RUN_TEST(test_dispatch_unlock_bad_arg_nak05);
    RUN_TEST(test_dispatch_unlock_mask_must_be_ff);
    RUN_TEST(test_dispatch_get_status_returns_status);
    RUN_TEST(test_dispatch_server_types_nak02);
    RUN_TEST(test_dispatch_cap_zero_writes_nothing);
    RUN_TEST(test_hello_layout);
    RUN_TEST(test_clamp_restricted_clamps_over_limit);
    RUN_TEST(test_clamp_restricted_keeps_within_limit);
    RUN_TEST(test_clamp_restricted_boundary);
    RUN_TEST(test_status_layout);
    RUN_TEST(test_ack_frame_bytes);
    RUN_TEST(test_nak_frame_bytes);
    return UNITY_END();
}