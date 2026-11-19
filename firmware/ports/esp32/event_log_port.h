#ifndef BLE_LIGHT_EVENT_LOG_PORT_H
#define BLE_LIGHT_EVENT_LOG_PORT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 事件日志 ports 粘合（ports/esp32，#15）。
 *
 * core/event_log（纯函数：JSON 行格式化 + 定长环形缓冲）之上的一薄层：
 * - 环形缓冲实例 + USB CDC 写出回调（由 app 层注入，app.c 的 console 任务
 *   每轮调用 event_log_flush 把行排到 USB CDC）；
 * - event_log_emit_* 系列：在调用点（nimble_gatt / app / led_task /
 *   nvs_store 粘合处）格式化成行并入环。
 *
 * 事件种类与字段见 core/event_log.h 文件头。seq 口径：RX 帧序号回显；
 * 无关联帧的事件传 0。t_ms 由本层取 esp_timer 单调时钟（仅供 PC 排序）。
 *
 * 线程：emit 可在 NimBLE host 任务 / esp_timer 任务 / LED 任务调用 ——
 * 入环是内存拷贝（关中断不需要，FreeRTOS 任务级并发由"单写者多读点 +
 * 8 行环"容忍：极端并发下最多丢最旧行，计数可查）。flush 只在 console
 * 任务调用。
 */

/* 写出回调：把 len 字节（含 '\n'）写到具体介质（app 层注入 USB CDC）。 */
typedef void (*event_log_write_fn)(const char *data, size_t len, void *ctx);

/* 初始化（清零环形缓冲）。app_init 早期调用。 */
void event_log_init(void);

/* 注入写出回调（app 层装配 USB CDC 后调用）。 */
void event_log_attach(event_log_write_fn fn, void *ctx);

/* 把环里全部行写出（console 任务每轮调用；最坏 100ms 延迟）。 */
void event_log_flush(void);

/* ---- 事件发射（调用点散布在 ports/app 粘合处） ---- */

/* 上电装配完成。fw 例："0.1.0"。 */
void event_log_emit_boot(const char *fw);

/* GAP：连接建立。 */
void event_log_emit_connect(void);
/* GAP：断连（reason 为 NimBLE 断连原因码）。 */
void event_log_emit_disconnect(int reason);
/* GAP：RSP CCCD 订阅变化（notify：非 0 = 订阅）。 */
void event_log_emit_subscribe(int notify);
/* GAP：MTU 更新（被动跟随，值仅记录）。 */
void event_log_emit_mtu(uint16_t mtu);

/* CMD 帧解出（seq = 帧序号；type/flags/len 为帧字段）。 */
void event_log_emit_rx(uint16_t seq, uint8_t type, uint8_t flags,
                       uint8_t len);
/* ACK notify 发出（seq = 被确认帧序号）。 */
void event_log_emit_ack(uint16_t seq);
/* NAK notify 发出（seq + 错误码）。 */
void event_log_emit_nak(uint16_t seq, uint8_t err);
/* STATUS 帧发出（seq：触发帧序号，周期 STATUS 为 0）。 */
void event_log_emit_status(uint16_t seq, uint8_t brightness,
                           uint16_t glitch, uint16_t drop);
/* NVS 保存完成（rc 为 esp_err_t）。 */
void event_log_emit_nvs_save(int rc);
/* 协议层丢帧：feed 缓冲溢出（reason="feed_overflow"）或错误帧
 * （reason="parse"，err = NAK 码）。 */
void event_log_emit_drop(const char *reason, uint8_t err);
/* 调度 glitch 累计值变化（count 为变化后的值）。 */
void event_log_emit_glitch(uint16_t count);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_EVENT_LOG_PORT_H */