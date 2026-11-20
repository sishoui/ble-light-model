// C 端 golden 对拍 runner（test-strategy.md §1 层 3）。
//
// 由 run-all.mjs 以 `node run-c.mjs <vectorsPath>` 调用。
// 本脚本用 Node 读 vectors.json，把「命令构造 / 字节流」通过参数和 stdin 交给
// 一个只处理字节的 C host 二进制（tests/protocol/c_host_main.c + firmware/proto/src/ble_proto.c），
// C 二进制输出结果文本，Node 与期望逐字节比对。C 端不解析 JSON。
//
// C host 文本协议：
//   encode <seq> <type> <flags> <strip_mask> <hex|->
//     -> 输出一行整帧 hex
//   feed（从 stdin 读行，直到 EOF）：
//     <now_ms> <hex>   喂入一块字节
//     TICK <now_ms>    推进时间
//     -> 逐行输出事件：
//        FRAME <ver> <seq> <type> <flags> <mask> <param_len> <hexpayload> [APPLIED <id> <hexparams>]
//        NAK <hexbytes>
//        ACK <seq> <hexbytes>
//        STATUS
//        SCENE
//        DISCARD
//
// 退出码：0 全绿 / 1 有差异或编译失败 / 2 无 C 编译器（明确 SKIP）。

import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..");

const vectorsPath = process.argv[2] ? resolve(process.argv[2]) : join(__dirname, "vectors.json");
const includeDir = join(root, "firmware", "proto", "include");
const protoSrc = join(root, "firmware", "proto", "src", "ble_proto.c");
const hostSrc = join(__dirname, "c_host_main.c");

function fail(msg) {
  console.error(`[c] FAIL: ${msg}`);
  process.exit(1);
}

// ---- 编译器探测 ----
function findCompiler() {
  const candidates = [];
  if (process.env.CC) candidates.push(process.env.CC);
  candidates.push("cc", "gcc", "clang");
  for (const cc of candidates) {
    const r = spawnSync(cc, ["--version"], { encoding: "utf8", timeout: 15000 });
    if (r.status === 0) return cc;
  }
  return null;
}

const cc = findCompiler();
if (!cc) {
  console.error("[c] SKIP: no C compiler found (tried $CC, cc, gcc, clang)");
  process.exit(2);
}
if (!existsSync(protoSrc) || !existsSync(hostSrc)) {
  fail(`缺少 C 源: ${existsSync(protoSrc) ? "" : protoSrc} ${existsSync(hostSrc) ? "" : hostSrc}`.trim());
}

// ---- 编译到临时目录 ----
const buildDir = mkdtempSync(join(tmpdir(), "ble-proto-c-"));
const exe = join(buildDir, process.platform === "win32" ? "ble_proto_host.exe" : "ble_proto_host");
const compileArgs = [
  "-std=c99",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  `-I${includeDir}`,
  "-o",
  exe,
  hostSrc,
  protoSrc,
];
const built = spawnSync(cc, compileArgs, { encoding: "utf8" });
if (built.status !== 0) {
  console.error(`[c] SKIP? compile failed with ${cc}`);
  console.error(built.stderr || built.stdout || "");
  rmSync(buildDir, { recursive: true, force: true });
  process.exit(1);
}

// ---- JSON 读取（仅 Node 侧） ----
let vectors;
try {
  vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
} catch (e) {
  fail(`vectors.json 无法解析: ${e.message}`);
}

const hex = (arr) => Buffer.from(arr).toString("hex").toUpperCase();
const parseHex = (s) => {
  if (s === "-" || s.length === 0) return Buffer.alloc(0);
  if (s.length % 2 !== 0) throw new Error(`odd hex length: ${s}`);
  return Buffer.from(s, "hex");
};
const B0 = (n) => n & 0xff;

function runEncode(cmd) {
  const r = spawnSync(
    exe,
    ["encode", String(cmd.seq), String(cmd.type), String(cmd.flags), String(cmd.stripMask), hex(cmd.payload)],
    { encoding: "utf8", timeout: 15000 },
  );
  if (r.status !== 0) fail(`encode 调用失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function runFeed(chunks, tickAt) {
  const lines = [];
  for (const c of chunks) lines.push(`0 ${hex(c)}`);
  if (tickAt !== undefined) lines.push(`TICK ${tickAt}`);
  const r = spawnSync(exe, ["feed"], { input: lines.join("\n") + "\n", encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) fail(`feed 调用失败: ${r.stderr || r.stdout}`);
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseEvent);
}

function parseEvent(line) {
  const t = line.split(/\s+/);
  switch (t[0]) {
    case "FRAME": {
      const frame = {
        ver: Number(t[1]),
        seq: Number(t[2]),
        type: Number(t[3]),
        flags: Number(t[4]),
        strip_mask: Number(t[5]),
        param_len: Number(t[6]),
        payload: Array.from(parseHex(t[7] ?? "-")),
      };
      const a = t.indexOf("APPLIED");
      if (a >= 0) {
        frame.applied = { effect_id: Number(t[a + 1]), params: Array.from(parseHex(t[a + 2] ?? "-")) };
      }
      return { kind: "frame", frame };
    }
    case "NAK":
      return { kind: "nak", bytes: Array.from(parseHex(t[1] ?? "-")) };
    case "ACK":
      return { kind: "ack", seq: Number(t[1]), bytes: Array.from(parseHex(t[2] ?? "-")) };
    case "STATUS":
      return { kind: "status" };
    case "SCENE":
      return { kind: "scene" };
    case "DISCARD":
      return { kind: "discard" };
    default:
      throw new Error(`未知 C 事件行: ${line}`);
  }
}

// ---- 简易整帧构造（只用于校验 ACK 字节；C 输出必须与它逐字节一致） ----
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
function buildFrame({ seq = 0, type, flags = 0, stripMask = 0, payload = [] }) {
  const body = [1, B0(seq), B0(seq >> 8), B0(type), B0(flags), B0(stripMask), B0(payload.length), ...payload.map(B0)];
  const crc = crc16(body);
  return [0xaa, 0x55, ...body, B0(crc), B0(crc >> 8)];
}
const ackBytes = (seq) => buildFrame({ type: 0x07, seq, payload: [B0(seq), B0(seq >> 8)] });

function firstDiff(name, label, got, exp) {
  const a = Array.isArray(got) ? got : Array.from(got);
  const b = Array.isArray(exp) ? exp : Array.from(exp);
  if (a.length !== b.length) return `${name}: ${label} 长度 ${a.length} != ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return `${name}: ${label}[${i}] ${a[i]} != ${b[i]}`;
  }
  return null;
}

let failures = 0;
function report(msg) {
  if (failures === 0) console.error(`[c] FAIL: ${msg}`);
  failures++;
}

// ---- encode 向量 ----
let encCount = 0;
for (const v of vectors.encode ?? []) {
  const name = v.name ?? "?";
  try {
    const bytes = v.bytes;
    if (!Array.isArray(bytes) || bytes.length < 11) throw new Error("bytes 缺失或过短");
    const paramLen = bytes[8];
    if (bytes.length !== 9 + paramLen + 2) throw new Error(`整帧长度 ${bytes.length} != 9+${paramLen}+2`);
    // chunks 自洽：拼接 == bytes，切片 20，非末块必须恰 20。
    if (Array.isArray(v.chunks) && v.chunks.length > 0) {
      const flat = v.chunks.flat();
      const d = firstDiff(name, "chunks 拼接", flat, bytes);
      if (d) throw new Error(d);
      for (let i = 0; i < v.chunks.length; i++) {
        const n = v.chunks[i].length;
        if (n === 0 || n > 20) throw new Error(`chunks[${i}] 长度 ${n} 不在 1..20`);
        if (i + 1 < v.chunks.length && n !== 20) throw new Error(`chunks[${i}] 非末块长度 ${n} != 20`);
      }
    }
    const cmd = {
      seq: bytes[3] | (bytes[4] << 8),
      type: bytes[5],
      flags: bytes[6],
      stripMask: bytes[7],
      payload: bytes.slice(9, 9 + paramLen),
    };
    const gotHex = runEncode(cmd);
    const expHex = hex(bytes);
    if (gotHex.toUpperCase() !== expHex) throw new Error(`encode 输出 ${gotHex} != ${expHex}`);
    encCount++;
  } catch (e) {
    report(`${name}: ${e.message}`);
    break;
  }
}

// ---- feed 向量 ----
let feedCount = 0;
for (const v of vectors.feed ?? []) {
  const name = v.name ?? "?";
  try {
    const expect = v.expect ?? {};
    const events = runFeed(v.chunks ?? [], expect.discard === true ? 201 : undefined);
    const frames = events.filter((e) => e.kind === "frame");
    const naks = events.filter((e) => e.kind === "nak");
    const expFrames = expect.frames ?? [];
    const expNaks = expect.naks ?? [];

    if (frames.length !== expFrames.length) throw new Error(`frames 数量 ${frames.length} != ${expFrames.length}`);
    for (let i = 0; i < frames.length; i++) {
      const got = frames[i].frame;
      const exp = expFrames[i];
      const names = ["ver", "seq", "type", "flags", "strip_mask", "param_len"];
      const a = [exp.ver, exp.seq, exp.type, exp.flags, exp.strip_mask, exp.param_len];
      const b = [got.ver, got.seq, got.type, got.flags, got.strip_mask, got.param_len];
      for (let k = 0; k < a.length; k++) {
        if (a[k] !== b[k]) throw new Error(`frames[${i}].${names[k]} ${b[k]} != ${a[k]}`);
      }
      const d = firstDiff(name, `frames[${i}].payload`, got.payload, exp.payload);
      if (d) throw new Error(d);
      const expApp = exp.applied;
      const gotApp = got.applied;
      if ((expApp === undefined) !== (gotApp === undefined)) throw new Error(`frames[${i}] applied 存在性不符`);
      if (expApp && gotApp) {
        if (expApp.effect_id !== gotApp.effect_id) {
          throw new Error(`frames[${i}] applied.effect_id ${gotApp.effect_id} != ${expApp.effect_id}`);
        }
        const d2 = firstDiff(name, `frames[${i}].applied.params`, gotApp.params, expApp.params);
        if (d2) throw new Error(d2);
      }
    }

    if (naks.length !== expNaks.length) throw new Error(`naks 数量 ${naks.length} != ${expNaks.length}`);
    for (let i = 0; i < naks.length; i++) {
      const d = firstDiff(name, `naks[${i}]`, naks[i].bytes, expNaks[i]);
      if (d) throw new Error(d);
    }

    if (expect.discard === true) {
      if (!events.some((e) => e.kind === "discard")) throw new Error("期望 discard，未触发");
    }

    const replyStr = expect.reply;
    if (replyStr) {
      const acks = events.filter((e) => e.kind === "ack");
      const statuses = events.filter((e) => e.kind === "status");
      const scenes = events.filter((e) => e.kind === "scene");
      if (replyStr.startsWith("ACK")) {
        const expAckCount = /twice/.test(replyStr) ? 2 : frames.length;
        if (acks.length !== expAckCount) throw new Error(`ACK 数 ${acks.length} != ${expAckCount}`);
        for (const ack of acks) {
          if (!frames.some((f) => f.frame.seq === ack.seq)) throw new Error(`ACK seq ${ack.seq} 不在已解析帧内`);
          const d = firstDiff(name, `ACK seq=${ack.seq} 字节`, ack.bytes, ackBytes(ack.seq));
          if (d) throw new Error(d);
        }
      } else if (replyStr.startsWith("STATUS")) {
        if (statuses.length < 1) throw new Error("期望 STATUS 应答，未生成");
      } else if (replyStr.startsWith("SCENE")) {
        if (scenes.length < 1) throw new Error("期望 SCENE 应答，未生成");
      }
    }
    feedCount++;
  } catch (e) {
    report(`${name}: ${e.message}`);
    break;
  }
}

rmSync(buildDir, { recursive: true, force: true });

if (failures > 0) process.exit(1);
console.log(`[c] ok: ${encCount} encode + ${feedCount} feed vectors (C99, ${cc})`);
process.exit(0);
