# 协议 golden 向量

`vectors.json` 是小程序 `miniprogram/logic`、固件 `firmware/proto/`、PC 集成 Python 复刻三侧的唯一编解码契约（`docs/spec/test-strategy.md` §1.3）。三侧不跨语言复用代码，只对齐字节。

**不要手改 `vectors.json`**：它是 `generate_vectors.mjs` 的产物。改用例后运行：

```sh
node tests/protocol/generate_vectors.mjs
```

生成器自带 CRC-16/CCITT-FALSE 自检（标准检查值 `0x29B1`），并断言 `enc_get_status` 与两侧测试里手算的字面量 `AA5501030006000000D6A0` 一致——防止生成器与实现共享同一布局误读。

## 跑测

- JS：`npm run test:logic`（vitest，`miniprogram/logic/codec.test.ts` 全量跑 `vectors`）
- C：`pio test -d firmware -e native`（Unity，`firmware/test/test_ble_proto/`，读同文件；可用 `BLE_VECTORS_PATH` 覆盖路径，默认 `../tests/protocol/vectors.json`）

## Schema（v1）

顶层：`version`、`encoding`（`hex`）、`frame`（帧格式元数据）、`constants`（type / NAK 错误码）、`effect_param_lengths`（effect_id -> 效果参数期望长度，不含 effect_id 字节）、`feed_semantics`（喂入/重同步/校验顺序的文字约定）、`vectors`。

每个 vector：

| 字段 | 说明 |
|---|---|
| `id` / `kind` / `desc` | 标识、`encode` 或 `feed`、描述 |
| `frame` | encode 输入帧：`ver, seq, type, flags, strip_mask, payload(hex)` |
| `expect_hex` | encode 期望的线格式字节（含 CRC，小端） |
| `writes` | feed 用：每次 BLE 写入的原始字节（hex）。统一语义 `feed(concat(上次 remainder, write))` |
| `expect_frames` | feed 期望解出的帧（字段同上） |
| `expect_errors` | feed 期望错误：`{kind, error(NAK 码), seq, type}`，顺序敏感 |
| `expect_remainders` | 与 `writes` 等长：每次喂入后未完成尾字节（空串 = 无） |
| `expect_ack_generated` | seq 场景专用：Codec 不得自行产生 ACK（匹配/重传归 BleLink） |

## 覆盖清单（spec §1.3 / §3.2）

正常帧（SET_EFFECT/SET_BRIGHTNESS/GET_STATUS/HELLO/ACK/NAK/SET_POWER_LIMIT/UNLOCK）、分片、分片+粘包混合、粘包、空输入、垃圾前缀、CRC 错（NAK 0x01）、seq 错（可识别、不产 ACK）、ACK 回显、未知 type（0x02）、未知灯效（0x03）、param_len 过短（0x04）、param_len 过长（接受）、未知版本（0x08）、多错误顺序、半帧遇新 magic 重同步。

## 协议要点

- 帧：`AA55 | ver(1) | seq(2 LE) | type(1) | flags(1) | strip_mask(1) | param_len(1) | payload(N) | crc16(2 LE)`，CRC-16/CCITT-FALSE 覆盖 ver..payload。
- 校验顺序：CRC -> 版本 -> type -> SET_EFFECT 灯效 -> 长度。
- `param_len >= 1 + 期望效果参数长度` 接受、多余忽略；更短 NAK 0x04（#4 决议）。
- 详见 `#4` 决议（协议 v1 定稿）与 `docs/spec/test-strategy.md` §3.2。