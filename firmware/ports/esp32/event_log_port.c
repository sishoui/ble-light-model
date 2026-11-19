/*
 * 事件日志 ports 实现（ports/esp32，#15）。
 *
 * 结构：core/event_log 的 writer 格式化单行 -> core 环形缓冲 -> 由 console
 * 任务（app.c）周期 flush 到 USB CDC。单行最长 BLE_LIGHT_EVENT_LOG_LINE_MAX
 * 字节；writer 溢出（行超长）整行丢弃（rejected++），环满丢最旧（dropped++），
 * 全部定长、无动态内存。
 *
 * t_ms 取 esp_timer 单调毫秒。JSON 里不含任何 NimBLE/IDF 句柄，纯数值与
 * 短静态字符串 —— PC 侧 json.loads 直接解析。
 */

#include "event_log_port.h"

#include "esp_timer.h"

#include "event_log.h" /* core：JSON writer + 环形缓冲（纯函数层） */

static event_log_ring_t s_ring;
static event_log_write_fn s_write;
static void *s_write_ctx;

/* core 环形缓冲计数（诊断口径，STATUS 之外的旁路信号）。 */
uint32_t event_log_ring_dropped_count(void);
uint32_t event_log_ring_rejected_count(void);

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

/* 格式化 -> 入环（writer 溢出整行丢弃）。 */
static void push(event_log_writer_t *w)
{
    (void)event_log_ring_push_writer(&s_ring, w);
}

void event_log_init(void)
{
    event_log_ring_init(&s_ring);
    s_write = NULL;
    s_write_ctx = NULL;
}

void event_log_attach(event_log_write_fn fn, void *ctx)
{
    s_write = fn;
    s_write_ctx = ctx;
}

void event_log_flush(void)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    size_t n;

    if (s_write == NULL) {
        return;
    }
    while ((n = event_log_ring_pop(&s_ring, line, sizeof(line))) > 0u) {
        s_write(line, n, s_write_ctx);
    }
}

void event_log_emit_boot(const char *fw)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), 0u, "boot");
    event_log_writer_str(&w, "fw", fw);
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_connect(void)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), 0u, "gap");
    event_log_writer_str(&w, "what", "connect");
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_disconnect(int reason)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), 0u, "gap");
    event_log_writer_str(&w, "what", "disconnect");
    event_log_writer_int(&w, "reason", reason);
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_subscribe(int notify)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), 0u, "gap");
    event_log_writer_str(&w, "what", "subscribe");
    event_log_writer_int(&w, "notify", notify);
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_mtu(uint16_t mtu)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), 0u, "gap");
    event_log_writer_str(&w, "what", "mtu");
    event_log_writer_int(&w, "mtu", mtu);
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_rx(uint16_t seq, uint8_t type, uint8_t flags,
                       uint8_t len)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), seq, "rx");
    event_log_writer_int(&w, "type", type);
    event_log_writer_int(&w, "flags", flags);
    event_log_writer_int(&w, "len", len);
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_ack(uint16_t seq)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), seq, "ack");
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_nak(uint16_t seq, uint8_t err)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), seq, "nak");
    event_log_writer_int(&w, "err", err);
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_status(uint16_t seq, uint8_t brightness,
                           uint16_t glitch, uint16_t drop)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), seq, "status");
    event_log_writer_int(&w, "brightness", brightness);
    event_log_writer_int(&w, "glitch", glitch);
    event_log_writer_int(&w, "drop", drop);
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_nvs_save(int rc)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), 0u, "nvs");
    event_log_writer_str(&w, "op", "save");
    event_log_writer_int(&w, "rc", rc);
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_drop(const char *reason, uint8_t err)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), 0u, "drop");
    event_log_writer_str(&w, "reason", reason);
    if (err != 0u) {
        event_log_writer_int(&w, "err", err);
    }
    event_log_writer_end(&w);
    push(&w);
}

void event_log_emit_glitch(uint16_t count)
{
    char line[BLE_LIGHT_EVENT_LOG_LINE_MAX];
    event_log_writer_t w;

    event_log_writer_init(&w, line, sizeof(line));
    event_log_writer_begin(&w, now_ms(), 0u, "glitch");
    event_log_writer_int(&w, "count", count);
    event_log_writer_end(&w);
    push(&w);
}

uint32_t event_log_ring_dropped_count(void)
{
    return event_log_ring_dropped(&s_ring);
}

uint32_t event_log_ring_rejected_count(void)
{
    return event_log_ring_rejected(&s_ring);
}