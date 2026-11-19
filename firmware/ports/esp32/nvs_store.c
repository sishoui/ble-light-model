/*
 * NVS 场景持久化实现（ports/esp32，#14）。
 *
 * 传输窗口纪律（#7 §3-5）：NVS 写只允许在轮次间隙发生 —— tick 由 100ms
 * 定时器驱动（远高于 25ms 刷新周期），写操作单次 < 1ms，不与 RMT 传输
 * 窗口（1.8ms/条）重叠概率低；即便偶合，NVS 擦写只在轮次间隙的 100ms
 * 定时器回调里，最坏也只错过一个 keep-alive。这里不做互斥，靠"低频 +
 * 短时"满足窗口纪律。
 */

#include "nvs_store.h"

#include <string.h>

#include "nvs.h"
#include "nvs_flash.h"

#include "esp_log.h"
#include "event_log_port.h"
#include "gatt.h"
#include "led_task.h"

static const char *TAG = "nvs";

#define NVS_NAMESPACE "ble_light"
#define NVS_KEY_SCENE "scene"

/* 去抖保存参数（#4：ACK 后 1s 去抖，继续收命令重新计时）。 */
#define NVS_SAVE_DEBOUNCE_MS 1000u

static nvs_handle_t s_nvs;
static uint8_t s_dirty;
static uint32_t s_deadline_ms;
static uint16_t s_power_limit = GATT_DEFAULT_POWER_LIMIT_MA;

esp_err_t nvs_store_init(void)
{
    esp_err_t err = nvs_flash_init();

    if (err == ESP_ERR_NVS_NO_FREE_PAGES ||
        err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "nvs flash init 0x%x, erasing", (unsigned)err);
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &s_nvs);
    if (err != ESP_OK) {
        return err;
    }
    s_dirty = 0u;
    s_deadline_ms = 0u;
    ESP_LOGI(TAG, "nvs ready (namespace=%s key=%s)", NVS_NAMESPACE,
             NVS_KEY_SCENE);
    return ESP_OK;
}

int nvs_store_load(scene_state_t *out, esp_err_t *err)
{
    uint8_t blob[SCENE_BLOB_MAX];
    size_t len = sizeof(blob);
    esp_err_t rc = nvs_get_blob(s_nvs, NVS_KEY_SCENE, blob, &len);

    if (err != NULL) {
        *err = rc;
    }
    s_power_limit = GATT_DEFAULT_POWER_LIMIT_MA;
    if (rc != ESP_OK || len == 0u) {
        scene_init_state(out);
        ESP_LOGI(TAG, "no scene in nvs (rc=0x%x) -> all off",
                 (unsigned)rc);
        return 0;
    }
    if (scene_decode(blob, len, out)) {
        /* 持久化的限流：恢复（受限默认或保存值）；解锁态不恢复。 */
        s_power_limit = out->power_limit_ma;
        if (s_power_limit > GATT_POWER_LIMIT_MA) {
            s_power_limit = GATT_POWER_LIMIT_MA;
            out->power_limit_ma = s_power_limit;
        }
        ESP_LOGI(TAG, "scene restored (len=%u, limit=%uma)",
                 (unsigned)len, (unsigned)s_power_limit);
        return 1;
    }
    ESP_LOGW(TAG, "scene invalid -> all off");
    return 0;
}

void nvs_store_set_power_limit(uint16_t ma)
{
    s_power_limit = ma;
}

uint16_t nvs_store_power_limit(void)
{
    return s_power_limit;
}

void nvs_store_mark_dirty(void)
{
    s_dirty = 1u;
    s_deadline_ms = 0u; /* 重新计时：等 tick 设新截止 */
}

esp_err_t nvs_store_save_now(const scene_state_t *st)
{
    uint8_t blob[SCENE_BLOB_MAX];
    size_t n = scene_encode(st, blob, sizeof(blob));

    if (n == 0u) {
        return ESP_ERR_INVALID_SIZE;
    }
    esp_err_t rc = nvs_set_blob(s_nvs, NVS_KEY_SCENE, blob, n);

    if (rc == ESP_OK) {
        rc = nvs_commit(s_nvs);
    }
    if (rc == ESP_OK) {
        ESP_LOGI(TAG, "scene saved (%u bytes)", (unsigned)n);
    } else {
        ESP_LOGW(TAG, "scene save failed 0x%x", (unsigned)rc);
    }
    /* #15：NVS 事件（PC 集成断言锚点：ACK 说成功，NVS 也得真存）。 */
    event_log_emit_nvs_save((int)rc);
    return rc;
}

void nvs_store_tick(uint32_t now_ms)
{
    led_shared_t shared;

    if (!s_dirty) {
        return;
    }
    if (s_deadline_ms == 0u) {
        s_deadline_ms = now_ms + NVS_SAVE_DEBOUNCE_MS;
        return;
    }
    if ((int32_t)(now_ms - s_deadline_ms) < 0) {
        return; /* 去抖窗口内继续等 */
    }
    s_dirty = 0u;
    s_deadline_ms = 0u;

    led_task_snapshot(&shared);
    scene_state_t st;
    scene_capture(&shared.effects, shared.brightness, s_power_limit, &st);
    (void)nvs_store_save_now(&st);
}