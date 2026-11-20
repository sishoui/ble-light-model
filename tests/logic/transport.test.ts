// Transport 层单元测试（vitest，Node 环境）。
// 覆盖可脱离 wx 全局 / 真桥的部分：mapWxError 的 errCode 映射、FakeTransport 的可编排行为。
// wx 真壳（WxTransport）与 PcBleTransport 的桥握手属影子跑/真机，不在此处（见 miniprogram.md §9.4）。

import { describe, it, expect } from "vitest";
import { FakeTransport } from "./fake-transport";
import { mapWxError } from "../../miniprogram/transport/wx-transport";
import { TransportError } from "@ble-light/logic";

describe("mapWxError", () => {
  it("maps wx errCodes to TransportError kinds per miniprogram.md §7.1", () => {
    expect(mapWxError({ errCode: 10000 }).kind).toBe("not-initialized");
    expect(mapWxError({ errCode: 10001 }).kind).toBe("adapter-unavailable");
    expect(mapWxError({ errCode: 10009 }).kind).toBe("unsupported");
    expect(mapWxError({ errCode: 10007 }).kind).toBe("unsupported");
    expect(mapWxError({ errCode: 10004 }).kind).toBe("service-missing");
    expect(mapWxError({ errCode: 10005 }).kind).toBe("characteristic-missing");
    expect(mapWxError({ errCode: 10002 }).kind).toBe("not-found");
    expect(mapWxError({ errCode: 10003 }).kind).toBe("connect-failed");
    expect(mapWxError({ errCode: 10006 }).kind).toBe("not-connected");
    expect(mapWxError({ errCode: 10012 }).kind).toBe("timeout");
    expect(mapWxError({ errCode: 10013 }).kind).toBe("invalid-data");
    expect(mapWxError({ errCode: 10008 }).kind).toBe("system");
  });

  it("carries the raw code for diagnostics and defaults to system", () => {
    const e = mapWxError({ errCode: 99999, errMsg: "boom" });
    expect(e).toBeInstanceOf(TransportError);
    expect(e.kind).toBe("system");
    expect(e.code).toBe(99999);
    expect(e.message).toBe("boom");
  });
});

describe("FakeTransport (production, transport/fake-transport.ts)", () => {
  it("records writes and echoes notify via orchestration", async () => {
    const t = new FakeTransport();
    const chunks: Uint8Array[] = [];
    t.onNotify((c) => chunks.push(c));
    await t.connect("dev-1");
    await t.writePacket(Uint8Array.from([1, 2, 3]));
    expect(t.writes.length).toBe(1);
    expect(Array.from(t.writes[0])).toEqual([1, 2, 3]);
    t.emitNotify([9, 8]);
    expect(Array.from(chunks[0])).toEqual([9, 8]);
  });

  it("rejects connect when configured to fail", async () => {
    const t = new FakeTransport({ failConnect: true });
    await expect(t.connect("dev-1")).rejects.toBeInstanceOf(TransportError);
    expect(t.connectCalls).toBe(1);
  });

  it("reports non-explicit disconnect through onDisconnect", async () => {
    const t = new FakeTransport();
    await t.connect("dev-1");
    const errs: TransportError[] = [];
    t.onDisconnect((e) => errs.push(e));
    t.emitDisconnect();
    expect(errs.length).toBe(1);
    expect(errs[0].kind).toBe("not-connected");
  });
});