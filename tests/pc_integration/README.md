# PC 集成测试

PC 蓝牙适配器当 BLE 中心直连 C3，用 COM6 JSONL 串口日志 + RSP notify 交叉断言（`docs/spec/test-strategy.md` §3.3）。依赖物理硬件，不进 CI；实现由 #6 落地。

运行环境：Windows + Python + bleak + pyserial + pytest。