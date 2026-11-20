# 仓库根脚本

| 脚本 | 用途 | 对应 spec |
|---|---|---|
| `gen-site.mjs` | 项目站点生成（读 `project.yaml` → `site/`） | project-site.md §6 |
| `site-preview.mjs` | 本地静态预览 `site/` | project-site.md §6 |
| `run-host-test.mjs` | C core host 单测编排（探测 `pio` / `platformio` / `python -m platformio`；缺工具链时本机退 2、CI/`--require-host` 退 1） | test-strategy.md §6 |
| `lint.mjs` | logic/src 禁用 API 检查 | miniprogram.md §1 |
| `smoke-cli.mjs` | 层 5 真机冒烟 CLI 入口 | test-strategy.md §1 |
| `glob.cjs` | 零依赖递归 glob（内部工具） | — |

## 状态

`lint.mjs`、`run-host-test.mjs`（fail-closed）、`protocol-vectors` 相关脚本已可用；`gen-site.mjs` 仍产出占位站点（项目站点实现待落地），`site-preview.mjs` / `smoke-cli.mjs` 为入口占位（层 2/5 未实现）。