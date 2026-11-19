/**
 * automator 会话（spec §3.4 环境固化 + research/test-automation-facts §1）：
 * - 工具常驻：`cli auto --project <miniprogram> --auto-port 9420` 由人工先起，
 *   脚本只 connect({wsEndpoint})（Windows + Node>=18 下 launch() 有 spawn EINVAL 坑）；
 * - remote(true) 未扫码静默等待无超时 → 每轮 60s 看门狗；remote(false) 打印二维码
 *   供首次真机调试（--remote qr）；
 * - connect() 无内置超时 → 每次调用包超时（withTimeout）；
 * - `Connection closed` 不重试、等人（SessionClosedError）；
 * - BLE notify 推到脚本：exposeFunction('onBLEFrame', hex) + evaluate 注入第二个
 *   wx.onBLECharacteristicValueChange 监听器，hex 回传；不给生产代码加测试钩子。
 *   注意：evaluate 注入的监听器在小程序重启（重新编译）后会丢，需要重跑 run.js。
 * - remote 下 screenshot() 不可用，page.data() / page.callMethod() / element.attribute()
 *   可用（官方真机示例在用）。
 */

import automator from 'miniprogram-automator';

/** remote / connect 看门狗（spec §3.4：60s）。 */
export const CONNECT_TIMEOUT_MS = 60_000;
export const REMOTE_TIMEOUT_MS = 60_000;
/** 单次 automator 调用超时（spec：connect 无内置超时，每次调用包超时）。 */
export const CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_WS_ENDPOINT = 'ws://127.0.0.1:9420';

export class SessionConnectError extends Error {}
export class SessionClosedError extends Error {}
export class SessionTimeoutError extends Error {}
export class StepAssertionError extends Error {}

export function isConnectionClosed(e) {
  return /Connection closed/i.test(String((e && e.message) || e));
}

/** 给任意 Promise 包超时；超时抛 SessionTimeoutError。 */
export function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SessionTimeoutError(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function friendlyConnectError(e) {
  if (isConnectionClosed(e)) return e;
  return new SessionConnectError(
    `无法连接开发者工具自动化端口（${e.message}）。请确认：` +
      '① 微信开发者工具已常驻且项目已打开；' +
      '② 已执行 cli auto --project <miniprogram 路径> --auto-port 9420（或 launch 等价命令）；' +
      '③ 手机真机调试已启用并连接（remote 扫码或已连过）；' +
      '④ 9420 端口未被其他进程占用。',
  );
}

/**
 * 连接真机会话。remoteMode：
 * - 'auto'：remote(true)，不打印二维码（手机需已连过，未连则 60s 看门狗超时）；
 * - 'qr'：remote(false)，打印二维码供人工扫码（首次真机调试用）；
 * - 'off'：不调 remote（会话已由人工/其他脚本建立）。
 */
export async function connectSession({
  wsEndpoint = DEFAULT_WS_ENDPOINT,
  remoteMode = 'auto',
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  remoteTimeoutMs = REMOTE_TIMEOUT_MS,
  callTimeoutMs = CALL_TIMEOUT_MS,
  log = () => {},
} = {}) {
  let mp;
  try {
    mp = await withTimeout(automator.connect({ wsEndpoint }), connectTimeoutMs, `automator.connect(${wsEndpoint})`);
  } catch (e) {
    throw friendlyConnectError(e);
  }
  log(`automator.connect OK: ${wsEndpoint}`);

  if (remoteMode !== 'off') {
    try {
      await withTimeout(mp.remote(remoteMode === 'qr'), remoteTimeoutMs, `remote(${remoteMode === 'qr' ? 'qr' : 'auto'})`);
    } catch (e) {
      if (e instanceof SessionTimeoutError) {
        throw new SessionConnectError(
          `remote() 60s 内未等到真机连接：请确认手机已连接开发者工具真机调试（--remote qr 可打印二维码重新扫码），` +
            '或改用 --remote off 复用已建立的会话。',
        );
      }
      throw friendlyConnectError(e);
    }
    log(`remote(${remoteMode === 'qr' ? 'qr' : 'auto'}) OK（真机已连接）`);
  }

  const session = new DeviceSession({ mp, callTimeoutMs, log });
  await session._clearStaleListeners();
  await session._setupBleTap();
  return session;
}

export class DeviceSession {
  constructor({ mp, callTimeoutMs = CALL_TIMEOUT_MS, log = () => {} }) {
    this._mp = mp;
    this.callTimeoutMs = callTimeoutMs;
    this.log = log;
    /** BLE notify 时间线：{ tsMs, hex }（exposeFunction 回传，JSON 只传 hex）。 */
    this.notifyFrames = [];
    /** 小程序 console 捕获：{ tsMs, type, args }（console 只断领域错误出现 / 不出现）。 */
    this.consoleLogs = [];
    this._offConsole = null;
  }

  /**
   * 清掉小程序里残留的 wx BLE 监听（上一次运行 / 旧页面的 BleLink）。
   * 不清的话旧 BleLink 会和新页面抢断连事件 → 重连风暴。新页面在 reLaunch
   * 时由 WxTransport 构造重新注册；测试注入的监听随后装。
   */
  async _clearStaleListeners() {
    await this.evaluate(() => {
      // 不能引用闭包；逐个 try（个别 off* 在部分基础库可能不存在）。
      try { wx.offBluetoothDeviceFound(); } catch (e) { /* noop */ }
      try { wx.offBLEConnectionStateChange(); } catch (e) { /* noop */ }
      try { wx.offBLECharacteristicValueChange(); } catch (e) { /* noop */ }
      try { wx.offBLEMTUChange(); } catch (e) { /* noop */ }
    });
  }

  /** exposeFunction + evaluate 注入第二个 BLE 监听器（不给生产代码加钩子）。 */
  async _setupBleTap() {
    await this._mp.exposeFunction('onBLEFrame', (hex) => {
      this.notifyFrames.push({ tsMs: Date.now(), hex });
    });
    await this.evaluate(() => {
      // 不能引用闭包：onBLEFrame 是 exposeFunction 注册的全局名；值转 hex（JSON 序列化）。
      wx.onBLECharacteristicValueChange(function (res) {
        var bytes = new Uint8Array(res.value);
        var hex = '';
        for (var i = 0; i < bytes.length; i += 1) hex += ('0' + bytes[i].toString(16)).slice(-2);
        onBLEFrame(hex);
      });
    });
    try {
      this._offConsole = this._mp.on('console', (msg) => {
        this.consoleLogs.push({ tsMs: Date.now(), type: msg && msg.type, args: msg && msg.args });
      });
    } catch {
      this._offConsole = null;
    }
  }

  _call(promise, label) {
    return withTimeout(promise, this.callTimeoutMs, label).catch((e) => {
      if (e instanceof SessionTimeoutError) throw e;
      if (isConnectionClosed(e)) {
        throw new SessionClosedError(
          `automator 会话断开（${e.message}）。不重试：请检查开发者工具是否常驻 / 真机调试是否掉线，等人恢复后重跑。`,
        );
      }
      throw e;
    });
  }

  async page() {
    const page = await this._call(this._mp.currentPage(), 'currentPage()');
    if (!page) throw new StepAssertionError('currentPage() 返回空（页面未打开？）');
    return page;
  }

  async currentPageData() {
    const page = await this.page();
    return this._call(page.data(), 'page.data()');
  }

  async tap(selector) {
    const page = await this.page();
    const el = await this._call(page.$(selector), `page.$(${selector})`);
    if (!el) throw new StepAssertionError(`未找到元素 ${selector}（页面结构变了？检查 index.wxml）`);
    await this._call(el.tap(), `tap(${selector})`);
  }

  async tapAt(selector, index) {
    const page = await this.page();
    const els = await this._call(page.$$(selector), `page.$$(${selector})`);
    const el = els[index];
    if (!el) throw new StepAssertionError(`元素 ${selector}[${index}] 不存在（共 ${els.length} 个）`);
    await this._call(el.tap(), `tap(${selector}[${index}])`);
  }

  async callMethod(method, ...args) {
    const page = await this.page();
    return this._call(page.callMethod(method, ...args), `page.callMethod(${method})`);
  }

  /** element.attribute(name)：只断可访问性 / 状态类（disabled 等）。 */
  async elementAttribute(selector, name) {
    const el = await this.element(selector);
    if (!el) return null;
    return this._call(el.attribute(name), `attribute(${name})`);
  }

  /** 元素是否存在（wx:if 控制的存在性断言）。 */
  async element(selector) {
    const page = await this.page();
    return this._call(page.$(selector), `page.$(${selector})`);
  }

  async elementVisible(selector) {
    const page = await this.page();
    const el = await this._call(page.$(selector), `page.$(${selector})`);
    if (!el) return false;
    return this._call(el.visible(), `visible(${selector})`);
  }

  async reLaunch(path) {
    await this._call(this._mp.reLaunch(path), `reLaunch(${path})`);
  }

  /** 断开自动化连接（不 close()——工具常驻工作流）。 */
  async close() {
    if (this._offConsole) {
      try {
        this._offConsole();
      } catch {
        /* ignore */
      }
      this._offConsole = null;
    }
    try {
      await this._call(this._mp.disconnect(), 'disconnect()');
    } catch {
      /* 断开失败不影响结果判定 */
    }
  }
}