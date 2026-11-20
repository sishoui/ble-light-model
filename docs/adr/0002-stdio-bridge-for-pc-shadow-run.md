# PC 影子运行走 stdio 桥 + Python bleak

## 状态

accepted（2026-11-20）

## 背景与决定

目标：同一份小程序 TS 逻辑在没有手机时跑在 Node 里，经 PC 蓝牙直连 C3 做回归。小程序侧已有 `Transport` 抽象；剩下要选的是 Node 怎么碰蓝牙。

决定：**Node 逻辑进程为父，拉起一个 Python 子进程，用 stdio + JSONL 通信；Python 只做 BLE 电台（bleak + 内置 WinRT 适配器），不编解码、不认识灯效、不做重连。**

- 桥只提供扫描/连接/断开/写/MTU/通知与断连事件；请求带 `id`，事件是通知流。
- Node 侧 `PcBleTransport` 是桥的薄客户端；协议、状态机、重连全部留在 TS。
- 生命周期：Node 关 stdin → Python 读到 EOF 退出；父死子退，无孤儿、无端口、无鉴权面。

## 考虑过的替代

- **Node 直接 `@stoprocent/noble`**：少一个进程，但原仓库已归档、Windows WinRT 绑定不暴露 MTU、维护押在单个分叉上；BLE 稳定性不如 bleak。
- **WebSocket 常驻桥**：可多客户端、可独立重启，但多出端口选择/占用、本机鉴权、孤儿进程与“桥还活着但链路已死”的对账；影子跑只有一个消费者。
- **Python 侧重写协议 codec**（旧 #6 方案）：三端各写一份编解码，同源只剩 golden 向量；无法验证“小程序那份逻辑”本身。
- **C#/.NET WinRT**：能力齐全，但样板最多、`FromIdAsync` 有 UI 线程/同意 caveat，迭代最慢。

## 后果

- 影子跑依赖 Python ≥3.10 + `bleak` 3.1.x + Windows 蓝牙适配器；只在 Windows 有意义，不进 Linux CI。
- 多一个可崩溃的进程边界：桥崩溃按 `bridge-unavailable` 直接失败，不静默重连。
- 真正的同源：Node 与小程序加载同一 `logic/dist` 产物；桥不碰字节，协议正确性只有一份实现。
- 若将来要换 Node 原生栈，替换的是 `PcBleTransport` 与桥，不动 `BleLink` 以上任何代码。
- 细节见 `docs/spec/miniprogram.md` §2、§5。
