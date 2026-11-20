# tests — 无手机回归（五层金字塔）

五层划分与一条命令边界见 `docs/spec/test-strategy.md`。

```text
tests/
  logic/          # 层 1 Node 单测（vitest，测 @ble-light/logic 的 dist）
  scenarios/      # 共享场景脚本（tests/scenarios/*.json，三 runner 共用，未落地）
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

- 层 1：`tests/logic/` 30 个 vitest 用例全绿；C core host 单测（D1–D16 + 灯效 + 遥测，30 用例）在 `firmware/test/`，走 `pio test -e native`（**不在 `tests/driver/`**）。
- 层 3：`tests/protocol/` 三端对拍（`vectors.json` 20 encode / 17 feed，TS/C/Python 逐字节一致）全绿。
- 层 2/4/5（`page/` `shadow/` 与共享 `scenarios/`）尚未落地，见 `docs/handover.md`。