// Driver core internal implementation header (not exported).
// Used internally by firmware/driver/src.

#ifndef LIGHT_CORE_INTERNAL_H
#define LIGHT_CORE_INTERNAL_H

#include <stdbool.h>
#include <stdint.h>

#include "light_core.h"

/* Per-strip scheduling category (driver.md 1.2 / 1.3). */
enum light_kind {
    LIGHT_KIND_IDLE   = 0, /* off/not configured: never send (OFF sends one frame then IDLE) */
    LIGHT_KIND_ACTIVE = 1, /* time-varying: redraw every 12.5 ms */
    LIGHT_KIND_STATIC = 2  /* static: dirty redraw + 200 ms heartbeat */
};

/* Internal state machine. Opaque externally (see light_core.h). */
struct light_core {
    const light_ports_t *ports;

    light_cfg_t cfg[LIGHT_STRIP_COUNT]; /* current config per strip */
    uint8_t kind[LIGHT_STRIP_COUNT];    /* see enum light_kind */

    /* due[ch][slot]: next send time for that slot, in microseconds (mod 2^32, int32-diff compare). */
    uint32_t due[LIGHT_CHANNEL_COUNT][LIGHT_SLOTS_PER_CH];

    /* Double-buffered symbols: sym[ch][buf][LIGHT_SYMBOLS]. tx_submit does not copy;
     * core guarantees the buffer is not overwritten until tx_done for it arrives. */
    uint32_t sym[LIGHT_CHANNEL_COUNT][2][LIGHT_SYMBOLS];

    uint8_t next_free[LIGHT_CHANNEL_COUNT];      /* next writable buffer index (0|1) */
    uint8_t tx_busy[LIGHT_CHANNEL_COUNT];        /* in-flight transmissions (0..2) */
    uint8_t busy_mask[LIGHT_CHANNEL_COUNT];      /* bit mask of buffers held by in-flight tx (bit0=buf0,bit1=buf1) */
    uint32_t busy_since_us[LIGHT_CHANNEL_COUNT]; /* microsecond timestamp when tx_busy became >0 */

    uint32_t last_submit_us[LIGHT_STRIP_COUNT];  /* last submit time per strip (frame_ms / heartbeat_ms) */
    uint8_t last_slot[LIGHT_CHANNEL_COUNT];      /* last submitted slot (ch0_slot / ch1_slot) */

    uint16_t glitch_count;   /* frame-start late >2 ms count (real source of STATUS.glitch_count) */
    uint16_t drop_count;     /* skipped frames due to missing a whole period (diagnostic) */

    uint32_t first_sent_ms;  /* now_ms of first submit (reference for heartbeat gap) */
    uint16_t prev_strip_state; /* last strip_state bitmap (telemetry only on change) */
    uint8_t first_sent_done;  /* a submit has happened at least once */

    uint8_t off_pending[LIGHT_STRIP_COUNT]; /* OFF: one black frame still owed before IDLE */
    uint8_t rgb_scratch[LIGHT_RGB_BYTES];   /* per-frame render target (LIGHT_LEDS*3) */

    uint32_t last_poll_ms;   /* now_ms of last poll */
    uint32_t last_tele_ms;   /* now_ms of last telemetry aggregate line (1 Hz throttle) */
};

/* frame.c exports (scheduler in sched.c calls these). */
void frame_note_glitch(struct light_core *c);
uint8_t frame_mark_busy(struct light_core *c, uint8_t ch, uint8_t buf, uint32_t now_us);

#endif /* LIGHT_CORE_INTERNAL_H */