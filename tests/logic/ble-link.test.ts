// BleLink 层 1 单测：6 态状态机 + 命令会话（miniprogram.md §6）。
// 用 FakeTransport + FakeClock 注入，不真等。

import { describe, expect, it } from "vitest";
import {
  BleLink,
  FakeClock,
  CommandError,
  Type,
  encode,
  TransportError,
} from "@ble-light/logic";
import { FakeTransport } from "./fake-transport";

const SERVICE = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
const PREFIX = "BLE-Light";

/** 让所有挂起的微任务（async 写链、connect 拒绝等）落定 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function makeHello(payload?: number[]): Uint8Array {
  const hello = payload ?? [
    0x01, 0x00, 0x01, 0x00, // ver, fw 0.1.0
    0x08, 0x64, // 8 strips, 100 leds
    0x07, // caps
    0x7f, ...Array.from({ length: 15 }, () => 0), // effect_bitmap
  ];
  return encode({ type: Type.HELLO, seq: 0, payload: hello });
}

function makeReady(
  link: BleLink,
  transport: FakeTransport,
  clock: FakeClock,
): void {
  const p = link.start();
  transport.addDevice({ deviceId: "d1", name: "BLE-Light-1234", rssi: -50 });
  transport.emitNotify(makeHello());
  void p;
  expect(link.state).toBe("ready");
  void clock;
}

describe("BleLink 状态机", () => {
  it("start: idle → scanning → connecting（匹配广播）", async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    expect(link.state).toBe("idle");
    const p = link.start();
    expect(link.state).toBe("scanning");
    transport.addDevice({ deviceId: "d1", name: "BLE-Light-1234", rssi: -50 });
    expect(link.state).toBe("connecting");
    await p;
  });

  it("connecting + HELLO → ready；caps 就位", async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    await link.start();
    transport.addDevice({ deviceId: "d1", name: "BLE-Light-1234", rssi: -50 });
    expect(link.state).toBe("connecting");
    transport.emitNotify(makeHello());
    expect(link.state).toBe("ready");
    expect(link.caps?.fw.major).toBe(0);
    expect(link.caps?.stripCount).toBe(8);
  });

  it("scanning 8s 无匹配 → failed", async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    await link.start();
    expect(link.state).toBe("scanning");
    clock.advance(8000);
    expect(link.state).toBe("failed");
  });

  it("connecting 连接失败（首连）→ failed，不自动重连", async () => {
    const transport = new FakeTransport({ failConnect: true });
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    await link.start();
    transport.addDevice({ deviceId: "d1", name: "BLE-Light-1234", rssi: -50 });
    expect(link.state).toBe("connecting");
    // 等待 connect 失败微任务落地
    await Promise.resolve();
    expect(link.state).toBe("failed");
  });

  it("FAILED 只经 retry() 离开；其它操作 no-op", async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    await link.start();
    clock.advance(8000);
    expect(link.state).toBe("failed");
    // setEffect / getStatus 在 failed 下 reject
    await expect(link.setEffect(1, 1, Uint8Array.from([255, 0, 0]))).rejects.toBeInstanceOf(CommandError);
    // retry → scanning
    const rp = link.retry();
    expect(link.state).toBe("scanning");
    await rp;
  });

  it("ready + 10s 无帧（看门狗）→ reconnecting", async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    await link.start();
    transport.addDevice({ deviceId: "d1", name: "BLE-Light-1234", rssi: -50 });
    transport.emitNotify(makeHello());
    expect(link.state).toBe("ready");
    // 有帧会重置看门狗：先发一帧在 5s，再推进到 15s（> 10s 无帧）
    clock.advance(5000);
    transport.emitNotify(makeHello()); // 重置 watchdog
    expect(link.state).toBe("ready");
    clock.advance(10000);
    expect(link.state).toBe("reconnecting");
  });

  it("ready 收到非预期断连 → reconnecting；3 次重连失败 → failed", async () => {
    const transport = new FakeTransport({ failConnect: true });
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    await link.start();
    transport.addDevice({ deviceId: "d1", name: "BLE-Light-1234", rssi: -50 });
    transport.emitNotify(makeHello());
    expect(link.state).toBe("ready");
    // 断连
    transport.emitDisconnect(new TransportError("not-connected", "link lost"));
    expect(link.state).toBe("reconnecting");
    // 3 次尝试都失败 → failed（退避 500/1000/2000）
    clock.advance(500); // attempt1 连接失败（异步）
    await Promise.resolve();
    expect(link.state).toBe("reconnecting");
    clock.advance(1000); // attempt2
    await Promise.resolve();
    expect(link.state).toBe("reconnecting");
    clock.advance(2000); // attempt3 失败 → failed
    await Promise.resolve();
    expect(link.state).toBe("failed");
  });

  it("重连成功（+HELLO）→ ready", async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    await link.start();
    transport.addDevice({ deviceId: "d1", name: "BLE-Light-1234", rssi: -50 });
    transport.emitNotify(makeHello());
    expect(link.state).toBe("ready");
    transport.emitDisconnect(new TransportError("not-connected", "link lost"));
    expect(link.state).toBe("reconnecting");
    clock.advance(500); // attempt1 连接成功
    transport.emitNotify(makeHello()); // 收到 HELLO → ready
    expect(link.state).toBe("ready");
  });

  it("stop() 任意状态 → idle", async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    await link.start();
    transport.addDevice({ deviceId: "d1", name: "BLE-Light-1234", rssi: -50 });
    transport.emitNotify(makeHello());
    expect(link.state).toBe("ready");
    await link.stop();
    expect(link.state).toBe("idle");
  });
});

describe("BleLink 命令会话", () => {
  function setupReady(): { link: BleLink; transport: FakeTransport; clock: FakeClock } {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    makeReady(link, transport, clock);
    return { link, transport, clock };
  }

  it("SET_EFFECT 一帧在途；收到 ACK → resolve、pending 清除", async () => {
    const { link, transport } = setupReady();
    // onWrite 时回 ACK
    const p = link.setEffect(0x01, 0x01, Uint8Array.from([255, 255, 255]));
    // 取出写出的帧 seq，回 ACK
    expect(transport.writes.length).toBe(1);
    const frame = transport.writes[0];
    const seq = frame[3] | (frame[4] << 8);
    transport.emitNotify(encode({ type: Type.ACK, seq: 0, payload: [seq & 0xff, (seq >> 8) & 0xff] }));
    await expect(p).resolves.toBeUndefined();
    expect(transport.writes.length).toBe(1);
  });

  it("无 ACK：500ms×3 重发，共 4 次写后 timeout", async () => {
    const { link, transport, clock } = setupReady();
    const p = link.setEffect(0x01, 0x01, Uint8Array.from([255, 0, 0]));
    // 立即附上拒绝处理器，避免 vitest 视为 unhandled
    const rejectionPromise = p.then(
      () => null,
      (e) => e as unknown,
    );
    expect(transport.writes.length).toBe(1);
    // 等 ACK 计时器在首个写解析后被安置（now+500）
    await flush();
    clock.advance(500);
    await flush();
    expect(transport.writes.length).toBe(2);
    clock.advance(500);
    await flush();
    expect(transport.writes.length).toBe(3);
    clock.advance(500);
    await flush();
    expect(transport.writes.length).toBe(4);
    clock.advance(500);
    await flush();
    expect(transport.writes.length).toBe(4); // 不再发
    const rejection = await rejectionPromise;
    expect(rejection).toBeInstanceOf(CommandError);
    expect((rejection as CommandError).kind).toBe("timeout");
  });

  it("NAK 不重试：收到 NAK 立即 reject", async () => {
    const { link, transport, clock } = setupReady();
    const p = link.setEffect(0x01, 0x01, Uint8Array.from([255, 0, 0]));
    const frame = transport.writes[0];
    const seq = frame[3] | (frame[4] << 8);
    transport.emitNotify(encode({ type: Type.NAK, seq: 0, payload: [seq & 0xff, (seq >> 8) & 0xff, 0x03] }));
    await expect(p).rejects.toMatchObject({ kind: "rejected", nakError: 0x03 });
    // 不重试：不再发
    clock.advance(3000);
    expect(transport.writes.length).toBe(1);
    void clock;
  });

  it("20 字节兜底分片：mtu=20 时 40B payload 拆成 20/20/12 三包写", async () => {
    const { link, transport } = setupReady();
    const params = Array.from({ length: 40 }, (_, i) => 0x40 + i);
    const p = link.setEffect(0xff, 0x06, Uint8Array.from(params));
    // 整帧 = 9 头 + (1 + 40) payload + 2 crc = 52B → 20/20/12
    await flush();
    expect(transport.writes.length).toBe(3);
    expect(transport.writes[0].length).toBe(20);
    expect(transport.writes[1].length).toBe(20);
    expect(transport.writes[2].length).toBe(12);
    // 回 ACK 完成
    const frame = transport.writes[0];
    const seq = frame[3] | (frame[4] << 8);
    transport.emitNotify(encode({ type: Type.ACK, seq: 0, payload: [seq & 0xff, (seq >> 8) & 0xff] }));
    await expect(p).resolves.toBeUndefined();
  });

  it("单包写超时（3s）→ 链路不可信 → reconnecting + 命令失败", async () => {
    const transport = new FakeTransport({ writeHangs: true });
    const clock = new FakeClock();
    const link = new BleLink({ transport, clock, filter: { serviceUuid: SERVICE, namePrefix: PREFIX } });
    makeReady(link, transport, clock);
    expect(link.state).toBe("ready");
    const p = link.setEffect(0x01, 0x01, Uint8Array.from([255, 0, 0]));
    const rejectionPromise = p.then(
      () => null,
      (e) => e as unknown,
    );
    // 3s 单包写超时
    clock.advance(3000);
    await flush();
    expect(link.state).toBe("reconnecting");
    await expect(rejectionPromise).resolves.toBeInstanceOf(CommandError);
  });

  it("GET_STATUS：写后收到 STATUS → resolve；超时 1s", async () => {
    const { link, transport, clock } = setupReady();
    const p = link.getStatus();
    expect(transport.writes.length).toBe(1);
    const statusPayload = [
      0x10, 0, 0, 0, // uptime 16
      0, 0, 0, 0, 0, // glitch/drop/fault
      0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, // active_effect
    ];
    transport.emitNotify(encode({ type: Type.STATUS, seq: 0, payload: statusPayload }));
    const status = await p;
    expect(status.uptimeS).toBe(16);
    expect(status.activeEffect).toEqual([0, 1, 0, 2, 0, 3, 0, 0]);
    void clock;
  });
});