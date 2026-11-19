/*
 * ESP32-C3 RMT 驱动（IDF v5.5.3，espidf component）。
 *
 * 几何与缓解包（#7 §3 决议，rmt_tx_register_to_group() 源码核实）：
 * - 双通道 ch0/ch1，各 mem_block_symbols = 48。C3 每通道硬件 48 符号、
 *   内存块必须连续分配；一个通道占 96（2 块）后第二个 TX 通道在扫描
 *   范围内无连续空闲块、无法创建 —— 双通道对称 48+48，不加倍。
 * - 60 颗 × 24 符号 = 1440 符号/条 → ~60µs 补数据间隔，靠缓解包扛：
 *   ① 编码函数 IRAM（RMT_ENCODER_FUNC_ATTR + CONFIG_RMT_ENCODER_FUNC_IN_IRAM）
 *   ② CONFIG_RMT_TX_ISR_CACHE_SAFE（sdkconfig）
 *   ③ intr_priority = 3（LOWMED 档允许的最高值，创建后不可改）
 *   ④ 传输窗口（1.8ms/条）内禁止关中断操作（日志进环形缓冲、NVS/堆
 *      操作排到轮次间隙 —— 由 LED 任务编排保证，见 led_task.c）
 *
 * 符号编码在 core/ws2812（不 include IDF 头，host 可单测）。本文件用
 * IDF 官方的 rmt_new_simple_encoder（回调式编码器）：payload 直接是
 * core 编码好的 ws2812_symbol_t 数组（位布局与 rmt_symbol_word_t 兼容，
 * duration/level 位序一致），回调只做符号拷贝 —— 不做逐符号换算。
 * simple encoder 的回调在 ISR 上下文被调用，因此回调体带
 * RMT_ENCODER_FUNC_ATTR（IRAM）。
 *
 * 切换机制（#7 §4）：单信号多引脚 —— TX 信号经 GPIO Matrix 连到 4 个
 * GPIO（ch0→L0/2/4/6，ch1→L1/3/5/7，#3 分配），轮间只对"下轮要用的
 * 引脚"输出使能、其余关闭。可替换单元接口见 rmt_switch.h（默认实现
 * 方案① gpio 输出使能/关闭，零重路由开销）。
 *
 * glitch（#7 §3）：done 回调 edata.num_symbols 与期望不符
 * （期望 = 1440 数据 + 1 EOF = 1441）的累计次数，经 scheduler_note_done
 * 进 glitch_count，随 STATUS 上报。
 */

#include "rmt_driver.h"

#include <string.h>

#include "driver/gpio.h"
#include "driver/rmt_tx.h"
#include "esp_err.h"
#include "esp_log.h"

#include "scheduler.h"
#include "ws2812.h"

static const char *TAG = "rmt";

/* 通道 → 4 个灯带引脚（#3 硬件分配）。 */
#define RMT_CH0_GPIOS \
    { GPIO_NUM_0, GPIO_NUM_3, GPIO_NUM_4, GPIO_NUM_5 }
#define RMT_CH1_GPIOS \
    { GPIO_NUM_1, GPIO_NUM_6, GPIO_NUM_7, GPIO_NUM_10 }

static const gpio_num_t ch_gpios[2][4] = {
    RMT_CH0_GPIOS,
    RMT_CH1_GPIOS,
};

typedef struct {
    rmt_channel_handle_t ch[2];
    rmt_encoder_handle_t enc;
    rmt_transmit_config_t tx_cfg;
    sched_ctx_t *sched; /* glitch 回加上报目标（可为 NULL） */
    uint8_t ch_idx[2];  /* user_ctx：回调内识别通道号（内部 RAM） */
    volatile uint32_t done_num[2]; /* done 回调记录 num_symbols（ISR 写、任务读） */
} rmt_ctx_t;

static rmt_ctx_t R;

/* core 符号缓冲：每通道每轮一条（1441 符号），静态分配无堆。 */
static ws2812_symbol_t sym_buf[2][SCHED_BUF_SYMBOLS];

/*
 * 回调式编码器（IDF v5.5 官方 rmt_new_simple_encoder）：payload 是
 * core/ws2812 编码好的符号流（rmt_symbol_word_t 位布局兼容），回调
 * 只做 memcpy —— 编码/时序全在 core 层完成并可 host 单测。
 * 回调在 ISR 上下文运行：RMT_ENCODER_FUNC_ATTR 保证放 IRAM
 * （CONFIG_RMT_ENCODER_FUNC_IN_IRAM 时）。
 */
RMT_ENCODER_FUNC_ATTR static size_t sym_copy_cb(const void *data,
                                                size_t data_size,
                                                size_t symbols_written,
                                                size_t symbols_free,
                                                rmt_symbol_word_t *symbols,
                                                bool *done, void *arg)
{
    const rmt_symbol_word_t *src = (const rmt_symbol_word_t *)data;
    size_t total = data_size / sizeof(rmt_symbol_word_t);
    size_t remaining = total - symbols_written;
    size_t n = remaining < symbols_free ? remaining : symbols_free;

    (void)arg;
    if (n > 0u) {
        memcpy(symbols, src + symbols_written, n * sizeof(rmt_symbol_word_t));
    }
    if (symbols_written + n >= total) {
        *done = true;
    }
    return n;
}

static bool IRAM_ATTR on_trans_done(rmt_channel_handle_t ch,
                                    const rmt_tx_done_event_data_t *edata,
                                    void *user_ctx)
{
    uint8_t ch_idx = *(uint8_t *)user_ctx;
    uint32_t num = edata->num_symbols;

    if (R.sched != NULL) {
        sched_note_done(R.sched, num);
    }
    /* 只在 ISR 里记录 num_symbols（不可打印/加锁），
     * 由 led_task 轮次间隙排空并打印。 */
    R.done_num[ch_idx] = num;
    return false;
}

/* led_task 轮次间隙读取并打印（清零）。仅当 num_symbols 与期望不符
 * 时打印（诊断 glitch 用）；正常传输静默。 */
void rmt_dump_done(uint8_t ch_idx)
{
    if (ch_idx >= 2) {
        return;
    }
    uint32_t num = R.done_num[ch_idx];
    R.done_num[ch_idx] = 0;
    if (num != 0u && num != SCHED_EXPECTED_SYMBOLS) {
        ESP_LOGW(TAG, "ch%u done num_symbols=%u (expect %u)",
                 ch_idx, num, SCHED_EXPECTED_SYMBOLS);
    }
}

esp_err_t rmt_driver_init(sched_ctx_t *sched)
{
    esp_err_t err;

    memset(&R, 0, sizeof(R));
    R.sched = sched;

    rmt_tx_channel_config_t ch_cfg = {
        .gpio_num = ch_gpios[0][0],
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 80u * 1000u * 1000u, /* 1 tick = 12.5ns */
        .mem_block_symbols = 48,              /* 双通道对称 48+48，见文件头 */
        .intr_priority = 3,                   /* LOWMED 档最高，创建后不可改 */
        .trans_queue_depth = 2,               /* 每通道 2 个待发事务，配合 tx_wait_all_done */
        .flags.with_dma = false,
        .flags.io_loop_back = false,
        .flags.io_od_mode = false,
    };

    err = rmt_new_tx_channel(&ch_cfg, &R.ch[0]);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ch0 create failed: %s", esp_err_to_name(err));
        return err;
    }
    ch_cfg.gpio_num = ch_gpios[1][0];
    err = rmt_new_tx_channel(&ch_cfg, &R.ch[1]);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ch1 create failed: %s", esp_err_to_name(err));
        return err;
    }

    rmt_simple_encoder_config_t enc_cfg = {
        .callback = sym_copy_cb,
        .arg = NULL,
        .min_chunk_size = 64, /* 每次回调至少写 64 符号（48 符号内存块
                                * 的 ping-pong 节奏下够用） */
    };
    err = rmt_new_simple_encoder(&enc_cfg, &R.enc);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "encoder create failed: %s", esp_err_to_name(err));
        return err;
    }

    rmt_tx_event_callbacks_t cbs = {
        .on_trans_done = on_trans_done,
    };
    for (int i = 0; i < 2; i++) {
        R.ch_idx[i] = (uint8_t)i;
        err = rmt_tx_register_event_callbacks(R.ch[i], &cbs, &R.ch_idx[i]);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "ch%d cbs failed: %s", i, esp_err_to_name(err));
            return err;
        }
        err = rmt_enable(R.ch[i]);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "ch%d enable failed: %s", i, esp_err_to_name(err));
            return err;
        }
    }
    ESP_LOGI(TAG, "RMT ready: 2ch x 48 symbols @80MHz, irq prio 3");
    return ESP_OK;
}

uint8_t rmt_strip_gpio(uint8_t strip)
{
    /* strip 2r/2r+1 → ch0/ch1 的第 r 个引脚。 */
    uint8_t ch = (uint8_t)(strip % 2u);
    uint8_t r = (uint8_t)(strip / 2u);

    if (strip >= SCHED_STRIP_COUNT) {
        return 0xFFu;
    }
    return (uint8_t)ch_gpios[ch][r];
}

ws2812_symbol_t *rmt_strip_symbols(uint8_t strip)
{
    if (strip >= SCHED_STRIP_COUNT) {
        return NULL;
    }
    /* 通道 = strip % 2（与 rmt_strip_gpio / sched_round_strip 一致：
     * 偶数灯带走 ch0、奇数走 ch1）。sym_buf 每通道一个。 */
    return sym_buf[strip % 2u];
}

esp_err_t rmt_transmit_strip(uint8_t channel)
{
    if (channel >= 2) {
        return ESP_ERR_INVALID_ARG;
    }
    /* payload = 符号数组按字节（sym_count × 4）；回调按符号拷贝。
     * 发全部缓冲（含 1 个 EOF 占位符，线上 1.25µs 低电平，无碍）。 */
    esp_err_t err = rmt_transmit(R.ch[channel], R.enc, sym_buf[channel],
                                 SCHED_BUF_SYMBOLS *
                                     sizeof(sym_buf[channel][0]),
                                 &R.tx_cfg);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ch%u transmit err 0x%x", channel, (unsigned)err);
    }
    return err;
}

esp_err_t rmt_wait_round(void)
{
    /* 两通道串行等待（#7 §6）。1.8ms/条，50ms 超时裕量充足；
     * ESP_ERR_TIMEOUT 即 glitch（done 未到，note_done 不会补计）。 */
    esp_err_t e0 = rmt_tx_wait_all_done(R.ch[0], 50);
    esp_err_t e1 = rmt_tx_wait_all_done(R.ch[1], 50);
    if (e0 == ESP_ERR_TIMEOUT) {
        ESP_LOGW(TAG, "round wait ch0 timeout");
        return ESP_ERR_TIMEOUT;
    }
    if (e1 == ESP_ERR_TIMEOUT) {
        ESP_LOGW(TAG, "round wait ch1 timeout");
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}