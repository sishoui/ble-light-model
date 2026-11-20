// C core host 单测 runner（test-strategy.md 层 1 C 侧 / §6）。
//
// 退出码：0 全绿 / 1 失败（含：CI 或 --require-host 下未能执行）/ 2 未执行（本机缺 PlatformIO）。
//
// 为什么不能静默绿：层 1 的 C host 单测是 CI 必绿项，纯软件（native 平台），不需要硬件。
// 缺 PlatformIO 是「缺工具链」，不是「硬件不可用」，因此：
//   - 有 PlatformIO（PATH 上的 pio/platformio，或 `python -m platformio` 任一可用）→ 真跑 `pio test -e native`；
//   - 缺 PlatformIO：本机打印 NOT EXECUTED 并退 2（诚实：未执行 ≠ 成功）；
//     CI（env CI=true）或显式 --require-host / REQUIRE_HOST=1 时退 1（红），防止假绿。
//
// 探测顺序顺带修掉一个常见坑：`pip install platformio` 后脚本常不在 PATH，
// 但 `python -m platformio` 可用——这时仍应真跑，而不是跳过。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const firmwareDir = join(__dirname, "..", "firmware");

const argv = process.argv.slice(2);
const requireHost =
  argv.includes("--require-host") ||
  process.env.REQUIRE_HOST === "1" ||
  (process.env.CI || "").toLowerCase() === "true" ||
  process.env.CI === "1";

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

// 解析可用的 PlatformIO 调用：{ cmd, baseArgs } 或 null。
// 先试 PATH 上的 pio / platformio；再试 python 解释器的 `-m platformio`。
function resolvePio() {
  for (const cmd of ["pio", "platformio"]) {
    const p = which(cmd);
    if (p && spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0) {
      return { cmd: p, baseArgs: [] };
    }
  }
  const pyCandidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const py of pyCandidates) {
    const p = which(py);
    if (!p) continue;
    if (spawnSync(p, ["-m", "platformio", "--version"], { encoding: "utf8" }).status === 0) {
      return { cmd: p, baseArgs: ["-m", "platformio"] };
    }
  }
  return null;
}

const pio = resolvePio();
const hasTest = existsSync(join(firmwareDir, "test"));

function notExecuted(reason) {
  if (requireHost) {
    console.error(`[host-test] FAIL: ${reason} —— CI / --require-host 要求层 1 C host 单测必须真跑`);
    process.exit(1);
  }
  console.log(`[host-test] NOT EXECUTED (exit 2): ${reason}；装上 PlatformIO 后重跑（CI 会判红）`);
  process.exit(2);
}

if (!hasTest) notExecuted("firmware/test 尚无 C core 单测");
if (!pio) notExecuted("找不到 PlatformIO（pip install platformio，或把 Python Scripts 加入 PATH）");

if (pio.baseArgs.length > 0) {
  console.log(`[host-test] 使用 ${pio.cmd} ${pio.baseArgs.join(" ")} 运行 native 单测`);
}
const r = spawnSync(pio.cmd, [...pio.baseArgs, "test", "-e", "native"], {
  cwd: firmwareDir,
  stdio: "inherit",
});
process.exit(r.status ?? 1);
