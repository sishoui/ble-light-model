#ifndef BLE_LIGHT_RMT_SWITCH_H
#define BLE_LIGHT_RMT_SWITCH_H

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 切换机制（可替换单元，#7 §4）。core 不感知；ports 内部按轮次选通
 * "本轮哪些灯带引脚输出使能"。
 *
 * 几何（#3）：单 TX 信号经 GPIO Matrix 连到 4 个 GPIO；轮 r 里
 * ch0 驱动 strip 2r（引脚 rmt_strip_gpio(2r)），ch1 驱动 strip 2r+1
 * （引脚 rmt_strip_gpio(2r+1)）。
 *
 * 默认实现：方案① —— 初始化时把 TX 信号路由到 8 个引脚，运行时只做
 * gpio_output_enable/disable 选通。零重路由、零传输窗口内操作，每次
 * 切换仅寄存器写。方案②（rmt_tx_switch_gpio）要求先 disable 通道、
 * 在轮间做；波形质量由真机实测裁决（待真机验证项），接口按方案①的
 * 语义定义（select_round 在轮间调用），后续换方案②只改本文件实现。
 */

/* 初始化：8 个引脚全部设为 GPIO 输出（由 GPIO Matrix 连上对应通道
 * 信号）并初始关闭。 */
esp_err_t rmt_switch_init(void);

/* 选通某一轮：仅该轮 2 个引脚输出使能，其余 6 个关闭。
 * 必须在轮间（无在途事务）调用。 */
esp_err_t rmt_switch_select_round(uint8_t round);

/* 全关闭（自检结束 / 关灯兜底）。 */
esp_err_t rmt_switch_all_off(void);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_RMT_SWITCH_H */