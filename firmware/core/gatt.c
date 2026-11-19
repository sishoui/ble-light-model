/*
 * BLE 控制面核心实现（纯 C99，host 单测，无 NimBLE 调用）。
 *
 * 分发约定（ports 粘合代码的执行顺序，见 gatt.h）：
 * - GATT_ACT_APPLY_EFFECT：ports 调 effect_apply(effects, mask, payload,
 *   len, now_ms)；返回 EFFECT_OK -> 回 ACK（回显 seq），并排 1s 去抖保存；
 *   返回错误码 -> 回 NAK（同错误码，effect_engine 结果码与 NAK 对齐）。
 * - GATT_ACT_SET_BRIGHTNESS / SET_POWER_LIMIT / SET_UNLOCK：ports 更新
 *   共享状态/内部状态，成功回 ACK 并排去抖保存；SET_UNLOCK=1 不排保存
 *   （解锁不持久化）；=0 时夹回默认值并排保存。
 * - NAK 由本层产出（门禁失败 / 参数非法），ports 直接发。
 * - GET_STATUS / SET_* 需要 ACK 时，flags bit0 决定回不回 ACK：协议第 2
 *   节"需要 ACK 的命令"是命令语义（SET_EFFECT 等必 ACK）；实现按 flags
 *   bit0：置位才 ACK（客户端可关 ACK 省空口带宽）。
 */

#include "gatt.h"

#include <string.h>

#include "ble_proto.h"

void gatt_dispatch_init(gatt_dispatch_t *d)
{
    d->unlocked = 0u;
    d->power_limit_ma = GATT_POWER_LIMIT_MA;
}

/* ---------- HELLO ---------- */

/*
 * HELLO payload（#4 第 2 节，23 字节）：
 *   protocol_ver(1)=1, fw_major(1), fw_minor(1), fw_patch(1),
 *   strip_count(1), leds_per_strip(1), max_current_ma(2),
 *   power_limit_ma(2), thermal_warning_c(1), thermal_shutdown_c(1),
 *   caps(1), effect_bitmap[16]
 * fw 版本 = 0.1.0（v1 阶段，无 OTA 版本协商）。
 */
void gatt_build_hello(uint8_t out[/* 23 */], uint8_t caps,
                      uint8_t strip_count, uint8_t leds_per_strip)
{
    memset(out, 0, 23);
    out[0] = BLE_PROTO_VERSION;
    out[1] = 0u;  /* fw_major */
    out[2] = 1u;  /* fw_minor */
    out[3] = 0u;  /* fw_patch */
    out[4] = strip_count;
    out[5] = leds_per_strip;
    out[6] = (uint8_t)(GATT_POWER_LIMIT_MAX_MA & 0xFFu);
    out[7] = (uint8_t)(GATT_POWER_LIMIT_MAX_MA >> 8);
    out[8] = (uint8_t)(GATT_POWER_LIMIT_MA & 0xFFu);
    out[9] = (uint8_t)(GATT_POWER_LIMIT_MA >> 8);
    out[10] = 70u; /* thermal_warning_c */
    out[11] = 85u; /* thermal_shutdown_c */
    out[12] = caps;
    /* effect_bitmap[16]：置位 effect_id 0..6（0x00–0x06，全部支持）。 */
    for (uint8_t i = 0u; i < EFFECT_ID_COUNT; i++) {
        out[13u + (i / 8u)] |= (uint8_t)(1u << (i % 8u));
    }
}

uint8_t gatt_active_effect(const effect_ctx_t *effects, uint8_t strip)
{
    return effect_active_id(effects, strip);
}

/* ---------- STATUS ---------- */

void gatt_build_status(uint8_t out[GATT_STATUS_PAYLOAD_LEN],
                       uint32_t uptime_s, int8_t temp_c,
                       uint16_t current_ma_est,
                       uint8_t thermal_status,
                       uint16_t glitch_count, uint16_t drop_count,
                       uint8_t brightness, uint16_t power_limit_ma,
                       uint8_t strip_fault,
                       const effect_ctx_t *effects)
{
    memset(out, 0, GATT_STATUS_PAYLOAD_LEN);
    out[0] = (uint8_t)(uptime_s & 0xFFu);
    out[1] = (uint8_t)((uptime_s >> 8) & 0xFFu);
    out[2] = (uint8_t)((uptime_s >> 16) & 0xFFu);
    out[3] = (uint8_t)((uptime_s >> 24) & 0xFFu);
    out[4] = (uint8_t)temp_c;
    out[5] = (uint8_t)(current_ma_est & 0xFFu);
    out[6] = (uint8_t)(current_ma_est >> 8);
    out[7] = thermal_status;
    out[8] = (uint8_t)(glitch_count & 0xFFu);
    out[9] = (uint8_t)(glitch_count >> 8);
    out[10] = (uint8_t)(drop_count & 0xFFu);
    out[11] = (uint8_t)(drop_count >> 8);
    out[12] = brightness;
    out[13] = (uint8_t)(power_limit_ma & 0xFFu);
    out[14] = (uint8_t)(power_limit_ma >> 8);
    out[15] = strip_fault;
    for (uint8_t i = 0u; i < 8u; i++) {
        out[16u + i] = gatt_active_effect(effects, i);
    }
}

/* ---------- 分发 ---------- */

/* 是否要回 ACK：flags bit0（协议第 1 节）。 */
static uint8_t want_ack(const ble_proto_frame_t *f)
{
    return (uint8_t)((f->flags & 0x01u) != 0u);
}

/* SET_* 动作成功后 ports 判断回不回 ACK（flags bit0）。 */
uint8_t gatt_action_wants_ack(const ble_proto_frame_t *f)
{
    return want_ack(f);
}

static void put_nak(gatt_action_t *a, uint16_t seq, uint8_t code)
{
    a->type = GATT_ACT_NAK;
    a->seq = seq;
    a->error = code;
}

size_t gatt_dispatch(const gatt_dispatch_t *d, const ble_proto_frame_t *f,
                     gatt_action_t *out_actions, size_t cap)
{
    gatt_action_t *a = &out_actions[0];

    if (cap == 0u) {
        return 0u;
    }
    a->type = GATT_ACT_NONE;
    a->seq = f->seq;
    a->error = 0u;

    switch (f->type) {
    case BLE_PROTO_TYPE_SET_EFFECT:
        a->type = GATT_ACT_APPLY_EFFECT;
        a->strip_mask = f->strip_mask;
        a->payload_len = f->payload_len;
        memcpy(a->payload, f->payload, f->payload_len);
        return 1u;

    case BLE_PROTO_TYPE_SET_BRIGHTNESS:
        if (f->payload_len < 1u) {
            put_nak(a, f->seq, BLE_PROTO_NAK_LENGTH_MISMATCH);
            return 1u;
        }
        if (f->strip_mask != 0xFFu) {
            put_nak(a, f->seq, BLE_PROTO_NAK_INVALID_PARAM);
            return 1u;
        }
        if (!d->unlocked && f->payload[0] > GATT_BRIGHTNESS_LIMIT) {
            put_nak(a, f->seq, BLE_PROTO_NAK_NOT_UNLOCKED);
            return 1u;
        }
        a->type = GATT_ACT_SET_BRIGHTNESS;
        a->payload_len = 1u;
        a->payload[0] = f->payload[0];
        return 1u;

    case BLE_PROTO_TYPE_SET_POWER_LIMIT: {
        uint16_t lim;

        if (f->payload_len < 2u) {
            put_nak(a, f->seq, BLE_PROTO_NAK_LENGTH_MISMATCH);
            return 1u;
        }
        lim = (uint16_t)((uint16_t)f->payload[0] |
                         ((uint16_t)f->payload[1] << 8));
        if (f->strip_mask != 0xFFu) {
            put_nak(a, f->seq, BLE_PROTO_NAK_INVALID_PARAM);
            return 1u;
        }
        if (lim > GATT_POWER_LIMIT_MAX_MA) {
            put_nak(a, f->seq, BLE_PROTO_NAK_INVALID_PARAM);
            return 1u;
        }
        if (!d->unlocked && lim > GATT_POWER_LIMIT_MA) {
            put_nak(a, f->seq, BLE_PROTO_NAK_NOT_UNLOCKED);
            return 1u;
        }
        a->type = GATT_ACT_SET_POWER_LIMIT;
        a->payload_len = 2u;
        a->payload[0] = f->payload[0];
        a->payload[1] = f->payload[1];
        return 1u;
    }

    case BLE_PROTO_TYPE_UNLOCK_FULL_POWER:
        if (f->payload_len < 1u || f->payload[0] > 1u ||
            f->strip_mask != 0xFFu) {
            put_nak(a, f->seq, BLE_PROTO_NAK_INVALID_PARAM);
            return 1u;
        }
        a->type = GATT_ACT_SET_UNLOCK;
        a->payload_len = 1u;
        a->payload[0] = f->payload[0];
        return 1u;

    case BLE_PROTO_TYPE_GET_STATUS:
        a->type = GATT_ACT_STATUS;
        a->seq = f->seq;
        return 1u;

    case BLE_PROTO_TYPE_HELLO:
    case BLE_PROTO_TYPE_ACK:
    case BLE_PROTO_TYPE_NAK:
    case BLE_PROTO_TYPE_STATUS:
        /* C3 -> 客户端方向，不是客户端命令：按未知 type 处理。 */
        put_nak(a, f->seq, BLE_PROTO_NAK_UNKNOWN_TYPE);
        return 1u;

    default:
        /* feed 已拦 type 越界；这里防御性兜底。 */
        put_nak(a, f->seq, BLE_PROTO_NAK_UNKNOWN_TYPE);
        return 1u;
    }
}