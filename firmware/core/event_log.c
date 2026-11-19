/*
 * 事件日志（JSONL）核心实现（纯 C99，无动态内存）。
 *
 * writer 追加语义：容量含 NUL 余量（len <= cap-1 时 buf[len] 恒可写 '\0'），
 * 放不下即置 overflow 并停止追加 —— 整行作废由 push_writer 统一拦截，避免
 * 半截 JSON 混入串口流。转义口径见 event_log.h。
 */

#include "event_log.h"

#include <string.h>

/* ---------- writer 内部 ---------- */

/* 追加 n 字节原文（不转义）。放不下置 overflow。 */
static void append_raw(event_log_writer_t *w, const char *s, size_t n)
{
    if (w->overflow) {
        return;
    }
    if (w->len + n + 1u > w->cap) {
        w->overflow = 1;
        return;
    }
    memcpy(w->buf + w->len, s, n);
    w->len += n;
    w->buf[w->len] = '\0';
}

static void append_char(event_log_writer_t *w, char c)
{
    append_raw(w, &c, 1u);
}

/* 无符号十进制（writer_int 的负数也走这里，先取幅值）。 */
static void append_uint(event_log_writer_t *w, unsigned long v)
{
    char tmp[24];
    size_t n = 0u;

    do {
        tmp[n++] = (char)('0' + (char)(v % 10u));
        v /= 10u;
    } while (v != 0u && n < sizeof(tmp));
    while (n > 0u) {
        append_char(w, tmp[--n]);
    }
}

/* JSON 字符串转义追加（不含两侧引号）。 */
static void append_escaped(event_log_writer_t *w, const char *s)
{
    static const char hex[] = "0123456789abcdef";

    for (; *s != '\0'; s++) {
        unsigned char c = (unsigned char)*s;

        switch (c) {
        case '"':
            append_raw(w, "\\\"", 2u);
            break;
        case '\\':
            append_raw(w, "\\\\", 2u);
            break;
        case '\b':
            append_raw(w, "\\b", 2u);
            break;
        case '\f':
            append_raw(w, "\\f", 2u);
            break;
        case '\n':
            append_raw(w, "\\n", 2u);
            break;
        case '\r':
            append_raw(w, "\\r", 2u);
            break;
        case '\t':
            append_raw(w, "\\t", 2u);
            break;
        default:
            if (c < 0x20u) {
                char esc[6];

                esc[0] = '\\';
                esc[1] = 'u';
                esc[2] = '0';
                esc[3] = '0';
                esc[4] = hex[(c >> 4) & 0x0Fu];
                esc[5] = hex[c & 0x0Fu];
                append_raw(w, esc, 6u);
            } else {
                append_char(w, (char)c);
            }
            break;
        }
    }
}

/* ---------- writer 公共接口 ---------- */

void event_log_writer_init(event_log_writer_t *w, char *buf, size_t cap)
{
    w->buf = buf;
    w->cap = cap;
    w->len = 0u;
    w->overflow = 0;
    if (cap > 0u) {
        buf[0] = '\0';
    } else {
        w->overflow = 1; /* 零容量：任何追加都失败 */
    }
}

void event_log_writer_begin(event_log_writer_t *w, uint32_t t_ms,
                            uint16_t seq, const char *ev)
{
    append_raw(w, "{\"t_ms\":", 8u);
    append_uint(w, (unsigned long)t_ms);
    append_raw(w, ",\"seq\":", 7u);
    append_uint(w, (unsigned long)seq);
    append_raw(w, ",\"ev\":\"", 7u);
    append_escaped(w, ev);
    append_char(w, '"');
}

void event_log_writer_int(event_log_writer_t *w, const char *key, long v)
{
    append_char(w, ',');
    append_char(w, '"');
    append_escaped(w, key);
    append_raw(w, "\":", 2u);
    if (v < 0) {
        append_char(w, '-');
        append_uint(w, (unsigned long)(-(v + 1)) + 1u);
    } else {
        append_uint(w, (unsigned long)v);
    }
}

void event_log_writer_str(event_log_writer_t *w, const char *key,
                          const char *v)
{
    append_char(w, ',');
    append_char(w, '"');
    append_escaped(w, key);
    append_raw(w, "\":\"", 3u);
    append_escaped(w, v);
    append_char(w, '"');
}

void event_log_writer_end(event_log_writer_t *w)
{
    append_raw(w, "}\n", 2u);
}

/* ---------- 环形缓冲 ---------- */

void event_log_ring_init(event_log_ring_t *r)
{
    memset(r, 0, sizeof(*r));
}

int event_log_ring_push(event_log_ring_t *r, const char *line, size_t len)
{
    if (len == 0u || len >= BLE_LIGHT_EVENT_LOG_LINE_MAX) {
        r->rejected++;
        return -1;
    }

    if (r->count >= BLE_LIGHT_EVENT_LOG_RING_LINES) {
        /* 环满：丢最旧行（tail 前进），计数。 */
        r->tail = (uint8_t)((r->tail + 1u) % BLE_LIGHT_EVENT_LOG_RING_LINES);
        r->count--;
        r->dropped++;
    }
    memcpy(r->lines[r->head], line, len);
    r->lines[r->head][len] = '\0';
    r->lens[r->head] = (uint16_t)len;
    r->head = (uint8_t)((r->head + 1u) % BLE_LIGHT_EVENT_LOG_RING_LINES);
    r->count++;
    return 0;
}

size_t event_log_ring_pop(event_log_ring_t *r, char *out, size_t out_cap)
{
    size_t len;

    if (r->count == 0u) {
        return 0u;
    }
    len = r->lens[r->tail];
    if (len + 1u > out_cap) {
        return 0u; /* 调用方缓冲过小：不消费（调用方须 >= LINE_MAX） */
    }
    memcpy(out, r->lines[r->tail], len + 1u); /* 含 NUL */
    r->tail = (uint8_t)((r->tail + 1u) % BLE_LIGHT_EVENT_LOG_RING_LINES);
    r->count--;
    return len;
}

int event_log_ring_push_writer(event_log_ring_t *r,
                               const event_log_writer_t *w)
{
    if (w->overflow) {
        r->rejected++;
        return -1;
    }
    return event_log_ring_push(r, w->buf, w->len);
}

uint32_t event_log_ring_dropped(const event_log_ring_t *r)
{
    return r->dropped;
}

uint32_t event_log_ring_rejected(const event_log_ring_t *r)
{
    return r->rejected;
}