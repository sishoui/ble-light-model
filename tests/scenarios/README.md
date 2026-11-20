# 共享场景脚本

`tests/scenarios/*.json` 是**单一真源**，被层 1（FakeTransport）、层 4（PcBleTransport）、层 5（真机 automator）三个 runner 共用。用例只写语义动作，不写死帧字节或 sleep（test-strategy.md §4）。

v1 固定 10 条（连接 + HELLO / 整场下发 / 单条下发 / 总开关 / GET_STATUS / 断连重连 / 20B 与 255B 分片 / OFF / NAK 回滚 / 并发写串行化）。

## 状态

未实现：目录就位，10 条共享场景尚未落地。