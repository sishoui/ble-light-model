#!/usr/bin/env node
/**
 * 真机 automator 入口（工单 #18，spec §3.4）：miniprogram-automator + COM6 断言，
 * 跑真机场景 1–6。不进 CI、不重试、等人。
 *
 * 用法示例：
 *   node run.js --list
 *   node run.js --dry-run --scenario write_effects
 *   node run.js --scenario cold_start --repeat 3
 *   node run.js --scenario disconnect_reconnect --repeat 3 --remote qr
 *   node run.js --scenario failure_path --port COM6 --delta-limit-ms 800
 *
 * 退出码：0 全过 / 1 场景断言失败 / 2 环境或 harness 失败（等人处理）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunDir, dumpFailure, dumpSummary } from './src/evidence.mjs';
import { runSteps, validateSteps } from './src/runner.mjs';
import { getScenario, listScenarios } from './src/scenarios.mjs';
import { connectSession } from './src/session.mjs';
import { ComLog, DEFAULT_PORT, discoverEspPort } from './src/serial.mjs';

const DEFAULT_WS_ENDPOINT = 'ws://127.0.0.1:9420';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNS_DIR = path.join(HERE, 'runs');

function parseArgs(argv) {
  const args = {
    scenario: 'cold_start',
    repeat: 1,
    wsEndpoint: DEFAULT_WS_ENDPOINT,
    port: DEFAULT_PORT,
    remote: 'auto',
    deltaLimitMs: 500,
    dryRun: false,
    list: false,
    runsDir: DEFAULT_RUNS_DIR,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 缺少取值`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--scenario': args.scenario = next(); break;
      case '--repeat': args.repeat = Number(next()); break;
      case '--ws-endpoint': args.wsEndpoint = next(); break;
      case '--port': args.port = next(); break;
      case '--remote': args.remote = next(); break;
      case '--delta-limit-ms': args.deltaLimitMs = Number(next()); break;
      case '--runs-dir': args.runsDir = next(); break;
      case '--dry-run': args.dryRun = true; break;
      case '--list': args.list = true; break;
      case '-h':
      case '--help': args.help = true; break;
      default: throw new Error(`未知参数 ${a}（--help 查看用法）`);
    }
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error('--repeat 必须是 ≥1 的整数');
  if (!Number.isFinite(args.deltaLimitMs) || args.deltaLimitMs <= 0) throw new Error('--delta-limit-ms 必须是正数');
  if (!['auto', 'qr', 'off'].includes(args.remote)) throw new Error('--remote 只能是 auto / qr / off');
  return args;
}

function printHelp() {
  process.stdout.write(
    `真机 automator（#18，spec §3.4）——手机 ↔ C3 全链路 6 场景\n\n` +
      `用法: node run.js [选项]\n\n` +
      `  --scenario <id>       场景 id（--list 查看全部；默认 cold_start）\n` +
      `  --repeat <n>          连跑次数（场景 1/2/4 验收门槛用 3；失败即停）\n` +
      `  --ws-endpoint <url>   automator 端口（默认 ${DEFAULT_WS_ENDPOINT}）\n` +
      `  --port <COM>           C3 串口（默认 ${DEFAULT_PORT}；auto=按 USB VID 0x303A 发现）\n` +
      `  --remote auto|qr|off  remote 模式（默认 auto；qr=打印二维码供扫码；off=复用已建立会话）\n` +
      `  --delta-limit-ms <n>  COM6 Δ 上限 ms（默认 500；连接 / 重连步骤固定放宽 5s）\n` +
      `  --runs-dir <path>     取证目录（默认 tests/device_automator/runs）\n` +
      `  --dry-run             只校验场景配置并打印计划，不连硬件\n` +
      `  --list / --help\n\n` +
      `退出码: 0 全过 / 1 场景断言失败 / 2 环境或 harness 失败（等人处理）\n`,
  );
}

async function connectSerial(port) {
  let portName = port;
  if (portName === 'auto') {
    try {
      portName = await discoverEspPort();
    } catch (e) {
      throw new Error(`串口自动发现失败：${e.message}\n请检查 C3 已接入，或用 --port <COMx> 指定。`);
    }
  }
  const com = await ComLog.open({ portName }).catch((e) => {
    throw new Error(`打开串口 ${portName} 失败：${e.message}\n请在设备管理器确认 COM 口号（缺少驱动？C3 USB CDC 为 Espressif VID 0x303A）。`);
  });
  return com;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n（--help 查看用法）\n`);
    return 2;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.list) {
    process.stdout.write('可用场景（spec §3.4 表）：\n');
    for (const s of listScenarios()) {
      process.stdout.write(`  ${s.id.padEnd(18)} ${s.title}  步骤数=${s.steps}${s.gate ? '  [连跑门槛：--repeat 3]' : ''}\n`);
    }
    return 0;
  }

  const scenario = getScenario(args.scenario);
  if (!scenario) {
    process.stderr.write(`未知场景 ${args.scenario}；可用：${listScenarios().map((s) => s.id).join(', ')}\n`);
    return 2;
  }

  const stepProblems = validateSteps(scenario.steps);
  if (stepProblems.length > 0) {
    process.stderr.write(`场景配置校验失败：\n  - ${stepProblems.join('\n  - ')}\n`);
    return 2;
  }

  if (args.dryRun) {
    process.stdout.write(`[dry-run] 场景 ${scenario.id}（${scenario.title}）配置合法，共 ${scenario.steps.length} 步：\n`);
    for (const s of scenario.steps) process.stdout.write(`  ${s.op} ${s.selector ?? s.method ?? s.rx?.ev ?? ''}\n`);
    return 0;
  }

  const runStartWall = Date.now();
  const runLog = [];
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    runLog.push(line);
    process.stdout.write(line + '\n');
  };

  let com;
  try {
    com = await connectSerial(args.port);
  } catch (e) {
    process.stderr.write(`[env] ${e.message}\n`);
    return 2;
  }
  log(`COM 串口打开：${com.portName}`);

  let session;
  try {
    session = await connectSession({
      wsEndpoint: args.wsEndpoint,
      remoteMode: args.remote,
      log,
    });
  } catch (e) {
    log(`[env] automator 会话建立失败：${e.message}`);
    await com.close();
    return 2;
  }

  // 逐场景运行：失败即停（不重试）
  const ctx = {
    session,
    com,
    deltaLimitMs: args.deltaLimitMs,
    clock: Date.now,
  };
  const repeats = [];
  let overallOk = true;
  let failedRepeat = null;
  let connectionClosed = false;

  for (let r = 1; r <= args.repeat && overallOk && !connectionClosed; r += 1) {
    ctx.sessionStartMs = Date.now();
    log(`--- 第 ${r}/${args.repeat} 轮：${scenario.id} ---`);
    const repeatStartWall = Date.now();
    try {
      const outcomes = await runSteps(ctx, scenario.steps);
      const ok = outcomes.length === scenario.steps.length && outcomes.every((o) => o.ok);
      repeats.push({
        index: r,
        ok,
        startedWall: new Date(repeatStartWall).toISOString(),
        durationMs: Date.now() - repeatStartWall,
        steps: outcomes.map((o) => ({
          index: o.index,
          op: o.op,
          desc: o.desc,
          ok: o.ok,
          detail: o.detail,
          durationMs: o.endedMs - o.startedMs,
        })),
      });
      log(`第 ${r} 轮 ${ok ? '通过' : '失败'}：${outcomes.length}/${scenario.steps.length} 步`);
      if (!ok) {
        // 'Connection closed' 不重试、等人：记录后跳出循环，统一走失败落盘、退出码 2
        const closed = outcomes.find((o) => !o.ok && /Connection closed|automator 会话断开/i.test(o.detail));
        failedRepeat = repeats[repeats.length - 1];
        if (closed) {
          connectionClosed = true;
          log(`[env] automator 会话断开：${closed.detail}`);
          continue;
        }
        overallOk = false;
      }
    } catch (e) {
      // harness 级错误（如 Connection closed）：不重试，等人
      log(`[env] 第 ${r} 轮 harness 错误：${e.message}`);
      await com.close();
      await session.close().catch(() => {});
      return 2;
    }
  }

  const runDir = createRunDir(args.runsDir, scenario.id);
  const summary = {
    ok: overallOk && !connectionClosed,
    scenario: scenario.id,
    scenarioTitle: scenario.title,
    startedWall: new Date(runStartWall).toISOString(),
    durationMs: Date.now() - runStartWall,
    repeat: args.repeat,
    repeats,
    config: {
      wsEndpoint: args.wsEndpoint,
      port: com.portName,
      remote: args.remote,
      deltaLimitMs: args.deltaLimitMs,
    },
    evidenceDir: path.relative(HERE, runDir),
  };

  if (overallOk && !connectionClosed) {
    // 成功留 summary（运行过程中已全部断言）
    dumpSummary(runDir, summary);
    log(`全部通过：${runDir}/summary.json`);
    await session.close().catch(() => {});
    await com.close().catch(() => {});
    return 0;
  }

  // 失败：落全量证据（automator 日志 + console + COM6 JSONL + page.data 快照）
  let pageDataSnapshot = null;
  try {
    pageDataSnapshot = await session.currentPageData();
  } catch {
    pageDataSnapshot = null;
  }
  dumpFailure(runDir, {
    summary,
    failure: {
      scenario: scenario.id,
      repeatIndex: failedRepeat.index,
      outcomes: failedRepeat.steps,
      snapshots: {},
      session,
      com,
      consoleLogs: session.consoleLogs,
      runLog,
      pageDataSnapshot,
    },
  });
  log(`失败证据：${runDir}/failure.json`);
  await session.close().catch(() => {});
  await com.close().catch(() => {});
  return connectionClosed ? 2 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`run.js 内部错误: ${e && e.stack ? e.stack : e}\n`);
    process.exit(2);
  },
);