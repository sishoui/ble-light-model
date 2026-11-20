// Frame management (firmware/driver, pure C99): double-buffer handoff, queue depth
// (tx_busy), tx_done bookkeeping and glitch counting. See docs/spec/driver.md 1.5 / 1.6 / 7.
//
// Pure C99: no IDF / no malloc / no float / no stdio.

#include "light_core.h"
#include "light_core_internal.h"

/* Glitch counting lives here (frame-start lateness); scheduler decides when to call it. */
void frame_note_glitch(struct light_core *c)
{
    if (c->glitch_count < 0xFFFFu) c->glitch_count++;
#ifdef LIGHT_TELEMETRY
    {
        char val[12];
        unsigned v = c->glitch_count;
        char tmp[11]; int i = 0;
        if (v == 0u) { tmp[i++] = '0'; }
        while (v > 0u) { tmp[i++] = (char)('0' + (int)(v % 10u)); v /= 10u; }
        int j = 0;
        while (i > 0) val[j++] = tmp[--i];
        val[j] = 0;
        char line[40];
        size_t n = 0;
        line[n++] = 'T'; line[n++] = ':';
        const char *key = "glitch_count";
        while (*key) line[n++] = *key++;
        line[n++] = '=';
        const char *s = val;
        while (*s) line[n++] = *s++;
        line[n] = 0;
        c->ports->log(LIGHT_LOG_INFO, line);
    }
#endif
}

/*
 * Record that channel ch has one more transmission in flight on buffer buf,
 * starting at now_us. Returns the new tx_busy count.
 */
uint8_t frame_mark_busy(struct light_core *c, uint8_t ch, uint8_t buf, uint32_t now_us)
{
    c->tx_busy[ch]++;
    if (c->tx_busy[ch] == 1u) c->busy_since_us[ch] = now_us;
    c->busy_mask[ch] |= (uint8_t)(1u << buf);
    return c->tx_busy[ch];
}

/*
 * One transmission finished. Stale/duplicate (tx_busy already 0) is safely ignored.
 * Called from task context; ISR only signals a semaphore (spec 5.4).
 */
void light_core_tx_done(light_core_t *cc, uint8_t ch)
{
    struct light_core *c = (struct light_core *)cc;
    if (ch >= LIGHT_CHANNEL_COUNT) return;
    if (c->tx_busy[ch] == 0u) return; /* stale/duplicate: safely ignore */
    c->tx_busy[ch]--;
    if (c->tx_busy[ch] == 0u) c->busy_mask[ch] = 0u;
}