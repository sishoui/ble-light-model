# 项目管理系统规格

> 状态：已定稿（对应 issue #27）。
> 适用范围：仓库内静态可视化站点，从 `project.yaml` 与测试产物生成，只读、不依赖网络与后端。
> 边界：本文定 `project.yaml` 的 schema、生成器选型、视图清单、CI 与发布流水线、新鲜度约定。模块/流程/里程碑/任务/风险的真源在这份 YAML；测试矩阵的结果来自测试产物（见 `docs/spec/test-strategy.md`）；issue 只在 YAML 里引用编号，站点不做任何抓取。

把「项目管理系统长什么样」钉死成可以直接开工的规格：`project.yaml` 单一真源 + 构建时自动合并测试产物的静态站，部署到 GitHub Pages。

---

## 1. 定论（issue #27 方向）

| 决策 | 结论 |
|---|---|
| 形态 | 仓库内静态可视化站点，只读，构建时生成，不依赖网络与后端 |
| 单一真源 | 仓库根一份 `project.yaml` |
| 生成器 | 纯手写 Node 脚本（`scripts/gen-site.mjs`）+ Mermaid 客户端渲染 |
| 数据来源 | `project.yaml` 手写 + 测试产物（JUnit XML / `result.json`）自动合并 |
| 发布 | GitHub Pages，`push` 到 `master` 时 `GitHub Actions` 源部署 |
| 失败语义 | schema 无效 / 生成脚本报错 = 阻断；测试结果新鲜度 = 从不阻断（用 badge 显示） |
| 新鲜度 | 构建期记 `generated_at` + `source_commit`，落后于代码自动打 badge |

---

## 2. `project.yaml` schema

单一事实源，顶层结构如下。字段约束见 §3 校验规则。

### 2.1 完整示例

```yaml
version: 1
name: BLE Light
description: 8 条 WS2812B 灯带固件 + 微信小程序 + 无手机回归

specs:
  - id: effects
    title: 灯效与交互契约
    path: docs/spec/effects.md
    issue: 21
  - id: protocol
    title: BLE 协议 v1 契约
    path: docs/spec/protocol.md
    issue: 22
  - id: driver
    title: 驱动调度与刷新策略
    path: docs/spec/driver.md
    issue: 24
  - id: miniprogram
    title: 小程序可测性与无手机影子运行
    path: docs/spec/miniprogram.md
    issue: 25
  - id: test-strategy
    title: 测试金字塔与一条命令边界
    path: docs/spec/test-strategy.md
    issue: 26

modules:
  - id: firmware/driver
    name: 驱动调度
    responsibility: 决定哪一条的哪一帧在哪个引脚发送、何时可偷懒
    deps: [firmware/effects]
    code_path: firmware/driver/
  - id: firmware/effects
    name: 灯效引擎
    responsibility: 逐像素灯效算法，含 7 效果与场景持久化
    deps: []
    code_path: firmware/effects/
  - id: app/logic
    name: 小程序逻辑层
    responsibility: DeviceController / BleLink / codec，逻辑与页面解耦
    deps: [firmware/driver]
    code_path: app/src/
  - id: app/page
    name: 小程序页面层
    responsibility: 单设备页渲染 DeviceController 快照
    deps: [app/logic]
    code_path: miniprogram/pages/
  - id: test-harness
    name: 无手机回归
    responsibility: 层 1–5 的统一回归与证据
    deps: [app/logic, firmware/driver]
    code_path: tests/

flows:
  - id: ble-connect
    title: BLE 连接
    sequence: [scan, discover, connect, subscribe, hello, ready]
  - id: set-effect
    title: 点击下发灯效
    sequence: [tap, optimistic, send, ack, rollback-on-nak]
  - id: effect-refresh
    title: 灯效刷新
    sequence: [tick, compute-pixels, encode, schedule, transmit, heartbeat]

milestones:
  - id: spec
    title: 规格定稿
    order: 1
  - id: implement
    title: 三端实现
    order: 2
  - id: regression
    title: 无手机回归
    order: 3
  - id: release
    title: 发布
    order: 4

tasks:
  - id: t1
    milestone: spec
    module: firmware/effects
    title: 灯效契约定稿
    status: done
    issue: 21
  - id: t2
    milestone: spec
    module: firmware/driver
    title: 驱动调度定稿
    status: done
    issue: 24
  - id: t3
    milestone: implement
    module: firmware/driver
    title: C 驱动 + host 单测
    status: in_progress
    issue: null
  - id: t4
    milestone: implement
    module: app/logic
    title: 小程序逻辑 + codec
    status: todo
    issue: null
  - id: t5
    milestone: regression
    module: test-harness
    title: 三端 golden 对拍
    status: todo
    issue: null

risks:
  - id: r1
    title: 30µs 补数窗口无法消除
    severity: high
    mitigation: 上板实测 + 心跳自愈 + glitch_count 遥测
  - id: r2
    title: 页面层无手机只能模拟器
    severity: medium
    mitigation: 注入 FakeTransport + 真机低频人工冒烟
  - id: r3
    title: 分片向量缺口
    severity: medium
    mitigation: 补 >20B 切片向量再对拍

test_matrix:
  rows: [firmware/driver, firmware/effects, app/logic, app/page, test-harness]
  columns: [layer1, layer2, layer3, layer4, layer5]
```

### 2.2 各 section 说明

| section | 手写/合并 | 内容 |
|---|---|---|
| `specs` | 手写 | 关联 `docs/spec/*`，`issue` 引用定稿 issue 编号 |
| `modules` | 手写 | `id / name / responsibility / deps / code_path`，`deps` 驱动依赖图 |
| `flows` | 手写 | `id / title / sequence`，`sequence` 是步骤名字符串数组，驱动时序图 |
| `milestones` | 手写 | `id / title / order`，粗阶段 |
| `tasks` | 手写 | `id / milestone / module / title / status / issue`，细到模块，三态 |
| `risks` | 手写 | `id / title / severity / mitigation` |
| `test_matrix` | 手写骨架 + 合并结果 | 只声明 `rows`（模块 id）与 `columns`（层名），结果构建期注入 |

**关键边界**：只有 `test_matrix` 的结果自动合并；其余全部手写。`task.issue` 只存编号用于深链，站点不做任何抓取。

---

## 3. 校验规则（构建时强制）

生成脚本启动即校验 `project.yaml`，任一违反即退出非零（阻断 CI）：

- `task.status` ∈ `{todo, in_progress, done}`（不加 `blocked`，受阻状态由 `task.issue` 深链呈现）
- `risk.severity` ∈ `{high, medium, low}`，`mitigation` 必填非空
- 所有引用解析成功：`module.deps` → 存在的模块 id；`task.module` / `task.milestone` → 存在的 id；`test_matrix.rows` → 存在的模块 id
- `task.issue` 为 `null` 或正整数（数字）
- `milestones.order` 唯一且连续
- `test_matrix.columns` 引用已知层名（`layer1..layer5`，对应 test-strategy.md 五层）

---

## 4. 数据流

```
project.yaml (手写) ────────────┐
                               ├──> scripts/gen-site.mjs ──> site/ (静态 HTML)
artifacts/latest/ (测试产物) ────┘
  └ result.json / JUnit XML
```

- **谁写 `project.yaml`**：模块/流程/里程碑/风险/任务由人在合并对应 PR 时同步更新（约定：每关一个执行 ticket 顺手改 YAML 里的对应 `task.status` / 里程碑进度）。
- **谁写测试产物**：各测试 runner 按 test-strategy.md §6 落 `artifacts/<utc-runid>/`，构建脚本取其中 `latest/`。
- **防止过期**：§5 新鲜度约定在构建期自动计算并渲染 badge，落后一目了然；`task.status` 的过期由 PR 合并时同步的人驱动约定兜底（非自动）。

---

## 5. 新鲜度约定

构建期计算、渲染进站点，无网络依赖：

- 生成脚本记录 `generated_at`（UTC）与 `source_commit`（构建时 `git HEAD`）。
- 对比三项：
  1. `source_commit` 与当前仓库 `HEAD` —— 落后则整站顶部打黄 badge「落后于 <n> 次提交」。
  2. 各 spec / 模块对应代码路径的最近提交时间 vs 站点构建时间 —— 落后则对应模块打黄 badge「代码已更新」。
  3. 测试矩阵每格的产物时间 vs 站点构建时间 —— 落后超过阈值（默认 7 天）或产物缺失，该格标灰并标注「距上次结果 X 天」。
- 新鲜度**永不阻断 CI**，只做标注。

---

## 6. 生成器选型

- **选纯手写 Node 脚本**：`scripts/gen-site.mjs`，读 `project.yaml` + `artifacts/latest/`，输出 `site/`。
- **依赖预算**：零 build 期依赖。解析 YAML 用一个极小的内置 YAML 子集解析器（本 schema 结构固定、无嵌套歧义，可手写）；Mermaid 由浏览器端加载（CDN 或随产物打包），构建脚本本身无第三方依赖。
- 理由：monorepo Node 20，与现有栈贴合；满足"无网络、无后端、静态、CI 可跑"四条；比 VitePress/Astro（重工具链）轻，比自绘 SVG（每类图手写）省维护。
- npm scripts：`npm run site:build`（生成 `site/`）、`npm run site:preview`（本地静态服务预览，读本地 `artifacts/latest/`，可能全灰）。

---

## 7. 视图清单

三页聚合，图用 Mermaid 客户端渲染，表格/进度用 HTML/CSS。

| 视图 | 内容 | 渲染 |
|---|---|---|
| **总览** | 项目名/描述、specs 列表（深链 issue）、里程碑总进度条、构建时间 + commit + 新鲜度 badge | HTML/CSS |
| **模块与流程** | 模块依赖图（`flowchart`）+ 流程时序图（`sequenceDiagram`） | Mermaid |
| **矩阵与清单** | 测试矩阵（绿/黄/红 + 灰无数据）、里程碑任务进度、待办任务、风险清单 | HTML 表格/CSS |

- 测试矩阵颜色：绿=通过、黄=有失败/重试、红=失败、灰=无数据（缺产物）。
- 里程碑进度：任务完成数 / 总数，细到模块。
- 待办：`task.status != done` 的列表，含模块、里程碑、issue 深链。
- 风险：severity 着色，含 mitigation。
- 所有 `issue: N` 渲染为 `<a href="https://github.com/sishoui/ble-light-model/issues/N">` 深链。

---

## 8. 目录与产物

```
project.yaml              # 仓库根，单一真源
scripts/gen-site.mjs      # 生成器
site/                     # 输出（纯静态，构建产物）
artifacts/latest/         # 最新测试产物（CI 内 / 本地）
```

`site/` 与 `artifacts/` 均进 `.gitignore`（`artifacts/` 已在 test-strategy.md §6 约定 gitignore）。站点是构建产物，不提交 git。

---

## 9. CI 与发布

- **Job**：独立 `site` job（Linux），`push` 到 `master` 时跑，与测试 job 分开。
- **生成**：`npm run site:build`，失败（schema 无效 / 脚本报错）即阻断该工作流。
- **读产物**：site job 读当前工作流已落盘的 `artifacts/latest/`；层 1+3 每次 push 有结果，层 4/5 只在发布前跑 → 缺的层灰显 + 新鲜度标注（§5）。
- **发布**：`actions/upload-pages-artifact` 上传 `site/`，`actions/deploy-pages` 部署。仓库需在 Settings→Pages 把 Source 设为 "GitHub Actions"（公共仓库免费）。
- **失败语义**：schema 无效 / 生成报错 = 阻断；测试结果新鲜度 = 从不阻断（只标注）。

---

## 10. 关联

- `docs/spec/test-strategy.md`（#26）：五层、`result.json`、`artifacts/`、发布门禁、退出码。测试矩阵的列与结果来源在此。
- `docs/spec/miniprogram.md`（#25）：模块 `app/logic` / `app/page` 的契约来源。
- `docs/spec/driver.md`（#24）、`docs/spec/effects.md`（#21）、`docs/spec/protocol.md`（#22）：其余模块与 risks 的语义来源。
- issue #20（地图）：`task.issue` / `specs.issue` 深链到地图与其执行 ticket，站点不抓取。