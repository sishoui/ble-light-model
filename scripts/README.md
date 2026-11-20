# 仓库根脚本

| 脚本 | 用途 | 对应 spec |
|---|---|---|
| `gen-site.mjs` | 项目站点生成（读 `project.yaml` → `site/`） | project-site.md §6 |
| `site-preview.mjs` | 本地静态预览 `site/` | project-site.md §6 |
| `run-host-test.mjs` | C core host 单测编排（PIO 缺失时占位跳过） | test-strategy.md §6 |
| `lint.mjs` | logic/src 禁用 API 检查 | miniprogram.md §1 |
| `smoke-cli.mjs` | 层 5 真机冒烟 CLI 入口 | test-strategy.md §1 |
| `glob.cjs` | 零依赖递归 glob（内部工具） | — |

## 状态

骨架阶段：`gen-site.mjs` / `lint.mjs` / `run-host-test.mjs` 已可用；其余为入口占位。