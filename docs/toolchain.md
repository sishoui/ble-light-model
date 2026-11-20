# 工具链版本锁定（root 统一）

| 工具 | 版本 | 锁定方式 |
|---|---|---|
| Node | 20 | `.nvmrc` + `package.json` `engines` + CI `setup-node@v4` |
| npm workspaces | — | root `package.json` `workspaces` |
| TypeScript | ^5.6 | root devDependencies（`package-lock.json`） |
| vitest | ^2.1 | root devDependencies（`package-lock.json`） |
| PlatformIO + ESP-IDF | espressif32@6.9.0（IDF v5.5.3） | `firmware/platformio.ini` |
| Python | 3.11 + venv | CI `setup-python@v5` + `bridge/requirements.txt` |

- `package-lock.json` 锁 Node 依赖；`firmware/.pio` 由 PlatformIO 解析。
- 本地 Node 版本只要 ≥20 即可；CI 固定 20。