import { describe, expect, it } from "vitest";

import { crc16 } from "./crc16";

describe("crc16", () => {
  it("匹配 CRC-16/CCITT-FALSE 标准校验值 0x29B1", () => {
    // CRC-16/CCITT-FALSE 的标准检查输入是 ASCII "123456789"。
    const checkInput = new Uint8Array([
      0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    ]);

    expect(crc16(checkInput)).toBe(0x29b1);
  });
});