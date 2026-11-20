// Scheduler (firmware/driver, pure C99): decides when to send which frame to which pin.
// See docs/spec/driver.md 1.1 - 1.6. Pure C99: no IDF / no malloc / no float / no stdio.
//
// Model: two independent channel pipelines, no global barrier. Each channel keeps up to
// two transmissions in flight (tx_busy, queue depth 2). A strip is:
//   ACTIVE -> redraw every 12.5 ms;   STATIC -> dirty redraw + 200 ms heartbeat;
//   IDLE   -> never send (OFF sends exactly one black frame then IDLE).
// due[] is compared with int32 difference to survive the 2^32 wrap.

#include "light_core.h"
#include "light_core_internal.h"

#include <string.h>

#define NOW_US(ms) ((uint32_t)((uint32_t)(ms) * 1000u))
#define CH_OF_STRIP(s) ((uint8_t)((s) / LIGHT_SLOTS_PER_CH))
#define SLOT_OF_STRIP(s) ((uint8_t)((s) % LIGHT_SLOTS_PER_CH))

/* (a - b) as signed, for wrap-safe due comparison / interval. */
static int32_t u32_diff(uint32_t a, uint32_t b)
{
    return (int32_t)(a - b);
}

static uint8_t strip_kind(const struct light_core *c, uint8_t strip)
{
    return c->kind[strip];
}

/* Frame period in us: static heartbeat 200 ms, everything else 12.5 ms. */
static uint32_t period_us_of(uint8_t kind)
{
    return (kind == LIGHT_KIND_STATIC) ? LIGHT_STATIC_PERIOD_US : LIGHT_ACTIVE_PERIOD_US;
}

/* ---------- Telemetry T: lines (spec 6). Core has no stdio/float; integers are
 * formatted here and passed to ports->log (spec 6.6). ---------- */

#ifdef LIGHT_TELEMETRY

static void u32_to_dec(char *out, uint32_t v)
{
    char tmp[11];
    int i = 0;
    if (v == 0u) { out[0] = '0'; out[1] = 0; return; }
    while (v > 0u) { tmp[i++] = (char)('0' + (int)(v % 10u)); v /= 10u; }
    int j = 0;
    while (i > 0) out[j++] = tmp[--i];
    out[j] = 0;
}

static void emit_tline(const struct light_core *c, const char *key, const char *val)
{
    char line[48];
    size_t n = 0;
    line[n++] = 'T'; line[n++] = ':';
    while (*key) line[n++] = *key++;
    line[n++] = '=';
    while (*val) line[n++] = *val++;
    line[n] = 0;
    c->ports->log(LIGHT_LOG_INFO, line);
}

static void emit_t_u32(const struct light_core *c, const char *key, uint32_t v)
{
    char val[12];
    u32_to_dec(val, v);
    emit_tline(c, key, val);
}

static void emit_strip_state(struct light_core *c)
{
    uint16_t st = 0;
    for (int s = 0; s < LIGHT_STRIP_COUNT; s++)
        st |= (uint16_t)((uint16_t)strip_kind(c, (uint8_t)s) << (2 * s));
    if (st != c->prev_strip_state) {
        c->prev_strip_state = st;
        emit_t_u32(c, "strip_state", st);
    }
}

/* 1 Hz aggregate: re-emit resident counters when >=1000 ms elapsed. */
static void tele_flush(struct light_core *c, uint32_t now_ms)
{
    if (u32_diff(now_ms, c->last_tele_ms) >= 1000) {
        c->last_tele_ms = now_ms;
        emit_t_u32(c, "glitch_count", c->glitch_count);
        emit_t_u32(c, "drop_count", c->drop_count);
    }
}

#endif /* LIGHT_TELEMETRY */

/* ---------- Public interface ---------- */

void light_core_init(light_core_t *cc, const light_ports_t *p, uint32_t now_ms)
{
    struct light_core *c = (struct light_core *)cc;
    memset(c, 0, sizeof(*c));
    c->ports = p;
    for (int s = 0; s < LIGHT_STRIP_COUNT; s++) c->kind[s] = LIGHT_KIND_IDLE;
    for (int ch = 0; ch < LIGHT_CHANNEL_COUNT; ch++)
        for (int k = 0; k < LIGHT_SLOTS_PER_CH; k++)
            c->due[ch][k] = 0u; /* IDLE slots: due is irrelevant (kind-gated) */
    c->last_poll_ms = now_ms;
    c->last_tele_ms = now_ms;
}

void light_core_set(light_core_t *cc, uint8_t strip, const light_cfg_t *cfg, uint32_t now_ms)
{
    struct light_core *c = (struct light_core *)cc;
    if (strip >= LIGHT_STRIP_COUNT || cfg == NULL) return;

    c->cfg[strip] = *cfg;

    if (cfg->effect_id == EFFECT_OFF) {
        /* OFF: unless already IDLE, owe one black frame then go IDLE (1.3). */
        if (strip_kind(c, strip) != LIGHT_KIND_IDLE) {
            c->off_pending[strip] = 1;
            c->kind[strip] = LIGHT_KIND_STATIC; /* reuse send path; off_pending makes frame black */
        }
    } else {
        bool active = effect_is_time_varying(cfg->effect_id, cfg->params);
        c->kind[strip] = active ? LIGHT_KIND_ACTIVE : LIGHT_KIND_STATIC;
        c->off_pending[strip] = 0;
    }

    /* Mark dirty: send at the next opportunity. */
    c->due[CH_OF_STRIP(strip)][SLOT_OF_STRIP(strip)] = NOW_US(now_ms);

#ifdef LIGHT_TELEMETRY
    emit_strip_state(c);
#endif
}

/* Pick the slot on channel ch that should be sent now; -1 if none (IDLE slots skipped).
 * Active strips have scheduling priority over static ones so a heartbeat never displaces
 * an active frame (D11). Among equal priority, earliest due wins, then slot order. */
static int pick_due_slot(const struct light_core *c, uint8_t ch, uint32_t now_us)
{
    int best = -1;
    uint32_t best_due = 0u;
    bool best_active = false;
    for (int k = 0; k < LIGHT_SLOTS_PER_CH; k++) {
        uint8_t strip = (uint8_t)(ch * LIGHT_SLOTS_PER_CH + k);
        uint8_t kind = strip_kind(c, strip);
        if (kind == LIGHT_KIND_IDLE) continue;
        uint32_t d = c->due[ch][k];
        if ((int32_t)(d - now_us) > 0) continue; /* not due yet */
        bool is_active = (kind == LIGHT_KIND_ACTIVE);
        if (best < 0 ||
            (is_active && !best_active) ||
            (is_active == best_active && (int32_t)(d - best_due) < 0)) {
            best = k;
            best_due = d;
            best_active = is_active;
        }
    }
    return best;
}

light_poll_t light_core_poll(light_core_t *cc, uint32_t now_ms, uint32_t *sleep_ms)
{
    struct light_core *c = (struct light_core *)cc;
    uint32_t now_us = NOW_US(now_ms);
    uint32_t earliest = 0u;
    bool have_earliest = false;
    bool submitted = false;
    int ch;

    for (ch = 0; ch < LIGHT_CHANNEL_COUNT; ch++) {
        /* Timeout recovery: never deadlock on a lost tx_done. */
        if (c->tx_busy[ch] > 0u &&
            u32_diff(now_us, c->busy_since_us[ch]) > (int32_t)LIGHT_TX_TIMEOUT_US) {
            c->tx_busy[ch] = 0u;
            c->busy_mask[ch] = 0u;
            frame_note_glitch(c);
        }

        if (c->tx_busy[ch] >= 2u) continue; /* queue full, wait for tx_done */

        int k = pick_due_slot(c, (uint8_t)ch, now_us);
        if (k < 0) {
            for (int kk = 0; kk < LIGHT_SLOTS_PER_CH; kk++) {
                uint8_t strip = (uint8_t)(ch * LIGHT_SLOTS_PER_CH + kk);
                if (strip_kind(c, strip) == LIGHT_KIND_IDLE) continue;
                uint32_t d = c->due[ch][kk];
                if (!have_earliest || (int32_t)(d - earliest) < 0) { earliest = d; have_earliest = true; }
            }
            continue;
        }

        uint8_t slot = (uint8_t)k;
        uint8_t strip = (uint8_t)(ch * LIGHT_SLOTS_PER_CH + slot);
        uint8_t buf = c->next_free[ch];
        uint32_t due0 = c->due[ch][slot];

        /* Frame-start late by >2 ms while the channel was idle -> glitch (not normal serialization). */
        if (c->tx_busy[ch] == 0u && u32_diff(now_us, due0) > (int32_t)LIGHT_GLITCH_LATE_US)
            frame_note_glitch(c);

        /* Render + encode into the free buffer. */
        const light_cfg_t *cf = &c->cfg[strip];
        effect_render(cf->effect_id, cf->params, strip, now_ms, c->rgb_scratch);
        ws_encode(c->rgb_scratch, c->sym[ch][buf]);

        /* Route (fan-out+OE main path, or switch_gpio fallback): select next frame's slot. */
        if (c->ports->route) c->ports->route(ch, slot);

        if (c->ports->tx_submit(ch, c->sym[ch][buf], LIGHT_SYMBOLS)) {
#ifdef LIGHT_TELEMETRY
            uint32_t prev_submit_us = c->last_submit_us[strip];
#endif
            c->next_free[ch] ^= 1u;
            frame_mark_busy(c, (uint8_t)ch, buf, now_us);

            c->last_submit_us[strip] = now_us;
            c->last_slot[ch] = slot;
            c->first_sent_done = 1;
            if (c->first_sent_ms == 0u) c->first_sent_ms = now_ms;

            if (c->off_pending[strip]) {
                /* OFF: this black frame was sent; go IDLE, no further schedule. */
                c->off_pending[strip] = 0;
                c->kind[strip] = LIGHT_KIND_IDLE;
            } else {
                c->due[ch][slot] = now_us + period_us_of(strip_kind(c, strip));
            }

            submitted = true;

#ifdef LIGHT_TELEMETRY
            /* Per-frame interval in whole ms (actual submit-to-submit gap for this strip). */
            uint32_t gap_us = now_us - prev_submit_us;
            emit_t_u32(c, "frame_ms", gap_us / 1000u);
            /* Static strips: a >=100 ms gap is a heartbeat (not a dirty redraw). */
            if (strip_kind(c, strip) == LIGHT_KIND_STATIC && prev_submit_us != 0u &&
                gap_us >= 100000u) {
                emit_t_u32(c, "heartbeat_ms", gap_us / 1000u);
            }
            /* Channel slot lines on change. */
            emit_t_u32(c, "ch0_slot", c->last_slot[0]);
            emit_t_u32(c, "ch1_slot", c->last_slot[1]);
#endif
        }
        /* tx_submit returned false: not counted, retried next poll. */
    }

#ifdef LIGHT_TELEMETRY
    tele_flush(c, now_ms);
#endif

    if (submitted) return LIGHT_POLL_AGAIN;

    if (c->tx_busy[0] == 0u && c->tx_busy[1] == 0u && !have_earliest) {
        *sleep_ms = 1u; /* all IDLE: short sleep */
        return LIGHT_POLL_SLEEP;
    }
    if (have_earliest) {
        int32_t dt = u32_diff(earliest, now_us);
        if (dt <= 0) { *sleep_ms = 1u; return LIGHT_POLL_SLEEP; }
        *sleep_ms = (uint32_t)(dt / 1000);
        if (*sleep_ms == 0u) *sleep_ms = 1u;
        return LIGHT_POLL_SLEEP;
    }
    *sleep_ms = 1u;
    return LIGHT_POLL_SLEEP;
}

uint16_t light_core_glitch_count(const light_core_t *cc)
{
    const struct light_core *c = (const struct light_core *)cc;
    return c->glitch_count;
}

uint16_t light_core_drop_count(const light_core_t *cc)
{
    const struct light_core *c = (const struct light_core *)cc;
    return c->drop_count;
}