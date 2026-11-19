/**
 * LightService 单测（TDD，工单 #16）：FakeTransport 驱动的纯逻辑验证。
 * 页面与 WxTransport 薄壳不进单测（spec §1.1，靠真机冒烟）。
 */

import { describe, expect, it } from "vitest";

import { BleLink } from "./ble_link";
import { encode, FRAME_TYPES, PROTOCOL_VERSION } from "./codec";
import { InvalidStateError, TimeoutError } from "./errors";
import { EffectParamError, LightService, encodeEffectPayload } from "./light_service";
import type { EffectParams } from "./light_service";
import { FakeTransport, bytesToHex, hexToBytes } from "./test_utils/fake_transport";
import { FakeLightDevice } from "./test_utils/fake_device";

/** 状态帧 payload（#4 §4，24 字节）；uptime 1s，temp 30，active_effect L0=静态。 */
function statusHex(): string {
  // STATUS payload 24 字节（#4 §4）：active_effect 其余路全 0xff（未设置），仅 L0=1(静态)。
  const payload = new Uint8Array(24).fill(0xff);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 1, true);
  payload[4] = 30;
  view.setUint16(5, 100, true);
  payload[7] = 0;
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  payload[12] = 128;
  view.setUint16(13, 15000, true);
  payload[15] = 0;
  payload[16] = 1; // L0 当前 effect_id = 静态
  return bytesToHex(encode({ version: 1, seq: 7, type: FRAME_TYPES.status, flags: 0, stripMask: 0, payload }));
}

/** ACK 帧（LightService 按 payload ack_seq 关联，帧头 seq 任意）。 */
function ackHex(): string {
  const payload = new Uint8Array(2);
  new DataView(payload.buffer).setUint16(0, 0, true);
  return bytesToHex(encode({ version: 1, seq: 0, type: FRAME_TYPES.ack, flags: 0, stripMask: 0, payload }));
}

/**
 * ACK 帧（payload 回显客户端 seq）；帧头 seq 用独立值 0x5a5a，验证 LightService
 * 按 payload ack_seq 关联而非帧头 seq（#4：C3 的 notify 用独立 tx seq）。
 */
function ackHexFor(seq: number): string {
  const payload = new Uint8Array(2);
  new DataView(payload.buffer).setUint16(0, seq, true);
  return bytesToHex(encode({ version: 1, seq: 0x5a5a, type: FRAME_TYPES.ack, flags: 0, stripMask: 0, payload }));
}

/** 用 FakeTransport 组装（BleLink, LightService)，notifySettleMs=0 提速。 */
function setup(options: { notifyFrames?: string[]; mtu?: number; autoReconnect?: boolean } = {}) {
  const transport = new FakeTransport({
    notifyFrames: options.notifyFrames ?? [],
    ...(options.mtu === undefined ? {} : { mtu: options.mtu }),
  });
  const link = new BleLink(transport, {
    scanTimeoutMs: 20,
    reconnectDelayMs: 20,
    notifySettleMs: 0,
    // 默认关闭自动重连：多数用例不关心重连，关掉可避免断连后 reconnect timer 泄漏。
    autoReconnect: options.autoReconnect ?? false,
  });
  const service = new LightService(link);
  return { service, link, transport };
}

/**
 * 走页面同款流程：scan 记下设备 -> connect。
 * FakeTransport 的 notifyFrames 在 setNotification(true) 时推送（模拟 C3 订阅后
 * 主动发 HELLO / STATUS），但此推送早于 BleLink setState("ready")，LightService
 * 收帧通路独立于状态机，无碍。
 */
async function connectVia(service: LightService): Promise<void> {
  await service.scan({ timeoutMs: 10 });
  await service.connect();
}

describe("LightService 连接生命周期", () => {
  it("连接成功后进入 ready，状态订阅回调收到 ready 与 C3 主动 HELLO", async () => {
    const hello = encode({
      version: 1,
      seq: 0,
      type: FRAME_TYPES.hello,
      flags: 0,
      stripMask: 0,
      payload: hexToBytes("01000100083C3075983A4655077F000000000000000000"),
    });
    const { service, transport } = setup({ notifyFrames: [bytesToHex(hello)] });
    const states: string[] = [];
    service.onStateChange((state) => states.push(state));

    await connectVia(service);

    expect(service.state).toBe("ready");
    expect(service.hello?.protocolVersion).toBe(1);
    expect(service.hello?.fwVersion).toBe("0.1.0");
    expect(service.hello?.stripCount).toBe(8);
    expect(service.hello?.ledsPerStrip).toBe(60);
    expect(service.hello?.effectBitmap[0]! & 0x7f).toBe(0x7f); // 0x00–0x06 受支持
    expect(states).toContain("ready");
    expect(transport.opCount("notify")).toBe(1);
  });

  it("被动断连进入 reconnecting，状态订阅回调收到 reconnecting", async () => {
    const { service, transport } = setup({ autoReconnect: true });
    const states: string[] = [];
    service.onStateChange((state) => states.push(state));
    await connectVia(service);
    transport.dropConnection("C3-A1");

    expect(service.state).toBe("reconnecting");
    expect(states).toContain("reconnecting");
  });

  it("自动重连成功后回到 ready", async () => {
    const { service, transport } = setup({ autoReconnect: true });
    await connectVia(service);
    transport.dropConnection("C3-A1");
    expect(service.state).toBe("reconnecting");

    const deadline = Date.now() + 2000;
    while (service.state !== "ready" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(service.state).toBe("ready");
  });

  it("用户主动 disconnect 后回到 idle 且屏蔽自动重连", async () => {
    const { service, transport } = setup();
    await connectVia(service);
    await service.disconnect();

    expect(service.state).toBe("idle");
    expect(transport.opCount("connect")).toBe(1);
  });
});

describe("LightService.setEffect", () => {
  it("静态红：编码 SET_EFFECT(0x02, flags=1, mask, [0x01,FF,00,00]) 写入 CMD 特征", async () => {
    const { service, transport } = setup({ mtu: 247 });
    await connectVia(service);
    const pending = service.setEffect(0xff, { effect: "static", color: { r: 255, g: 0, b: 0 } });
    // C3 回同 seq ACK（LightService 不等会被 500ms 超时，这里立即喂上）。
    const ack = encode({
      version: 1,
      seq: 0,
      type: FRAME_TYPES.ack,
      flags: 0,
      stripMask: 0,
      payload: hexToBytes("0000"),
    });
    transport.emitNotification(bytesToHex(ack));
    await pending;

    const expected = encode({
      version: PROTOCOL_VERSION,
      seq: 0,
      type: FRAME_TYPES.setEffect,
      flags: 1,
      stripMask: 0xff,
      payload: hexToBytes("01FF0000"),
    });
    expect(transport.writes.map((w) => w.hex)).toEqual([bytesToHex(expected)]);
  });

  it("7 种灯效参数编码与 #4 决议一致（seq 递增，flags=1 请求 ACK）", async () => {
    const { service, transport } = setup({ mtu: 247 });
    await connectVia(service);

    // 逐条喂 ACK（seq 0..6）：LightService 先写，收到同 seq ACK 才 resolve。
    const cases: [number, EffectParams][] = [
      [0x01, { effect: "off" }],
      [0x02, { effect: "static", color: { r: 1, g: 2, b: 3 } }],
      [0x04, { effect: "breath", color: { r: 1, g: 2, b: 3 }, periodMs: 1000, min: 10, max: 200 }],
      [0x08, { effect: "gradient", from: { r: 1, g: 2, b: 3 }, to: { r: 4, g: 5, b: 6 }, periodMs: 2000, direction: 1 }],
      [0x10, { effect: "rainbow", speed: 5, saturation: 200, direction: 0 }],
      [0x20, { effect: "flow", color: { r: 9, g: 8, b: 7 }, speed: 3, length: 10, direction: 1 }],
      [0x40, { effect: "twinkle", color: { r: 1, g: 2, b: 3 }, density: 100, speed: 4 }],
    ];
    const seqs: number[] = [];
    for (let i = 0; i < cases.length; i += 1) {
      const [mask, params] = cases[i]!;
      const pending = service.setEffect(mask, params);
      seqs.push(i);
      // C3 回 ACK（payload ack_seq 回显客户端 seq i；帧头 seq 无关）。
      transport.emitNotification(ackHexFor(i));
      await pending;
    }

    const frames = transport.writes.map((w) => {
      const bytes = new Uint8Array(w.value);
      return {
        seq: bytes[3]! | (bytes[4]! << 8),
        type: bytes[5]!,
        flags: bytes[6]!,
        mask: bytes[7]!,
        payload: bytesToHex(bytes.subarray(9, bytes.length - 2)),
      };
    });
    // 期望 payload 即 encodeEffectPayload 的逐字节输出（effect_id + 参数）。
    const expectedPayloads = cases.map(([, params]) => bytesToHex(encodeEffectPayload(params)));
    expect(frames).toEqual(
      cases.map(([mask], seq) => ({ seq, type: 0x02, flags: 1, mask, payload: expectedPayloads[seq]! })),
    );
    // 关键字节逐效果核对（#4 决议第 3 节参数布局）。
    expect(expectedPayloads).toEqual([
      "00", // off
      "01" + "010203", // static
      "02" + "010203" + "e803" + "0a" + "c8", // breath: period 1000, min 10, max 200
      "03" + "010203" + "040506" + "d007" + "01" + "00", // gradient: to=040506, period 2000, dir 1, 末尾保留字节
      "04" + "05" + "c8" + "00", // rainbow: speed 5, sat 200, dir 0
      "05" + "090807" + "03" + "0a" + "01" + "00", // flow: color 090807, speed 3, length 10, dir 1, 末尾保留字节（参数长度 7）
      "06" + "010203" + "64" + "04", // twinkle: density 100, speed 4
    ]);
  });

  it("写串行：连续两次 setEffect 顺序入队，按调用顺序写出", async () => {
    const { service, transport } = setup({ mtu: 247 });
    await connectVia(service);

    const first = service.setEffect(0x01, { effect: "off" });
    const second = service.setEffect(0x01, { effect: "static", color: { r: 0xff, g: 0, b: 0 } });
    for (const seq of [0, 1]) {
      // 顺序回 ACK（payload ack_seq = 客户端 seq；帧头 seq 无关）。
      transport.emitNotification(ackHexFor(seq));
    }
    await Promise.all([first, second]);

    const expected0 = encode({
      version: PROTOCOL_VERSION,
      seq: 0,
      type: FRAME_TYPES.setEffect,
      flags: 1,
      stripMask: 0x01,
      payload: hexToBytes("00"),
    });
    const expected1 = encode({
      version: PROTOCOL_VERSION,
      seq: 1,
      type: FRAME_TYPES.setEffect,
      flags: 1,
      stripMask: 0x01,
      payload: hexToBytes("01FF0000"),
    });
    expect(transport.writes.map((w) => w.hex)).toEqual([bytesToHex(expected0), bytesToHex(expected1)]);
  });

  it("未连接时 setEffect 抛 InvalidStateError，不产生写", async () => {
    const { service, transport } = setup();
    await expect(service.setEffect(0xff, { effect: "off" })).rejects.toBeInstanceOf(InvalidStateError);
    expect(transport.opCount("write")).toBe(0);
  });

  it("断连后 setEffect reject INVALID_STATE（BleLink 断连路径②：断连后写被状态机拒绝）", async () => {
    const { service, transport } = setup({ mtu: 247 });
    await connectVia(service);
    transport.dropConnection("C3-A1");
    await new Promise((resolve) => setTimeout(resolve, 5)); // 断连事件已派发
    await expect(service.setEffect(0xff, { effect: "off" })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(transport.opCount("write")).toBe(0);
  });

  it("缺参数抛 EffectParamError（编码前校验）", async () => {
    const { service, transport } = setup({ mtu: 247 });
    await connectVia(service);
    const bad: Record<string, unknown> = { effect: "static" };
    await expect(service.setEffect(0xff, bad as never)).rejects.toBeInstanceOf(EffectParamError);
    const breath: Record<string, unknown> = { effect: "breath", color: { r: 1, g: 2, b: 3 } };
    await expect(service.setEffect(0xff, breath as never)).rejects.toBeInstanceOf(EffectParamError);
    expect(transport.opCount("write")).toBe(0);
  });

  it("越界参数抛 EffectParamError", async () => {
    const { service } = setup({ mtu: 247 });
    await connectVia(service);
    await expect(
      service.setEffect(0xff, { effect: "static", color: { r: 256, g: 0, b: 0 } }),
    ).rejects.toBeInstanceOf(EffectParamError);
    await expect(
      service.setEffect(0xff, { effect: "breath", color: { r: 1, g: 2, b: 3 }, periodMs: 70000, min: 0, max: 255 }),
    ).rejects.toBeInstanceOf(EffectParamError);
  });

  it("notifySettleMs 默认 200ms：订阅后窗口内的首写自动等待生效延迟", async () => {
    const transport = new FakeTransport({ mtu: 247 });
    const link = new BleLink(transport, { scanTimeoutMs: 20, reconnectDelayMs: 20 });
    const service = new LightService(link);
    await service.scan({ timeoutMs: 10 });
    await service.connect();

    const t0 = Date.now();
    const pending = service.setEffect(0xff, { effect: "off" });
    await new Promise((resolve) => setTimeout(resolve, 30)); // 期间被 notifySettle 挡住
    expect(transport.writes).toHaveLength(0);
    const ack = encode({
      version: 1,
      seq: 0,
      type: FRAME_TYPES.ack,
      flags: 0,
      stripMask: 0,
      payload: hexToBytes("0000"),
    });
    transport.emitNotification(bytesToHex(ack));
    await pending;
    const firstWriteAt = transport.writes[0]?.at ?? 0;
    expect(firstWriteAt - t0).toBeGreaterThanOrEqual(190);
  });
});

describe("LightService 写结果（ACK / NAK）", () => {
  it("flags bit0=1 且 C3 回同 seq ACK：setEffect resolve", async () => {
    const { service, transport } = setup();
    await connectVia(service);
    const pending = service.setEffect(0xff, { effect: "off" });
    // 模拟 C3 收到 seq=0 后回 ACK（从 transport 侧注入）。
    transport.emitNotification(ackHex());
    await expect(pending).resolves.toBeUndefined();
  });

  it("C3 帧头 seq 与客户端 seq 解耦时按 payload ack_seq 关联（旧实现按帧头匹配会挂）", async () => {
    // FakeLightDevice 用独立 tx seq：HELLO 消耗 seq 0，客户端 setEffect seq 0
    // 的 ACK 帧头 seq=1 ≠ 客户端 seq 0 —— 旧实现按帧头匹配会永远等不到、超时挂起。
    let device: FakeLightDevice;
    const transport = new FakeTransport({
      mtu: 247,
      onWrite: (b) => device.onWrite(b),
    });
    device = new FakeLightDevice(transport, {});
    const link = new BleLink(transport, {
      scanTimeoutMs: 20,
      reconnectDelayMs: 20,
      notifySettleMs: 0,
      autoReconnect: false,
    });
    const service = new LightService(link);
    await service.scan({ timeoutMs: 10 });
    await service.connect();
    await service.setEffect(0x01, { effect: "static", color: { r: 255, g: 0, b: 0 } });
    expect(device.activeEffect[0]).toBe(1); // L0 已落地灯效
    expect(device.activeEffect[1]).toBe(0xff); // L1 未选
  });

  it("C3 回 NAK 0x06（未解锁）：setEffect reject ServiceNakError", async () => {
    const { service, transport } = setup({ mtu: 247 });
    await connectVia(service);
    const pending = service.setEffect(0xff, { effect: "static", color: { r: 255, g: 255, b: 255 } });
    const nak = encode({
      version: 1,
      seq: 0,
      type: FRAME_TYPES.nak,
      flags: 0,
      stripMask: 0,
      payload: hexToBytes("0000" + "06"),
    });
    transport.emitNotification(bytesToHex(nak));
    await expect(pending).rejects.toMatchObject({ code: "SERVICE_NAK", nakCode: 0x06 });
  });

  it("无 ACK 时 500ms 超时抛 TimeoutError，且只发一次不自动重试", async () => {
    const { service, transport } = setup({ mtu: 247 });
    await connectVia(service);
    await expect(service.setEffect(0xff, { effect: "off" })).rejects.toBeInstanceOf(TimeoutError);
    expect(transport.opCount("write")).toBe(1);
  });

  it("写失败（10006）立即 reject NOT_CONNECTED，不等超时", async () => {
    const { service, transport } = setup({ mtu: 247 });
    await connectVia(service);
    transport.enqueueFailure("write", 10006);
    await expect(service.setEffect(0xff, { effect: "off" })).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });
});

describe("LightService 状态查询", () => {
  it("connect 后收到周期 STATUS：status 快照字段正确", async () => {
    const { service } = setup({ notifyFrames: [ackHex(), statusHex()], mtu: 247 });
    await connectVia(service);

    const status = service.status;
    expect(status).toBeDefined();
    expect(status?.uptimeS).toBe(1);
    expect(status?.tempC).toBe(30);
    expect(status?.brightness).toBe(128);
    expect(status?.powerLimitMa).toBe(15000);
    expect(status?.activeEffect[0]).toBe(1);
    expect(status?.activeEffect[1]).toBe(0xff); // 未设置
  });

  it("requestStatus 发送 GET_STATUS 并等待 STATUS 帧", async () => {
    const { service, transport } = setup({ mtu: 247 });
    await connectVia(service);
    const getStatus = encode({
      version: PROTOCOL_VERSION,
      seq: 0,
      type: FRAME_TYPES.getStatus,
      flags: 0,
      stripMask: 0,
      payload: new Uint8Array(0),
    });
    // GET_STATUS 走 BleLink.write，订阅生效延迟 200ms 后才真正发出。
    const pending = service.requestStatus();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(transport.writes.map((w) => w.hex)).toContain(bytesToHex(getStatus));
    const status = statusHex();
    transport.emitNotification(status);
    await expect(pending).resolves.toBeDefined();
  });

  it("STATUS payload 长度不对时忽略，不抛错", async () => {
    const { service, transport } = setup();
    await connectVia(service);
    const bad = encode({
      version: 1,
      seq: 0,
      type: FRAME_TYPES.status,
      flags: 0,
      stripMask: 0,
      payload: hexToBytes("0102"),
    });
    transport.emitNotification(bytesToHex(bad));
    expect(service.status).toBeUndefined();
  });

  it("未连接时 requestStatus 抛 InvalidStateError", async () => {
    const { service } = setup();
    await expect(service.requestStatus()).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe("协议解码健壮性（通知流）", () => {
  it("粘包：HELLO + STATUS 同一次 notify 也能分别解出", async () => {
    const { service, transport } = setup({ notifyFrames: [], mtu: 247 });
    await connectVia(service);
    const hello = encode({
      version: 1,
      seq: 0,
      type: FRAME_TYPES.hello,
      flags: 0,
      stripMask: 0,
      payload: hexToBytes("01000100083C3075983A4655077F000000000000000000"),
    });
    const status = hexToBytes(statusHex());
    const combined = new Uint8Array(hello.length + status.length);
    combined.set(hello, 0);
    combined.set(status, hello.length);
    transport.emitNotification(bytesToHex(combined));

    expect(service.hello?.protocolVersion).toBe(1);
    expect(service.status?.uptimeS).toBe(1);
  });

  it("半帧：notify 分两次到达，跨调用重组", async () => {
    const status = hexToBytes(statusHex());
    const { service, transport } = setup({ notifyFrames: [], mtu: 247 });
    await connectVia(service);
    transport.emitNotification(bytesToHex(status.slice(0, 10)));
    transport.emitNotification(bytesToHex(status.slice(10)));

    expect(service.status?.uptimeS).toBe(1);
  });
});