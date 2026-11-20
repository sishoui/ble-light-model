// 极小的递归 glob（`**/*.ext` 于给定目录），零依赖。只服务 scripts/ 内的骨架脚本。
"use strict";
const { readdirSync, statSync, existsSync } = require("node:fs");
const { join } = require("node:path");

/**
 * @param {string} base 目录
 * @param {string[]} [exts] 只返回这些扩展名
 * @returns {string[]} 绝对路径列表
 */
function globSync(base, exts = [".ts", ".tsx", ".mjs", ".js"]) {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (exts.includes(ent.name.slice(ent.name.lastIndexOf(".")))) out.push(p);
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

module.exports = { globSync };