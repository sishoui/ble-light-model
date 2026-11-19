/**
 * 协议解码单测：golden 向量（tests/protocol/vectors.json）+ 坏帧拒绝 + 载荷解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ackSeq,
  bytesToHex,
  crc16,
  decodeFrame,
  hexToBytes,
  nakSeqErr,
  parseHelloPayload,
  parseStatusPayload,
} from '../src/protocol.mjs';

const vectors = JSON.parse(readFileSync(new URL('../../protocol/vectors.json', import.meta.url), 'utf8'));

const HELLO_HEX = 'AA550100000100001D01010000083C3075983A4655077F000000000000000000000000000000005CF6';

test('crc16 与 golden 向量一致（覆盖 ver..payload，LE 存放）', () => {
  const hex = 'AA550101000201010401FF0000B521';
  const bytes = hexToBytes(hex);
  const expect = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
  assert.equal(crc16(bytes.subarray(2, bytes.length - 2)), expect);
});

test('decodeFrame 解出全部 encode golden 向量（逐字段）', () => {
  let count = 0;
  for (const v of vectors.vectors) {
    if (v.kind !== 'encode') continue;
    const d = decodeFrame(v.expect_hex);
    assert.ok(d.ok, `${v.id}: ${d.error}`);
    const f = d.frame;
    assert.equal(f.version, v.frame.ver, v.id);
    assert.equal(f.seq, v.frame.seq, v.id);
    assert.equal(f.type, v.frame.type, v.id);
    assert.equal(f.flags, v.frame.flags, v.id);
    assert.equal(f.stripMask, v.frame.strip_mask, v.id);
    assert.equal(f.payloadHex, v.frame.payload.toLowerCase(), v.id);
    count += 1;
  }
  assert.ok(count >= 9, `encode 向量数量偏少：${count}`);
});

test('decodeFrame 拒绝坏帧', () => {
  assert.equal(decodeFrame('').ok, false, '空');
  assert.equal(decodeFrame('AA55').ok, false, '截断');
  assert.equal(decodeFrame('BB550101000201010401FF0000B521').ok, false, 'magic');
  assert.equal(decodeFrame('AA550101000201010401FF0000B522').ok, false, 'CRC 错');
  assert.equal(decodeFrame('zz').ok, false, '非法 hex');
  assert.equal(decodeFrame('AA550101000201010401FF0000').ok, false, '缺 CRC');
});

test('decodeFrame 忽略粘包尾部（只解第一帧）', () => {
  const d = decodeFrame('AA550101000201010401FF0000B521AA550102000301FF0180B2E3');
  assert.ok(d.ok);
  assert.equal(d.frame.type, 2);
  assert.equal(d.frame.payloadHex, '01ff0000');
});

test('ackSeq / nakSeqErr 从 notify 载荷取回显', () => {
  const ack = decodeFrame('AA55010700070000020700FF0B');
  assert.ok(ack.ok);
  assert.equal(ackSeq(ack.frame), 7);

  const nak = decodeFrame('AA5501050008000003050003522A');
  assert.ok(nak.ok);
  assert.deepEqual(nakSeqErr(nak.frame), { seq: 5, err: 3 });
});

test('parseStatusPayload（24 字节）', () => {
  const buf = Buffer.alloc(24);
  buf.writeUInt32LE(100, 0); // uptimeS
  buf.writeInt8(30, 4); // tempC
  buf.writeUInt16LE(500, 5); // currentMaEst
  buf[7] = 0; // thermalStatus
  buf.writeUInt16LE(1, 8); // glitch
  buf.writeUInt16LE(2, 10); // drop
  buf[12] = 128; // brightness
  buf.writeUInt16LE(15000, 13); // powerLimitMa
  buf[15] = 0; // stripFault
  buf[16] = 1; // activeEffect[0]
  const st = parseStatusPayload(buf.toString('hex'));
  assert.equal(st.uptimeS, 100);
  assert.equal(st.tempC, 30);
  assert.equal(st.currentMaEst, 500);
  assert.equal(st.brightness, 128);
  assert.equal(st.powerLimitMa, 15000);
  assert.deepEqual(st.activeEffect, [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(parseStatusPayload('00'), null, '长度不符返回 null');
});

test('parseHelloPayload（23 / 29 字节，golden 29 字节）', () => {
  const hello = parseHelloPayload(bytesToHex(hexToBytes(HELLO_HEX).subarray(9, 9 + 29)));
  assert.equal(hello.protocolVersion, 1);
  assert.equal(hello.fwVersion, '1.0.0');
  assert.equal(hello.stripCount, 8);
  assert.equal(hello.ledsPerStrip, 60);
  assert.equal(hello.maxCurrentMa, 30000);
  assert.equal(hello.powerLimitMa, 15000);
  assert.equal(hello.effectBitmapLen, 16);
});