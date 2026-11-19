/*
 * 协议 v1 帧编解码实现。行为与 miniprogram/logic/codec.ts 逐字节一致，
 * 由 tests/protocol/vectors.json golden 向量在三侧（JS / C / Python）锁定。
 *
 * feed 规则（与 codec.ts 文件头注释同源）：
 * - 非帧垃圾、孤立 0xAA 静默丢弃；半帧后遇到新的 AA 55 magic 丢弃半帧。
 * - CRC 错但帧内出现 AA 55 视为错位垃圾，静默重同步；否则 NAK 0x01。
 * - 语义校验顺序：CRC -> 版本 0x08 -> type 0x02 -> SET_EFFECT 灯效 0x03 -> 长度 0x04。
 * - SET_EFFECT payload = effect_id(1) + 效果参数；param_len >= 1+期望效果参数长度
 *   接受、多余忽略；更短 NAK 0x04。
 * - seq 错不是协议错误：帧照常解出、本层不产生 ACK；匹配 / 超时重传由上层负责。
 */

#include "ble_proto.h"

#include <string.h>

#include "crc16.h"

static size_t find_magic(const uint8_t *buf, size_t from, size_t until)
{
    size_t j;

    for (j = from; j + 1 < until; j++) {
        if (buf[j] == 0xAAu && buf[j + 1] == 0x55u) {
            return j;
        }
    }
    return (size_t)-1;
}

size_t ble_proto_encode(const ble_proto_frame_t *frame, uint8_t *out, size_t out_cap)
{
    size_t plen = frame->payload_len;
    size_t total = BLE_PROTO_HEADER_SIZE + plen + 2;
    uint16_t crc;

    if (total > out_cap) {
        return 0;
    }
    out[0] = 0xAAu;
    out[1] = 0x55u;
    out[2] = frame->version;
    out[3] = (uint8_t)(frame->seq & 0xFFu);
    out[4] = (uint8_t)((frame->seq >> 8) & 0xFFu);
    out[5] = frame->type;
    out[6] = frame->flags;
    out[7] = frame->strip_mask;
    out[8] = plen;
    if (plen > 0) {
        memcpy(out + BLE_PROTO_HEADER_SIZE, frame->payload, plen);
    }

    crc = crc16_ccitt_false(out + 2, plen + 7u);
    out[BLE_PROTO_HEADER_SIZE + plen] = (uint8_t)(crc & 0xFFu);
    out[BLE_PROTO_HEADER_SIZE + plen + 1] = (uint8_t)((crc >> 8) & 0xFFu);
    return total;
}

/* 追加数据到 ctx 并处理完整帧；返回本次解出的帧数。 */
static size_t process(ble_proto_feed_t *ctx,
                      ble_proto_frame_t *frames, size_t frames_cap,
                      ble_proto_error_t *errors, size_t errors_cap,
                      size_t *errors_out)
{
    size_t i = 0;
    size_t nf = 0;
    size_t ne = 0;

    while (i < ctx->len) {
        uint8_t version;
        uint16_t seq;
        uint8_t type;
        uint8_t flags;
        uint8_t strip_mask;
        uint8_t plen;
        size_t frame_size;
        uint16_t crc_calc;
        uint16_t crc_recv;
        size_t j;

        if (ctx->buf[i] != 0xAAu) {
            i++;
            continue;
        }
        if (i + 1 >= ctx->len) {
            break; /* 末尾半个 magic，留作 remainder */
        }
        if (ctx->buf[i + 1] != 0x55u) {
            i++; /* 孤立 0xAA，垃圾 */
            continue;
        }

        /* 候选帧头不完整：后面若还有新 magic，丢弃半帧从新 magic 重来。 */
        if (i + BLE_PROTO_HEADER_SIZE > ctx->len) {
            j = find_magic(ctx->buf, i + 1, ctx->len);
            if (j != (size_t)-1) {
                i = j;
                continue;
            }
            break;
        }

        version = ctx->buf[i + 2];
        seq = (uint16_t)((uint16_t)ctx->buf[i + 3] | ((uint16_t)ctx->buf[i + 4] << 8));
        type = ctx->buf[i + 5];
        flags = ctx->buf[i + 6];
        strip_mask = ctx->buf[i + 7];
        plen = ctx->buf[i + 8];
        frame_size = BLE_PROTO_HEADER_SIZE + plen + 2;

        /* 整帧不完整：同样先找新 magic 重同步，否则留作 remainder 等后续字节。 */
        if (i + frame_size > ctx->len) {
            j = find_magic(ctx->buf, i + 1, ctx->len);
            if (j != (size_t)-1) {
                i = j;
                continue;
            }
            break;
        }

        crc_calc = crc16_ccitt_false(ctx->buf + i + 2, plen + 7u);
        crc_recv = (uint16_t)((uint16_t)ctx->buf[i + BLE_PROTO_HEADER_SIZE + plen] |
                              ((uint16_t)ctx->buf[i + BLE_PROTO_HEADER_SIZE + plen + 1] << 8));
        if (crc_calc != crc_recv) {
            /* 帧内出现新 magic 视为错位垃圾，静默重同步；否则是真正的 CRC 错。 */
            j = find_magic(ctx->buf, i + 1, i + frame_size);
            if (j != (size_t)-1) {
                i = j;
                continue;
            }
            if (ne < errors_cap) {
                errors[ne].code = BLE_PROTO_NAK_CRC;
                errors[ne].seq = seq;
                errors[ne].type = type;
                ne++;
            }
            i += frame_size;
            continue;
        }

        if (version != BLE_PROTO_VERSION) {
            if (ne < errors_cap) {
                errors[ne].code = BLE_PROTO_NAK_BAD_VERSION;
                errors[ne].seq = seq;
                errors[ne].type = type;
                ne++;
            }
            i += frame_size;
            continue;
        }
        if (type < BLE_PROTO_TYPE_HELLO || type > BLE_PROTO_TYPE_STATUS) {
            if (ne < errors_cap) {
                errors[ne].code = BLE_PROTO_NAK_UNKNOWN_TYPE;
                errors[ne].seq = seq;
                errors[ne].type = type;
                ne++;
            }
            i += frame_size;
            continue;
        }
        if (type == BLE_PROTO_TYPE_SET_EFFECT) {
            uint8_t effect_id;
            int expected;

            if (plen < 1) {
                if (ne < errors_cap) {
                    errors[ne].code = BLE_PROTO_NAK_LENGTH_MISMATCH;
                    errors[ne].seq = seq;
                    errors[ne].type = type;
                    ne++;
                }
                i += frame_size;
                continue;
            }
            effect_id = ctx->buf[i + BLE_PROTO_HEADER_SIZE];
            expected = ble_proto_effect_param_length(effect_id);
            if (expected < 0) {
                if (ne < errors_cap) {
                    errors[ne].code = BLE_PROTO_NAK_UNKNOWN_EFFECT;
                    errors[ne].seq = seq;
                    errors[ne].type = type;
                    ne++;
                }
                i += frame_size;
                continue;
            }
            /* 期望长度只数效果参数，payload 还要含 effect_id 字节。 */
            if (plen < (uint8_t)(1 + expected)) {
                if (ne < errors_cap) {
                    errors[ne].code = BLE_PROTO_NAK_LENGTH_MISMATCH;
                    errors[ne].seq = seq;
                    errors[ne].type = type;
                    ne++;
                }
                i += frame_size;
                continue;
            }
            /* plen > 1 + expected：接受，多余字节忽略。 */
        }

        if (nf < frames_cap) {
            ble_proto_frame_t *f = &frames[nf];
            f->version = version;
            f->seq = seq;
            f->type = type;
            f->flags = flags;
            f->strip_mask = strip_mask;
            f->payload_len = plen;
            if (plen > 0) {
                memcpy(f->payload, ctx->buf + i + BLE_PROTO_HEADER_SIZE, plen);
            }
            nf++;
        }
        i += frame_size;
    }

    if (i > 0) {
        memmove(ctx->buf, ctx->buf + i, ctx->len - i);
        ctx->len -= i;
    }
    *errors_out = ne;
    return nf;
}

size_t ble_proto_feed(ble_proto_feed_t *ctx, const uint8_t *data, size_t len,
                      ble_proto_frame_t *frames, size_t frames_cap,
                      ble_proto_error_t *errors, size_t errors_cap,
                      size_t *errors_written)
{
    size_t nf_total = 0;
    size_t ne_total = 0;
    size_t off = 0;

    while (off < len) {
        size_t space = sizeof(ctx->buf) - ctx->len;
        size_t chunk = len - off;
        size_t ne = 0;
        size_t nf;

        if (chunk > space) {
            chunk = space;
        }
        if (chunk > 0) {
            memcpy(ctx->buf + ctx->len, data + off, chunk);
            ctx->len += chunk;
            off += chunk;
        }
        nf = process(ctx,
                     frames + nf_total, frames_cap - nf_total,
                     errors + ne_total, errors_cap - ne_total,
                     &ne);
        nf_total += nf;
        ne_total += ne;
        /* 缓冲区被未完成数据占满且无法推进：丢弃剩余输入（cap 过小的误用）。 */
        if (off < len && space == 0u && chunk == 0u) {
            break;
        }
    }
    if (errors_written != NULL) {
        *errors_written = ne_total;
    }
    return nf_total;
}

void ble_proto_feed_reset(ble_proto_feed_t *ctx)
{
    ctx->len = 0;
}

int ble_proto_feed_should_reset(uint32_t last_ms, uint32_t now_ms)
{
    /* 无符号回绕安全：now - last 在 uint32 上回绕后仍正确表示时间差。 */
    return (int)((uint32_t)(now_ms - last_ms) >= BLE_PROTO_FEED_TIMEOUT_MS);
}

int ble_proto_effect_param_length(uint8_t effect_id)
{
    static const int8_t lengths[7] = {0, 3, 7, 10, 3, 7, 5};

    if (effect_id >= 7u) {
        return -1;
    }
    return (int)lengths[effect_id];
}