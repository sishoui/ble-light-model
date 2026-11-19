/**
 * wxa.setup：wxa-runner 启动前钩子（spec §3.5 / 工单 #19）。
 *
 * 在 App.onLaunch 之前、appservice iframe 创建之前执行（浏览器 top window）：
 * - 创建 wx-ble-mock（FakeTransport + FakeLightDevice，设备模型与 Node 单测同源）；
 * - invoke 型 BLE wx.* 注册为 ApiRegistry mock（键为原生名，见 wx-ble-mock.ts）；
 * - 事件型（on*）由 wx-ble-mock 经 __wxaHost.emitToService 派发，不在这里处理；
 * - showToast：页面会直接调用，wxa-runner 未实现它，不 mock 会被 errors() 记账。
 *
 * setup 由 wxa-runner 的 esbuild 单独打包（platform=browser），可 import 小程序 TS 源码；
 * 不能 import Node 内置模块。
 */
import { defineSetup } from "@open-wxa/wxa-runner-core/setup";
import { createWxBleMock } from "./wx-ble-mock";

const bleMock = createWxBleMock();

export default defineSetup({
  mock: {
    ...bleMock.invokeMocks,
    // 非 BLE：页面成功 / 失败路径都会调用 showToast。
    showToast: {},
  },
});