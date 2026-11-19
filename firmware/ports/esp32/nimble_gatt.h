#ifndef BLE_LIGHT_NIMBLE_GATT_H
#define BLE_LIGHT_NIMBLE_GATT_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * NimBLE GATT server（ports/esp32，#14）—— C3 的 BLE 控制面。
 *
 * GATT 布局（UUID 定稿，见 firmware/README.md 与 #14 报告）：
 *   Service  0xFFE0-0000-1000-8000-00805F9B34FB（16 位 0xFFE0）
 *   CMD 写   0xFFE1-0000-1000-8000-00805F9B34FB（WRITE，无响应写也可）
 *   RSP 通知 0xFFE2-0000-1000-8000-00805F9B34FB（NOTIFY + CCCD 0x2902）
 *
 * 数据流：
 * - CMD 写回调：分片累积（ble_proto_feed，静态缓冲 266 字节）→ 完整帧
 *   → core gatt_dispatch → 动作执行（effect_apply / brightness / ACK /
 *   NAK / STATUS）→ 需要时 RSP notify。
 * - 连接建立 + CCCD 订阅后：C3 主动发 HELLO（29 字节 payload 帧，effect_bitmap[16]）。
 * - 周期 STATUS：2s（定时器回调里只做组帧 + notify，不重活）。
 * - 满功率门禁 / 解锁在 core 分发层（gatt.c），ports 只执行。
 * - 断连：保持灯效继续跑（led_task 不感知）；新连接重新发 HELLO。
 *
 * 传输窗口纪律（#7 §3-5）：notify / NVS 写不在 RMT 传输窗口内做 ——
 * NimBLE host 任务与 LED 任务的 RMT 传输是不同任务，无程序化互斥；靠
 * "BLE 事件稀疏化"（连接间隔 50–100ms、STATUS 2s）把冲突概率压到
 * 工程可接受（#7 §3 缓解包第 4 条）。
 */

/* 初始化 NimBLE 协议栈 + GATT server + 广播 + 100ms 周期定时器。
 * 必须在 app_init 里 led_task_start 之后调用（共享状态已就绪）。 */
esp_err_t nimble_gatt_init(void);

/* 当前是否已连接（调试/串口用）。 */
int nimble_gatt_connected(void);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_NIMBLE_GATT_H */