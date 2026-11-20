# 桥入口（骨架占位）。协议见 docs/spec/miniprogram.md §5。
# 执行阶段在此实现 stdio JSONL 电台：bleak 扫描/连接/读写/notify，只做适配器。
import sys


def main() -> int:
    print('{"event":"ready","protocol":1,"bleak":"3.1.x"}', flush=True)
    # 执行阶段：读 stdin JSONL，执行扫描/连接/读写，把 notify/device/disconnect 事件写 stdout。
    return 0


if __name__ == "__main__":
    sys.exit(main())