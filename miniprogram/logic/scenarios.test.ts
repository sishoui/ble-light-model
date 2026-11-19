import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseScenario } from "./test_utils/scenario";
import { runScenario } from "./test_utils/scenario_runner";

/** §3.6：场景脚本是跨层唯一用例源；这里让每份 tests/scenarios/*.json 都跑一遍。 */
const scenariosDir = fileURLToPath(new URL("../../tests/scenarios/", import.meta.url));
const scenarioFiles = readdirSync(scenariosDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

describe.each(scenarioFiles)("场景脚本 %s", (file) => {
  it("FakeTransport 驱动 BleLink 全步骤通过", async () => {
    const scenario = parseScenario(readFileSync(path.join(scenariosDir, file), "utf8"));
    await runScenario(scenario);
  });
});

describe("parseScenario schema 校验", () => {
  it("version 必须为 1", () => {
    expect(() => parseScenario(JSON.stringify({ version: 2, name: "x", steps: [] }))).toThrow(
      /version 必须为 1/,
    );
  });

  it("steps 必须是数组", () => {
    expect(() => parseScenario(JSON.stringify({ version: 1, name: "x", steps: {} }))).toThrow(
      /steps 必须是数组/,
    );
  });

  it("非法 JSON 报错", () => {
    expect(() => parseScenario("{")).toThrow(/不是合法 JSON/);
  });

  it("非法 trigger 报错", () => {
    const text = JSON.stringify({
      version: 1,
      name: "x",
      steps: [{ action: "disconnect", trigger: "bogus" }],
    });
    expect(() => parseScenario(text)).toThrow(/trigger 必须是 local \/ remote \/ silent/);
  });

  it("合法脚本归一为类型化结构", () => {
    const scenario = parseScenario(
      JSON.stringify({
        version: 1,
        name: "demo",
        environment: { platform: "ios", mtu: 185 },
        steps: [
          { action: "scan", timeoutMs: 10, expect: { devices: ["C3-A1"], state: "idle" } },
          { action: "waitForState", expect: { state: "ready" } },
        ],
      }),
    );
    expect(scenario.environment).toEqual({ platform: "ios", mtu: 185 });
    expect(scenario.steps[0]?.action).toBe("scan");
    expect(scenario.steps[0]?.timeoutMs).toBe(10);
    expect(scenario.steps[1]?.expect?.state).toBe("ready");
  });
});