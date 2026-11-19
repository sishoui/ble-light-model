/**
 * 串口解析纯函数单测（无硬件）：JSONL 行解析 / 行规范化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLine, parseJsonlLine } from '../src/serial.mjs';

test('parseJsonlLine：合法 JSONL / 非 JSON / 空', () => {
  assert.deepEqual(parseJsonlLine('{"t_ms":1,"seq":7,"ev":"rx","type":2,"flags":1,"len":4}'), {
    t_ms: 1,
    seq: 7,
    ev: 'rx',
    type: 2,
    flags: 1,
    len: 4,
  });
  assert.equal(parseJsonlLine('rst:0x1 (POWERON)'), null, 'ESP_LOG* 行返回 null');
  assert.equal(parseJsonlLine(''), null, '空行');
  assert.equal(parseJsonlLine('   '), null, '空白行');
  assert.equal(parseJsonlLine('[1234] I (56) event_log: ...'), null, '日志行');
});

test('normalizeLine：剥尾部 \\r（ReadlineParser 的 \\n 分隔）', () => {
  assert.deepEqual(normalizeLine('{"ev":"boot"}\r'), { line: '{"ev":"boot"}', event: { ev: 'boot' } });
  assert.deepEqual(normalizeLine('{"ev":"ack"}\n'), { line: '{"ev":"ack"}', event: { ev: 'ack' } });
  const bad = normalizeLine('not json\r');
  assert.equal(bad.line, 'not json');
  assert.equal(bad.event, null);
});

test('parseJsonlLine 对大小写 / 前后空格容错', () => {
  assert.deepEqual(parseJsonlLine('  {"EV":"RX"}  '), { EV: 'RX' });
});