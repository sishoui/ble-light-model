#ifndef BLE_LIGHT_SCENE_H
#define BLE_LIGHT_SCENE_H

#include <stddef.h>
#include <stdint.h>

#include "effect_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 场景状态迁移 + NVS blob 序列化/反序列化（纯 C99，host 单测，无动态内存）。
 *
 * 持久化口径（#4 决议第 4 节）：
 * - NVS blob `ble_light:scene`：scene_version(1) + length(2) + payload。
 * - payload：每路 effect_id + param_len + params（EFFECT_STRIP_COUNT 路）、
 *   全局 brightness(1)、power_limit_ma(2)，多字节小端。
 * - 启动加载：blob 缺失 / 版本不支持 / 长度不符 / CRC 无效 -> 全灭（全灭态
 *   = 全部灯带 OFF、brightness 128、power_limit 15000）。
 * - 满功率解锁不持久化：blob 不含 unlock 字段，重启回受限态（50%/15000）。
 *
 * 本层不做 NVS API（那是 ports 的事），只做 blob <-> 状态的纯函数转换。
 */

#define SCENE_VERSION 1u
#define SCENE_BLOB_OVERHEAD 3u /* version(1) + length(2) */
#define SCENE_ENTRY_PARAM_CAP 10u /* = EFFECT_MAX_PARAM_LEN（最长渐变参数） */

/* 受限默认（未解锁）：50% 亮度 / 15000mA。 */
#define SCENE_DEFAULT_BRIGHTNESS 128u
#define SCENE_DEFAULT_POWER_LIMIT_MA 15000u

/* 全灭 / 出厂态：全部灯带 OFF + 默认亮度 + 默认限流。 */
#define SCENE_OFF_BRIGHTNESS SCENE_DEFAULT_BRIGHTNESS
#define SCENE_OFF_POWER_LIMIT_MA SCENE_DEFAULT_POWER_LIMIT_MA

/* blob 最大长度：8 路 × (1+1+10) + 1 + 2 + 3 头 = 102。 */
#define SCENE_BLOB_MAX (SCENE_BLOB_OVERHEAD + \
                        (EFFECT_STRIP_COUNT * (2u + SCENE_ENTRY_PARAM_CAP)) + 3u)

/*
 * 场景状态 = LED 共享状态去掉动画锚点的可持久化子集。
 * 恢复时 start_ms 全部置 0（恢复后重新起相）。
 */
typedef struct {
    effect_ctx_t effects;       /* 每路灯效 + 参数（start_ms 不持久化） */
    uint8_t brightness;         /* 全局亮度 0–255 */
    uint16_t power_limit_ma;    /* 全局限流 */
} scene_state_t;

/* 状态复位为全灭 / 默认亮度 / 默认限流。 */
void scene_init_state(scene_state_t *st);

/*
 * 从 led 共享状态快照提取场景状态（start_ms 不进入序列化）。
 * 用于收到 ACK 后的去抖保存：ports 层 snapshot -> scene_capture -> 序列化。
 */
void scene_capture(const effect_ctx_t *effects, uint8_t brightness,
                   uint16_t power_limit_ma, scene_state_t *out);

/*
 * 序列化：state -> blob（scene_version(1)+length(2)+payload）。
 * 返回写入字节数；out_cap 不足返回 0。写入内容不含未初始化字节。
 */
size_t scene_encode(const scene_state_t *st, uint8_t *out, size_t out_cap);

/*
 * 反序列化：blob -> state。
 * 返回 1 成功；0 表示 blob 缺失（len==0 也算）/ 版本不支持 / length 字段与
 * 实际长度不符 / 长度越界 —— 语义均为全灭（#4：缺失/版本不支持/CRC 无效
 * 则全灭）。CRC 校验在 ports 层对整条 NVS 记录做（#4 blob 布局由 ports
 * 的 crc16 适配核过再进本函数），本函数负责版本与长度语义。
 * 失败时把 out 置全灭态（全 NONE + 默认亮度/限流）—— 调用方无需先
 * scene_init_state。
 */
int scene_decode(const uint8_t *blob, size_t len, scene_state_t *out);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_SCENE_H */