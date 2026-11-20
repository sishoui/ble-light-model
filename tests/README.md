# tests — 无手机回归（五层金字塔）

五层划分与一条命令边界见 `docs/spec/test-strategy.md`。

```text
tests/
  logic/          # 层 1 Node 单测（vitest，测 @ble-light/logic 的 dist）
  driver/         # 层 1 C core host 单测（firmware/[env:native]，D1–D16）
  scenarios/      # 共享场景脚本（tests/scenarios/*.json，三 runner 共用）
  shadow/         # 层 4 Node 影子跑（PcBleTransport + 真桥 + 真 C3）
  page/           # 层 2 miniprogram-automator（开发者工具模拟器，不进 Linux CI）
  protocol/       # 层 3 三端 golden（vectors.json + generate_vectors.mjs + run-all.mjs）
```

## 命令

| 命令 | 层 | 环境 |
|---|---|---|
| `npm test` | 1 + 3（含 host） | 任意，永远干净 Linux 可绿 |
| `npm run test:page` | 2 | Windows + 开发者工具 |
| `npm run test:hw` | 4 | Windows + 真机 + 桥 |
| `npm run test:smoke` | 5 | 人工 |
| `npm run protocol-vectors` | 3 | 任意 |

证据统一落 `artifacts/<utc-runid>/`（gitignore），见 test-strategy.md §6。

## 状态

骨架阶段：`tests/logic/placeholder.test.ts` 与 `tests/protocol/run-all.mjs`（golden 自洽校验）可绿；其余目录在执行阶段落地。