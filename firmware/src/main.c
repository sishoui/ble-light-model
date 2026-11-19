#ifdef ESP_PLATFORM
#include "app.h"

void app_main(void)
{
    /* #13：装配 LED 任务（RMT 双通道）+ USB CDC 测试指令 + 上电自检。
     * #14：NVS 场景恢复 + BLE GATT server 在 app_init 内装配。 */
    app_init();
}
#elif !defined(PIO_UNIT_TESTING)
int main(void)
{
    /* host 骨架：native 环境只用于编译与单测。 */
    return 0;
}
#endif