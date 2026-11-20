/*
 * BLE 协议 v1 平台无关 codec（protocol.md §12）。
 *
 * 纯 C99：无 Arduino / ESP-IDF、无 malloc、无 float、无 stdio。
 * 只负责帧字节、CRC-16/CCITT-FALSE、分片重组、seq、ACK/NAK 状态机。
 * 不认识具体灯效算法（effects.md）；仅按 protocol.md §6 做参数长度/合法性校验。
 *
 * 三端 golden：C / TS / Python 对 tests/protocol/vectors.json 逐字节一致（层 3）。
 */

#ifndef BLE_PROTO_H
#define BLE_PROTO_H

#include <stddef.h>
#include <stdint.h>

#define BLE_PROTO_VERSION 0x01
#define BLE_PROTO_MAGIC0 0xAA
#define BLE_PROTO_MAGIC1 0x55
#define BLE_PROTO_MAX_PAYLOAD 255
#define BLE_PROTO_MAX_FRAME 266 /* 2 magic + 9 header + 255 payload + 2 crc */
#define BLE_PROTO_HALF_FRAME_TIMEOUT_MS 200

/* 指令 type（protocol.md §4） */
#define BLE_PROTO_TYPE_HELLO 0x01
#define BLE_PROTO_TYPE_SET_EFFECT 0x02
#define BLE_PROTO_TYPE_GET_STATUS 0x06
#define BLE_PROTO_TYPE_ACK 0x07
#define BLE_PROTO_TYPE_NAK 0x08
#define BLE_PROTO_TYPE_STATUS 0x09
#define BLE_PROTO_TYPE_GET_SCENE 0x0A
#define BLE_PROTO_TYPE_SCENE 0x0B

/* NAK error（protocol.md §9） */
#define BLE_PROTO_NAK_CRC 0x01
#define BLE_PROTO_NAK_UNKNOWN_TYPE 0x02
#define BLE_PROTO_NAK_UNKNOWN_EFFECT 0x03
#define BLE_PROTO_NAK_LEN_MISMATCH 0x04
#define BLE_PROTO_NAK_BAD_PARAM 0x05
#define BLE_PROTO_NAK_BUSY 0x07
#define BLE_PROTO_NAK_BAD_VERSION 0x08

#define BLE_PROTO_FLAG_NEED_ACK 0x01

typedef struct {
    uint16_t seq;
    uint8_t type;
    uint8_t flags;
    uint8_t strip_mask;
    const uint8_t *payload;
    uint8_t param_len;
} ble_proto_cmd_t;

typedef struct {
    uint8_t ver;
    uint16_t seq;
    uint8_t type;
    uint8_t flags;
    uint8_t strip_mask;
    uint8_t param_len;
    uint8_t payload[BLE_PROTO_MAX_PAYLOAD];
    /* param_len 超过该灯效期望时，实际应应用的 effect_id + params（protocol.md §6） */
    uint8_t has_applied;
    uint8_t applied_effect_id;
    uint8_t applied_params[16];
    uint8_t applied_len;
} ble_proto_frame_t;

typedef struct {
    void *ctx;
    void (*on_frame)(void *ctx, const ble_proto_frame_t *frame);
    void (*on_nak)(void *ctx, uint16_t seq, uint8_t error, const uint8_t *bytes, size_t len);
    void (*on_ack)(void *ctx, uint16_t seq, const uint8_t *bytes, size_t len);
    void (*on_status)(void *ctx);
    void (*on_scene)(void *ctx);
    void (*on_discard)(void *ctx);
} ble_proto_events_t;

typedef struct {
    uint8_t buf[BLE_PROTO_MAX_FRAME];
    size_t len;
    uint32_t last_byte_ms;
    uint8_t has_last_byte_ms;
    uint8_t has_last_processed;
    uint8_t last_type;
    uint16_t last_seq;
} ble_proto_t;

/* CRC-16/CCITT-FALSE：poly 0x1021，init 0xFFFF，无反射，xorout 0。 */
uint16_t ble_proto_crc16(const uint8_t *data, size_t len);

/*
 * 组整帧（含 magic + crc）。成功返回帧长，失败返回 0。
 * 输出缓冲至少需要 9 + param_len + 2 字节。
 */
size_t ble_proto_encode(const ble_proto_cmd_t *cmd, uint8_t *out, size_t out_cap);

/* 初始化 / 断连重连时重置重组与 seq 状态。 */
void ble_proto_init(ble_proto_t *proto);

/*
 * 喂入一块收到的字节（BLE write 分片），按需回调 frame/nak/ack/status/scene。
 * now_ms 用于半帧超时时间基。
 */
void ble_proto_feed(ble_proto_t *proto, const uint8_t *data, size_t len, uint32_t now_ms,
                    const ble_proto_events_t *events);

/* 时间推进：半帧超时则静默丢弃并回调 discard（不发 NAK）。 */
void ble_proto_tick(ble_proto_t *proto, uint32_t now_ms, const ble_proto_events_t *events);

#endif /* BLE_PROTO_H */
