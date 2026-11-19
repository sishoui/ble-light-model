# 固件工程

PlatformIO 工程，两个 env：

- `native`：host 编译与 Unity 单测，CI 跑这个。
- `esp32-c3`：ESP-IDF v5.5.3（`espressif32@6.13.0` 解析到 `framework-espidf 3.50503.0`）。

`proto/` 是纯 C99 协议层（`ble_proto` 帧编解码 + `effect_engine` 灯效引擎），不依赖 Arduino / IDF，不用动态内存。native 通过 `build_src_filter` 直接编译；esp32-c3 通过 `CMakeLists.txt` 注册为 IDF component。

- `ble_proto`：帧 / 分片重组 / CRC / seq / 灯效参数长度表，不认识灯效语义。
- `effect_engine`：8 路 × 60 颗逻辑 RGB 帧缓冲；灯效参数校验复用 `ble_proto_effect_param_length`，动画时间由调用方注入（`now_ms`），可 host 单测。GRB 转换 / 亮度 / 限流在驱动层（#13/#14）。

> Windows 注意：ESP-IDF 构建要求工程路径不含非 ASCII 字符。CMake/Ninja 会以系统 ANSI 代码页写 `build.ninja`，PlatformIO 按 UTF-8 读取；路径含中文（如 `项目`）会报 `UnicodeDecodeError`。把仓库放到纯 ASCII 路径，或开启系统 UTF-8 选项。