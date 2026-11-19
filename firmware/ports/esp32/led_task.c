/*
 * LED 任务实现（#7 §6）。
 *
 * 死循环：到刷新周期点 → effect_render 填充两路符号缓冲 → switch 选通
 * 本轮引脚 → 两通道 transmit → rmt_tx_wait_all_done 串行等待 →
 * vTaskDelayUntil 对齐下一周期。任一 wait 超时即 glitch（done 回调也会
 * 通过 sched_note_done 记 num_symbols 不符，两个口径互补）。
 *
 * 共享状态取快照用临界区（portMUX），只保护赋值一瞬；渲染与 RMT 操作
 * 全在任务上下文。日志只打事件（轮次间隙），传输窗口内不调用。
 */

#include "led_task.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "effect_engine.h"
#include "event_log_port.h"
#include "rmt_driver.h"
#include "rmt_switch.h"
#include "scheduler.h"
#include "ws2812.h"

static const char *TAG = "led";

#define LED_TASK_STACK 4096
#define LED_TASK_PRIO 5 /* 高于 BLE host（#7 §6；数字实测后调） */
#define LED_TASK_CORE 0

/* NimBLE（#14）与 LED 任务的唯一数据面。 */
static led_shared_t shared;
static sched_ctx_t sched;

/* #15：glitch 累计值变化检测（事件日志去重口径）。 */
static uint16_t s_last_glitch;

/* led_task_set_shared 与 LED 任务之间的临界区（取快照瞬间）。 */
static portMUX_TYPE shared_mux = portMUX_INITIALIZER_UNLOCKED;

void led_task_set_shared(const led_shared_t *s)
{
    if (s == NULL) {
        return;
    }
    portENTER_CRITICAL(&shared_mux);
    shared = *s;
    portEXIT_CRITICAL(&shared_mux);
    /* 把效果表同步进调度器（活跃判定 / keep-alive 的输入）。 */
    for (uint8_t i = 0; i < EFFECT_STRIP_COUNT; i++) {
        sched.active_id[i] = s->effects.strips[i].effect_id;
    }
}

void led_task_snapshot(led_shared_t *out)
{
    if (out == NULL) {
        return;
    }
    portENTER_CRITICAL(&shared_mux);
    *out = shared;
    portEXIT_CRITICAL(&shared_mux);
}

uint16_t led_task_glitch_count(void)
{
    return sched.glitch_count;
}

static uint32_t now_ms(void *ctx)
{
    (void)ctx;
    return (uint32_t)(esp_timer_get_time() / 1000);
}

/* scheduler 注入的 transmit：启动通道上预填好的符号缓冲。 */
static void on_transmit(uint8_t channel, const sched_item_t *item, void *ctx)
{
    (void)ctx;
    (void)item;
    esp_err_t err = rmt_transmit_strip(channel);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ch%u transmit failed: %s", channel,
                 esp_err_to_name(err));
    }
}

/* 渲染一轮 2 条灯带的符号缓冲（读共享快照）。 */
static void render_round(uint8_t round, uint32_t now)
{
    led_shared_t snap;
    uint8_t frame[EFFECT_LEDS_PER_STRIP * 3];

    portENTER_CRITICAL(&shared_mux);
    snap = shared;
    portEXIT_CRITICAL(&shared_mux);

    for (uint8_t ch = 0; ch < 2; ch++) {
        uint8_t strip = sched_round_strip(round, ch);
        ws2812_symbol_t *dst = rmt_strip_symbols(strip);

        effect_render(&snap.effects, strip, now, frame);
        ws2812_encode(frame, EFFECT_LEDS_PER_STRIP, snap.brightness, dst,
                      SCHED_BUF_SYMBOLS);
    }
}

static void led_task(void *arg)
{
    (void)arg;
    TickType_t last_wake = xTaskGetTickCount();

    sched_init(&sched, on_transmit, now_ms, NULL);

    for (;;) {
        /* 到刷新周期点：跑一轮（round = sched 当前轮号）。 */
        uint8_t round = sched.round;
        render_round(round, now_ms(NULL));
        rmt_switch_select_round(round);
        sched_tick(&sched); /* 内部经 on_transmit 启动两通道 */
        if (rmt_wait_round() != ESP_OK) {
            /* 超时 = glitch（num_symbols 不符的另一种形态）。 */
            sched_note_done(&sched, 0u);
            ESP_LOGW(TAG, "round timeout (glitch, count=%u)",
                     (unsigned)sched.glitch_count);
        }
        rmt_dump_done(0);
        rmt_dump_done(1);
        /* 传输窗口结束：轮次间隙（日志/堆操作可在此做）。 */
        rmt_switch_all_off();
        /* #15：glitch 累计值变化事件（PC 集成断言锚点，事件级去重：
         * 只在计数变化时发一行）。 */
        if (sched.glitch_count != s_last_glitch) {
            s_last_glitch = sched.glitch_count;
            event_log_emit_glitch(s_last_glitch);
        }

        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(SCHED_REFRESH_MS));
    }
}

esp_err_t led_task_start(void)
{
    esp_err_t err;

    effect_init(&shared.effects);
    shared.brightness = 128; /* 上电默认半亮（与 #3 软限配合） */

    err = rmt_driver_init(&sched);
    if (err != ESP_OK) {
        return err;
    }
    err = rmt_switch_init();
    if (err != ESP_OK) {
        return err;
    }

    BaseType_t ok = xTaskCreatePinnedToCore(led_task, "led", LED_TASK_STACK,
                                            NULL, LED_TASK_PRIO, NULL,
                                            LED_TASK_CORE);
    if (ok != pdPASS) {
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "LED task started (prio %d, core %d, %u ms period)",
             LED_TASK_PRIO, LED_TASK_CORE, SCHED_REFRESH_MS);
    return ESP_OK;
}