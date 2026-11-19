# 固件工程

PlatformIO 工程，两个 env：

- `native`：host 编译与 Unity 单测，CI 跑这个。
- `esp32-c3`：ESP-IDF v5.5.3（`espressif32@6.13.0` 解析到 `framework-espidf 3.50503.0`）。

`proto/` 是纯 C99 协议层，不依赖 Arduino / IDF，不用动态内存。native 通过 `build_src_filter` 直接编译；esp32-c3 通过 `CMakeLists.txt` 注册为 IDF component。

> Windows 注意：ESP-IDF 构建要求工程路径不含非 ASCII 字符。CMake/Ninja 会以系统 ANSI 代码页写 `build.ninja`，PlatformIO 按 UTF-8 读取；路径含中文（如 `项目`）会报 `UnicodeDecodeError`。把仓库放到纯 ASCII 路径，或开启系统 UTF-8 选项。