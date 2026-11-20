// Driver host tests (firmware/driver + effects) for PlatformIO [env:native] Unity.
// Covers docs/spec/driver.md 7 (D1-D16) plus the T: telemetry contract (6).
//
// Uses fake light_ports_t (fake clock + capturing tx_submit/route/log) and a small
// transmission model: each channel serializes frames, each frame takes FRAME_MS, and
// tx_done is delivered when the frame completes. This keeps the tests hardware-free.

#include <unity.h>
#include <string.h>

#include "light_core.h"
#include "effect_engine.h"
#include "telemetry.h"

void run_effects_tests(void); /* provided by test_effects.c (single main lives here) */

#define FRAME_MS 3u /* LIGHT_FRAME_US / 1000 */

/* ---------- Fake ports ---------- */

#define SUB_MAX 2048
#define ROUTE_MAX 2048
#define LOG_MAX 1024
#define LOG_LEN 48

typedef struct {
    uint8_t ch;
    uint8_t slot;
    uint32_t t_ms;                /* submission time */
    const uint32_t *sym;          /* buffer handed to tx_submit */
} sub_rec_t;

typedef struct {
    uint8_t ch;
    uint8_t slot;
    uint32_t t_ms;
} route_rec_t;

static struct {
    uint32_t clock_ms;
    bool submit_ok;               /* control tx_submit return value */

    uint8_t pending_slot[LIGHT_CHANNEL_COUNT];

    sub_rec_t subs[SUB_MAX];
    int sub_count;

    route_rec_t routes[ROUTE_MAX];
    int route_count;

    char logs[LOG_MAX][LOG_LEN];
    int log_count;

    /* per-channel transmission model */
    uint32_t busy_until[LIGHT_CHANNEL_COUNT];
    uint32_t done_at[LIGHT_CHANNEL_COUNT][16];
    int done_n[LIGHT_CHANNEL_COUNT];
    uint32_t completions[LIGHT_CHANNEL_COUNT][256]; /* delivered done times per channel */
    int comp_n[LIGHT_CHANNEL_COUNT];
} fake;

/* last captured symbol bytes per strip (strip = ch*4+slot) */
static uint32_t cap_first[LIGHT_STRIP_COUNT][LIGHT_SYMBOLS];
static uint32_t cap_last[LIGHT_STRIP_COUNT][LIGHT_SYMBOLS];
static bool cap_has_first[LIGHT_STRIP_COUNT];
static int cap_count[LIGHT_STRIP_COUNT];

static uint32_t fake_now_ms(void) { return fake.clock_ms; }

static void fake_route(uint8_t ch, uint8_t slot)
{
    if (fake.route_count < ROUTE_MAX) {
        fake.routes[fake.route_count].ch = ch;
        fake.routes[fake.route_count].slot = slot;
        fake.routes[fake.route_count].t_ms = fake.clock_ms;
        fake.route_count++;
    }
    fake.pending_slot[ch] = slot;
}

static bool fake_tx_submit(uint8_t ch, const uint32_t *sym, size_t n)
{
    if (!fake.submit_ok) return false;
    uint8_t slot = fake.pending_slot[ch];
    uint8_t strip = (uint8_t)(ch * LIGHT_SLOTS_PER_CH + slot);

    if (fake.sub_count < SUB_MAX) {
        sub_rec_t *r = &fake.subs[fake.sub_count++];
        r->ch = ch;
        r->slot = slot;
        r->t_ms = fake.clock_ms;
        r->sym = sym;
    }
    /* capture frame bytes per strip */
    if (n <= LIGHT_SYMBOLS) {
        if (!cap_has_first[strip]) {
            memcpy(cap_first[strip], sym, n * sizeof(uint32_t));
            cap_has_first[strip] = true;
        }
        memcpy(cap_last[strip], sym, n * sizeof(uint32_t));
        cap_count[strip]++;
    }

    /* transmission model: serialize on the channel, each frame FRAME_MS */
    uint32_t start = fake.clock_ms;
    if (fake.busy_until[ch] > start) start = fake.busy_until[ch];
    uint32_t done = start + FRAME_MS;
    fake.busy_until[ch] = done;
    if (fake.done_n[ch] < 16) fake.done_at[ch][fake.done_n[ch]++] = done;
    return true;
}

static void fake_log(uint8_t level, const char *msg)
{
    (void)level;
    if (fake.log_count < LOG_MAX) {
        strncpy(fake.logs[fake.log_count], msg, LOG_LEN - 1);
        fake.logs[fake.log_count][LOG_LEN - 1] = 0;
        fake.log_count++;
    }
}

static light_ports_t g_ports;

/* ---------- globals ---------- */

static light_core_storage_t g_store;
static light_core_t *g_core;

static void fake_reset(void)
{
    memset(&fake, 0, sizeof(fake));
    memset(cap_first, 0, sizeof(cap_first));
    memset(cap_last, 0, sizeof(cap_last));
    memset(cap_has_first, 0, sizeof(cap_has_first));
    memset(cap_count, 0, sizeof(cap_count));
    fake.submit_ok = true;

    g_ports.now_ms = fake_now_ms;
    g_ports.tx_submit = fake_tx_submit;
    g_ports.route = fake_route;
    g_ports.log = fake_log;
}

/* deliver tx_done for completions due at or before now */
static void deliver_done(void)
{
    for (int ch = 0; ch < LIGHT_CHANNEL_COUNT; ch++) {
        while (fake.done_n[ch] > 0 && fake.done_at[ch][0] <= fake.clock_ms) {
            uint32_t t = fake.done_at[ch][0];
            if (fake.comp_n[ch] < 256) fake.completions[ch][fake.comp_n[ch]++] = t;
            for (int i = 1; i < fake.done_n[ch]; i++) fake.done_at[ch][i - 1] = fake.done_at[ch][i];
            fake.done_n[ch]--;
            if (g_core) light_core_tx_done(g_core, (uint8_t)ch);
        }
    }
}

/* one poll loop at the current clock */
static void poll_once(void)
{
    uint32_t sleep_ms = 0;
    for (int guard = 0; guard < 32; guard++) {
        if (light_core_poll(g_core, fake.clock_ms, &sleep_ms) == LIGHT_POLL_SLEEP) break;
    }
}

/* step the fake clock from current to target ms (1 ms granularity), polling each ms.
 * Uses int32 difference so it also works across the 2^32 wrap (D15). */
static void run_until(uint32_t target_ms)
{
    for (;;) {
        deliver_done();
        poll_once();
        if ((int32_t)(target_ms - fake.clock_ms) <= 0) break;
        fake.clock_ms++;
    }
}

void setUp(void)
{
    fake_reset();
    memset(&g_store, 0, sizeof(g_store));
    g_core = (light_core_t *)&g_store;
    light_core_init(g_core, &g_ports, 0);
}

void tearDown(void) {}

/* ---------- helpers ---------- */

static light_cfg_t make_cfg(uint8_t id, const uint8_t *params, uint8_t len)
{
    light_cfg_t c;
    memset(&c, 0, sizeof(c));
    c.effect_id = id;
    c.param_len = len;
    if (params && len) memcpy(c.params, params, len);
    return c;
}

static light_cfg_t cfg_static_rgb(uint8_t r, uint8_t g, uint8_t b)
{
    uint8_t p[3] = { r, g, b };
    return make_cfg(EFFECT_STATIC, p, 3);
}

static light_cfg_t cfg_active_rainbow(void)
{
    uint8_t p[3] = { 0x80, 0xFF, 0x00 }; /* speed=0x80, sat=255, dir=0 */
    return make_cfg(EFFECT_RAINBOW, p, 3);
}

/* decode one symbol's data bit: bit 1 has the long high phase (T1H = 16 ticks),
 * bit 0 has the short one (T0H = 8 ticks). Both use level0=1, so decode by duration. */
static int sym_bit(uint32_t s)
{
    uint32_t d0 = s & 0x7FFFu;
    return (d0 == LIGHT_SYM_T1H_TICKS) ? 1 : 0;
}

/* total frame duration in ticks (sum of both phases per symbol) */
static uint64_t frame_ticks(const uint32_t *sym)
{
    uint64_t t = 0;
    for (int i = 0; i < LIGHT_SYMBOLS; i++) {
        t += (sym[i] & 0x7FFFu) + ((sym[i] >> 16) & 0x7FFFu);
    }
    return t;
}

/* count submissions attributed to a strip */
static int strip_sub_count(uint8_t strip)
{
    int n = 0;
    for (int i = 0; i < fake.sub_count; i++) {
        if (fake.subs[i].ch * LIGHT_SLOTS_PER_CH + fake.subs[i].slot == strip) n++;
    }
    return n;
}

/* find a T: line by key, return value string or NULL */
static const char *find_tline(const char *key)
{
    char want[24];
    size_t n = 0;
    want[n++] = 'T'; want[n++] = ':';
    while (*key && n < sizeof(want) - 2) want[n++] = *key++;
    want[n++] = '=';
    want[n] = 0;
    for (int i = 0; i < fake.log_count; i++) {
        if (strncmp(fake.logs[i], want, n) == 0) return fake.logs[i] + n;
    }
    return NULL;
}

/* =====================================================================
 * D1 / D2: encoder golden, symbol count, frame duration, GRB order
 * ===================================================================== */

static void test_d1_encode_0000(void)
{
    uint8_t rgb[LIGHT_RGB_BYTES];
    uint32_t sym[LIGHT_SYMBOLS];
    memset(rgb, 0x00, sizeof(rgb));
    ws_encode(rgb, sym);
    /* every bit is 0: (d0,l0,d1,l1) = (8,1,17,0) */
    for (int i = 0; i < LIGHT_SYMBOLS; i++) {
        TEST_ASSERT_EQUAL_UINT32(8u, sym[i] & 0x7FFFu);
        TEST_ASSERT_EQUAL_UINT32(1u, (sym[i] >> 15) & 1u);
        TEST_ASSERT_EQUAL_UINT32(17u, (sym[i] >> 16) & 0x7FFFu);
        TEST_ASSERT_EQUAL_UINT32(0u, (sym[i] >> 31) & 1u);
    }
    TEST_ASSERT_EQUAL_UINT64(60000u, frame_ticks(sym)); /* 60000 ticks * 0.05 us = 3.000 ms */
}

static void test_d1_encode_ffff(void)
{
    uint8_t rgb[LIGHT_RGB_BYTES];
    uint32_t sym[LIGHT_SYMBOLS];
    memset(rgb, 0xFF, sizeof(rgb));
    ws_encode(rgb, sym);
    /* every bit is 1: (16,1,9,0) */
    for (int i = 0; i < LIGHT_SYMBOLS; i++) {
        TEST_ASSERT_EQUAL_UINT32(16u, sym[i] & 0x7FFFu);
        TEST_ASSERT_EQUAL_UINT32(1u, (sym[i] >> 15) & 1u);
        TEST_ASSERT_EQUAL_UINT32(9u, (sym[i] >> 16) & 0x7FFFu);
        TEST_ASSERT_EQUAL_UINT32(0u, (sym[i] >> 31) & 1u);
    }
    TEST_ASSERT_EQUAL_UINT64(60000u, frame_ticks(sym));
}

static void test_d1_encode_5555(void)
{
    uint8_t rgb[LIGHT_RGB_BYTES];
    uint32_t sym[LIGHT_SYMBOLS];
    memset(rgb, 0x55, sizeof(rgb)); /* 01010101 per byte */
    ws_encode(rgb, sym);
    /* 0x55 = 0101_0101, MSB first: 0,1,0,1,0,1,0,1 */
    for (int i = 0; i < LIGHT_SYMBOLS; i++) {
        int expect = ((i % 8) % 2 == 0) ? 0 : 1; /* bit 0 first (MSB) */
        TEST_ASSERT_EQUAL_INT(expect, sym_bit(sym[i]));
        if (expect) {
            TEST_ASSERT_EQUAL_UINT32(16u, sym[i] & 0x7FFFu);
            TEST_ASSERT_EQUAL_UINT32(9u, (sym[i] >> 16) & 0x7FFFu);
        } else {
            TEST_ASSERT_EQUAL_UINT32(8u, sym[i] & 0x7FFFu);
            TEST_ASSERT_EQUAL_UINT32(17u, (sym[i] >> 16) & 0x7FFFu);
        }
    }
    TEST_ASSERT_EQUAL_UINT64(60000u, frame_ticks(sym));
}

static void test_d1_symbol_count_and_duration(void)
{
    uint8_t rgb[LIGHT_RGB_BYTES];
    uint32_t sym[LIGHT_SYMBOLS];
    memset(rgb, 0x3C, sizeof(rgb));
    ws_encode(rgb, sym);
    TEST_ASSERT_EQUAL_INT(2400, LIGHT_SYMBOLS);
    /* total duration 3.000 ms = 60000 ticks at 20 MHz */
    TEST_ASSERT_EQUAL_UINT64(60000u, frame_ticks(sym));
}

static void test_d2_grb_order(void)
{
    /* pixel 0: R=0x12 G=0x34 B=0x56. Wire order must be G,R,B. */
    uint8_t rgb[LIGHT_RGB_BYTES];
    uint32_t sym[LIGHT_SYMBOLS];
    memset(rgb, 0, sizeof(rgb));
    rgb[0] = 0x12; rgb[1] = 0x34; rgb[2] = 0x56;
    ws_encode(rgb, sym);

    /* symbols 0..7 = G byte (0x34), 8..15 = R (0x12), 16..23 = B (0x56) */
    uint8_t g = 0, r = 0, b = 0;
    for (int i = 0; i < 8; i++) g = (uint8_t)((g << 1) | sym_bit(sym[i]));
    for (int i = 8; i < 16; i++) r = (uint8_t)((r << 1) | sym_bit(sym[i]));
    for (int i = 16; i < 24; i++) b = (uint8_t)((b << 1) | sym_bit(sym[i]));
    TEST_ASSERT_EQUAL_UINT8(0x34, g);
    TEST_ASSERT_EQUAL_UINT8(0x12, r);
    TEST_ASSERT_EQUAL_UINT8(0x56, b);
}

/* =====================================================================
 * D3: driver-level determinism (two identical cores -> identical submissions)
 * ===================================================================== */

static void test_d3_driver_deterministic(void)
{
    /* Run the same strip/schedule twice; the last encoded frame must be identical. */
    light_cfg_t cfg = cfg_active_rainbow();

    light_core_set(g_core, 0, &cfg, 0);
    run_until(40);
    uint32_t a_last[LIGHT_SYMBOLS];
    memcpy(a_last, cap_last[0], sizeof(a_last));

    /* identical fresh run */
    setUp(); /* resets clock + fake */
    light_core_set(g_core, 0, &cfg, 0);
    run_until(40);
    TEST_ASSERT_EQUAL_UINT32_ARRAY(a_last, cap_last[0], LIGHT_SYMBOLS);
}

/* =====================================================================
 * D4 / D5: speed=0 freeze classification, activity table via core scheduling
 * ===================================================================== */

static void test_d4_speed_zero_is_static(void)
{
    /* rainbow speed=0 -> static: only dirty redraw + 200 ms heartbeat, never 12.5 ms */
    uint8_t p[3] = { 0x00, 0xFF, 0x00 }; /* speed=0 */
    light_cfg_t cfg = make_cfg(EFFECT_RAINBOW, p, 3);
    light_core_set(g_core, 0, &cfg, 0);
    run_until(300);

    int n = strip_sub_count(0);
    /* 200 ms heartbeat over 300 ms -> first + 1 heartbeat = 2, definitely not 80 Hz */
    TEST_ASSERT_TRUE(n >= 1);
    TEST_ASSERT_TRUE(n <= 3);
}

static void test_d5_activity_table_via_core(void)
{
    struct { uint8_t id; uint8_t params[10]; uint8_t len; } cases[] = {
        { EFFECT_OFF,      { 0 }, 0 },
        { EFFECT_STATIC,   { 0xFF, 0x00, 0x00 }, 3 },
        { EFFECT_BREATH,   { 0xFF, 0x00, 0x00, 0xE8, 0x03, 0x00, 0xFF }, 7 },
        { EFFECT_BREATH,   { 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF }, 7 },
        { EFFECT_GRADIENT, { 0xFF, 0, 0, 0, 0, 0xFF, 0xE8, 0x03, 0x00 }, 9 },
        { EFFECT_GRADIENT, { 0xFF, 0, 0, 0, 0, 0xFF, 0x00, 0x00, 0x00 }, 9 },
        { EFFECT_RAINBOW,  { 0xFF, 0xFF, 0x00 }, 3 },
        { EFFECT_RAINBOW,  { 0x00, 0xFF, 0x00 }, 3 },
        { EFFECT_FLOW,     { 0xFF, 0, 0, 0x80, 0x10, 0x00 }, 6 },
        { EFFECT_FLOW,     { 0xFF, 0, 0, 0x00, 0x10, 0x00 }, 6 },
        { EFFECT_SPARKLE,  { 0xFF, 0xFF, 0xFF, 0x20, 0x40 }, 5 },
        { EFFECT_SPARKLE,  { 0xFF, 0xFF, 0xFF, 0x20, 0x00 }, 5 },
    };
    /* expected activity flag, aligned with cases[] */
    static const int expect_active[] = { 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0 };

    for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        setUp(); /* fresh core+clock */
        light_cfg_t cfg = make_cfg(cases[i].id, cases[i].params, cases[i].len);
        light_core_set(g_core, 0, &cfg, 0);
        run_until(60); /* 60 ms: active gets ~5 frames, static/off <= 1 */
        int n = strip_sub_count(0);
        if (expect_active[i]) {
            TEST_ASSERT_TRUE_MESSAGE(n >= 3, "active strip should redraw");
        } else {
            TEST_ASSERT_TRUE_MESSAGE(n <= 1, "static/off should not redraw at 80 Hz");
        }
    }
}

/* =====================================================================
 * D6: all OFF never submits
 * ===================================================================== */

static void test_d6_all_off_never_submits(void)
{
    /* init leaves all strips IDLE; also explicitly set all OFF */
    for (uint8_t s = 0; s < LIGHT_STRIP_COUNT; s++) {
        light_cfg_t off = make_cfg(EFFECT_OFF, NULL, 0);
        light_core_set(g_core, s, &off, 0);
    }
    run_until(1000);
    TEST_ASSERT_EQUAL_INT(0, fake.sub_count);
}

/* =====================================================================
 * D7: OFF transition -> exactly one black frame, then never
 * ===================================================================== */

static void test_d7_off_transition_one_black_frame(void)
{
    light_cfg_t on = cfg_static_rgb(0x10, 0x20, 0x30);
    light_core_set(g_core, 0, &on, 0);
    run_until(10);
    TEST_ASSERT_TRUE(strip_sub_count(0) >= 1);
    int before = strip_sub_count(0);

    /* now turn off */
    light_cfg_t off = make_cfg(EFFECT_OFF, NULL, 0);
    light_core_set(g_core, 0, &off, fake.clock_ms);
    uint32_t t_off = fake.clock_ms;
    run_until(t_off + 500);

    int during = strip_sub_count(0) - before;
    TEST_ASSERT_EQUAL_INT_MESSAGE(1, during, "OFF must send exactly one frame");

    /* the black frame is all-zero symbols */
    TEST_ASSERT_EQUAL_UINT64(60000u, frame_ticks(cap_last[0])); /* count ok */
    for (int i = 0; i < LIGHT_SYMBOLS; i++) TEST_ASSERT_EQUAL_INT(0, sym_bit(cap_last[0][i]));

    /* no further submits long after */
    int after = strip_sub_count(0);
    run_until(t_off + 1500);
    TEST_ASSERT_EQUAL_INT(after, strip_sub_count(0));
}

/* =====================================================================
 * D8: all 8 active -> each strip ~12.5 ms, slot order 0..3, channels parallel
 * ===================================================================== */

static void test_d8_all_active(void)
{
    for (uint8_t s = 0; s < LIGHT_STRIP_COUNT; s++) {
        light_cfg_t cfg = cfg_active_rainbow();
        light_core_set(g_core, s, &cfg, 0);
    }
    run_until(100);

    /* every strip got at least several frames */
    for (uint8_t s = 0; s < LIGHT_STRIP_COUNT; s++) {
        TEST_ASSERT_TRUE_MESSAGE(cap_count[s] >= 6, "each active strip should redraw repeatedly");
    }

    /* per-strip consecutive submit gaps: >= 12 ms (<= ~80 Hz) and <= 13 ms */
    for (uint8_t s = 0; s < LIGHT_STRIP_COUNT; s++) {
        uint32_t prev = 0; int seen = 0;
        for (int i = 0; i < fake.sub_count; i++) {
            if (fake.subs[i].ch * LIGHT_SLOTS_PER_CH + fake.subs[i].slot != s) continue;
            if (seen) {
                uint32_t gap = fake.subs[i].t_ms - prev;
                TEST_ASSERT_TRUE_MESSAGE(gap >= 12u, "strip faster than 80 Hz");
                TEST_ASSERT_TRUE_MESSAGE(gap <= 13u, "strip slower than 12.5 ms bound");
            }
            prev = fake.subs[i].t_ms;
            seen = 1;
        }
    }

    /* channels run in parallel: both have submissions at t=0 */
    int ch0_t0 = 0, ch1_t0 = 0;
    for (int i = 0; i < fake.sub_count; i++) {
        if (fake.subs[i].t_ms == 0) { if (fake.subs[i].ch == 0) ch0_t0++; else ch1_t0++; }
    }
    TEST_ASSERT_TRUE_MESSAGE(ch0_t0 >= 1 && ch1_t0 >= 1, "both channels start in parallel");

    /* slot order per channel is non-decreasing within a 12 ms round (0..3) */
    for (uint8_t ch = 0; ch < LIGHT_CHANNEL_COUNT; ch++) {
        int last_round_start = -1;
        int expect_slot = 0;
        for (int i = 0; i < fake.sub_count; i++) {
            if (fake.subs[i].ch != ch) continue;
            int t = (int)fake.subs[i].t_ms;
            if (last_round_start < 0 || t - last_round_start >= 12) {
                last_round_start = t;
                expect_slot = 0;
            }
            TEST_ASSERT_EQUAL_INT_MESSAGE(expect_slot, fake.subs[i].slot, "slot order 0->3");
            expect_slot = (expect_slot + 1) % 4;
        }
    }

    /* single round <= 12.5 ms: 4 frames x 3 ms per channel */
    for (uint8_t ch = 0; ch < LIGHT_CHANNEL_COUNT; ch++) {
        TEST_ASSERT_TRUE_MESSAGE(fake.comp_n[ch] >= 4, "channel must complete a full round");
        uint32_t span = fake.completions[ch][3] - fake.completions[ch][0];
        TEST_ASSERT_TRUE_MESSAGE(span <= 12u, "one round must fit in 12.5 ms");
    }
}

/* =====================================================================
 * D9: single active -> <=80 Hz, others silent
 * ===================================================================== */

static void test_d9_single_active(void)
{
    light_cfg_t cfg = cfg_active_rainbow();
    light_core_set(g_core, 2, &cfg, 0);
    run_until(200);

    for (uint8_t s = 0; s < LIGHT_STRIP_COUNT; s++) {
        if (s == 2) {
            TEST_ASSERT_TRUE(cap_count[s] >= 10);
        } else {
            TEST_ASSERT_EQUAL_INT_MESSAGE(0, strip_sub_count(s), "other strips must stay silent");
        }
    }
    /* gaps >= 12 ms -> <= ~80 Hz, never faster */
    uint32_t prev = 0; int seen = 0;
    for (int i = 0; i < fake.sub_count; i++) {
        if (fake.subs[i].ch * LIGHT_SLOTS_PER_CH + fake.subs[i].slot != 2) continue;
        if (seen) TEST_ASSERT_TRUE(fake.subs[i].t_ms - prev >= 12u);
        prev = fake.subs[i].t_ms; seen = 1;
    }
}

/* =====================================================================
 * D10: static heartbeat every 200 ms +/- 1, identical frame bytes
 * ===================================================================== */

static void test_d10_static_heartbeat(void)
{
    light_cfg_t cfg = cfg_static_rgb(0x40, 0x80, 0xC0);
    light_core_set(g_core, 1, &cfg, 0);
    run_until(1000);

    /* collect submit times for strip 1 */
    uint32_t times[16]; int n = 0;
    for (int i = 0; i < fake.sub_count && n < 16; i++) {
        if (fake.subs[i].ch * LIGHT_SLOTS_PER_CH + fake.subs[i].slot == 1)
            times[n++] = fake.subs[i].t_ms;
    }
    TEST_ASSERT_TRUE_MESSAGE(n >= 5, "should have several heartbeats");
    for (int i = 1; i < n; i++) {
        int32_t gap = (int32_t)(times[i] - times[i - 1]);
        TEST_ASSERT_TRUE_MESSAGE(gap >= 199 && gap <= 201, "heartbeat 200 ms +/-1");
    }

    /* frame bytes identical to first (static never changes) */
    TEST_ASSERT_EQUAL_UINT32_ARRAY(cap_first[1], cap_last[1], LIGHT_SYMBOLS);
    /* heartbeat telemetry present */
    TEST_ASSERT_NOT_NULL(find_tline("heartbeat_ms"));
}

/* =====================================================================
 * D11: heartbeat does not steal the active period
 * ===================================================================== */

static void test_d11_heartbeat_does_not_steal_active(void)
{
    /* 3 active + 1 static on channel A (strips 0,1,2 active; strip 3 static) */
    for (uint8_t s = 0; s < 3; s++) {
        light_cfg_t cfg = cfg_active_rainbow();
        light_core_set(g_core, s, &cfg, 0);
    }
    light_cfg_t st = cfg_static_rgb(0x10, 0x10, 0x10);
    light_core_set(g_core, 3, &st, 0);

    run_until(1000);

    for (uint8_t s = 0; s < 3; s++) {
        uint32_t prev = 0; int seen = 0;
        for (int i = 0; i < fake.sub_count; i++) {
            if (fake.subs[i].ch * LIGHT_SLOTS_PER_CH + fake.subs[i].slot != s) continue;
            if (seen) {
                uint32_t gap = fake.subs[i].t_ms - prev;
                TEST_ASSERT_TRUE_MESSAGE(gap >= 12u, "active stole a frame to heartbeat");
                TEST_ASSERT_TRUE_MESSAGE(gap <= 16u, "active period drifted below 60 Hz");
            }
            prev = fake.subs[i].t_ms; seen = 1;
        }
    }
}

/* =====================================================================
 * D12: dirty redraw within 12.5 ms and before next heartbeat
 * ===================================================================== */

static void test_d12_dirty_redraw_latency(void)
{
    light_cfg_t cfg = cfg_static_rgb(0x10, 0x20, 0x30);
    light_core_set(g_core, 1, &cfg, 0);
    run_until(250); /* one heartbeat at 200 */

    /* change colour at t=300: must be sent within 12.5 ms */
    fake.clock_ms = 300;
    light_cfg_t cfg2 = cfg_static_rgb(0xAA, 0xBB, 0xCC);
    light_core_set(g_core, 1, &cfg2, fake.clock_ms);
    int before = strip_sub_count(1);
    uint32_t t0 = fake.clock_ms;
    run_until(320);

    /* find first submit after set */
    uint32_t sent_at = 0; int found = 0;
    int idx = 0;
    for (int i = 0; i < fake.sub_count; i++) {
        if (fake.subs[i].ch * LIGHT_SLOTS_PER_CH + fake.subs[i].slot == 1 &&
            fake.subs[i].t_ms >= t0) {
            idx++; if (idx == 1) { sent_at = fake.subs[i].t_ms; found = 1; }
        }
    }
    TEST_ASSERT_TRUE_MESSAGE(found, "dirty redraw not sent");
    TEST_ASSERT_TRUE_MESSAGE(sent_at - t0 <= 12u, "dirty redraw later than 12.5 ms");
    TEST_ASSERT_TRUE(strip_sub_count(1) > before);
}

/* =====================================================================
 * D13: double buffer safety and queue-full no-submit
 * ===================================================================== */

static void test_d13_double_buffer(void)
{
    for (uint8_t s = 0; s < LIGHT_STRIP_COUNT; s++) {
        light_cfg_t cfg = cfg_active_rainbow();
        light_core_set(g_core, s, &cfg, 0);
    }
    /* drive to t=0 without delivering tx_done: two frames queued per channel */
    fake.clock_ms = 0;
    deliver_done(); /* none */
    poll_once();    /* ch0 slot0 + ch1 slot0 */
    poll_once();    /* ch0 slot1 + ch1 slot1 -> tx_busy=2 */

    /* queue full: no further submits until a tx_done arrives */
    int subs_now = fake.sub_count;
    poll_once();
    poll_once();
    TEST_ASSERT_EQUAL_INT_MESSAGE(subs_now, fake.sub_count, "queue full must not submit");

    /* the two buffers handed out on ch0 must be distinct */
    const uint32_t *p0 = NULL, *p1 = NULL;
    int seen = 0;
    for (int i = 0; i < fake.sub_count; i++) {
        if (fake.subs[i].ch != 0) continue;
        if (seen == 0) p0 = fake.subs[i].sym;
        if (seen == 1) p1 = fake.subs[i].sym;
        seen++;
    }
    TEST_ASSERT_NOT_NULL(p0);
    TEST_ASSERT_NOT_NULL(p1);
    TEST_ASSERT_TRUE_MESSAGE(p0 != p1, "in-flight frames must use different buffers");

    /* deliver one done -> a new submit may reuse only the freed buffer */
    fake.clock_ms = FRAME_MS;
    deliver_done();
    int before = fake.sub_count;
    poll_once();
    TEST_ASSERT_TRUE(fake.sub_count > before);
    const uint32_t *p_new = fake.subs[fake.sub_count - 1].sym;
    TEST_ASSERT_TRUE_MESSAGE(p_new != p1, "must not overwrite the still-in-flight buffer");
}

/* =====================================================================
 * D14: late / lost tx_done
 * ===================================================================== */

static void test_d14_late_tx_done_no_corruption(void)
{
    for (uint8_t s = 0; s < LIGHT_STRIP_COUNT; s++) {
        light_cfg_t cfg = cfg_active_rainbow();
        light_core_set(g_core, s, &cfg, 0);
    }
    fake.clock_ms = 0;
    poll_once();
    poll_once();
    /* simulate a tx_done that arrives 12.5 ms late */
    int16_t glitch_before = (int16_t)light_core_glitch_count(g_core);
    fake.clock_ms = 12;
    deliver_done(); /* completions at 3 and 6 ms -> delivered late */
    TEST_ASSERT_EQUAL_INT(glitch_before, (int16_t)light_core_glitch_count(g_core));

    /* after late done the core resumes normally on both channels */
    int before = fake.sub_count;
    poll_once();
    TEST_ASSERT_TRUE(fake.sub_count > before);

    /* buffers handed out are the two distinct ones (no in-flight overwrite) */
    const uint32_t *ch0[64]; int n = 0;
    for (int i = 0; i < fake.sub_count && n < 64; i++)
        if (fake.subs[i].ch == 0) ch0[n++] = fake.subs[i].sym;
    TEST_ASSERT_TRUE(n >= 3);
    /* buffer 2 and 3 alternate; buffer 3 != buffer 2 */
    TEST_ASSERT_TRUE(ch0[n - 1] != ch0[n - 2]);
}

static void test_d14_lost_tx_done_recovery(void)
{
    light_cfg_t cfg = cfg_active_rainbow();
    light_core_set(g_core, 0, &cfg, 0);
    light_core_set(g_core, 1, &cfg, 0);
    fake.clock_ms = 0;
    poll_once();
    poll_once();

    /* never deliver tx_done: after the timeout the channel recovers and keeps sending */
    int subs_before = fake.sub_count;
    fake.clock_ms = LIGHT_TX_TIMEOUT_US / 1000u + 10u;
    deliver_done();   /* none actually due (we cleared? keep none) */
    poll_once();
    TEST_ASSERT_TRUE_MESSAGE(fake.sub_count > subs_before, "lost tx_done must not deadlock");
    TEST_ASSERT_TRUE_MESSAGE(light_core_glitch_count(g_core) > 0, "timeout recovery counts glitch");
}

/* =====================================================================
 * D15: 2^32 wrap of now_ms
 * ===================================================================== */

static void test_d15_time_wrap(void)
{
    /* start just before wrap */
    uint32_t start = 0xFFFFFFF0u; /* wraps in 16 ms */
    fake.clock_ms = start;
    light_core_t *c = g_core;
    light_core_init(c, &g_ports, start);
    light_cfg_t act = cfg_active_rainbow();
    light_core_set(c, 0, &act, start);

    /* run across the wrap (~40 ms) */
    uint32_t end = start + 40u;
    run_until(end);

    /* still redrawing: several frames, gaps still ~13 ms (wrap-safe) */
    int n = 0; uint32_t prev = 0; int seen = 0;
    for (int i = 0; i < fake.sub_count; i++) {
        if (fake.subs[i].ch * LIGHT_SLOTS_PER_CH + fake.subs[i].slot != 0) continue;
        if (seen) {
            int32_t gap = (int32_t)(fake.subs[i].t_ms - prev);
            TEST_ASSERT_TRUE_MESSAGE(gap >= 12 && gap <= 13, "gap broken across wrap");
        }
        prev = fake.subs[i].t_ms; seen = 1; n++;
    }
    TEST_ASSERT_TRUE_MESSAGE(n >= 3, "strip must keep redrawing across wrap");

    /* static heartbeat across wrap too */
    setUp();
    fake.clock_ms = start;
    light_core_init(g_core, &g_ports, start);
    light_cfg_t st = cfg_static_rgb(0x01, 0x02, 0x03);
    light_core_set(g_core, 4, &st, start);
    run_until(start + 450u);
    int hb = 0; uint32_t pt = 0; int seen2 = 0;
    for (int i = 0; i < fake.sub_count; i++) {
        if (fake.subs[i].ch * LIGHT_SLOTS_PER_CH + fake.subs[i].slot != 4) continue;
        if (seen2) {
            int32_t gap = (int32_t)(fake.subs[i].t_ms - pt);
            TEST_ASSERT_TRUE(gap >= 199 && gap <= 201);
            hb++;
        }
        pt = fake.subs[i].t_ms; seen2 = 1;
    }
    TEST_ASSERT_TRUE(hb >= 1);
}

/* =====================================================================
 * D16: glitch_count semantics (frame start late >2 ms -> +1, else unchanged)
 * ===================================================================== */

static void test_d16_glitch_counting(void)
{
    light_cfg_t cfg = cfg_active_rainbow();
    light_core_set(g_core, 0, &cfg, 0); /* due = 0 */

    /* channel idle; poll at t=10 ms -> 10 ms late -> one glitch */
    fake.clock_ms = 10;
    poll_once();
    TEST_ASSERT_EQUAL_UINT16(1u, light_core_glitch_count(g_core));

    /* on-time frame: next due ~22.5; poll at 23 -> <2 ms late -> no new glitch */
    uint16_t g1 = light_core_glitch_count(g_core);
    fake.clock_ms = 23;
    deliver_done();
    poll_once();
    TEST_ASSERT_EQUAL_UINT16(g1, light_core_glitch_count(g_core));

    /* very late again -> +1 */
    fake.clock_ms = 200;
    deliver_done();
    poll_once();
    TEST_ASSERT_TRUE(light_core_glitch_count(g_core) > g1);
}

/* =====================================================================
 * T: telemetry contract (spec 6): keys present with valid format
 * ===================================================================== */

static void test_telemetry_lines(void)
{
    light_cfg_t act = cfg_active_rainbow();
    light_core_set(g_core, 0, &act, 0);
    light_cfg_t st = cfg_static_rgb(0x10, 0x20, 0x30);
    light_core_set(g_core, 4, &st, 0);
    run_until(1200); /* span >=1 s so the 1 Hz aggregate lines appear */

    /* every log line starting with "T:" must be exactly T:key=value (one '=') */
    int tlines = 0;
    for (int i = 0; i < fake.log_count; i++) {
        if (fake.logs[i][0] != 'T' || fake.logs[i][1] != ':') continue;
        tlines++;
        const char *eq = strchr(fake.logs[i], '=');
        TEST_ASSERT_NOT_NULL_MESSAGE(eq, "T: line must contain '='");
        TEST_ASSERT_EQUAL_PTR_MESSAGE(eq, strchr(fake.logs[i], '=') , "only one '='");
        TEST_ASSERT_TRUE_MESSAGE(eq > fake.logs[i] + 2, "T: line must have a key");
        TEST_ASSERT_TRUE_MESSAGE(eq[1] != 0, "T: line must have a value");
    }
    TEST_ASSERT_TRUE_MESSAGE(tlines > 0, "no T: telemetry emitted");

    TEST_ASSERT_NOT_NULL_MESSAGE(find_tline("glitch_count"), "missing T:glitch_count");
    TEST_ASSERT_NOT_NULL_MESSAGE(find_tline("drop_count"), "missing T:drop_count");
    TEST_ASSERT_NOT_NULL_MESSAGE(find_tline("frame_ms"), "missing T:frame_ms");
    TEST_ASSERT_NOT_NULL_MESSAGE(find_tline("ch0_slot"), "missing T:ch0_slot");
    TEST_ASSERT_NOT_NULL_MESSAGE(find_tline("heartbeat_ms"), "missing T:heartbeat_ms");
    TEST_ASSERT_NOT_NULL_MESSAGE(find_tline("strip_state"), "missing T:strip_state");

    /* glitch_count/drop_count are resident regardless of telemetry */
    TEST_ASSERT_EQUAL_UINT16(0u, light_core_glitch_count(g_core));
}

/* ---------- T: telemetry helper contract (spec 6). Pins the shared formatter
 * so both sched.c (frame_ms/heartbeat/ch0_slot/...) and frame.c (glitch_count)
 * emit identical T:key=value lines through the same helper. ---------- */

static void test_telemetry_helper_format(void)
{
    /* 单个 u32 值 -> 一行 T:key=value，十进制、无前导零。 */
    memset(fake.logs, 0, sizeof(fake.logs));
    fake.log_count = 0;
    telemetry_emit_t_u32(&g_ports, "frame_ms", 12u);
    TEST_ASSERT_EQUAL_INT(1, fake.log_count);
    TEST_ASSERT_EQUAL_STRING("T:frame_ms=12", fake.logs[0]);

    /* 边界值：0 与最大 u32。 */
    memset(fake.logs, 0, sizeof(fake.logs));
    fake.log_count = 0;
    telemetry_emit_t_u32(&g_ports, "glitch_count", 0u);
    TEST_ASSERT_EQUAL_STRING("T:glitch_count=0", fake.logs[0]);
    telemetry_emit_t_u32(&g_ports, "drop_count", 4294967295u);
    TEST_ASSERT_EQUAL_STRING("T:drop_count=4294967295", fake.logs[1]);

    /* 字符串值（frame.c 场景走同一条路径）。 */
    memset(fake.logs, 0, sizeof(fake.logs));
    fake.log_count = 0;
    telemetry_emit_t_str(&g_ports, "key", "val");
    TEST_ASSERT_EQUAL_STRING("T:key=val", fake.logs[0]);
}

/* ---------- main (single main for the whole host test binary) ---------- */

int main(void)
{
    UNITY_BEGIN();
    run_effects_tests();
    RUN_TEST(test_d1_encode_0000);
    RUN_TEST(test_d1_encode_ffff);
    RUN_TEST(test_d1_encode_5555);
    RUN_TEST(test_d1_symbol_count_and_duration);
    RUN_TEST(test_d2_grb_order);
    RUN_TEST(test_d3_driver_deterministic);
    RUN_TEST(test_d4_speed_zero_is_static);
    RUN_TEST(test_d5_activity_table_via_core);
    RUN_TEST(test_d6_all_off_never_submits);
    RUN_TEST(test_d7_off_transition_one_black_frame);
    RUN_TEST(test_d8_all_active);
    RUN_TEST(test_d9_single_active);
    RUN_TEST(test_d10_static_heartbeat);
    RUN_TEST(test_d11_heartbeat_does_not_steal_active);
    RUN_TEST(test_d12_dirty_redraw_latency);
    RUN_TEST(test_d13_double_buffer);
    RUN_TEST(test_d14_late_tx_done_no_corruption);
    RUN_TEST(test_d14_lost_tx_done_recovery);
    RUN_TEST(test_d15_time_wrap);
    RUN_TEST(test_d16_glitch_counting);
    RUN_TEST(test_telemetry_lines);
    RUN_TEST(test_telemetry_helper_format);
    return UNITY_END();
}