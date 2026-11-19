#ifndef BLE_LIGHT_APP_H
#define BLE_LIGHT_APP_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* app 层对外（main.c 调用）：启动 LED 任务 + 控制台 + 上电自检。 */
esp_err_t app_init(void);

/* 上电自检：8 条灯带轮流点亮可辨识颜色（L0→L7）。 */
esp_err_t app_run_selftest(void);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_APP_H */