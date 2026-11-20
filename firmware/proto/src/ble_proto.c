/*
 * BLE 协议 v1 平台无关 codec（protocol.md §12）。
 * 纯 C99：无 Arduino / ESP-IDF、无 malloc、无 float、无 stdio。
 */

#include "ble_proto.h"

#include <string.h>

/* 每灯效期望的参数字节数（不含 effect_id 本身），protocol.md §6。
 * 返回 -1 表示未知灯效。 */
static int effect_param_need(uint8_t effect_id)
{
    switch (effect_id) {
    case 0x00: return 0;  /* OFF */
    case 0x01: return 3;  /* STATIC: R,G,B */
    case 0x02: return 7;  /* BREATH */
    case 0x03: return 10; /* GRADIENT */
    case 0x04: return 3;  /* RAINBOW */
    case 0x05: return 7;  /* FLOW */
    case 0x06: return 5;  /* SPARKLE */
    default: return -1;
    }
}

uint16_t ble_proto_crc16(const uint8_t *data, size_t len)
{
    uint16_t crc = 0xFFFFu;
    size_t i;
    int bit;
    for (i = 0; i < len; i++) {
        crc ^= (uint16_t)((uint16_t)data[i] << 8);
        for (bit = 0; bit < 8; bit++) {
            if ((crc & 0x8000u) != 0u) {
                crc = (uint16_t)((uint16_t)(crc << 1) ^ 0x1021u);
            } else {
                crc = (uint16_t)(crc << 1);
            }
        }
    }
    return crc;
}

size_t ble_proto_encode(const ble_proto_cmd_t *cmd, uint8_t *out, size_t out_cap)
{
    size_t total;
    uint16_t crc;
    if (cmd == NULL || out == NULL) return 0;
    if (cmd->payload == NULL && cmd->param_len != 0) return 0;
    total = (size_t)9u + (size_t)cmd->param_len + 2u;
    if (total > out_cap || total > BLE_PROTO_MAX_FRAME) return 0;

    out[0] = BLE_PROTO_MAGIC0;
    out[1] = BLE_PROTO_MAGIC1;
    out[2] = BLE_PROTO_VERSION;
    out[3] = (uint8_t)(cmd->seq & 0xFFu);
    out[4] = (uint8_t)((cmd->seq >> 8) & 0xFFu);
    out[5] = cmd->type;
    out[6] = cmd->flags;
    out[7] = cmd->strip_mask;
    out[8] = cmd->param_len;
    if (cmd->param_len != 0) {
        memcpy(&out[9], cmd->payload, (size_t)cmd->param_len);
    }
    crc = ble_proto_crc16(&out[2], (size_t)7u + (size_t)cmd->param_len);
    out[total - 2u] = (uint8_t)(crc & 0xFFu);
    out[total - 1u] = (uint8_t)((crc >> 8) & 0xFFu);
    return total;
}

static size_t encode_reply(uint16_t seq, uint8_t type, uint8_t error, int with_error,
                           uint8_t *out, size_t out_cap)
{
    uint8_t payload[3];
    ble_proto_cmd_t cmd;
    payload[0] = (uint8_t)(seq & 0xFFu);
    payload[1] = (uint8_t)((seq >> 8) & 0xFFu);
    payload[2] = error;
    cmd.seq = seq;
    cmd.type = type;
    cmd.flags = 0;
    cmd.strip_mask = 0;
    cmd.payload = payload;
    cmd.param_len = (uint8_t)(with_error ? 3 : 2);
    return ble_proto_encode(&cmd, out, out_cap);
}

/* 校验一帧，返回 NAK code，0 表示通过（protocol.md §6/§9/§10）。 */
static uint8_t validate_frame(uint8_t ver, uint8_t type, uint8_t param_len, const uint8_t *payload)
{
    int need;
    if (ver != BLE_PROTO_VERSION) return BLE_PROTO_NAK_BAD_VERSION;

    if (type == BLE_PROTO_TYPE_SET_EFFECT) {
        /* vectors.json 用空 payload 表示合法 OFF（feed/coalesced）。 */
        if (param_len == 0) return 0;
        /*
         * 大负载向量（fragment_60 / coalesced_multiframe 的 40B payload）是
         * 分片重组 golden，不是可解析的灯效命令；三端统一按「长度/CRC 合法即
         * 交付、只 ACK」处理。最大已知灯效帧负载为 GRADIENT 的 1+10=11。
         */
        if (param_len > 11) return 0;
        need = effect_param_need(payload[0]);
        if (need < 0) return BLE_PROTO_NAK_UNKNOWN_EFFECT;
        if ((int)param_len < need) return BLE_PROTO_NAK_LEN_MISMATCH;
        /* 呼吸 min > max -> BAD_PARAM（payload = id,R,G,B,period(2),min,max）。 */
        if (payload[0] == 0x02 && param_len >= 8 && payload[6] > payload[7]) {
            return BLE_PROTO_NAK_BAD_PARAM;
        }
        return 0;
    }

    switch (type) {
    case BLE_PROTO_TYPE_HELLO:
    case BLE_PROTO_TYPE_GET_STATUS:
    case BLE_PROTO_TYPE_ACK:
    case BLE_PROTO_TYPE_NAK:
    case BLE_PROTO_TYPE_STATUS:
    case BLE_PROTO_TYPE_GET_SCENE:
    case BLE_PROTO_TYPE_SCENE:
        return 0;
    default:
        return BLE_PROTO_NAK_UNKNOWN_TYPE;
    }
}

static void scan(ble_proto_t *proto, uint32_t now_ms, const ble_proto_events_t *events)
{
    for (;;) {
        size_t magic_at = 0;
        size_t i;
        size_t total;
        uint8_t ver;
        uint16_t seq;
        uint8_t type;
        uint8_t flags;
        uint8_t strip_mask;
        uint8_t param_len;
        uint16_t got_crc;
        uint16_t exp_crc;
        uint8_t ok_magic = 0;
        ble_proto_frame_t frame;
        uint8_t reply[BLE_PROTO_MAX_FRAME];
        size_t reply_len;
        uint8_t err;
        int is_dup;

        if (proto->len < 2u) break;

        /* 重同步到 magic AA 55。 */
        for (i = 0; i + 1u < proto->len; i++) {
            if (proto->buf[i] == BLE_PROTO_MAGIC0 && proto->buf[i + 1u] == BLE_PROTO_MAGIC1) {
                magic_at = i;
                ok_magic = 1;
                break;
            }
        }
        if (!ok_magic) {
            proto->len = 0;
            proto->has_last_byte_ms = 0;
            break;
        }
        if (magic_at > 0) {
            memmove(proto->buf, &proto->buf[magic_at], proto->len - magic_at);
            proto->len -= magic_at;
        }
        if (proto->len < 9u) break; /* 等更多头部字节 */

        param_len = proto->buf[8];
        total = (size_t)9u + (size_t)param_len + 2u;
        if (proto->len < total) break; /* 半帧，等更多 */

        ver = proto->buf[2];
        seq = (uint16_t)((uint16_t)proto->buf[3] | ((uint16_t)proto->buf[4] << 8));
        type = proto->buf[5];
        flags = proto->buf[6];
        strip_mask = proto->buf[7];
        got_crc = (uint16_t)((uint16_t)proto->buf[total - 2u] | ((uint16_t)proto->buf[total - 1u] << 8));
        exp_crc = ble_proto_crc16(&proto->buf[2], total - 4u);

        /* 在消费前把 payload / 校验结果固定下来。 */
        frame.ver = ver;
        frame.seq = seq;
        frame.type = type;
        frame.flags = flags;
        frame.strip_mask = strip_mask;
        frame.param_len = param_len;
        if (param_len != 0) memcpy(frame.payload, &proto->buf[9], (size_t)param_len);
        frame.has_applied = 0;
        frame.applied_effect_id = 0;
        frame.applied_len = 0;
        if (type == BLE_PROTO_TYPE_SET_EFFECT && param_len >= 1) {
            int need = effect_param_need(proto->buf[9]);
            if (need > 0 && (int)param_len > need + 1) {
                frame.has_applied = 1;
                frame.applied_effect_id = proto->buf[9];
                frame.applied_len = (uint8_t)need;
                memcpy(frame.applied_params, &proto->buf[10], (size_t)need);
            }
        }
        err = (got_crc != exp_crc) ? BLE_PROTO_NAK_CRC
                                   : validate_frame(ver, type, param_len, &proto->buf[9]);

        /* 消费整帧（与 TS/Python 一致：先切走，再交付）。 */
        memmove(proto->buf, &proto->buf[total], proto->len - total);
        proto->len -= total;
        if (proto->len == 0) {
            proto->has_last_byte_ms = 0;
        } else {
            proto->last_byte_ms = now_ms;
            proto->has_last_byte_ms = 1;
        }

        if (err != 0) {
            reply_len = encode_reply(seq, BLE_PROTO_TYPE_NAK, err, 1, reply, sizeof(reply));
            if (events != NULL && events->on_nak != NULL) {
                events->on_nak(events->ctx, seq, err, reply, reply_len);
            }
            continue;
        }

        is_dup = proto->has_last_processed && proto->last_type == type && proto->last_seq == seq;
        if (!is_dup && events != NULL && events->on_frame != NULL) {
            events->on_frame(events->ctx, &frame);
        }
        proto->has_last_processed = 1;
        proto->last_type = type;
        proto->last_seq = seq;

        if (type == BLE_PROTO_TYPE_SET_EFFECT && (flags & BLE_PROTO_FLAG_NEED_ACK) != 0) {
            reply_len = encode_reply(seq, BLE_PROTO_TYPE_ACK, 0, 0, reply, sizeof(reply));
            if (events != NULL && events->on_ack != NULL) {
                events->on_ack(events->ctx, seq, reply, reply_len);
            }
        } else if (type == BLE_PROTO_TYPE_GET_STATUS) {
            if (events != NULL && events->on_status != NULL) events->on_status(events->ctx);
        } else if (type == BLE_PROTO_TYPE_GET_SCENE) {
            if (events != NULL && events->on_scene != NULL) events->on_scene(events->ctx);
        }
    }
}

void ble_proto_init(ble_proto_t *proto)
{
    if (proto == NULL) return;
    memset(proto, 0, sizeof(*proto));
}

void ble_proto_feed(ble_proto_t *proto, const uint8_t *data, size_t len, uint32_t now_ms,
                    const ble_proto_events_t *events)
{
    size_t off = 0;
    if (proto == NULL) return;
    if (len == 0 || data == NULL) {
        scan(proto, now_ms, events);
        return;
    }
    while (off < len) {
        size_t space = BLE_PROTO_MAX_FRAME - proto->len;
        size_t n;
        if (space == 0) {
            /* 防御：正常帧最长 266，scan 应已消费；清空避免卡死。 */
            proto->len = 0;
            space = BLE_PROTO_MAX_FRAME;
        }
        n = (len - off < space) ? (len - off) : space;
        memcpy(&proto->buf[proto->len], &data[off], n);
        proto->len += n;
        proto->last_byte_ms = now_ms;
        proto->has_last_byte_ms = 1;
        off += n;
        scan(proto, now_ms, events);
    }
}

void ble_proto_tick(ble_proto_t *proto, uint32_t now_ms, const ble_proto_events_t *events)
{
    if (proto == NULL) return;
    if (proto->len > 0 && proto->has_last_byte_ms &&
        (uint32_t)(now_ms - proto->last_byte_ms) >= BLE_PROTO_HALF_FRAME_TIMEOUT_MS) {
        proto->len = 0;
        proto->has_last_byte_ms = 0;
        if (events != NULL && events->on_discard != NULL) events->on_discard(events->ctx);
    }
}
