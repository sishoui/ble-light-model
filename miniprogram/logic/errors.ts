/**
 * 领域错误（GLOSSARY）：业务层唯一可见的错误词汇，由 WxTransport 的原始 errCode 映射而来。
 * 覆盖 wx-ble-facts §2 的错误码表 + 本项目自有的超时 / 状态机错误。
 *
 * 映射规则：`mapErrCode(errCode, errMsg)` 是逐码映射表 + 未知码兜底（UnknownBleError，
 * 原始码保留在 errCode 字段）。业务层只 instanceof / code 判断，不裸判 errCode。
 */

import type { BleTransportFailure } from "./transport";

/** 领域错误基类；code 为稳定的领域错误码（大写下划线），errCode/errMsg 保留原始值。 */
export abstract class BleDomainError extends Error {
  readonly code: string;
  readonly errCode: number | undefined;
  readonly errMsg: string | undefined;

  constructor(
    code: string,
    message: string,
    options?: { errCode?: number; errMsg?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.errCode = options?.errCode;
    this.errMsg = options?.errMsg;
  }
}

/** 10000：未初始化蓝牙适配器（未 openBluetoothAdapter 就调其他 API）。 */
export class NotInitializedError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("NOT_INITIALIZED", "蓝牙适配器未初始化", options);
  }
}

/** 10001：当前蓝牙适配器不可用（手机蓝牙未开 / 不支持）。 */
export class AdapterUnavailableError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("ADAPTER_UNAVAILABLE", "蓝牙适配器不可用", options);
  }
}

/** 10002：没有找到指定设备。 */
export class DeviceNotFoundError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("DEVICE_NOT_FOUND", "没有找到指定设备", options);
  }
}

/** 10003：连接失败。 */
export class ConnectionFailedError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("CONNECTION_FAILED", "连接失败", options);
  }
}

/** 10004：没有找到指定服务。 */
export class NoServiceError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("NO_SERVICE", "没有找到指定服务", options);
  }
}

/** 10005：没有找到指定特征。 */
export class NoCharacteristicError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("NO_CHARACTERISTIC", "没有找到指定特征", options);
  }
}

/**
 * 10006：当前连接已断开（断连路径②：断连后读写会 reject 10006）。
 * 官方建议此时进行重连；BleLink 把它视为可触发重连的断连信号。
 */
export class NotConnectedError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("NOT_CONNECTED", "当前连接已断开", options);
  }
}

/** 10007：当前特征不支持此操作（如向只读特征 write）。 */
export class OperationNotSupportedError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("OPERATION_NOT_SUPPORTED", "当前特征不支持此操作", options);
  }
}

/** 10008：系统错误（其余系统上报异常，常见于安卓 GATT ERROR / notify 后立即 write）。 */
export class SystemError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string; cause?: unknown }) {
    super("SYSTEM_ERROR", "蓝牙系统错误", options);
  }
}

/** 10009：系统不支持（安卓系统版本低于 4.3）。 */
export class PlatformNotSupportedError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("PLATFORM_NOT_SUPPORTED", "系统不支持蓝牙", options);
  }
}

/** 10012：操作超时（连接超时）。 */
export class ConnectionTimeoutError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("CONNECTION_TIMEOUT", "连接超时", options);
  }
}

/** 10013：deviceId 为空或格式不正确。 */
export class InvalidDeviceIdError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("INVALID_DEVICE_ID", "deviceId 为空或格式不正确", options);
  }
}

/** -1：已连接（wx 特有码，createBLEConnection 对重复连接返回）。 */
export class AlreadyConnectedError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string }) {
    super("ALREADY_CONNECTED", "设备已连接", options);
  }
}

/** 未知 errCode 兜底：原始码保留，不丢失信息。 */
export class UnknownBleError extends BleDomainError {
  constructor(options?: { errCode?: number; errMsg?: string; cause?: unknown }) {
    super(
      "UNKNOWN_BLE_ERROR",
      options?.errCode === undefined ? "未知蓝牙错误" : `未知蓝牙错误（errCode=${options.errCode}）`,
      options,
    );
  }
}

/**
 * 本项目自有超时（spec §3.1：每片写 3s 超时 → TimeoutError，不自动重试）。
 * 与 wx 的 10012（连接超时）区分：这是小程序侧看门狗。
 */
export class TimeoutError extends BleDomainError {
  readonly phase: string;

  constructor(phase: string, timeoutMs: number) {
    super("TIMEOUT", `${phase}超时（${timeoutMs}ms）`);
    this.phase = phase;
  }
}

/** BleLink 状态机拒绝非法操作（如非 ready 状态下 write）。非 wx 映射。 */
export class InvalidStateError extends BleDomainError {
  constructor(message: string) {
    super("INVALID_STATE", message);
  }
}

  /** 逐码映射表：wx errCode -> 领域错误（wx-ble-facts §2 全表 + -1）。 */
export function mapErrCode(errCode: number, errMsg?: string): BleDomainError {
  const options = errMsg === undefined ? { errCode } : { errCode, errMsg };
  switch (errCode) {
    case -1:
      return new AlreadyConnectedError(options);
    case 10000:
      return new NotInitializedError(options);
    case 10001:
      return new AdapterUnavailableError(options);
    case 10002:
      return new DeviceNotFoundError(options);
    case 10003:
      return new ConnectionFailedError(options);
    case 10004:
      return new NoServiceError(options);
    case 10005:
      return new NoCharacteristicError(options);
    case 10006:
      return new NotConnectedError(options);
    case 10007:
      return new OperationNotSupportedError(options);
    case 10008:
      return new SystemError(options);
    case 10009:
      return new PlatformNotSupportedError(options);
    case 10012:
      return new ConnectionTimeoutError(options);
    case 10013:
      return new InvalidDeviceIdError(options);
    default:
      return new UnknownBleError(options);
  }
}

/** 原始失败形状（Transport reject 的 { errCode, errMsg }）-> 领域错误。 */
export function mapTransportFailure(failure: BleTransportFailure): BleDomainError {
  return mapErrCode(failure.errCode, failure.errMsg);
}