#ifndef BLE_LIGHT_NVS_STORE_H
#define BLE_LIGHT_NVS_STORE_H

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#include "scene.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * NVS 场景持久化适配（ports/esp32，#14）。
 *
 * NVS 命名空间 `ble_light`，键 `scene`；blob 布局 = scene 序列化输出
 * （scene_version(1) + length(2) + payload + CRC(2)，见 core/scene.h）。
 *
 * 去抖保存口径（#4 第 4 节）：状态变更（SET_EFFECT / SET_BRIGHTNESS /
 * SET_POWER_LIMIT 等成功落地）后 1s 去抖 —— 1s 内继续收到命令则重新计时；
 * 到点后把最新场景写进 NVS。ACK 是否回仍由 flags bit0 门控，与保存解耦
 * （客户端关 ACK 不顺带关持久化）。实现用「pending 标志 + 截止时间戳」由
 * 100ms 周期定时器推进（NimBLE host 任务里跑，不新开任务；写 NVS 放在
 * 轮次间隙的定时器回调，不碰 RMT 传输窗口）。
 *
 * power_limit 的来源：led 共享状态目前不含限流字段（#14 之前没人需要）。
 * 为了让保存的 blob 带正确的 power_limit_ma，本模块持有运行时值：
 * nimble_gatt 在 SET_POWER_LIMIT 动作执行后调 nvs_store_set_power_limit，
 * 本模块在 tick 保存时打包进 scene。重启加载时返回给 nimble_gatt 恢复。
 *
 * 写放大控制：仅 pending 时才写；load 只在启动时调用一次。
 */

/* 初始化（打开句柄）。启动时调用一次。 */
esp_err_t nvs_store_init(void);

/*
 * 启动加载：读 blob -> scene_decode。返回 1 = 有效场景已恢复（out 填好）；
 * 0 = 缺失/损坏（out 置全灭态）。err 非 NULL 时回填 esp_err_t（诊断用）。
 * out->power_limit_ma 恢复为持久化值（受限默认或保存值）；unlock 态不
 * 持久化，由 nimble_gatt 负责夹回受限口径。
 */
int nvs_store_load(scene_state_t *out, esp_err_t *err);

/* 运行时限流（SET_POWER_LIMIT 后由 nimble_gatt 同步）。 */
void nvs_store_set_power_limit(uint16_t ma);
uint16_t nvs_store_power_limit(void);

/*
 * 标记"场景已变，需要保存"：重置 1s 去抖计时。收到 ACK 的命令后调用。
 * 同一 tick 内多次调用只保留一次保存。
 */
void nvs_store_mark_dirty(void);

/*
 * 周期推进（100ms 定时器回调里调）：检查去抖到期，到期则把 led 共享
 * 状态的当前快照编码写 NVS。写失败仅打日志（下次 mark_dirty 再来）。
 */
void nvs_store_tick(uint32_t now_ms);

/* 立即保存当前快照（测试/串口命令用；不走去抖）。 */
esp_err_t nvs_store_save_now(const scene_state_t *st);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_NVS_STORE_H */