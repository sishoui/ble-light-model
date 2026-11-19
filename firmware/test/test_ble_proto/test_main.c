/*
 * 协议 v1 C 侧单测（native / Unity）：
 * - 编码字面量锚点（与 JS 侧 codec.test.ts 同一手算值）
 * - 边界（out_cap 不足、最大 payload 往返、cap 丢弃、reset）
 * - tests/protocol/vectors.json golden 向量跑测（与 JS 侧同一组字节）
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <unity.h>

#include "ble_proto.h"
#include "vectors_json.h"

void setUp(void)
{
}

void tearDown(void)
{
}

/* ---------- 编码字面量锚点 ---------- */

static void test_encode_get_status_literal(void)
{
    ble_proto_frame_t frame;
    uint8_t out[16];
    size_t n;
    char hex[32];

    memset(&frame, 0, sizeof(frame));
    frame.version = 1;
    frame.seq = 3;
    frame.type = BLE_PROTO_TYPE_GET_STATUS;

    n = ble_proto_encode(&frame, out, sizeof(out));
    TEST_ASSERT_EQUAL_UINT32(11, n);

    hex_encode(out, n, hex);
    /* GET_STATUS：ver=1, seq=3, type=0x06, flags=0, strip=0, 空 payload；
     * CRC 覆盖 01 03 00 06 00 00 00 = 0xA0D6，小端 D6 A0（与 JS 侧手算锚点一致）。 */
    TEST_ASSERT_EQUAL_STRING("AA5501030006000000D6A0", hex);
}

/* ---------- 编码边界 ---------- */

static void test_encode_out_cap_too_small(void)
{
    ble_proto_frame_t frame;
    uint8_t out[16];

    memset(&frame, 0, sizeof(frame));
    frame.version = 1;
    frame.seq = 1;
    frame.type = BLE_PROTO_TYPE_GET_STATUS;

    TEST_ASSERT_EQUAL_UINT32(0, ble_proto_encode(&frame, out, 10));
}

static void test_roundtrip_max_payload(void)
{
    ble_proto_frame_t in;
    ble_proto_frame_t frames[1];
    ble_proto_error_t errors[1];
    ble_proto_feed_t ctx;
    uint8_t bytes[BLE_PROTO_MAX_FRAME + 4];
    size_t n;
    size_t got;
    size_t errs = 0;
    int i;

    memset(&in, 0, sizeof(in));
    in.version = 1;
    in.seq = 0x1234;
    in.type = BLE_PROTO_TYPE_SET_POWER_LIMIT;
    in.flags = 1;
    in.strip_mask = 0xFF;
    in.payload_len = BLE_PROTO_MAX_PAYLOAD;
    for (i = 0; i < (int)BLE_PROTO_MAX_PAYLOAD; i++) {
        in.payload[i] = (uint8_t)i;
    }

    n = ble_proto_encode(&in, bytes, sizeof(bytes));
    TEST_ASSERT_EQUAL_UINT32(BLE_PROTO_MAX_FRAME, n);

    memset(&ctx, 0, sizeof(ctx));
    got = ble_proto_feed(&ctx, bytes, n, frames, 1, errors, 1, &errs);
    TEST_ASSERT_EQUAL_UINT32(1, got);
    TEST_ASSERT_EQUAL_UINT32(0, errs);
    TEST_ASSERT_EQUAL_UINT32(0, ctx.len);
    TEST_ASSERT_EQUAL_UINT8(1, frames[0].version);
    TEST_ASSERT_EQUAL_UINT16(0x1234, frames[0].seq);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_TYPE_SET_POWER_LIMIT, frames[0].type);
    TEST_ASSERT_EQUAL_UINT8(1, frames[0].flags);
    TEST_ASSERT_EQUAL_UINT8(0xFF, frames[0].strip_mask);
    TEST_ASSERT_EQUAL_UINT8(BLE_PROTO_MAX_PAYLOAD, frames[0].payload_len);
    TEST_ASSERT_EQUAL_MEMORY(in.payload, frames[0].payload, BLE_PROTO_MAX_PAYLOAD);
}

static void test_feed_caps_discard_extra_frames(void)
{
    /* 粘包两帧，frames_cap=1：只产出第一帧，第二帧丢弃，缓冲清空。 */
    ble_proto_frame_t in;
    ble_proto_frame_t frames[2];
    ble_proto_error_t errors[1];
    ble_proto_feed_t ctx;
    uint8_t bytes[600];
    size_t n1;
    size_t n2;
    size_t got;
    size_t errs = 0;

    memset(&in, 0, sizeof(in));
    in.version = 1;
    in.seq = 1;
    in.type = BLE_PROTO_TYPE_GET_STATUS;

    n1 = ble_proto_encode(&in, bytes, sizeof(bytes));
    in.seq = 2;
    n2 = ble_proto_encode(&in, bytes + n1, sizeof(bytes) - n1);

    memset(&ctx, 0, sizeof(ctx));
    got = ble_proto_feed(&ctx, bytes, n1 + n2, frames, 1, errors, 1, &errs);
    TEST_ASSERT_EQUAL_UINT32(1, got);
    TEST_ASSERT_EQUAL_UINT32(0, errs);
    TEST_ASSERT_EQUAL_UINT32(0, ctx.len);
    TEST_ASSERT_EQUAL_UINT16(1, frames[0].seq);
}

static void test_feed_reset(void)
{
    ble_proto_feed_t ctx;
    uint8_t half[4] = {0xAA, 0x55, 0x01, 0x03};
    ble_proto_frame_t frames[1];
    ble_proto_error_t errors[1];
    size_t errs = 0;

    memset(&ctx, 0, sizeof(ctx));
    ble_proto_feed(&ctx, half, sizeof(half), frames, 1, errors, 1, &errs);
    TEST_ASSERT_EQUAL_UINT32(4, ctx.len);

    ble_proto_feed_reset(&ctx);
    TEST_ASSERT_EQUAL_UINT32(0, ctx.len);
}

/* ---------- 半帧 200ms 超时丢弃（#4 §1） ---------- */

static void test_feed_should_reset_boundary(void)
{
    /* 199ms 未到：不丢弃。 */
    TEST_ASSERT_EQUAL_INT(0, ble_proto_feed_should_reset(1000u, 1199u));
    /* 200ms 整：丢弃（>= 200）。 */
    TEST_ASSERT_EQUAL_INT(1, ble_proto_feed_should_reset(1000u, 1200u));
    /* 201ms：丢弃。 */
    TEST_ASSERT_EQUAL_INT(1, ble_proto_feed_should_reset(1000u, 1201u));
}

static void test_feed_should_reset_wrap_safe(void)
{
    /* uint32 回绕：last 接近上限，now 已回绕，差值仍按模 2^32 计算。 */
    TEST_ASSERT_EQUAL_INT(0, ble_proto_feed_should_reset(0xFFFFFFF0u, 0x00000010u)); /* 32ms */
    TEST_ASSERT_EQUAL_INT(1, ble_proto_feed_should_reset(0xFFFFFFF0u, 0x000000C8u)); /* 200ms */
    TEST_ASSERT_EQUAL_INT(1, ble_proto_feed_should_reset(0xFFFFFFF0u, 0x000000C9u)); /* 201ms */
}

/* ---------- golden 向量 ---------- */

static vec_doc_t doc;
static int doc_ready;

static void ensure_doc(void)
{
    const char *path;

    if (doc_ready) return;
    path = getenv("BLE_VECTORS_PATH");
    if (path == NULL || path[0] == '\0') {
        /* pio test 的工作目录是 firmware/，向量在仓库根 tests/protocol/ 下。 */
        path = "../tests/protocol/vectors.json";
    }
    if (vectors_load(path, &doc) != 0) {
        fprintf(stderr, "vectors.json 装载失败：%s\n", path);
        TEST_FAIL_MESSAGE("vectors.json 装载失败");
    }
    doc_ready = 1;
}

static void test_vectors_encode(void)
{
    int i;

    ensure_doc();
    for (i = 0; i < doc.count; i++) {
        const vec_case_t *c = &doc.cases[i];
        ble_proto_frame_t frame;
        uint8_t out[BLE_PROTO_MAX_FRAME];
        char hex[2 * BLE_PROTO_MAX_FRAME + 1];
        size_t n;

        if (!c->is_encode) continue;

        memset(&frame, 0, sizeof(frame));
        frame.version = (uint8_t)c->frame.ver;
        frame.seq = (uint16_t)c->frame.seq;
        frame.type = (uint8_t)c->frame.type;
        frame.flags = (uint8_t)c->frame.flags;
        frame.strip_mask = (uint8_t)c->frame.strip_mask;
        frame.payload_len = (uint8_t)c->frame.payload_len;
        memcpy(frame.payload, c->frame.payload, (size_t)c->frame.payload_len);

        n = ble_proto_encode(&frame, out, sizeof(out));
        TEST_ASSERT_TRUE_MESSAGE(n > 0, c->id);

        hex_encode(out, n, hex);
        if (strcmp(hex, c->expect_hex) != 0) {
            printf("  %s\n  期望 %s\n  实际 %s\n", c->id, c->expect_hex, hex);
        }
        TEST_ASSERT_EQUAL_STRING_MESSAGE(c->expect_hex, hex, c->id);
    }
}

static void test_vectors_feed(void)
{
    int i;

    ensure_doc();
    for (i = 0; i < doc.count; i++) {
        const vec_case_t *c = &doc.cases[i];
        ble_proto_feed_t ctx;
        ble_proto_frame_t frames[VEC_MAX_FRAMES];
        ble_proto_error_t errors[VEC_MAX_ERRORS];
        char remainder_hex[2 * BLE_PROTO_MAX_FRAME + 1];
        size_t frame_count = 0;
        size_t error_count = 0;
        int w;
        int j;

        if (c->is_encode) continue;

        memset(&ctx, 0, sizeof(ctx));
        for (w = 0; w < c->write_count; w++) {
            uint8_t wbuf[VEC_HEX_MAX / 2 + 2];
            size_t errs = 0;
            int wlen = hex_decode(c->writes[w], wbuf, sizeof(wbuf));
            size_t got;

            TEST_ASSERT_TRUE_MESSAGE(wlen >= 0, c->id);
            got = ble_proto_feed(&ctx, wbuf, (size_t)wlen,
                                 frames + frame_count, VEC_MAX_FRAMES - frame_count,
                                 errors + error_count, VEC_MAX_ERRORS - error_count,
                                 &errs);
            frame_count += got;
            error_count += errs;

            /* 每次喂入后的未完成尾字节必须与向量一致。 */
            hex_encode(ctx.buf, ctx.len, remainder_hex);
            if (strcmp(remainder_hex, c->expect_remainders[w]) != 0) {
                printf("  %s writes[%d] remainder\n  期望 %s\n  实际 %s\n",
                       c->id, w, c->expect_remainders[w], remainder_hex);
            }
            TEST_ASSERT_EQUAL_STRING_MESSAGE(c->expect_remainders[w], remainder_hex, c->id);
        }

        if (frame_count != (size_t)c->expect_frame_count || error_count != (size_t)c->expect_error_count) {
            printf("  %s 数量不符：期望 %d 帧 / %d 错，实际 %d 帧 / %d 错\n",
                   c->id, c->expect_frame_count, c->expect_error_count,
                   (int)frame_count, (int)error_count);
        }
        TEST_ASSERT_EQUAL_UINT32_MESSAGE((size_t)c->expect_frame_count, frame_count, c->id);
        TEST_ASSERT_EQUAL_UINT32_MESSAGE((size_t)c->expect_error_count, error_count, c->id);

        for (j = 0; j < c->expect_frame_count; j++) {
            const vec_frame_t *e = &c->expect_frames[j];
            const ble_proto_frame_t *a = &frames[j];
            char hex[2 * 256 + 1];

            TEST_ASSERT_EQUAL_UINT8_MESSAGE(e->ver, a->version, c->id);
            TEST_ASSERT_EQUAL_UINT16_MESSAGE(e->seq, a->seq, c->id);
            TEST_ASSERT_EQUAL_UINT8_MESSAGE(e->type, a->type, c->id);
            TEST_ASSERT_EQUAL_UINT8_MESSAGE(e->flags, a->flags, c->id);
            TEST_ASSERT_EQUAL_UINT8_MESSAGE(e->strip_mask, a->strip_mask, c->id);
            TEST_ASSERT_EQUAL_UINT8_MESSAGE(e->payload_len, a->payload_len, c->id);
            hex_encode(a->payload, (size_t)a->payload_len, hex);
            {
                char ehex[2 * 256 + 1];
                hex_encode(e->payload, (size_t)e->payload_len, ehex);
                TEST_ASSERT_EQUAL_STRING_MESSAGE(ehex, hex, c->id);
            }
        }

        for (j = 0; j < c->expect_error_count; j++) {
            const vec_error_t *e = &c->expect_errors[j];
            const ble_proto_error_t *a = &errors[j];
            char msg[160];

            /* 向量的 kind 字符串与 NAK 错误码一一对应，这里核对码值与序号/类型。 */
            snprintf(msg, sizeof(msg), "%s error kind=%s code 期望 %d 实际 %d",
                     c->id, e->kind, e->error, a->code);
            TEST_ASSERT_EQUAL_UINT8_MESSAGE(e->error, a->code, msg);
            TEST_ASSERT_EQUAL_UINT16_MESSAGE(e->seq, a->seq, c->id);
            TEST_ASSERT_EQUAL_UINT8_MESSAGE(e->type, a->type, c->id);
        }

        if (c->has_expect_ack_generated) {
            int ack_in = 0;
            int ack_out = 0;

            /* Codec 不得自行产生 ACK：输出 ACK 数 = 输入（expect_frames）里的 ACK 数。 */
            for (j = 0; j < c->expect_frame_count; j++) {
                if (c->expect_frames[j].type == BLE_PROTO_TYPE_ACK) ack_in++;
            }
            for (j = 0; j < (int)frame_count; j++) {
                if (frames[j].type == BLE_PROTO_TYPE_ACK) ack_out++;
            }
            TEST_ASSERT_EQUAL_INT_MESSAGE(ack_in, ack_out, c->id);
        }
    }
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_encode_get_status_literal);
    RUN_TEST(test_encode_out_cap_too_small);
    RUN_TEST(test_roundtrip_max_payload);
    RUN_TEST(test_feed_caps_discard_extra_frames);
    RUN_TEST(test_feed_reset);
    RUN_TEST(test_feed_should_reset_boundary);
    RUN_TEST(test_feed_should_reset_wrap_safe);
    RUN_TEST(test_vectors_encode);
    RUN_TEST(test_vectors_feed);
    return UNITY_END();
}