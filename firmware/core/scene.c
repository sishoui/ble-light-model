/*
 * 场景状态迁移 + NVS blob 序列化实现（纯 C99，host 单测）。
 *
 * blob 布局（#4 决议第 4 节，小端）：
 *   scene_version(1)=1 | length(2) | payload
 *   payload = 每路 [effect_id(1) param_len(1) params(param_len)] × 8
 *             + brightness(1) + power_limit_ma(2)
 * 长度字段覆盖 payload（不含 3 字节头），decode 用它判"长度与内容一致"。
 *
 * 失败语义：任何异常（len==0 / 版本不符 / length 与实际不符 / 越界）都
 * 返回 0，调用方把 out 置全灭态 —— "缺失/版本不支持/CRC 无效则全灭"（#4）。
 */

#include "scene.h"

#include <string.h>

/* CRC-16/CCITT-FALSE（proto/crc16 同源实现，core 不依赖 proto）。 */
static uint16_t scene_crc16(const uint8_t *data, size_t len)
{
    uint16_t crc = 0xFFFFu;
    size_t i;
    int bit;

    for (i = 0u; i < len; i++) {
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

void scene_init_state(scene_state_t *st)
{
    memset(st, 0, sizeof(*st));
    effect_init(&st->effects);
    st->brightness = SCENE_OFF_BRIGHTNESS;
    st->power_limit_ma = SCENE_OFF_POWER_LIMIT_MA;
}

void scene_capture(const effect_ctx_t *effects, uint8_t brightness,
                   uint16_t power_limit_ma, scene_state_t *out)
{
    out->effects = *effects;
    out->brightness = brightness;
    out->power_limit_ma = power_limit_ma;
}

size_t scene_encode(const scene_state_t *st, uint8_t *out, size_t out_cap)
{
    size_t off = 0u;
    uint16_t plen = 0u;
    uint16_t crc;
    uint8_t i;

    if (out_cap < SCENE_BLOB_OVERHEAD) {
        return 0u;
    }

    out[off++] = SCENE_VERSION;

    /* length 占位，写完 payload 回填。 */
    size_t len_off = off;
    off += 2u;

    for (i = 0u; i < EFFECT_STRIP_COUNT; i++) {
        const effect_strip_t *s = &st->effects.strips[i];

        out[off++] = s->effect_id;
        out[off++] = s->param_len;
        if (s->param_len > 0u) {
            memcpy(out + off, s->params, s->param_len);
            off += s->param_len;
        }
    }
    out[off++] = st->brightness;
    out[off++] = (uint8_t)(st->power_limit_ma & 0xFFu);
    out[off++] = (uint8_t)((st->power_limit_ma >> 8) & 0xFFu);

    plen = (uint16_t)(off - (len_off + 2u));
    out[len_off] = (uint8_t)(plen & 0xFFu);
    out[len_off + 1u] = (uint8_t)((plen >> 8) & 0xFFu);

    /* CRC 覆盖 version..payload 末尾（与协议帧同口径：头到数据）。 */
    crc = scene_crc16(out, off);
    if (off + 2u > out_cap) {
        return 0u;
    }
    out[off++] = (uint8_t)(crc & 0xFFu);
    out[off++] = (uint8_t)((crc >> 8) & 0xFFu);
    return off;
}

int scene_decode(const uint8_t *blob, size_t len, scene_state_t *out)
{
    uint16_t plen;
    uint16_t crc_calc;
    uint16_t crc_recv;
    size_t off = 3u; /* version(1) + length(2)：payload 从第 3 字节起 */
    uint8_t i;

    if (blob == NULL) {
        scene_init_state(out);
        return 0;
    }
    if (out == NULL) {
        return 0;
    }
    /* 失败路径统一置全灭：调用方不用先初始化。 */
    scene_init_state(out);

    if (len < SCENE_BLOB_OVERHEAD + 2u) {
        return 0;
    }
    if (blob[0] != SCENE_VERSION) {
        return 0;
    }
    plen = (uint16_t)((uint16_t)blob[1] | ((uint16_t)blob[2] << 8));
    if (plen != (uint16_t)(len - (SCENE_BLOB_OVERHEAD + 2u))) {
        return 0;
    }
    crc_calc = scene_crc16(blob, len - 2u);
    crc_recv = (uint16_t)((uint16_t)blob[len - 2u] |
                          ((uint16_t)blob[len - 1u] << 8));
    if (crc_calc != crc_recv) {
        return 0;
    }

    /* payload 上界：blob 中 payload 区 [3, 3+plen) = [3, len-2)。 */
    for (i = 0u; i < EFFECT_STRIP_COUNT; i++) {
        uint8_t plen_i;

        if (off + 2u > (size_t)plen + 3u) {
            return 0; /* 条目头越界 */
        }
        out->effects.strips[i].effect_id = blob[off + 0u];
        plen_i = blob[off + 1u];
        if (plen_i > SCENE_ENTRY_PARAM_CAP) {
            return 0; /* 参数长度越界：视作无效 blob，全灭 */
        }
        out->effects.strips[i].param_len = plen_i;
        if (plen_i > 0u) {
            if (off + 2u + plen_i > (size_t)plen + 3u) {
                return 0; /* 参数越界 */
            }
            memcpy(out->effects.strips[i].params, blob + off + 2u, plen_i);
        }
        off += 2u + plen_i;
    }

    if (off + 3u > (size_t)plen + 3u) {
        return 0; /* 亮度/限流越界 */
    }
    out->brightness = blob[off + 0u];
    out->power_limit_ma = (uint16_t)((uint16_t)blob[off + 1u] |
                                    ((uint16_t)blob[off + 2u] << 8));
    return 1;
}