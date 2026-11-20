// Telemetry T: line helper (firmware/driver, pure C99). See docs/spec/driver.md §6.
//
// Shared by sched.c (frame_ms / heartbeat_ms / ch0_slot / strip_state / ...) and
// frame.c (glitch_count) so every T:key=value line is formatted by the same code --
// integer->decimal conversion + "T:key=value" construction + ports->log.
//
// Pure C99: no stdio / no float / no malloc.

#ifndef LIGHT_TELEMETRY_H
#define LIGHT_TELEMETRY_H

#include "light_core.h"

/* Emit one `T:key=value` line for a uint32 value (decimal, no leading zeros).
 * key must be NUL-terminated; the value is formatted internally. */
void telemetry_emit_t_u32(const light_ports_t *ports, const char *key, uint32_t v);

/* Emit one `T:key=value` line for a pre-formatted NUL-terminated string value. */
void telemetry_emit_t_str(const light_ports_t *ports, const char *key, const char *val);

#endif /* LIGHT_TELEMETRY_H */