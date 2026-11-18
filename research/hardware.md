# 硬件约束与引脚分配研究报告

> Ticket #3「硬件约束与引脚分配」
> 项目：ESP32-C3 通过 8 个 GPIO 驱动 8 条 WS2812 灯带（每条 60 颗，共 480 颗），USB 接 PC COM6，同时跑 BLE 与手机小程序通信。
> 本报告基于联网查证与 Espressif 官方文档/源码、FastLED issue、WLED 布线指南等公开资料整理；未在硬件上实测的项统一列在 §6。

---

## 0. 结论摘要（TL;DR）

1. **8 路不能用 8 个独立 RMT 通道**：ESP32-C3 只有 2 个 RMT TX 通道（ch0/ch1），每通道 48 个 32-bit 符号（192 字节），无 DMA。8 路必须时分复用。
2. **推荐 GPIO 分配**：TX0 → GPIO0/3/4/5（灯带 L0/L2/L4/L6），TX1 → GPIO1/6/7/10（灯带 L1/L3/L5/L7）。两个通道并行、4 轮完成 8 路，理论 ~110 fps，工程目标 30–50 fps。
3. **推荐切换机制**：初始化时把一个 TX 通道的输出信号通过 GPIO Matrix 同时连到 4 个 GPIO；运行时只切换 `gpio_output_enable/disable`，不做 GPIO Matrix 重路由。每条数据线加 1kΩ 串阻 + 10kΩ 下拉，防止悬空/幽灵供电。
4. **电平转换**：2× 74AHCT125（8 路），5V 供电、TTL 输入（VIH=2.0V，3.3V 逻辑可直接驱动），输出 5V 满足 WS2812 VIH=3.5V。或 1× 74HCT245（8 路，DIR 接 VCC、OE 接 GND）。
5. **供电**：5V/40A（200W）开关电源起步；8 路各 5A 保险丝；每路首尾注入，1000µF/10V 电容位置；任意像素到注入点 ≤1m；满白 28.8A，软件默认限到 50%（14.4A）。
6. **开发板**：SuperMini 可引出全部 8 个 GPIO、原生 USB CDC，最适合；但必须从 USB 供电，不要把外部 5V 接到板子 5V 引脚（多数克隆板无防反灌二极管）。DevKitM-1 引脚文档最全、有防反灌二极管，适合开发；已 EOL。DevKitC-02 同样可引出全部 8 个 GPIO，但已 EOL、用 USB-to-UART 桥。
7. **协议必须包含**：全局/分路电流上限、亮度上限、帧序号/CRC/重传、热降额、USB 高帧率 + BLE 低帧率分工。默认亮度 50%，100% 需显式解锁；C3 内部温度 >85°C 关闭 LED 输出。

---

## 1. GPIO 分配方案

### 1.1 可用引脚与限制

ESP32-C3 可用 GPIO：**0, 1, 3, 4, 5, 6, 7, 10**，刚好 8 个。

| GPIO | 性质 | 本项目用途 | 备注 |
|---|---|---|---|
| 0 | 安全 | L0 / TX0 默认 | 无 strapping、无 JTAG |
| 1 | 安全 | L1 / TX1 默认 | 无 strapping、无 JTAG |
| 3 | 安全 | L2 | ADC1_CH3，本项目不用 ADC |
| 4 | JTAG MTMS / FSPIHD | L4 | 用作灯带后失去 JTAG |
| 5 | JTAG MTDI / FSPIWP | L6 | 用作灯带后失去 JTAG |
| 6 | JTAG MTCK / FSPICLK | L3 | 用作灯带后失去 JTAG |
| 7 | JTAG MTDO / FSPID | L5 | 用作灯带后失去 JTAG |
| 10 | 安全 / FSPICS0 | L7 | 无 strapping、无 JTAG |
| 2/8/9 | strapping | 不用 | 2 必须高、8 必须高、9 控制 boot |
| 18/19 | USB D-/D+ | 不用 | SuperMini 原生 USB 占用 |
| 20/21 | UART0 | 不用 | 保留给调试/USB 桥 |
| 12–17 | Flash | 不可用 | 模组内部 flash |

**关键取舍**：8 路必须用到 GPIO4–7，因此 **JTAG 调试不可用**。USB 串口/下载仍可工作（SuperMini 走原生 USB Serial/JTAG 的 USB 通道；DevKitM-1 走 USB-to-UART 桥）。生产固件不需要 JTAG；开发阶段如需 JTAG，可先用 4 路安全引脚调试，再切到 8 路接线。

### 1.2 RMT 通道能力（为什么必须时分）

来自 ESP-IDF SoC Capabilities 与 `rmt_tx.c` 源码：

- ESP32-C3 RMT：4 个通道，**ch0/ch1 只能 TX，ch2/ch3 只能 RX**。
- 每通道 **48 个 32-bit 符号**（192 字节），4 通道共 192 个符号。
- **无 DMA**；TX 每 48 个符号产生一次阈值中断，ISR 必须在下一批数据发送完之前补入。
- 48 符号 = 48 bit × 1.25µs = **60µs** 的 refill 窗口。
- 一条 60 颗灯带：60 × 24 = 1440 bit，需要 1440 / 48 = **30 次 ISR 补数据**。
- **不能给 ch0 分配 96 个符号**：C3 的 RMT 内存块是连续分配的，ch0 占 96 个会连带占用 ch1 的内存，导致 ch1 无法创建（Espressif 在 FastLED issue #473 中确认过）。

因此 8 路必须 2 个 TX 通道时分复用。

### 1.3 GPIO → 灯带映射表（推荐）

把 8 路分成两组，每组 4 路由一个 TX 通道轮流驱动；两个通道并行，4 轮完成一帧。

| 灯带 | 数据 GPIO | RMT 通道 | 轮次 | 电平转换器 | 引脚性质 | 备注 |
|---|---|---|---|---|---|---|
| L0 | GPIO0 | TX0 | 0 | U1 通道 1 | 安全 | TX0 默认引脚 |
| L1 | GPIO1 | TX1 | 0 | U2 通道 1 | 安全 | TX1 默认引脚 |
| L2 | GPIO3 | TX0 | 1 | U1 通道 2 | 安全 | |
| L3 | GPIO6 | TX1 | 1 | U2 通道 2 | JTAG MTCK | 失去 JTAG |
| L4 | GPIO4 | TX0 | 2 | U1 通道 3 | JTAG MTMS | 失去 JTAG |
| L5 | GPIO7 | TX1 | 2 | U2 通道 3 | JTAG MTDO | 失去 JTAG |
| L6 | GPIO5 | TX0 | 3 | U1 通道 4 | JTAG MTDI | 失去 JTAG |
| L7 | GPIO10 | TX1 | 3 | U2 通道 4 | 安全 | |

说明：

- 每个 RMT 通道对应一片 74AHCT125（4 通道），两片共 8 路。TX0 的 4 个 GPIO 全部接 U1，TX1 的 4 个 GPIO 全部接 U2，布线最整齐。
- 轮次 0 的 L0/L1 使用最安全的 GPIO0/1，也是上电默认引脚。
- 若必须保留 JTAG，只能用 GPIO0/1/3/10 四个安全引脚，最多驱动 4 路；8 路必须牺牲 JTAG。这是 C3 的硬约束。

### 1.4 切换机制（推荐：一信号多引脚 + 输出使能）

**核心思想：不要在每个灯带之间重新配置 GPIO Matrix，而是在初始化时把一个 TX 通道的输出信号同时连到 4 个 GPIO，运行时只切换输出使能。**

#### 初始化（以 TX0 为例，TX1 同理）

```c
#include "driver/gpio.h"
#include "driver/rmt_tx.h"
#include "esp_rom_gpio.h"
#include "soc/rmt_periph.h"

#define RMT_RES_HZ      10000000   // 10MHz, 1 tick = 100ns
#define RMT_MEM_SYMBOLS 48
#define LEDS_PER_STRIP  60
#define SYMBOLS_PER_LED 24

static rmt_channel_handle_t tx[2];
static rmt_encoder_handle_t copy_encoder;

static const uint8_t tx_pins[2][4] = {
    {0, 3, 4, 5},   // TX0 -> L0, L2, L4, L6
    {1, 6, 7, 10},  // TX1 -> L1, L3, L5, L7
};

static void rmt_init_one(int ch, uint8_t default_pin) {
    rmt_tx_channel_config_t cfg = {
        .gpio_num          = default_pin,
        .clk_src           = RMT_CLK_SRC_APB,
        .resolution_hz     = RMT_RES_HZ,
        .mem_block_symbols = RMT_MEM_SYMBOLS,
        .trans_queue_depth = 4,
        .flags.with_dma    = false,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&cfg, &tx[ch]));

    // 把该通道的 TX 信号同时连到 4 个 GPIO
    int sig = rmt_periph_signals.groups[0].channels[ch].tx_sig;  // ch0/ch1 是 TX
    for (int i = 0; i < 4; i++) {
        int pin = tx_pins[ch][i];
        gpio_func_sel(pin, PIN_FUNC_GPIO);
        esp_rom_gpio_connect_out_signal(pin, sig, 0, false);
        gpio_output_enable(pin);
        if (i > 0) gpio_output_disable(pin);   // 只使能默认引脚
    }

    rmt_enable(tx[ch]);
}
```

#### 运行时切换

```c
static void select_pin(int ch, int round) {
    for (int i = 0; i < 4; i++) {
        int pin = tx_pins[ch][i];
        if (i == round) gpio_output_enable(pin);
        else            gpio_output_disable(pin);
    }
}
```

#### 发送一帧

```c
void show_frame(const rmt_symbol_word_t *symbols[8]) {
    for (int round = 0; round < 4; round++) {
        // 等两个通道都空闲；切换只发生在空闲低电平期间
        rmt_tx_wait_all_done(tx[0], 100);
        rmt_tx_wait_all_done(tx[1], 100);

        select_pin(0, round);
        select_pin(1, round);

        rmt_transmit_config_t tcfg = {
            .flags.queue_nonblocking = true,
        };
        rmt_transmit(tx[0], copy_encoder,
                     symbols[round * 2 + 0],
                     LEDS_PER_STRIP * SYMBOLS_PER_LED * sizeof(rmt_symbol_word_t),
                     &tcfg);
        rmt_transmit(tx[1], copy_encoder,
                     symbols[round * 2 + 1],
                     LEDS_PER_STRIP * SYMBOLS_PER_LED * sizeof(rmt_symbol_word_t),
                     &tcfg);
    }
}
```

#### 为什么可行

- `esp_rom_gpio_connect_out_signal` 是 GPIO Matrix 的标准 API；同一个 peripheral 输出信号可以连到多个 GPIO，每个 GPIO 有自己的输出选择寄存器。
- `gpio_output_enable/disable` 只改输出使能位，不改 IOMUX 和输出信号路由。关闭的引脚变成高阻，由 10kΩ 下拉保持低电平。
- 切换只发生在上一轮发送完成后的空闲低电平期间，不会截断波形。
- 不需要 `rmt_set_gpio()`，也不需要在运行时删除/重建 RMT 通道，避免了 FastLED 在 RMT5 上放弃 worker pool 时遇到的“GPIO 悬空导致瞬态高电平”问题（见 §1.6）。

#### IDF 版本差异

| IDF 版本 | 机制 | 说明 |
|---|---|---|
| v4.4 | `rmt_set_gpio(ch, RMT_MODE_TX, gpio, invert)` | 运行时改 GPIO Matrix 输出路由；**不会自动关闭旧引脚输出**，需手动 `gpio_output_disable(old)` 或 `gpio_matrix_out(old, SIG_GPIO_OUT_IDX, 0, false)` |
| v5.x | 无公开 `rmt_set_gpio()`；`rmt_new_tx_channel()` 在创建时调用 `esp_rom_gpio_connect_out_signal()` | 推荐用上面的“一信号多引脚 + 输出使能”；或手动 `esp_rom_gpio_connect_out_signal(new, sig, 0, false)` + `gpio_output_disable(old)`；删除/重建通道开销大，不推荐 |
| FastLED RMT4 | worker pool，支持超过硬件通道数的灯带 | 需要 IDF v4.4 |
| FastLED RMT5 | 无 worker pool，C3 上只能 2 路 | 若用 FastLED，建议 IDF v4.4 + RMT4，或自写时分驱动 |

### 1.5 时序预算

| 项目 | 数值 |
|---|---|
| 每颗 WS2812 数据 | 24 bit × 1.25µs = 30µs |
| 每条 60 颗数据时间 | 60 × 30µs = 1.8ms |
| 每条复位时间（EOF 低电平） | ≥50µs（datasheet），建议 280–300µs |
| 每轮 2 路并行 | 1.8ms + 0.3ms = 2.1ms |
| 4 轮 | 8.4ms |
| RMT ISR 补数据开销 | 4 轮 × 2 通道 × 30 次 × ~2–5µs ≈ 0.5–1.2ms |
| **合计** | **~9–9.6ms → 104–111 fps（理论）** |
| **工程目标** | **30–50 fps**（给 BLE/Wi-Fi 中断留余量） |

注意：

- 48 符号 = 60µs，ISR 必须每 60µs 补一次。BLE/Wi-Fi 中断可能阻塞超过 60µs，导致 RMT underrun 和 LED 误码。这是 C3 单核 + 无 DMA 的最大风险。
- 降低帧率到 30fps（33ms/帧）可以让 BLE 有足够时间；但 RMT 的 60µs 补数据窗口仍然存在，和帧率无关。关键是提高 RMT ISR 优先级、缩短 ISR、以及在 BLE 事件高发时降低数据刷新频率。
- 如果 BLE 干扰严重，考虑把 BLE 连接间隔调大（如 50–100ms），或把高帧率数据只走 USB，BLE 只发控制命令。

### 1.6 已知问题与对策

| 问题 | 来源 | 对策 |
|---|---|---|
| RMT 通道删除后 GPIO 悬空，产生瞬态高电平，触发首颗 LED 误码 | FastLED issue #473（RMT5 worker pool 被放弃的原因） | 每条数据线加 10kΩ 下拉；不要热删除 RMT 通道；切换时用输出使能而不是删除/重建 |
| IDF v4 `rmt_set_gpio` 只改新引脚，旧引脚仍可能输出 | ESP32 论坛 t=5462 | 手动关闭旧引脚输出；或改用“一信号多引脚”方案 |
| C3 上给 ch0 分配 96 个符号会导致 ch1 无法分配 | Espressif 在 issue #473 的回复 | 每个通道固定 48 个符号；不要尝试 96 |
| BLE/Wi-Fi 中断优先级高于 RMT，导致 refill 超时 | issue #473、FastLED 文档 | 提高 RMT ISR 优先级；双缓冲；降低帧率；必要时用 SPI DMA 驱动 1 路（见 §1.7） |
| FastLED RMT5 在 C3 上只能 2 路 | FastLED 文档、issue #473 | 用 IDF v4.4 + RMT4，或自写时分驱动 |

### 1.7 备选方案

**方案 B：IDF v4.4 + `rmt_set_gpio()` 逐路切换**

- 每路发送前调用 `rmt_set_gpio(ch, RMT_MODE_TX, next_gpio, false)`，然后 `gpio_output_disable(old_gpio)`。
- 优点：代码简单，每路一个通道配置。
- 缺点：运行时改 GPIO Matrix，开销略大；旧引脚必须手动关闭；FastLED 经验表明容易留下悬空引脚。

**方案 C：外部 74HCT238 + 74HCT08 解码器**

- 2 个 RMT 通道各接一个 74HCT238（3-to-8 译码器，输出高电平有效），每路输出接一个 74HCT08 与门的一个输入，RMT 数据接所有与门的另一个输入。与门输出直接是 5V 数据（74HCT08 用 5V 供电，TTL 输入，3.3V 可直接驱动）。
- 需要 6 个 GPIO 做 2 个 3 位选择（2 个通道各 3 位），加 2 个 RMT 数据 GPIO，共 8 个。芯片：2× 74HCT238 + 4× 74HCT08（每个与门 4 路，2 个通道共 16 路，需要 4 片）。
- 优点：不需要运行时改 GPIO Matrix；输出天生 5V；切换只是 6 个 GPIO 写电平。
- 缺点：芯片多（6 片），PCB 面积大；译码器 + 与门的传播延迟（~10–20ns）远小于 1.25µs 位周期，理论上没问题，但需实测边沿质量。
- 适用：如果 RMT GPIO 切换在目标 IDF 版本上不稳定，这是可靠的硬件后备。

**方案 D：ESP32-S3 或 ESP32-P4**

- S3 有 4 个 TX 通道，P4 有 PARLIO/LCD 等并行外设，可以直接 8 路并行，不需要时分。
- 如果 8 路高帧率是硬需求，换芯片比在 C3 上折腾更省事。但本项目的 BOM/功耗/成本约束可能不允许。

---

## 2. 电平转换电路设计

### 2.1 为什么必须转换

- C3 GPIO 高电平 3.3V。
- WS2812B 数据输入 VIH = 0.7 × VDD = 0.7 × 5V = **3.5V**（datasheet）。
- 3.3V < 3.5V，短线可能“碰巧”工作，长线/低温/电池供电下不可靠。
- 必须用 5V 供电的 TTL 输入缓冲器把 3.3V 逻辑转成 5V 逻辑。

### 2.2 选型对比

| 参数 | 74AHCT125 | 74HCT125 | 74HCT245 |
|---|---|---|---|
| 通道数 | 4 | 4 | 8 |
| 8 路所需芯片 | 2 | 2 | 1 |
| 输入 VIH（VCC=5V） | 2.0V | 2.0V | 2.0V |
| 3.3V 逻辑能否直接驱动 | 能（3.3V > 2.0V） | 能 | 能 |
| 输出高电平 | ~5V | ~5V | ~5V |
| 每通道独立 OE | 有（低有效） | 有（低有效） | 无（全局 OE） |
| 方向控制 | 无 | 无 | 有（DIR） |
| 传播延迟 | ~5ns | ~20ns | ~10–20ns |
| 边沿速率 | 快 | 较慢 | 中等 |
| 未使用输入处理 | 接 GND 或 VCC | 接 GND 或 VCC | A unused 接 GND，B unused 悬空 |
| 幽灵供电风险 | 有输入钳位二极管 | 有 | 有 |
| 推荐度 | ★★★★★ | ★★★★ | ★★★★ |

**推荐：2× 74AHCT125**

- 每个通道独立 OE，布线灵活；8 路刚好两片。
- 5V 供电，TTL 输入，3.3V 逻辑直接驱动。
- 输出 5V，满足 WS2812 VIH=3.5V。
- 价格低、供货稳定。

**备选：1× 74HCT245**

- 8 路一片，省面积。
- DIR 必须接 VCC（A→B），OE 接 GND。
- A 侧（输入）接 C3，B 侧（输出）接灯带。
- 未使用的 A/B 引脚：A unused 接 GND，B unused 悬空。
- 注意：如果 5V 电源断开而 C3 仍供电，3.3V 输入会通过输入钳位二极管给芯片“幽灵供电”，输出可能浮到 ~2.6V。解决：1kΩ 串阻 + 10kΩ 下拉，或保证 5V 先上电。

### 2.3 每路接法

每路数据通道：

```text
C3 GPIO ──[1kΩ]──┬── 74AHCT125 输入 (A)
                  │
                 [10kΩ]
                  │
                 GND

74AHCT125 输出 (Y) ──[300–500Ω]── 灯带 DIN
74AHCT125 VCC ── 5V（外部 PSU）
74AHCT125 GND ── GND（与 C3 共地）
74AHCT125 nOE ── GND（使能）
```

元件说明：

- **1kΩ 串阻**：限制 5V 未上电时输入钳位二极管的电流；抑制振铃；与 10kΩ 下拉一起把悬空输入拉到 0V。
- **10kΩ 下拉**：C3 引脚高阻时（复位、切换输出使能、RMT 删除后）保持 74AHCT125 输入为低，避免随机高电平触发首颗 LED。
- **300–500Ω 串阻**：在灯带 DIN 处抑制反射/振铃；300Ω 用于长线，500Ω 用于短线。不要太大，否则边沿变缓导致误码。
- **100nF 去耦**：每片 74AHCT125 的 VCC–GND 之间放一个 100nF 陶瓷电容，尽量靠近芯片。
- **10µF 体电容**：在 5V 进入电平转换板处放一个 10µF 电解/钽电容。
- **1A 保险丝**：5V 进入电平转换板的支路加 1A 保险丝，防止短路烧板。

### 2.4 布局建议

- 两片 74AHCT125 放在 C3 板旁边，5V/GND 用短而粗的走线。
- 8 路数据线从芯片出发后远离 5V/GND 大电流走线，避免串扰。
- 4 层板：完整 GND 平面；5V 用 1–2mm 宽走线或铜皮。
- 每片芯片的 100nF 去耦电容紧贴 VCC 引脚。
- 1k/10k/300–500Ω 电阻用 0603 或 0805，靠近对应引脚。
- 如果 C3 板和电平转换板分开，数据线用排线/双绞；5V/GND 用独立粗线，不要和信号线共用细线。

### 2.5 上电时序与幽灵供电

- **必须先给灯带/电平转换上 5V，再给 C3 上 USB/3.3V**。否则 5V 未上电时，C3 的 3.3V 高电平会通过 74AHCT125 的输入钳位二极管给 5V 侧“幽灵供电”，可能导致输出乱跳、灯带闪烁，甚至拉高 5V 轨。
- 1kΩ 串阻 + 10kΩ 下拉可以把幽灵供电电流限制在 ~2.6mA，并让输出保持低电平。
- 如果无法保证上电顺序，可在 5V 与电平转换板之间加一个 P-MOSFET 负载开关，由 C3 控制；但 C3 上电前 GPIO 不确定，不如机械/继电器顺序可靠。
- SuperMini 的 5V 引脚与 USB VBUS 直连（多数克隆板无二极管），**不要把外部 5V 接到板子的 5V 引脚**；只从 USB 给板子供电，外部 5V 只给电平转换器和灯带供电，两者共地即可。

---

## 3. 供电拓扑方案

### 3.1 负载计算

| 项目 | 数值 |
|---|---|
| 每颗 WS2812 满白电流 | 60mA（R+G+B 各 20mA） |
| 每条 60 颗 | 3.6A |
| 8 条 | 28.8A |
| 满白功率 | 28.8A × 5V = 144W |
| 推荐 PSU | 5V/40A（200W），留 28% 余量 |
| 最低 PSU | 5V/30A（150W），100% 白时无余量，不推荐 |

推荐型号：Mean Well LRS-200-5（5V, 40A, 200W）或同等规格。LRS-150-5（5V, 30A）只在软件限到 ≤50% 亮度时可用。

### 3.2 拓扑：星形 + 首尾注入

```text
PSU 5V (+) ──┬── 30A 主保险丝 ──┬── 5V 母线（10AWG）
              │                   ├── 5A 保险丝 ── L0 起点 + 终点
              │                   ├── 5A 保险丝 ── L1 起点 + 终点
              │                   ├── ...
              │                   └── 5A 保险丝 ── L7 起点 + 终点
              │
PSU GND (-) ─┴── 30A 主保险丝 ──┬── GND 母线（10AWG）
                                  ├── L0 起点 + 终点
                                  ├── ...
                                  └── L7 起点 + 终点
```

要点：

- **不要沿灯带 daisy-chain 5V/GND**。灯带 PCB 铜箔很薄，3.6A 电流会让远端压降 0.5–1V，导致远端变暗、变色甚至复位。
- **每条灯带首尾各注入一次**：起点和终点各接一对 5V/GND 线。60 颗灯带（1–2m）任意像素到注入点 ≤1m。
- **星形/母线**：从 PSU 端子用 10AWG 主线拉到一条 5V 母线和一条 GND 母线，再从母线分 8 路 16AWG 到每条灯带的首尾。母线要短、粗、低电阻。
- **共地**：PSU GND、C3 GND、电平转换器 GND、所有灯带 GND 必须连在一起，且尽量在 PSU 端子处单点汇合，避免地环路。
- **保险丝**：每路 5V 正极加 5A 慢熔保险丝，尽量靠近 PSU；主 5V 加 30A 保险丝；C3/电平转换支路加 1A 保险丝。
- **线径**：
  - 主母线：10AWG（承载 28.8A）。
  - 每路注入线：16AWG（承载 3.6A，短距离）；如果超过 1m，用 14–15AWG。
  - GND 线同样线径；不要细于 18AWG。
- **连接器**：用 ferrule（冷压端子套管）压接多股软线，防止散股；螺丝端子要拧紧；大电流接头用 XT60/XT90 或安德森连接器，不要用杜邦线。

### 3.3 电容位置

每条灯带：

- **起点**：1000µF / 10V（或 16V）低 ESR 电解电容，跨接 5V–GND，尽量靠近灯带 5V/GND 焊盘；再并一个 100nF 陶瓷电容。
- **终点**：如果再注入，终点也放 470–1000µF；如果只起点注入，终点可不放，但建议 100nF。
- **每条灯带一个 1000µF**，8 条共 8000µF。上电瞬间 PSU 要给 8000µF 充电，浪涌电流可能达到几十安培。如果 PSU 过流保护敏感，加 NTC 热敏电阻或软启动模块。
- 电容耐压：5V 轨用 10V 或 16V，不要用 6.3V（余量太小）。
- 电容极性：电解电容负极接 GND，正极接 5V；装反会炸。

### 3.4 压降补偿

- 目标：任意 LED 的 5V 引脚电压 ≥4.5V（低于 4.5V 会明显变暗/变色）。
- 满白时测量首/中/尾电压：
  - 首端应 ≈ PSU 输出电压（5.0–5.2V）。
  - 末端与首端差 ≤0.3V 为佳；≤0.5V 可接受。
  - 如果 >0.5V，增加注入点或加粗线。
- PSU 输出电压可微调到 5.1–5.2V 补偿压降，但**不要超过 5.5V**（WS2812 绝对最大值）。
- 如果灯带超过 2m（>120 颗），中间加注入点；60 颗以内首尾足够。
- 数据线不要和电源线捆在一起；如果必须并行，用双绞或屏蔽线，且距离 >5cm。

### 3.5 保护与上电顺序

- **上电顺序**：先开 5V PSU → 等 5V 稳定（灯带/电平转换器上电）→ 再插 USB 给 C3 供电 → C3 启动后通过握手确认 5V 正常。
- **断电顺序**：先拔 USB（C3 断电，GPIO 高阻）→ 再关 5V PSU。或者一起关，但不要先关 5V 再拔 USB（可能导致 C3 的 GPIO 通过电平转换器钳位二极管给 5V 侧供电）。
- **过流**：软件限流为主，保险丝为辅。保险丝只防火灾，不防 LED 过流损坏。
- **过热**：PSU 本身有过温保护；C3 内部温度传感器用于降额；灯带没有温度传感器，靠通风和亮度限制。
- **浪涌**：8×1000µF 上电浪涌可能触发 PSU 过流。对策：选带软启动的 PSU；或加 NTC；或分路缓慢上电（用 MOSFET + RC 延时）。

---

## 4. 开发板选型建议

### 4.1 三款板对比

| 项目 | SuperMini | DevKitM-1 | DevKitC-02 |
|---|---|---|---|
| 8 个 GPIO 是否全部引出 | 是（GPIO0–10, 20, 21；克隆板需核对丝印） | 是（官方文档明确） | 是（官方文档明确） |
| 原生 USB Serial/JTAG | 是（GPIO18/19 接 USB-C） | 否（GPIO18/19 引出但无 USB 座） | 否（GPIO18/19 引出但无 USB 座） |
| USB-to-UART 桥 | 无（原生 USB） | 有（3Mbps） | 有（3Mbps） |
| 5V 引脚防反灌 | 多数克隆板无二极管，5V 与 VBUS 直连 | 有二极管 | 有二极管 |
| 板载 LDO | SOT-23-5，~150mA | 500mA+ | 500mA+ |
| 尺寸 | 22.5×18mm | 较大 | 较大 |
| 价格 | ~$2–3 | ~$4.5 | ~$5–8 |
| 文档 | 社区/第三方 | 官方完整 | 官方完整 |
| 状态 | 在售 | EOL | EOL |
| 适合 | 本项目首选（低成本、原生 USB） | 开发调试 | 开发调试 |

### 4.2 推荐

**首选：ESP32-C3 SuperMini**

- 能引出全部 8 个 GPIO。
- 原生 USB Serial/JTAG，PC 识别为 COM 口，吞吐远高于 3Mbps UART 桥；高帧率流式传输更轻松。
- 最小、最便宜、最容易买到。
- **必须注意**：
  1. **只用 USB 给板子供电**，不要把外部 5V 接到板子的 5V 引脚。外部 5V 只给电平转换器和灯带；两者共 GND。
  2. 克隆板丝印可能错，逐个用万用表/二极管档核对 GPIO0/1/3/4/5/6/7/10。
  3. 板载 LDO 只供 C3，不要从 3V3 引脚取电流给传感器/灯带。
  4. 板载蓝色 LED 在 GPIO8，BOOT 在 GPIO9，我们不使用，但丝印要避开。

**备选：ESP32-C3-DevKitM-1**

- 官方文档完整，引脚引出明确，5V 有防反灌二极管。
- USB-to-UART 桥 3Mbps：1440 字节/帧约 3.84ms，50fps 时占 19% 带宽，够用；100fps 时占 38%，仍可行。
- 已 EOL，但库存多、价格低，适合开发阶段。
- 注意：它没有原生 USB，必须用 USB-to-UART 桥；GPIO18/19 虽然引出，但没有 USB 座，不能直接插线。

**备选：ESP32-C3-DevKitC-02**

- 官方文档完整，引脚引出明确。
- 已 EOL；USB-to-UART 桥，和 M-1 类似。
- 如果你需要两个 USB 口或特定排针布局，可以选它；否则优先 SuperMini 或 M-1。

**不推荐**：任何没有引出 GPIO4–7 的板子（部分 SuperMini 批次、XIAO ESP32-C3 等）。XIAO 只有 11 个引脚，无法引出全部 8 个目标 GPIO。

### 4.3 开发板与电平转换板的连接

- C3 板：USB 供电；GPIO0/1/3/4/5/6/7/10 用杜邦线/排线连到电平转换板。
- 电平转换板：外部 5V 供电；GND 与 C3 共地；8 路输出到灯带。
- 5V 和 GND 用独立粗线；信号线用排线。
- 如果 C3 板和电平转换板距离 >20cm，信号线用双绞或屏蔽，避免 EMI。

---

## 5. 对协议设计的约束

### 5.1 亮度与电流上限

**硬约束**：

- 满白 28.8A，PSU 30A 无余量；必须软件限流。
- 每条灯带 3.6A，8 条同时满白才可能到 28.8A；实际动画很少全白。
- C3 无法测量 5V 电流（没有 ADC 引脚/电流传感器），只能按 RGB 值估算。

**协议字段**：

- `global_brightness`（0–255）：全局亮度，默认 128（50%）。
- `power_limit_ma`（0–30000）：全局电流预算，默认 15000（15A），最大 30000。
- `per_strip_limit_ma`（0–3600）：每条灯带电流预算，默认 3600。
- `strip_mask`（8 bit）：启用的灯带；未启用的灯带不输出，省电。

**MCU 行为**：

- 收到帧后，先应用 `global_brightness`，再估算电流：

```c
uint32_t estimate_ma(const uint8_t *rgb, int n) {
    uint32_t ma = 0;
    for (int i = 0; i < n; i++) {
        ma += (rgb[i*3+0] + rgb[i*3+1] + rgb[i*3+2]) * 20 / 255;
    }
    return ma;  // 每通道 20mA，满白 60mA
}
```

- 如果总电流 > `power_limit_ma`，按比例缩放所有通道。
- 如果单条灯带电流 > `per_strip_limit_ma`，只缩放该条。
- 缩放用整数运算，避免浮点；可以用 8 位查表加速。
- **100% 亮度（255）必须显式解锁**：例如协议命令 `unlock_full_power=1` 才允许 `global_brightness=255` 且 `power_limit_ma>=28000`。默认永远 50%。

**效果**：

- 默认 50%：~14.4A，200W PSU 轻松。
- 节能模式 30%：~8.6A。
- 满白 100%：28.8A，需要 200W PSU 和良好散热。
- 单条灯带满白：3.6A，5A 保险丝。

### 5.2 分路限流与保险丝

- 每条灯带独立 5A 保险丝；软件 `per_strip_limit_ma` 默认 3600。
- 如果某条灯带内容特别亮（如全白），MCU 只缩放该条，不影响其他条。
- 协议可以包含 `strip_power_report[8]`：每条灯带的估算电流，PC 可显示。
- 如果 MCU 检测到某条灯带的 RMT 错误计数异常升高（可能是短路/接触不良），可以自动关闭该条并上报 `strip_fault[8]`。

### 5.3 温度保护

- C3 内部温度传感器：`temperature_sensor_t`，精度约 ±1–2°C，范围 -40–125°C。
- 每 1s 读取一次：
  - `<70°C`：正常。
  - `70–85°C`：警告，全局亮度降到 50%，协议上报 `thermal_status=warning`。
  - `>85°C`：关闭 LED 输出，协议上报 `thermal_status=shutdown`，等待温度降下来。
  - `>100°C`：蜂鸣/日志，必要时重启。
- C3 的 die temperature 不是灯带温度，但可以作为环境温度的粗略代理。灯带本身没有温度传感器（没有空闲 GPIO），只能靠 PSU 过温保护和通风。
- 如果必须测灯带温度，需要额外 MCU/传感器，或者使用带温度输出的智能灯带（如 WS2812 不带回传）。本项目不推荐。

### 5.4 帧率与 BLE 共存

- **USB 高帧率，BLE 低帧率**：
  - USB CDC/UART：流式全帧，30–50fps。
  - BLE：只发控制命令（颜色、亮度、模式、效果参数）和低频更新（≤10fps）；不要通过 BLE 发全帧。
  - BLE 带宽约 10–30KB/s，1440 字节全帧需要 50–150ms，无法支撑高帧率。
- **帧协议**：

```text
0xAA 0x55 | seq (2B) | strip_mask (1B) | len (2B) | payload (N×3B) | crc16 (2B)
```

  - `seq`：帧序号，递增；MCU 检测到跳号则 `drop_count++`。
  - `strip_mask`：8 位，选择更新的灯带；未选中的灯带保持上一帧。
  - `len`：LED 数量（1–480）。
  - `payload`：RGB 或 GRB，3 字节/颗。
  - `crc16`：CRC-CCITT，覆盖 header + payload。

- **ACK/NAK**：
  - MCU 校验 CRC 和 seq；正确则 `ACK(seq)`，错误则 `NAK(seq, error)`。
  - PC 收到 NAK 可重发；收到 ACK 可继续。
  - MCU 周期发送 `STATUS`：`seq | drop_count | glitch_count | temp | current_ma_est | thermal_status`。

- **双缓冲**：
  - 接收缓冲（PC/BLE 写）和发送缓冲（RMT 读）分离。
  - 帧队列深度 2–3；队列满时丢弃最旧帧，保留最新帧。
  - 不要在 RMT 发送过程中修改发送缓冲。

- **BLE 连接参数**：
  - 连接间隔 30–50ms；从设备延迟 0–4；MTU 协商到 247。
  - 如果 BLE 吞吐不足，降低 BLE 更新频率，增加 USB 优先级。

- **RMT glitch 检测**：
  - RMT 驱动有 TX 错误中断/计数；MCU 可以统计 `glitch_count`。
  - 如果 `glitch_count` 快速增长，降低帧率或暂停 BLE 广播/连接。
  - WS2812 没有回传通道，MCU 无法直接知道哪颗 LED 误码；只能靠 RMT 错误计数和用户反馈。

### 5.5 上电握手

- MCU 启动后：
  1. 配置 GPIO 为输出低（或输入下拉）。
  2. 初始化 RMT、电平转换器。
  3. 发送 `HELLO`：固件版本、LED 数量、最大电流、温度。
  4. 等待 PC 的 `CONFIG`：亮度、电流上限、灯带 mask、帧率。
  5. 收到 `CONFIG` 后开始接收帧。
- PC 收到 `HELLO` 后才开始发帧；避免 5V 未稳定时驱动灯带。
- 如果 PC 没发 `CONFIG`，MCU 保持灯带关闭，只响应 `PING`。

### 5.6 数据完整性

- 帧头 `0xAA 0x55`，长度，CRC16。
- MCU 校验失败：丢弃，`drop_count++`，回 `NAK`。
- PC 超时未收到 `ACK`：重发，最多 3 次；超过则报错。
- 对于动画/渐变，丢一帧通常不明显；对于静态文字/图片，PC 应定期重发。
- 数据线：300–500Ω 串阻 + 10kΩ 下拉；远离电源线；必要时屏蔽。
- 如果误码率高，降低帧率（增加每帧间隔）或降低数据传输速率（如 400kbps WS2812？不推荐，WS2812 是 800kbps）。

### 5.7 协议与硬件的对应关系

| 硬件约束 | 协议对策 |
|---|---|
| 2 个 RMT 通道，8 路时分 | 帧序号、分路 mask、MCU 内部 4 轮调度 |
| 60µs RMT refill 窗口，BLE 中断可能阻塞 | 低帧率、USB 优先、BLE 只发命令、`glitch_count` 上报 |
| 28.8A 满白，PSU 30A | 全局亮度/电流上限、默认 50%、满白需解锁 |
| 每路 3.6A | 分路电流上限、5A 保险丝、`strip_fault` |
| 无空闲 GPIO 接传感器 | 只用 C3 内部温度传感器；温度降额；不开环外部检测 |
| 5V 上电顺序 | `HELLO`/`CONFIG` 握手；先 5V 后 USB |
| 数据线长、电平转换 | CRC、ACK/NAK、串阻/下拉、屏蔽 |
| JTAG 被占用 | 用串口日志/USB 下载；生产固件不需要 JTAG |

---

## 6. 未查到/需实测的项

1. **“一信号多引脚 + 输出使能”在目标 IDF 版本上的可靠性**：GPIO Matrix 允许多个 GPIO 选择同一个 peripheral 输出信号，但官方文档没有把它作为“推荐用法”明确写出来。需要在 IDF v4.4 和 v5.x 上分别实测：切换时是否有毛刺、旧引脚是否真的高阻、重新使能后波形是否正确。
2. **BLE 中断对 RMT refill 的影响**：C3 单核，BLE 协议栈中断可能阻塞 >60µs。需要实测：BLE 连接间隔 30/50/100ms、广播间隔、手机 MTU 大小对 LED 误码率（`glitch_count`）的影响。建议用逻辑分析仪抓 RMT 波形和 BLE 事件时间戳。
3. **74AHCT125 + 300–500Ω + 灯带输入电容的边沿质量**：需要示波器测量 8 路输出在 5V、空载/带灯带时的上升时间、过冲、振铃；确认首颗 LED 不误码。特别是 500Ω 是否太大导致边沿变缓。
4. **SuperMini 克隆板的 5V 引脚是否有防反灌二极管**：用万用表二极管档测 5V 引脚与 USB VBUS 之间的压降；如果有 ~0.3–0.7V 压降，说明有二极管；如果 0Ω，说明直连。不同批次可能不同。
5. **SuperMini 各批次的 GPIO4–7 是否真的引出**：逐板核对丝印和排针；有些克隆板可能把 GPIO4–7 用于内部 flash 或没有引出。
6. **30A PSU 在 8×1000µF 同时充电时的浪涌**：用示波器/电流探头测上电瞬间电流；如果超过 PSU 过流点，加 NTC 或软启动。也可以先只接 2–3 条灯带上电，再逐步接入。
7. **满白时的实际压降**：在每条灯带首/中/尾测量 5V 电压；确认 ≥4.5V。如果低于 4.5V，增加注入点或加粗线。
8. **C3 内部温度传感器的精度和响应**：与外部温度计对比；确认 70/85°C 阈值是否合适。C3 的 die temperature 可能比环境温度高 10–20°C，阈值要留余量。
9. **30A 持续电流下的连接器/端子发热**：用热像仪或热电偶测量端子、保险丝座、接线端子；确认 <60°C。大电流接头要拧紧，必要时用铜排。
10. **数据线长度限制**：测试 0.5m/1m/2m 非屏蔽线在 8 路同时传输时的误码率；如果 >1m 误码，改用双绞/屏蔽或加接收端上拉/下拉。
11. **74HCT245 替代方案的 DIR/OE 接法**：实测 DIR=VCC、OE=GND 时 A→B 方向是否正确；未使用的 B 引脚是否要接下拉；5V 未上电时的幽灵供电电流。
12. **外部 74HCT238 + 74HCT08 方案（备选）的传播延迟**：实测译码器 + 与门的边沿延迟是否会计入 WS2812 的 T0H/T1H；74HCT 系列 ~10–20ns，理论远小于 1.25µs，但要看实际波形。
13. **RMT 通道的实际信号编号**：`rmt_periph_signals.groups[0].channels[ch].tx_sig` 在不同 IDF 版本/芯片上的值；需要在目标 IDF 的 `soc/rmt_periph.h` 中确认。
14. **FreeRTOS 任务优先级与 RMT ISR 优先级**：C3 的 RMT ISR 默认优先级是否足够；BLE 协议栈的任务优先级是否会抢占 LED 任务；需要实测 `glitch_count` 和 CPU 占用率。
15. **灯带的实际电流**：不同厂家 WS2812B 的满白电流可能 50–70mA/颗；用 60mA 估算可能偏低。建议实测一条灯带的满白电流，校准软件限流系数。

---

## 7. 参考来源

- ESP-IDF RMT 文档（v5.5.5）：https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32c3/api-reference/peripherals/rmt.html
- ESP-IDF v4.4 RMT 文档：https://docs.espressif.com/projects/esp-idf/en/v4.4.8/esp32c3/api-reference/peripherals/rmt.html
- ESP32-C3 SoC Capabilities：`SOC_RMT_CHANNELS_PER_GROUP=4`，`SOC_RMT_MEM_WORDS_PER_CHANNEL=48`
- ESP-IDF `rmt_tx.c` 源码（v5.5.5）：https://github.com/espressif/esp-idf/blob/v5.5.5/components/soc/esp32c3/include/soc/soc_caps.h
- ESP-IDF v4.4 `rmt.c` 源码（`rmt_set_gpio`）：https://github.com/espressif/esp-idf/blob/v4.4.8/components/driver/rmt.c
- ESP32 论坛：Using rmt_set_pin to change the pin bound to an RMT channel：https://esp32.com/viewtopic.php?t=5462
- FastLED issue #473（RMT5 worker pool 放弃、GPIO 悬空导致瞬态高电平、C3 2 TX 通道限制）：https://github.com/espressif/idf-extra-components/issues/473
- FastLED ESP32 README（RMT4 worker pool、RMT5 限制）：https://github.com/FastLED/FastLED/blob/master/src/platforms/esp/32/README.md
- WS2812B datasheet（VIH=0.7VDD，reset ≥50µs，>280µs 推荐）：https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf
- 74AHCT125 datasheet（VIH=2.0V @ 4.5–5.5V）：https://assets.nexperia.com/documents/data-sheet/74AHC_AHCT125.pdf
- 74HCT245 datasheet（DIR=H：A→B；OE=L：使能）：https://www.sg-micro.com/rect/assets/a8296301-a85b-4753-bb74-515854bbdd66/74HCT245.pdf
- WLED Wiring Pro Tips（线径、保险丝、注入）：https://kno.wled.ge/advanced/wiring/
- WLED Power Injection Guide（5V 每 100 颗注入、首尾注入、压降测试）：https://zelco.co.uk/blogs/wled-user-guide/wled-power-injection-when-where-and-how
- ESP32-C3-DevKitM-1 用户指南（引脚、5V 二极管）：https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/esp32-c3-devkitm-1/user_guide.html
- ESP32-C3-DevKitC-02 用户指南（引脚）：https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/esp32-c3-devkitc-02/user_guide.html
- ESP32-C3 SuperMini 引脚参考：https://lastminuteengineers.com/esp32-c3-super-mini-pinout-reference
- SuperMini 预算版 vs 高级版（5V 引脚无二极管警告）：https://electricalflux.com/mcu-boards/esp32-c3-supermini-pinout-budget-premium