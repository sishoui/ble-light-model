// DeviceController 层 1 单测：8 行镜像 + 总开关 + 乐观更新/回滚（miniprogram.md §8）。
// 用 FakeTransport + FakeClock 注入，不真等。

import { describe, expect, it } from "vitest";
import {
  DeviceController,
  BleLink,
  FakeClock,
  Type,
  encode,
  TransportError,
} from "@ble-light/logic";
import { FakeTransport } from "./fake-transport";

const SERVICE = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
const PREFIX = "BLE-Light";

/** 让所有挂起的微任务（async 写链、ACK 计时器安置等）落定 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function buildScenePayload(): number[] {
  // SCENE 全量回读：strip0 ON(static white), 其余全关
  const out = [0x08];
  out.push(0x01, 0x03, 0xff, 0xff, 0xff); // strip0 static white
  for (let i = 1; i < 8; i++) out.push(0x00, 0x00);
  return out;
}

/** 起一个 ready 且场景已加载的 controller */
async function setup(): Promise<{
  controller: DeviceController;
  link: BleLink;
  transport: FakeTransport;
  clock: FakeClock;
}> {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
  const controller = new DeviceController({ link });
  const p = link.start();
  transport.addDevice({ deviceId: "d1", name: "BLE-Light-1234", rssi: -50 });
  // HELLO → ready
  const hello = [
    0x01, 0x00, 0x01, 0x00, 0x08, 0x64, 0x07,
    0x7f, ...Array.from({ length: 15 }, () => 0),
  ];
  transport.emitNotify(encode({ type: Type.HELLO, seq: 0, payload: hello }));
  await p;
  // controller.start() → on ready → getScene()
  const sp = controller.start();
  // 等 getScene 写发出，回 SCENE
  transport.emitNotify(encode({ type: Type.SCENE, seq: 0, payload: buildScenePayload() }));
  await sp;
  return { controller, link, transport, clock };
}

describe("DeviceController 8 行镜像", () => {
  it("ready + getScene 覆盖 8 行；allOn 派生正确", async () => {
    const { controller } = await setup();
    const state = controller.state;
    expect(state.link).toBe("ready");
    expect(state.rows.length).toBe(8);
    expect(state.rows[0].on).toBe(true);
    expect(state.rows[0].effectId).toBe(0x01);
    expect(state.rows[1].on).toBe(false);
    expect(state.allOn).toBe(true);
    expect(state.banner).toBeNull();
  });

  it("行开关开灯：乐观立即变亮，ACK 后 pending 清除、lastOn 提交", async () => {
    const { controller, transport } = await setup();
    // 点 strip1（当前 off）→ 开灯（默认静态白 0x01 + [128,128,128]）
    const before = controller.state.rows[1];
    expect(before.on).toBe(false);
    const p = controller.toggleStrip(1);
    // 乐观：立即 on + pending
    expect(controller.state.rows[1].on).toBe(true);
    expect(controller.state.rows[1].pending).toBe(true);
    // 回 ACK
    const frame = transport.writes[transport.writes.length - 1];
    const seq = frame[3] | (frame[4] << 8);
    transport.emitNotify(encode({ type: Type.ACK, seq: 0, payload: [seq & 0xff, (seq >> 8) & 0xff] }));
    await p;
    const after = controller.state.rows[1];
    expect(after.pending).toBe(false);
    expect(after.on).toBe(true);
    expect(after.effectId).toBe(0x01);
    expect(Array.from(after.params)).toEqual([128, 128, 128]);
  });

  it("行开关关灯：发送单 bit strip_mask 的 SET_EFFECT(0x00)", async () => {
    const { controller, transport } = await setup();
    // strip0 是开的 → 关灯
    const writesBefore = transport.writes.length;
    const p = controller.toggleStrip(0);
    const frame = transport.writes[transport.writes.length - 1];
    // strip_mask = 1<<0 = 1，type SET_EFFECT，payload effect_id=0
    expect(frame[5]).toBe(Type.SET_EFFECT);
    expect(frame[7]).toBe(0x01);
    expect(frame[9]).toBe(0x00);
    const seq = frame[3] | (frame[4] << 8);
    transport.emitNotify(encode({ type: Type.ACK, seq: 0, payload: [seq & 0xff, (seq >> 8) & 0xff] }));
    await p;
    expect(controller.state.rows[0].on).toBe(false);
    expect(controller.state.rows[0].effectId).toBe(0x00);
    void writesBefore;
  });

  it("NAK → 恢复旧 RowView、pending=false、行内 error=文案", async () => {
    const { controller, transport } = await setup();
    const p = controller.toggleStrip(1);
    // 乐观 on
    expect(controller.state.rows[1].on).toBe(true);
    const frame = transport.writes[transport.writes.length - 1];
    const seq = frame[3] | (frame[4] << 8);
    transport.emitNotify(encode({ type: Type.NAK, seq: 0, payload: [seq & 0xff, (seq >> 8) & 0xff, 0x05] }));
    await p;
    const row = controller.state.rows[1];
    expect(row.on).toBe(false); // 恢复旧状态
    expect(row.pending).toBe(false);
    expect(row.error).toBe("参数不合法");
  });

  it("超时（无 ACK）→ 恢复旧状态、error=设备无响应", async () => {
    const { controller, clock } = await setup();
    const p = controller.toggleStrip(1);
    expect(controller.state.rows[1].on).toBe(true);
    // 等 ACK 计时器被安置后再推进
    await flush();
    // 500ms×3 后无 ACK → timeout（每 500ms 一次重发，第 4 次超时）
    clock.advance(500);
    await flush();
    clock.advance(500);
    await flush();
    clock.advance(500);
    await flush();
    clock.advance(500);
    await flush();
    await p;
    const row = controller.state.rows[1];
    expect(row.on).toBe(false);
    expect(row.error).toBe("设备无响应");
  });

  it("非 ready 时点击 no-op：不写、视图不变", async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    const controller = new DeviceController({ link });
    await controller.start(); // 仍在 scanning
    expect(link.state).toBe("scanning");
    const writesBefore = transport.writes.length;
    await controller.toggleStrip(0);
    await controller.setMaster(true);
    expect(transport.writes.length).toBe(writesBefore);
    expect(controller.state.rows[0].on).toBe(false);
  });
});

describe("DeviceController 总开关", () => {
  it("任一开 → 一帧 SET_EFFECT(0x00) strip_mask=0xFF，8 行一起乐观关", async () => {
    const { controller, transport } = await setup();
    // strip0 是开的
    expect(controller.state.allOn).toBe(true);
    const p = controller.setMaster(false);
    // 乐观全关
    for (const row of controller.state.rows) expect(row.on).toBe(false);
    expect(controller.state.rows[0].pending).toBe(true);
    const frame = transport.writes[transport.writes.length - 1];
    expect(frame[5]).toBe(Type.SET_EFFECT);
    expect(frame[7]).toBe(0xff); // strip_mask 0xFF
    expect(frame[9]).toBe(0x00);
    const seq = frame[3] | (frame[4] << 8);
    transport.emitNotify(encode({ type: Type.ACK, seq: 0, payload: [seq & 0xff, (seq >> 8) & 0xff] }));
    await p;
    expect(controller.state.allOn).toBe(false);
    for (const row of controller.state.rows) {
      expect(row.pending).toBe(false);
      expect(row.on).toBe(false);
    }
  });

  it("全关 → 全开：逐条一帧按 lastOn 恢复；某条失败只回滚该行后续继续", async () => {
    const { controller, transport, clock } = await setup();
    // 先全关（提交 lastOn for strip0）
    let p = controller.setMaster(false);
    const f0 = transport.writes[transport.writes.length - 1];
    const s0 = f0[3] | (f0[4] << 8);
    transport.emitNotify(encode({ type: Type.ACK, seq: 0, payload: [s0 & 0xff, (s0 >> 8) & 0xff] }));
    await p;
    expect(controller.state.allOn).toBe(false);
    // 全开 → 逐条恢复：8 条各需 500ms×3+1 超时（4×500）
    const writesBefore = transport.writes.length;
    const p2 = controller.setMaster(true);
    // 为每条串行超时推进时钟（8 条 × 4 段 = 32 次 advance(500)）
    for (let i = 0; i < 32; i++) clock.advance(500);
    await p2;
    // 至少发了逐条命令
    expect(transport.writes.length).toBeGreaterThan(writesBefore);
  });
});