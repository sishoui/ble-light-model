# ESP32-C3 SuperMini 灯带项目：OTA 与内存事实核查报告

- 核查日期：2026-11-19
- 方法：websearch + webfetch 查证官方文档（docs.espressif.com / GitHub 源码）与社区来源（esp32.com、GitHub issues、论坛、博客），逐条给出链接。
- 原则：查不到的明确标注"查不到"；间接数据点与官方数据分开标注。

---

## 1. ESP32-C3 SuperMini 的 flash 大小

**结论**：主流在售 SuperMini 均为 **4MB**（芯片为 ESP32-C3FN4 或 ESP32-C3FH4，封装内置 4MB flash）。**不存在官方的 "2MB 批次"**——ESP32-C3 芯片的封装内 flash 只有 无 / 4MB / 8MB 三种规格，没有 2MB 变体；市面上标 "2MB" 的链接属于错误标注或混淆。真正的批次风险不是 2MB，而是**无 flash 的裸芯片批次**（ESP32-C3 无 F 后缀），这种板子无法运行任何固件，购买时需确认芯片丝印为 FN4/FH4。

**依据**：
- Zephyr 官方板级文档（ESP32-C3-SUPERMINI）：384 KiB RAM / 4 MiB Flash — https://docs.zephyrproject.org/latest/boards/others/esp32c3_supermini/doc
- SuperMini 厂商 Datasheet v3："4 MB In-Package Flash" — https://cdn.shopify.com/s/files/1/0664/6127/0112/files/ESP32-C3-SUPERMINI-Datasheet-v3.pdf
- 另一份 SuperMini datasheet："ESP32-C3FH4 or ESP32-C3FN4 embedded … 4 MB flash in chip package" — https://epyelectronica.com/wp-content/uploads/ESP32-C3-SuperMini-Placa-de-Desarrollo-USB-Tipo-C-Datasheet.pdf
- Espressif C3 芯片规格对比（引自官方 datasheet）：In-package flash = No / 4 MB / 8 MB — https://mischianti.org/esp32-c3-supermini-plus-v2-high-resolution-pinout-datasheet-and-specs
- 无 flash 批次警告（Seeed 论坛）：https://forum.seeedstudio.com/t/be-careful-with-esp32-c3-super-mini-development-boards/294766
- 变体清单（FH4AZ/FH4X=4MB，FH8X=8MB 为当前量产变体）：https://itechfaqs.com/be-wary-of-flashless-esp32-c3-super-mini-boards-how-to-check-before-you-buy
- 采购避坑（AliExpress 无 flash 冒充）：https://blog.quadmeup.com/2025/12/22/the-hidden-trap-inside-esp32-c3-super-mini-boards-from-aliexpress

> 备注：eBay 有标 "2mb" 的 SuperMini listing（如 https://www.ebay.com/itm/135647901662 ），但无任何技术文档支持 C3 存在 2MB 封装内 flash，判定为错误标注，不作为依据。

---

## 2. IDF v5.5 + NimBLE 在 C3 上的固件体积

**结论**：
- **官方 gatt_server / bleprph 示例在 C3 上的 bin 大小：查不到。** Espressif 官方文档和示例 README 均不公布各芯片上的示例 bin 大小，社区也未检索到可信的具体数字（多个检索词组合均无结果）。
- NimBLE vs Bluedroid 的 flash 节省（可核实的数据点）：
  - **esp32.com 原帖已定位**：《Reduce RAM usage of Bluetooth NimBLE stack》— https://esp32.com/viewtopic.php?t=33783 。原帖引文（与已知的 "Flash -167KB" 数据点一致）："In comparison to my previously 'optimized' Bluedroid config, using Nimble resulted in the following changes: **- reduced Flash usage by 167KB** - increased IRAM usage by 1.5KB - reduced Total Heap usage by 8.5KB"。⚠️ 核实限制：esp32.com 对自动抓取有 bot 拦截（多次尝试均无法获取全文，Wayback 也无存档），引文通过两条独立搜索引擎对该帖 URL 的索引快照交叉确认；发帖芯片/IDF 版本等上下文未能核实。
  - ESPHome BTHome 组件文档（ESP32-S3 实测）：Bluedroid 1,101KB vs NimBLE 886KB flash（省 ~215KB），RAM 47KB vs 40KB — https://dz0ny.github.io/esphome-bthome/components/bthome
  - Arduino（IDF 4.4 底层）+ BLE 工程实测：Bluedroid 765,701 B → 换 NimBLE 564,825 B（ESP32，省 ~196KB）— https://community.platformio.org/t/esp32-arduino-firmware-becomes-huge-with-ble/30230
- 量级参考（间接，非 C3+IDF5.5 直接数字）：IDF WiFi+NimBLE 工程初始 1,256,240 B，裁剪后 973,024 B（h0bb3 博客，ESP32）— https://h0bb3.github.io/log/2025/08/26/firmware-on-a-diet.html

**对本项目的含义**：NimBLE GATT server + RMT + WiFi 的 C3 工程，app bin 预计在数百 KB ~ 1MB 量级（间接证据支持"1MB 分区通常够用、2×1MB OTA 布局不紧张"），但**必须实测** `idf.py size` 才能定论。

---

## 3. ESP-IDF OTA 分区方案

**结论**：
- **4MB 上的官方 OTA 布局**（内置 "Factory app, two OTA definitions"，v5.5.3 文档原表）：

  ```
  nvs,      data, nvs,     0x9000,   0x4000
  otadata,  data, ota,     0xd000,   0x2000
  phy_init, data, phy,     0xf000,   0x1000
  factory,  app,  factory, 0x10000,  1M
  ota_0,    app,  ota_0,   0x110000, 1M
  ota_1,    app,  ota_1,   0x210000, 1M
  ```
  即 bootloader(0x1000 起) + 分区表(0x8000) + nvs/otadata/phy + **factory 1M + ota_0 1M + ota_1 1M**。Kconfig 原文："All are 1MB, so this partition table requires 4MB or larger flash size."
- **官方对 OTA 的硬性要求**（OTA 文档）：至少两个 OTA app 槽（ota_0、ota_1）+ 一个 otadata 分区（固定 0x2000 字节）。官方**没有给出"OTA 最小 flash"的绝对数字**；但内置 Single factory app 表（可放进 2MB）被 Kconfig 明确标注 "not suitable for an app that needs OTA"。
- **2MB 上做 OTA**：官方Workshop 明确 "Two 1 MB OTA app partitions no longer fit"（2MB 场景）— https://developer.espressif.com/workshops/esp-idf-with-esp32-c5/assignment-2-1 。可行做法是自定义 CSV：两个 app 槽各约 0.9~0.95MB（此为按 0x10000 起、2MB 总量推算的自算值，非官方数字）。槽 <1MB 对本项目（BLE+RMT，无 WiFi 协议栈需求的话）通常够用，但余量小、为后续功能增长留的空间少。

**依据**：
- IDF v5.5.3 Partition Tables（内置表原文）— https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32/api-guides/partition-tables.html
- IDF v5.5.3 OTA 文档（ota_0/ota_1 + otadata 要求）— https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32/api-reference/system/ota.html
- Kconfig.projbuild v5.5.3（"requires 4MB or larger" / "not suitable for OTA"）— https://github.com/espressif/esp-idf/blob/v5.5.3/components/partition_table/Kconfig.projbuild

---

## 4. Arduino-ESP32 3.x 的 flash/RAM 开销 vs 裸 IDF

**结论**：
- **Arduino 2.x → 3.x 官方 CI 数据**（SIZES_TEST.md，C3 列）：多数示例 flash 增加 **~180~220KB**（HTTPClient +204K、BasicOTA +194K、CaptivePortal +221K；BLE 示例几乎不变，个别 -1.7K）。增幅主要来自 IDF 4.4→5.1 的系统膨胀，官方维护者拆解：WiFi 相关 ~120KB、LwIP +24KB、core +12KB、USB ~20KB 等。
- **复杂工程实测**（GitHub issue #9741，ESP32）：WiFi+BLE+WebServer+HTTPS OTA 工程 2.0.17 = 1,870,801 B → 3.0.0 = 2,051,421 B（**+~180KB / +9.7%**）；空 sketch（3.0.0）= 252,537 B。
- **"Arduino vs 裸 IDF 同功能 flash 差值"的官方/权威数字：查不到。** 可用间接数据：Arduino 核心贡献者 Jason2866 在同 issue 中说明其裁剪版 Arduino（去 SPIFFS/RainMaker/Insights/WifiProv、精简 mbedtls、BearSSL+h2zero NimBLE）"results is about 200k less flash usage than the official build"——即官方 Arduino 配置约含 ~200KB 可裁掉的"功能税"。
- **Arduino 3.x 支持 OTA：是，且底层就是 IDF 的 app_update**。Update 库源码（Updater.cpp）直接 `#include "esp_ota_ops.h"`，ArduinoOTA / HTTPUpdate / WebUpdater / Update.h 都是 IDF esp_ota API 的封装。

**依据**：
- 官方 CI 尺寸对比：https://github.com/P-R-O-C-H-Y/arduino-esp32/blob/gh-pages/SIZES_TEST.md
- Issue #9741（含 2.0.17 vs 3.0.0 实测与官方拆解）：https://github.com/espressif/arduino-esp32/issues/9741
- Update 库源码（esp_ota_ops.h）：https://github.com/espressif/arduino-esp32/blob/master/libraries/Update/src/Updater.cpp

---

## 5. C3 RAM 官方数字核实

**结论**：esp-techpedia 《Memory Usage Comparison》（测试于 **release/v5.5**，默认 sdkconfig、未做内存优化）C3 行原表：

| 芯片 | 空工程 | Station | Gatt_server | bleprph | provision (BLE&WiFi共存) | thread |
|---|---|---|---|---|---|---|
| ESP32-C3 | **332 K** | 219 K | **215 K** | 205 K | 126 K | 不支持 |

用户之前查到的"空 332K / gatt_server 215K"**确认无误**。注：Gatt_server / bleprph 列即 IDF `examples/bluetooth/nimble/` 下的 NimBLE 示例（剩余 free heap）；对比 ESP32（366K/205K）和 ESP32-C2（197K/80K）可见 C3 跑 NimBLE GATT server 的 RAM 余量在同类中较宽裕。同页另有 C3 内存优化示例（v5.2.2）：Station 230K→304K、bleprph_wifi_coex 178K→248K，说明默认配置还有优化空间。

**依据**：
- https://docs.espressif.com/projects/esp-techpedia/en/latest/esp-friends/advanced-development/system/ram-usage.html

---

## 附：本次"查不到"清单

1. IDF v5.5 + NimBLE 官方 gatt_server / bleprph 示例在 **C3 上的 bin 大小**——官方未公布、社区无可靠数字（第 2 组）。
2. "Arduino vs 裸 IDF 同功能 flash 差值"的权威直接对比数字——不存在（第 4 组），仅有 ±200KB 量级的间接证据。
3. esp32.com t=33783 原帖全文——被 bot 拦截无法全文核实；引文经搜索引擎索引交叉确认（第 2 组）。
4. 2MB flash 上 OTA 双槽的官方推荐布局——官方只覆盖 4MB 内置表；2MB 双槽布局为社区/自算（第 3 组）。