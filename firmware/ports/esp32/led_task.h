#ifndef BLE_LIGHT_LED_TASK_H
#define BLE_LIGHT_LED_TASK_H

#include "esp_err.h"

#include "scheduler.h"
#include "effect_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * LED 任务（#7 §6）：跑刷新周期调度器 + 轮次 RMT 串行等待。
 *
 * 任务体：死循环 → sched_tick 到点发一轮（switch 选通 → 填充符号 →
 * 两通道 transmit → rmt_tx_wait_all_done 串行等待）→ vTaskDelay 到
 * 下一轮。优先级高于 NimBLE host（具体数字实测后调）。
 *
 * 与 NimBLE 的解耦（#14 接入点）：本任务不 include 任何 NimBLE 头，
 * 通过 led_task_set_shared() 注入共享状态（effect_ctx + brightness +
 * power 状态），NimBLE 侧协议粘合代码（#14）写这些状态即可，LED 任务
 * 每轮读快照渲染。互斥用 ports 级简单锁（关中断 / 临界区），渲染在
 * 任务上下文，锁只保护"取快照"一瞬。
 *
 * 传输窗口纪律（#7 §3-5）：传输窗口（1.8ms/条）内禁止任何可能关中断
 * 的操作 —— 日志只进环形缓冲（本任务内 ESP_LOG* 仅用于轮次间隙的
 * 事件）、NVS 写 / 堆查询排到轮次间隙。
 */

/* 共享状态（NimBLE 侧协议粘合 #14 与 LED 任务之间的唯一数据面）。 */
typedef struct {
    effect_ctx_t effects;
    uint8_t brightness; /* 0–255 全局亮度（core/ws2812 注入） */
} led_shared_t;

/* 装配：初始化 RMT 驱动 / switch / 共享状态，创建 LED 任务。 */
esp_err_t led_task_start(void);

/* 注入 / 读取共享状态（NimBLE 侧协议粘合 #14 与 app 控制台的接入点）。
 * 写：全量替换（读改写请先 snapshot 再 set）。 */
void led_task_set_shared(const led_shared_t *shared);
void led_task_snapshot(led_shared_t *out);

/* glitch 计数（scheduler 持有，NimBLE 侧 STATUS 上报用）。 */
uint16_t led_task_glitch_count(void);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_LED_TASK_H */