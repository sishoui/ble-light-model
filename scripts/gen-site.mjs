// 项目站点生成器（project-site.md §6）。
// 骨架阶段：解析 project.yaml（零依赖的内置 YAML 子集解析器），做 §3 校验规则的
// 关键项，输出 site/index.html（占位版）。执行阶段在此扩展三页视图与 Mermaid。
// 失败（schema 无效 / 脚本报错）即退出非零（阻断 CI 的 site job）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const projectYaml = join(root, "project.yaml");
const siteDir = join(root, "site");

// ---- 极小的内置 YAML 子集解析器：只服务本项目固定 schema（无嵌套歧义） ----
// 支持：顶层 `key: value`、顶层 `key:` 开列表、列表项 `- key: value`、
//       后续缩进 `key: value` 行并入当前列表项。本 schema 均为单行标量。
function parseYaml(text) {
  const out = {};
  let section = null;
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    const listMatch = line.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (listMatch) {
      if (!Array.isArray(out[section])) out[section] = [];
      current = { [listMatch[1]]: scalar(listMatch[2]) };
      out[section].push(current);
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) throw new Error(`无法解析: ${line}`);
    if (indent === 0) {
      // 顶层 section 头：列表项之后不再并入旧 current
      current = null;
      section = kv[1];
      out[section] = kv[2] ? scalar(kv[2]) : [];
    } else if (current) {
      current[kv[1]] = scalar(kv[2]);
    }
  }
  return out;
}

function scalar(s) {
  s = s.trim();
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  return s;
}

let yaml;
try {
  if (!existsSync(projectYaml)) {
    console.error("[gen-site] 缺 project.yaml（单一真源）");
    process.exit(1);
  }
  yaml = parseYaml(readFileSync(projectYaml, "utf8"));
} catch (e) {
  console.error(`[gen-site] project.yaml 解析失败: ${e.message}`);
  process.exit(1);
}

// ---- §3 校验规则（骨架先做关键子集；完整规则执行阶段补全） ----
let valid = true;
const problems = [];
if (!yaml.version || !yaml.name) problems.push("缺 version / name");
const statusSet = new Set(["todo", "in_progress", "done"]);
const severitySet = new Set(["high", "medium", "low"]);
for (const t of yaml.tasks || []) {
  if (!statusSet.has(t.status)) problems.push(`task ${t.id}: status 非法 "${t.status}"`);
  if (t.issue != null && !Number.isInteger(t.issue)) problems.push(`task ${t.id}: issue 必须为 null 或正整数`);
}
for (const r of yaml.risks || []) {
  if (!severitySet.has(r.severity)) problems.push(`risk ${r.id}: severity 非法 "${r.severity}"`);
  if (!r.mitigation) problems.push(`risk ${r.id}: 缺 mitigation`);
}
if (problems.length) {
  valid = false;
  console.error("[gen-site] project.yaml 校验失败:");
  for (const p of problems) console.error("  - " + p);
}

// ---- 生成占位站 ----
const generatedAt = new Date().toISOString();
let html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>BLE Light 项目站（骨架）</title>
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}</style>
</head><body>
<h1>${escapeHtml(yaml.name || "BLE Light")}</h1>
<p class="muted">骨架站点。构建时间 ${generatedAt}；specs ${(yaml.specs || []).length}，tasks ${(yaml.tasks || []).length}。</p>
<h2>Specs</h2><table><tr><th>id</th><th>title</th><th>issue</th></tr>`;
for (const s of yaml.specs || []) {
  html += `<tr><td>${escapeHtml(s.id)}</td><td>${escapeHtml(s.title)}</td><td>${s.issue ? `<a href="https://github.com/sishoui/ble-light-model/issues/${s.issue}">#${s.issue}</a>` : ""}</td></tr>`;
}
html += `</table><h2>Tasks</h2><table><tr><th>id</th><th>title</th><th>milestone</th><th>status</th></tr>`;
for (const t of yaml.tasks || []) {
  html += `<tr><td>${escapeHtml(t.id)}</td><td>${escapeHtml(t.title)}</td><td>${escapeHtml(t.milestone)}</td><td>${escapeHtml(t.status)}</td></tr>`;
}
html += `</table></body></html>`;

mkdirSync(siteDir, { recursive: true });
writeFileSync(join(siteDir, "index.html"), html);
console.log(`[gen-site] ${valid ? "ok" : "WARN(校验不过)"} 已生成 site/index.html @ ${generatedAt}`);
if (!valid) process.exit(1);
process.exit(0);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}