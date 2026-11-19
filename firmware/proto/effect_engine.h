#ifndef BLE_LIGHT_EFFECT_ENGINE_H
#define BLE_LIGHT_EFFECT_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#include "ble_proto.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * C3 灯效引擎（纯 C99，不依赖 Arduino / IDF，不用动态内存）。
 *
 * 职责边界：本层只懂灯效语义（参数布局、动画、像素输出），不认识 BLE 帧
 * （编解码在 proto/，#10）。长度校验复用 ble_proto_effect_param_length，
 * 全仓只有一份灯效长度表。
 *
 * 确定性：动画类灯效不读时钟，全部由调用方注入 now_ms；相同输入 + 相同
 * now_ms 序列产生相同输出，host 单测（pio test -e native）可直接断言中间帧。
 *
 * 坐标与输出：帧缓冲是逻辑 RGB（r,g,b 顺序，与 WS2812 的 GRB 转换在
 * 亮度/驱动层，#13/#14）。渐变/彩虹的 hue→RGB 色轮（饱和=满、value=满）与
 * FastLED CHSV 同款，是逐通道断言的独立事实源。
 *
 * 灯带布局：灯带 L0–L7 对应 EFFECT_STRIPS=8 路；灯珠索引 0 是灯带头部，
 * 动画的"正向/反向"方向由 direction 参数相对该索引定义（物理接线方向是
 * 驱动层的事，#13）。
 */

/* HELLO 广播的两个字段（#4 决议第 2 节）。 */
#define EFFECT_STRIP_COUNT 8u
#define EFFECT_LEDS_PER_STRIP 60u

/* 灯效编号（#4 决议第 3 节），与 ble_proto_effect_param_length 的表一一对应。 */
#define EFFECT_ID_OFF 0x00u
#define EFFECT_ID_STATIC 0x01u
#define EFFECT_ID_BREATH 0x02u
#define EFFECT_ID_GRADIENT 0x03u
#define EFFECT_ID_RAINBOW 0x04u
#define EFFECT_ID_CHASE 0x05u
#define EFFECT_ID_TWINKLE 0x06u
#define EFFECT_ID_COUNT 7u

/* 无灯效时的 effect_id 占位：无效，apply 返回 unknown。 */
#define EFFECT_ID_NONE 0xFFu

/*
 * apply 结果码。取值与协议 NAK 错误码对齐，调用方（协议层粘合代码）可直接
 * 把 RESULT_TO_NAK 的结果作为 NAK error 字段发出：
 *   - OK              ACK
 *   - UNKNOWN_EFFECT  NAK 0x03
 *   - LENGTH_MISMATCH NAK 0x04（param_len 短于期望值）
 *   - INVALID_PARAM   NAK 0x05（参数合法长度但语义越界）
 * strip_mask == 0 不是错误：帧被忽略、返回 OK（线上无动作）。
 */
#define EFFECT_OK 0x00
#define EFFECT_ERR_UNKNOWN_EFFECT 0x03
#define EFFECT_ERR_LENGTH_MISMATCH 0x04
#define EFFECT_ERR_INVALID_PARAM 0x05

/*
 * 每路灯带的独立状态：当前灯效 + 参数 + 动画锚点。
 * start_ms 是动画时间锚点：apply 时以当时的 now_ms 锚定，之后渲染只依赖
 * now_ms - start_ms，切灯效不会跳相位。effect_init 后全部灯带处于 off 态。
 * 所有灯效（含星闪）都是 (params, now_ms) 的纯函数，无隐式帧计数。
 */
#define EFFECT_MAX_PARAM_LEN 10u /* 最长灯效（渐变）的参数长度 */

typedef struct {
    uint8_t effect_id;
    uint8_t param_len;
    uint8_t params[EFFECT_MAX_PARAM_LEN];
    uint32_t start_ms; /* 动画锚点：apply 时的 now_ms */
} effect_strip_t;

typedef struct {
    effect_strip_t strips[EFFECT_STRIP_COUNT];
} effect_ctx_t;

/* 全部灯带复位到 off 态。 */
void effect_init(effect_ctx_t *ctx);

/*
 * 应用一条 SET_EFFECT（#4 决议第 3 节参数布局）：
 * payload = effect_id(1) + params，len 为 payload_len。
 * - 短于期望值           -> EFFECT_ERR_LENGTH_MISMATCH
 * - 未知 effect_id       -> EFFECT_ERR_UNKNOWN_EFFECT
 * - 参数语义越界         -> EFFECT_ERR_INVALID_PARAM
 * - param_len 长于期望值 -> 接受，多余字节忽略（向后兼容）
 * 成功时 strip_mask 选中的灯带原子切换到新灯效：参数与动画锚点一起替换，
 * now_ms 为动画锚点（当前时间）。未选中的灯带不受影响。
 * 返回 EFFECT_OK 或上面的错误码。
 */
uint8_t effect_apply(effect_ctx_t *ctx, uint8_t strip_mask,
                     const uint8_t *payload, uint8_t len, uint32_t now_ms);

/*
 * 渲染一路灯带的帧缓冲（逻辑 RGB，r[i*3+0]=R 等）。
 * now_ms 为注入的当前时间；out 容量需 >= leds*3。
 * 未在 effect_apply 里设置过的灯带输出全 0（off）。
 */
void effect_render(const effect_ctx_t *ctx, uint8_t strip,
                   uint32_t now_ms, uint8_t *out);

/* 某路灯带当前 effect_id（EFFECT_ID_NONE 表示未设置）。 */
uint8_t effect_active_id(const effect_ctx_t *ctx, uint8_t strip);

/* 渲染整个帧周期：所有灯带各渲染一次（供 #13 刷新周期调用）。 */
void effect_render_all(const effect_ctx_t *ctx, uint32_t now_ms,
                       uint8_t *out, size_t out_len);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_EFFECT_ENGINE_H */