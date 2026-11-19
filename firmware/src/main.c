#ifdef ESP_PLATFORM
void app_main(void)
{
    /* 骨架：后续工单在此初始化 BLE、协议层与 effect_engine。 */
}
#elif !defined(PIO_UNIT_TESTING)
int main(void)
{
    /* host 骨架：native 环境只用于编译与单测。 */
    return 0;
}
#endif