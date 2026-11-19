import { describe, expect, it } from "vitest";

import { isBleTransportFailure } from "./transport";
import {
  AdapterUnavailableError,
  AlreadyConnectedError,
  BleDomainError,
  ConnectionFailedError,
  ConnectionTimeoutError,
  DeviceNotFoundError,
  InvalidDeviceIdError,
  InvalidStateError,
  NoCharacteristicError,
  NoServiceError,
  NotConnectedError,
  NotInitializedError,
  OperationNotSupportedError,
  PlatformNotSupportedError,
  SystemError,
  TimeoutError,
  UnknownBleError,
  mapErrCode,
  mapTransportFailure,
} from "./errors";

describe("mapErrCode 逐码映射（wx-ble-facts §2 全表）", () => {
  const table: Array<[number, new (options?: { errCode?: number; errMsg?: string }) => BleDomainError]> = [
    [-1, AlreadyConnectedError],
    [10000, NotInitializedError],
    [10001, AdapterUnavailableError],
    [10002, DeviceNotFoundError],
    [10003, ConnectionFailedError],
    [10004, NoServiceError],
    [10005, NoCharacteristicError],
    [10006, NotConnectedError],
    [10007, OperationNotSupportedError],
    [10008, SystemError],
    [10009, PlatformNotSupportedError],
    [10012, ConnectionTimeoutError],
    [10013, InvalidDeviceIdError],
  ];

  it.each(table)("errCode %i -> %s", (errCode, Expected) => {
    const error = mapErrCode(errCode, "boom");
    expect(error).toBeInstanceOf(Expected);
    expect(error).toBeInstanceOf(BleDomainError);
    expect(error.errCode).toBe(errCode);
    expect(error.errMsg).toBe("boom");
  });

  it("未知码兜底 UnknownBleError 且保留原始码", () => {
    const error = mapErrCode(10099, "weird");
    expect(error).toBeInstanceOf(UnknownBleError);
    expect(error.code).toBe("UNKNOWN_BLE_ERROR");
    expect(error.errCode).toBe(10099);
    expect(error.errMsg).toBe("weird");
    expect(error.message).toContain("10099");
  });

  it("errMsg 缺省时为 undefined", () => {
    expect(mapErrCode(10006).errMsg).toBeUndefined();
  });
});

describe("mapTransportFailure", () => {
  it("把 { errCode, errMsg } 映射为对应领域错误", () => {
    const error = mapTransportFailure({ errCode: 10006, errMsg: "no connection" });
    expect(error).toBeInstanceOf(NotConnectedError);
    expect(error.errCode).toBe(10006);
  });
});

describe("自有错误", () => {
  it("TimeoutError 带 phase 与超时时长", () => {
    const error = new TimeoutError("write", 3000);
    expect(error.code).toBe("TIMEOUT");
    expect(error.phase).toBe("write");
    expect(error.message).toContain("3000");
    expect(error.name).toBe("TimeoutError");
  });

  it("InvalidStateError 是领域错误", () => {
    const error = new InvalidStateError("当前状态 scanning 不可写");
    expect(error).toBeInstanceOf(BleDomainError);
    expect(error.code).toBe("INVALID_STATE");
  });
});

describe("isBleTransportFailure", () => {
  it("识别 { errCode: number } 形状", () => {
    expect(isBleTransportFailure({ errCode: 10006 })).toBe(true);
    expect(isBleTransportFailure({ errCode: 10006, errMsg: "x" })).toBe(true);
  });

  it("非该形状返回 false", () => {
    expect(isBleTransportFailure(null)).toBe(false);
    expect(isBleTransportFailure("boom")).toBe(false);
    expect(isBleTransportFailure({ errCode: "10006" })).toBe(false);
    expect(isBleTransportFailure({ message: "x" })).toBe(false);
  });
});