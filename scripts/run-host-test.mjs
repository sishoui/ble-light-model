// C core host 单测 runner（test-strategy.md 层 1 C 侧 / §6）。
// 骨架阶段 firmware/driver + effects 尚无真测试，此脚本只负责编排：
//   - PlatformIO 存在且 firmware/platformio.ini 有 `test` 目录 → 跑 `pio test -e native`；
//   - 否则打印一行明确结论并退 0（占位可绿）。退出码 0 绿 / 1 失败 / 2 未执行。
//
// 注意：骨架的占位可绿不能掩盖「真测试没跑」。CI 的 firmware-host-test job 里
// PlatformIO 必然存在，跑的是真测试；本机无 PIO 时 `npm test` 才走占位跳过。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const firmwareDir = join(__dirname, "..", "firmware");

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

const pio = which("pio") || which("platformio");
const hasTest = existsSync(join(firmwareDir, "test"));

if (!pio) {
  console.log("[host-test] SKIPPED: PlatformIO 未安装（占位可绿；CI 会装并跑真测试）");
  process.exit(0);
}
if (!hasTest) {
  console.log("[host-test] SKIPPED: firmware/test 尚无 C core 单测（占位可绿；执行阶段落地）");
  process.exit(0);
}

const r = spawnSync(pio, ["test", "-e", "native"], { cwd: firmwareDir, stdio: "inherit" });
process.exit(r.status ?? 1);