/**
 * 场景脚本执行器：把 §3.6 的场景 JSON 喂给 FakeTransport 驱动 BleLink，并逐步骤断言。
 *
 * Node 单测（#2）的执行器；#6 PC harness（Python）与 #8 真机 B 后续按同一份 JSON
 * 各自解释 action / expect，行为不一致即说明 Transport 抽象漏了。
 */

import { BleLink } from "../ble_link";
import type { BleLinkOptions, LinkState } from "../ble_link";
import { BleDomainError } from "../errors";
import { DEFAULT_DEVICE_ID, FakeTransport, bytesToHex, hexToBytes } from "./fake_transport";
import type { FakeTransportOptions } from "./fake_transport";
import type { Scenario, ScenarioStep, ScenarioStepExpect } from "./scenario";

export interface ScenarioRunOptions {
  link?: BleLinkOptions;
  transport?: FakeTransportOptions;
}

export interface ScenarioRunResult {
  link: BleLink;
  transport: FakeTransport;
  notifications: string[];
}

interface StepResult {
  value?: unknown;
  error?: unknown;
}

const STATE_POLL_INTERVAL_MS = 5;
const STATE_POLL_TIMEOUT_MS = 3000;

function applyScript(transport: FakeTransport, step: ScenarioStep): void {
  const script = step.script;
  if (script === undefined) return;
  if (script.fail !== undefined) {
    transport.enqueueFailure(script.fail.phase, script.fail.errCode, script.fail.times ?? 1);
  }
  if (script.mtu !== undefined) transport.setMtuValue(script.mtu);
  if (script.advertiseRepeats !== undefined) transport.setAdvertiseRepeats(script.advertiseRepeats);
  if (script.notifyHex !== undefined) transport.setNotifyFrames(script.notifyHex);
}

async function waitForState(link: BleLink, state: LinkState): Promise<void> {
  const deadline = Date.now() + STATE_POLL_TIMEOUT_MS;
  while (link.state !== state) {
    if (Date.now() > deadline) {
      throw new Error(`waitForState 超时：期望 ${state}，当前 ${link.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_INTERVAL_MS));
  }
}

async function runAction(
  link: BleLink,
  transport: FakeTransport,
  step: ScenarioStep,
): Promise<StepResult> {
  switch (step.action) {
    case "scan": {
      const scanOptions: { timeoutMs?: number } = {};
      if (step.timeoutMs !== undefined) scanOptions.timeoutMs = step.timeoutMs;
      try {
        return { value: await link.scan(scanOptions) };
      } catch (error) {
        return { error };
      }
    }
    case "connect": {
      try {
        await link.connect(step.deviceId ?? DEFAULT_DEVICE_ID);
        return {};
      } catch (error) {
        return { error };
      }
    }
    case "write": {
      if (step.hex === undefined) throw new Error("write 动作缺少 hex");
      try {
        await link.write(hexToBytes(step.hex));
        return {};
      } catch (error) {
        return { error };
      }
    }
    case "notify": {
      for (const hex of step.frames ?? []) transport.emitNotification(hex);
      return {};
    }
    case "disconnect": {
      if (step.trigger === "local") {
        try {
          await link.disconnect();
          return {};
        } catch (error) {
          return { error };
        }
      }
      transport.dropConnection(step.deviceId ?? link.deviceId ?? DEFAULT_DEVICE_ID, {
        silent: step.trigger === "silent",
      });
      return {};
    }
    case "hide": {
      link.onHide();
      return {};
    }
    case "show": {
      try {
        await link.onShow();
        return {};
      } catch (error) {
        return { error };
      }
    }
    case "waitForState": {
      const expected = step.expect?.state;
      if (expected === undefined) throw new Error("waitForState 动作缺少 expect.state");
      await waitForState(link, expected);
      return {};
    }
  }
}

function fail(step: ScenarioStep, index: number, message: string): never {
  throw new Error(`场景步骤 #${index}（${step.action}）断言失败：${message}`);
}

function verifyExpect(
  step: ScenarioStep,
  index: number,
  result: StepResult,
  before: { writes: number; notifications: number },
  context: { link: BleLink; transport: FakeTransport; notifications: string[] },
): void {
  const expect: ScenarioStepExpect | undefined = step.expect;

  if (expect?.error !== undefined) {
    const error = result.error;
    if (!(error instanceof BleDomainError)) {
      fail(step, index, `期望领域错误 ${expect.error}，实际 ${String(error)}`);
    }
    if (error.code !== expect.error) {
      fail(step, index, `期望领域错误 ${expect.error}，实际 ${error.code}`);
    }
  } else if (result.error !== undefined) {
    fail(step, index, `出现未预期错误：${String(result.error)}`);
  }

  if (expect === undefined) return;

  if (expect.state !== undefined && context.link.state !== expect.state) {
    fail(step, index, `期望状态 ${expect.state}，实际 ${context.link.state}`);
  }

  if (expect.devices !== undefined) {
    const devices = result.value;
    if (!Array.isArray(devices)) {
      fail(step, index, "scan 未返回设备列表");
    }
    const ids = (devices as Array<{ deviceId: string }>).map((d) => d.deviceId);
    if (JSON.stringify(ids) !== JSON.stringify(expect.devices)) {
      fail(step, index, `期望设备 ${JSON.stringify(expect.devices)}，实际 ${JSON.stringify(ids)}`);
    }
  }

  const newWrites = context.transport.writes.slice(before.writes);
  if (expect.chunks !== undefined) {
    const sizes = newWrites.map((w) => w.hex.length / 2);
    if (JSON.stringify(sizes) !== JSON.stringify(expect.chunks)) {
      fail(step, index, `期望分片 ${JSON.stringify(expect.chunks)}，实际 ${JSON.stringify(sizes)}`);
    }
  }

  if (expect.values !== undefined) {
    const values = newWrites.map((w) => w.hex.toLowerCase());
    const expected = expect.values.map((hex) => hex.toLowerCase());
    if (JSON.stringify(values) !== JSON.stringify(expected)) {
      fail(step, index, `期望写入 ${JSON.stringify(expect.values)}，实际 ${JSON.stringify(values)}`);
    }
  }

  if (expect.notifications !== undefined) {
    const received = context.notifications.slice(before.notifications).map((hex) => hex.toLowerCase());
    const expected = expect.notifications.map((hex) => hex.toLowerCase());
    if (JSON.stringify(received) !== JSON.stringify(expected)) {
      fail(
        step,
        index,
        `期望通知 ${JSON.stringify(expect.notifications)}，实际 ${JSON.stringify(received)}`,
      );
    }
  }

  if (expect.connectCalls !== undefined && context.transport.opCount("connect") !== expect.connectCalls) {
    fail(step, index, `期望 connect 调用 ${expect.connectCalls} 次，实际 ${context.transport.opCount("connect")}`);
  }

  if (expect.writeCalls !== undefined && context.transport.opCount("write") !== expect.writeCalls) {
    fail(step, index, `期望 write 调用 ${expect.writeCalls} 次，实际 ${context.transport.opCount("write")}`);
  }
}

/** 执行整个场景脚本；任一步骤断言失败即抛错（含步骤序号）。 */
export async function runScenario(
  scenario: Scenario,
  options: ScenarioRunOptions = {},
): Promise<ScenarioRunResult> {
  const transportOptions: FakeTransportOptions = { ...options.transport };
  if (scenario.environment?.platform !== undefined && transportOptions.platform === undefined) {
    transportOptions.platform = scenario.environment.platform;
  }
  if (scenario.environment?.mtu !== undefined && transportOptions.mtu === undefined) {
    transportOptions.mtu = scenario.environment.mtu;
  }
  const transport = new FakeTransport(transportOptions);
  const link = new BleLink(transport, {
    scanTimeoutMs: 50,
    reconnectDelayMs: 20,
    ...options.link,
  });
  const notifications: string[] = [];
  link.onNotification((notification) => notifications.push(bytesToHex(notification.value)));

  for (const [index, step] of scenario.steps.entries()) {
    applyScript(transport, step);
    const before = { writes: transport.writes.length, notifications: notifications.length };
    const result = await runAction(link, transport, step);
    verifyExpect(step, index, result, before, { link, transport, notifications });
  }

  return { link, transport, notifications };
}