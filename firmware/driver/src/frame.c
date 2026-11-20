// Frame management (firmware/driver, pure C99): double-buffer handoff, queue depth
// (tx_busy), tx_done bookkeeping and glitch counting. See docs/spec/driver.md 1.5 / 1.6 / 7.
//
// Pure C99: no IDF / no malloc / no float / no stdio.

#include "light_core.h"
#include "light_core_internal.h"
#include "telemetry.h"

/* Glitch counting lives here (frame-start lateness); scheduler decides when to call it. */
void frame_note_glitch(struct light_core *c)
{
    if (c->glitch_count < 0xFFFFu) c->glitch_count++;
#ifdef LIGHT_TELEMETRY
    telemetry_emit_t_u32(c->ports, "glitch_count", c->glitch_count);
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