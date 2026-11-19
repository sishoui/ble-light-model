#ifndef BLE_LIGHT_PROTO_BLE_PROTO_H
#define BLE_LIGHT_PROTO_BLE_PROTO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 协议 v1 帧编解码（纯 C99，不依赖 Arduino / IDF，不用动态内存）。
 *
 * 帧格式（多字节小端）：
 *   AA 55 | ver(1) | seq(2) | type(1) | flags(1) | strip_mask(1) | param_len(1) | payload(N) | crc16(2)
 * CRC-16/CCITT-FALSE 覆盖 ver..payload。整帧最长 266 字节。
 *
 * 职责边界：本层只处理帧 / 分片重组 / CRC / seq / 灯效参数长度，不认识灯效语义
 * （灯效渲染在 effect_engine，#11）。
 */

#define BLE_PROTO_VERSION 1u
#define BLE_PROTO_HEADER_SIZE 9u
#define BLE_PROTO_MAX_PAYLOAD 255u
#define BLE_PROTO_MAX_FRAME (BLE_PROTO_HEADER_SIZE + BLE_PROTO_MAX_PAYLOAD + 2u)

/* 指令集（#4 决议第 2 节）。 */
#define BLE_PROTO_TYPE_HELLO 0x01u
#define BLE_PROTO_TYPE_SET_EFFECT 0x02u
#define BLE_PROTO_TYPE_SET_BRIGHTNESS 0x03u
#define BLE_PROTO_TYPE_SET_POWER_LIMIT 0x04u
#define BLE_PROTO_TYPE_UNLOCK_FULL_POWER 0x05u
#define BLE_PROTO_TYPE_GET_STATUS 0x06u
#define BLE_PROTO_TYPE_ACK 0x07u
#define BLE_PROTO_TYPE_NAK 0x08u
#define BLE_PROTO_TYPE_STATUS 0x09u

/* NAK 错误码（#4 决议第 4 节）。 */
#define BLE_PROTO_NAK_CRC 0x01u
#define BLE_PROTO_NAK_UNKNOWN_TYPE 0x02u
#define BLE_PROTO_NAK_UNKNOWN_EFFECT 0x03u
#define BLE_PROTO_NAK_LENGTH_MISMATCH 0x04u
#define BLE_PROTO_NAK_INVALID_PARAM 0x05u
#define BLE_PROTO_NAK_NOT_UNLOCKED 0x06u
#define BLE_PROTO_NAK_BUSY 0x07u
#define BLE_PROTO_NAK_BAD_VERSION 0x08u

/* 解码后的协议帧。 */
typedef struct {
    uint8_t version;
    uint16_t seq;
    uint8_t type;
    uint8_t flags;
    uint8_t strip_mask;
    uint8_t payload_len;
    uint8_t payload[BLE_PROTO_MAX_PAYLOAD];
} ble_proto_frame_t;

/* feed 产出的帧错误：code 即 NAK 错误码；seq 为出错帧序号（回显用）。 */
typedef struct {
    uint8_t code;
    uint16_t seq;
    uint8_t type;
} ble_proto_error_t;

/* 接收端半帧超时（#4 §1：200ms 未完成则丢弃半帧；遇新 magic 也丢，在 feed 里处理）。 */
#define BLE_PROTO_FEED_TIMEOUT_MS 200u

/*
 * 判断半帧是否已超时应被丢弃：now_ms - last_ms >= 200ms（#4 §1）。
 * 纯函数：仅本地时钟比较，无 I/O、无动态内存、host 可单测；无副作用。
 * last_ms 为半帧里最近一字节的收到时刻（若半帧为空则不应调用）。
 */
int ble_proto_feed_should_reset(uint32_t last_ms, uint32_t now_ms);

/*
 * feed 重组上下文：调用方分配（静态或栈变量），必须零初始化
 * （ble_proto_feed_reset 可在连接重置时清空半帧）。
 */
typedef struct {
    uint8_t buf[BLE_PROTO_MAX_FRAME];
    size_t len;
} ble_proto_feed_t;

/*
 * 帧 -> 线格式字节，写入 out（容量 out_cap）。
 * 返回写入字节数；空间不足返回 0。
 */
size_t ble_proto_encode(const ble_proto_frame_t *frame, uint8_t *out, size_t out_cap);

/*
 * 字节流 -> 帧 / 错误。data 可含粘包 / 半帧 / 垃圾；未完成尾字节留在 ctx 里，
 * 由调用方在下次喂入前保持不动（或 ble_proto_feed_reset 丢弃）。
 * 返回本次解出的帧数；*errors_written（可为 NULL）为本次错误数。
 * frames/errors 达到各自 cap 后，多余的完整帧 / 错误被丢弃（cap 是安全阀）。
 * 与 JS 侧 codec.ts feed 的语义逐字节一致（golden 向量验证）。
 */
size_t ble_proto_feed(ble_proto_feed_t *ctx, const uint8_t *data, size_t len,
                      ble_proto_frame_t *frames, size_t frames_cap,
                      ble_proto_error_t *errors, size_t errors_cap,
                      size_t *errors_written);

/* 丢弃重组中的半帧（连接断开 / 超时 200ms 时调用）。 */
void ble_proto_feed_reset(ble_proto_feed_t *ctx);

/*
 * 灯效效果参数的期望长度（#4 决议第 3 节，只数效果参数、不含 effect_id 字节）。
 * 返回 -1 表示未知灯效。协议层只懂长度、不懂灯效语义。
 */
int ble_proto_effect_param_length(uint8_t effect_id);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_PROTO_BLE_PROTO_H */