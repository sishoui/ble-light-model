// Encoder (firmware/driver, pure C99): logical RGB -> WS2812 GRB bit-stream symbols.
// See docs/spec/driver.md 2.1 / 5.2: one strip = 100 LEDs x 24 bit = 2400 symbols.
//
// Symbol bit layout is fixed to RMT's duration0:15 | level0:1 | duration1:15 | level1:1
// (#23 verified hal/rmt_types.h:31-35). Each symbol is {d0,l0,d1,l1}:
//   bit 0 = (T0H, T0L), bit 1 = (T1H, T1L).
// At 20 MHz: T0H=8, T0L=17, T1H=16, T1L=9 ticks; bit period is always 25 ticks = 1.25 us.
// Wire order is GRB, MSB first per byte (WS2812 expects G first, then R, then B).

#include "light_core.h"

/* Build one symbol: high-phase (dur0, level0) followed by low-phase (dur1, level1). */
static uint32_t sym_make(uint32_t dur0, uint32_t level0, uint32_t dur1, uint32_t level1)
{
    return (dur0 & 0x7FFFu)
         | ((level0 & 0x1u) << 15)
         | ((dur1 & 0x7FFFu) << 16)
         | ((level1 & 0x1u) << 31);
}

void ws_encode(const uint8_t rgb[LIGHT_RGB_BYTES], uint32_t sym[LIGHT_SYMBOLS])
{
    /* Each symbol corresponds to one data bit: symbol 0..23 = LED0, 24..47 = LED1, etc.
     * WS2812 needs GRB order (G=bits0..7, R=bits8..15, B=bits16..23), MSB first per byte. */
    const uint8_t *p = rgb;
    for (int led = 0; led < LIGHT_LEDS; led++) {
        uint8_t g = p[1], r = p[0], b = p[2];
        p += 3;
        const uint8_t bytes[3] = { g, r, b };
        for (int bi = 0; bi < 3; bi++) {
            uint8_t byte = bytes[bi];
            for (int biti = 7; biti >= 0; biti--) {
                if ((byte >> biti) & 0x1u) {
                    *sym++ = sym_make(LIGHT_SYM_T1H_TICKS, 1u, LIGHT_SYM_T1L_TICKS, 0u);
                } else {
                    *sym++ = sym_make(LIGHT_SYM_T0H_TICKS, 1u, LIGHT_SYM_T0L_TICKS, 0u);
                }
            }
        }
    }
}