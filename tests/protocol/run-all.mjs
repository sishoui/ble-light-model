// 三端协议 golden 对拍入口（test-strategy.md §1 层 3）。
//
// 层 3 = C / TS / Python 三端对同一份 vectors.json 逐字节一致（encode + feed）。
//   - TS：miniprogram/logic/dist 的 verifyVectors（必须先 npm run build:logic）；
//   - C ：tests/protocol/run-c.mjs 编译 firmware/proto 后真对拍；
//   - Python：tests/protocol/check.py 独立复算。
// 本脚本只编排与聚合三端结果，不解释帧语义。
//
// 退出码：0 全绿 / 1 有红。C/Python 缺少工具链时明确 SKIP（不误红）；
// CI 环境（CI=true）下不允许 SKIP，因为层 3 验收要求三端真跑。
//
// 定位（test-strategy.md §5）：
//   只有一端不一致 -> 该端 codec bug（对照该条向量）；
//   三端一致但用例红 -> 向量或 spec 错。

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const vectorsPath = join(__dirname, "vectors.json");
const strict = process.env.CI === "true" || process.env.CI === "1";

function fail(msg) {
  console.error(`[protocol-vectors] FAIL: ${msg}`);
  process.exitCode = 1;
}

// ---- golden 自洽校验：每 encode.bytes 的 CRC、magic、长度与 meta 定义一致 ----
function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= (b & 0xff) << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

let vectors;
try {
  vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
} catch (e) {
  fail(`vectors.json 无法解析: ${e.message}`);
  process.exit(1);
}

if (!vectors.meta || !Array.isArray(vectors.encode) || !Array.isArray(vectors.feed)) {
  fail("vectors.json 结构不符（缺 meta/encode/feed）");
} else {
  for (const v of vectors.encode) {
    const b = v.bytes;
    if (!Array.isArray(b) || b.length < 11) {
      fail(`${v.name}: bytes 缺失或过短`);
      continue;
    }
    if (b[0] !== 0xaa || b[1] !== 0x55) fail(`${v.name}: magic AA55 不符`);
    const exp = crc16(b.slice(2, b.length - 2));
    const got = b[b.length - 2] | (b[b.length - 1] << 8);
    if (exp !== got) fail(`${v.name}: CRC 不符 (exp ${exp}, got ${got})`);
    if (b.length > 266) fail(`${v.name}: 帧长 ${b.length} > 266`);
    if (b.length !== 9 + b[8] + 2) fail(`${v.name}: 帧长与 param_len 不符`);
  }
}

// ---- TS 端：必须真跑，不可 skip ----
const logicDist = join(root, "miniprogram", "logic", "dist", "index.js");
let tsResult = "FAIL";
try {
  if (!existsSync(logicDist)) {
    fail("TS 端: miniprogram/logic/dist 未构建，先 npm run build:logic");
  } else {
    const logic = await import(pathToFileURL(logicDist).href);
    if (typeof logic.verifyVectors !== "function") {
      fail("TS 端: dist 未导出 verifyVectors");
    } else {
      const r = logic.verifyVectors(vectors);
      if (r !== true) fail(`TS 端对拍: ${r}`);
      else tsResult = "ok";
    }
  }
} catch (e) {
  fail(`TS 端加载失败: ${e.message}`);
}

// ---- C 端：run-c.mjs 真编译 firmware/proto 并复算 ----
let cResult = "FAIL";
const cRunner = join(__dirname, "run-c.mjs");
if (!existsSync(cRunner)) {
  fail("C 端: 缺少 tests/protocol/run-c.mjs");
} else {
  const r = spawnSync(process.execPath, [cRunner, vectorsPath], { encoding: "utf8" });
  if (r.status === 0) {
    cResult = "ok";
  } else if (r.status === 2) {
    cResult = "skip (无 C 编译器)";
    if (strict) fail("C 端: CI 下不允许 skip（需要 cc/gcc/clang）");
    else console.warn("[protocol-vectors] WARN: C 端 skip（本机无 C 编译器，CI 会真跑）");
  } else {
    fail(`C 端对拍失败:\n${(r.stderr || r.stdout || "").trim()}`);
  }
}

// ---- Python 端：优先 venv / $PYTHON，再探测系统解释器 ----
function pythonCandidates() {
  const out = [];
  if (process.env.PYTHON) out.push({ cmd: process.env.PYTHON, args: [] });
  if (process.env.BLE_BRIDGE_VENV) {
    const venv = process.env.BLE_BRIDGE_VENV;
    const names =
      process.platform === "win32"
        ? ["Scripts/python.exe", "python.exe", "bin/python", "python"]
        : ["bin/python", "python3", "python"];
    for (const rel of names) out.push({ cmd: join(venv, rel), args: [] });
  }
  out.push({ cmd: "python3", args: [] });
  out.push({ cmd: "python", args: [] });
  out.push({ cmd: "py", args: ["-3"] });
  return out;
}

function findPython() {
  for (const c of pythonCandidates()) {
    const r = spawnSync(c.cmd, [...c.args, "--version"], { encoding: "utf8", timeout: 15000 });
    if (r.status === 0) return c;
  }
  return null;
}

let pyResult = "FAIL";
const pyRunner = join(__dirname, "check.py");
const py = findPython();
if (!py) {
  pyResult = "skip (无 Python 解释器)";
  if (strict) fail("Python 端: CI 下不允许 skip（setup-python 应提供 python3）");
  else console.warn("[protocol-vectors] WARN: Python 端 skip（本机无解释器，CI 会真跑）");
} else if (!existsSync(pyRunner)) {
  fail("Python 端: 缺少 tests/protocol/check.py");
} else {
  const r = spawnSync(py.cmd, [...py.args, pyRunner, vectorsPath], { encoding: "utf8" });
  if (r.status === 0) pyResult = "ok";
  else fail(`Python 端对拍失败:\n${(r.stderr || r.stdout || "").trim()}`);
}

console.log(
  `[protocol-vectors] golden 自洽 ok; ${vectors.encode.length} encode + ${vectors.feed.length} feed; ` +
    `TS=${tsResult}; C=${cResult}; Python=${pyResult}`,
);
if (process.exitCode) process.exit(process.exitCode);
process.exit(0);
