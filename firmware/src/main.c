#ifdef ESP_PLATFORM
#include "app.h"

void app_main(void)
{
    /* #13：装配 LED 任务（RMT 双通道）+ USB CDC 测试指令 + 上电自检。
     * BLE（#14）后续在此接入 led_task_set_shared。 */
    app_init();
}
#elif !defined(PIO_UNIT_TESTING)
int main(void)
{
    /* host 骨架：native 环境只用于编译与单测。 */
    return 0;
}
#endif