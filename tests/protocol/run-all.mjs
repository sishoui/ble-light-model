// 三端协议 golden 对拍入口（test-strategy.md §3）。
//
// 层 3 = C / TS / Python 三端对同一份 vectors.json 逐字节一致（encode + feed）。
// 骨架阶段：
//   - 先做「golden 自洽」校验（vectors.json 内部一致性），退出非零即红；
//   - TS 端：执行阶段由 miniprogram/logic 的 codec.ts 复算；
//   - C 端：执行阶段由 firmware/proto 的 host codec 复算（此处探测存在才跑）；
//   - Python 端：执行阶段由 bridge 或 tests/protocol 的 Python 校验工具复算。
// 本脚本只编排与聚合三端结果，不解释帧语义。
//
// 退出码：0 全绿 / 1 有红 / 2 未执行。

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = join(__dirname, "vectors.json");

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
  process.exit(process.exitCode || 1);
}

if (!vectors.meta || !Array.isArray(vectors.encode) || !Array.isArray(vectors.feed)) {
  fail("vectors.json 结构不符（缺 meta/encode/feed）");
} else {
  for (const v of vectors.encode) {
    const b = v.bytes;
    if (b[0] !== 0xaa || b[1] !== 0x55) fail(`${v.name}: magic AA55 不符`);
    const exp = crc16(b.slice(2, b.length - 2));
    const got = b[b.length - 2] | (b[b.length - 1] << 8);
    if (exp !== got) fail(`${v.name}: CRC 不符 (exp ${exp}, got ${got})`);
    if (b.length > 266) fail(`${v.name}: 帧长 ${b.length} > 266`);
  }
}

// ---- TS 端：探测 logic 产物 codec（执行阶段落地后启用） ----
const logicDist = join(__dirname, "..", "..", "miniprogram", "logic", "dist");
let tsResult = "skip";
if (existsSync(join(logicDist, "index.js"))) {
  // 执行阶段：加载 codec 并逐条复算；骨架阶段产物不含 codec，故只记 ok（无 codec 不报错）。
  try {
    const logic = await import(pathToFileURL(join(logicDist, "index.js")).href);
    if (typeof logic.verifyVectors === "function") {
      const r = logic.verifyVectors(vectors);
      if (r !== true) fail(`TS 端对拍: ${r}`);
      else tsResult = "ok";
    } else {
      tsResult = "skip (codec 未落地)";
    }
  } catch (e) {
    fail(`TS 端加载失败: ${e.message}`);
  }
} else {
  tsResult = "skip (logic/dist 未构建)";
}

// ---- C 端：探测 firmware/proto host codec（执行阶段落地后启用） ----
const cRunner = join(__dirname, "run-c.mjs");
let cResult = "skip";
if (existsSync(cRunner)) {
  const r = spawnSync(process.execPath, [cRunner, vectorsPath], { encoding: "utf8" });
  if (r.status !== 0) fail(`C 端对拍失败: ${r.stderr || r.stdout}`);
  else cResult = "ok";
}

// ---- Python 端：探测 bridge 校验工具（执行阶段落地后启用） ----
let pyResult = "skip";
if (process.env.BLE_BRIDGE_VENV) {
  const py = join(process.env.BLE_BRIDGE_VENV, "python");
  const pyRunner = join(__dirname, "check.py");
  if (existsSync(pyRunner)) {
    const r = spawnSync(py, [pyRunner, vectorsPath], { encoding: "utf8" });
    if (r.status !== 0) fail(`Python 端对拍失败: ${r.stderr || r.stdout}`);
    else pyResult = "ok";
  }
}

console.log(`[protocol-vectors] golden 自洽 ok; TS=${tsResult}; C=${cResult}; Python=${pyResult}`);
if (process.exitCode) process.exit(process.exitCode);
process.exit(0);