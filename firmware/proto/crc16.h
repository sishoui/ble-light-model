#ifndef BLE_LIGHT_PROTO_CRC16_H
#define BLE_LIGHT_PROTO_CRC16_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * CRC-16/CCITT-FALSE：poly 0x1021、init 0xFFFF、无输入/输出反射、xorout 0x0000。
 *
 * 协议帧中覆盖从 ver 到 payload 的字节（见 docs/spec/test-strategy.md §3.2）；
 * 这里只实现字节序列上的 CRC 原语，不感知帧结构。
 */
uint16_t crc16_ccitt_false(const uint8_t *data, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_PROTO_CRC16_H */