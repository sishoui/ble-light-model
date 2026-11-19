cmake_minimum_required(VERSION 3.16.0)

# proto/ 是纯 C99 协议层，作为 ESP-IDF component 参与编译。
list(APPEND EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/proto")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(ble_light_model)