# miniprogram — 原生微信小程序 + 共享逻辑层

依赖方向与目录见 `docs/spec/miniprogram.md` §1/§2。组合根 `app.ts` 组装 transport → link → controller。

```text
miniprogram/
  app.ts                      # 组合根（未实现）
  app.json / app.wxss         # 小程序全局配置（未实现）
  logic/                      # 逻辑层（npm workspace @ble-light/logic）
    src/index.ts              # 唯一导出入口
    tsconfig.build.json       # tsc -> dist（CJS / ES2017 / d.ts / sourcemap）
    package.json              # main: dist/index.js
    dist/                     # 唯一产物，gitignore
  transport/                  # factory / wx-transport / pc-transport / fake-transport（已实现）
  test/                       # 页面命名场景（未实现；FakeTransport 在 transport/）
  pages/device/               # index.ts / index.wxml / index.wxss / index.json（未实现）
  project.config.json         # 小程序项目配置（AppID 见下）
```

## AppID 与 secrets

- AppID：`wx0a46668333178576`（公开，可进仓库）。
- **AppSecret 只放 CI secrets**，任何文件、issue、日志都不写。见仓库 Settings → Secrets。
- `project.config.json` 不含 secret；`packOptions.ignore` 排除 `test/**`（页面测试用 Fake，不随上传）。

## 同源构建

`logic/src` 是唯一事实源；`npm run build:logic`（root）用 `tsc` 产出 `logic/dist`，小程序页面、Node 影子跑、`vitest` 都加载同一份 `dist/index.js`。

## 状态

- `logic/`：已实现 `codec` / `BleLink` / `DeviceController` / `ViewState` / `Clock` / Transport 接口（30 vitest 用例）。
- `transport/`：`WxTransport` / `PcBleTransport` / `FakeTransport` / `factory` 已实现。
- 未实现：`app.ts` / `app.json` / `pages/device/`（页面层）、`test/` 命名场景。见 `docs/handover.md`。