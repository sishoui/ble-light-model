/**
 * UI 回归 spike 的唯一用例：连接页 happy path（spec §3.5 / 工单 #19）。
 *
 * 覆盖链路（全部在浏览器里跑，BLE 由 wx-ble-mock 在 wx 层模拟，设备模型复用
 * FakeTransport + FakeLightDevice）：
 *   打开页面 → 扫描 → 设备列表出现 mock 的 BLELight-C3 → 点击连接 →
 *   发现服务/订阅 → C3 回 HELLO → 状态「已就绪」→ 应用灯效（写 + ACK 往返）→
 *   刷新状态（GET_STATUS → STATUS → 页面展示）。
 *
 * 断言面：page data / 渲染层定位点击 / mock 调用日志（errors() 由 fixture 在
 * 用例结束时检查为空，wxaCheckErrors: true）。
 */
import { expect, test } from "@open-wxa/wxa-runner-playwright";

test("连接页 happy path：扫描 → 连接 → 就绪 → 应用灯效 → 查询状态", async ({ miniProgram }) => {
  await miniProgram.open("pages/index/index");

  // 1. 初始态：未连接、无设备列表
  await expect(miniProgram).toHavePageData({ state: "idle", stateText: "未连接", connected: false, devices: [] });

  // 2. 扫描：页面 scan 固定 5s 超时，断言超时放宽到 15s
  await miniProgram.current.getByRole("button", { name: "扫描设备" }).click();
  await expect(miniProgram).toHavePageData(
    { scanning: false, devices: [{ deviceId: "C3-A1", name: "BLELight-C3", rssi: -50 }] },
    { timeout: 15000 },
  );

  // 3. 点击设备连接：createBLEConnection → 发现服务 → 订阅 → HELLO → ready
  await miniProgram.current.locator(".device", { hasText: "BLELight-C3" }).click();
  await expect(miniProgram).toHavePageData({ state: "ready", stateText: "已就绪", connected: true });
  const afterConnect = await miniProgram.pageData();
  expect(afterConnect?.helloText).toContain("固件");
  expect(afterConnect?.helloText).toContain("8 路");

  // 4. 全选灯带 → 应用默认灯效（静态红）→ 等 C3 ACK（写序列含 notify 200ms 生效延迟）
  await miniProgram.current.getByRole("button", { name: "全选" }).click();
  await expect(miniProgram).toHavePageData({ mask: 0xff, maskText: "全路（0xFF）" });
  await miniProgram.current.getByRole("button", { name: /应用灯效/ }).click();
  await expect
    .poll(
      async () => {
        const data = await miniProgram.pageData();
        const log = (data?.log as string[] | undefined) ?? [];
        return log.some((line) => line.includes("已应用"));
      },
      { timeout: 10000 },
    )
    .toBe(true);

  // 5. 刷新状态：GET_STATUS → C3 回 STATUS（FakeLightDevice 默认亮度 128 / 限流 15000mA）
  await miniProgram.current.getByRole("button", { name: "刷新状态" }).click();
  await expect(miniProgram).toHavePageData({ status: { brightness: "128", powerLimit: "15000mA" } });
});