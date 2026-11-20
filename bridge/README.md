# bridge — PC 蓝牙桥（Python bleak）

影子跑（`test:hw`）中承载 PC 蓝牙收发的本地电台，纯 stdio JSONL，只做电台不碰帧与灯效。协议见 `docs/spec/miniprogram.md` §5。

## 版本锁定

- Python 3.11 + venv（`requirements.txt`：`bleak==3.1.*`）。
- 建 venv：`python -m venv .venv`，然后 `pip install -r bridge/requirements.txt`。
- 桥进程由 Node 父进程拉起（`spawn('python', ['-m', 'ble_bridge'], { cwd: bridge/ })`），stdio JSONL。

## 目录

```text
bridge/
  ble_bridge/__main__.py      # 桥入口（未实现：仅打印 ready 占位）
  requirements.txt            # bleak==3.1.*
```

## 状态

未实现：桥代码仍是占位（仅打印 ready）；契约见 `docs/spec/miniprogram.md` §5，待后续票实现。

## secrets

桥不需要微信 AppSecret（只走 PC 蓝牙）；小程序侧 AppSecret 走 CI secrets。