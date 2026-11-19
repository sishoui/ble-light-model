# vendored wxa-runner 0.14.0 + baselib 3.7.0

> **状态：有时限 spike（spec §3.5 / 工单 #19）。** wxa-runner 非腾讯官方产品，2026-11 应腾讯要求
> 下线（官方仓库删除、文档站 404、npm 全部 `deprecated`）。本目录把运行必需的文件 vendor 进
> 仓库，保证 spike 期内可重复运行；**不随产品发布**，kill 标准达成后随 C 层一起废弃。

## 来源与完整性

全部文件来自 npm registry 官方 tarball（`npm pack` 解包），vendor 时逐一做过 sha512 校验：

| 包 | 版本 | tarball | sha512（registry integrity，逐一比对一致） |
|---|---|---|---|
| `wxa-runner` | 0.14.0 | `https://registry.npmjs.org/wxa-runner/-/wxa-runner-0.14.0.tgz` | `OXc3X3Ta0/r8VlxJ4bvxLMpFw1uQCqtwQ30FVryg3W2A7xCDDYkHD/9ksCAxnSYljNuKLVN0jX+zz7EfQCnC4g=` |
| `@open-wxa/wxa-runner-core` | 0.14.0 | `…/@open-wxa/wxa-runner-core/-/wxa-runner-core-0.14.0.tgz` | `+Aq7dOJ1ClmlFfQiwGqY5MDfkM5cZZT7ju2wQJu6AzZy75GxE5FKu1Go6RnPuIkCj7KBvsobHAB2hrUm/C4YOQ=` |
| `@open-wxa/wxa-runner-extractor` | 0.14.0 | `…/@open-wxa/wxa-runner-extractor/-/wxa-runner-extractor-0.14.0.tgz` | `aYMvc/10+S7vOXxwVHEyXxqnyEHMX4y2Qm9287NUOBBTx9ZmkDdIxHhJIaq+XTL/eOkJ+XuXfZtDjwJIyuGmqA=` |
| `@open-wxa/wxa-runner-compiler` | 0.14.0 | `…/@open-wxa/wxa-runner-compiler/-/wxa-runner-compiler-0.14.0.tgz` | `3JKyQrWovuUphPPsVHourJDWdVNfGmXacg6LFmilIB4CFo1fujSepaLyGBTxSnmsv2gWXDtjpQ2LntcHmRAqkA=` |
| `@open-wxa/wxa-runner-playwright` | 0.14.0 | `…/@open-wxa/wxa-runner-playwright/-/wxa-runner-playwright-0.14.0.tgz` | `kW02II0lTdwtDe+PHYp7srH+U/BYeIEPf8jVDLlyyipHy+KfyOOKnK6MKDdBqUKXC4Oi8u+KUMv97qrPB9do5g=` |
| `@open-wxa/wxa-baselib` | 0.1.0（内含 3.7.0） | `…/@open-wxa/wxa-baselib/-/wxa-baselib-0.1.0.tgz` | `mt2Nsd3mt7mXh3GhpSQzTHvzi6l++Xhwdd7CH9PJJv3yTh4QXC8y9+E2QkL5URO76RToLahACRwCmrgmMYQsaA=` |

社区 fork（源码 / 文档参考）：`https://github.com/hackwaly/wxa-runner`（commit `8f6018c`，tag v0.7.0 时代
的仓库结构；npm 0.14.0 的发布产物与 fork 内容对应）。

## 文件清单（只 vendor 运行必需文件，不含 node_modules）

```
wxa-runner/                bin/wxa-runner.js + package.json（CLI 入口）
wxa-runner-core/           dist/（dev server + 浏览器运行时 host.js/frame.js/sw.js/worker.js）
wxa-runner-extractor/      dist/（基础库定位与解包）
wxa-runner-compiler/       dist/（miniprogram-compiler 封装）
wxa-runner-playwright/     dist/（Playwright fixture：miniProgram）
wxa-baselib/3.7.0/         WAService.js / WAWebview.js / WAWorker.js / WAVersion.json（微信官方基础库）
```

- 去掉了各包 `package.json` 的 `devDependencies`（含 `@open-wxa/wxa-viewer@0.10.0`，npm 已 404；
  npm 对 `file:` 依赖会尝试安装其 devDeps，不去掉则 `npm install` 直接失败）。其余字段未动。
- 去掉了 dist 的 `.map` sourcemap 文件（运行不需要，减小体积）。
- 其余运行时依赖（express / ws / esbuild / chokidar / commander / chalk / sass / less /
  miniprogram-compiler）是正常 npm 包，由 `tests/ui_spike/package.json` 声明、`package-lock.json` 锁定，
  **不 vendor**。

## 许可

- `wxa-runner*` 五个包：MIT（Copyright (c) 2026 open-wxa），各目录内 LICENSE 为证。
- `wxa-baselib/3.7.0/`：**微信官方基础库，版权归腾讯所有，不适用 MIT**。仅因 wxa-runner 在没有
  开发者工具的环境（Linux CI）需要而保存，未做任何修改（见 `wxa-baselib/README.md`）。

## 如何重新 vendor（升级 / 校验时）

```bash
npm pack wxa-runner@0.14.0 @open-wxa/wxa-runner-core@0.14.0 …   # 逐个下载
tar -xzf <tgz> -C <目标目录> --strip-components=1
# 删 devDependencies、删 *.map，sha512 与本 README 表格比对
```

CI（Linux）无需微信开发者工具：baselib 用本目录内置 3.7.0（`playwright.config.ts` 已固定
`baseLibVersion: "3.7.0"`），编译器用 npm 的 `miniprogram-compiler`（x86-64）。