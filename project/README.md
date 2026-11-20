# project — 项目站点输入

仓库内静态项目管理系统（issue #27, `docs/spec/project-site.md`）。

- 单一真源：仓库根 `project.yaml`（不是本目录内）。
- 生成器：`scripts/gen-site.mjs` → 输出 `site/`（构建产物，gitignore）。
- 三页视图：总览 / 模块与流程 / 矩阵与清单（执行阶段扩展）。

## 状态

骨架阶段：`project.yaml` 就位、`gen-site.mjs` 输出占位站可绿；完整三页视图与新鲜度 badge 在执行阶段落地。