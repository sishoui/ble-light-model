/*
 * NimBLE GATT server 实现（ports/esp32，#14）。
 *
 * 分层：协议语义全在 core/gatt.c（host 单测）；本文件只做 NimBLE 粘合：
 * - CMD 特征写回调 → ble_proto_feed 重组 → gatt_dispatch → 动作执行
 * - RSP notify 帧发送（HELLO / ACK / NAK / STATUS）
 * - 周期 2s STATUS + 100ms 去抖保存 tick（一个定时器）
 * - 连接参数更新（50–100ms 间隔）+ 断连重启广播
 *
 * 线程模型：NimBLE host 任务跑协议栈；所有 GATT 事件回调在 host 任务
 * 上下文。周期定时器回调在 esp_timer 任务里，只做组帧 + notify + NVS
 * 去抖写 —— notify 经 ble_gatts_notify_custom（线程安全入口）；NVS 写
 * 单次 < 1ms 且 100ms 才一次，按 #7 §3-5 靠事件稀疏化满足窗口纪律。
 *
 * 传输窗口纪律：RMT 传输窗口（1.8ms/条）与 BLE 空口事件由不同任务触发，
 * 无法程序化互斥；#7 §3 缓解包第 4 条（连接间隔 50–100ms、STATUS 2s）
 * 已把冲突概率压到工程可接受，本文件不做额外互斥。
 *
 * 注意：nimble 头文件里 BLE_GAP_EVENT_SUBSCRIBE 的 attr_value 为 uint8_t，
 * 0x0080（Windows 怪癖，NimBLE-Arduino #850）在 C3 侧只可能是 0x80 位。
 */

#include "nimble_gatt.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"

#include "ble_proto.h"
#include "event_log_port.h"
#include "gatt.h"
#include "led_task.h"
#include "nvs_store.h"

#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

static const char *TAG = "nimble";

/* ---- GATT 布局（UUID 定稿，见 nimble_gatt.h / README） ---- */

/* Service 0xFFE0 / CMD 写 0xFFE1 / RSP 通知 0xFFE2（16 位 UUID，
 * Bluetooth SIG 未使用段厂商自定义）。 */
static const ble_uuid16_t gatt_svc_uuid = BLE_UUID16_INIT(0xFFE0);
static const ble_uuid16_t gatt_cmd_uuid = BLE_UUID16_INIT(0xFFE1);
static const ble_uuid16_t gatt_rsp_uuid = BLE_UUID16_INIT(0xFFE2);

static uint16_t gatt_cmd_val_handle;
static uint16_t gatt_rsp_val_handle;

/* ---- 运行时状态 ---- */

static uint8_t gatt_connected;
static uint16_t gatt_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint8_t gatt_subscribed; /* 客户端已订阅 RSP（CCCD != 0） */
static gatt_dispatch_t gatt_disp;
static uint16_t gatt_tx_seq; /* C3 自己的 HELLO/NAK/STATUS 序号 */

/* 分片重组上下文（CMD 写回调跨多次 write 累积）。 */
static ble_proto_feed_t gatt_feed;

/* drop_count：协议层丢弃帧计数（feed 缓冲溢出/半帧超时被丢弃）。
 * core 不持有 I/O 状态，计数在 ports 层，随 STATUS 上报。 */
static uint16_t s_drop_count;

/* led_task.c 里的 scheduler 的 glitch 计数 accessor（定义在 led_task.c，
 * 与 sched 静态变量同文件）。 */
uint16_t led_task_glitch_count(void);

/* ---- 周期定时器 ---- */

#define GATT_TICK_MS 100u                     /* 去抖保存 tick 粒度 */
#define STATUS_PERIOD_MS GATT_STATUS_PERIOD_MS /* 2000，来自 core/gatt.h */

static esp_timer_handle_t gatt_timer;
static uint32_t gatt_last_status_ms;

/* ---- 基础发送 ---- */

static int send_frame(uint8_t type, uint16_t seq, const uint8_t *payload,
                      uint8_t payload_len)
{
    ble_proto_frame_t f;
    uint8_t buf[BLE_PROTO_MAX_FRAME];
    size_t n;
    struct os_mbuf *om;
    int rc;

    memset(&f, 0, sizeof(f));
    f.version = BLE_PROTO_VERSION;
    f.seq = seq;
    f.type = type;
    f.flags = 0u;
    f.strip_mask = 0u;
    f.payload_len = payload_len;
    if (payload_len > 0u) {
        memcpy(f.payload, payload, payload_len);
    }
    n = ble_proto_encode(&f, buf, sizeof(buf));
    if (n == 0u) {
        return BLE_HS_EMSGSIZE;
    }

    om = ble_hs_mbuf_from_flat(buf, n);
    if (om == NULL) {
        return BLE_HS_ENOMEM;
    }
    rc = ble_gatts_notify_custom(gatt_conn_handle, gatt_rsp_val_handle, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "notify type=0x%02x failed rc=%d", type, rc);
    }
    return rc;
}

static void send_ack(uint16_t seq)
{
    uint8_t payload[2];

    payload[0] = (uint8_t)(seq & 0xFFu);
    payload[1] = (uint8_t)(seq >> 8);
    (void)send_frame(BLE_PROTO_TYPE_ACK, gatt_tx_seq++, payload, 2u);
    /* #15：ACK 事件（seq 回显；发送意图口径，传输失败另有 ESP_LOGW）。 */
    event_log_emit_ack(seq);
}

static void send_nak(uint16_t seq, uint8_t code)
{
    uint8_t payload[3];

    payload[0] = (uint8_t)(seq & 0xFFu);
    payload[1] = (uint8_t)(seq >> 8);
    payload[2] = code;
    (void)send_frame(BLE_PROTO_TYPE_NAK, gatt_tx_seq++, payload, 3u);
    /* #15：NAK 事件（err = NAK 错误码，PC 与 notify 帧交叉断言）。 */
    event_log_emit_nak(seq, code);
}

/* ---- HELLO / STATUS ---- */

static void send_hello(void)
{
    uint8_t payload[23];
    uint8_t caps = GATT_CAP_FULL_POWER | GATT_CAP_SCENE_SAVE |
                   GATT_CAP_EFFECT_BITMAP;

    gatt_build_hello(payload, caps, EFFECT_STRIP_COUNT,
                     EFFECT_LEDS_PER_STRIP);
    (void)send_frame(BLE_PROTO_TYPE_HELLO, gatt_tx_seq++, payload,
                     sizeof(payload));
}

static void send_status(uint16_t seq)
{
    led_shared_t shared;
    uint8_t payload[GATT_STATUS_PAYLOAD_LEN];
    uint16_t glitch = led_task_glitch_count();

    led_task_snapshot(&shared);
    /* temp_c / current_ma_est：C3 无温度传感器（报 0），current 按点亮
     * LED 数 × 单灯 20mA 满白估算（brightness 缩放）；thermal_status 恒
     * 0（正常），strip_fault 恒 0。 */
    gatt_build_status(payload,
                      (uint32_t)(esp_timer_get_time() / 1000000),
                      (int8_t)0,
                      (uint16_t)((uint32_t)shared.brightness * 60u * 8u *
                                 20u / 255u),
                      GATT_THERMAL_NORMAL,
                      glitch,
                      s_drop_count,
                      shared.brightness,
                      (uint16_t)nvs_store_power_limit(),
                      0u, &shared.effects);
    (void)send_frame(BLE_PROTO_TYPE_STATUS, gatt_tx_seq++, payload,
                     sizeof(payload));
    /* #15：STATUS 事件（seq = 触发帧序号，周期 STATUS 为 0）。字段与
     * STATUS payload 同源 —— PC 侧交叉断言 "notify 说 X，日志也得说 X"。 */
    event_log_emit_status(seq, shared.brightness, glitch, s_drop_count);
}

/* ---- 动作执行（core gatt_dispatch 的输出落地） ---- */

static void on_frame(const ble_proto_frame_t *f)
{
    gatt_action_t acts[1];
    size_t n = gatt_dispatch(&gatt_disp, f, acts, 1u);

    for (size_t i = 0; i < n; i++) {
        const gatt_action_t *a = &acts[i];
        led_shared_t shared;

        switch (a->type) {
        case GATT_ACT_APPLY_EFFECT: {
            uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
            uint8_t r;

            led_task_snapshot(&shared);
            r = effect_apply(&shared.effects, a->strip_mask, a->payload,
                             a->payload_len, now);
            if (r == EFFECT_OK) {
                led_task_set_shared(&shared);
                if (gatt_action_wants_ack(f)) {
                    send_ack(f->seq);
                    nvs_store_mark_dirty();
                }
            } else {
                send_nak(f->seq, r);
            }
            break;
        }
        case GATT_ACT_SET_BRIGHTNESS:
            led_task_snapshot(&shared);
            shared.brightness = a->payload[0];
            led_task_set_shared(&shared);
            if (gatt_action_wants_ack(f)) {
                send_ack(f->seq);
                nvs_store_mark_dirty();
            }
            break;
        case GATT_ACT_SET_POWER_LIMIT: {
            uint16_t lim = (uint16_t)((uint16_t)a->payload[0] |
                                      ((uint16_t)a->payload[1] << 8));

            gatt_disp.power_limit_ma = lim;
            nvs_store_set_power_limit(lim);
            if (gatt_action_wants_ack(f)) {
                send_ack(f->seq);
                nvs_store_mark_dirty();
            }
            break;
        }
        case GATT_ACT_SET_UNLOCK:
            gatt_disp.unlocked = a->payload[0] != 0u;
            if (!gatt_disp.unlocked) {
                /* =0 立即夹回受限：亮度 50% / 限流 15000。 */
                led_task_snapshot(&shared);
                if (shared.brightness > GATT_BRIGHTNESS_LIMIT) {
                    shared.brightness = GATT_BRIGHTNESS_LIMIT;
                    led_task_set_shared(&shared);
                }
                gatt_disp.power_limit_ma = GATT_POWER_LIMIT_MA;
                nvs_store_set_power_limit(GATT_POWER_LIMIT_MA);
                nvs_store_mark_dirty();
            }
            /* =1 解锁不持久化：不 mark_dirty。 */
            if (gatt_action_wants_ack(f)) {
                send_ack(f->seq);
            }
            break;
        case GATT_ACT_STATUS:
            send_status(f->seq);
            break;
        case GATT_ACT_NAK:
            send_nak(a->seq, a->error);
            break;
        case GATT_ACT_ACK:
            send_ack(a->seq);
            break;
        case GATT_ACT_NONE:
        default:
            break;
        }
    }
}

/* ---- CMD 写回调（分片累积） ---- */

static int on_cmd_write(uint16_t conn_handle, uint16_t attr_handle,
                        struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)arg;

    if (attr_handle != gatt_cmd_val_handle) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (gatt_feed.len + ctxt->om->om_len > sizeof(gatt_feed.buf)) {
        /* 缓冲溢出：丢弃半帧（drop_count 口径），从空重新开始。 */
        s_drop_count++;
        ble_proto_feed_reset(&gatt_feed);
        event_log_emit_drop("feed_overflow", 0u);
        return 0;
    }
    ble_proto_frame_t frames[4];
    ble_proto_error_t errors[4];
    size_t errors_written = 0u;
    size_t nf = ble_proto_feed(&gatt_feed, ctxt->om->om_data,
                               ctxt->om->om_len, frames, 4u, errors, 4u,
                               &errors_written);

    for (size_t i = 0u; i < errors_written; i++) {
        s_drop_count++;
        /* #15：错误帧事件（err = NAK 码；NAK notify 由 send_nak 发）。 */
        event_log_emit_drop("parse", errors[i].code);
        send_nak(errors[i].seq, errors[i].code);
    }
    for (size_t i = 0u; i < nf; i++) {
        /* #15：RX 事件 —— PC 交叉断言的 seq 关联起点（Δ 计时锚）。 */
        event_log_emit_rx(frames[i].seq, frames[i].type, frames[i].flags,
                          frames[i].payload_len);
        on_frame(&frames[i]);
    }
    return 0;
}

/* ---- GATT 表 ---- */

static int on_access(uint16_t conn_handle, uint16_t attr_handle,
                     struct ble_gatt_access_ctxt *ctxt, void *arg);

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = (const ble_uuid_t *)&gatt_svc_uuid,
        .characteristics = (struct ble_gatt_chr_def[]){
            {
                .uuid = (const ble_uuid_t *)&gatt_cmd_uuid,
                .access_cb = on_access,
                .val_handle = &gatt_cmd_val_handle,
                .flags = BLE_GATT_CHR_F_WRITE |
                         BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {
                .uuid = (const ble_uuid_t *)&gatt_rsp_uuid,
                .access_cb = on_access,
                .val_handle = &gatt_rsp_val_handle,
                .flags = BLE_GATT_CHR_F_NOTIFY,
            },
            {0},
        },
    },
    {0},
};

static int on_access(uint16_t conn_handle, uint16_t attr_handle,
                     struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR &&
        attr_handle == gatt_cmd_val_handle) {
        return on_cmd_write(conn_handle, attr_handle, ctxt, arg);
    }
    return BLE_ATT_ERR_UNLIKELY;
}

/* ---- GAP 事件 ---- */

static void start_advertise(void);

static int on_gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;

    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            gatt_connected = 1u;
            gatt_conn_handle = event->connect.conn_handle;
            gatt_subscribed = 0u;
            ble_proto_feed_reset(&gatt_feed);
            ESP_LOGI(TAG, "connected handle=%u", gatt_conn_handle);
            event_log_emit_connect();

            /* 连接参数：50–100ms 间隔（外设侧请求，#7 §5）。 */
            struct ble_gap_upd_params params = {
                .itvl_min = 50u * 1250u / 10u,  /* 50ms，单位 1.25ms/步 */
                .itvl_max = 100u * 1250u / 10u, /* 100ms */
                .latency = 0,
                .supervision_timeout = 500u, /* 5s，单位 10ms */
                .min_ce_len = 0,
                .max_ce_len = 0,
            };
            int rc = ble_gap_update_params(gatt_conn_handle, &params);
            if (rc != 0 && rc != BLE_HS_EALREADY) {
                ESP_LOGW(TAG, "conn param update rc=%d", rc);
            }
        } else {
            ESP_LOGW(TAG, "connect failed status=%d",
                     event->connect.status);
            start_advertise();
        }
        break;

    case BLE_GAP_EVENT_DISCONNECT:
        gatt_connected = 0u;
        gatt_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        gatt_subscribed = 0u;
        ble_proto_feed_reset(&gatt_feed);
        ESP_LOGI(TAG, "disconnected (reason=%d); restart advertising",
                 event->disconnect.reason);
        event_log_emit_disconnect(event->disconnect.reason);
        start_advertise();
        break;

    case BLE_GAP_EVENT_SUBSCRIBE:
        /* CCCD 写：NimBLE 给出 cur_notify 位（Windows 写 0x0080 的怪癖由
         * nimble 层规范化为 cur_notify，NimBLE-Arduino #850 同款防御只
         * 看 notify 语义位），订阅后 C3 补发一次 HELLO。 */
        gatt_subscribed = (uint8_t)(event->subscribe.cur_notify != 0u ||
                                    event->subscribe.cur_indicate != 0u);
        ESP_LOGI(TAG, "subscribe cur_notify=%u -> %s",
                 event->subscribe.cur_notify,
                 gatt_subscribed ? "on" : "off");
        if (gatt_subscribed) {
            send_hello();
        }
        event_log_emit_subscribe(event->subscribe.cur_notify);
        break;

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "MTU updated: %u (passive follow)",
                 event->mtu.value);
        event_log_emit_mtu(event->mtu.value);
        break;

    default:
        break;
    }
    return 0;
}

/* ---- 广播 ---- */

static void start_advertise(void)
{
    struct ble_gap_adv_params adv_params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
        .itvl_min = 100u,
        .itvl_max = 200u,
    };
    int rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER,
                               &adv_params, on_gap_event, NULL);

    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGW(TAG, "adv start rc=%d", rc);
    }
}

/* ---- 周期定时器（100ms：去抖保存 tick + 2s STATUS） ---- */

static void on_tick(void *arg)
{
    (void)arg;
    uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);

    nvs_store_tick(now);
    if (gatt_connected && gatt_subscribed &&
        (uint32_t)(now - gatt_last_status_ms) >= STATUS_PERIOD_MS) {
        gatt_last_status_ms = now;
        send_status(0u);
    }
}

/* ---- host 任务 / 初始化 ---- */

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

esp_err_t nimble_gatt_init(void)
{
    int rc;

    rc = nimble_port_init();
    if (rc != 0) {
        ESP_LOGE(TAG, "nimble_port_init rc=%d", rc);
        return ESP_FAIL;
    }

    /* 设备名（BLE 设备名，小程序/PC 按此扫描）。 */
    rc = ble_svc_gap_device_name_set("BLELight-C3");
    if (rc != 0) {
        ESP_LOGE(TAG, "device_name_set rc=%d", rc);
        return ESP_FAIL;
    }

    rc = ble_gatts_count_cfg(gatt_svcs);
    if (rc != 0) {
        return ESP_FAIL;
    }
    rc = ble_gatts_add_svcs(gatt_svcs);
    if (rc != 0) {
        return ESP_FAIL;
    }

    gatt_disp.unlocked = 0u;
    gatt_disp.power_limit_ma = GATT_DEFAULT_POWER_LIMIT_MA;
    gatt_conn_handle = BLE_HS_CONN_HANDLE_NONE;
    gatt_tx_seq = 0u;
    s_drop_count = 0u;

    /* 周期定时器：去抖保存 tick（100ms）+ 周期 STATUS（2s）。 */
    esp_timer_create_args_t timer_args = {
        .callback = on_tick,
        .arg = NULL,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "gatt_tick",
    };
    rc = esp_timer_create(&timer_args, &gatt_timer);
    if (rc != ESP_OK) {
        return ESP_FAIL;
    }
    rc = esp_timer_start_periodic(gatt_timer, (uint64_t)GATT_TICK_MS * 1000u);
    if (rc != ESP_OK) {
        return ESP_FAIL;
    }

    nimble_port_freertos_init(host_task);

    ESP_LOGI(TAG, "GATT server ready (svc 0xFFE0, cmd 0xFFE1, rsp 0xFFE2)");
    return ESP_OK;
}

int nimble_gatt_connected(void)
{
    return gatt_connected;
}