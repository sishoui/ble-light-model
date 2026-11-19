idf_component_register(
    SRCS "main.c"
         "../ports/esp32/rmt_driver.c"
         "../ports/esp32/rmt_switch.c"
         "../ports/esp32/led_task.c"
         "../app/app.c"
    INCLUDE_DIRS
        "."
        "../ports/esp32"
        "../app"
    REQUIRES
        "core"
        "proto"
        "driver"
        "esp_timer"
        "esp_driver_rmt"
        "usb"
)