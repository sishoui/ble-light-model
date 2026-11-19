/**
 * CRC-16/CCITT-FALSE：poly 0x1021、init 0xFFFF、无输入/输出反射、xorout 0x0000。
 *
 * 协议帧中覆盖从 ver 到 payload 的字节（见 docs/spec/test-strategy.md §3.2）；
 * 这里只实现字节序列上的 CRC 原语，不感知帧结构。
 */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;

  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        (crc & 0x8000) !== 0
          ? ((crc << 1) ^ 0x1021) & 0xffff
          : (crc << 1) & 0xffff;
    }
  }

  return crc;
}