/**
 * 场景脚本（spec §3.6）：语言无关 JSON 的类型与解析。
 *
 * 本工单建立 schema v1：`tests/scenarios/*.json`。FakeTransport 消费其中的传输侧编排
 * （script），Node 侧由 runScenario 驱动 BleLink；#6 PC harness（Python）与 #8 真机 B
 * 后续共读同一份文件，行为不一致即说明 Transport 抽象漏了。
 *
 * 步骤 = 驱动动作（action）+ 可选传输编排（script）+ 可观察断言（expect）。
 * 字段全部可选，除 action；未知字段忽略（前向兼容）。
 */

import type { LinkState } from "../ble_link";
import type { Platform } from "../transport";
import type { FailPhase } from "./fake_transport";

export type ScenarioAction =
  | "scan"
  | "connect"
  | "write"
  | "notify"
  | "disconnect"
  | "hide"
  | "show"
  | "waitForState";

/** 传输侧编排：由 FakeTransport 在动作执行前应用。 */
export interface ScenarioStepScript {
  /** 让某阶段接下来 times 次调用 reject { errCode }（默认 1 次）。 */
  fail?: { phase: FailPhase; errCode: number; times?: number };
  /** 覆盖 getMtu 返回的真实 ATT_MTU。 */
  mtu?: number;
  /** 每个设备重复广播次数（验证扫描去重）。 */
  advertiseRepeats?: number;
  /** setNotification(true) 成功后自动推送的 hex 帧（模拟 HELLO / STATUS）。 */
  notifyHex?: string[];
}

/** 可观察断言：全部针对公开接口（BleLink.state / 返回值 / Transport 调用记录）。 */
export interface ScenarioStepExpect {
  /** BleLink 状态机状态。 */
  state?: LinkState;
  /** scan 返回的设备 deviceId 列表（去重后）。 */
  devices?: string[];
  /** write 动作产生的分片大小序列（字节）。 */
  chunks?: number[];
  /** write 动作产生的分片内容（hex 序列）。 */
  values?: string[];
  /** notify 动作后 BleLink 收到的通知帧（hex）。 */
  notifications?: string[];
  /** 动作预期抛出的领域错误 code（如 NOT_CONNECTED / TIMEOUT）。 */
  error?: string;
  /** Transport connect 累计调用次数（重连风暴防护断言）。 */
  connectCalls?: number;
  /** Transport write 累计调用次数（超时 / 不自动重试断言）。 */
  writeCalls?: number;
}

export interface ScenarioStep {
  action: ScenarioAction;
  deviceId?: string;
  /** write 动作：要写入的原始字节（hex）。 */
  hex?: string;
  /** notify 动作：设备侧推送的帧（hex 序列）。 */
  frames?: string[];
  /** disconnect 动作：local = 调用 BleLink.disconnect；remote = 断连事件；silent = 静默断连（无事件，逼出 10006）。 */
  trigger?: "local" | "remote" | "silent";
  timeoutMs?: number;
  script?: ScenarioStepScript;
  expect?: ScenarioStepExpect;
}

/** 场景级环境默认值（传给 FakeTransport / BleLink）。 */
export interface ScenarioEnvironment {
  platform?: Platform;
  mtu?: number;
}

export interface Scenario {
  version: number;
  name: string;
  description?: string;
  environment?: ScenarioEnvironment;
  steps: ScenarioStep[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`场景脚本字段 ${field} 必须是字符串`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`场景脚本字段 ${field} 必须是字符串数组`);
  }
  return value as string[];
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`场景脚本字段 ${field} 必须是数字`);
  return value;
}

/** 解析并校验场景脚本 JSON（schema v1）。 */
export function parseScenario(text: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`场景脚本不是合法 JSON：${String(error)}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("场景脚本根节点必须是对象");
  const root = raw as Record<string, unknown>;
  const version = optionalNumber(root.version, "version");
  if (version !== 1) throw new Error(`场景脚本 version 必须为 1，收到 ${String(version)}`);
  const name = requireString(root.name, "name");
  const description = optionalString(root.description, "description");
  if (!Array.isArray(root.steps)) throw new Error("场景脚本 steps 必须是数组");

  const steps = root.steps.map((stepRaw, index): ScenarioStep => {
    if (typeof stepRaw !== "object" || stepRaw === null) {
      throw new Error(`steps[${index}] 必须是对象`);
    }
    const step = stepRaw as Record<string, unknown>;
    const action = requireString(step.action, `steps[${index}].action`);
    const stepOut: ScenarioStep = { action: action as ScenarioAction };
    const deviceId = optionalString(step.deviceId, `steps[${index}].deviceId`);
    if (deviceId !== undefined) stepOut.deviceId = deviceId;
    const hex = optionalString(step.hex, `steps[${index}].hex`);
    if (hex !== undefined) stepOut.hex = hex;
    const frames = optionalStringArray(step.frames, `steps[${index}].frames`);
    if (frames !== undefined) stepOut.frames = frames;
    const trigger = optionalString(step.trigger, `steps[${index}].trigger`);
    if (trigger !== undefined) {
      if (trigger !== "local" && trigger !== "remote" && trigger !== "silent") {
        throw new Error(`steps[${index}].trigger 必须是 local / remote / silent`);
      }
      stepOut.trigger = trigger;
    }
    const timeoutMs = optionalNumber(step.timeoutMs, `steps[${index}].timeoutMs`);
    if (timeoutMs !== undefined) stepOut.timeoutMs = timeoutMs;

    if (step.script !== undefined) {
      if (typeof step.script !== "object" || step.script === null) {
        throw new Error(`steps[${index}].script 必须是对象`);
      }
      const script = step.script as Record<string, unknown>;
      const scriptOut: ScenarioStepScript = {};
      if (script.fail !== undefined) {
        if (typeof script.fail !== "object" || script.fail === null) {
          throw new Error(`steps[${index}].script.fail 必须是对象`);
        }
        const fail = script.fail as Record<string, unknown>;
        const failOut: { phase: FailPhase; errCode: number; times?: number } = {
          phase: requireString(fail.phase, "script.fail.phase") as FailPhase,
          errCode: optionalNumber(fail.errCode, "script.fail.errCode") ?? 0,
        };
        const times = optionalNumber(fail.times, "script.fail.times");
        if (times !== undefined) failOut.times = times;
        scriptOut.fail = failOut;
      }
      const mtu = optionalNumber(script.mtu, "script.mtu");
      if (mtu !== undefined) scriptOut.mtu = mtu;
      const repeats = optionalNumber(script.advertiseRepeats, "script.advertiseRepeats");
      if (repeats !== undefined) scriptOut.advertiseRepeats = repeats;
      const notifyHex = optionalStringArray(script.notifyHex, "script.notifyHex");
      if (notifyHex !== undefined) scriptOut.notifyHex = notifyHex;
      stepOut.script = scriptOut;
    }

    if (step.expect !== undefined) {
      if (typeof step.expect !== "object" || step.expect === null) {
        throw new Error(`steps[${index}].expect 必须是对象`);
      }
      const expect = step.expect as Record<string, unknown>;
      const expectOut: ScenarioStepExpect = {};
      const state = optionalString(expect.state, "expect.state");
      if (state !== undefined) expectOut.state = state as LinkState;
      const devices = optionalStringArray(expect.devices, "expect.devices");
      if (devices !== undefined) expectOut.devices = devices;
      const chunks = expect.chunks;
      if (chunks !== undefined) {
        if (!Array.isArray(chunks) || chunks.some((n) => typeof n !== "number")) {
          throw new Error(`steps[${index}].expect.chunks 必须是数字数组`);
        }
        expectOut.chunks = chunks as number[];
      }
      const values = optionalStringArray(expect.values, "expect.values");
      if (values !== undefined) expectOut.values = values;
      const notifications = optionalStringArray(expect.notifications, "expect.notifications");
      if (notifications !== undefined) expectOut.notifications = notifications;
      const error = optionalString(expect.error, "expect.error");
      if (error !== undefined) expectOut.error = error;
      const connectCalls = optionalNumber(expect.connectCalls, "expect.connectCalls");
      if (connectCalls !== undefined) expectOut.connectCalls = connectCalls;
      const writeCalls = optionalNumber(expect.writeCalls, "expect.writeCalls");
      if (writeCalls !== undefined) expectOut.writeCalls = writeCalls;
      stepOut.expect = expectOut;
    }

    return stepOut;
  });

  const scenario: Scenario = { version, name, steps };
  if (description !== undefined) scenario.description = description;
  if (root.environment !== undefined) {
    if (typeof root.environment !== "object" || root.environment === null) {
      throw new Error("environment 必须是对象");
    }
    const env = root.environment as Record<string, unknown>;
    const platform = optionalString(env.platform, "environment.platform");
    const mtu = optionalNumber(env.mtu, "environment.mtu");
    scenario.environment = {};
    if (platform !== undefined) scenario.environment.platform = platform as Platform;
    if (mtu !== undefined) scenario.environment.mtu = mtu;
  }
  return scenario;
}