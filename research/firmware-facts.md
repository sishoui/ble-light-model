# 固件事实核查报告（ESP32-C3 / RMT / BLE / PlatformIO）

> 核查日期：2026-11-19（以 GitHub / 官方文档当日在线内容为准）。
> 项目背景：ESP32-C3 单核，2 个 RMT TX 通道 + GPIO Matrix 时分复用驱动 8 条 WS2812B（每条 60 颗，1.8ms/条，48 符号内存块，ISR 每 ~60µs 补数据），同时跑 BLE GATT notify，IDF v5.x vs Arduino-ESP32 3.x 二选一（倾向 IDF）。

---

## 1. ESP-IDF v5.x 新 RMT 驱动（driver/rmt_tx.h）

### 结论
- **1a**：TX 侧只有**一个**事件回调：`on_trans_done`（传输完成），无 error 事件、无 underrun 事件。回调在 **ISR 上下文**执行，返回 bool 表示是否唤醒更高优先级任务，只能调用 FromISR 结尾的 FreeRTOS API；开启 cache-safe 时必须放 IRAM。
- **1b**：**没有任何公开 API / 状态 / 事件可以检测发送期间的 FIFO 欠载**。官方 FAQ 明确承认这一失效模式：编码器（在 ISR 里跑）若被拖延，硬件 transmitter 会读旧数据，导致 "RMT transmits more data than expected"（发多了/发出错数据），且没有暂停机制。你设计的"统计 glitch 并重发"只能自行在 `on_trans_done` 回调里数实际发送符号数（`edata.num_symbols` 与期望值比对），拿不到"欠载发生过"的直接信号。
- **1c**：`rmt_tx_wait_all_done(tx_channel, timeout_ms)` 阻塞等待该通道所有在途事务完成并回收描述符；`timeout_ms = -1` 永久等待，`>=0` 超时返回 `ESP_ERR_TIMEOUT`。API 是**单通道**的，官方无"多通道并行等待"接口；要并行等只能对两个通道各自调用（分别在两个任务里，或依次调用并保证超时足够）。注意：有无限循环（loop_count=-1）的未结束事务会让它永远阻塞。

### 依据
- 官方文档（v5.x/v6.x RMT 文档，"Register Event Callbacks"、"FAQ: Why the RMT transmits more data than expected?"、"Kconfig Options"）：
  - https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/peripherals/rmt.html
- rmt_tx.h（v5.4，回调结构与注释 "The callbacks are all running under ISR environment"、wait_all_done 语义）：
  - https://raw.githubusercontent.com/espressif/esp-idf/v5.4/components/esp_driver_rmt/include/driver/rmt_tx.h
- rmt_tx.c（v5.4，ISR 流程：仅 THRES / DONE / LOOP_END 三种中断，无 underrun 处理）：
  - https://raw.githubusercontent.com/espressif/esp-idf/v5.4/components/esp_driver_rmt/src/rmt_tx.c
- rmt_tx.c（v5.5，同上 + 新增 `rmt_tx_switch_gpio()`，见第 4 组备注）：
  - https://raw.githubusercontent.com/espressif/esp-idf/v5.5/components/esp_driver_rmt/src/rmt_tx.c
- 文档 FAQ 原文（欠载后果与缓解措施：加大 mem_block_symbols、编码函数放 IRAM、用 DMA、把 RMT 驱动装到与 WiFi/BT 不同的核——C3 单核不适用最后一条）：
  - 同上 stable 文档 FAQ 节
- esp32.com 论坛（RMT 半满中断被高优先级 radio 中断抢占 → 发送错误 → 建议改用带 DMA 的 SPI，即本项目不走 DMA 时的典型社区结论）：
  - https://esp32.com/viewtopic.php?t=30714

---

## 2. PlatformIO espressif32 对 ESP-IDF 的支持（截至 2026-11）

### 结论
- framework-espidf 包（platformio 官方 registry）当前版本链：**4.60100.0（对应 IDF v5.5.x，2026-08-31，latest）**、**4.60001.0 / 4.60000.0（IDF v5.5.x，2026-04）**、**3.50503.0 / 3.50502.0（IDF v5.3.x，2026-02）**、3.50500.0（IDF v5.3.1，2025-07）、3.50402/3.50401/3.50400（IDF v5.2.x）等。平台版本与 IDF 版本的对应：platform 6.9.0→IDF 5.3.1；6.11.0→IDF 5.4.1；6.12.0→IDF 5.5.0；6.13.0→IDF 5.5.3；7.0.x→IDF 6.0.1；7.1.0→IDF 6.1.0；**8.0.0（最新，2026-10）→ IDF v6.1**。
- 对 ESP32-C3 + 本项目（新 RMT 驱动 + NimBLE + BLE）：**最稳组合是 platform-espressif32 ~6.13.0 + IDF 5.5.3**（IDF 5.x 的最后一个平台系列，RMT/BLE 驱动成熟，社区大量使用）；若坚持 5.4 分支可用 6.11.0（IDF 5.4.1）。**不建议**上 7.x/8.0.0（IDF v6.x）：大版本刚发布数月，Arduino/蓝牙生态仍在迁移（8.0.0 release notes 自述 Arduino core 蓝牙 API 还在重构中）。也不建议 6.9.0（IDF 5.3.1）——它早于 IDF v5.5 的 RMT 修复（见第 4 组：v5.5 的 rmt_tx.c 修了 v5.4 里 `rmt_disable()` 不 reset encoder 等 bug）。

### 依据
- framework-espidf 版本列表（官方 registry API）：
  - https://api.registry.platformio.org/v3/packages/platformio/tool/framework-espidf
- 平台 8.0.0 release notes（IDF v6.1、Arduino 3.3.12 / IDF 5.5.5）：
  - https://github.com/platformio/platform-espressif32/releases
- 平台 6.13.0（IDF 5.5.3）、6.12.0（IDF 5.5.0）、6.11.0（IDF 5.4.1）、6.9.0（IDF 5.3.1）release notes：
  - https://github.com/platformio/platform-espressif32/releases/tag/v6.13.0
  - https://github.com/platformio/platform-espressif32/releases/tag/v6.12.0
  - https://github.com/platformio/platform-espressif32/releases/tag/v6.11.0
  - https://github.com/platformio/platform-espressif32/releases/tag/v6.9.0
- 6.9.0 的 platform.json（默认 ~3.50301.0，可选 ~3.40407.0）与 8.0.0 的 platform.json（默认 ~4.60100.0，可选 ~3.50505.0）：
  - https://raw.githubusercontent.com/platformio/platform-espressif32/v6.9.0/platform.json
  - https://raw.githubusercontent.com/platformio/platform-espressif32/refs/heads/develop/platform.json

---

## 3. ESP32-C3 NimBLE vs Bluedroid（IDF v5.x）

### 结论
- **RAM**：NimBLE（仅 BLE host）比 Bluedroid（双模 + 大 host）省得多。Espressif 官方对比（ESP32-C3，默认 sdkconfig，v5.5 数据）：空工程剩 332K，GATT server 示例剩 215K；C3 优化后 Station 230K→304K、bleprph_wifi_coex 178K→248K（含 NimBLE 广播）。esp32.com 用户实测（ESP32 平台）：相对其优化过的 Bluedroid 配置，换 NimBLE 后 Flash -167KB、堆 +8.5KB。C3 上 NimBLE 每条连接约 1k DRAM 量级（官方 Kconfig 对 C2/C6/H2 的说明），GATT server + notify（BLE 5.0：2M PHY、Coded PHY、扩展广播）两栈都完整支持。
- **对用户代码的影响**：NimBLE host 任务可绑核（CONFIG_BT_NIMBLE_PINNED_TO_CORE_*；C3 单核无所谓），默认 4KB 栈；BLE controller 的中断/临界区对 RMT 补数据 ISR 的阻塞时长**无官方数字**（查不到明确的 "BLE 阻塞 < X µs" 文档）。已知坑：与 RMT 共存时的实测证据几乎全部来自 WiFi 共存场景（FastLED #1349、#1846），BLE-only 场景的直接实测报告很少——见第 4 组。
- 对"给微信小程序发 notify"这一用例：两栈都支持 GATT server notify；NimBLE 的 API 更精简、RAM 更省，是 C3 单核 + 大 LED 缓冲方案（480 颗 ×3 字节 ≈ 1.4KB 像素缓冲 + 两个通道事务）下的合理选择。Bluedroid 唯一明显优势是双模（本工程不用）和 Arduino 3.x 生态默认。

### 依据
- Espressif 官方内存对比（ESP-Techpedia "Memory Usage Comparison"，C3 332K 空 / 215K gatt_server，v5.5 默认配置）：
  - https://docs.espressif.com/projects/esp-techpedia/en/latest/esp-friends/advanced-development/system/ram-usage.html
- esp32.com "Reduce RAM usage of Bluetooth NimBLE stack"（实测 Flash -167KB / 堆 +8.5KB）：
  - https://esp32.com/viewtopic.php?t=33783
- esp32.com "advantages of bludroid and nimble over each other"（Bluedroid=双模/大堆，NimBLE=仅 BLE/小占用）：
  - https://esp32.com/viewtopic.php?t=16094
- NimBLE Kconfig（连接数、每连接 RAM、绑核、MSYS 缓冲、GATT 配置）：
  - https://raw.githubusercontent.com/espressif/esp-idf/v5.4/components/bt/host/nimble/Kconfig.in
- Arduino/Bluedroid vs NimBLE 的第三方对比（CSDN，仅供定性参考）：
  - https://blog.csdn.net/weixin_28738397/article/details/160298168

---

## 4. ESP32-C3 RMT 与 BLE 中断共存

### 结论
- **4a**：能设，但**不能直接设到"最高"**。`rmt_tx_channel_config_t::intr_priority`（1/2/3，数字形式而非位掩码）在 v5.4/v5.5 被驱动内部用 `RMT_ALLOW_INTR_PRIORITY_MASK = ESP_INTR_FLAG_LOWMED` 校验，即只允许落在 LOWMED（1~3）档，填 4~7（NMI 档）会 `ESP_ERR_INVALID_ARG`。同 group 的通道必须一致，创建后不可改（rmt_del_channel 前）。实践中"最高可用"= 与 BLE controller 同档或更低，靠 BLE 自身不使用高优先级抢占窗口来保证时延。
- **4b**：**查不到官方数字**。Espressif 文档没有给出 C3 BLE controller + host 关中断/临界区的最大时长保证；社区对 "BLE 中断会不会阻塞超过 60µs" 没有权威测量结论。间接证据：FastLED #1846（ESP32-C3 + BLE 遥控 + WS2812，RMT5 驱动下严重闪烁，加大 RMT 内存块后解决）与 esp32.com t=30714（WiFi 抢占 RMT 半满中断导致发送错误）说明**射频共存中断确实能把 RMT 补数据延迟到出错**，但这是故障案例而非时延测量。工程上只能自行用 GPIO 翻转 + 示波器/逻辑分析仪实测最坏关中断时长。
- **4c**：社区结论明确：**"ESP32-C3（RISC-V）+ 无 DMA RMT + 无线协议栈同时跑" 是已知易碎组合**。
  - FastLED 维护者（zackees）在 #1846 中直言："Unfortunately the C3 and C6 have a lot of flicker and there is nothing that will be done about it in the near time frame... you really shouldn't be doing serious LED work on any other chip"（指非 S3）。
  - WLED：0.15.0 起（NPB 2.8 / IDF5 RMT 驱动）出现 RMT 数据损坏 #4389；修复方案 RmtHI 高优先级中断驱动（#4890）**只支持 Xtensa（ESP32/S2/S3），明确排除 C3**——"there's some unresolved issue with nested interrupts on RISCV"。
  - WLED 对 C3 的现行做法全是**规避**：等 LED 更新完成再执行可能关中断的操作（文件写、ESP.getFreeHeap、OTA）(#5435/#5683/#5691)，softhack007 总结："the real problem on -C3 is the shared RMT refill interrupt. This interrupt can be stalled by many FreeRTOS or hardware driver activities... the only real solution for -C3 is to rewrite the leds driver, or implement a high-priority RMT driver... Both options are ongoing experiments, but the code is not stable yet"。
  - 缓解清单（社区实测有效/官方 FAQ 推荐）：① encoder/refill 放 IRAM（RMT_ENCODER_FUNC_ATTR）+ mem_block_symbols 加倍（C3 是 48 的倍数，FastLED rmt5-less-flicker 分支即此方案）；② 打开 CONFIG_RMT_TX_ISR_CACHE_SAFE（代价 IRAM）；③ 无线事件（BLE notify、连接事件）安排在非刷新窗口，或拉长连接间隔/降低 notify 频率（本项目 ~2s 一次 STATUS，冲突面小）；④ 避免在传输途中有任何可能关中断的调用（heap 查询、文件、日志刷盘——USB CDC 日志注意别在 1.8ms 窗口里同步写）；⑤ 电平/电源：3.3V 逻辑 + 74HCT 电平转换、独立 5V 供电（FastLED #1349 里多起 "flicker" 最终是电源/电平问题）。
  - 对"误码率"：**查不到量化数据**（无社区给出 C3+BLE+RMT 的 BER 数字）；可引用的只有"闪烁/数据损坏频发"（WiFi/BLE 开启时）的定性结论，且部分报告最终被归因于电源或电平而非中断。

### 依据
- intr_priority 校验（LOWMED 掩码、1~3、创建后不可改）：
  - https://raw.githubusercontent.com/espressif/esp-idf/v5.5/components/esp_driver_rmt/src/rmt_private.h （`RMT_ALLOW_INTR_PRIORITY_MASK ESP_INTR_FLAG_LOWMED`）
  - https://raw.githubusercontent.com/espressif/esp-idf/v5.5/components/esp_driver_rmt/src/rmt_tx.c （`rmt_new_tx_channel()` 内校验）
  - 文档（intr_priority 说明，数字形式 1/2/3）：https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/peripherals/rmt.html
- 官方 FAQ（欠载 → 发错数据；缓解：mem_block_symbols、IRAM、DMA、分核）：
  - 同上 stable 文档 FAQ 节
- FastLED #1846（C3 + BLE 遥控 → 闪烁；rmt5-less-flicker = 加倍 RMT 内存；zackees 对 C3 的悲观结论；建议 SPI/I2S 后端）：
  - https://github.com/FastLED/FastLED/issues/1846
- FastLED #1349（C3 + WiFi → 闪烁；多起最终归因电源/电平；#1515 修复部分案例）：
  - https://github.com/FastLED/FastLED/issues/1349
- esp32.com t=30714（WiFi 高优先级中断抢占 RMT 半满中断 → RMT 发送错误 → 建议 SPI DMA）：
  - https://esp32.com/viewtopic.php?t=30714
- WLED #4389（0.15.0 RMT 数据损坏）：
  - https://github.com/wled/WLED/issues/4389
- WLED #4890（RmtHI 高优先级驱动，Xtensa-only，C3 因 RISC-V 嵌套中断问题未解决被排除）：
  - https://github.com/wled/WLED/pull/4890
- WLED #5435 / #5683 / #5691（C3 规避方案：关中断操作前等 LED 更新完成；"shared RMT refill interrupt can be stalled by many FreeRTOS or hardware driver activities"）：
  - https://github.com/wled/WLED/pull/5435
  - https://github.com/wled/WLED/pull/5683
  - https://github.com/wled/WLED/pull/5691

---

## 附：对本项目有直接影响的额外发现

1. **IDF v5.5 的 RMT 驱动修了 v5.4 的两个相关 bug**（rmt_tx.c diff）：
   - v5.4：`rmt_disable()` 不调用 `rmt_encoder_reset()`（v5.5 先 reset 再回收事务）；v5.5 `rmt_tx_do_transaction()` 开头统一 `rmt_encoder_reset(t->encoder)`——对"运行时切 GPIO / 反复重发同一通道"的用法更稳。
   - v5.4：`rmt_encode_check_result` 里 loop_count 超限只打日志；v5.5 新增 `RMT_ENCODING_WITH_EOF` 标志避免重复插 EOF。
   - **v5.5 新增 `rmt_tx_switch_gpio()`**（channel 必须处于 disabled 状态）：官方 API 级支持运行中切 GPIO。你"运行时切 gpio_output_enable/disable"的手工方案若升级到 platform 6.11+（IDF 5.4.1+）可以考虑它，但仍需 disable→switch→enable，不能无缝。
   - 结论：第 2 组选 **platform 6.13.0 / IDF 5.5.3** 的又一理由。
2. **C3 的 BLE controller 是 `SOC_ESP_NIMBLE_CONTROLLER`**（NimBLE Kconfig 可见），即 C3 上 NimBLE 用自研 controller（非 VHCI 到 host），Bluedroid 用 BTDM controller；两者互斥编译，与 RMT 无共享资源冲突记录。
3. **RMT 通道内存**：C3 每通道硬件 48 symbols（192B），`mem_block_symbols` 必须是偶数且 ≥48；加倍到 96（占用两个相邻内存块，ping-pong 48+48）正是 FastLED 修复 C3 闪烁的核心手段——你 1440 symbols 的事务天然会被拆成 30 次 ping-pong 补数据，加大内存块可直接拉长每次补数据间隔（48 symbols @ 1.25µs/symbol = 60µs，与你的 ISR 预算一致）。