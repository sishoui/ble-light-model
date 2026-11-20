/*
 * C 端 golden 对拍 host driver（tests/protocol/run-c.mjs 调用）。
 *
 * 只做字节 I/O 与文本协议，不解析 JSON、不实现协议语义：
 * 协议语义全部在 firmware/proto/src/ble_proto.c。本文件允许使用 stdio/stdlib，
 * firmware/proto 本身仍是纯 C99（无 IDF / malloc / float / stdio）。
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ble_proto.h"

static int hex_val(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static size_t parse_hex(const char *s, uint8_t *out, size_t cap)
{
    size_t n = 0;
    if (s == NULL || strcmp(s, "-") == 0) return 0;
    while (s[0] != '\0' && s[1] != '\0') {
        int hi = hex_val(s[0]);
        int lo = hex_val(s[1]);
        if (hi < 0 || lo < 0 || n >= cap) return (size_t)-1;
        out[n++] = (uint8_t)((hi << 4) | lo);
        s += 2;
    }
    if (s[0] != '\0') return (size_t)-1;
    return n;
}

static void print_hex(const uint8_t *b, size_t n)
{
    size_t i;
    if (n == 0) {
        fputs("-", stdout);
        return;
    }
    for (i = 0; i < n; i++) printf("%02X", b[i]);
}

static void on_frame(void *ctx, const ble_proto_frame_t *f)
{
    (void)ctx;
    printf("FRAME %u %u %u %u %u %u ", (unsigned)f->ver, (unsigned)f->seq, (unsigned)f->type,
           (unsigned)f->flags, (unsigned)f->strip_mask, (unsigned)f->param_len);
    print_hex(f->payload, f->param_len);
    if (f->has_applied) {
        printf(" APPLIED %u ", (unsigned)f->applied_effect_id);
        print_hex(f->applied_params, f->applied_len);
    }
    fputc('\n', stdout);
}

static void on_nak(void *ctx, uint16_t seq, uint8_t error, const uint8_t *bytes, size_t len)
{
    (void)ctx;
    (void)seq;
    (void)error;
    fputs("NAK ", stdout);
    print_hex(bytes, len);
    fputc('\n', stdout);
}

static void on_ack(void *ctx, uint16_t seq, const uint8_t *bytes, size_t len)
{
    (void)ctx;
    printf("ACK %u ", (unsigned)seq);
    print_hex(bytes, len);
    fputc('\n', stdout);
}

static void on_status(void *ctx) { (void)ctx; fputs("STATUS\n", stdout); }
static void on_scene(void *ctx) { (void)ctx; fputs("SCENE\n", stdout); }
static void on_discard(void *ctx) { (void)ctx; fputs("DISCARD\n", stdout); }

static int cmd_encode(int argc, char **argv)
{
    ble_proto_cmd_t cmd;
    uint8_t payload[BLE_PROTO_MAX_PAYLOAD];
    uint8_t frame[BLE_PROTO_MAX_FRAME];
    size_t n;
    size_t len;
    if (argc != 7) {
        fprintf(stderr, "usage: encode <seq> <type> <flags> <strip_mask> <hex|->\n");
        return 2;
    }
    n = parse_hex(argv[6], payload, sizeof(payload));
    if (n == (size_t)-1) return 2;
    cmd.seq = (uint16_t)strtoul(argv[2], NULL, 0);
    cmd.type = (uint8_t)strtoul(argv[3], NULL, 0);
    cmd.flags = (uint8_t)strtoul(argv[4], NULL, 0);
    cmd.strip_mask = (uint8_t)strtoul(argv[5], NULL, 0);
    cmd.payload = payload;
    cmd.param_len = (uint8_t)n;
    len = ble_proto_encode(&cmd, frame, sizeof(frame));
    if (len == 0) return 2;
    print_hex(frame, len);
    fputc('\n', stdout);
    return 0;
}

static int cmd_feed(void)
{
    char line[4096];
    ble_proto_t proto;
    ble_proto_events_t ev;
    uint8_t chunk[1024];
    ev.ctx = NULL;
    ev.on_frame = on_frame;
    ev.on_nak = on_nak;
    ev.on_ack = on_ack;
    ev.on_status = on_status;
    ev.on_scene = on_scene;
    ev.on_discard = on_discard;
    ble_proto_init(&proto);

    while (fgets(line, sizeof(line), stdin) != NULL) {
        unsigned long now;
        char hexbuf[2048];
        size_t n;
        if (strncmp(line, "TICK", 4) == 0) {
            if (sscanf(line + 4, "%lu", &now) != 1) return 2;
            ble_proto_tick(&proto, (uint32_t)now, &ev);
            continue;
        }
        if (sscanf(line, "%lu %2047s", &now, hexbuf) != 2) continue;
        n = parse_hex(hexbuf, chunk, sizeof(chunk));
        if (n == (size_t)-1) return 2;
        ble_proto_feed(&proto, chunk, n, (uint32_t)now, &ev);
    }
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: ble_proto_host encode ... | feed\n");
        return 2;
    }
    if (strcmp(argv[1], "encode") == 0) return cmd_encode(argc, argv);
    if (strcmp(argv[1], "feed") == 0) return cmd_feed();
    fprintf(stderr, "unknown mode: %s\n", argv[1]);
    return 2;
}
