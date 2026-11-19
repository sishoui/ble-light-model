/**
 * 构建可供 wxa-runner 运行的小程序产物到 `dist/miniprogram/`。
 *
 * wxa-runner 不编译 TypeScript（只加载 .js/.wxml/.wxss/.json），且不提供打包能力，
 * 这里用 tsc 做与开发者工具相同的“仅剥类型”处理（ES2022 ESM，wxa-runner 的 esbuild
 * 会将其转成 CommonJS define 模块），再把 WXML/WXSS/JSON 原样拷贝进产物目录。
 *
 * 产物与开发者工具导入 miniprogram/ 后真机调试的代码一致（同一套源码），不另建
 * 打包流程（spec §3.5）。
 */
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync, copyFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");   // miniprogram/
const distRoot = resolve(root, "..", "dist", "miniprogram");

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function main() {
  const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc");
  const tsconfig = resolve(root, "tsconfig.build.json");
  rmSync(distRoot, { recursive: true, force: true });
  mkdirSync(distRoot, { recursive: true });

  execFileSync(process.execPath, [tsc, "-p", tsconfig], {
    cwd: root,
    stdio: "inherit",
  });

  const assets = [resolve(root, "app.json"), resolve(root, "sitemap.json"), resolve(root, "project.config.json")];
  for (const file of assets) {
    const dest = resolve(distRoot, relative(root, file));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }

  const pagesRoot = resolve(root, "pages");
  for (const file of await walk(pagesRoot)) {
    if (!/\.(wxml|wxss|json)$/.test(file)) continue;
    const dest = resolve(distRoot, relative(root, file));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }

  console.log(`build-dist: ${distRoot} 已生成`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});