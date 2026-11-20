// Golden vector generator — protocol v1 contract (issue #22, docs/spec/protocol.md)
// This file DEFINES the contract vectors. It is not the production codec.
// Run: node tests/protocol/generate_vectors.mjs > tests/protocol/vectors.json
//
// Frame:  AA 55 | ver(1) | seq(2 LE) | type(1) | flags(1) | strip_mask(1) | param_len(1) | payload | crc16(2 LE)
// CRC:    CRC-16/CCITT-FALSE, poly 0x1021, init 0xFFFF, over ver..payload
// flags:  bit0 = NEED_ACK; other bits reserved, ignore unknown, never NAK.
// types:  0x01 HELLO, 0x02 SET_EFFECT, 0x03-0x05 reserved, 0x06 GET_STATUS,
//         0x07 ACK, 0x08 NAK, 0x09 STATUS, 0x0A GET_SCENE, 0x0B SCENE

const T = {
  HELLO: 0x01, SET_EFFECT: 0x02,
  GET_STATUS: 0x06, ACK: 0x07, NAK: 0x08, STATUS: 0x09,
  GET_SCENE: 0x0a, SCENE: 0x0b,
};
const FLAG_ACK = 0x01;
const NAK_CODES = {
  CRC: 0x01, UNKNOWN_TYPE: 0x02, UNKNOWN_EFFECT: 0x03,
  LEN_MISMATCH: 0x04, BAD_PARAM: 0x05, BUSY: 0x07, BAD_VERSION: 0x08,
};

function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= (b & 0xff) << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function buildFrame({ ver = 1, seq = 0, type, flags = 0, strip_mask = 0, payload = [] }) {
  if (payload.length > 255) throw new Error("payload > 255");
  const body = [
    ver & 0xff,
    seq & 0xff, (seq >> 8) & 0xff,
    type & 0xff,
    flags & 0xff,
    strip_mask & 0xff,
    payload.length & 0xff,
    ...payload.map((x) => x & 0xff),
  ];
  const crc = crc16(body);
  return [0xaa, 0x55, ...body, crc & 0xff, (crc >> 8) & 0xff];
}

// ---- payload builders (RGB effect params per protocol.md) ----
const eff = {
  OFF: [], STATIC: [0x01, 0xff, 0xff, 0xff],
  BREATH: [0x02, 0xff, 0x00, 0x00, 0xe8, 0x03, 0x00, 0xff], // R,G,B, period=1000 LE, min=0, max=255
  GRADIENT: [0x03, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xe8, 0x03, 0x00], // 2 colors, period=1000, dir=0
  RAINBOW: [0x04, 0xff, 0xff, 0x00], // speed, saturation, dir
  FLOW: [0x05, 0xff, 0x00, 0x00, 0x80, 0x10, 0x00], // R,G,B,speed,length,dir
  SPARKLE: [0x06, 0xff, 0xff, 0xff, 0x20, 0x40], // R,G,B,density,speed
};

const statusPayload = () => [
  0x10, 0x00, 0x00, 0x00, // uptime_s = 16
  0x00, 0x00,             // glitch_count = 0
  0x00, 0x00,             // drop_count = 0
  0x00,                   // strip_fault = 0
  0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, // active_effect[8]
];
const hellopayload = () => [
  0x01, 0x00, 0x01, 0x00, // ver, fw 0.1.0
  0x08, 0x64,            // strip_count=8, leds_per_strip=100
  0x07,                  // caps: bit0 GET_SCENE, bit1 scene persistence, bit2 effect_bitmap valid
  ...Array.from({ length: 16 }, (_, i) => (i === 0 ? 0x7f : 0)), // effect_bitmap: effect 0x00-0x06 -> byte0 bit0..6
];
const scenePayload = () => {
  const out = [0x08]; // strip_count
  out.push(0x00, 0x00);                 // strip0 OFF
  out.push(0x01, 0x03, 0xff, 0x40, 0x20); // strip1 static
  out.push(0x02, 0x07, ...eff.BREATH);  // strip2 breath
  out.push(0x03, 0x0a, ...eff.GRADIENT);
  out.push(0x04, 0x03, ...eff.RAINBOW);
  out.push(0x05, 0x07, ...eff.FLOW);
  out.push(0x06, 0x05, ...eff.SPARKLE);
  out.push(0x00, 0x00);                 // strip7 OFF
  return out;
};

const nak = (seq, err) => buildFrame({ seq, type: T.NAK, payload: [seq & 0xff, (seq >> 8) & 0xff, err] });

const encode = (name, frame, note) => ({ name, note, bytes: frame });
const feed = (name, chunks, expect, note) => ({ name, chunks, expect, note });

const out = {
  meta: {
    issue: 22,
    frame: "AA55|ver(1)|seq(2 LE)|type(1)|flags(1)|strip_mask(1)|param_len(1)|payload|crc16(2 LE)",
    crc: "CRC-16/CCITT-FALSE poly=0x1021 init=0xFFFF, over ver..payload",
    types: T,
    nak_codes: NAK_CODES,
    notes: "flags bit0 NEED_ACK; reserved bits ignored. Payload <= 255. Frame <= 266.",
  },
  encode: [],
  feed: [],
};

// ================= ENCODE (fixed input -> expected bytes) =================
out.encode.push(encode("encode/set_effect_static_off",
  buildFrame({ seq: 0, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: [0x00] }),
  "strip0 OFF, seq=0, needs ACK"));

out.encode.push(encode("encode/set_effect_static_white",
  buildFrame({ seq: 1, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0xff, payload: eff.STATIC }),
  "all strips static white, seq=1, needs ACK"));

out.encode.push(encode("encode/set_effect_breath",
  buildFrame({ seq: 0x1234, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x03, payload: eff.BREATH }),
  "strip0-1 breath red, period 1000ms, seq=0x1234"));

out.encode.push(encode("encode/set_effect_gradient",
  buildFrame({ seq: 2, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x0f, payload: eff.GRADIENT }),
  "gradient red->blue, period 1000ms"));

out.encode.push(encode("encode/set_effect_rainbow",
  buildFrame({ seq: 3, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0xf0, payload: eff.RAINBOW }),
  "rainbow on strip4-7, speed=255, sat=255, dir=0"));

out.encode.push(encode("encode/set_effect_flow",
  buildFrame({ seq: 4, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x10, payload: eff.FLOW }),
  "flow red, speed=128, tail=16, dir=0"));

out.encode.push(encode("encode/set_effect_sparkle",
  buildFrame({ seq: 5, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x20, payload: eff.SPARKLE }),
  "sparkle white, density=32, speed=64"));

out.encode.push(encode("encode/get_status",
  buildFrame({ seq: 6, type: T.GET_STATUS, flags: 0, strip_mask: 0, payload: [] }),
  "GET_STATUS, seq=6, no ACK flag (reply is STATUS)"));

out.encode.push(encode("encode/get_scene",
  buildFrame({ seq: 7, type: T.GET_SCENE, flags: 0, strip_mask: 0, payload: [] }),
  "GET_SCENE, seq=7, no ACK flag (reply is SCENE)"));

out.encode.push(encode("encode/ack",
  buildFrame({ seq: 8, type: T.ACK, payload: [0x34, 0x12] }),
  "ACK echoing seq=0x1234"));

out.encode.push(encode("encode/nak_unknown_effect",
  nak(0x1234, NAK_CODES.UNKNOWN_EFFECT),
  "NAK seq=0x1234 error=0x03 unknown effect"));

out.encode.push(encode("encode/hello",
  buildFrame({ seq: 0, type: T.HELLO, payload: hellopayload() }),
  "HELLO 23B payload: ver,fw 0.1.0, 8 strips, 100 leds, caps, effect_bitmap"));

out.encode.push(encode("encode/status",
  buildFrame({ seq: 1, type: T.STATUS, payload: statusPayload() }),
  "STATUS 17B payload"));

out.encode.push(encode("encode/scene",
  buildFrame({ seq: 2, type: T.SCENE, payload: scenePayload() }),
  "SCENE full readback, 8 strips"));

out.encode.push(encode("encode/param_len_255",
  buildFrame({ seq: 9, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0xff, payload: Array.from({ length: 255 }, () => 0x5a) }),
  "maximum payload 255; frame length = 266"));

// fragmented encode: same frame sliced into 20-byte BLE writes (no fragment header)
{
  const frame = buildFrame({ seq: 0x1234, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x03, payload: eff.BREATH });
  const chunks = [];
  for (let i = 0; i < frame.length; i += 20) chunks.push(frame.slice(i, i + 20));
  out.encode.push({ name: "encode/fragment_20", note: "frame sliced into 20-byte writes", bytes: frame, chunks });
}

// ================= FEED (chunk stream -> frames / naks / discard) =================
// Feed vectors: chunks are BLE payload slices as received; expect lists parsed frames,
// emitted naks, and replies the receiver must generate.

const frameOf = (f) => ({
  ver: f[2], seq: f[3] | (f[4] << 8), type: f[5], flags: f[6],
  strip_mask: f[7], param_len: f[8], payload: f.slice(9, 9 + f[8]),
});

// 1 normal
{
  const f = buildFrame({ seq: 0x0010, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: eff.STATIC });
  out.feed.push(feed("feed/normal", [f], {
    frames: [frameOf(f)], naks: [], reply: "ACK seq=0x0010",
  }, "one whole frame in one chunk"));
}
// 2 fragmented reassembly
{
  const f = buildFrame({ seq: 0x0011, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: eff.BREATH });
  const chunks = [];
  for (let i = 0; i < f.length; i += 20) chunks.push(f.slice(i, i + 20));
  out.feed.push(feed("feed/fragmented", chunks, {
    frames: [frameOf(f)], naks: [], reply: "ACK seq=0x0011",
  }, "frame split across 20-byte writes, reassembled without header"));
}
// 3 coalesced two frames in one chunk
{
  const a = buildFrame({ seq: 0x0012, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: eff.OFF });
  const b = buildFrame({ seq: 0x0013, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: eff.STATIC });
  out.feed.push(feed("feed/coalesced", [[...a, ...b]], {
    frames: [frameOf(a), frameOf(b)], naks: [], reply: "ACK seq=0x0012, ACK seq=0x0013",
  }, "two frames glued in one buffer"));
}
// 4 CRC error -> NAK CRC
{
  const f = buildFrame({ seq: 0x0014, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: eff.STATIC });
  f[f.length - 1] ^= 0xff; // corrupt high CRC byte
  out.feed.push(feed("feed/crc_error", [f], {
    frames: [], naks: [nak(0x0014, NAK_CODES.CRC)],
  }, "corrupt CRC -> NAK 0x01, frame dropped, next magic resyncs"));
}
// 5 unknown type -> NAK 0x02
{
  const f = buildFrame({ seq: 0x0015, type: 0x7f, flags: 0, strip_mask: 0x01, payload: [] });
  out.feed.push(feed("feed/unknown_type", [f], {
    frames: [], naks: [nak(0x0015, NAK_CODES.UNKNOWN_TYPE)],
  }, "type 0x7F not defined -> NAK 0x02"));
}
// 6 unknown effect -> NAK 0x03
{
  const f = buildFrame({ seq: 0x0016, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: [0x7f, 0x00, 0x00] });
  out.feed.push(feed("feed/unknown_effect", [f], {
    frames: [], naks: [nak(0x0016, NAK_CODES.UNKNOWN_EFFECT)],
  }, "effect_id 0x7F not in effect_bitmap -> NAK 0x03"));
}
// 7 param_len too short -> NAK 0x04
{
  const f = buildFrame({ seq: 0x0017, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: [0x02, 0xff, 0x00] }); // breath needs 7, got 3
  out.feed.push(feed("feed/param_len_short", [f], {
    frames: [], naks: [nak(0x0017, NAK_CODES.LEN_MISMATCH)],
  }, "breath payload 3 < expected 7 -> NAK 0x04"));
}
// 8 param_len too long -> accepted, extras ignored
{
  const f = buildFrame({ seq: 0x0018, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: [0x01, 0xff, 0x00, 0x00, 0xaa, 0xbb] }); // static needs 3, got 6
  out.feed.push(feed("feed/param_len_over", [f], {
    frames: [{ ...frameOf(f), applied: { effect_id: 0x01, params: [0xff, 0x00, 0x00] } }],
    naks: [], reply: "ACK seq=0x0018",
  }, "static payload 6 > expected 3 -> accept, ignore 0xAA 0xBB"));
}
// 9 bad version -> NAK 0x08
{
  const f = buildFrame({ ver: 2, seq: 0x0019, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: eff.STATIC });
  out.feed.push(feed("feed/version_bad", [f], {
    frames: [], naks: [nak(0x0019, NAK_CODES.BAD_VERSION)],
  }, "ver=2 unsupported -> NAK 0x08"));
}
// 10 half-frame timeout -> discard, no NAK
{
  const f = buildFrame({ seq: 0x001a, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: eff.BREATH });
  const partial = f.slice(0, 10);
  out.feed.push(feed("feed/half_frame_timeout", [partial], {
    frames: [], naks: [], discard: true,
  }, "incomplete frame, 200ms elapsed -> discard silently, no NAK"));
}
// 11 duplicate seq -> idempotent re-ACK, no double apply
{
  const f = buildFrame({ seq: 0x001b, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: eff.STATIC });
  out.feed.push(feed("feed/duplicate_seq", [[...f, ...f]], {
    frames: [frameOf(f)], naks: [], reply: "ACK seq=0x001b (twice; second is idempotent re-ACK, not re-applied)",
  }, "same seq resent -> re-ACK, no double apply"));
}
// 12 GET_STATUS -> emits STATUS
{
  const f = buildFrame({ seq: 0x001c, type: T.GET_STATUS, flags: 0, strip_mask: 0, payload: [] });
  out.feed.push(feed("feed/get_status", [f], {
    frames: [frameOf(f)], naks: [], reply: "STATUS (periodic snapshot)",
  }, "GET_STATUS -> receiver emits STATUS, no ACK"));
}
// 13 GET_SCENE -> emits SCENE
{
  const f = buildFrame({ seq: 0x001d, type: T.GET_SCENE, flags: 0, strip_mask: 0, payload: [] });
  out.feed.push(feed("feed/get_scene", [f], {
    frames: [frameOf(f)], naks: [], reply: "SCENE (full 8-strip readback)",
  }, "GET_SCENE -> receiver emits SCENE, no ACK"));
}
// 14 bad param -> NAK 0x05
{
  const f = buildFrame({ seq: 0x001e, type: T.SET_EFFECT, flags: FLAG_ACK, strip_mask: 0x01, payload: [0x02, 0xff, 0x00, 0x00, 0x64, 0x00, 0x80, 0x20] }); // min=128 > max=32
  out.feed.push(feed("feed/bad_param", [f], {
    frames: [], naks: [nak(0x001e, NAK_CODES.BAD_PARAM)],
  }, "breath min > max -> NAK 0x05"));
}

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
