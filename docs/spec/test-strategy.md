# 测试金字塔与一条命令边界

> 状态：已定稿（对应 issue #26）。
> 适用范围：Node 逻辑单测、C core host 单测、三端协议 golden、PC 蓝牙影子跑、页面 automator、真机冒烟，及它们共用的一条命令与证据/失败定位约定。
> 边界：本文只管"每一层跑什么、何时跑、谁算绿、证据留哪、红了怎么定位"。帧字节与 ACK/重传语义在 `docs/spec/protocol.md`；页面分层与 Transport 契约在 `docs/spec/miniprogram.md`；驱动时序/上板项在 `docs/spec/driver.md`；灯效确定性在 `docs/spec/effects.md`。冲突时以各自 spec 为字节/语义真源，本文只做编排。

本文把散在四份 spec 里的验收与时序收拢成一张"怎么测、谁在什么时候测、证据留哪、失败怎么定位"的图，并钉死缺的三件：一条命令的约定、证据留存、分层失败定位。

---

## 1. 五层

| 层 | 范围 | 工具 | 入口 | 环境 | CI | 证据 |
|---|---|---|---|---|---|---|
| **1 确定性单测** | Node 逻辑（codec / 状态机 / 业务规则，vitest）+ C core（sched / frame / encode，host） | `vitest` + PlatformIO `test -e native` / Unity | `npm test` | 任意（Linux CI 可） | ✅ 每次 push | JUnit / `result.json` |
| **2 页面层** | 单设备页在模拟器渲染与交互，注入 `FakeTransport` | `miniprogram-automator` 0.13.0 + 开发者工具（Windows GUI） | `npm run test:page` | Windows + 开发者工具 | ❌ | 截图 |
| **3 协议 golden** | C / TS / Python 三端对同一份 `vectors.json` 逐字节一致（encode + feed） | 三端各自 runner | `npm test` | 任意 | ✅ 每次 push | 三端差异报告 |
| **4 PC 集成** | 影子跑：同一份 Node 逻辑经 PC 桥直连真机 C3 + 串口遥测交叉断言 | `PcBleTransport` + Python bleak 桥 + `T:` tag 解析（契约见 `driver.md` §6） | `npm run test:hw` | Windows + 真机 | ❌（发布前门禁） | 串口原始日志 / notify 时间线 / 失败帧 dump |
| **5 真机冒烟** | automator 10 条（真机）+ driver 上板 B0–B9 + 4 项真实 BLE 栈人工项 | Android automator + 人工勾选清单 | `npm run test:smoke` | 真机 + 人 | ❌（发布前门禁） | 勾选清单 / 截图 / 录屏 |

**CI 与本地门槛分界**：每次 push 必须绿的是层 1 + 层 3 + 静态检查（`build:logic` → `tsc --noEmit` → logic 目录 grep/ESLint 约束 → `vitest run dist`）。层 2 / 4 / 5 是"硬件在环"门槛，只做**发布前**与人工时机，不进 Linux CI。层 2 单独一条命令，因为依赖 Windows + 微信开发者工具 + 登录；层 4 单独一条命令，因为依赖真机 + 桥；层 5 单独一条命令，因为要人。

---

## 2. 一条命令的约定

- **`npm test`** = 层 1 + 层 3。纯确定性、零外部依赖（无真机、无开发者工具、无网络）。这是用户说的"一条命令全自动回归"的底座，永远可在一台干净 Linux 上绿。它先跑 `build:logic`（logic 产 `dist`），`vitest` 测 `dist` 而非 `src`，再跑 C core host 单测，再跑三端 golden。
- **`npm run test:page`** = 层 2，Windows + 开发者工具。
- **`npm run test:hw`** = 层 4，Windows + 真机 + 桥。
- **`npm run test:smoke`** = 层 5，人工。
- **`make test`** 只做一行转发到 `npm test`，不是第二个真源。
- 三条"硬件在环"命令各自独立、**不硬合并**：三者的环境失败模式不同，硬合并会让退出码和"谁跳过"语义糊掉。发布门禁用一个 `--all` 顺序跑 `test:page` / `test:hw` / `test:smoke`，各自报退出码。

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 该层全绿 |
| `1` | 失败（有断言红，见 §5 定位） |
| `2` | 未执行（缺硬件 / 缺开发者工具 / 环境不可用），打印明确一行结论 |

**无硬件的优雅跳过**：`npm test` 根本不碰硬件，不存在跳过。只有 `test:page` / `test:hw` 会先探测环境（开发者工具端口 / 桥与设备可达），不可达时打印 `SKIPPED: no device on bridge <X>` 之类一行明确结论并退 `2`。`--require-hw` 把 `2` 升级为失败，供发布前门禁用。

**统一 `result.json`**：每个 runner 无论通过/跳过/失败都落一份 `result.json`（层、命令、commit、环境、通过数/失败数/跳过数、各场景耗时、实测均值），上层编排与发布门禁读它，不 grep 人类日志。

---

## 3. 时序类断言怎么测才不 flaky

原则：**确定性结论只在层 1（注入 Clock）**，**硬件层只断言区间与统计量**，绝不断言单一墙钟时刻。

- **层 1（假时钟，精确）**：ACK 超时 `500ms × 3` 重传、半帧丢弃 `200ms`、心跳 `200ms ± 1ms`、单条 `80Hz` 帧周期 `12.5ms`、`now_ms` 2³² 回绕，全部用注入 `Clock` 精确断言到毫秒。
- **层 4（区间 + 统计量）**：p95 ACK 延迟 `< 250ms`；无单条命令重传 `> 3 次`；5 秒窗口内刷新率 `≥ 60Hz` 且 `glitch_count == 0`；**绝不断言 80Hz**。`76Hz` 参考值降级成"只记录、不上报"（进 `result.json` 实测均值，不设门槛）。
- **层 5**：只做人工观察 + 勾选，不做自动时序断言。

**时长预算**：

| 层 | 预算 | 超预算处理 |
|---|---|---|
| 1 | ≤ 60s（Node ≤20s + C host ≤40s） | 即失败（是一条命令体验的一部分） |
| 3 | ≤ 10s | 即失败 |
| 2 | ≤ 120s | 只告警，记进 manifest |
| 4 | ≤ 5min（单场景 ≤20s） | 只告警 |
| 5 | ≤ 15min 人工 | 只告警 |

---

## 4. 场景脚本跨层复用

`tests/scenarios/*.json` 是**单一真源**，被层 1（FakeTransport）、层 4（PcBleTransport）、层 5（真机 automator）三个 runner 共用解释器加载。用例只写**语义动作**，不写死帧字节或 sleep：

- `connect` / `setScene` / `getStatus` / `expectStatus` / `expectFrame` / `expectNAK` / `expectDisconnect`
- 断言只依赖 ViewState / STATUS / SCENE 回读 / 帧日志，不依赖墙钟。

**v1 固定 10 条**（不追覆盖率数字）：连接 + HELLO、整场下发、单条下发、总开关、GET_STATUS 回读、断连重连三次、20B 与 255B 分片边界、OFF、NAK 回滚、并发写串行化。覆盖率数字进 §8 的 Not yet specified，等实现出来再谈。

---

## 5. 分层失败定位决策树

先看**哪条命令红 + 最底层证据**，不是按模块名猜：

- **`npm test` 红** → 先看三端 golden 是否一致：
  - 只有一端不一致 → 该端 codec 实现 bug（对照 `vectors.json` 该条）。
  - 三端一致但用例红 → vector 或 spec 错（先查 §8 前置项里已知的分片向量缺口）。
  - C core host 单测红（golden 绿）→ sched/frame/encode 内部，看 D1–D16 哪条。
- **`test:page` 红** → 同一场景先跑 FakeTransport（层 1）：
  - 逻辑绿而页面红 → 渲染 / 绑定 / 注入层。
  - 都红 → logic（先修层 1）。
- **`test:hw` 红** → 看串口：
  - 串口有 panic / reset → 固件。
  - HELLO 通但无 STATUS → 协议或桥。
  - STATUS 正确但灯不对 → 驱动时序（看 `glitch_count` / `drop_count`）或电气。
  - CRC 错率异常 → 射频 / 分片。
- **`test:smoke` 红而 PC 集成同一场景绿** → 微信栈（权限 / MTU / 后台 / 分片），走 4 项人工项确认。

---

## 6. 证据留存

每次运行落 `artifacts/<utc-runid>/`：

| 文件 | 内容 |
|---|---|
| `manifest.json` | 命令、commit、环境、各层结果、时长 |
| `serial-raw.log` | 串口原始日志（层 4） |
| `notify-timeline.jsonl` | 时间戳 + 帧头（层 4） |
| `frames/*.bin` | 失败帧 dump |
| `screenshots/*.png` | 页面层与冒烟截图 |

- `artifacts/` 进 `.gitignore`；本地保留最近 **20 次**；CI 产物保留 **14 天**。
- 发布候选**不提交二进制证据进 git**（避免仓库膨胀）：在 spec/issue 贴 `manifest.json` 摘要 + 一个归档链接当验收凭据。

---

## 7. 发布门禁

打 tag / 交付前必须满足：

- 层 1 + 层 3 绿（硬门槛）。
- 层 4 真机影子跑一次全绿（硬门槛）。
- 层 5 人工冒烟签字（硬门槛）。
- 层 2 只要**改过 `pages/` 就必须本地跑绿**，但**不进发布证据**；未改页面则不设门槛。

冒烟范围分界（不复述各 spec）：automator 10 条（真机，覆盖交互逻辑，见 `miniprogram.md` §9.3）+ driver 上板 B0–B9（覆盖固件时序/电气，见 `driver.md` §8）+ **4 项真实 BLE 栈人工项**（权限弹窗 / 后台与锁屏 / 分片 / notify 时序，automator 测不到的部分）。

---

## 8. 前置项与待定

**前置（blocker，不做则层 3 自欺）**：
- **~~`vectors.json` 分片向量缺口~~（已消除）**：~~`encode/fragment_20` 与 `feed/fragmented` 的 `chunks` 实际只有 1 个 19B 块（breath 帧整帧 < 20B），没真测到 20 字节分片/重组，与 `protocol.md` §13 描述不符。~~ 已由 #30 补齐真正的 `> 20B` 切片向量：`encode/fragment_60`（51B→20/20/11）、`feed/fragment_60_reassembly`（三块逐个喂入重组）、`feed/coalesced_multiframe`（两条 51B 帧粘包切两帧）、以及 19/20/21B 边界钉（`fragment_boundary_19/20/21`）。三端对拍已由 run-all.mjs 的 golden 自洽覆盖。
- **~~固件测试遥测 tag 契约~~（已消除）**：~~`driver.md` 需加一节"测试遥测"——`T:` 前缀的机器可读行（如 `T:glitch_count=0`、`T:frame_ms=12.4`、`T:ack_seq=17`），层 4 runner 解析这些行做交叉断言而非人眼读日志；`T:` 流仅 dev/test 构建、release 编译期 `-D` 关；`glitch_count` / `drop_count` 常驻（已是 STATUS 字段，release 也留）。~~ **已由 issue #32 补齐，见 `driver.md` §6「测试遥测（T: 行）」**（字段集合、节流、`LIGHT_TELEMETRY` 编译开关、层 4 接口、ports 层归属）。

**Not yet specified**（本票不决，留待实现后）：
- 覆盖率数字目标（层 1 的 branch/statement 阈值）——等实现出来再谈。
- 各 spec 已列的 host 16 条 / 上板 10 项 / automator 10 条是否还要扩充——本票只做编排，不复述。

---

## 9. 关联

- `docs/spec/protocol.md`（#22）：帧字节、ACK/重传、golden 向量。
- `docs/spec/miniprogram.md`（#25）：分层、Transport 契约、FakeTransport、CI 顺序、automator 10 条。
- `docs/spec/driver.md`（#24）：驱动时序、host 16 条、上板 10 项、可观测钩子。
- `docs/spec/effects.md`（#21）：确定性、时间基 `t_ms`、星闪 hash。
- issue #29：页面层工具选型（automator，非无头，不进 Linux CI）。
- `tests/protocol/vectors.json` + `generate_vectors.mjs` + `README.md`：golden 单一真源。