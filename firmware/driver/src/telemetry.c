// Telemetry T: line helper (firmware/driver, pure C99). See docs/spec/driver.md §6.
//
// Shared by sched.c (frame_ms / heartbeat_ms / ch0_slot / strip_state / ...) and
// frame.c (glitch_count) so every T:key=value line is formatted by the same code.
//
// Pure C99: no stdio / no float / no malloc. Integers are formatted here and passed
// to ports->log (spec 6.6). Under LIGHT_TELEMETRY these emit; otherwise they are
// no-ops with zero runtime cost (spec 6.4).

#include "telemetry.h"

#ifdef LIGHT_TELEMETRY

/* Format a uint32 as a decimal string into out (no leading zeros, "0" for zero).
 * out must hold at least 11 bytes (10 digits + NUL). */
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

static void emit_tline(const light_ports_t *ports, const char *key, const char *val)
{
    char line[48];
    size_t n = 0;
    line[n++] = 'T'; line[n++] = ':';
    while (*key) line[n++] = *key++;
    line[n++] = '=';
    while (*val) line[n++] = *val++;
    line[n] = 0;
    ports->log(LIGHT_LOG_INFO, line);
}

void telemetry_emit_t_u32(const light_ports_t *ports, const char *key, uint32_t v)
{
    char val[12];
    u32_to_dec(val, v);
    emit_tline(ports, key, val);
}

void telemetry_emit_t_str(const light_ports_t *ports, const char *key, const char *val)
{
    emit_tline(ports, key, val);
}

#else /* LIGHT_TELEMETRY */

/* Compiled-out: zero runtime cost in release builds (spec 6.4). */
void telemetry_emit_t_u32(const light_ports_t *ports, const char *key, uint32_t v)
{
    (void)ports; (void)key; (void)v;
}

void telemetry_emit_t_str(const light_ports_t *ports, const char *key, const char *val)
{
    (void)ports; (void)key; (void)val;
}

#endif /* LIGHT_TELEMETRY */