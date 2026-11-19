/**
 * 步骤执行器单测：假 session + 假 COM6 + 假时钟，验证
 * 断言 / Δ 计算 / seq 关联 / 失败即停 / 计数与不存在断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSteps } from '../src/runner.mjs';
import { matchEvent } from '../src/assert.mjs';
import { bytesToHex, crc16, hexToBytes } from '../src/protocol.mjs';

/** 拼一条合法 CRC 的 notify 帧：AA55 ver=1 seq=0 type flags strip_mask=0 payload crc16-LE。 */
function makeNotifyFrame(type, payloadBuf) {
  const payload = hexToBytes(payloadBuf.toString('hex'));
  const header = new Uint8Array([0xaa, 0x55, 1, 0, 0, type, 0, 0, payload.length]);
  const frame = new Uint8Array(header.length + payload.length + 2);
  frame.set(header);
  frame.set(payload, header.length);
  const crc = crc16(frame.subarray(2, header.length + payload.length));
  frame[header.length + payload.length] = crc & 0xff;
  frame[header.length + payload.length + 1] = crc >> 8;
  return bytesToHex(frame);
}

function makeFakeCom(events) {
  const lines = events.map((e) => ({ tsMs: e.tsMs, tsWall: 0, raw: JSON.stringify(e.event), event: e.event }));
  return {
    lines,
    findEvent(spec) {
      for (const rec of lines) if (rec.event && matchEvent(rec, spec)) return rec;
      return null;
    },
    countEvents(spec) {
      let n = 0;
      for (const rec of lines) if (rec.event && matchEvent(rec, spec)) n += 1;
      return n;
    },
    parsedEvents() {
      return lines;
    },
  };
}

function makeFakeSession(pageData, extra = {}) {
  return {
    notifyFrames: extra.notifyFrames ?? [],
    consoleLogs: extra.consoleLogs ?? [],
    async page() {
      return { $: async () => ({ attribute: async () => null }) };
    },
    async currentPageData() {
      return pageData;
    },
    async tap() {},
    async tapAt() {},
    async callMethod() {
      return null;
    },
    async element() {
      return null;
    },
    async reLaunch() {},
  };
}

const ctx = (session, com, clock, sessionStartMs = 0) => ({ session, com, clock: clock ?? Date.now, sessionStartMs, deltaLimitMs: 500 });

test('happy path：com6Exchange rx+ack 关联 + Δ 断言 + waitPageData', async () => {
  let now = 1000;
  const com = makeFakeCom([
    { tsMs: 1100, event: { ev: 'rx', seq: 5, type: 2, flags: 1, len: 4 } },
    { tsMs: 1150, event: { ev: 'ack', seq: 5 } },
  ]);
  const session = makeFakeSession({ state: 'ready' });
  const steps = [
    { op: 'log', message: 'start' },
    { op: 'com6Exchange', rx: { ev: 'rx', type: 2, flags: 1, len: 4 }, then: [{ ev: 'ack', seq: 'rx' }], timeoutMs: 500 },
    { op: 'waitPageData', expect: { state: 'ready' }, timeoutMs: 200 },
  ];
  const outcomes = await runSteps(ctx(session, com, () => now), steps);
  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every((o) => o.ok));
  assert.ok(outcomes[1].detail.includes('Δ=100ms'), outcomes[1].detail);
  assert.ok(outcomes[1].detail.includes('Δ=150ms'), outcomes[1].detail);
});

test('Δ 超限 → 失败且后续步骤不执行（失败即停）', async () => {
  let now = 1000;
  const com = makeFakeCom([
    { tsMs: 1100, event: { ev: 'rx', seq: 5, type: 2, flags: 1, len: 4 } },
    { tsMs: 1700, event: { ev: 'ack', seq: 5 } }, // Δ=700 > 500
  ]);
  const session = makeFakeSession({ state: 'ready' });
  const steps = [
    { op: 'log', message: 'start' },
    { op: 'com6Exchange', rx: { ev: 'rx', type: 2, flags: 1, len: 4 }, then: [{ ev: 'ack', seq: 'rx' }], timeoutMs: 500 },
    { op: 'waitPageData', expect: { state: 'ready' }, timeoutMs: 200 },
  ];
  const outcomes = await runSteps(ctx(session, com, () => now), steps);
  assert.equal(outcomes.length, 2, '失败即停');
  assert.equal(outcomes[1].ok, false);
  assert.ok(outcomes[1].detail.includes('超过上限'));
});

test('rx 事件缺失 → com6Exchange 失败', async () => {
  let now = 1000;
  const com = makeFakeCom([]);
  const session = makeFakeSession({});
  const steps = [{ op: 'com6Exchange', rx: { ev: 'rx', type: 2, flags: 1, len: 4 }, then: [{ ev: 'ack', seq: 'rx' }], timeoutMs: 80 }];
  const outcomes = await runSteps(ctx(session, com, () => now), steps);
  assert.equal(outcomes[0].ok, false);
  assert.ok(outcomes[0].detail.includes('未等到'));
});

test('com6Count / com6Absent（无重试 / 无风暴断言）', async () => {
  let now = 1000;
  const com = makeFakeCom([
    { tsMs: 1050, event: { ev: 'gap', what: 'connect' } },
    { tsMs: 1060, event: { ev: 'gap', what: 'connect' } },
  ]);
  const session = makeFakeSession({});
  const steps = [
    { op: 'log', message: 'start' },
    { op: 'com6Count', rx: { ev: 'gap', what: 'connect' }, anchor: 'self', withinMs: 100, equals: 2 },
    { op: 'com6Count', rx: { ev: 'gap', what: 'connect' }, anchor: 'self', withinMs: 100, lte: 1 },
    { op: 'com6Absent', rx: { ev: 'ack' }, anchor: 'self', withinMs: 100 },
  ];
  const outcomes = await runSteps(ctx(session, com, () => now), steps);
  assert.equal(outcomes[1].ok, true);
  assert.equal(outcomes[2].ok, false, 'lte=1 但计数 2');
  assert.equal(outcomes.length, 3, '失败即停');
});

test('notifyWait：类型过滤 + expectFields（STATUS 解析）', async () => {
  let now = 1000;
  // STATUS notify：24 字节载荷，brightness=0
  const statusPayload = Buffer.alloc(24);
  statusPayload[12] = 0;
  const session = makeFakeSession(
    {},
    { notifyFrames: [{ tsMs: 1050, hex: makeNotifyFrame(9, statusPayload) }] },
  );
  const steps = [
    { op: 'log', message: 'start' },
    {
      op: 'notifyWait',
      type: 9,
      expectFields: { brightness: 0, powerLimitMa: 0 },
      timeoutMs: 200,
    },
  ];
  const outcomes = await runSteps(ctx(session, makeFakeCom([]), () => now), steps);
  assert.equal(outcomes[1].ok, true, outcomes[1].detail);
});

test('assertPageStatusMatchesNotify：page.data 跟随 notify STATUS', async () => {
  let now = 1000;
  const statusPayload = Buffer.alloc(24);
  statusPayload.writeUInt32LE(100, 0);
  statusPayload.writeInt8(30, 4);
  statusPayload.writeUInt16LE(15000, 13);
  statusPayload[12] = 128;
  statusPayload.writeUInt16LE(1, 8); // glitch
  statusPayload.writeUInt16LE(0, 10); // drop
  const notifyHex = makeNotifyFrame(9, statusPayload);

  const goodPage = {
    status: {
      uptime: '100s',
      temp: '30℃',
      current: '0mA',
      thermal: '正常',
      brightness: '128',
      powerLimit: '15000mA',
      glitch: '1/0',
      drop: '0',
      stripFault: '0x00',
      active: '',
    },
  };
  const sessionOk = makeFakeSession(goodPage, { notifyFrames: [{ tsMs: 1000, hex: notifyHex }] });
  const okOutcomes = await runSteps(ctx(sessionOk, makeFakeCom([]), () => now), [
    { op: 'log', message: 'start' },
    { op: 'assertPageStatusMatchesNotify', timeoutMs: 200 },
  ]);
  assert.equal(okOutcomes[1].ok, true, okOutcomes[1].detail);

  const badPage = { ...goodPage, status: { ...goodPage.status, brightness: '0' } };
  const sessionBad = makeFakeSession(badPage, { notifyFrames: [{ tsMs: 1000, hex: notifyHex }] });
  const badOutcomes = await runSteps(ctx(sessionBad, makeFakeCom([]), () => now), [
    { op: 'log', message: 'start' },
    { op: 'assertPageStatusMatchesNotify', timeoutMs: 200 },
  ]);
  assert.equal(badOutcomes[1].ok, false);
  assert.ok(badOutcomes[1].detail.includes('亮度'));
});

test('waitPageData 超时失败并给出不匹配明细', async () => {
  const session = makeFakeSession({ state: 'fault' });
  const steps = [{ op: 'waitPageData', expect: { state: 'ready' }, timeoutMs: 60 }];
  const outcomes = await runSteps(ctx(session, makeFakeCom([])), steps);
  assert.equal(outcomes[0].ok, false);
  assert.ok(outcomes[0].detail.includes('state'));
});

test('anchor=self / prev 基准正确', async () => {
  let now = 500;
  const com = makeFakeCom([{ tsMs: 560, event: { ev: 'gap', what: 'connect' } }]);
  const session = makeFakeSession({});
  const steps = [
    { op: 'log', message: 'first' }, // startedMs=500
    { op: 'sleep', ms: 1 }, // 推进真实时间，anchor=prev 用它
    { op: 'com6Wait', rx: { ev: 'gap', what: 'connect' }, timeoutMs: 100, deltaLimitMs: 500 }, // anchor=prev≈501
  ];
  const outcomes = await runSteps(ctx(session, com, () => now), steps);
  assert.equal(outcomes[2].ok, true, outcomes[2].detail);
});