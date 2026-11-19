"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  expect: () => expect,
  test: () => test
});
module.exports = __toCommonJS(src_exports);
var import_path2 = __toESM(require("path"));
var import_test2 = require("@playwright/test");
var import_wxa_runner_core = require("@open-wxa/wxa-runner-core");

// src/launchOptions.ts
var EAGER_SOURCE_POSITIONS = "--no-enable-lazy-source-positions";
var JS_FLAGS = "--js-flags=";
function withEagerSourcePositions(args = []) {
  const index = args.findIndex((arg) => arg.startsWith(JS_FLAGS));
  if (index < 0) return [...args, JS_FLAGS + EAGER_SOURCE_POSITIONS];
  if (args[index].includes("lazy-source-positions")) return [...args];
  return args.map((arg, i) => i === index ? `${arg} ${EAGER_SOURCE_POSITIONS}` : arg);
}

// src/matchers.ts
var import_test = require("@playwright/test");
async function retry(state, name, expected, timeout, read, assertion) {
  let actual;
  let readError;
  let pass;
  try {
    const poll = import_test.expect.poll(async () => {
      try {
        actual = await read();
        readError = void 0;
      } catch (error) {
        readError = error;
        throw error;
      }
      return actual;
    }, { timeout: timeout ?? state.timeout });
    await (state.isNot ? poll.not : poll)[assertion](expected);
    pass = true;
  } catch {
    pass = false;
  }
  if (state.isNot) pass = !pass;
  const message = () => [
    state.utils.matcherHint(name, void 0, void 0, { isNot: state.isNot }),
    "",
    `Expected: ${state.isNot ? "not " : ""}${state.utils.printExpected(expected)}`,
    readError ? `Error: ${readError instanceof Error ? readError.message : String(readError)}` : `Received: ${state.utils.printReceived(actual)}`
  ].join("\n");
  return { pass, message, name, expected, actual };
}
var miniProgramMatchers = {
  /**
   * 当前页是指定页面，不是时反复检查直到超时：点击跳转后不用手动等待
   * @param path 页面路径，如 pages/detail/detail，开头的 / 可有可无
   * @param options.timeout 毫秒，默认同 expect 的超时
   */
  toHavePath(miniProgram, path3, options = {}) {
    const expected = path3.replace(/^\/+/, "");
    return retry(this, "toHavePath", expected, options.timeout, async () => (await miniProgram.currentPage())?.path ?? null, "toBe");
  },
  /**
   * 页面的 data 包含给定的字段和值（同 toMatchObject，未列出的字段不比较），不满足时反复检查直到超时
   * @param options.path 不传时检查当前页，传页面路径时检查页面栈里的这个页面
   * @param options.timeout 毫秒，默认同 expect 的超时
   */
  toHavePageData(miniProgram, expected, options = {}) {
    return retry(this, "toHavePageData", expected, options.timeout, () => miniProgram.pageData(options.path), "toMatchObject");
  }
};

// src/request.ts
function parseRequestBody(request) {
  const { data } = request;
  if (typeof data !== "string") return data;
  const type = Object.entries(request.header).find(([name]) => name.toLowerCase() === "content-type")?.[1] || "";
  if (/\/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(data));
  if (/[/+]json/i.test(type)) {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}
function withBody(request) {
  return { ...request, body: parseRequestBody(request) };
}

// src/miniProgram.ts
var BRIDGE = "__wxa_playwright__";
var BINARY_BODY = "__wxa_binary_body__";
var DEFAULT_REQUEST_TIMEOUT = 1e4;
var DEFAULT_WEB_VIEW_TIMEOUT = 1e4;
var SYNC_APIS = /* @__PURE__ */ new Set(["getSystemInfo", "getMenuButtonBoundingClientRect"]);
function installInPage({ bridge, binaryBody }) {
  if (window !== window.top) return;
  const callNode = (...args) => window[bridge](...args);
  const decodeBody = (response) => {
    const base64 = response?.body?.[binaryBody];
    return typeof base64 === "string" ? { ...response, body: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)) } : response;
  };
  const toNode = (request) => Object.prototype.toString.call(request?.data) === "[object ArrayBuffer]" ? { ...request, data: new Uint8Array(request.data) } : request;
  const replay = (api, operations) => {
    for (const op of operations) {
      if (op.type === "mock") {
        api.mock(op.api, op.handler ? (args, context) => callNode("call", op.handler, [args, context]) : op.result);
      } else if (op.type === "unmock") {
        api.unmock(op.api);
      } else if (op.type === "route") {
        api.route(op.pattern, op.handler ? async (request) => decodeBody(await callNode("call", op.handler, [toNode(request)])) : decodeBody(op.response));
      } else {
        api.unroute(op.pattern);
      }
    }
  };
  window.__wxa_playwright_replay__ = replay;
  window.__wxa_playwright_requests__ = (pattern) => window.__wxa_test_api__.requests(pattern).map(toNode);
  window.__wxa_before_launch__ = async (api) => replay(api, await callNode("operations"));
}
function encodeBinaryBody(response) {
  const body = response?.body;
  if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return response;
  const bytes = ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.from(body);
  return { ...response, body: { [BINARY_BODY]: bytes.toString("base64") } };
}
function fromPage(request) {
  const { data } = request;
  if (!(data instanceof Uint8Array)) return withBody(request);
  return withBody({ ...request, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
}
async function trackWebViewWindows(page) {
  const windows = /* @__PURE__ */ new Map();
  const opened = [];
  const popups = [];
  const close = (popup) => popup && !popup.isClosed() ? popup.close().catch(() => void 0) : void 0;
  const pair = () => {
    while (opened.length && popups.length) {
      const popup = popups.shift();
      const index = Math.max(0, opened.findIndex((open) => open.src === popup.url()));
      const [{ name, closed }] = opened.splice(index, 1);
      if (closed) {
        void close(popup);
        continue;
      }
      const previous = windows.get(name);
      windows.set(name, popup);
      if (previous !== popup) void close(previous);
    }
  };
  await page.exposeFunction("__wxa_webview_window_event__", (type, name, src) => {
    if (type === "open") {
      opened.push({ name, src: src ?? "", closed: false });
      pair();
      return;
    }
    const pending = opened.find((open) => open.name === name);
    if (pending) pending.closed = true;
    void close(windows.get(name));
    windows.delete(name);
  });
  await page.addInitScript(() => {
    window.__wxa_webview_window__ = true;
  });
  page.on("popup", (popup) => {
    popups.push(popup);
    pair();
  });
  return {
    get(name) {
      const popup = windows.get(name);
      return popup && !popup.isClosed() ? popup : void 0;
    },
    async closeAll() {
      const all = [...windows.values(), ...popups.splice(0)];
      windows.clear();
      opened.length = 0;
      await Promise.all(all.map(close));
    }
  };
}
function waitForLaunch() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error) => {
      settled = true;
      resolve(error);
    };
    window.__wxa_test_api__?.ready.then(() => finish(null));
    const poll = () => {
      if (settled) return;
      const shown = document.querySelector(".wxa-error");
      if (shown) finish(shown.textContent || "");
      else setTimeout(poll, 50);
    };
    poll();
  });
}
async function createMiniProgram(page, { baseURL, listPages, webViewWindow = false }) {
  const operations = [];
  const handlers = /* @__PURE__ */ new Map();
  const handlerErrors = [];
  const earlierErrors = [];
  const addHandler = (source, run) => {
    const id = handlers.size + 1;
    handlers.set(id, { source, run });
    return id;
  };
  await page.exposeFunction(BRIDGE, async (kind, id, args = []) => {
    if (kind === "operations") return operations;
    const handler = handlers.get(id);
    try {
      return await handler.run(args);
    } catch (error) {
      handlerErrors.push({ source: handler.source, error });
      throw error;
    }
  });
  await page.addInitScript(installInPage, { bridge: BRIDGE, binaryBody: BINARY_BODY });
  const windows = webViewWindow ? await trackWebViewWindows(page) : null;
  const declare = async (operation) => {
    await page.evaluate((op) => {
      const api = window.__wxa_test_api__;
      const replay = window.__wxa_playwright_replay__;
      if (api && replay) replay(api, [op]);
    }, operation);
    operations.push(operation);
  };
  const currentErrors = () => page.evaluate(() => window.__wxa_test_api__?.errors() ?? []).catch(() => []);
  const forward = (name) => ((...args) => page.evaluate(([n, a]) => {
    const api = window.__wxa_test_api__;
    if (!api) throw new Error("\u5C0F\u7A0B\u5E8F\u8FD8\u6CA1\u6709\u6253\u5F00\uFF0C\u5148\u8C03\u7528 miniProgram.open()");
    return api[n](...a);
  }, [name, args]));
  const requests = async (pattern) => {
    const recorded = await page.evaluate((p) => {
      if (!window.__wxa_test_api__) throw new Error("\u5C0F\u7A0B\u5E8F\u8FD8\u6CA1\u6709\u6253\u5F00\uFF0C\u5148\u8C03\u7528 miniProgram.open()");
      return window.__wxa_playwright_requests__(p);
    }, pattern);
    return recorded.map(fromPage);
  };
  const miniProgram = {
    current: page.frameLocator("iframe[data-current]"),
    async open(url = "") {
      const queryStart = url.indexOf("?");
      const path3 = (queryStart < 0 ? url : url.slice(0, queryStart)).replace(/^\/+/, "").replace(/\.html$/, "");
      const query = queryStart < 0 ? "" : url.slice(queryStart + 1);
      const pages = path3 ? await listPages() : null;
      if (pages && !pages.includes(path3)) throw new Error(`\u9875\u9762 ${path3} \u4E0D\u5728 app.json \u7684 pages \u91CC`);
      earlierErrors.push(...await currentErrors());
      await windows?.closeAll();
      const search = [path3 && `path=${encodeURIComponent(path3)}`, query].filter(Boolean).join("&");
      await page.goto(`${baseURL}/${search ? `?${search}` : ""}`);
      await page.waitForFunction(() => window.__wxa_test_api__ || document.querySelector(".wxa-error"));
      const error = await page.evaluate(waitForLaunch);
      if (error !== null) throw new Error(`\u5C0F\u7A0B\u5E8F\u542F\u52A8\u5931\u8D25\uFF1A
${error}`);
    },
    async mock(api, impl) {
      if (typeof impl !== "function") return declare({ type: "mock", api, result: impl });
      if (api.endsWith("Sync") || SYNC_APIS.has(api)) {
        throw new Error(`wx.${api} \u7531\u57FA\u7840\u5E93\u540C\u6B65\u8C03\u7528\uFF0C\u53EA\u80FD mock \u6210\u56FA\u5B9A\u7684\u7ED3\u679C\u5BF9\u8C61\uFF1ANode \u91CC\u7684\u51FD\u6570\u53EA\u80FD\u5F02\u6B65\u8FD4\u56DE\u7ED3\u679C`);
      }
      const handler = addHandler(`mock('${api}')`, ([args, context]) => impl(args, context));
      return declare({ type: "mock", api, handler });
    },
    unmock: (api) => declare({ type: "unmock", api }),
    async route(pattern, handler) {
      if (typeof handler !== "function") return declare({ type: "route", pattern, response: encodeBinaryBody(handler) });
      const id = addHandler(`route('${pattern}')`, async ([request]) => encodeBinaryBody(await handler(fromPage({ ...request, routedBy: pattern }))));
      return declare({ type: "route", pattern, handler: id });
    },
    unroute: (pattern) => declare({ type: "unroute", pattern }),
    requests,
    async waitForRequest(pattern, { timeout = DEFAULT_REQUEST_TIMEOUT } = {}) {
      const deadline = Date.now() + timeout;
      for (; ; ) {
        const matched = await requests(pattern);
        if (matched.length) return matched[matched.length - 1];
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const sent = (await requests()).map((request) => `  ${request.method} ${request.url}`);
      throw new Error(`\u7B49\u5F85\u8BF7\u6C42 ${pattern} \u8D85\u65F6\uFF08${timeout}ms\uFF09\u3002\u5DF2\u53D1\u51FA\u7684\u8BF7\u6C42\uFF1A
${sent.join("\n") || "  \uFF08\u65E0\uFF09"}`);
    },
    errors: async () => [...earlierErrors, ...await currentErrors()],
    async webView({ index, timeout = DEFAULT_WEB_VIEW_TIMEOUT } = {}) {
      if (!windows) {
        throw new Error("webView() \u53EA\u5728\u65B0\u7A97\u53E3\u6A21\u5F0F\u4E0B\u53EF\u7528\uFF1Atest.use({ wxaWebView: 'window' })\u3002\u9ED8\u8BA4\u6A21\u5F0F\u4E0B\u7F51\u9875\u5728 miniProgram.current.frameLocator('iframe') \u91CC");
      }
      const deadline = Date.now() + timeout;
      for (; ; ) {
        const views = await miniProgram.webViews();
        if (views.length > 1 && index === void 0) {
          throw new Error(`\u5F53\u524D\u9875\u6709 ${views.length} \u4E2A web-view\uFF0C\u7528 webView({ index }) \u6307\u5B9A\u7B2C\u51E0\u4E2A\uFF08\u4ECE 0 \u5F00\u59CB\uFF09\uFF1A
${views.map((view, i) => `  ${i}: ${view.src}`).join("\n")}`);
        }
        if (index !== void 0 && views.length && (index < 0 || index >= views.length)) {
          throw new Error(`\u5F53\u524D\u9875\u53EA\u6709 ${views.length} \u4E2A web-view\uFF0Cindex \u5E94\u5728 0 \u5230 ${views.length - 1} \u4E4B\u95F4`);
        }
        const name = views[index ?? 0]?.windowName;
        const found = name ? windows.get(name) : void 0;
        if (found) return found;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `\u7B49\u5F85 web-view \u7684\u7F51\u9875\u7A97\u53E3\u8D85\u65F6\uFF08${timeout}ms\uFF09\u3002\u53EF\u80FD\u7684\u539F\u56E0\uFF1A
  - \u5F53\u524D\u9875\u6CA1\u6709 web-view\uFF0C\u6216 web-view \u8FD8\u6CA1\u6709\u8BBE\u7F6E src
  - \u5F39\u51FA\u7A97\u53E3\u88AB\u6D4F\u89C8\u5668\u62E6\u622A\uFF1APlaywright \u542F\u52A8\u6D4F\u89C8\u5668\u65F6\u9ED8\u8BA4\u5E26 --disable-popup-blocking\uFF0C\u914D\u7F6E\u91CC\u7528 ignoreDefaultArgs \u53BB\u6389\u4E86\u5B83
  - \u7F51\u9875\u7A97\u53E3\u5DF2\u88AB\u5173\u95ED`
      );
    },
    currentPage: forward("currentPage"),
    pageStack: forward("pageStack"),
    webViews: forward("webViews"),
    waitForPage: forward("waitForPage"),
    pageData: forward("pageData"),
    callPageMethod: forward("callPageMethod"),
    navigateTo: forward("navigateTo"),
    navigateBack: forward("navigateBack"),
    redirectTo: forward("redirectTo"),
    reLaunch: forward("reLaunch"),
    switchTab: forward("switchTab"),
    getStorage: forward("getStorage"),
    clearStorage: forward("clearStorage"),
    clearRequests: forward("clearRequests")
  };
  return {
    miniProgram,
    throwHandlerError() {
      if (!handlerErrors.length) return;
      const { source, error } = handlerErrors[0];
      const wrapped = new Error(`${source} \u7684\u5904\u7406\u51FD\u6570\u51FA\u9519\uFF1A${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) wrapped.stack = `${wrapped.message}
${error.stack.split("\n").slice(1).join("\n")}`;
      throw wrapped;
    }
  };
}

// src/server.ts
var import_path = __toESM(require("path"));
function devServerOptions(configDir, project, options) {
  const resolve = (file) => import_path.default.resolve(configDir, file);
  return {
    ...options,
    projectPath: resolve(project),
    setup: typeof options.setup === "string" ? resolve(options.setup) : options.setup,
    baseLibCacheDir: options.baseLibCacheDir && resolve(options.baseLibCacheDir),
    port: 0,
    watch: false,
    // 编译完成之类的日志每个 worker 都打一遍，只留警告和错误
    logger: { log: () => void 0, warn: console.warn, error: console.error }
  };
}

// src/index.ts
var ERRORS_HINT = "\u5C0F\u7A0B\u5E8F\u6709\u8FD0\u884C\u65F6\u9519\u8BEF\uFF0C\u6216\u8C03\u7528\u4E86\u672A\u5B9E\u73B0\u7684 wx API\uFF08\u7528\u5230\u7684\u8BF7 mock\uFF09\u3002\u6709\u610F\u89E6\u53D1\u9519\u8BEF\u7684\u7528\u4F8B\u53EF\u4EE5 test.use({ wxaCheckErrors: false })";
var test = import_test2.test.extend({
  wxaProject: [".", { scope: "worker", option: true }],
  wxaServerOptions: [{}, { scope: "worker", option: true }],
  wxaCheckErrors: [true, { option: true }],
  wxaWebView: ["iframe", { option: true }],
  // 配置文件 use 里的 launchOptions 照常传进来；用例文件里 test.use({ launchOptions }) 会整个替换掉这里，不再追加
  launchOptions: [async ({ launchOptions, browserName }, use) => {
    await use(browserName === "chromium" ? { ...launchOptions, args: withEagerSourcePositions(launchOptions.args) } : launchOptions);
  }, { scope: "worker" }],
  wxaServer: [async ({ wxaProject, wxaServerOptions }, use, workerInfo) => {
    const configDir = workerInfo.config.configFile ? import_path2.default.dirname(workerInfo.config.configFile) : process.cwd();
    const server = new import_wxa_runner_core.DevServer(devServerOptions(configDir, wxaProject, wxaServerOptions));
    await server.start();
    await use(server);
    await server.close();
  }, { scope: "worker", timeout: 6e4 }],
  miniProgram: async ({ page, wxaServer, wxaCheckErrors, wxaWebView }, use) => {
    const session = await createMiniProgram(page, {
      baseURL: wxaServer.url,
      listPages: () => wxaServer.builder.build().then((build) => build.pages, () => null),
      webViewWindow: wxaWebView === "window"
    });
    await use(session.miniProgram);
    session.throwHandlerError();
    if (wxaCheckErrors) (0, import_test2.expect)(await session.miniProgram.errors(), ERRORS_HINT).toEqual([]);
  }
});
var expect = import_test2.expect.extend(miniProgramMatchers);
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  expect,
  test
});
//# sourceMappingURL=index.js.map