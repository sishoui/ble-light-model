#!/usr/bin/env python3
"""<1min 冒烟脚本（等价于 `pytest -m smoke`，独立命令）。

用法（本目录下，Python 3.12 + 依赖已装）：
    python smoke.py

先决条件：PC 蓝牙适配器开启，C3 在广播（BLELight-C3），USB CDC COM 口可按
VID=0x303A 发现。结束后在 `runs/<时间戳>/` 留取证目录；退码 0 = 成功。
"""

from __future__ import annotations

import asyncio
import sys

from harness import run_scenario
from scenario import smoke_scenario


async def main() -> int:
    ok, outcomes, run_dir, err = await run_scenario(
        None, scenario=smoke_scenario
    )
    print(f"smoke: {'PASS' if ok else 'FAIL'} (run={run_dir})")
    for i, o in enumerate(outcomes):
        print(f"  [{i}] {o.name}: {'ok' if o.ok else 'FAIL'}  {o.detail}")
    if err:
        print(f"  error: {err}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))