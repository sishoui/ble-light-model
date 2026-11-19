# 协议 golden 向量

`vectors.json` 是小程序 `miniprogram/logic`、固件 `firmware/proto/`、PC 集成 Python 复刻三侧的唯一编解码契约（`docs/spec/test-strategy.md` §1.3）。三侧不跨语言复用代码，只对齐字节。

当前是空骨架：`vectors` 数组待协议工单落地时填充。最小覆盖集合见 spec §1.3 / §3.2：

- 正常帧
- 分片
- 粘包
- CRC 错
- seq 错
- 未知 type
- 未知灯效
- param_len 过长 / 过短

帧格式与 CRC 参数见 spec §3.2。