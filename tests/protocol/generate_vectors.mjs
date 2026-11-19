/**
 * 生成 tests/protocol/vectors.json —— JS / C（以及后续 Python）三侧共跑的唯一编解码契约。
 *
 * 用法：node tests/protocol/generate_vectors.mjs
 *
 * 设计约束：
 * - CRC 算法用 CRC-16/CCITT-FALSE 标准检查值 0x29B1（ASCII "123456789"）自检，
 *  生成器与两侧实现共用的只有算法定义本身（spec §3.2 / #4 决议）。
 * - encode 布局由 spec §1.3 / §3.2 与 #4 决议定稿；enc_get_status 的字节另在
 *   miniprogram/logic/codec.test.ts 里以手算字面量硬编码，防止生成器与实现
 *   共享同一布局误读而互相掩盖。
 * - 修改本文件后重新运行即可；vectors.json 不要手改。
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------- CRC-16/CCITT-FALSE（poly 0x1021, init 0xFFFF） ----------

function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// 自检：标准检查值必须是 0x29B1，否则生成器本身不可信。
{
  const check = crc16([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
  if (check !== 0x29b1) {
    throw new Error(`CRC-16/CCITT-FALSE 自检失败：期望 0x29B1，得到 0x${check.toString(16)}`);
  }
}

// ---------- 帧编解码（与 spec §3.2 一致，仅用于生成期望字节） ----------

const VERSION = 1;

function toBytes(hex) {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`非法 hex：${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** frame: {ver, seq, type, flags, strip_mask, payload(hex)} -> 线格式 hex（含 CRC） */
function encodeHex(frame) {
  const payload = toBytes(frame.payload);
  if (payload.length > 255) throw new Error("payload 超过 255");
  const body = [
    frame.ver,
    frame.seq & 0xff,
    (frame.seq >> 8) & 0xff,
    frame.type,
    frame.flags,
    frame.strip_mask,
    payload.length,
    ...payload,
  ];
  const crc = crc16(body);
  const all = [0xaa, 0x55, ...body, crc & 0xff, (crc >> 8) & 0xff];
  return toHex(all);
}

// ---------- 向量定义 ----------

const HELLO_PAYLOAD = [
  "01", // protocol_ver = 1
  "01", "00", "00", // fw 1.0.0
  "08", // strip_count = 8
  "3C", // leds_per_strip = 60
  "30", "75", // max_current_ma = 30000
  "98", "3A", // power_limit_ma = 15000
  "46", // thermal_warning_c = 70
  "55", // thermal_shutdown_c = 85
  "07", // caps：满功率解锁 + 场景持久化 + effect_bitmap 有效
  "7F", // effect_bitmap[0]：effect 0x00–0x06 支持
  ...Array(15).fill("00"),
].join("");

const f = (ver, seq, type, flags, strip_mask, payload) => ({
  ver,
  seq,
  type,
  flags,
  strip_mask,
  payload,
});

const vectors = [];
const enc = (id, desc, frame) =>
  vectors.push({ id, kind: "encode", desc, frame, expect_hex: encodeHex(frame) });

// ---- encode：正常帧 ----
// SET_EFFECT payload = effect_id(1) + 效果参数（spec §2）；期望长度表只数效果参数（spec §3）。
enc("enc_set_effect_static", "SET_EFFECT 静态灯效：L0 纯红", f(1, 1, 2, 1, 0x01, "01FF0000"));
enc("enc_set_brightness", "SET_BRIGHTNESS：全灯带 50%", f(1, 2, 3, 1, 0xff, "80"));
enc("enc_get_status", "GET_STATUS：空 payload", f(1, 3, 6, 0, 0x00, ""));
enc("enc_hello", "HELLO：caps + effect_bitmap", f(1, 0, 1, 0, 0x00, HELLO_PAYLOAD));
enc("enc_ack", "ACK：回显 seq 7", f(1, 7, 7, 0, 0x00, "0700"));
enc("enc_nak_unknown_effect", "NAK：seq 5 / 未知灯效 0x03", f(1, 5, 8, 0, 0x00, "050003"));
enc("enc_set_power_limit", "SET_POWER_LIMIT：15000mA", f(1, 9, 4, 1, 0xff, "983A"));
enc("enc_unlock_full_power", "UNLOCK_FULL_POWER：解锁", f(1, 10, 5, 1, 0xff, "01"));

// ---- encode：param_len 过长（接受，多余忽略） ----
enc(
  "enc_set_effect_param_overlong",
  "SET_EFFECT 静态：param_len 6 > 期望 1+3，多余忽略",
  f(1, 8, 2, 1, 0x02, "01FF0000AABB"),
);

// ---- feed：正常帧 ----
const setEffectStatic = encodeHex(f(1, 1, 2, 1, 0x01, "01FF0000"));
const setBrightness = encodeHex(f(1, 2, 3, 1, 0xff, "80"));
const getStatus = encodeHex(f(1, 3, 6, 0, 0x00, ""));
const ack7 = encodeHex(f(1, 7, 7, 0, 0x00, "0700"));

const feed = (id, desc, extra) => vectors.push({ id, kind: "feed", desc, ...extra });

feed("feed_single", "单帧一次喂入", {
  writes: [setEffectStatic],
  expect_frames: [f(1, 1, 2, 1, 0x01, "01FF0000")],
  expect_errors: [],
  expect_remainders: [""],
});

feed("feed_coalesced", "粘包：两帧一次喂入", {
  writes: [setEffectStatic + setBrightness],
  expect_frames: [f(1, 1, 2, 1, 0x01, "01FF0000"), f(1, 2, 3, 1, 0xff, "80")],
  expect_errors: [],
  expect_remainders: [""],
});

feed("feed_fragmented", "分片：一帧拆两次写入", {
  writes: [getStatus.slice(0, 12), getStatus.slice(12)],
  expect_frames: [f(1, 3, 6, 0, 0x00, "")],
  expect_errors: [],
  expect_remainders: [getStatus.slice(0, 12), ""],
});

feed("feed_fragmented_coalesced", "分片 + 粘包混合：四段写入还原三帧", {
  writes: [
    getStatus.slice(0, 8),
    getStatus.slice(8) + setBrightness,
    setEffectStatic.slice(0, 10),
    setEffectStatic.slice(10),
  ],
  expect_frames: [
    f(1, 3, 6, 0, 0x00, ""),
    f(1, 2, 3, 1, 0xff, "80"),
    f(1, 1, 2, 1, 0x01, "01FF0000"),
  ],
  expect_errors: [],
  expect_remainders: [getStatus.slice(0, 8), "", setEffectStatic.slice(0, 10), ""],
});

feed("feed_empty", "空输入", {
  writes: [""],
  expect_frames: [],
  expect_errors: [],
  expect_remainders: [""],
});

feed("feed_garbage_prefix", "帧前垃圾字节（含孤立 0xAA）静默丢弃", {
  writes: ["00AA00" + setEffectStatic],
  expect_frames: [f(1, 1, 2, 1, 0x01, "01FF0000")],
  expect_errors: [],
  expect_remainders: [""],
});

// ---- feed：CRC 错 -> NAK 0x01 ----
{
  // 把静态红帧的 payload 尾字节改坏，CRC 字段保持原值 -> CRC 不匹配。
  const broken = toBytes(setEffectStatic);
  broken[9 + 3 - 1] ^= 0xff; // payload 最后一字节
  const brokenHex = toHex(broken);
  // 保证坏帧内部（首 magic 之后）不出现新的 AA 55，否则会走"半帧丢弃重同步"而不是 NAK。
  if (brokenHex.slice(4).includes("AA55")) throw new Error("坏帧意外包含 AA55，需另选损坏方式");
  feed("feed_crc_error", "CRC 错 -> NAK 0x01", {
    writes: [brokenHex],
    expect_frames: [],
    expect_errors: [{ kind: "crc_error", error: 1, seq: 1, type: 2 }],
    expect_remainders: [""],
  });
}

// ---- feed：seq 错（不产生 ACK，可被识别；匹配/重传归 BleLink） ----
feed("feed_seq_mismatch", "seq 错：seq=9 超过 outstanding=8，帧仍合法可识别，不产生 ACK", {
  writes: [encodeHex(f(1, 9, 2, 1, 0x01, "01FF0000"))],
  expect_frames: [f(1, 9, 2, 1, 0x01, "01FF0000")],
  expect_errors: [],
  expect_remainders: [""],
  last_outstanding_seq: 8,
  expect_ack_generated: false,
});

feed("feed_ack_echo", "ACK 回显 seq=7，编解码可识别（匹配逻辑在 BleLink）", {
  writes: [ack7],
  expect_frames: [f(1, 7, 7, 0, 0x00, "0700")],
  expect_errors: [],
  expect_remainders: [""],
  last_outstanding_seq: 7,
  expect_ack_generated: false,
});

// ---- feed：未知 type -> NAK 0x02 ----
feed("feed_unknown_type", "未知 type 0x0A -> NAK 0x02", {
  writes: [encodeHex(f(1, 11, 0x0a, 0, 0x00, ""))],
  expect_frames: [],
  expect_errors: [{ kind: "unknown_type", error: 2, seq: 11, type: 0x0a }],
  expect_remainders: [""],
});

// ---- feed：未知灯效 -> NAK 0x03 ----
feed("feed_unknown_effect", "未知灯效 0x07 -> NAK 0x03", {
  writes: [encodeHex(f(1, 12, 2, 1, 0x01, "07"))],
  expect_frames: [],
  expect_errors: [{ kind: "unknown_effect", error: 3, seq: 12, type: 2 }],
  expect_remainders: [""],
});

// ---- feed：param_len 过短 -> NAK 0x04 ----
feed("feed_param_len_short", "呼吸（效果参数期望 7，param_len 需 >= 8）param_len=4 -> NAK 0x04", {
  writes: [encodeHex(f(1, 13, 2, 1, 0x01, "02FF0000"))],
  expect_frames: [],
  expect_errors: [{ kind: "length_mismatch", error: 4, seq: 13, type: 2 }],
  expect_remainders: [""],
});

// ---- feed：param_len 过长 -> 接受，多余忽略 ----
feed("feed_param_len_over", "静态（param_len 需 >= 4）param_len=6 -> 接受，多余忽略", {
  writes: [encodeHex(f(1, 14, 2, 1, 0x02, "01FF0000AABB"))],
  expect_frames: [f(1, 14, 2, 1, 0x02, "01FF0000AABB")],
  expect_errors: [],
  expect_remainders: [""],
});

// ---- feed：版本不支持 -> NAK 0x08 ----
feed("feed_bad_version", "ver=2 -> NAK 0x08", {
  writes: [encodeHex(f(2, 15, 2, 1, 0x01, "FF0000"))],
  expect_frames: [],
  expect_errors: [{ kind: "bad_version", error: 8, seq: 15, type: 2 }],
  expect_remainders: [""],
});

// ---- feed：错误顺序（未知 type 在前、CRC 错在后） ----
feed("feed_two_errors", "两帧连续出错：先 unknown_type 后 crc_error，顺序保持", {
  writes: [
    encodeHex(f(1, 11, 0x0a, 0, 0x00, "")) +
      (() => {
        const broken = toBytes(setEffectStatic);
        broken[9 + 3 - 1] ^= 0xff;
        const hex = toHex(broken);
        if (hex.slice(4).includes("AA55")) throw new Error("坏帧意外包含 AA55");
        return hex;
      })(),
  ],
  expect_frames: [],
  expect_errors: [
    { kind: "unknown_type", error: 2, seq: 11, type: 0x0a },
    { kind: "crc_error", error: 1, seq: 1, type: 2 },
  ],
  expect_remainders: [""],
});

// ---- feed：半帧遇新 magic -> 丢弃半帧重同步 ----
feed("feed_resync_new_magic", "半帧未完成时遇到新 magic：丢弃半帧，解析新帧", {
  writes: [setBrightness.slice(0, 12), getStatus],
  expect_frames: [f(1, 3, 6, 0, 0x00, "")],
  expect_errors: [],
  expect_remainders: [setBrightness.slice(0, 12), ""],
});

// ---------- 组装并写出 ----------

const doc = {
  version: 1,
  encoding: "hex",
  generated_by: "tests/protocol/generate_vectors.mjs",
  description:
    "BLE Light Model 协议 v1 golden 向量：JS codec / C ble_proto（及后续 Python 复刻）共跑的唯一编解码契约。",
  frame: {
    magic: "AA55",
    layout: "AA55 | ver(1) | seq(2 LE) | type(1) | flags(1) | strip_mask(1) | param_len(1) | payload(N) | crc16(2 LE)",
    header_size: 9,
    max_payload: 255,
    max_frame_size: 266,
    endianness: "little",
    crc: "CRC-16/CCITT-FALSE：poly=0x1021 init=0xFFFF refin=false refout=false xorout=0x0000，覆盖 ver..payload",
    flags_ack: "bit0 = 需要 ACK；其余位保留，接收端忽略未知位，不 NAK",
  },
  constants: {
    protocol_version: 1,
    types: {
      hello: 1,
      set_effect: 2,
      set_brightness: 3,
      set_power_limit: 4,
      unlock_full_power: 5,
      get_status: 6,
      ack: 7,
      nak: 8,
      status: 9,
    },
    nak_errors: {
      crc: 1,
      unknown_type: 2,
      unknown_effect: 3,
      length_mismatch: 4,
      invalid_param: 5,
      not_unlocked: 6,
      busy: 7,
      bad_version: 8,
    },
  },
  effect_param_lengths: {
    "0x00": 0,
    "0x01": 3,
    "0x02": 7,
    "0x03": 10,
    "0x04": 3,
    "0x05": 7,
    "0x06": 5,
  },
  feed_semantics: {
    writes: "每次写入的原始 BLE 字节（hex）。两侧测试统一：pending = 上一次的 remainder；每次 feed(concat(pending, write))，remainder 作为下一次的 pending。",
    expect_remainders: "与 writes 等长：每次喂入后未完成尾字节的 hex（空串 = 无未完成数据）。",
    resync: "半帧（不完整帧）后遇到新的 AA 55 magic 时丢弃半帧；CRC 错但帧内出现 AA 55 视为错位垃圾并静默重同步；孤立 0xAA / 非帧垃圾静默丢弃。",
    seq: "seq 错不是协议错误：帧仍可解码、不产生 ACK；ACK 匹配、超时重传由 BleLink 负责（#4 决议）。expect_ack_generated=false 表示 Codec 不得自行产生 ACK 帧。",
    param_len: "SET_EFFECT payload = effect_id(1) + 效果参数；effect_param_lengths 只数效果参数。param_len >= 1+期望效果参数长度 接受、多余忽略；更短 NAK 0x04（#4 决议 param_len 向后兼容规则）。仅 SET_EFFECT 做灯效长度表校验，协议层不认识其他灯效语义。",
    validation_order: "CRC -> 版本(0x08) -> type(0x02) -> SET_EFFECT 灯效(0x03) -> 长度(0x04)",
  },
  vectors,
};

const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "vectors.json");
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

// 生成后自检：enc_get_status 必须等于 codec.test.ts 里手算的字面量
// （GET_STATUS 空 payload，CRC 覆盖 01 03 00 06 00 00 00 -> 0xA0D6，小端 D6 A0）。
const getStatusHex = vectors.find((v) => v.id === "enc_get_status").expect_hex;
if (getStatusHex !== "AA5501030006000000D6A0") {
  throw new Error(`enc_get_status 与手算字面量不符：${getStatusHex}`);
}

console.log(`vectors.json 已生成：${vectors.length} 个向量（encode ${vectors.filter((v) => v.kind === "encode").length} / feed ${vectors.filter((v) => v.kind === "feed").length}）`);