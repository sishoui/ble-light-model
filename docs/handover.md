# 交接文档 · BLE Light（2026-11-21）

> 面向接手人。真源仍是 `docs/spec/*.md`、`docs/adr/`、`GLOSSARY.md`、`project.yaml`；本文只做状态快照、落差清单与入口。

## 1. 状态快照

- 分支：`feat/implement-t7-t9`（已推送 origin，**未合入 master**；master 受保护，需走 PR）。
- 已关闭执行票据：**#30–#36**（wayfinder 地图 #20 的执行阶段）。
- 本次交付：协议三端 golden、固件纯逻辑 core、小程序逻辑层 + transport 三实现、驱动 core + host 单测、测试遥测契约、文档对齐。
- 确定性门禁当前全绿：`npm test`（build:logic + vitest 30 + C host 30 + 三端对拍 TS/C/Python 全 ok）、`typecheck`、`typecheck:transport`、`lint`。

## 2. 目录地图（谁负责什么）

| 路径 | 职责 | 状态 |
|---|---|---|
| `docs/spec/` | 六份定稿 spec（effects/protocol/driver/miniprogram/test-strategy/project-site） | 真源 |
| `docs/adr/` | 0001 无限流、0002 stdio 桥 | 决策 |
| `firmware/effects/` | 灯效引擎（7 效果 + 关灯，逐像素整数确定性） | ✅ 已写 + 测试 |
| `firmware/driver/` | 调度 / 双缓冲 / 编码 / 遥测（`light_core_t` 不透明 + ports 回调） | ✅ 已写 + 测试 |
| `firmware/proto/` | 协议 codec（帧/CRC/分片/ACK-NAK/SCENE） | ✅ 已写 + 三端对拍 |
| `firmware/ports/` | RMT 发送、GPIO 扇出/route、clock、log、NVS 的 ESP-IDF 实现 | ❌ 空（仅 .gitkeep） |
| `firmware/main/` | `app_main`、任务循环、ISR 注册、启动顺序 | ❌ 空（仅 .gitkeep） |
| `firmware/test/` | Unity host 单测（D1–D16 + 灯效 + 遥测，30 用例） | ✅ |
| `miniprogram/logic/src/` | `codec` / `BleLink` / `DeviceController` / `ViewState` / `Clock` / Transport 接口 | ✅ 已写 + 测试 |
| `miniprogram/transport/` | `WxTransport` / `PcBleTransport` / `FakeTransport` / `factory` | ✅ 已写（仅 Fake+mapWxError 有测试） |
| `miniprogram/pages/device/` | 设备页 WXML + Page | ❌ 空；无 `app.ts`/`app.json` |
| `tests/logic/` | vitest（30 用例，注入 Fake + 假时钟） | ✅ |
| `tests/protocol/` | 向量单一真源 + 三端 runner（`vectors.json` 20 encode / 17 feed） | ✅ |
| `tests/scenarios/` | 跨层共享场景（spec 要 10 条） | ❌ 空 |
| `tests/page/` | 层 2 automator runner | ❌ 空 |
| `tests/shadow/` | 层 4 影子跑 runner | ❌ 空 |
| `tools/shadow/` | 影子跑 CLI | ❌ 空 |
| `bridge/ble_bridge/__main__.py` | Python bleak stdio 桥 | ⚠️ 占位（只 print ready） |

## 3. 已实现 vs 未实现（叙事版）

**能跑的（确定性、零硬件）**
- 协议：分片/粘包/CRC/各类 NAK/幂等/参数长度/版本错/半帧丢弃；C/TS/Python 三端对 `vectors.json` 逐字节一致。
- 逻辑层：`BleLink` 6 态状态机 + 命令会话（一帧在途、500ms×3、NAK 不重试、20B 兜底、单包 3s、10s 看门狗）；`DeviceController` 8 行镜像 + 总开关 + 乐观更新/回滚。
- 固件 core：驱动 D1–D16（编码/GRB/双缓冲/心跳/脏重绘/回绕/glitch）+ 灯效确定性/冻结/strip 错开/hash 已知值；测试遥测 `T:` 行契约。

**还没写 / 跑不了**
- **固件无法上板**：`ports/` 与 `main/` 空，全仓库 0 个 `app_main`、0 处真实 ESP-IDF 调用 → `pio run -e esp32c3` 链接不起来，只能 `pio test -e native`。
- **页面层缺失**：`pages/device` 空、无 `app.ts`/`app.json`；miniprogram.md §9.3 的 10 条页面断言一条跑不了；参数页（§8.4）也未实现。
- **影子跑/桥缺失**：桥是占位；`tools/shadow` 空 → 真 BLE 端到端、MTU/notify、重连全未验证。
- **共享场景缺失**：`tests/scenarios` 空，10 条场景未落地。
- **灯效无像素级 golden**：#36 的 golden 是协议字节，不是像素。effects.md §11「产出的像素值过 golden 对拍」未达标（现只有确定性 + 少数语义点）。
- **持久化未覆盖**：NVS 场景写入/去抖、重启恢复、断连保持（protocol §11、effects §2.3/§8.5）依赖 `ports/nvs`，未实现未测。
- **真实 adapter 无测试**：`WxTransport`、`PcBleTransport` 0 单测。

## 4. 怎么跑 / 怎么验

```bash
npm install
npm test                 # build:logic + vitest(30) + C host(30) + 三端 golden
npm run typecheck        # logic 构建配置 + src
npm run typecheck:transport
npm run lint             # logic/src 禁用 API
pio test -e native       # 固件 host 单测（需 PlatformIO；或 python -m platformio test -e native）
node tests/protocol/run-all.mjs   # 三端对拍
```

**`test:host` 是 fail-closed 的**：`pio` / `platformio` / `python -m platformio` 任一可解析就真跑；缺工具链时本机退 `2`（未执行），`CI=true` 或 `--require-host` 退 `1`（红）。不要再让它静默绿。

## 5. 交接注意

- **master 受保护**：本分支需开 PR 合入。分支已推送 `origin/feat/implement-t7-t9`。
- **工作树里有两处未提交的本地改动**（`README.md` 一行 + 未跟踪 `docs/spec/landing.md`），是地图落档的 WIP，不属于本次实现，未动。
- **单一真源**：`tests/protocol/vectors.json` 由 `generate_vectors.mjs` 生成，勿手改；三端 codec 是它的镜像。
- **端口 seam**：`firmware/driver/include/light_core.h` 的 `light_ports_t`（`now_ms` / `tx_submit` / `route` / `log`）就是补 `ports` 的接口边界——host 测试里的假实现可直接对照。
- **遥测**：`T:` 行契约见 `docs/spec/driver.md` §6；`glitch_count`/`drop_count` 是 STATUS 常驻字段。

## 6. 建议的后续工作（按优先级）

1. **补 `firmware/ports` + `firmware/main`**，让 `pio run -e esp32c3` 能编译烧录：RMT 发送（预编码 + `copy_encoder` + `CONFIG_RMT_TX_ISR_CACHE_SAFE`）、GPIO 扇出 + 只切 `GPIO_ENABLE`（`switch_gpio` 降级）、clock、log、NVS。随后做 driver.md §8 的 B0–B9 上板项（需示波器/逻辑分析仪）。
2. **灯效像素级 golden**：给 gradient/rainbow/flow/breath 加逐像素、跨 `t_ms` 的独立 oracle（补 effects.md §11 的缺口）。
3. **`tests/scenarios` 10 条 + 页面层**：`app.ts`/`app.json`、`pages/device`、automator runner（层 2，Windows + 开发者工具）。
4. **桥实现 + 影子跑**（层 4）：`bridge/ble_bridge` 落地 bleak stdio JSONL，`tools/shadow` + 层 4 runner，串口 `T:` 遥测交叉断言。
5. **NVS 持久化 + 重启/断连**：随 `ports/nvs` 一起补，并加对应 host/影子跑用例。
6. **（可选）架构深化**：见临时目录 `architecture-review-*.html` 的 7 个候选，首推「从 Feeder 拆出 echo server」。

## 7. 一句话

**软件层（协议/逻辑/驱动 core）已经可信、CI 可绿；要变成"能上板、有页面、能影子跑"的完整产品，下一步是 ports+main、像素 golden、场景+页面、桥+影子跑。**
