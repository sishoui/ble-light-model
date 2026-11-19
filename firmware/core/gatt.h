#ifndef BLE_LIGHT_GATT_H
#define BLE_LIGHT_GATT_H

#include <stddef.h>
#include <stdint.h>

#include "ble_proto.h"
#include "effect_engine.h"
#include "scene.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * BLE 控制面（GATT）核心：命令分发 + STATUS/HELLO/ACK/NAK 组帧（纯 C99，
 * host 单测，无任何 NimBLE 调用）。
 *
 * 职责：
 * - 输入：ble_proto_feed 解出的已校验帧（type/payload/strip_mask）+ 时钟
 *   （now_ms 注入）+ 共享状态视图（effect_ctx + brightness）。
 * - 输出：动作结构（dispatch_action_t）—— ports 层按动作更新 led 共享
 *   状态、回 ACK/NAK、触发 STATUS、排 NVS 保存。本层不做任何 I/O。
 *
 * 满功率门禁（#4 第 4 节）：受限态（unlock==0）下 SET_BRIGHTNESS > 50%
 * （>127/255）或 SET_POWER_LIMIT > 15000mA -> NAK 0x06；UNLOCK_FULL_POWER=1
 * 解锁（允许 100%/30000mA，不持久化）；=0 立即夹回 50%/15000。
 * SET_POWER_LIMIT 上限 30000（HELLO 声明值），超限 NAK 0x05。
 *
 * 校验顺序（与 #4 一致）：CRC/版本/type/灯效/长度在 ble_proto feed 层已
 * 拦（NAK 0x01/0x08/0x02/0x03/0x04）；本层补语义校验（NAK 0x05/0x06）。
 */

/* 受限阈值：亮度 >50%（>127/255）与限流 >15000mA 需先解锁。 */
#define GATT_BRIGHTNESS_LIMIT (255u / 2u) /* 127：> 此值受限 */
#define GATT_POWER_LIMIT_MA 15000u
/* 解锁后上限（HELLO 声明 max_current_ma）。 */
#define GATT_POWER_LIMIT_MAX_MA 30000u
/* 启动默认限流（受限态；与 led_task 默认 brightness=128 配套）。 */
#define GATT_DEFAULT_POWER_LIMIT_MA GATT_POWER_LIMIT_MA

/* 周期 STATUS 间隔（#4 第 4 节：每 2s 或状态变化时）。 */
#define GATT_STATUS_PERIOD_MS 2000u

/*
 * STATUS payload 24 字节（#4 第 4 节，小端）：
 *   uptime_s(4), temp_c(1, int8), current_ma_est(2), thermal_status(1),
 *   glitch_count(2), drop_count(2), brightness(1), power_limit_ma(2),
 *   strip_fault(1), active_effect[8]
 */
#define GATT_STATUS_PAYLOAD_LEN 24u

/* thermal_status 取值。 */
#define GATT_THERMAL_NORMAL 0u
#define GATT_THERMAL_WARNING 1u
#define GATT_THERMAL_SHUTDOWN 2u

/* caps 位（#4 第 2 节）：bit0 满功率解锁、bit1 场景持久化、bit2 bitmap 有效。 */
#define GATT_CAP_FULL_POWER 0x01u
#define GATT_CAP_SCENE_SAVE 0x02u
#define GATT_CAP_EFFECT_BITMAP 0x04u

/* 分派动作类型（dispatch 的输出）。 */
typedef enum {
    GATT_ACT_NONE = 0,     /* 无响应（flag 未置 ACK 且无需 STATUS） */
    GATT_ACT_ACK,          /* 回 ACK（回显被确认帧 seq） */
    GATT_ACT_NAK,          /* 回 NAK（seq + 错误码） */
    GATT_ACT_STATUS,       /* 触发一次 STATUS（GET_STATUS 或状态变化） */
    GATT_ACT_APPLY_EFFECT, /* 更新共享状态：effect_apply（成功后 ACK） */
    GATT_ACT_SET_BRIGHTNESS, /* 更新共享状态：brightness（成功后 ACK） */
    GATT_ACT_SET_POWER_LIMIT, /* 更新共享状态：power_limit_ma（成功后 ACK） */
    GATT_ACT_SET_UNLOCK,   /* 更新解锁态（成功后 ACK；=0 夹回受限） */
} gatt_action_type_t;

typedef struct {
    gatt_action_type_t type;
    uint16_t seq;          /* 被响应 / 触发帧的序号 */
    uint8_t error;         /* type==GATT_ACT_NAK 时有意义（NAK 错误码） */
    /* SET_EFFECT（GATT_ACT_APPLY_EFFECT）：effect_id 在 payload[0]。 */
    uint8_t strip_mask;
    uint8_t payload_len;
    uint8_t payload[BLE_PROTO_MAX_PAYLOAD];
} gatt_action_t;

/*
 * 分发层状态（ports 持有；零初始化即可，内部用 scene 默认值初始化受限态）。
 * unlock 不持久化：重启后 ports 调用 gatt_dispatch_init 重置为受限。
 */
typedef struct {
    uint8_t unlocked;         /* 0=受限（50%/15000），1=解锁 */
    uint16_t power_limit_ma;  /* 全局限流（受限时夹在 15000） */
} gatt_dispatch_t;

/* 状态复位：受限态 + 默认限流 15000（启动/重启调用）。 */
void gatt_dispatch_init(gatt_dispatch_t *d);

/*
 * 分发一条已校验帧（输入帧必须已通过 ble_proto_feed 的 CRC/版本/type/
 * 灯效/长度校验）。effects/brightness 为共享状态当前视图（输入输出：
 * 本函数就地修改通过 action 描述的新状态，不直接改 effects —— 由 ports
 * 执行动作）。
 *
 * out_actions 容量 cap，返回写入的动作数（<=cap；正常一条帧最多 1 个动作）。
 * gatt_action_wants_ack(f) 决定 SET_* 动作成功后是否回 ACK（flags bit0，
 * 协议第 1 节"接收端忽略未知位"同口径 —— bit0 置位才 ACK）。
 */
size_t gatt_dispatch(const gatt_dispatch_t *d, const ble_proto_frame_t *f,
                     gatt_action_t *out_actions, size_t cap);

/* HELLO payload 组帧（23 字节，#4 第 2 节布局）。 */
void gatt_build_hello(uint8_t out[/* 23 */], uint8_t caps,
                      uint8_t strip_count, uint8_t leds_per_strip);

/* 某灯带当前 effect_id（active_effect[i]，EFFECT_ID_NONE 表示未设置）。 */
uint8_t gatt_active_effect(const effect_ctx_t *effects, uint8_t strip);

/*
 * STATUS payload 组帧（24 字节，#4 第 4 节布局）。任何入参 0 语义都合法
 * （全灭时 brightness 仍可非 0），无失败路径。
 */
void gatt_build_status(uint8_t out[GATT_STATUS_PAYLOAD_LEN],
                       uint32_t uptime_s, int8_t temp_c,
                       uint16_t current_ma_est,
                       uint8_t thermal_status,
                       uint16_t glitch_count, uint16_t drop_count,
                       uint8_t brightness, uint16_t power_limit_ma,
                       uint8_t strip_fault,
                       const effect_ctx_t *effects);

/* 是否要回 ACK：flags bit0（协议第 1 节）。 */
uint8_t gatt_action_wants_ack(const ble_proto_frame_t *f);

/*
 * 重启 / 受限恢复夹取（#4 §4：重启后先限 50% / 15000mA，解锁态不持久化）：
 * 亮度夹到 <= GATT_BRIGHTNESS_LIMIT（127），限流夹到 <= GATT_POWER_LIMIT_MA
 * （15000）。in/out 指针，就地修改；core 纯函数（host 可测），ports 的
 * nvs_store 恢复路径直接调用。
 */
void gatt_clamp_restricted(uint8_t *brightness, uint16_t *power_limit_ma);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_GATT_H */