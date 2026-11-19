#ifndef BLE_LIGHT_RMT_DRIVER_H
#define BLE_LIGHT_RMT_DRIVER_H

#include <stdint.h>

#include "esp_err.h"

#include "scheduler.h"
#include "ws2812.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * ESP32-C3 RMT 驱动对外接口（ports/esp32 内部 + app 用）。
 *
 * 通道几何：ch0/ch1 各 48 symbols mem_block（双通道对称，不加倍 ——
 * C3 内存块连续分配约束，见 rmt_driver.c 文件头）。
 * 通道↔灯带：ch0 → L0/2/4/6（GPIO0/3/4/5），ch1 → L1/3/5/7
 * （GPIO1/6/7/10），#3 分配；轮 r 驱动 strip 2r / 2r+1。
 */

/* 初始化：建 2 通道（48 符号 + intr 3 + IRAM 编码器）+ 回调 + enable。
 * sched 为 glitch 回加上报目标（done 回调里调 scheduler_note_done）。 */
esp_err_t rmt_driver_init(sched_ctx_t *sched);

/* 灯带 strip(0..7) → 其 GPIO 引脚（#3 分配，switch 机制/自检用）。 */
uint8_t rmt_strip_gpio(uint8_t strip);

/* strip 的符号缓冲（8 条各 1441 符号，ports 静态分配）。
 * app 层把 ws2812_encode 的输出写进这里。 */
ws2812_symbol_t *rmt_strip_symbols(uint8_t strip);

/* 启动通道 channel(0/1) 上"当前符号缓冲"的传输（异步返回，done 回调
 * 记 glitch；LED 任务用 rmt_wait_round 收尾）。 */
esp_err_t rmt_transmit_strip(uint8_t channel);

/* 串行等待两通道在途事务完成（#7 §6）。超时返回 ESP_ERR_TIMEOUT
 * （上层记 glitch）。 */
esp_err_t rmt_wait_round(void);

/* ISR 记录的 done num_symbols 排空与打印（led_task 轮次间隙调用，用于
 * 诊断 num_symbols 与期望的差异；不会误报正常传输）。 */
void rmt_dump_done(uint8_t ch_idx);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_RMT_DRIVER_H */