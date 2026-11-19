/*
 * 事件日志（JSONL）核心单测（native / Unity，#15）。
 *
 * 断言基准：docs/spec/test-strategy.md §3.3 —— 事件行是 PC 集成交叉断言的
 * 锚点，格式必须逐字节稳定（Python 侧 json.loads 解析）：
 *   {"t_ms":<C3单调毫秒>,"seq":<RX帧序号回显>,"ev":"<种类>",...事件字段}
 * 覆盖：JSON 字符串转义、writer 定长截断、环形缓冲 FIFO / 满则丢最旧 /
 * 拒收空行与超长行、writer 溢出整行丢弃。
 */

#include <stdio.h>
#include <string.h>

#include <unity.h>

#include "event_log.h"

void setUp(void)
{
}

void tearDown(void)
{
}

/* ---------- writer：基本行逐字节 ---------- */

static void test_writer_basic_line(void)
{
    char buf[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, buf, sizeof(buf));
    event_log_writer_begin(&w, 1234u, 5u, "rx");
    event_log_writer_int(&w, "type", 2);
    event_log_writer_int(&w, "flags", 1);
    event_log_writer_int(&w, "len", 4);
    event_log_writer_end(&w);

    TEST_ASSERT_EQUAL_STRING(
        "{\"t_ms\":1234,\"seq\":5,\"ev\":\"rx\",\"type\":2,\"flags\":1,"
        "\"len\":4}\n",
        buf);
    TEST_ASSERT_EQUAL_INT(0, w.overflow);
    TEST_ASSERT_EQUAL_size_t(strlen(buf), w.len);
}

static void test_writer_empty_event_line(void)
{
    char buf[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, buf, sizeof(buf));
    event_log_writer_begin(&w, 0u, 0u, "ack");
    event_log_writer_end(&w);

    /* 无额外字段：seq=0 的无帧事件口径。 */
    TEST_ASSERT_EQUAL_STRING("{\"t_ms\":0,\"seq\":0,\"ev\":\"ack\"}\n", buf);
    TEST_ASSERT_EQUAL_INT(0, w.overflow);
}

/* ---------- writer：JSON 字符串转义 ---------- */

static void test_writer_str_escaping(void)
{
    char buf[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, buf, sizeof(buf));
    event_log_writer_begin(&w, 1u, 2u, "gap");
    event_log_writer_str(&w, "what", "a\"b\\c\nd\te\001f");
    event_log_writer_end(&w);

    /* 期望线格式：{"t_ms":1,"seq":2,"ev":"gap","what":"a\"b\\c\nd\te\u0001f"}\n
     * 转义口径：双引号/反斜杠/换行/制表/其余控制字符。 */
    TEST_ASSERT_EQUAL_STRING(
        "{\"t_ms\":1,\"seq\":2,\"ev\":\"gap\",\"what\":"
        "\"a\\\"b\\\\c\\nd\\te\\u0001f\"}\n",
        buf);
    TEST_ASSERT_EQUAL_INT(0, w.overflow);
}

static void test_writer_str_escapes_control_range(void)
{
    char buf[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;
    char v[2];

    v[0] = (char)0x1Fu;
    v[1] = '\0';
    event_log_writer_init(&w, buf, sizeof(buf));
    event_log_writer_begin(&w, 0u, 0u, "drop");
    event_log_writer_str(&w, "reason", v);
    event_log_writer_end(&w);

    TEST_ASSERT_EQUAL_STRING(
        "{\"t_ms\":0,\"seq\":0,\"ev\":\"drop\",\"reason\":\"\\u001f\"}\n", buf);
    TEST_ASSERT_EQUAL_INT(0, w.overflow);
}

/* ---------- writer：定长截断 ---------- */

static void test_writer_truncation_sets_overflow(void)
{
    char buf[8];
    event_log_writer_t w;

    event_log_writer_init(&w, buf, sizeof(buf));
    event_log_writer_begin(&w, 1234u, 5u, "rx");
    /* 28 字节的需求 vs 8 字节容量：必须截断并置 overflow，且不越界。 */
    event_log_writer_int(&w, "type", 2);
    event_log_writer_end(&w);

    TEST_ASSERT_EQUAL_INT(1, w.overflow);
    TEST_ASSERT_TRUE(w.len < sizeof(buf)); /* buf[w.len] = '\0' 可写 */
    TEST_ASSERT_EQUAL_UINT8('\0', (uint8_t)buf[w.len]);
}

/* ---------- 环形缓冲：FIFO ---------- */

static void push_str(event_log_ring_t *r, const char *s)
{
    TEST_ASSERT_EQUAL_INT(0, event_log_ring_push(r, s, strlen(s)));
}

static void test_ring_fifo_order(void)
{
    event_log_ring_t r;
    char out[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    size_t n;

    event_log_ring_init(&r);
    push_str(&r, "{\"seq\":1}\n");
    push_str(&r, "{\"seq\":2}\n");
    push_str(&r, "{\"seq\":3}\n");

    n = event_log_ring_pop(&r, out, sizeof(out));
    TEST_ASSERT_EQUAL_size_t(10, n);
    TEST_ASSERT_EQUAL_STRING("{\"seq\":1}\n", out);
    n = event_log_ring_pop(&r, out, sizeof(out));
    TEST_ASSERT_EQUAL_STRING("{\"seq\":2}\n", out);
    n = event_log_ring_pop(&r, out, sizeof(out));
    TEST_ASSERT_EQUAL_STRING("{\"seq\":3}\n", out);
    TEST_ASSERT_EQUAL_size_t(0, event_log_ring_pop(&r, out, sizeof(out)));
}

/* ---------- 环形缓冲：满则丢最旧 ---------- */

static void test_ring_full_drops_oldest(void)
{
    event_log_ring_t r;
    char out[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    char line[16];

    event_log_ring_init(&r);
    for (int i = 1; i <= 10; i++) {
        (void)snprintf(line, sizeof(line), "{\"n\":%d}\n", i);
        push_str(&r, line);
    }
    TEST_ASSERT_EQUAL_UINT32(2, event_log_ring_dropped(&r));

    /* 环只保留最新 8 行：n=3..10。 */
    for (int i = 3; i <= 10; i++) {
        (void)snprintf(line, sizeof(line), "{\"n\":%d}\n", i);
        TEST_ASSERT_EQUAL_size_t(strlen(line),
                                 event_log_ring_pop(&r, out, sizeof(out)));
        TEST_ASSERT_EQUAL_STRING(line, out);
    }
    /* 弹出不清 dropped 计数。 */
    TEST_ASSERT_EQUAL_UINT32(2, event_log_ring_dropped(&r));
    TEST_ASSERT_EQUAL_size_t(0, event_log_ring_pop(&r, out, sizeof(out)));
}

/* ---------- 环形缓冲：拒收空行 / 超长行 ---------- */

static void test_ring_rejects_empty_and_overlong(void)
{
    event_log_ring_t r;
    char big[BLE_LIGHT_EVENT_LOG_LINE_MAX + 1];

    event_log_ring_init(&r);
    TEST_ASSERT_EQUAL_INT(-1, event_log_ring_push(&r, "", 0));
    memset(big, 'x', sizeof(big));
    big[sizeof(big) - 1] = '\n';
    TEST_ASSERT_EQUAL_INT(-1, event_log_ring_push(&r, big, sizeof(big)));
    TEST_ASSERT_EQUAL_UINT32(2, event_log_ring_rejected(&r));
    TEST_ASSERT_EQUAL_UINT32(0, event_log_ring_dropped(&r));
}

/* ---------- push_writer：writer 溢出整行丢弃 ---------- */

static void test_ring_push_writer_drops_overflow_line(void)
{
    event_log_ring_t r;
    char small[8];
    char out[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_ring_init(&r);
    event_log_writer_init(&w, small, sizeof(small));
    event_log_writer_begin(&w, 1234u, 5u, "rx");
    event_log_writer_int(&w, "type", 2);
    event_log_writer_end(&w);
    TEST_ASSERT_EQUAL_INT(1, w.overflow);

    /* 溢出（截断）行不得入环：JSON 不完整，PC 侧只会当垃圾。 */
    TEST_ASSERT_EQUAL_INT(-1, event_log_ring_push_writer(&r, &w));
    TEST_ASSERT_EQUAL_UINT32(1, event_log_ring_rejected(&r));
    TEST_ASSERT_EQUAL_size_t(0, event_log_ring_pop(&r, out, sizeof(out)));
}

static void test_ring_push_writer_roundtrip(void)
{
    event_log_ring_t r;
    char buf[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    char out[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_ring_init(&r);
    event_log_writer_init(&w, buf, sizeof(buf));
    event_log_writer_begin(&w, 4242u, 9u, "nak");
    event_log_writer_int(&w, "err", 3);
    event_log_writer_end(&w);
    TEST_ASSERT_EQUAL_INT(0, w.overflow);

    TEST_ASSERT_EQUAL_INT(0, event_log_ring_push_writer(&r, &w));
    TEST_ASSERT_EQUAL_size_t(w.len, event_log_ring_pop(&r, out, sizeof(out)));
    TEST_ASSERT_EQUAL_STRING(buf, out);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_writer_basic_line);
    RUN_TEST(test_writer_empty_event_line);
    RUN_TEST(test_writer_str_escaping);
    RUN_TEST(test_writer_str_escapes_control_range);
    RUN_TEST(test_writer_truncation_sets_overflow);
    RUN_TEST(test_ring_fifo_order);
    RUN_TEST(test_ring_full_drops_oldest);
    RUN_TEST(test_ring_rejects_empty_and_overlong);
    RUN_TEST(test_ring_push_writer_drops_overflow_line);
    RUN_TEST(test_ring_push_writer_roundtrip);
    return UNITY_END();
}