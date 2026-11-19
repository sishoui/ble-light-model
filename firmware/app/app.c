/*
 * 上电装配与串口测试指令（app 层）。
 *
 * 装配（#14 起）：
 *   1. led_task_start（RMT 双通道 + LED 任务）
 *   2. nvs_store_init + nvs_store_load → 恢复 last scene 到 led 共享状态
 *      （缺失/损坏 -> 全灭态；解锁态不恢复，重启受限）
 *   3. nimble_gatt_init（NimBLE GATT server + 广播 + 周期定时器）
 *   4. USB CDC 控制台 + 上电自检
 *
 * 协议分发（SET_EFFECT / SET_BRIGHTNESS / SET_POWER_LIMIT /
 * UNLOCK_FULL_POWER / GET_STATUS）在 ports/esp32/nimble_gatt.c 的
 * on_frame 执行，与 BLE 共享同一 core/gatt.c 分发层。USB CDC 控制台是
 * 测试辅助（不进协议 profile），保持自有简单解析（console.c），但它也
 * 通过 led_task_set_shared 落共享状态 —— 与 BLE 共用同一渲染数据面。
 *
 * 自检：上电后跑一段可辨识序列 —— 8 条灯带按 L0→L7 顺序轮流点亮
 * 各自一遍（每条一个不同颜色），然后结束恢复原共享状态。
 */

#include "app.h"

#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "console.h"
#include "effect_engine.h"
#include "led_task.h"
#include "nimble_gatt.h"
#include "nvs_store.h"
#include "scene.h"

static const char *TAG = "app";

/* ---- 自检序列 ---- */

#define SELFTEST_STEP_MS 300u
#define SELFTEST_STRIPS 8u

static void selftest_task(void *arg)
{
    (void)arg;
    led_shared_t saved;

    led_task_snapshot(&saved);

    for (uint8_t strip = 0; strip < SELFTEST_STRIPS; strip++) {
        led_shared_t st = saved;
        st.brightness = 255u;
        /* 每条一个可辨识颜色，用 STATIC 灯效点亮。 */
        st.effects.strips[strip].effect_id = EFFECT_ID_STATIC;
        st.effects.strips[strip].param_len = 3u;
        st.effects.strips[strip].params[0] = (uint8_t)(0x40u + strip * 0x20u);
        st.effects.strips[strip].params[1] = 0x20u;
        st.effects.strips[strip].params[2] = (uint8_t)(0xE0u - strip * 0x20u);
        led_task_set_shared(&st);
        ESP_LOGI(TAG, "selftest strip L%u", strip);
        vTaskDelay(pdMS_TO_TICKS(SELFTEST_STEP_MS));
    }

    led_task_set_shared(&saved);
    ESP_LOGI(TAG, "selftest done");
    vTaskDelete(NULL);
}

esp_err_t app_run_selftest(void)
{
    BaseType_t ok = xTaskCreate(selftest_task, "selftest", 3072, NULL, 4, NULL);
    return ok == pdPASS ? ESP_OK : ESP_FAIL;
}

/* ---- 共享状态读改写（控制台动作执行） ---- */

static uint8_t console_set_effect(uint8_t mask, uint8_t effect_id,
                                  const uint8_t *params, uint8_t param_len)
{
    led_shared_t st;
    uint8_t payload[BLE_LIGHT_CONSOLE_MAX_PARAMS + 1u];
    uint8_t r;

    payload[0] = effect_id;
    if (param_len > 0u) {
        memcpy(&payload[1], params, param_len);
    }
    led_task_snapshot(&st);
    r = effect_apply(&st.effects, mask, payload, (uint8_t)(param_len + 1u),
                     (uint32_t)(esp_timer_get_time() / 1000));
    if (r == EFFECT_OK) {
        led_task_set_shared(&st);
        nvs_store_mark_dirty();
    }
    return r;
}

static void console_set_brightness(uint8_t b)
{
    led_shared_t st;

    led_task_snapshot(&st);
    st.brightness = b;
    led_task_set_shared(&st);
    nvs_store_mark_dirty();
}

/* ---- USB CDC 字符收发 ---- */

static void console_respond(const char *msg)
{
    usb_serial_jtag_write_bytes(msg, strlen(msg), portMAX_DELAY);
}

static char line_buf[BLE_LIGHT_CONSOLE_LINE_MAX];
static size_t line_len;

static void feed_byte(char c)
{
    if (c == '\n' || c == '\r') {
        if (line_len > 0u) {
            console_action_t act;
            console_parse_line(line_buf, line_len, &act);
            switch (act.type) {
            case CONSOLE_ACT_SET_EFFECT: {
                uint8_t r = console_set_effect(act.strip_mask, act.effect_id,
                                               act.params, act.param_len);
                console_respond(r == EFFECT_OK ? "OK\r\n" : "ERR\r\n");
                break;
            }
            case CONSOLE_ACT_SET_BRIGHTNESS:
                console_set_brightness(act.brightness);
                console_respond("OK\r\n");
                break;
            case CONSOLE_ACT_SELFTEST:
                console_respond("SELFTEST\r\n");
                app_run_selftest();
                break;
            case CONSOLE_ACT_HELP:
                console_respond("SET <mask> <effect> [p..] / BRI <0-255>"
                                " / SELFTEST / ?\r\n");
                break;
            case CONSOLE_ACT_NONE:
                break;
            case CONSOLE_ACT_ERROR:
            default:
                console_respond("ERR\r\n");
                break;
            }
            line_len = 0u;
        }
        return;
    }
    if (line_len < sizeof(line_buf)) {
        line_buf[line_len++] = c;
    } else {
        line_len = 0u; /* 超长行丢弃 */
    }
}

static void console_task(void *arg)
{
    (void)arg;
    uint8_t buf[64];

    ESP_LOGI(TAG, "console ready (USB CDC): SET/BRI/SELFTEST/?");
    console_respond("ready\r\n");
    for (;;) {
        int n = usb_serial_jtag_read_bytes(buf, sizeof(buf),
                                           pdMS_TO_TICKS(100));
        for (int i = 0; i < n; i++) {
            feed_byte((char)buf[i]);
        }
    }
}

/* ---- 装配 ---- */

esp_err_t app_init(void)
{
    esp_err_t err;

    err = led_task_start();
    if (err != ESP_OK) {
        return err;
    }

    /* #14：NVS 场景恢复（缺失/损坏 -> 全灭；解锁态不恢复）。 */
    err = nvs_store_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs init failed 0x%x (continuing without persistence)",
                 (unsigned)err);
    } else {
        scene_state_t scene;
        if (nvs_store_load(&scene, NULL)) {
            led_shared_t st;
            st.effects = scene.effects;
            st.brightness = scene.brightness;
            led_task_set_shared(&st);
            ESP_LOGI(TAG, "last scene restored");
        }
    }

    /* #14：BLE GATT server。 */
    err = nimble_gatt_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble gatt init failed 0x%x", (unsigned)err);
    }

    BaseType_t ok = xTaskCreate(console_task, "console", 3072, NULL, 3, NULL);
    if (ok != pdPASS) {
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "selftest start");
    app_run_selftest();
    return ESP_OK;
}