import { afterEach, describe, expect, it, vi } from "vitest";

import { BleLink } from "./ble_link";
import type { BleLinkOptions, LinkState } from "./ble_link";
import {
  AdapterUnavailableError,
  ConnectionFailedError,
  InvalidStateError,
  NoCharacteristicError,
  NoServiceError,
  NotConnectedError,
  OperationNotSupportedError,
  SystemError,
  TimeoutError,
  UnknownBleError,
} from "./errors";
import {
  FakeTransport,
  DEFAULT_DEVICE_ID,
  DEFAULT_NOTIFY_CHAR_ID,
  DEFAULT_SERVICE_ID,
  DEFAULT_WRITE_CHAR_ID,
  bytesToHex,
} from "./test_utils/fake_transport";
import type { FakeTransportOptions } from "./test_utils/fake_transport";

/** 默认测试配置：缩短扫描 / 重连延迟；notify 生效延迟单独测试，这里关掉提速。 */
function setup(options: { transport?: FakeTransportOptions; link?: BleLinkOptions } = {}) {
  const transport = new FakeTransport(options.transport);
  const link = new BleLink(transport, {
    scanTimeoutMs: 50,
    reconnectDelayMs: 20,
    notifySettleMs: 0,
    ...options.link,
  });
  return { link, transport };
}

/** 等待状态机到达目标状态（真实计时器）。 */
async function waitState(link: BleLink, state: LinkState, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (link.state !== state) {
    if (Date.now() > deadline) throw new Error(`等待状态 ${state} 超时，当前 ${link.state}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("扫描", () => {
  it("重复广播按 deviceId 去重，超时后停止 discovery 并回到 idle", async () => {
    const { link, transport } = setup({ transport: { advertiseRepeats: 3 } });
    const devices = await link.scan({ timeoutMs: 20 });
    expect(devices.map((d) => d.deviceId)).toEqual([DEFAULT_DEVICE_ID]);
    expect(transport.opCount("stopDiscovery")).toBe(1);
    expect(link.state).toBe("idle");
  });

  it("适配器不可用（10001）映射为 AdapterUnavailableError 并进入 fault，可再次扫描", async () => {
    const { link, transport } = setup();
    transport.enqueueFailure("openAdapter", 10001);
    const error = await link.scan({ timeoutMs: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterUnavailableError);
    expect(link.state).toBe("fault");
    const devices = await link.scan({ timeoutMs: 10 });
    expect(devices).toHaveLength(1);
    expect(link.state).toBe("idle");
  });

  it("ready 状态扫描抛 InvalidStateError", async () => {
    const { link } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    await expect(link.scan({ timeoutMs: 10 })).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("ready 状态再次 connect 抛 InvalidStateError", async () => {
    const { link } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    await expect(link.connect(DEFAULT_DEVICE_ID)).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe("连接 / 发现 / 订阅", () => {
  it("冷启动连接迁移 connecting -> discovering -> subscribing -> ready 并自动挑选特征", async () => {
    const { link, transport } = setup();
    const states: LinkState[] = [];
    link.onStateChange((state) => states.push(state));
    await link.connect(DEFAULT_DEVICE_ID);
    expect(states).toEqual(["connecting", "discovering", "subscribing", "ready"]);
    expect(link.deviceId).toBe(DEFAULT_DEVICE_ID);
    expect(link.selectedTarget).toEqual({
      serviceId: DEFAULT_SERVICE_ID,
      writeCharacteristicId: "0000fff2-0000-1000-8000-00805f9b34fb",
      notifyCharacteristicId: "0000fff1-0000-1000-8000-00805f9b34fb",
      writeType: "writeNoResponse",
    });
    expect(transport.callsOf("notify")).toEqual([
      { op: "notify", detail: `${DEFAULT_DEVICE_ID}/0000fff1-0000-1000-8000-00805f9b34fb/true`, at: expect.any(Number) },
    ]);
    expect(link.cachedServices.map((s) => s.uuid)).toEqual([DEFAULT_SERVICE_ID]);
  });

  it("连接失败 10003 -> ConnectionFailedError + fault", async () => {
    const { link, transport } = setup();
    transport.enqueueFailure("connect", 10003);
    const error = await link.connect(DEFAULT_DEVICE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionFailedError);
    expect(link.state).toBe("fault");
  });

  it("already connect（-1）视为已连接，继续发现 / 订阅", async () => {
    const { link, transport } = setup();
    await transport.connect(DEFAULT_DEVICE_ID);
    await link.connect(DEFAULT_DEVICE_ID);
    expect(link.state).toBe("ready");
  });

  it("无服务 10004 -> NoServiceError + fault", async () => {
    const { link, transport } = setup();
    transport.enqueueFailure("services", 10004);
    const error = await link.connect(DEFAULT_DEVICE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoServiceError);
    expect(link.state).toBe("fault");
  });

  it("服务既无可写也不可通知特征 -> NoCharacteristicError", async () => {
    const readOnly = {
      uuid: "00002a00-0000-1000-8000-00805f9b34fb",
      properties: { read: true, write: false, writeNoResponse: false, notify: false, indicate: false },
    };
    const { link } = setup({
      transport: { characteristics: { [DEFAULT_SERVICE_ID]: [readOnly] } },
    });
    const error = await link.connect(DEFAULT_DEVICE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoCharacteristicError);
    expect(link.state).toBe("fault");
  });

  it("自动挑选跳过 0x1800 / 0x1801 标准服务", async () => {
    const generic = {
      uuid: "00001800-0000-1000-8000-00805f9b34fb",
      properties: { read: true, write: false, writeNoResponse: false, notify: true, indicate: false },
    };
    const { link } = setup({
      transport: {
        services: [
          { uuid: "00001800-0000-1000-8000-00805f9b34fb", isPrimary: true },
          { uuid: DEFAULT_SERVICE_ID, isPrimary: true },
        ],
        characteristics: {
          "00001800-0000-1000-8000-00805f9b34fb": [generic],
          [DEFAULT_SERVICE_ID]: [
            {
              uuid: DEFAULT_NOTIFY_CHAR_ID,
              properties: { read: false, write: false, writeNoResponse: false, notify: true, indicate: false },
            },
            {
              uuid: DEFAULT_WRITE_CHAR_ID,
              properties: { read: false, write: false, writeNoResponse: true, notify: false, indicate: false },
            },
          ],
        },
      },
    });
    await link.connect(DEFAULT_DEVICE_ID);
    expect(link.selectedTarget?.serviceId).toBe(DEFAULT_SERVICE_ID);
  });

  it("显式 target 服务不存在 -> NoServiceError", async () => {
    const { link } = setup({
      link: { target: { serviceId: "0000abcd-0000-1000-8000-00805f9b34fb" } },
    });
    const error = await link.connect(DEFAULT_DEVICE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoServiceError);
    expect(link.state).toBe("fault");
  });

  it("显式 target 特征不存在 -> NoCharacteristicError", async () => {
    const { link } = setup({
      link: {
        target: {
          serviceId: DEFAULT_SERVICE_ID,
          writeCharacteristicId: "0000fff9-0000-1000-8000-00805f9b34fb",
        },
      },
    });
    const error = await link.connect(DEFAULT_DEVICE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoCharacteristicError);
    expect(link.state).toBe("fault");
  });

  it("显式 target 只给 serviceId：在该服务内自动挑选可写 + 通知特征", async () => {
    const { link } = setup({ link: { target: { serviceId: DEFAULT_SERVICE_ID } } });
    await link.connect(DEFAULT_DEVICE_ID);
    expect(link.state).toBe("ready");
    expect(link.selectedTarget?.notifyCharacteristicId).toBe("0000fff1-0000-1000-8000-00805f9b34fb");
    expect(link.selectedTarget?.writeCharacteristicId).toBe("0000fff2-0000-1000-8000-00805f9b34fb");
  });

  it("显式 target 同时指定两个特征：直接使用", async () => {
    const { link } = setup({
      link: {
        target: {
          serviceId: DEFAULT_SERVICE_ID,
          notifyCharacteristicId: "0000fff1-0000-1000-8000-00805f9b34fb",
          writeCharacteristicId: "0000fff2-0000-1000-8000-00805f9b34fb",
        },
      },
    });
    await link.connect(DEFAULT_DEVICE_ID);
    expect(link.state).toBe("ready");
  });

  it("显式 target 服务无可通知特征 -> NoCharacteristicError", async () => {
    const writeOnly = {
      uuid: "0000fff2-0000-1000-8000-00805f9b34fb",
      properties: { read: false, write: false, writeNoResponse: true, notify: false, indicate: false },
    };
    const { link } = setup({
      transport: { characteristics: { [DEFAULT_SERVICE_ID]: [writeOnly] } },
      link: { target: { serviceId: DEFAULT_SERVICE_ID } },
    });
    const error = await link.connect(DEFAULT_DEVICE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoCharacteristicError);
    expect(link.state).toBe("fault");
  });

  it("显式 target 服务无可写特征 -> NoCharacteristicError", async () => {
    const notifyOnly = {
      uuid: "0000fff1-0000-1000-8000-00805f9b34fb",
      properties: { read: false, write: false, writeNoResponse: false, notify: true, indicate: false },
    };
    const { link } = setup({
      transport: { characteristics: { [DEFAULT_SERVICE_ID]: [notifyOnly] } },
      link: { target: { serviceId: DEFAULT_SERVICE_ID } },
    });
    const error = await link.connect(DEFAULT_DEVICE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoCharacteristicError);
    expect(link.state).toBe("fault");
  });

  it("notify 使能失败 10007 -> OperationNotSupportedError + fault", async () => {
    const { link, transport } = setup();
    transport.enqueueFailure("notify", 10007);
    const error = await link.connect(DEFAULT_DEVICE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationNotSupportedError);
    expect(link.state).toBe("fault");
  });

  it("通知帧只转发当前设备的", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    const received: string[] = [];
    link.onNotification((n) => received.push(bytesToHex(n.value)));
    transport.emitNotification("aa55");
    transport.emitNotification("aabb", {
      deviceId: "other-device",
      serviceId: DEFAULT_SERVICE_ID,
      characteristicId: "0000fff1-0000-1000-8000-00805f9b34fb",
    });
    expect(received).toEqual(["aa55"]);
  });
});

describe("MTU 协商与分片", () => {
  it("安卓：setBLEMTU 请求 247，用 getBLEMTU 真实值 −3 作 payload", async () => {
    const { link, transport } = setup({ transport: { mtu: 247 } });
    await link.connect(DEFAULT_DEVICE_ID);
    expect(transport.callsOf("setMtu")[0]?.detail).toBe(`${DEFAULT_DEVICE_ID}/247`);
    expect(link.writePayloadSize).toBe(244);
  });

  it("安卓：onBLEMTUChange 更新 payload；success 回显不可信不影响", async () => {
    const { link, transport } = setup({ transport: { mtu: 247 } });
    await link.connect(DEFAULT_DEVICE_ID);
    transport.emitMtuChange(DEFAULT_DEVICE_ID, 101);
    expect(link.writePayloadSize).toBe(98);
  });

  it("iOS：不调用 setBLEMTU，payload = 系统 MTU − 3", async () => {
    const { link, transport } = setup({ transport: { platform: "ios", mtu: 185 } });
    await link.connect(DEFAULT_DEVICE_ID);
    expect(transport.opCount("setMtu")).toBe(0);
    expect(link.writePayloadSize).toBe(182);
  });

  it("setBLEMTU 失败不致命：仍用 getBLEMTU 真实值", async () => {
    const { link, transport } = setup({ transport: { mtu: 247 } });
    transport.enqueueFailure("setMtu", 10008);
    await link.connect(DEFAULT_DEVICE_ID);
    expect(link.writePayloadSize).toBe(244);
  });

  it("getBLEMTU 失败 -> 20 字节兜底", async () => {
    const { link, transport } = setup({ transport: { mtu: 247 } });
    transport.enqueueFailure("getMtu", 10008);
    await link.connect(DEFAULT_DEVICE_ID);
    expect(link.writePayloadSize).toBe(20);
  });

  it("mtu=23（ATT 默认）时 payload 兜底 20，40 字节数据分两片", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    await link.write(new Uint8Array(40).fill(0xab));
    expect(transport.writes.map((w) => w.hex.length / 2)).toEqual([20, 20]);
    expect(transport.writes.map((w) => w.writeType)).toEqual(["writeNoResponse", "writeNoResponse"]);
  });
});

describe("写策略", () => {
  it("并发写串行排队：按调用顺序逐片执行，value 是 ArrayBuffer", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    const first = new Uint8Array(30).fill(0x11);
    const second = new Uint8Array(30).fill(0x22);
    await Promise.all([link.write(first), link.write(second)]);
    const expected = [
      bytesToHex(first.subarray(0, 20)),
      bytesToHex(first.subarray(20)),
      bytesToHex(second.subarray(0, 20)),
      bytesToHex(second.subarray(20)),
    ];
    expect(transport.writes.map((w) => w.hex)).toEqual(expected);
    for (const write of transport.writes) {
      expect(write.value).toBeInstanceOf(ArrayBuffer);
    }
  });

  it("notify 使能后 200ms 生效：200ms 内的写等待，之后执行", async () => {
    vi.useFakeTimers();
    const { link, transport } = setup({ link: { notifySettleMs: 200 } });
    await link.connect(DEFAULT_DEVICE_ID);
    const notifyAt = transport.callsOf("notify")[0]?.at ?? 0;
    const promise = link.write(new Uint8Array(4));
    await vi.advanceTimersByTimeAsync(199);
    expect(transport.opCount("write")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.opCount("write")).toBe(1);
    await promise;
    const writeAt = transport.writes[0]?.at ?? 0;
    expect(writeAt - notifyAt).toBeGreaterThanOrEqual(200);
  });

  it("每片写 3s 超时 -> TimeoutError，且不自动重试", async () => {
    vi.useFakeTimers();
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.hangNextWrites(1);
    const promise = link.write(new Uint8Array(4));
    let settled = false;
    void promise.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.opCount("write")).toBe(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
    expect(settled).toBe(true);
    expect(transport.opCount("write")).toBe(1); // 不自动重试
  });

  it("非 ready 状态写 -> InvalidStateError", async () => {
    const { link } = setup();
    await expect(link.write(new Uint8Array(4))).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("排队期间断连：队列内的写以 InvalidStateError 结束", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    const promise = link.write(new Uint8Array(4));
    transport.dropConnection(DEFAULT_DEVICE_ID);
    expect(link.state).toBe("reconnecting");
    await expect(promise).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("写失败后队列继续：后续 write 调用不受前一次失败影响", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.enqueueFailure("write", 10008, 1);
    const error = await link.write(new Uint8Array(4)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SystemError);
    expect(transport.opCount("write")).toBe(1);
    await link.write(new Uint8Array(4));
    expect(transport.opCount("write")).toBe(2);
  });
});

describe("断连与重连", () => {
  it("断连路径①：连接状态事件 -> reconnecting -> 自动重连 ready", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.dropConnection(DEFAULT_DEVICE_ID);
    expect(link.state).toBe("reconnecting");
    await waitState(link, "ready");
    expect(transport.opCount("connect")).toBe(2);
  });

  it("断连路径②：静默断连后写 reject 10006 -> NotConnectedError + 自动重连", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.dropConnection(DEFAULT_DEVICE_ID, { silent: true });
    const error = await link.write(new Uint8Array(4)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotConnectedError);
    expect(link.state).toBe("reconnecting");
    await waitState(link, "ready");
    expect(transport.opCount("connect")).toBe(2);
  });

  it("主动 disconnect 不触发自动重连，回到 idle", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    await link.disconnect();
    expect(link.state).toBe("idle");
    expect(link.deviceId).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.opCount("connect")).toBe(1);
  });

  it("disconnect 传输失败（10008）回 idle 并抛 SystemError", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.enqueueFailure("disconnect", 10008);
    const error = await link.disconnect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SystemError);
    expect(link.state).toBe("idle");
  });

  it("autoReconnect=false：断连落 fault，不自动重连", async () => {
    const { link, transport } = setup({ link: { autoReconnect: false } });
    await link.connect(DEFAULT_DEVICE_ID);
    transport.dropConnection(DEFAULT_DEVICE_ID);
    expect(link.state).toBe("fault");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.opCount("connect")).toBe(1);
  });

  it("重连失败落 fault 且不循环重试", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.enqueueFailure("connect", 10003);
    transport.dropConnection(DEFAULT_DEVICE_ID);
    await waitState(link, "fault");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(transport.opCount("connect")).toBe(2); // 只有一次自动重连
  });

  it("重连风暴防护：重复断连事件只排一个重连", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.dropConnection(DEFAULT_DEVICE_ID);
    transport.dropConnection(DEFAULT_DEVICE_ID);
    await waitState(link, "ready");
    expect(transport.opCount("connect")).toBe(2);
  });
});

describe("挂起恢复（onHide / onShow）", () => {
  it("扫描中 onHide -> suspended 且停止 discovery；onShow -> idle", async () => {
    const { link, transport } = setup();
    const scanPromise = link.scan({ timeoutMs: 200 });
    expect(link.state).toBe("scanning");
    link.onHide();
    expect(link.state).toBe("suspended");
    await scanPromise;
    expect(transport.opCount("stopDiscovery")).toBeGreaterThanOrEqual(1);
    expect(link.state).toBe("suspended");
    await link.onShow();
    expect(link.state).toBe("idle");
  });

  it("重连中 onHide 暂停重连，onShow 恢复", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.dropConnection(DEFAULT_DEVICE_ID);
    expect(link.state).toBe("reconnecting");
    link.onHide();
    expect(link.state).toBe("suspended");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(transport.opCount("connect")).toBe(1); // 挂起期间不重连
    await link.onShow();
    await waitState(link, "ready");
    expect(transport.opCount("connect")).toBe(2);
  });

  it("ready 状态 onShow：校验连接并重新发现订阅，无重连风暴", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    expect(transport.opCount("services")).toBe(1);
    expect(transport.opCount("characteristics")).toBe(1);
    await link.onShow();
    expect(link.state).toBe("ready");
    expect(transport.opCount("services")).toBe(3); // 连接 1 次 + onShow 探测 1 次 + 重新发现 1 次
    expect(transport.opCount("characteristics")).toBe(1); // 特征走缓存
    expect(transport.opCount("connect")).toBe(1);
  });

  it("ready 状态 onShow：挂起期间连接被回收（10006）-> 重连 ready", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.dropConnection(DEFAULT_DEVICE_ID, { silent: true });
    await link.onShow();
    expect(link.state).toBe("reconnecting");
    await waitState(link, "ready");
    expect(transport.opCount("connect")).toBe(2);
  });
});

describe("错误映射兜底", () => {
  it("非 wx 形状的 reject 值映射为 UnknownBleError 并保留原始信息", async () => {
    const { link, transport } = setup();
    transport.enqueueRawFailure("services", "boom");
    const error = await link.connect(DEFAULT_DEVICE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownBleError);
    const domainError = error as UnknownBleError;
    expect(domainError.code).toBe("UNKNOWN_BLE_ERROR");
    expect(domainError.errMsg).toBe("boom");
    expect(link.state).toBe("fault");
  });
});

describe("FakeTransport.setDelay（延迟回调）", () => {
  it("setDelay 让 write 回调延迟指定毫秒（写路径确实等待延迟）", async () => {
    const { link, transport } = setup();
    await link.connect(DEFAULT_DEVICE_ID);
    transport.setDelay("write", 40);
    const t0 = Date.now();
    await link.write(new Uint8Array([0xaa, 0x55]));
    const elapsed = Date.now() - t0;
    // 延迟生效：write 至少等了 ~40ms（留 CI 抖动余量，阈值 30）。
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(transport.opCount("write")).toBe(1);
  });
});