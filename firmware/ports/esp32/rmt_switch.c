/*
 * 切换机制默认实现：方案①（#7 §4 / #3）。
 *
 * 初始化：ch0 的 TX 信号经 GPIO Matrix 连到 GPIO0/3/4/5，ch1 连到
 * GPIO1/6/7/10（#3 分配）；8 个引脚全部设为输出、初始关闭。
 * 运行时：每轮只 gpio_output_enable 下轮 2 个引脚、disable 其余 6 个
 * —— 零重路由、零传输窗口内操作（两条寄存器写），满足 #7 §3-5 的
 * "传输窗口内禁止关中断操作"约束。
 *
 * 换成方案②（rmt_tx_switch_gpio）只需替换 select_round 的实现（通道
 * 先 rmt_disable → switch → rmt_enable，在轮间做），接口不变。
 */

#include "rmt_switch.h"

#include "driver/gpio.h"
#include "esp_log.h"

#include "rmt_driver.h" /* ch_gpios */

static const char *TAG = "rmt_switch";

esp_err_t rmt_switch_init(void)
{
    esp_err_t err;

    /* 全部设为输出、初始低电平关闭。 */
    for (int ch = 0; ch < 2; ch++) {
        for (int r = 0; r < 4; r++) {
            gpio_num_t pin = rmt_strip_gpio((uint8_t)(ch * 4 + r));
            gpio_config_t io = {
                .pin_bit_mask = 1ULL << pin,
                .mode = GPIO_MODE_OUTPUT,
                .pull_up_en = GPIO_PULLUP_DISABLE,
                .pull_down_en = GPIO_PULLDOWN_DISABLE,
                .intr_type = GPIO_INTR_DISABLE,
            };
            err = gpio_config(&io);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "gpio %d config failed", pin);
                return err;
            }
            gpio_set_level(pin, 0);
            gpio_set_direction(pin, GPIO_MODE_INPUT); /* 输出关闭 */
        }
    }
    ESP_LOGI(TAG, "switch ready: 8 pins, plan 1 (output enable/disable)");
    return ESP_OK;
}

esp_err_t rmt_switch_select_round(uint8_t round)
{
    if (round >= 4u) {
        return ESP_ERR_INVALID_ARG;
    }
    for (int r = 0; r < 4; r++) {
        for (int ch = 0; ch < 2; ch++) {
            gpio_num_t pin = rmt_strip_gpio((uint8_t)(ch * 4 + r));
            if (r == (int)round) {
                gpio_set_direction(pin, GPIO_MODE_OUTPUT);
            } else {
                gpio_set_direction(pin, GPIO_MODE_INPUT);
            }
        }
    }
    return ESP_OK;
}

esp_err_t rmt_switch_all_off(void)
{
    for (int ch = 0; ch < 2; ch++) {
        for (int r = 0; r < 4; r++) {
            gpio_set_direction(rmt_strip_gpio((uint8_t)(ch * 4 + r)),
                               GPIO_MODE_INPUT);
        }
    }
    return ESP_OK;
}