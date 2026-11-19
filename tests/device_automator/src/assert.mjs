/**
 * 断言纯逻辑（无 I/O、无时钟——调用方把输入显式传入，便于 Node 单测）。
 *
 * 断言口径（spec §3.4）：
 * - page.data 只断公开 data（路径子集匹配，允许 actual 有多余字段）；
 * - element.attribute 只断可访问性 / 状态类（disabled / visible）；
 * - console 只断领域错误出现 / 不出现（runner 侧）；
 * - COM6 事件级断言：seq 关联 + Δ（默认 500ms，连接 / 重连放宽 5s）。
 */

/** 期望值的迷你 DSL（嵌在 page.data 期望里）： */
export const OP = {
  /** 字符串包含子串 / 数组包含元素（元素再走 deepMatch）。 */
  includes: 'includes',
  /** actual 匹配 values 中任意一个。 */
  oneOf: 'oneOf',
  /** 数值下界 / 上界。 */
  gte: 'gte',
  lte: 'lte',
};

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof RegExp);
}

/** 取点路径值：'status.brightness' / 'lanes.0'。 */
export function getPath(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * 深度子集匹配：
 * - 期望 RegExp：actual 为字符串且命中；
 * - 期望 {__op:'includes'|'oneOf'|'gte'|'lte', ...}：按操作符匹配；
 * - 期望数组：长度一致且逐元素匹配；
 * - 期望普通对象：actual 逐键子集匹配（actual 多余字段允许）；
 * - 其余：Object.is。
 */
export function deepMatch(actual, expected) {
  if (expected instanceof RegExp) {
    return typeof actual === 'string' && expected.test(actual);
  }
  if (isPlainObject(expected) && typeof expected.__op === 'string') {
    switch (expected.__op) {
      case OP.includes:
        if (typeof actual === 'string') return actual.includes(String(expected.value));
        if (Array.isArray(actual)) return actual.some((el) => deepMatch(el, expected.value));
        return false;
      case OP.oneOf:
        return expected.values.some((v) => deepMatch(actual, v));
      case OP.gte:
        return typeof actual === 'number' && actual >= expected.value;
      case OP.lte:
        return typeof actual === 'number' && actual <= expected.value;
      default:
        return false;
    }
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => deepMatch(actual[i], v))
    );
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every((k) => deepMatch(actual[k], expected[k]));
  }
  return Object.is(actual, expected);
}

function fmt(v) {
  if (v instanceof RegExp) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 计算 page.data 期望的不匹配清单（空数组 = 全部通过）。
 * path 支持点路径（'status.brightness'）。
 */
export function matchProblems(pageData, expect) {
  const problems = [];
  if (!isPlainObject(expect)) return ['期望必须是普通对象（键为 page.data 路径）'];
  for (const path of Object.keys(expect)) {
    const actual = getPath(pageData, path);
    const expected = expect[path];
    if (!deepMatch(actual, expected)) {
      problems.push(`page.data.${path}: 期望 ${fmt(expected)} 实际 ${fmt(actual)}`);
    }
  }
  return problems;
}

/** Δ 计算口径（PC 单调时钟在设备侧换成本机 Date.now()，同一时钟域）。 */
export function measureDeltaMs(anchorMs, tsMs) {
  return tsMs - anchorMs;
}

/** Δ 断言：超限返回问题描述，否则 null。deltaLimitMs 为空表示不检查。 */
export function checkDelta(deltaMs, deltaLimitMs) {
  if (deltaLimitMs === null || deltaLimitMs === undefined) return null;
  return deltaMs > deltaLimitMs ? `Δ=${Math.round(deltaMs)}ms 超过上限 ${deltaLimitMs}ms` : null;
}

/**
 * COM6 事件匹配：record = { tsMs, event }；spec 支持
 * ev / seq / type / flags / len / what / err / afterMs / beforeMs。
 */
export function matchEvent(record, spec) {
  if (!record.event) return false;
  const ev = record.event;
  if (spec.ev !== undefined && ev.ev !== spec.ev) return false;
  if (spec.seq !== undefined && ev.seq !== spec.seq) return false;
  for (const k of ['type', 'flags', 'len', 'what', 'err']) {
    if (spec[k] !== undefined && ev[k] !== spec[k]) return false;
  }
  if (spec.afterMs !== undefined && record.tsMs < spec.afterMs) return false;
  if (spec.beforeMs !== undefined && record.tsMs > spec.beforeMs) return false;
  return true;
}

/** 把 spec 渲染成人类可读片段（失败证据用）。 */
export function describeSpec(spec) {
  const parts = [];
  if (spec.ev !== undefined) parts.push(`ev=${spec.ev}`);
  if (spec.type !== undefined) parts.push(`type=0x${spec.type.toString(16).padStart(2, '0')}`);
  if (spec.flags !== undefined) parts.push(`flags=${spec.flags}`);
  if (spec.len !== undefined) parts.push(`len=${spec.len}`);
  if (spec.what !== undefined) parts.push(`what=${spec.what}`);
  if (spec.err !== undefined) parts.push(`err=0x${spec.err.toString(16)}`);
  if (spec.seq !== undefined) parts.push(`seq=${spec.seq}`);
  return parts.join(' ');
}