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
  最大 payload 255（整帧 266）、按 20 字节切片的 `chunks`。
- **feed**：字节流 → 帧 / NAK / 丢弃。含正常、分片重组、粘包、CRC 错→0x01、
  未知 type→0x02、未知灯效→0x03、长度不足→0x04、长度超出（忽略多余）、
  版本错→0x08、半帧超时丢弃、seq 重复幂等、GET_STATUS/GET_SCENE 应答、非法参数→0x05。

## 运行

三端各自读取 `vectors.json` 复算；不满足即红。