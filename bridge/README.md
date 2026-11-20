# bridge — PC 蓝牙桥（Python bleak）

影子跑（`test:hw`）中承载 PC 蓝牙收发的本地电台，纯 stdio JSONL，只做电台不碰帧与灯效。协议见 `docs/spec/miniprogram.md` §5。

## 版本锁定

- Python 3.11 + venv（`requirements.txt`：`bleak==3.1.*`）。
- 建 venv：`python -m venv .venv`，然后 `pip install -r bridge/requirements.txt`。
- 桥进程由 Node 父进程拉起（`spawn('python', ['-m', 'ble_bridge'], { cwd: bridge/ })`），stdio JSONL。

## 目录

```text
bridge/
  ble_bridge/__main__.py      # 桥入口（执行阶段落地）
  requirements.txt            # bleak==3.1.*
```

## 状态

骨架阶段：仅版本与契约就位；桥代码在执行阶段落地（issue #28 之后的执行 ticket）。

## secrets

桥不需要微信 AppSecret（只走 PC 蓝牙）；小程序侧 AppSecret 走 CI secrets。