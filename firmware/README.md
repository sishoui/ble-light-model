# firmware — ESP32-C3 固件（ESP-IDF v5.5.3 + PlatformIO）

8 条 WS2812B 灯带，每条 100 颗，2×RMT 4+4 分时复用驱动。目录分层与硬约束见 `docs/spec/driver.md`。

| 目录 | 职责 | 约束 |
|---|---|---|
| `driver/` | 调度 / 帧 / 编码（sched / frame / encode） | 纯 C99，无 IDF / 无 malloc / 无 float / 无 stdio |
| `effects/` | 灯效引擎（7 效果 + 场景持久化语义） | 纯 C99（`docs/spec/effects.md` §6） |
| `proto/` | 协议 codec（帧 / CRC / ACK/NAK / scene） | 纯 C99（`docs/spec/protocol.md` §12） |
| `ports/` | 唯一出现 ESP-IDF 的地方（rmt / route / clock / log / nvs） | 不碰调度策略 |
| `main/` | app_main：任务循环、ISR 注册、启动顺序 | — |
| `test/` | C core host 单测（Unity，`[env:native]`） | 用例见 `docs/spec/driver.md` §7（D1–D16） |

## 版本锁定

- 平台：`espressif32@6.9.0`（内嵌 ESP-IDF v5.5.3）。
- 运行时配置：`CONFIG_RMT_TX_ISR_CACHE_SAFE=y`、`CONFIG_PM_ENABLE=n`、RMT `intr_priority = 3`（`docs/spec/driver.md` §0.3 / §4）。
- host 单测走 `[env:native]`，CI 的 `firmware-host-test` job 跑 `pio test -e native`。

## 状态

纯 C99 core（`effects/` `driver/` `proto/`）已实现；`test/` 有 30 个 Unity host 用例（D1–D16 + 灯效 + 遥测）。
`ports/`（ESP-IDF：rmt / route / clock / log / nvs）与 `main/`（`app_main` / 任务循环 / ISR）**尚未实现**，因此 `pio run -e esp32c3` 还不能编译上板，目前只能 `pio test -e native` 跑 host 单测。落差与后续见 `docs/handover.md`。