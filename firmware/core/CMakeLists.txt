idf_component_register(
    SRCS "ws2812.c" "scheduler.c" "console.c" "scene.c" "gatt.c" "event_log.c"
    INCLUDE_DIRS "."
    REQUIRES "proto"
)

# core 不直接调 esp_timer/esp_log —— 时间/日志全注入（host 可编译）。
# 无 IDF 依赖以外的 REQUIRES。