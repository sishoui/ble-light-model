/**
 * 场景配置校验单测：6 场景齐全 / gate 标记 / validateSteps 合法性 / effects 表一致性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SCENARIOS, getScenario, listScenarios } from '../src/scenarios.mjs';
import { validateStep, validateSteps } from '../src/runner.mjs';
import { bytesToHex, crc16, decodeFrame, hexToBytes } from '../src/protocol.mjs';

test('6 场景齐全（spec §3.4 表）且 id 唯一', () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.deepEqual(
    ids.slice().sort(),
    ['background_resume', 'cold_start', 'disconnect_reconnect', 'failure_path', 'status_refresh', 'write_effects'],
  );
  assert.equal(new Set(ids).size, ids.length);
});

test('场景 1/2/4 带连跑门槛标记（gate）', () => {
  for (const id of ['cold_start', 'write_effects', 'disconnect_reconnect']) {
    assert.equal(getScenario(id).gate, true, id);
  }
  for (const id of ['status_refresh', 'background_resume', 'failure_path']) {
    assert.equal(getScenario(id).gate, false, id);
  }
});

test('getScenario / listScenarios', () => {
  assert.equal(getScenario('cold_start').title, '① 冷启动连接');
  assert.equal(getScenario('nope'), null);
  assert.equal(listScenarios().length, 6);
});

test('全部场景步骤通过 validateSteps', () => {
  for (const s of SCENARIOS) {
    const problems = validateSteps(s.steps);
    assert.deepEqual(problems, [], `${s.id}: ${problems.join('; ')}`);
  }
});

test('validateSteps 拒绝非法配置', () => {
  assert.deepEqual(validateStep({ op: 'bogus' }, 0), ['步骤 0: 未知 op "bogus"']);
  assert.ok(validateStep({ op: 'tap' }, 0).some((p) => p.includes('selector')));
  assert.ok(validateStep({ op: 'waitPageData', expect: { a: 1 } }, 0).some((p) => p.includes('timeoutMs')));
  assert.ok(validateStep({ op: 'com6Count', rx: { ev: 'gap' }, withinMs: 10 }, 0).some((p) => p.includes('equals')));
  assert.ok(validateStep({ op: 'com6Exchange', rx: {}, then: [], timeoutMs: 100 }, 0).some((p) => p.includes('then')));
  assert.ok(validateStep({ op: 'human', instruction: '' }, 0).some((p) => p.includes('instruction')));
  assert.ok(validateStep({ op: 'x', anchor: 'bogus' }, 0).some((p) => p.includes('anchor')));
  assert.ok(validateSteps([]).length > 0, '空数组非法');
});

test('effects 表：payload 合法且拼成完整帧能 CRC 通过；effectId / index 对应', () => {
  const table = JSON.parse(readFileSync(new URL('../effects.json', import.meta.url), 'utf8'));
  assert.equal(table.effects.length, 7);
  for (const eff of table.effects) {
    const payload = hexToBytes(eff.payloadHex);
    assert.ok(payload, `${eff.key} payload hex 非法`);
    assert.equal(payload[0], eff.effectId, `${eff.key} effectId`);
    // 拼成完整 SET_EFFECT 帧：AA55 ver=1 seq=0 type=2 flags=1 strip_mask=1 param_len=N payload CRC16-LE
    const header = new Uint8Array([0xaa, 0x55, 1, 0, 0, 2, 1, 1, payload.length]);
    const frame = new Uint8Array(header.length + payload.length + 2);
    frame.set(header);
    frame.set(payload, header.length);
    const crc = crc16(frame.subarray(2, header.length + payload.length));
    frame[header.length + payload.length] = crc & 0xff;
    frame[header.length + payload.length + 1] = crc >> 8;
    const d = decodeFrame(bytesToHex(frame));
    assert.ok(d.ok, `${eff.key}: ${d.error}`);
    assert.equal(d.frame.paramLen, payload.length);
    assert.equal(d.frame.payloadHex, eff.payloadHex.toLowerCase());
    assert.equal(d.frame.stripMask, 1);
    assert.equal(d.frame.flags, 1);
  }
});

test('effects 表：static 与 golden 向量 enc_set_effect_static 一致', () => {
  const table = JSON.parse(readFileSync(new URL('../effects.json', import.meta.url), 'utf8'));
  const vectors = JSON.parse(readFileSync(new URL('../../protocol/vectors.json', import.meta.url), 'utf8'));
  const v = vectors.vectors.find((x) => x.id === 'enc_set_effect_static');
  const staticRow = table.effects.find((e) => e.key === 'static');
  assert.equal(staticRow.golden, v.id);
  assert.equal(staticRow.payloadHex.toLowerCase(), v.frame.payload.toLowerCase());
});