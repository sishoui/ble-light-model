/**
 * 取证目录（spec §3.4 产物 + §4 失败定位）：
 * - 成功：runs/<scenario>-<UTCstamp>/summary.json；
 * - 失败：另落 failure.json（失败步骤 + page.data 快照 + §4 提示）、console.log、
 *   serial_raw.log（原始串口）、events.jsonl（解析 JSONL）、notify_timeline.json
 *   （BLE notify hex + 解码）、page_snapshots.json。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { decodeFrame } from './protocol.mjs';

export function createRunDir(rootDir, scenarioId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dir = path.join(rootDir, `${scenarioId}-${stamp}`);
  let n = 2;
  while (existsSync(dir)) {
    dir = path.join(rootDir, `${scenarioId}-${stamp}-${n}`);
    n += 1;
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function notifyTimeline(session) {
  return session.notifyFrames.map((nf) => {
    const decoded = decodeFrame(nf.hex);
    return {
      tsMs: nf.tsMs,
      hex: nf.hex,
      ...(decoded.ok
        ? {
            type: decoded.frame.type,
            typeName: decoded.frame.typeName,
            seq: decoded.frame.seq,
            stripMask: decoded.frame.stripMask,
            payloadHex: decoded.frame.payloadHex,
          }
        : { decodeError: decoded.error }),
    };
  });
}

/** 成功：只留 summary。 */
export function dumpSummary(dir, summary) {
  writeJson(path.join(dir, 'summary.json'), summary);
}

/** 失败：failure.json + 全量证据（automator console / COM6 / notify / page.data 快照）。 */
export function dumpFailure(dir, { summary, failure }) {
  writeJson(path.join(dir, 'summary.json'), summary);
  const {
    scenario,
    repeatIndex,
    outcomes,
    snapshots,
    session,
    com,
    consoleLogs,
    runLog,
    error,
    pageDataSnapshot = null,
  } = failure;

  const failedIdx = outcomes.findIndex((o) => !o.ok);
  const failed = failedIdx >= 0 ? outcomes[failedIdx] : null;

  writeJson(path.join(dir, 'failure.json'), {
    scenario,
    repeatIndex,
    failedStepIndex: failedIdx >= 0 ? failedIdx : null,
    failedStep: failed ? { op: failed.op, desc: failed.desc, detail: failed.detail } : null,
    steps: outcomes.map((o) => ({
      index: o.index,
      op: o.op,
      desc: o.desc,
      ok: o.ok,
      detail: o.detail,
      durationMs: o.endedMs - o.startedMs,
    })),
    pageDataSnapshot,
    error,
    hint: failureHint({ failed, com, consoleLogs }),
  });

  writeFileSync(path.join(dir, 'console.log'), (consoleLogs ?? []).map((c) => `${new Date(c.tsMs).toISOString()} [${c.type}] ${safeArgs(c.args)}`).join('\n'), 'utf8');
  writeFileSync(
    path.join(dir, 'serial_raw.log'),
    (com?.lines ?? []).map((r) => `${r.tsMs}\t${new Date(r.tsWall).toISOString()}\t${r.raw}`).join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'events.jsonl'),
    (com?.parsedEvents() ?? []).map((r) => JSON.stringify({ tsMs: r.tsMs, tsWall: r.tsWall, event: r.event })).join('\n'),
    'utf8',
  );
  writeJson(path.join(dir, 'notify_timeline.json'), notifyTimeline(session ?? { notifyFrames: [] }));
  writeJson(path.join(dir, 'page_snapshots.json'), snapshots ?? {});
  if (runLog) writeFileSync(path.join(dir, 'run.log'), runLog.join('\n'), 'utf8');
}

function safeArgs(args) {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** §4 分层定位提示（automator 日志 + 小程序 console + COM6 JSONL 三方时间线）。 */
export function failureHint({ failed, com, consoleLogs }) {
  const lines = com?.lines ?? [];
  const rxEvents = (com?.parsedEvents() ?? []).filter((r) => r.event.ev === 'rx');
  const detail = failed ? failed.detail : '';
  if (lines.length === 0) {
    return '串口无任何输出：检查 USB CDC 连接（设备管理器确认 COM6 / --port 覆盖）与 C3 供电。';
  }
  if (rxEvents.length === 0 && /rx|SET_|写/.test(detail)) {
    return '串口有输出但全程无 RX 事件：§4 口径——串口无帧 → BLE 空口 / 固件（检查手机蓝牙、C3 广播、GATT 服务）。';
  }
  if (/超过上限/.test(detail)) {
    return 'Δ 超时：串口日志排空延迟（console 任务 100ms flush）或 C3 高负载；慢机可放宽 --delta-limit-ms。';
  }
  if (/未等到/.test(detail) && /rx/.test(detail)) {
    return '未等到 rx 事件：写指令没到 C3 —— 检查手机侧 BLE 写（RSP 订阅 / MTU 分片 / 连接态）。';
  }
  if (/未等到/.test(detail) && /ack/i.test(detail)) {
    return 'RX 在但未等到 ACK：检查 RSP 订阅（CCCD）或固件 ACK 发送路径。';
  }
  if (/page\.data/.test(detail) && rxEvents.length > 0) {
    return '串口有帧但 page.data 状态不符：§4 口径——串口有帧但 UI 状态错 → 小程序逻辑层。';
  }
  const consoleErrors = (consoleLogs ?? []).filter((c) => c.type === 'error').length;
  if (consoleErrors > 0) {
    return `console 有 ${consoleErrors} 条 error（见 console.log）；结合失败步骤 detail 判断 UI / 逻辑层。`;
  }
  return '见 failure.json 的步骤 detail 与 notify_timeline.json（三方时间线对照）。';
}