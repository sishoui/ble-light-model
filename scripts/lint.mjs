// 静态检查脚本（test-strategy.md §1：CI 每次 push 必绿的「静态检查」一部分）。
// 骨架阶段只做「logic/src 禁用 API」的 grep 约束（miniprogram.md §1）；
// ESLint 与更多规则在执行阶段并入。任何违反即退出非零。
//
// 硬约束：miniprogram/logic/src/** 内禁止出现
//   wx、Page(、Component(、getApp(、App(、DOM、process.env、裸 setTimeout
// 只有 transport/wx-transport.ts、transport/factory.ts、页面与 app.ts 能引用 wx。

import { readFileSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { globSync } = require("./glob.cjs");

const FORBIDDEN = [
  ["wx", /(^|[^\w$])wx\./],
  ["Page(", /Page\s*\(/],
  ["Component(", /Component\s*\(/],
  ["getApp(", /getApp\s*\(/],
  ["App(", /\bApp\s*\(/],
  ["process.env", /process\s*\.\s*env/],
  ["setTimeout", /\bsetTimeout\s*\(/],
];

const logicSrc = join("miniprogram", "logic", "src");
let failed = false;

if (!existsSync(logicSrc)) {
  console.log(`[lint] skip: ${logicSrc} 尚不存在`);
  process.exit(0);
}

const files = globSync(logicSrc);
for (const file of files) {
  const rel = file.split(sep).slice(-3).join("/");
  const text = readFileSync(file, "utf8");
  for (const [name, re] of FORBIDDEN) {
    if (re.test(text)) {
      console.error(`[lint] ${rel}: 出现禁用符号 "${name}"`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("[lint] 违反 logic/src 禁用 API 约束");
  process.exit(1);
}
console.log(`[lint] ok: ${files.length} 个 logic/src 文件通过禁用 API 检查`);