/**
 * 断言纯逻辑单测（deepMatch / matchProblems / matchEvent / checkDelta）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkDelta, deepMatch, matchEvent, matchProblems, measureDeltaMs } from '../src/assert.mjs';

test('deepMatch：RegExp / 基本值 / 嵌套对象子集', () => {
  assert.equal(deepMatch('BLELight-C3', /BLELight-C3/), true);
  assert.equal(deepMatch('BLELight-X1', /BLELight-C3/), false);
  assert.equal(deepMatch(42, 42), true);
  assert.equal(deepMatch(42, 43), false);
  assert.equal(deepMatch(null, null), true);
  assert.equal(deepMatch({ a: 1, b: 2 }, { a: 1 }), true);
  assert.equal(deepMatch({ a: 1, b: 2 }, { a: 1, c: 3 }), false);
  assert.equal(deepMatch({ a: { b: { c: 5 } } }, { 'a.b.c': 5 }), false); // 点路径不在 deepMatch 内部解析（那是 matchProblems）
  assert.equal(deepMatch({ a: { b: { c: 5 } } }, { a: { b: { c: 5 } } }), true);
  assert.equal(deepMatch([1, 2, 3], [1, 2, 3]), true);
  assert.equal(deepMatch([1, 2, 3], [1, 2]), false);
});

test('deepMatch：__op 操作符（includes / oneOf / gte / lte）', () => {
  assert.equal(deepMatch('应用灯效失败: ACK超时（500ms）', { __op: 'includes', value: '超时' }), true);
  assert.equal(deepMatch('应用灯效失败: ACK超时（500ms）', { __op: 'includes', value: '需满功率解锁' }), false);
  assert.equal(deepMatch(['a', 'b'], { __op: 'includes', value: { __op: 'includes', value: 'a' } }), true);
  assert.equal(deepMatch(['a', 'b'], { __op: 'includes', value: 'c' }), false);
  assert.equal(deepMatch('reconnecting', { __op: 'oneOf', values: ['reconnecting', 'fault'] }), true);
  assert.equal(deepMatch('ready', { __op: 'oneOf', values: ['reconnecting', 'fault'] }), false);
  assert.equal(deepMatch(0, { __op: 'gte', value: 0 }), true);
  assert.equal(deepMatch(255, { __op: 'lte', value: 255 }), true);
  assert.equal(deepMatch(256, { __op: 'lte', value: 255 }), false);
});

test('matchProblems：缺字段 / 不匹配 / 通过', () => {
  const d = { state: 'ready', mask: 1, status: { brightness: '0', powerLimit: '128mA' } };
  assert.deepEqual(matchProblems(d, { state: 'ready', mask: 1 }), []);
  assert.deepEqual(matchProblems(d, { state: 'idle' }), [`page.data.state: 期望 "idle" 实际 "ready"`]);
  const probs = matchProblems(d, { 'status.brightness': '255', 'status.powerLimit': '128mA' });
  assert.equal(probs.length, 1);
  assert.ok(probs[0].includes('status.brightness'));
});

test('matchEvent：ev / seq / type / flags / len / what / afterMs / beforeMs', () => {
  const rec = { tsMs: 1000, event: { ev: 'rx', seq: 5, type: 2, flags: 1, len: 4 } };
  assert.equal(matchEvent(rec, { ev: 'rx' }), true);
  assert.equal(matchEvent(rec, { ev: 'rx', seq: 5 }), true);
  assert.equal(matchEvent(rec, { ev: 'rx', seq: 6 }), false);
  assert.equal(matchEvent(rec, { ev: 'gap' }), false);
  assert.equal(matchEvent(rec, { type: 2, flags: 1, len: 4 }), true);
  assert.equal(matchEvent(rec, { afterMs: 1000 }), true);
  assert.equal(matchEvent(rec, { afterMs: 1001 }), false);
  assert.equal(matchEvent(rec, { beforeMs: 1000 }), true);
  assert.equal(matchEvent(rec, { beforeMs: 999 }), false);
});

test('measureDeltaMs / checkDelta', () => {
  assert.equal(measureDeltaMs(1000, 1200), 200);
  assert.equal(checkDelta(499, 500), null);
  assert.equal(checkDelta(500, 500), null);
  assert.equal(checkDelta(501, 500), 'Δ=501ms 超过上限 500ms');
  assert.equal(checkDelta(200, null), null);
});