"use strict";
(() => {
  // src/runtime/consoleHook.ts
  function hookConsole(levels, report) {
    for (const level of levels) {
      const original = console[level];
      console[level] = function(...args) {
        original.apply(this, args);
        try {
          report(level, args);
        } catch {
        }
      };
    }
  }

  // src/runtime/syncScript.ts
  function readSync(url) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.send();
    if (xhr.status !== 200) throw new Error(`[wxa-runner] \u52A0\u8F7D ${url} \u5931\u8D25\uFF1A${xhr.status}`);
    return xhr.responseText;
  }
  function runScript(win, url, code) {
    const href = new URL(url, location.href).href;
    const sourceMap = url.startsWith("/__baselib__/") ? `
//# sourceMappingURL=${href}.map` : "";
    const script2 = win.document.createElement("script");
    script2.text = `${code}
//# sourceURL=${href}${sourceMap}`;
    win.document.head.appendChild(script2);
  }

  // src/runtime/context.ts
  var MAIN_CONTEXT_ID = 1;
  var APP_CONTEXT_NAME = "app";
  var APP_SERVICE_ENTRY = "app-service.js";
  var BOOT_TIMEOUT = 1e4;
  function installWeixinJSContext(main, host2, options) {
    const contexts = new JsContexts(main, host2, options);
    main.WeixinJSContext = contexts.nativeInterface;
    main.__wxaContexts = {
      prepare: (id, win) => contexts.prepare(id, win),
      loaded: (id) => contexts.loaded(id)
    };
  }
  function installSingleContextLibLoader(service) {
    service.WeixinJSContext = { loadLibFiles: () => 1 };
  }
  var JsContexts = class {
    constructor(main, host2, options) {
      this.main = main;
      this.host = host2;
      this.options = options;
      this.contexts = /* @__PURE__ */ new Map();
      this.nextId = MAIN_CONTEXT_ID + 1;
      /** 交给基础库的原生接口。基础库会把方法取下来单独调用，所以都不依赖 this */
      this.nativeInterface = {
        mainContextId: MAIN_CONTEXT_ID,
        alloc: (name, callback) => this.open(name, false).whenReady(callback).id,
        allocEmpty: (name, callback) => this.open(name, true).whenReady(callback).id,
        create: (entry, name, callback) => {
          const context = this.open(name, false);
          context.whenReady(entry ? () => this.evaluate(context, entry, callback) : callback);
          return context.id;
        },
        evaluateScriptFile: (id, file, callback) => this.withContext(id, (context) => this.evaluate(context, file, callback)),
        loadJsFiles: (id, files, callback) => this.withContext(id, (context) => this.evaluateAll(context, JSON.parse(files), callback)),
        /** 基础库自己的文件（如 WARenderContext.js），同步执行 */
        loadLibFiles: (id, files) => this.withContext(id, (context) => {
          context.runSync(JSON.parse(files).map((file) => `/__baselib__/${file}`));
          return 1;
        }),
        destroy: (id, callback) => this.destroy(id, callback)
      };
      this.boot = new AppBoot(host2);
      this.mainContext = new JsContext(MAIN_CONTEXT_ID, "main", main);
      this.contexts.set(MAIN_CONTEXT_ID, this.mainContext);
    }
    /** 子上下文页面开始执行，基础库之前：交给它基础库需要的全局变量 */
    prepare(id, win) {
      const context = this.contexts.get(id);
      if (!context || context === this.mainContext) throw new Error(`[wxa-runner] \u672A\u77E5\u7684\u5B50\u4E0A\u4E0B\u6587 ${id}`);
      context.win = win;
      Object.assign(win, { WeixinJSContext: this.nativeInterface, WeixinJSContextId: id, __wxConfig: this.main.__wxConfig });
      if (context.isApp) this.host.registerAppContext(win);
    }
    /** 子上下文页面执行完（基础库已初始化） */
    loaded(id) {
      const context = this.contexts.get(id);
      if (!context) return;
      context.markReady();
      if (context.isApp) {
        this.boot.reach("entry");
        this.options.dispatchNative("onSubPackageReady", { moduleName: "__APP__" });
      }
    }
    open(name, empty) {
      const context = openSubContext(this.main, this.nextId++, name, empty);
      this.contexts.set(context.id, context);
      if (context.isApp) this.boot.reach("load");
      return context;
    }
    /** 原生接口的结果码：1 成功，0 失败 */
    withContext(id, action) {
      const context = this.contexts.get(Number(id));
      if (context) return action(context);
      console.warn(`[wxa-runner] \u627E\u4E0D\u5230 JS \u4E0A\u4E0B\u6587 ${id}`);
      return 0;
    }
    /** 执行基础库要求的脚本文件：带回调时等上下文加载完再异步执行，否则同步执行 */
    evaluate(context, file, done) {
      if (!context.isApp || file.replace(/^\/+/, "") !== APP_SERVICE_ENTRY) {
        console.warn(`[wxa-runner] \u57FA\u7840\u5E93\u8981\u6C42\u6267\u884C\u672A\u77E5\u811A\u672C ${file}`);
        return 0;
      }
      const urls = this.options.appServiceScripts;
      if (done) {
        context.whenReady(() => {
          this.startApp(context);
          loadScripts(context.win, urls, () => {
            done();
            this.boot.finish();
          });
        });
      } else {
        this.startApp(context);
        context.runSync(urls);
        this.boot.finish();
      }
      return 1;
    }
    startApp(context) {
      this.boot.reach("run");
      if (this.options.hot) context.win.__virtualDOM__?.enableUpdateWxAppCode?.();
    }
    evaluateAll(context, files, done) {
      if (!done) return files.every((file) => this.evaluate(context, file) === 1) ? 1 : 0;
      let remaining = files.length;
      if (remaining === 0) done();
      for (const file of files) {
        if (this.evaluate(context, file, () => --remaining === 0 && done()) === 0) return 0;
      }
      return 1;
    }
    destroy(id, callback) {
      const context = this.contexts.get(Number(id));
      if (!context || context === this.mainContext) return;
      this.contexts.delete(context.id);
      context.destroy();
      if (context.isApp) this.host.registerAppContext(null);
      callback?.();
    }
  };
  var JsContext = class {
    constructor(id, name, win, iframe) {
      this.id = id;
      this.name = name;
      this.win = win;
      this.iframe = iframe;
      this.pending = win ? null : [];
    }
    get isApp() {
      return this.name === APP_CONTEXT_NAME;
    }
    /** 加载完后执行，已加载完时立即执行 */
    whenReady(task) {
      if (task) {
        if (this.pending) this.pending.push(task);
        else task();
      }
      return this;
    }
    markReady() {
      const tasks = this.pending || [];
      this.pending = null;
      tasks.forEach((task) => task());
    }
    runSync(urls) {
      if (this.pending) throw new Error(`[wxa-runner] JS \u4E0A\u4E0B\u6587 ${this.id} \u5C1A\u672A\u52A0\u8F7D\u5B8C\uFF0C\u4E0D\u80FD\u540C\u6B65\u6267\u884C\u811A\u672C`);
      for (const url of urls) runScript(this.win, url, readSync(url));
    }
    destroy() {
      this.pending = [];
      this.iframe?.remove();
    }
  };
  function openSubContext(main, id, name, empty) {
    const iframe = main.document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = `/__wxa__/subcontext.html?id=${id}${empty ? "&empty=1" : ""}`;
    main.document.documentElement.appendChild(iframe);
    return new JsContext(id, name || `context${id}`, null, iframe);
  }
  var BOOT_STAGES = {
    alloc: `\u57FA\u7840\u5E93\u6CA1\u6709\u521B\u5EFA\u4E1A\u52A1\u5B50\u4E0A\u4E0B\u6587\uFF08\u540D\u4E3A ${APP_CONTEXT_NAME} \u7684\u5B50\u4E0A\u4E0B\u6587\uFF09`,
    load: "\u4E1A\u52A1\u5B50\u4E0A\u4E0B\u6587\u6CA1\u6709\u52A0\u8F7D\u5B8C\uFF08WASubContext.js \u52A0\u8F7D\u6216\u6267\u884C\u51FA\u9519\uFF09",
    entry: `\u57FA\u7840\u5E93\u6CA1\u6709\u6267\u884C\u4E1A\u52A1\u4EE3\u7801\u5165\u53E3 ${APP_SERVICE_ENTRY}`,
    run: "\u4E1A\u52A1\u4EE3\u7801\u6CA1\u6709\u52A0\u8F7D\u5B8C"
  };
  var AppBoot = class {
    constructor(host2) {
      this.host = host2;
      this.stage = "alloc";
      this.finished = false;
      this.timer = setTimeout(() => {
        this.finish(new Error(`[wxa-runner] \u903B\u8F91\u5C42 ${BOOT_TIMEOUT}ms \u5185\u6CA1\u6709\u5C31\u7EEA\uFF1A${BOOT_STAGES[this.stage]}`));
      }, BOOT_TIMEOUT);
    }
    reach(stage) {
      this.stage = stage;
    }
    /** 通知宿主逻辑层就绪，只通知一次；出错时先报告错误 */
    finish(error) {
      if (this.finished) return;
      this.finished = true;
      clearTimeout(this.timer);
      if (error) {
        console.error(error.message);
        this.host.reportError("service", 0, error);
      }
      this.host.frameLoaded("service", 0);
    }
  };
  function loadScripts(win, urls, done) {
    let remaining = urls.length;
    if (remaining === 0) {
      done();
      return;
    }
    for (const url of urls) {
      const script2 = win.document.createElement("script");
      script2.async = false;
      script2.src = url;
      const settle = () => {
        if (--remaining === 0) done();
      };
      script2.onload = settle;
      script2.onerror = () => {
        console.error(`[wxa-runner] \u52A0\u8F7D ${url} \u5931\u8D25`);
        settle();
      };
      win.document.head.appendChild(script2);
    }
  }

  // src/runtime/fileSession.ts
  var KEY = "__wxa_file_session__";
  function fileSession() {
    let session = localStorage.getItem(KEY);
    if (!session) {
      session = crypto.randomUUID();
      localStorage.setItem(KEY, session);
    }
    return session;
  }

  // src/runtime/networkPanel.ts
  var PROXY_PREFIX = "/__wxa__/proxy/";
  function toServerPath(prefix, url) {
    let target;
    try {
      target = new URL(url);
    } catch {
      return null;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    return `${prefix}${target.protocol.slice(0, -1)}/${target.host}${target.pathname}${target.search}`;
  }

  // src/runtime/sdkStubs.ts
  var UNSUPPORTED = "\u6D4F\u89C8\u5668\u8FD0\u884C\u65F6\u4E0D\u652F\u6301\u5E7F\u544A";
  function rejected(reason) {
    const promise = Promise.reject(reason);
    promise.catch(() => void 0);
    return promise;
  }
  var StubAd = class {
    constructor(hideable) {
      this.hideable = hideable;
      this.listeners = {};
    }
    load() {
      return this.fail();
    }
    show() {
      return this.fail();
    }
    destroy() {
      this.listeners = {};
    }
    onLoad(callback) {
      this.add("load", callback);
    }
    offLoad(callback) {
      this.remove("load", callback);
    }
    onError(callback) {
      this.add("error", callback);
    }
    offError(callback) {
      this.remove("error", callback);
    }
    onClose(callback) {
      this.add("close", callback);
    }
    offClose(callback) {
      this.remove("close", callback);
    }
    /** 只有原生模板广告（createCustomAd）有这组接口 */
    hide() {
      return this.hideable ? Promise.resolve() : void 0;
    }
    isShow() {
      return this.hideable ? false : void 0;
    }
    onHide(callback) {
      if (this.hideable) this.add("hide", callback);
    }
    offHide(callback) {
      if (this.hideable) this.remove("hide", callback);
    }
    add(event, callback) {
      (this.listeners[event] = this.listeners[event] || []).push(callback);
    }
    remove(event, callback) {
      if (!this.listeners[event]) return;
      this.listeners[event] = callback ? this.listeners[event].filter((l) => l !== callback) : [];
    }
    /** 真机上拉取失败也是先回调 onError 再 reject，这里保持一致 */
    fail() {
      const error = { errCode: 1e3, errMsg: UNSUPPORTED };
      queueMicrotask(() => {
        for (const listener of (this.listeners.error || []).slice()) listener({ ...error });
      });
      return rejected(error);
    }
  };
  var UNSUPPORTED_AD_APIS = [
    "createRewardedVideoAd",
    "createInterstitialAd",
    "createCustomAd",
    "createSkitAd"
  ];
  var STUB = /* @__PURE__ */ Symbol.for("wxa-runner.apiStub");
  var WARNED = /* @__PURE__ */ Symbol.for("wxa-runner.apiStubWarned");
  function installApiStubs(wx, options = {}) {
    const warn = options.warn || ((message) => console.warn(message));
    const replaced = [];
    for (const name of UNSUPPORTED_AD_APIS) {
      if (wx[name]?.[STUB]) continue;
      const stub = () => {
        if (!wx[WARNED]) {
          wx[WARNED] = true;
          warn("[wxa-runner] \u5E7F\u544A\uFF08WAAppAd.js\uFF09\u5728\u6D4F\u89C8\u5668\u8FD0\u884C\u65F6\u4E0D\u53EF\u7528\uFF0C\u5E7F\u544A\u5BF9\u8C61\u7684 load/show \u4F1A\u5931\u8D25\uFF0C\u4F46\u4E0D\u4F1A\u4E2D\u65AD\u9875\u9762");
        }
        return new StubAd(name === "createCustomAd");
      };
      stub[STUB] = true;
      try {
        Object.defineProperty(wx, name, { value: stub, writable: true, configurable: true, enumerable: true });
        replaced.push(name);
      } catch {
      }
    }
    return replaced;
  }
  var BUILT_IN_SDK_GLOBALS = /* @__PURE__ */ new Set(["__cloudSDKMain__"]);
  function guardSdkGlobals(global, before) {
    const guarded = [];
    for (const key of Object.getOwnPropertyNames(global)) {
      if (before.has(key) || BUILT_IN_SDK_GLOBALS.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(global, key);
      if (!descriptor?.get || !descriptor.configurable) continue;
      Object.defineProperty(global, key, { get: () => void 0, enumerable: descriptor.enumerable, configurable: true });
      guarded.push(key);
    }
    return guarded;
  }

  // src/runtime/workers.ts
  function createWeixinWorker(win, host2) {
    const g2 = win;
    const configured = !!g2.__wxConfig?.workers;
    const workers = /* @__PURE__ */ new Map();
    let nextId = 1;
    const send = (worker, message) => worker.postMessage(message);
    const reportError = (id, error) => {
      host2.reportError("service", 0, error);
      g2.WeixinWorker.workerMsgHandler(id, { __cmd__: "workerUncaughtError", __data__: error });
    };
    const invoke = (worker, allowed, { api, args, callbackId }) => {
      const reply = (result) => send(worker, { type: "callback", callbackId, result });
      if (!allowed.has(api)) reply({ errMsg: `${api}:fail not support` });
      else host2.invoke("service", win, api, args, reply);
    };
    return {
      /** 返回 Worker 的编号；没有配置 workers 时返回 -1，基础库报告 Worker 不存在 */
      create(_script, options = {}) {
        if (!configured) return -1;
        const id = nextId++;
        const url = `/__wxa__/worker.js?id=${id}&session=${fileSession()}`;
        const worker = new Worker(url);
        const allowed = new Set(options.APIList || []);
        worker.addEventListener("message", ({ data }) => {
          if (data.type === "message") g2.WeixinWorker.workerMsgHandler(id, data.data);
          else if (data.type === "invoke") invoke(worker, allowed, data);
          else reportError(id, { message: data.message, stack: data.stack });
        });
        worker.addEventListener("error", (event) => {
          event.preventDefault();
          reportError(id, { message: event.message || `[wxa-runner] Worker \u542F\u52A8\u5931\u8D25\uFF1A\u52A0\u8F7D ${url} \u5931\u8D25` });
        });
        workers.set(id, worker);
        return id;
      },
      /** 基础库内部的消息（如 setSharedBuffer、readCompressedFile 的结果）不序列化，直接给对象 */
      postMsgToWorker(id, message) {
        const worker = workers.get(id);
        if (worker) send(worker, { type: "message", data: typeof message === "string" ? JSON.parse(message) : message });
      },
      terminate(id) {
        workers.get(id)?.terminate();
        workers.delete(id);
      }
    };
  }

  // src/runtime/frame.ts
  var script = document.currentScript;
  var kind = script.dataset.kind || "webview";
  var webviewId = Number(script.dataset.webviewId || 0);
  var subContextId = Number(script.dataset.contextId || 0);
  var host = (subContextId ? window.parent.parent : window.parent).__wxaHost;
  var g = window;
  g.__global = g;
  if (!subContextId) g.__wxConfig.env.USER_DATA_PATH = `${location.origin}/__wxa__/usr/${fileSession()}`;
  if (kind === "service") {
    Object.assign(g, {
      __wxAppData: {},
      __wxRoute: void 0,
      __wxRouteBegin: void 0,
      __wxAppCode__: {},
      __wxAppCurrentFile__: void 0,
      __vd_version_info__: {},
      global: {},
      __workerVendorCode__: {},
      __workersCode__: {},
      // 创建 Worker 的基础库代码在逻辑层 iframe 里（3.8 起是主上下文），子上下文用不到
      WeixinWorker: subContextId ? {} : createWeixinWorker(window, host),
      $gwx: void 0
    });
    g.__WeixinWorker = g.WeixinWorker;
    delete g.MutationObserver;
    delete g.WebKitMutationObserver;
    g.__passWAServiceGlobal__ = (globals) => {
      for (const key of Object.keys(globals)) {
        if (key !== "Protect") g[key] = globals[key];
      }
    };
    const businessCodeHere = !subContextId && !script.dataset.appService;
    if (businessCodeHere) {
      const disableFunctionConstructor = reserveFunctionConstructor();
      const globalsBeforeBaseLib = new Set(Object.getOwnPropertyNames(g));
      hookRequire(() => {
        disableFunctionConstructor();
        guardSdkGlobals(g, globalsBeforeBaseLib);
      });
    } else {
      hookRequire();
    }
    g.createCustomImage = createCustomImage;
    moveCanvasesIntoPages();
  } else {
    emulateDeviceScreen(host.device);
    installInput();
    runLoadCallbacksEarly();
  }
  overrideUserAgent();
  window.addEventListener("error", (event) => host.reportError(kind, webviewId, event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => host.reportError(kind, webviewId, event.reason));
  hookConsole(host.forwardConsole === "all" ? ["warn", "error"] : ["error"], (level, args) => host.reportConsole(kind, webviewId, level, args));
  if (subContextId) {
    window.parent.__wxaContexts.prepare(subContextId, window);
  } else {
    const bridge = createBridge();
    g.WeixinJSBridge = bridge;
    g.__wxaBridge = bridge;
    if (script.dataset.appService) {
      installWeixinJSContext(window, host, {
        dispatchNative: bridge.__dispatchOn,
        appServiceScripts: JSON.parse(script.dataset.appService),
        hot: script.dataset.hot === "1"
      });
    } else if (kind === "service") {
      installSingleContextLibLoader(window);
    }
    host.registerFrame(kind, window, bridge, webviewId);
  }
  function reserveFunctionConstructor() {
    const native = Function;
    const disabled = function(...args) {
      if (args.length > 0 && args[args.length - 1] === "return this") return () => g;
    };
    disabled.prototype = native.prototype;
    let current = native;
    const reserve = (target, key) => Object.defineProperty(target, key, {
      get: () => current,
      set() {
      },
      enumerable: false,
      configurable: false
    });
    reserve(g, "Function");
    reserve(native.prototype, "constructor");
    return () => {
      current = disabled;
    };
  }
  function hookRequire(beforeBusinessCode) {
    let real;
    let businessCodeStarted = false;
    const wrapper = function(...args) {
      if (g.wx) installApiStubs(g.wx);
      if (!businessCodeStarted) {
        businessCodeStarted = true;
        beforeBusinessCode?.();
      }
      return real.apply(this, args);
    };
    try {
      Object.defineProperty(g, "require", {
        configurable: true,
        enumerable: true,
        get: () => typeof real === "function" ? wrapper : real,
        set: (value) => {
          real = value;
        }
      });
    } catch {
    }
  }
  function moveCanvasesIntoPages() {
    const { getContext } = HTMLCanvasElement.prototype;
    const { removeChild } = Node.prototype;
    const tried = /* @__PURE__ */ new WeakSet();
    HTMLCanvasElement.prototype.getContext = function(...args) {
      if (this.parentNode === document.body && !tried.has(this)) {
        tried.add(this);
        host.placeCanvas(this, String(args[0]));
      }
      return getContext.apply(this, args);
    };
    HTMLBodyElement.prototype.removeChild = function(child) {
      if (child.parentNode === this || !(child instanceof HTMLCanvasElement)) return removeChild.call(this, child);
      child.remove();
      return child;
    };
  }
  function createCustomImage(toUrl, fromUrl) {
    let url = "";
    return new class extends Image {
      set src(value) {
        url = toUrl(value);
        super.src = loadableImageUrl(url);
      }
      get src() {
        return fromUrl(url);
      }
    }();
  }
  function loadableImageUrl(url) {
    if (url.startsWith("/__pageframe__/")) return url.slice("/__pageframe__".length);
    if (/^https?:\/\//i.test(url) && !url.startsWith(location.origin + "/")) return toServerPath(PROXY_PREFIX, url) ?? url;
    return url;
  }
  function createBridge() {
    const onListeners = {};
    const subListeners = {};
    const add = (map, event, listener) => {
      (map[event] = map[event] || []).push(listener);
    };
    const remove = (map, event, listener) => {
      if (!map[event]) return;
      map[event] = listener ? map[event].filter((l) => l !== listener) : [];
    };
    const emit = (map, event, data, id) => {
      for (const listener of (map[event] || []).slice()) {
        try {
          listener(data, id);
        } catch (error) {
          console.error(`[wxa-runner] ${event} \u5904\u7406\u51FA\u9519`, error);
        }
      }
    };
    return {
      invoke(api, args, callback) {
        host.invoke(kind, window, api, args, callback);
      },
      publish(event, data, webviewIds) {
        host.publish(kind, window, event, data, webviewIds);
      },
      subscribe(event, listener) {
        add(subListeners, event, listener);
      },
      on(event, listener) {
        add(onListeners, event, listener);
      },
      addEventListener(event, listener) {
        add(onListeners, event, listener);
      },
      removeEventListener(event, listener) {
        remove(onListeners, event, listener);
      },
      addSubscribeListener(event, listener) {
        add(subListeners, event, listener);
      },
      removeSubscribeListener(event, listener) {
        remove(subListeners, event, listener);
      },
      __dispatchOn(event, data, id) {
        emit(onListeners, event, data, id);
      },
      __dispatchSub(event, data, id) {
        emit(subListeners, event, data, id);
      }
    };
  }
  function emulateDeviceScreen(device) {
    const values = {
      width: device.screenWidth,
      height: device.screenHeight,
      availWidth: device.screenWidth,
      availHeight: device.screenHeight
    };
    for (const key of Object.keys(values)) {
      try {
        Object.defineProperty(window.screen, key, { get: () => values[key], configurable: true });
      } catch {
      }
    }
    const portrait = {
      type: "portrait-primary",
      angle: 0,
      onchange: null,
      addEventListener() {
      },
      removeEventListener() {
      },
      dispatchEvent: () => false,
      lock: () => Promise.reject(new Error("not supported")),
      unlock() {
      }
    };
    try {
      Object.defineProperty(window.screen, "orientation", { get: () => portrait, configurable: true });
    } catch {
    }
    try {
      Object.defineProperty(window, "devicePixelRatio", { get: () => device.pixelRatio, configurable: true });
    } catch {
    }
  }
  function runLoadCallbacksEarly() {
    let owner = window;
    while (owner && !Object.getOwnPropertyDescriptor(owner, "onload")) owner = Object.getPrototypeOf(owner);
    const native = owner && Object.getOwnPropertyDescriptor(owner, "onload");
    if (!native?.get || !native.set) return;
    Object.defineProperty(window, "onload", {
      configurable: true,
      get: () => native.get.call(window),
      set(handler) {
        if (typeof handler === "function" && document.readyState !== "complete") {
          queueMicrotask(() => handler.call(window, new Event("load")));
        } else {
          native.set.call(window, handler);
        }
      }
    });
  }
  function overrideUserAgent() {
    const ua = `${navigator.userAgent} (iPhone; wxa-runner) MicroMessenger/8.0.50 miniProgram`;
    try {
      Object.defineProperty(navigator, "userAgent", { get: () => ua, configurable: true });
    } catch {
    }
  }
  function installInput() {
    const SCROLL_TAP_GUARD = 80;
    const TOUCH_SLOP = 8;
    let lastScroll = 0;
    let queue = Promise.resolve();
    let press = null;
    document.addEventListener("scroll", () => {
      lastScroll = Date.now();
    }, true);
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const fire = (type, event, eventTarget, afterDispatch) => {
      const point = {
        clientX: event.clientX,
        clientY: event.clientY,
        pageX: event.pageX,
        pageY: event.pageY,
        screenX: event.screenX,
        screenY: event.screenY
      };
      queue = queue.then(async () => {
        if (type === "touchstart") {
          await nextFrame();
          await nextFrame();
          const wait = lastScroll + SCROLL_TAP_GUARD - Date.now();
          if (wait > 0) await sleep(wait);
        }
        const touch = new Touch({ identifier: 1, target: eventTarget, ...point });
        const active = type === "touchend" ? [] : [touch];
        const passed = eventTarget.dispatchEvent(new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: active,
          targetTouches: active,
          changedTouches: [touch]
        }));
        afterDispatch?.(!passed);
      });
    };
    const move = (event, current) => {
      const dx = event.clientX - current.last.x;
      const dy = event.clientY - current.last.y;
      current.last = { x: event.clientX, y: event.clientY };
      fire("touchmove", event, current.target, (prevented) => {
        if (prevented || current.scroller === null) return;
        if (current.scroller === void 0) {
          current.scroller = findScroller(current.target, dx, dy);
          if (current.scroller && getComputedStyle(current.scroller).scrollSnapType !== "none") {
            current.snapType = current.scroller.style.scrollSnapType;
            current.scroller.style.scrollSnapType = "none";
          }
        }
        current.scroller?.scrollBy({
          left: userScrollable(current.scroller, "x") ? -dx : 0,
          top: userScrollable(current.scroller, "y") ? -dy : 0,
          behavior: "instant"
        });
      });
    };
    window.addEventListener("mousedown", (event) => {
      event.stopImmediatePropagation();
      if (event.button !== 0 || !event.target) return;
      const current = { target: event.target, start: { x: event.clientX, y: event.clientY }, last: { x: event.clientX, y: event.clientY } };
      press = current;
      fire("touchstart", event, current.target, (prevented) => {
        if (prevented) current.scroller = null;
      });
    }, true);
    window.addEventListener("mousemove", (event) => {
      event.stopImmediatePropagation();
      if (!press) return;
      if (press.start) {
        if (Math.hypot(event.clientX - press.start.x, event.clientY - press.start.y) < TOUCH_SLOP) return;
        press.start = null;
      }
      move(event, press);
    }, true);
    window.addEventListener("mouseup", (event) => {
      event.stopImmediatePropagation();
      if (!press) return;
      if (press.start && (event.clientX !== press.start.x || event.clientY !== press.start.y)) {
        move(event, press);
        queue = queue.then(nextFrame);
      }
      const current = press;
      fire("touchend", event, current.target, () => {
        if (!current.scroller || current.snapType === void 0) return;
        current.scroller.style.scrollSnapType = current.snapType;
        current.scroller.scrollTo({ left: current.scroller.scrollLeft, top: current.scroller.scrollTop, behavior: "smooth" });
      });
      press = null;
    }, true);
    window.addEventListener("dragstart", (event) => {
      if (press) event.preventDefault();
    }, true);
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      window.addEventListener(type, (event) => {
        if (event.pointerType !== "touch") event.stopImmediatePropagation();
      }, true);
    }
  }
  function findScroller(node, dx, dy) {
    const axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    const forward = (axis === "x" ? dx : dy) < 0;
    for (let el = node instanceof HTMLElement ? node : node instanceof Element ? node.parentElement : null; el; el = el.parentElement) {
      if (!userScrollable(el, axis)) continue;
      const [position, size, client] = axis === "x" ? [el.scrollLeft, el.scrollWidth, el.clientWidth] : [el.scrollTop, el.scrollHeight, el.clientHeight];
      if (forward ? position + client < size - 1 : position > 0) return el;
    }
    return null;
  }
  function userScrollable(el, axis) {
    const overflow = getComputedStyle(el)[axis === "x" ? "overflowX" : "overflowY"];
    const overflows = axis === "x" ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight;
    if (!overflows) return false;
    return el === document.scrollingElement ? overflow !== "hidden" && overflow !== "clip" : overflow === "auto" || overflow === "scroll";
  }
})();
//# sourceMappingURL=frame.js.map