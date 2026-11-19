/**
 * LightBusinessService 单测（TDD，工单 #17）：FakeTransport + FakeLightDevice（C3 行为模型）
 * 驱动的页面级业务验证。断言受限门禁（NAK 0x06）、解锁生效、解锁不持久化、strip_mask
 * 多路、STATUS 24 字节解析、supportsEffect。
 *
 * 页面 / WxTransport 薄壳不进单测（spec §1.1，靠真机冒烟）。
 */

import { describe, expect, it } from "vitest";

import { BleLink } from "./ble_link";
import { FRAME_TYPES } from "./codec";
import { InvalidStateError, TimeoutError } from "./errors";
import {
  BRIGHTNESS_LIMIT,
  LightBusinessService,
  NeedsUnlockError,
  POWER_LIMIT_MA,
  STRIP_MASK_ALL,
  isNotUnlocked,
  lanesFromStripMask,
  stripMaskFromLanes,
} from "./business_service";
import { FakeTransport } from "./test_utils/fake_transport";
import { FakeLightDevice } from "./test_utils/fake_device";
import type { FakeLightDeviceOptions } from "./test_utils/fake_device";
import { LightService } from "./light_service";

interface SetupOptions {
  mtu?: number;
  autoReconnect?: boolean;
  device?: FakeLightDevice;
}

/** 组装 BleLink + LightService + Business，并挂上 C3 设备模型。 */
function setup(options: SetupOptions = {}) {
  const transport = new FakeTransport({
    mtu: options.mtu ?? 247,
    onWrite: (bytes) => device.onWrite(bytes),
  });
  const link = new BleLink(transport, {
    scanTimeoutMs: 20,
    reconnectDelayMs: 20,
    notifySettleMs: 0,
    autoReconnect: options.autoReconnect ?? false,
  });
  const device = options.device ?? new FakeLightDevice(transport);
  const service = new LightBusinessService(new LightService(link));
  return { service, link, transport, device };
}

async function connect(service: LightBusinessService): Promise<void> {
  await service.scan({ timeoutMs: 10 });
  await service.connect();
  // 等 ready（FakeTransport 同步回调，通常已就绪）。
  const deadline = Date.now() + 1000;
  while (service.state !== "ready" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("LightBusinessService 亮度门禁", () => {
  it("受限态 setBrightness(200) → C3 NAK 0x06 → NeedsUnlockError", async () => {
    const { service } = setup();
    await connect(service);
    const error = await service.setBrightness(200).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeedsUnlockError);
    expect(isNotUnlocked(error)).toBe(true);
  });

  it("受限态 setBrightness(127) 边界值 → ACK 生效", async () => {
    const { service, device } = setup();
    await connect(service);
    await expect(service.setBrightness(BRIGHTNESS_LIMIT)).resolves.toBeUndefined();
    expect(device.brightness).toBe(127);
  });

  it("解锁后 setBrightness(200) → ACK 生效", async () => {
    const { service, device } = setup();
    await connect(service);
    await service.unlockFullPower(true);
    expect(service.fullPowerUnlocked).toBe(true);
    await expect(service.setBrightness(200)).resolves.toBeUndefined();
    expect(device.brightness).toBe(200);
  });

  it("setBrightness 值域非法 → InvalidStateError（不发送）", async () => {
    const { service, transport } = setup();
    await connect(service);
    await expect(service.setBrightness(256)).rejects.toBeInstanceOf(InvalidStateError);
    await expect(service.setBrightness(-1)).rejects.toBeInstanceOf(InvalidStateError);
    // 只应有连接期 + 无 brightness 写（write 次数仅来自必要流程；此处不做严格计数）。
    expect(transport.opCount("write")).toBe(0);
  });

  it("unlockFullPower(false) 后 C3 立即夹回 127 / 15000", async () => {
    const { service, device } = setup();
    await connect(service);
    await service.unlockFullPower(true);
    await service.setBrightness(220);
    await service.setPowerLimit(20000);
    expect(device.brightness).toBe(220);
    expect(device.powerLimitMa).toBe(20000);

    await service.unlockFullPower(false);
    expect(service.fullPowerUnlocked).toBe(false);
    expect(device.brightness).toBe(BRIGHTNESS_LIMIT);
    expect(device.powerLimitMa).toBe(POWER_LIMIT_MA);
  });
});

describe("LightBusinessService 限流门禁", () => {
  it("受限态 setPowerLimit(20000) → C3 NAK 0x06 → NeedsUnlockError", async () => {
    const { service } = setup();
    await connect(service);
    const error = await service.setPowerLimit(20000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeedsUnlockError);
  });

  it("受限态 setPowerLimit(15000) 边界 → ACK 生效", async () => {
    const { service, device } = setup();
    await connect(service);
    await expect(service.setPowerLimit(POWER_LIMIT_MA)).resolves.toBeUndefined();
    expect(device.powerLimitMa).toBe(15000);
  });

  it("解锁后 setPowerLimit(30000) → ACK 生效", async () => {
    const { service, device } = setup();
    await connect(service);
    await service.unlockFullPower(true);
    await expect(service.setPowerLimit(30000)).resolves.toBeUndefined();
    expect(device.powerLimitMa).toBe(30000);
  });

  it("setPowerLimit(40000) 超硬件上限 → InvalidStateError（不发）", async () => {
    const { service } = setup();
    await connect(service);
    await service.unlockFullPower(true);
    await expect(service.setPowerLimit(40000)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("setPowerLimit 值域非法（>65535）→ InvalidStateError（不发）", async () => {
    const { service, transport } = setup();
    await connect(service);
    await expect(service.setPowerLimit(70000)).rejects.toBeInstanceOf(InvalidStateError);
    expect(transport.opCount("write")).toBe(0);
  });
});

describe("LightBusinessService 解锁不持久化", () => {
  it("解锁后断连重连 → fullPowerUnlocked 回落 false（页面级不持久化）", async () => {
    const { service, transport, device } = setup({ autoReconnect: true });
    await connect(service);
    await service.unlockFullPower(true);
    expect(service.fullPowerUnlocked).toBe(true);

    // 模拟断电重启 + 被动断连：设备回落受限态，BleLink 自动重连。
    device.reboot();
    transport.dropConnection("C3-A1");
    const deadline = Date.now() + 2000;
    while (service.state !== "ready" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(service.state).toBe("ready");
    expect(service.fullPowerUnlocked).toBe(false);
    // 重连后受限态：超限再次 NAK 0x06。
    const error = await service.setBrightness(200).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeedsUnlockError);
  });

  it("主动 disconnect 后 fullPowerUnlocked 回落 false", async () => {
    const { service } = setup();
    await connect(service);
    await service.unlockFullPower(true);
    await service.disconnect();
    expect(service.fullPowerUnlocked).toBe(false);
  });

  it("onHide / onShow 透传底层（不抛）", async () => {
    const { service } = setup();
    await connect(service);
    service.onHide();
    await expect(service.onShow()).resolves.toBeUndefined();
  });
});

describe("FakeLightDevice.reboot 受限夹取（#4 §4）", () => {
  function makeDevice(options: FakeLightDeviceOptions = {}): FakeLightDevice {
    const transport = new FakeTransport();
    return new FakeLightDevice(transport, options);
  }

  it("重启后亮度夹到 127、限流夹到 15000，解锁清除", () => {
    const device = makeDevice({ brightness: 200, powerLimitMa: 30000, unlocked: true });
    device.reboot();
    expect(device.brightness).toBe(127); // min(200, 127)
    expect(device.powerLimitMa).toBe(15000); // min(30000, 15000)
    expect(device.unlocked).toBe(false);
  });

  it("重启后未超限的亮度/限流原样保留", () => {
    const device = makeDevice({ brightness: 100, powerLimitMa: 10000 });
    device.reboot();
    expect(device.brightness).toBe(100);
    expect(device.powerLimitMa).toBe(10000);
  });

  it("重启后保存的灯效恢复（继续跑）", () => {
    const device = makeDevice();
    device.activeEffect[0] = 1;
    device.reboot();
    expect(device.activeEffect[0]).toBe(1);
  });
});

describe("LightBusinessService strip_mask 单路 / 多路", () => {
  it("lanes <-> mask 互转（含全选 / 单路 / 多路）", () => {
    expect(stripMaskFromLanes([true, false, false, false, false, false, false, false])).toBe(0x01);
    expect(stripMaskFromLanes([true, false, true, false, false, false, false, false])).toBe(0x05);
    expect(stripMaskFromLanes(new Array<boolean>(8).fill(true))).toBe(STRIP_MASK_ALL);
    expect(lanesFromStripMask(0x05)).toEqual([true, false, true, false, false, false, false, false]);
    expect(lanesFromStripMask(0x00)).toEqual(new Array<boolean>(8).fill(false));
  });

  it("lanes 长度不对 → InvalidStateError", () => {
    expect(() => stripMaskFromLanes([true, false])).toThrow(InvalidStateError);
  });

  it("单路 setEffect 只更新选路灯（STATUS active_effect 校验）", async () => {
    const { service, device } = setup();
    await connect(service);
    // 只选 L0：mask=0x01，静态绿。
    await service.setEffect(0x01, { effect: "static", color: { r: 0, g: 255, b: 0 } });
    expect(device.activeEffect[0]).toBe(0x01);
    expect(device.activeEffect[1]).toBe(0xff);
  });

  it("多路 setEffect 更新所有选路灯", async () => {
    const { service, device } = setup();
    await connect(service);
    // 选 L0/L2/L4：mask=0x15，渐变。
    const mask = stripMaskFromLanes([true, false, true, false, true, false, false, false]);
    expect(mask).toBe(0x15);
    await service.setEffect(mask, {
      effect: "gradient",
      from: { r: 255, g: 0, b: 0 },
      to: { r: 0, g: 0, b: 255 },
      periodMs: 2000,
      direction: 0,
    });
    expect(device.activeEffect[0]).toBe(0x03);
    expect(device.activeEffect[1]).toBe(0xff);
    expect(device.activeEffect[2]).toBe(0x03);
    expect(device.activeEffect[4]).toBe(0x03);
  });
});

describe("LightBusinessService STATUS 实时显示", () => {
  it("周期 / 主动 STATUS：24 字节解析出亮度 / 限流 / 温度 / 每路灯效", async () => {
    const { service, device } = setup();
    await connect(service);
    await service.setPowerLimit(15000);
    device.emitStatus(42);

    const status = service.status;
    expect(status).toBeDefined();
    expect(status?.uptimeS).toBe(42);
    expect(status?.tempC).toBe(30);
    expect(status?.powerLimitMa).toBe(15000);
    expect(status?.activeEffect).toHaveLength(8);
  });

  it("requestStatus 触发 GET_STATUS 并返回最新快照", async () => {
    const { service } = setup();
    await connect(service);
    const status = await service.requestStatus();
    expect(status.activeEffect).toHaveLength(8);
  });

  it("onStatus 订阅收到每条 STATUS", async () => {
    const { service, device } = setup();
    await connect(service);
    const seen: number[] = [];
    service.onStatus((s) => seen.push(s.uptimeS));
    device.emitStatus(1);
    device.emitStatus(2);
    expect(seen).toEqual([1, 2]);
  });
});

describe("LightBusinessService supportsEffect", () => {
  it("按 HELLO effect_bitmap 判断 0–6 受支持、其余不支持", async () => {
    const { service } = setup();
    await connect(service);
    // FakeLightDevice 默认 bitmap 首字节 0x7f → effect 0..6 支持。
    for (let id = 0; id <= 6; id += 1) expect(service.supportsEffect(id)).toBe(true);
    expect(service.supportsEffect(7)).toBe(false);
    expect(service.supportsEffect(200)).toBe(false);
  });

  it("无 HELLO 时 supportsEffect 恒 false", () => {
    const { service } = setup();
    expect(service.supportsEffect(1)).toBe(false);
  });
});

describe("LightBusinessService 生命周期与错误透传", () => {
  it("未连接 setEffect 抛 InvalidStateError（透传底层）", async () => {
    const { service } = setup();
    await expect(service.setEffect(0xff, { effect: "off" })).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("无 ACK 时 setBrightness 抛 TimeoutError（500ms，不重试）", async () => {
    // 用一个不回 ACK 的"哑"设备模型：onWrite 不做事。
    const transport = new FakeTransport({ mtu: 247 });
    const link = new BleLink(transport, {
      scanTimeoutMs: 20,
      reconnectDelayMs: 20,
      notifySettleMs: 0,
      autoReconnect: false,
    });
    const service = new LightBusinessService(new LightService(link, { ackTimeoutMs: 60 }));
    await service.scan({ timeoutMs: 10 });
    await service.connect();
    await expect(service.setBrightness(100)).rejects.toBeInstanceOf(TimeoutError);
    // 只发一次（write 一次），不自动重试。
    expect(transport.opCount("write")).toBe(1);
  });
});

describe("isNotUnlocked 归一判断", () => {
  it("NeedsUnlockError / {nakCode:0x06} → true，其余 → false", () => {
    expect(isNotUnlocked(new NeedsUnlockError())).toBe(true);
    expect(isNotUnlocked({ nakCode: 0x06 })).toBe(true);
    expect(isNotUnlocked({ nakCode: 0x03 })).toBe(false);
    expect(isNotUnlocked(new Error("x"))).toBe(false);
    expect(isNotUnlocked(undefined)).toBe(false);
  });
});

/** 供人读：帧类型常量存在性自检（防止未来误改协议常量）。 */
describe("协议常量自检", () => {
  it("全局命令帧类型与 #4 决议一致", () => {
    expect(FRAME_TYPES.setBrightness).toBe(0x03);
    expect(FRAME_TYPES.setPowerLimit).toBe(0x04);
    expect(FRAME_TYPES.unlockFullPower).toBe(0x05);
  });
});