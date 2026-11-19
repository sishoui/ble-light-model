import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// spec §1.1：miniprogram/logic/** 是纯 TS，禁止引用微信运行时。
// 这里只查容易漏的引用形式；真正的全局变量约束由 tsc 与 review 兜底。
const forbidden = [
  { name: "wx.* API", pattern: /\bwx\s*\./ },
  { name: "Page()/Component()", pattern: /\b(?:Page|Component)\s*\(/ },
  { name: "getApp()", pattern: /\bgetApp\s*\(/ },
  { name: "import ... from 'wx'", pattern: /\bfrom\s+["']wx["']/ },
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logicDir = path.join(root, "logic");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const files = await walk(logicDir);
const violations = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { name, pattern } of forbidden) {
      if (pattern.test(line)) {
        const relative = path.relative(root, file).replaceAll("\\", "/");
        violations.push(`${relative}:${index + 1}: ${name}: ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("miniprogram/logic 禁止引用微信运行时（spec §1.1）：");
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  process.exit(1);
}

console.log(
  `purity OK: ${files.length} 个 TS 文件，未发现 wx / Page / Component / getApp 引用`,
);