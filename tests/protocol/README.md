# Protocol golden vectors

Protocol v1 契约的 golden 向量，单一事实源：`vectors.json`（生成物，勿手改）。

- 规格：`docs/spec/protocol.md`（issue #22）
- 生成：`node generate_vectors.mjs > vectors.json`

`generate_vectors.mjs` 是**向量定义工具**，不是生产 codec；生产 codec 在
`firmware/proto/`（C99）与小程序逻辑层 `codec.ts`（TS）各写一份镜像，
外加 `tests/protocol/` 下的 Python 校验工具，三者共用 `vectors.json` 互相对拍，
字节必须逐一致。

## 覆盖

- **encode**：固定输入 → 期望整帧字节。含各灯效帧、HELLO/STATUS/SCENE、ACK/NAK、
  最大 payload 255（整帧 266）、按 20 字节切片的 `chunks`。分片覆盖含真实多块：
  `encode/fragment_60`（40B payload → 51B 帧 → **20/20/11 三块**）、以及 19/20/21B
  边界钉（`fragment_boundary_19/20/21`，其中 21B 帧 `chunks` 为 20/1 跨边界）。
- **feed**：字节流 → 帧 / NAK / 丢弃。含正常、分片重组（含 `feed/fragment_60_reassembly`
  51B→三块逐个喂入重组、`feed/fragment_boundary_21` 21B→20/1 跨边界重组）、
  粘包（含 `feed/coalesced_multiframe` 两条 51B 帧连段切两帧、跨 20B 边界）、
  CRC 错→0x01、未知 type→0x02、未知灯效→0x03、长度不足→0x04、长度超出（忽略多余）、
  版本错→0x08、半帧超时丢弃、seq 重复幂等、GET_STATUS/GET_SCENE 应答、非法参数→0x05。

## 运行

三端各自读取 `vectors.json` 复算；不满足即红。