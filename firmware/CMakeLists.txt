cmake_minimum_required(VERSION 3.16.0)

# core/（纯 C99）、proto/（纯 C99）作为 ESP-IDF component 参与编译。
# ports/esp32 与 app/ 走 src/ 主 component（src/CMakeLists.txt 引用）。
list(APPEND EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_SOURCE_DIR}/core"
    "${CMAKE_CURRENT_SOURCE_DIR}/proto")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(ble_light_model)