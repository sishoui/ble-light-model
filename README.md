# BLE Light 模型

8×100 WS2812B 灯带系统（ESP32-C3 固件 + 原生微信小程序 + 无手机回归）+ 仓库内静态项目站点。monorepo。

## 顶层布局

| 路径 | 内容 |
|---|---|
| `firmware/` | ESP32-C3 固件（ESP-IDF v5.5.3 + PlatformIO），`driver/` `effects/` `proto/` `ports/` |
| `miniprogram/` | 原生微信小程序 + 共享逻辑层（`logic/` workspace） |
| `tests/` | 五层无手机回归（logic / driver / scenarios / shadow / page / protocol） |
| `project/` | 项目站点输入（单一真源 `project.yaml` 在仓库根） |
| `scripts/` | 根脚本（site 生成、lint、host-test 编排、preview、smoke CLI） |
| `docs/spec/` | 六份定稿 spec（effects / protocol / driver / miniprogram / test-strategy / project-site） |
| `docs/adr/` | 架构决策记录 |
| `research/` | 调研与事实核查 |
| `bridge/` | PC 蓝牙桥（Python bleak，stdio JSONL） |

## 一条命令

```bash
npm install     # 装 root 与 workspace 依赖（Node 20）
npm test        # 层 1 + 3（含 C host）：确定性、零外部依赖、永远干净 Linux 可绿
```

硬件在环命令（不进 CI）：`npm run test:page`（Windows + 开发者工具）、`npm run test:hw`（Windows + 真机 + 桥）、`npm run test:smoke`（人工）。

## 版本锁定

Node 20（`.nvmrc`）、npm workspaces、TypeScript ^5.6 + vitest ^2.1（`package-lock.json`）、PlatformIO espressif32@6.9.0（IDF v5.5.3）、Python 3.11 + venv。详见 `docs/toolchain.md`。

## CI

`.github/workflows/ci.yml` 分六 job：`typecheck` / `lint` / `logic-test` / `firmware-host-test` / `protocol-vectors` / `site-build`（master push 时部署 GitHub Pages）。硬件在环层不进 Linux CI。

## 分支与提交

- `master` 受保护：PR 合并，禁止直接 push。
- 提交信息：`<type>(<scope>): <subject>`，type 用 `feat/fix/docs/chore/refactor/test/ci`。
- `feat/test-strategy-impl` 已封存：保留分支、不合并、实现不参考（地图 Notes 基线）。

## secrets

微信小程序 AppSecret 只放 CI secrets；AppID `wx0a46668333178576` 公开可进仓库。任何文件、issue、日志不写 AppSecret。

## 文档

- 术语：`GLOSSARY.md`
- 决策：`docs/adr/`
- 规格：`docs/spec/*.md`
- 地图与决策记录：issue #20（BLE Light 地图）