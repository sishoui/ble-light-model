/**
 * 场景步骤执行器（data-driven，可注入假 session/com/clock 用于单测）。
 *
 * 失败即停（不重试）：第一个失败的步骤立即中断，后续步骤不再执行。
 * 每个步骤记录 {index, op, desc, startedMs, endedMs, ok, detail, evidence}。
 *
 * step.op 合法取值见 validateStep。
 */

import { checkDelta, describeSpec, matchProblems, measureDeltaMs } from './assert.mjs';
import { ackSeq, decodeFrame, nakSeqErr, parseHelloPayload, parseStatusPayload, TYPE_NAMES } from './protocol.mjs';
import { createInterface } from 'node:readline';

export class StepAssertionError extends Error {}

const STEP_OPS = new Set([
  'reLaunch',
  'tap',
  'tapAt',
  'callMethod',
  'sleep',
  'log',
  'waitPageData',
  'assertPageData',
  'assertElement',
  'com6Wait',
  'com6Exchange',
  'com6Count',
  'com6Absent',
  'notifyWait',
  'notifyCount',
  'assertPageStatusMatchesNotify',
  'human',
  'snapshot',
  'consoleClean',
]);

/** 判断 step 对象是否合法；失败抛 StepAssertionError（可被 validateSteps 逐条收集）。 */
export function validateStep(step, index) {
  const problems = [];
  if (!step || typeof step !== 'object') return [`步骤 ${index} 不是对象`];
  const { op } = step;
  if (!op || !STEP_OPS.has(op)) problems.push(`步骤 ${index}: 未知 op "${op}"`);
  const require = (field) => {
    if (step[field] === undefined || step[field] === '') problems.push(`步骤 ${index}(${op}): 缺少必填字段 ${field}`);
  };
  const requireNumber = (field, min = 0) => {
    if (typeof step[field] !== 'number' || step[field] < min) problems.push(`步骤 ${index}(${op}): ${field} 必须是 ≥${min} 的数字`);
  };
  const requireObject = (field) => {
    if (!step[field] || typeof step[field] !== 'object' || Array.isArray(step[field]))
      problems.push(`步骤 ${index}(${op}): ${field} 必须是普通对象`);
  };
  switch (op) {
    case 'reLaunch':
      break;
    case 'tap':
    case 'tapAt':
      require('selector');
      if (op === 'tapAt' && typeof step.index !== 'number') problems.push(`步骤 ${index}(${op}): index 必须是数字`);
      break;
    case 'callMethod':
      require('method');
      break;
    case 'sleep':
      requireNumber('ms', 0);
      break;
    case 'log':
      require('message');
      break;
    case 'waitPageData':
      requireObject('expect');
      requireNumber('timeoutMs', 0);
      break;
    case 'assertPageData':
      requireObject('expect');
      break;
    case 'assertElement':
      require('selector');
      if (step.state !== undefined && step.state !== 'disabled' && step.state !== 'enabled') {
        problems.push(`步骤 ${index}(${op}): state 只能是 disabled / enabled`);
      }
      break;
    case 'com6Wait':
    case 'com6Exchange':
      requireObject('rx');
      requireNumber('timeoutMs', 0);
      if (op === 'com6Exchange' && (!Array.isArray(step.then) || step.then.length === 0)) {
        problems.push(`步骤 ${index}(${op}): then 必须是非空数组`);
      }
      break;
    case 'com6Count':
      requireObject('rx');
      requireNumber('withinMs', 0);
      if (step.equals === undefined && step.lte === undefined && step.gte === undefined) {
        problems.push(`步骤 ${index}(${op}): 需要 equals / lte / gte 中至少一个`);
      }
      break;
    case 'com6Absent':
      requireObject('rx');
      requireNumber('withinMs', 0);
      break;
    case 'notifyWait':
      require('type');
      requireNumber('timeoutMs', 0);
      break;
    case 'notifyCount':
      requireObject('rx');
      requireNumber('withinMs', 0);
      break;
    case 'assertPageStatusMatchesNotify':
      requireNumber('timeoutMs', 0);
      break;
    case 'human':
      require('instruction');
      break;
    case 'snapshot':
      require('label');
      break;
    case 'consoleClean':
      break;
    default:
      break; // 未知 op 已在上面统一报
  }
  if (step.anchor !== undefined && step.anchor !== 'self' && step.anchor !== 'prev' && step.anchor !== 'sessionStart' && typeof step.anchor !== 'number') {
    problems.push(`步骤 ${index}(${op}): anchor 必须是 'self' | 'prev' | 'sessionStart' | 步骤序号`);
  }
  return problems;
}

/** 批量校验所有步骤；返回问题清单（空 = 合法）。 */
export function validateSteps(steps) {
  const problems = [];
  if (!Array.isArray(steps) || steps.length === 0) return ['steps 必须是非空数组'];
  for (let i = 0; i < steps.length; i += 1) {
    for (const p of validateStep(steps[i], i)) problems.push(p);
  }
  return problems;
}

function describeStep(step) {
  const base = `${step.op}${step.desc ? ' [' + step.desc + ']' : ''}`;
  return base;
}

/** 计算锚点时刻（Δ / afterMs 的基准）。默认 'prev'（上一步开始时刻）。 */
function anchorMs(step, state, fallback, defaultAnchor = 'prev') {
  const a = step.anchor ?? defaultAnchor;
  if (a === 'self') return state.clock();
  if (a === 'sessionStart') return state.sessionStartMs ?? fallback;
  if (typeof a === 'number') {
    const ref = state.outcomes[a];
    if (!ref) throw new StepAssertionError(`步骤 ${state.i}: anchor=${a} 不存在`);
    return ref.startedMs;
  }
  // 'prev'：上一步的开始时刻；不存在则用自身开始时刻
  const prev = state.outcomes[state.outcomes.length - 1];
  return prev ? prev.startedMs : fallback;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到 pred 为真或超时；返回最后一次 pred 返回的值。 */
async function waitUntil(pred, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (true) {
    try {
      last = await pred();
    } catch {
      last = null;
    }
    if (last) return last;
    if (Date.now() >= deadline) return last;
    await sleepMs(intervalMs);
  }
}

/** 执行单个步骤；成功返回 detail 字符串，失败抛 StepAssertionError。 */
export async function executeStep(ctx, step, state) {
  const { session, com } = ctx;
  const anchorFallback = Date.now();

  switch (step.op) {
    case 'reLaunch':
      await session.reLaunch(step.path || '/pages/index/index');
      return `页面重启 ${step.path || '/pages/index/index'}`;

    case 'tap':
      await session.tap(step.selector);
      return `tap(${step.selector})`;

    case 'tapAt':
      await session.tapAt(step.selector, step.index);
      return `tap(${step.selector}[${step.index}])`;

    case 'callMethod': {
      const result = await session.callMethod(step.method, ...(step.args ?? []));
      return `callMethod(${step.method}) -> ${JSON.stringify(result)}`;
    }

    case 'sleep':
      await sleepMs(step.ms);
      return `sleep(${step.ms}ms)`;

    case 'log':
      return step.message;

    case 'waitPageData': {
      const data = await waitUntil(
        async () => {
          const d = await session.currentPageData();
          const problems = matchProblems(d, step.expect);
          return problems.length === 0 ? d : null;
        },
        step.timeoutMs,
      );
      if (!data) {
        const d = await session.currentPageData();
        throw new StepAssertionError(matchProblems(d, step.expect).join('；'));
      }
      return `page.data ✓`;
    }

    case 'assertPageData': {
      const d = await session.currentPageData();
      const problems = matchProblems(d, step.expect);
      if (problems.length > 0) throw new StepAssertionError(problems.join('；'));
      return `page.data ✓`;
    }

    case 'assertElement': {
      const el = await session.element(step.selector);
      if (!el) throw new StepAssertionError(`元素 ${step.selector} 不存在`);
      if (step.state !== undefined) {
        const attr = step.attribute ? await el.attribute(step.attribute) : null;
        const disabled = attr !== null && attr !== '' && attr !== 'false';
        const wantDisabled = step.state === 'disabled';
        if (disabled !== wantDisabled) {
          throw new StepAssertionError(`元素 ${step.selector} disabled=${attr} 期望 ${step.state}`);
        }
      }
      return `element ${step.selector} ✓`;
    }

    case 'com6Wait': {
      const anchor = anchorMs(step, state, anchorFallback);
      const spec = { ...step.rx, afterMs: anchor - 1 };
      const rec = await waitUntil(() => com.findEvent(spec), step.timeoutMs, 50);
      if (!rec) throw new StepAssertionError(`COM6 未等到事件 ${describeSpec(spec)}`);
      const delta = measureDeltaMs(anchor, rec.tsMs);
      const deltaProblem = checkDelta(delta, step.deltaLimitMs ?? ctx.deltaLimitMs);
      if (deltaProblem) throw new StepAssertionError(`${describeSpec(spec)} ${deltaProblem}`);
      return `${describeSpec(spec)} Δ=${Math.round(delta)}ms`;
    }

    case 'com6Exchange': {
      const anchor = anchorMs(step, state, anchorFallback);
      const rxSpec = { ...step.rx, afterMs: anchor - 1 };
      const rxRec = await waitUntil(() => com.findEvent(rxSpec), step.timeoutMs, 50);
      if (!rxRec) throw new StepAssertionError(`COM6 未等到触发事件 ${describeSpec(rxSpec)}`);
      let detail = `${describeSpec(rxSpec)} Δ=${Math.round(measureDeltaMs(anchor, rxRec.tsMs))}ms`;
      let rxSeq = rxRec.event.seq;
      for (const entry of step.then) {
        const entryTimeout = entry.timeoutMs ?? step.timeoutMs;
        const entrySpec = {
          ...entry,
          seq: entry.seq === 'rx' ? rxSeq : entry.seq,
          afterMs: anchor - 1,
        };
        const rec = await waitUntil(() => com.findEvent(entrySpec), entryTimeout, 50);
        if (!rec) throw new StepAssertionError(`COM6 未等到 ${describeSpec(entrySpec)}`);
        const delta = measureDeltaMs(anchor, rec.tsMs);
        const deltaLimit = entry.deltaLimitMs ?? step.deltaLimitMs ?? ctx.deltaLimitMs;
        const deltaProblem = checkDelta(delta, deltaLimit);
        if (deltaProblem) throw new StepAssertionError(`${describeSpec(entrySpec)} ${deltaProblem}`);
        detail += `；${describeSpec(entrySpec)} Δ=${Math.round(delta)}ms`;
        if (entry.seqSource === 'rx') rxSeq = rec.event.seq;
      }
      return detail;
    }

    case 'com6Count': {
      const anchor = anchorMs(step, state, anchorFallback);
      const beforeMs = step.withinMs ? anchor + step.withinMs : undefined;
      const spec = { ...step.rx, afterMs: anchor - 1, beforeMs };
      const n = com.countEvents(spec);
      let ok;
      if (step.equals !== undefined) ok = n === step.equals;
      else if (step.lte !== undefined) ok = n <= step.lte;
      else ok = n >= step.gte;
      if (!ok) throw new StepAssertionError(`COM6 计数 ${describeSpec(spec)} = ${n} 不满足期望`);
      return `COM6 计数 ${describeSpec(spec)} = ${n}`;
    }

    case 'com6Absent': {
      const anchor = anchorMs(step, state, anchorFallback);
      const beforeMs = anchor + step.withinMs;
      const spec = { ...step.rx, afterMs: anchor - 1, beforeMs };
      const rec = com.findEvent(spec);
      if (rec) throw new StepAssertionError(`COM6 不应出现事件 ${describeSpec(spec)}（已出现 ${rec.tsMs}ms）`);
      return `COM6 无事件 ${describeSpec(spec)}（窗口 ${step.withinMs}ms）`;
    }

    case 'notifyWait': {
      const anchorKind = step.anchor ?? 'sessionStart';
      const anchor = anchorMs(step, state, anchorFallback, 'sessionStart');
      const notifyFrames = session.notifyFrames;
      let matched = null;
      const rec = await waitUntil(
        () => {
          for (let i = 0; i < notifyFrames.length; i += 1) {
            const nf = notifyFrames[i];
            if (nf.tsMs < anchor - 1) continue;
            const decoded = decodeFrame(nf.hex);
            if (!decoded.ok || decoded.frame.type !== step.type) continue;
            if (step.seq !== undefined && decoded.frame.seq !== step.seq) continue;
            if (step.payloadPrefix !== undefined && !decoded.frame.payloadHex.startsWith(step.payloadPrefix)) continue;
            matched = { nf, decoded };
            return nf;
          }
          return null;
        },
        step.timeoutMs,
        100,
      );
      if (!rec) throw new StepAssertionError(`notify 未等到 ${TYPE_NAMES[step.type] ?? step.type} 帧`);
      // sessionStart 锚点是“是否收到过”语义，Δ 无意义；只有动作锚点才断言 Δ。
      const deltaLimit = step.deltaLimitMs ?? (anchorKind === 'sessionStart' ? null : ctx.deltaLimitMs);
      const delta = measureDeltaMs(anchor, rec.tsMs);
      const deltaProblem = checkDelta(delta, deltaLimit);
      if (deltaProblem) throw new StepAssertionError(`notify ${TYPE_NAMES[step.type] ?? step.type} ${deltaProblem}`);
      if (step.expectFields) {
        const { decoded } = matched;
        let parsed;
        if (step.type === 9) parsed = parseStatusPayload(decoded.frame.payloadHex);
        else if (step.type === 1) parsed = parseHelloPayload(decoded.frame.payloadHex);
        else if (step.type === 7) parsed = { seq: ackSeq(decoded.frame) };
        else if (step.type === 8) parsed = nakSeqErr(decoded.frame);
        if (parsed === null || parsed === undefined) throw new StepAssertionError(`notify 帧解析失败（长度不符）`);
        const problems = matchProblems(parsed, step.expectFields);
        if (problems.length > 0) throw new StepAssertionError(problems.join('；'));
      }
      return `notify ${TYPE_NAMES[step.type] ?? step.type} ✓ hex=${rec.hex}`;
    }

    case 'notifyCount': {
      const anchor = anchorMs(step, state, anchorFallback, 'sessionStart');
      const beforeMs = step.withinMs ? anchor + step.withinMs : undefined;
      const type = step.rx.type;
      let n = 0;
      for (const nf of session.notifyFrames) {
        if (nf.tsMs < anchor - 1 || (beforeMs !== undefined && nf.tsMs > beforeMs + 1)) continue;
        const decoded = decodeFrame(nf.hex);
        if (decoded.ok && decoded.frame.type === type) n += 1;
      }
      let ok;
      if (step.equals !== undefined) ok = n === step.equals;
      else if (step.lte !== undefined) ok = n <= step.lte;
      else ok = n >= step.gte;
      if (!ok) throw new StepAssertionError(`notify ${TYPE_NAMES[type] ?? type} 计数 = ${n} 不满足期望`);
      return `notify ${TYPE_NAMES[type] ?? type} 计数 = ${n}`;
    }

    case 'assertPageStatusMatchesNotify': {
      // 页面 data 状态应与 notify 里最新一条 STATUS 一致（通知刷新跟随）。
      const statusFrames = [];
      for (const nf of session.notifyFrames) {
        const decoded = decodeFrame(nf.hex);
        if (decoded.ok && decoded.frame.type === 9) {
          const st = parseStatusPayload(decoded.frame.payloadHex);
          if (st) statusFrames.push({ tsMs: nf.tsMs, ...st });
        }
      }
      const last = statusFrames[statusFrames.length - 1];
      if (!last) throw new StepAssertionError('尚未收到任何 notify STATUS 帧');
      const d = await session.currentPageData();
      const pageStatus = d.status;
      if (!pageStatus) throw new StepAssertionError('page.data.status 为空（页面未收到 STATUS）');
      const problems = [];
      if (String(pageStatus.brightness) !== String(last.brightness)) {
        problems.push(`亮度: page.data=${pageStatus.brightness} notify=${last.brightness}`);
      }
      if (String(pageStatus.powerLimit) !== `${last.powerLimitMa}mA`) {
        problems.push(`限流: page.data=${pageStatus.powerLimit} notify=${last.powerLimitMa}mA`);
      }
      if (String(pageStatus.temp) !== `${last.tempC}℃`) {
        problems.push(`温度: page.data=${pageStatus.temp} notify=${last.tempC}℃`);
      }
      if (String(pageStatus.glitch).split('/')[0] !== String(last.glitchCount)) {
        problems.push(`毛刺: page.data=${pageStatus.glitch} notify=${last.glitchCount}`);
      }
      if (problems.length > 0) throw new StepAssertionError(problems.join('；'));
      return `page.data.status 与 notify STATUS 一致（brightness=${last.brightness}）`;
    }

    case 'human': {
      await waitForEnter(step.instruction, step.timeoutMs);
      return `人工确认：${step.instruction}`;
    }

    case 'snapshot': {
      const d = await session.currentPageData();
      ctx.snapshots = ctx.snapshots || {};
      ctx.snapshots[step.label] = { tsMs: Date.now(), data: d };
      return `page.data 快照：${step.label}`;
    }

    case 'consoleClean': {
      const logs = session.consoleLogs;
      const problems = [];
      for (const lg of logs) {
        if (lg.type === 'error') {
          problems.push(`console error: ${safeArgs(lg.args)}`);
        }
        for (const pat of step.forbid ?? []) {
          const re = pat instanceof RegExp ? pat : new RegExp(pat);
          if (safeArgs(lg.args).search(re) >= 0) problems.push(`console 命中禁忌 ${pat}: ${safeArgs(lg.args)}`);
        }
      }
      if (problems.length > 0) throw new StepAssertionError(problems.join('；'));
      return `console 干净（${logs.length} 条日志，无领域错误）`;
    }

    default:
      throw new StepAssertionError(`未实现的 op ${step.op}`);
  }
}

function safeArgs(args) {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** 交互式等待人工确认（stdin TTY）；非 TTY 直接失败并给清晰提示。 */
async function waitForEnter(instruction, timeoutMs) {
  process.stdout.write(`\n>>> [人工操作] ${instruction}\n    完成后在本终端按回车继续…\n`);
  return new Promise((resolve, reject) => {
    if (!process.stdin || !process.stdin.isTTY) {
      reject(new StepAssertionError(`human 步骤需要交互式终端（TTY）：${instruction}`));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      rl.close();
      err ? reject(err) : resolve();
    };
    rl.once('line', () => finish(null));
    if (timeoutMs) setTimeout(() => finish(new StepAssertionError(`等待人工操作超时（${timeoutMs}ms）：${instruction}`)), timeoutMs);
  });
}

/**
 * 跑完整场景：顺序执行步骤，第一个失败即停（不重试）。
 *
 * ctx: { session, com, clock?, deltaLimitMs?, snapshots? }
 * state.i 用于 anchor 报错；state.outcomes 被外部填充（此处由 runSteps 传入）。
 */
export async function runSteps(ctx, steps, label) {
  const outcomes = [];
  const state = { i: -1, clock: ctx.clock ?? Date.now, sessionStartMs: ctx.sessionStartMs, outcomes };
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const rec = {
      index: i,
      op: step.op,
      desc: describeStep(step),
      startedMs: state.clock(),
      endedMs: null,
      ok: false,
      detail: '',
    };
    try {
      const detail = await executeStep(ctx, step, { i, outcomes, clock: state.clock, sessionStartMs: state.sessionStartMs });
      rec.ok = true;
      rec.detail = detail;
    } catch (e) {
      rec.ok = false;
      rec.detail = e.message || String(e);
      rec.error = e;
    }
    rec.endedMs = state.clock();
    outcomes.push(rec);
    if (!rec.ok) break; // 失败即停（不重试）
  }
  return outcomes;
}