# 层 4 Node 影子跑

同一份小程序逻辑经 `PcBleTransport` + 桥直连真机 C3 + 串口遥测交叉断言。Windows + 真机，**不进 Linux CI**（test-strategy.md §1/§3）。入口 `npm run test:hw`。

## 状态

未实现：目录就位；桥与 runner 尚未实现（层 4）。