// 灯效引擎公共头（firmware/effects）。
// 纯 C99：无 Arduino / ESP-IDF、无 malloc、无 float、无 stdio（driver.md §5.1）。
// 本文件同时承载 driver 与 effects 共享的常量（LIGHT_STRIP_COUNT / LIGHT_LEDS）。
// 接口签名与 docs/spec/driver.md §5.2 一致。

#ifndef EFFECT_ENGINE_H
#define EFFECT_ENGINE_H

#include <stdint.h>
#include <stdbool.h>

#define LIGHT_STRIP_COUNT 8
#define LIGHT_LEDS        100
#define LIGHT_RGB_BYTES   (LIGHT_LEDS * 3) /* rgb[] 元素个数 */

/* effect_id 常量（effects.md §3） */
#define EFFECT_OFF        0x00
#define EFFECT_STATIC     0x01
#define EFFECT_BREATH     0x02
#define EFFECT_GRADIENT   0x03
#define EFFECT_RAINBOW    0x04
#define EFFECT_FLOW       0x05
#define EFFECT_SPARKLE    0x06

/*
 * 渲染一条灯带的逐像素 RGB（逻辑 R,G,B 序）。
 * effect_id:  效果 id（0x00 关灯）。
 * params:     该效果参数，按 docs/spec/protocol.md §6 的 RGB 布局解析。
 * strip:      灯带索引 0..7（周期类效果按 strip/8 错开相位）。
 * t_ms:       全局时间基（开机毫秒）。speed=0 时相位恒 0（冻结）。
 * rgb:        输出缓冲区，长度 LIGHT_RGB_BYTES；每 3 字节 = 1 颗 LED 的逻辑 RGB。
 */
void effect_render(uint8_t effect_id, const uint8_t *params, uint8_t strip,
                   uint32_t t_ms, uint8_t rgb[LIGHT_RGB_BYTES]);

/*
 * 该效果是否随时间变化（活动）。
 * 静态/关灯 → false；周期类在 speed=0 时也判为 false（冻结）。
 * 呼吸在 min==max 时理论上静态，仍判为 true（不做额外优化，driver.md §1.2）。
 */
bool effect_is_time_varying(uint8_t effect_id, const uint8_t *params);

/*
 * 星闪确定性 hash（effects.md §6.8 的 hash32）。
 * 同一 (i, slot, strip) 必得同一值；无 rand()、无开机种子。
 * 暴露为公共函数：既供引擎内部用，也让 host 单测 / t9 golden 对拍可直接锁定字节值。
 */
uint32_t effect_sparkle_hash(uint32_t i, uint32_t slot, uint32_t strip);

#endif /* EFFECT_ENGINE_H */