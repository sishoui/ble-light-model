"use strict";
(() => {
  // src/runtime/host/frameErrors.ts
  var DEDUPE_MS = 1e3;
  var MINI_PROGRAM_ERROR = /^(\(in promise\) )?MiniProgramError\n/;
  var STACK_FRAME = /^\s*at /;
  function isErrorLike(value) {
    return typeof value === "object" && value !== null && typeof value.message === "string";
  }
  function caughtError(value) {
    if (isErrorLike(value) && MINI_PROGRAM_ERROR.test(value.message)) {
      const ownStack = typeof value.stack === "string" && /^[^\n]*MiniProgramError\n/.test(value.stack);
      return { message: value.message.replace(MINI_PROGRAM_ERROR, ""), stack: ownStack ? void 0 : value.stack };
    }
    if (typeof value === "string" && MINI_PROGRAM_ERROR.test(value)) {
      const text = value.replace(MINI_PROGRAM_ERROR, "");
      const firstFrame2 = text.search(/^\s*at /m);
      const head = (firstFrame2 < 0 ? text : text.slice(0, firstFrame2)).replace(/\n$/, "");
      const message = /^([\s\S]*)\n[^\n]*?: \1$/.exec(head)?.[1] ?? head;
      return { message, stack: firstFrame2 < 0 ? void 0 : text.slice(firstFrame2) };
    }
    return null;
  }
  var RecentErrors = class {
    constructor() {
      this.recent = /* @__PURE__ */ new Map();
    }
    /**
     * 比较栈里的各帧而不是整个栈：基础库打印成字符串时，栈开头的 `TypeError: …` 那行拆不出来。
     * 不同位置抛出的同名错误帧不同，各记各的
     */
    isRepeated(kind, webviewId, message, stack) {
      const frames = (stack || "").split("\n").filter((line) => STACK_FRAME.test(line)).map((line) => line.trim()).join("\n");
      const key = `${kind}:${webviewId}:${message}
${frames}`;
      const now = Date.now();
      for (const [recent, time] of this.recent) {
        if (now - time >= DEDUPE_MS) this.recent.delete(recent);
      }
      if (this.recent.has(key)) return true;
      this.recent.set(key, now);
      return false;
    }
  };

  // src/runtime/host/ConsoleForwarder.ts
  var MAX_ARG_LENGTH = 1e3;
  var MAX_TEXT_LENGTH = 8e3;
  var LAYERS = { service: "\u903B\u8F91\u5C42", webview: "\u6E32\u67D3\u5C42" };
  var MODULE_URL = /\bhttps?:\/\/[^/\s]+\/__wxa__\/module\/([^?\s)]+?)(?:\?[^:\s)]*)?:(\d+):(\d+)/;
  var ConsoleForwarder = class {
    /**
     * @param pageOf 出错的页面路径，不知道时返回 undefined
     * @param hintsOf 附在报错后面的提示，帮开发者认出 wxa-runner 和真机不同造成的错误
     */
    constructor(mode, send, pageOf, hintsOf = () => []) {
      this.mode = mode;
      this.send = send;
      this.pageOf = pageOf;
      this.hintsOf = hintsOf;
    }
    /** 运行时错误：全局 error、未处理的 Promise 拒绝、基础库捕获的业务代码错误。两路报来的同一个错误由宿主去重（见 frameErrors.ts） */
    error(kind, webviewId, message, stack) {
      if (!this.mode) return;
      const frames = businessFrames(stack);
      const hints = this.hintsOf(kind).map((hint) => `
  \u63D0\u793A\uFF1A${hint}`).join("");
      this.post("error", `${this.origin(kind, webviewId)}\u62A5\u9519\uFF1A${message}${frames ? `
${frames}` : ""}${hints}`);
    }
    /** 运行时自己的提醒，如调用了未实现的 wx API */
    warn(text) {
      if (this.mode) this.post("warn", text);
    }
    /** iframe 里的 console.warn / console.error；基础库捕获业务代码错误后打印的不经过这里，按报错转发 */
    console(kind, webviewId, level, args) {
      if (this.mode === "all") this.post(level, `${this.origin(kind, webviewId)} console.${level}\uFF1A${args.map(formatArg).join(" ")}`);
    }
    post(level, text) {
      this.send({ type: "console", level, text: text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}\u2026` : text });
    }
    origin(kind, webviewId) {
      const page = this.pageOf(kind, webviewId);
      return page ? `${LAYERS[kind]}\uFF08${page}\uFF09` : LAYERS[kind];
    }
  };
  function businessFrames(stack) {
    return (stack || "").split("\n").filter((line) => /^\s*at /.test(line) && MODULE_URL.test(line)).map((line) => `    ${line.trim().replace(MODULE_URL, "$1:$2:$3")}`).join("\n");
  }
  function formatArg(arg) {
    if (typeof arg === "string") return truncate(arg);
    if (isErrorLike(arg)) {
      const frames = businessFrames(arg.stack);
      return truncate(`${arg.name || "Error"}: ${arg.message}`) + (frames ? `
${frames}` : "");
    }
    try {
      const json = JSON.stringify(arg);
      if (json !== void 0) return truncate(json);
    } catch {
    }
    return truncate(String(arg));
  }
  function truncate(text) {
    return text.length > MAX_ARG_LENGTH ? `${text.slice(0, MAX_ARG_LENGTH)}\u2026` : text;
  }

  // src/runtime/host/api/registry.ts
  var SILENT_APIS = /* @__PURE__ */ new Set([
    "reportKeyValue",
    "reportIDKey",
    "reportRealtimeAction",
    "reportPerformance",
    "systemLog",
    "traceEvent",
    "getPermissionBytes",
    "initRenderDone",
    "saveInitialRenderingCache",
    "setKeyValue",
    "invokeMiniProgramAPI",
    "updatePerfData",
    "reportSubmitForm",
    "initReady",
    "noticePerformanceMetrics"
  ]);
  var ApiRegistry = class {
    /** @param onUnimplemented 调用了没有实现、也没有 mock 的 API 时触发，每次调用都触发；基础库内部的上报类接口不触发 */
    constructor(onUnimplemented) {
      this.onUnimplemented = onUnimplemented;
      this.handlers = /* @__PURE__ */ new Map();
      this.mocks = /* @__PURE__ */ new Map();
      this.warned = /* @__PURE__ */ new Set();
    }
    register(handlers) {
      for (const [name, handler] of Object.entries(handlers)) {
        this.handlers.set(name, handler);
      }
    }
    has(api) {
      return this.handlers.has(api) || this.mocks.has(api);
    }
    /** 测试用：覆盖某个 API；传入对象时直接作为结果返回 */
    mock(api, impl) {
      this.mocks.set(api, typeof impl === "function" ? impl : () => impl);
    }
    unmock(api) {
      if (api) this.mocks.delete(api);
      else this.mocks.clear();
    }
    invoke(api, args, context) {
      const handler = this.mocks.get(api) || this.handlers.get(api);
      if (!handler) {
        if (!SILENT_APIS.has(api)) {
          this.onUnimplemented?.(context);
          if (!this.warned.has(api)) {
            this.warned.add(api);
            console.warn(`[wxa-runner] wx.${api} \u5C1A\u672A\u5B9E\u73B0\uFF0C\u8FD4\u56DE\u9ED8\u8BA4\u6210\u529F`, args);
          }
        }
        return { errMsg: `${api}:ok` };
      }
      try {
        const result = handler(args || {}, context);
        if (result && typeof result.then === "function") {
          return result.then(
            (value) => normalize(api, value),
            (error) => failure(api, error)
          );
        }
        return normalize(api, result);
      } catch (error) {
        return failure(api, error);
      }
    }
  };
  function ok(api, extra = {}) {
    return { ...extra, errMsg: `${api}:ok` };
  }
  function fail(api, reason2, extra = {}) {
    return { ...extra, errMsg: `${api}:fail ${reason2}` };
  }
  function normalize(api, result) {
    if (typeof result === "string") return result;
    if (!result) return { errMsg: `${api}:ok` };
    return result.errMsg ? result : { ...result, errMsg: `${api}:ok` };
  }
  function failure(api, error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errMsg: `${api}:fail ${message}` };
  }

  // src/runtime/host/api/audio.ts
  var STATES = {
    canplay: "canplay",
    playing: "play",
    ended: "ended",
    waiting: "waiting",
    seeking: "seeking",
    seeked: "seeked"
  };
  var HAVE_METADATA = 1;
  var ERROR_CODES = { 2: 10002, 3: 10004, 4: 10004 };
  var audioSeq = 0;
  function createAudioApis(options) {
    const { emit, createAudio = () => new Audio() } = options;
    const instances = /* @__PURE__ */ new Map();
    const createAudioInstance = (_args, { api }) => {
      const audioId = ++audioSeq;
      const audio = createAudio();
      const listening = new AbortController();
      const instance = {
        audio,
        src: "",
        startTime: 0,
        played: false,
        stopped: false,
        report: (state, extra) => emit("onAudioStateChange", { audioId, state, ...extra }),
        destroy: () => {
          listening.abort();
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
      };
      const on = (type, listener) => audio.addEventListener(type, listener, { signal: listening.signal });
      for (const [type, state] of Object.entries(STATES)) {
        on(type, () => {
          if (!instance.stopped) instance.report(state);
        });
      }
      on("loadedmetadata", () => {
        if (!instance.played && instance.startTime > 0) audio.currentTime = instance.startTime / 1e3;
      });
      on("error", () => {
        const code = audio.error?.code ?? 0;
        instance.report("error", { errCode: ERROR_CODES[code] ?? -1, errMsg: audio.error?.message || `MediaError ${code}` });
      });
      instances.set(audioId, instance);
      return ok(api, { audioId });
    };
    const withInstance = (args, api, action) => {
      const instance = instances.get(args.audioId);
      return instance ? ok(api, action(instance) || {}) : fail(api, `audio instance ${args.audioId} not found`);
    };
    return {
      createAudioInstance,
      createAudioInstanceAsync: createAudioInstance,
      // 状态里的 paused、currentTime 等是基础库缓存的旧值，只取能设置的属性
      setAudioState: (args, { api }) => withInstance(args, api, (instance) => {
        const { audio } = instance;
        if (typeof args.autoplay === "boolean") audio.autoplay = args.autoplay;
        if (typeof args.loop === "boolean") audio.loop = args.loop;
        if (typeof args.volume === "number") audio.volume = args.volume;
        if (typeof args.playbackRate === "number") audio.playbackRate = args.playbackRate;
        if (typeof args.src === "string" && args.src !== instance.src) {
          Object.assign(instance, { src: args.src, played: false, stopped: false });
          audio.src = args.src;
        }
        if (typeof args.startTime === "number" && args.startTime !== instance.startTime) {
          instance.startTime = args.startTime;
          if (!instance.played && audio.readyState >= HAVE_METADATA) audio.currentTime = args.startTime / 1e3;
        }
      }),
      getAudioState: (args, { api }) => withInstance(args, api, ({ audio, src, startTime }) => ({
        src,
        startTime,
        paused: audio.paused,
        currentTime: Math.round(audio.currentTime * 1e3),
        duration: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1e3) : 0,
        buffered: audio.buffered.length ? Math.round(audio.buffered.end(audio.buffered.length - 1) * 1e3) : 0,
        volume: audio.volume,
        autoplay: audio.autoplay,
        loop: audio.loop,
        playbackRate: audio.playbackRate
      })),
      operateAudio: (args, { api }) => withInstance(args, api, (instance) => {
        const { audio } = instance;
        switch (args.operationType) {
          case "play":
            Object.assign(instance, { played: true, stopped: false });
            audio.play().catch((error) => {
              if (error.name === "NotAllowedError") instance.report("error", { errCode: -1, errMsg: `${error.name}: ${error.message}` });
            });
            break;
          // 浏览器的 pause 事件不转发：它在 stop 之后才异步派发，播到结尾时也会先派发一次
          case "pause":
            if (!audio.paused) instance.report("pause");
            audio.pause();
            break;
          case "stop":
            instance.stopped = true;
            audio.pause();
            audio.currentTime = 0;
            instance.report("stop");
            break;
          case "seek":
            instance.stopped = false;
            audio.currentTime = Number(args.currentTime) / 1e3;
            break;
          default:
            throw new Error(`unknown operationType ${args.operationType}`);
        }
      }),
      destroyAudioInstance: (args, { api }) => {
        instances.get(args.audioId)?.destroy();
        instances.delete(args.audioId);
        return ok(api);
      }
    };
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

  // src/runtime/host/api/fs.ts
  function requestFile(operation, args, sync) {
    const url = "/__wxa__/fs/" + fileSession();
    const body = JSON.stringify({ operation, args });
    if (!sync)
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      }).then(async (response) => fileResult(response.status, await response.text()));
    const request = new XMLHttpRequest();
    request.open("POST", url, false);
    request.setRequestHeader("content-type", "application/json");
    request.send(body);
    return fileResult(request.status, request.responseText);
  }
  function fileResult(status, text) {
    if (status !== 200) throw new Error(`filesystem HTTP ${status}`);
    const { result, error } = JSON.parse(text);
    if (error) throw new Error(error);
    return result;
  }
  function createFileSystemApis(request = requestFile) {
    const apis = {};
    for (const operation of [
      "access",
      "stat",
      "mkdir",
      "writeFile",
      "appendFile",
      "readdir",
      "unlink",
      "rmdir",
      "getFileInfo",
      "copyFile",
      "rename",
      "readFile"
    ]) {
      const handler = (args, { api }) => {
        try {
          const input = { ...args };
          const isBuffer = Object.prototype.toString.call(input.data) === "[object ArrayBuffer]";
          if (isBuffer || ArrayBuffer.isView(input.data)) {
            const view = isBuffer ? new Uint8Array(input.data) : new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength);
            let binary = "";
            for (let offset = 0; offset < view.length; offset += 32768) {
              binary += String.fromCharCode(...view.subarray(offset, offset + 32768));
            }
            input.data = btoa(binary);
            input.binary = true;
          }
          const decode = (result2) => {
            if (result2.binary) {
              result2.data = Uint8Array.from(atob(result2.data), (character) => character.charCodeAt(0)).buffer;
              delete result2.binary;
            }
            return ok(api, result2);
          };
          const result = request(operation, input, api.endsWith("Sync"));
          return result instanceof Promise ? result.then(decode, (error) => fail(api, error.message)) : decode(result);
        } catch (error) {
          return fail(api, error.message);
        }
      };
      apis[operation] = handler;
      apis[operation + "Sync"] = handler;
      apis["fs_" + operation] = handler;
      apis["fs_" + operation + "Sync"] = handler;
    }
    const readUserFile = apis.readFile;
    apis.readFile = (args, context) => /^[a-z]+:\/\//i.test(String(args.filePath)) || /^\/__wxa__\/(tmp|usr)\//.test(String(args.filePath)) ? readUserFile(args, context) : readPackageFile(args.filePath, args.encoding).then(
      (data) => ok(context.api, { data }),
      (error) => fail(context.api, error.message)
    );
    apis.fs_readFile = apis.readFile;
    return apis;
  }
  async function readPackageFile(filePath, encoding) {
    if (encoding !== void 0 && encoding !== "utf8" && encoding !== "utf-8") {
      throw new Error(`\u8BFB\u53D6\u4EE3\u7801\u5305\u91CC\u7684\u6587\u4EF6\u53EA\u652F\u6301 utf8 \u7F16\u7801\uFF0C\u6216\u4E0D\u6307\u5B9A\u7F16\u7801\u5F97\u5230 ArrayBuffer\uFF0C\u4E0D\u652F\u6301 ${encoding}`);
    }
    const parts = [];
    for (const part of String(filePath).split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    const response = await fetch("/" + parts.map(encodeURIComponent).join("/"));
    if (!response.ok) throw new Error(`no such file or directory, open ${filePath}`);
    return encoding ? response.text() : response.arrayBuffer();
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
    const script = win.document.createElement("script");
    script.text = `${code}
//# sourceURL=${href}${sourceMap}`;
    win.document.head.appendChild(script);
  }

  // src/runtime/host/api/libFiles.ts
  function createLibFileApis(options) {
    const loadLibFiles = (args, { api, from, webviewId }) => {
      const win = from === "webview" ? options.windowOf(webviewId) : null;
      if (!win) return ok(api);
      const codes = args.paths.map((file) => {
        const url = `/__baselib__/${file}`;
        const code = readSync(url);
        if (file.endsWith(".js")) runScript(win, url, code);
        return code;
      });
      return ok(api, { __codes: codes });
    };
    return { loadLibFiles, loadLibFilesSync: loadLibFiles };
  }

  // src/runtime/host/api/map.ts
  function createMapApis({ registry, operations }) {
    return {
      private_geolocation: async (_args, context) => {
        const location2 = await registry.invoke("getLocation", { type: "gcj02" }, { ...context, api: "getLocation" });
        if (location2.errMsg !== "getLocation:ok") return JSON.stringify({ message: location2.errMsg });
        return JSON.stringify({ result: { location: { lat: location2.latitude, lng: location2.longitude } } });
      },
      // 开发者工具上没有原生地图，照基础库的格式转给当前页的 map 组件
      moveToMapLocation: (args, { webviewId }) => operations.send(webviewId, { ...args, method: "moveToMapLocation" })
    };
  }
  var MapOperations = class {
    /** @param publish 发给渲染层，渲染层的 WeixinJSBridge.subscribe 收到 */
    constructor(publish) {
      this.publish = publish;
      this.pending = /* @__PURE__ */ new Map();
      this.seq = 0;
    }
    /** map 组件做完才返回；页面上没有这个 map 时一直不返回，同基础库自己发的操作 */
    send(webviewId, operation) {
      const callbackId = `wxa_${++this.seq}`;
      return new Promise((resolve) => {
        this.pending.set(callbackId, resolve);
        this.publish(webviewId, "operateMap", { data: { ...operation, callbackId }, options: { timestamp: Date.now() } });
      });
    }
    /** map 组件发回的 operateMapCallback：是宿主发的操作时收下并返回 true，不再交给逻辑层 */
    receive(message) {
      const reply = message?.data;
      const resolve = this.pending.get(reply?.callbackId);
      if (!resolve) return false;
      this.pending.delete(reply.callbackId);
      resolve({ errMsg: reply.errMsg });
      return true;
    }
  };

  // src/runtime/host/api/tempFiles.ts
  var TEMP_DIR = "/__wxa__/tmp";
  async function saveTempFile(data, type) {
    const res = await fetch(`${TEMP_DIR}/${fileSession()}?type=${encodeURIComponent(type)}`, { method: "POST", body: data });
    if (!res.ok) throw new Error(await res.text());
    const { url } = await res.json();
    return url;
  }
  function tempFileRootPath(url) {
    const prefix = `${location.origin}${TEMP_DIR}/`;
    return url.startsWith(prefix) ? url.slice(location.origin.length) : url;
  }
  function tempFileType(name, mimeType, fallback) {
    const fromName = /\.([a-z\d]+)$/i.exec(name)?.[1];
    const fromType = /^[a-z]+\/([a-z\d]+)\s*(;|$)/i.exec(mimeType)?.[1];
    return (fromName || fromType || fallback).toLowerCase();
  }
  function isTempFile(filePath) {
    return typeof filePath === "string" && filePath.startsWith(`${location.origin}${TEMP_DIR}/`);
  }
  async function tempFileSize(url) {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok ? Number(res.headers.get("content-length")) : null;
  }
  async function removeTempFile(url) {
    await fetch(url, { method: "DELETE" });
  }

  // src/runtime/host/api/media.ts
  var SOURCES = ["camera", "album"];
  var SOURCE_LABELS = { camera: "\u62CD\u6444", album: "\u4ECE\u624B\u673A\u76F8\u518C\u9009\u62E9" };
  var DEFAULT_COUNT = 9;
  var MEDIA_KINDS = ["image", "video"];
  var FIRST_FRAME_TIMEOUT = 1e3;
  var countOf = (args) => Math.max(1, Number(args.count) || DEFAULT_COUNT);
  function createMediaApis({ showActionSheet, chooseFiles: chooseFiles2, hasUserActivation: hasUserActivation2, showImagePreview }) {
    async function pickFiles(args, accept) {
      const allowed = SOURCES.filter((source2) => args.sourceType?.includes(source2));
      const sources = allowed.length ? allowed : SOURCES;
      let source = sources[0];
      if (sources.length > 1 || !hasUserActivation2()) {
        const index = await showActionSheet({ itemList: sources.map((item) => SOURCE_LABELS[item]) });
        if (index === null) return null;
        source = sources[index];
      }
      return chooseFiles2({ accept, multiple: countOf(args) > 1, capture: source === "camera" });
    }
    const saveImage = (file) => saveTempFile(file, tempFileType(file.name, file.type, "jpg"));
    return {
      chooseImage: async (args, { api }) => {
        const files = (await pickFiles(args, "image/*"))?.slice(0, countOf(args));
        if (!files) return fail(api, "cancel");
        const paths = await Promise.all(files.map(saveImage));
        return ok(api, { tempFilePaths: paths, tempFiles: files.map((file, i) => ({ path: paths[i], size: file.size })) });
      },
      chooseMedia: async (args, { api }) => {
        const mediaType = args.mediaType?.length ? args.mediaType : MEDIA_KINDS;
        const mix = mediaType.includes("mix");
        const requested = MEDIA_KINDS.filter((kind) => mix || mediaType.includes(kind));
        const kinds = requested.length ? requested : MEDIA_KINDS;
        const picked = await pickFiles(args, kinds.map((kind) => `${kind}/*`).join(","));
        if (!picked) return fail(api, "cancel");
        const kindOf = (file) => kinds.length === 1 ? kinds[0] : file.type.startsWith("video/") ? "video" : "image";
        const videos = picked.filter((file) => kindOf(file) === "video");
        const files = (mix || !videos.length ? picked : videos).slice(0, countOf(args));
        const tempFiles = await Promise.all(files.map(async (file) => kindOf(file) === "video" ? { ...await saveVideo(file), fileType: "video" } : { tempFilePath: await saveImage(file), size: file.size, fileType: "image" }));
        return ok(api, { type: mix ? "mix" : tempFiles[0].fileType, tempFiles });
      },
      chooseVideo: async (args, { api }) => {
        const file = (await pickFiles({ sourceType: args.sourceType, count: 1 }, "video/*"))?.[0];
        if (!file) return fail(api, "cancel");
        return ok(api, await saveVideo(file));
      },
      // 基础库已经把 current 换成了 urls 里的地址；也兼容直接传下标
      previewImage: (args) => {
        const urls = (args.urls || []).map(String);
        if (!urls.length) return;
        const current = typeof args.current === "number" ? args.current : urls.indexOf(args.current);
        showImagePreview(urls, Math.max(current, 0));
      },
      // 网络图片基础库已先下载成本地地址，包内图片已换成相对小程序根目录的路径
      getImageInfo: async (args) => {
        const src = String(args.src || "");
        const blob = await fetchFile(src);
        const bitmap = await createImageBitmap(blob);
        const info = { width: bitmap.width, height: bitmap.height, type: imageType(blob), orientation: "up" };
        bitmap.close();
        return info;
      },
      // 浏览器没有相册，保存到相册就是下载这张图片
      saveImageToPhotosAlbum: async (args) => {
        const filePath = String(args.filePath || "");
        const link = document.createElement("a");
        link.href = URL.createObjectURL(await fetchFile(filePath));
        link.download = filePath.split(/[?#]/)[0].split("/").pop() || "image";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 6e4);
      }
    };
  }
  async function saveVideo(file) {
    const [tempFilePath, { duration, width, height, thumb }] = await Promise.all([
      saveTempFile(file, tempFileType(file.name, file.type, "mp4")),
      readVideo(file)
    ]);
    const thumbTempFilePath = thumb ? await saveTempFile(thumb, "jpg") : "";
    return { tempFilePath, size: file.size, duration, height, width, thumbTempFilePath };
  }
  async function readVideo(file) {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
        video.addEventListener("error", reject, { once: true });
      });
      const { videoWidth: width, videoHeight: height } = video;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      return { duration, width, height, thumb: width && height ? await firstFrame(video) : null };
    } catch {
      return { duration: 0, width: 0, height: 0, thumb: null };
    } finally {
      URL.revokeObjectURL(video.src);
    }
  }
  async function firstFrame(video) {
    const loaded = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || await Promise.race([
      new Promise((resolve) => video.addEventListener("loadeddata", () => resolve(true), { once: true })),
      new Promise((resolve) => setTimeout(() => resolve(false), FIRST_FRAME_TIMEOUT))
    ]);
    if (!loaded) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg"));
  }
  async function fetchFile(path) {
    const url = /^[a-z][a-z\d+.-]*:/i.test(path) ? path : "/" + path.replace(/^\//, "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`file not exist ${path}`);
    return res.blob();
  }
  function imageType(blob) {
    return /^image\/([a-z\d]+)/i.exec(blob.type)?.[1].toLowerCase() || "unknown";
  }

  // src/runtime/host/api/misc.ts
  var SERVICE_MARKET = "webapi_servicemarket_jsapi_comm";
  var CLOUD = "qbase_commapi";
  function createMiscApis(appid, options) {
    const viaDevtools = async (api, url, json) => {
      try {
        return await postDevServer(url, json);
      } catch (error) {
        options?.onDevtoolsLoginFail?.(api, error.message);
        throw error;
      }
    };
    let cloudWarned = false;
    const cloudUnavailable = (api, operation) => {
      if (!cloudWarned) {
        cloudWarned = true;
        console.warn("[wxa-runner] \u4E91\u5F00\u53D1\uFF08wx.cloud\uFF09\u5728\u6D4F\u89C8\u5668\u8FD0\u884C\u65F6\u4E0D\u53EF\u7528\uFF0C\u8C03\u7528\u4F1A\u5931\u8D25");
      }
      return fail(api, `wxa-runner \u4E0D\u652F\u6301\u4E91\u5F00\u53D1\uFF08${operation ?? "unknown"}\uFF09`);
    };
    return {
      // canvas 导出图片、拍照、录像的结果都经过这里
      base64ToTempFilePath: async (args) => {
        const bytes = Uint8Array.from(atob(String(args.base64Data || "")), (char) => char.charCodeAt(0));
        return { tempFilePath: await saveTempFile(bytes, String(args.fileType || "png")) };
      },
      // 基础库经这两个接口向后台拉各种配置和小程序信息
      operateWXData: (args, { api }) => {
        if (args.data?.api_name === SERVICE_MARKET) {
          const serviceMarketFail = (reason2) => fail(api, reason2, { err_code: -1 });
          if (!options?.devtoolsLogin) return serviceMarketFail("wx.serviceMarket \u8981\u5411\u5FAE\u4FE1\u670D\u52A1\u5E02\u573A\u771F\u5B9E\u8C03\u7528\uFF0C\u542F\u52A8\u65F6\u52A0 --devtools-login");
          return viaDevtools("serviceMarket.invokeService", "/__wxa__/api/operate-wx-data", { data: args.data }).then(
            ({ data }) => ok(api, { data }),
            (error) => serviceMarketFail(error.message)
          );
        }
        if (args.data?.api_name === CLOUD) return cloudUnavailable(api, args.data.data?.qbase_api_name);
        if (args.data?.api_name === "webapi_getwxanetwork") return bizDomainUnavailable(api);
        if (args.data?.api_name === "webapi_getwxauserprivacyauthinfo") return ok(api, { data: { data: JSON.stringify(PRIVACY_AUTH_INFO) } });
        return ok(api, { data: {} });
      },
      getAppContact: (args, { api }) => args.keyPath === "WxaAppInfo.Network.BizDomain" ? bizDomainUnavailable(api) : ok(api),
      // 基础库内部的实验开关。不在实验里时原生返回空字符串；没有 testConfig 时 3.3.4 读它的 length 报错
      getABTestConfig: (_args, { api }) => ok(api, { testConfig: "" }),
      // 插件：基础库启动时校验插件、取插件信息，插件里的网络请求要等拿到这两样才发出。插件代码也只在 --devtools-login 时下载
      ...options?.devtoolsLogin ? {
        verifyPlugin: (async (args, { api }) => ok(api, await viaDevtools(api, "/__wxa__/api/verify-plugin", { data: args.data }))),
        batchGetContact: (async (args, { api }) => ok(api, await viaDevtools(api, "/__wxa__/api/batch-get-contact", { appIds: args.appIds })))
      } : {},
      // 向微信取不到时明确返回 fail，不退回假数据：配置或登录态的问题要让开发者马上发现
      login: options?.devtoolsLogin ? async (_args, { api }) => ok(api, { code: (await viaDevtools(api, "/__wxa__/api/login")).code }) : (_args, { api }) => ok(api, { code: `wxa_mock_code_${Date.now().toString(36)}` }),
      // 基础库只从 JSON.parse(data) 里取手机号的 code
      getPhoneNumber: options?.devtoolsLogin ? async (_args, { api }) => ok(api, await viaDevtools(api, "/__wxa__/api/phone-number")) : (_args, { api }) => ok(api, { data: JSON.stringify({ code: `mock_phone_code_${Date.now()}` }), encryptedData: "mock_encrypted", iv: "mock_iv" }),
      checkSession: () => void 0,
      authorize: () => void 0,
      getSetting: (_args, { api }) => ok(api, {
        authSetting: { "scope.userInfo": true, "scope.userLocation": true }
      }),
      openSetting: (_args, { api }) => ok(api, { authSetting: {} }),
      getUserInfo: (_args, { api }) => ok(api, { userInfo: mockUser(), rawData: JSON.stringify(mockUser()), signature: "", encryptedData: "", iv: "" }),
      getUserProfile: (_args, { api }) => ok(api, { userInfo: mockUser(), rawData: JSON.stringify(mockUser()), signature: "", encryptedData: "", iv: "" }),
      getAccountInfoSync: (_args, { api }) => ok(api, { miniProgram: { appId: appid, envVersion: "develop", version: "" } }),
      requestPayment: (_args, { api }) => fail(api, '\u6D4F\u89C8\u5668\u8FD0\u884C\u65F6\u4E0D\u652F\u6301\u652F\u4ED8\uFF0C\u8BF7\u5728\u6D4B\u8BD5\u4E2D\u901A\u8FC7 __wxa_test_api__.mock("requestPayment", ...) \u6A21\u62DF'),
      getLocation: (_args, { api }) => ok(api, { latitude: 39.908823, longitude: 116.39747, speed: 0, accuracy: 65, altitude: 0, verticalAccuracy: 65, horizontalAccuracy: 65 }),
      scanCode: (_args, { api }) => fail(api, "cancel"),
      setClipboardData: async (args) => {
        clipboard = String(args.data ?? "");
        await navigator.clipboard?.writeText(clipboard).catch(() => void 0);
      },
      getClipboardData: (_args, { api }) => ok(api, { data: clipboard }),
      makePhoneCall: (args) => console.info(`[wxa-runner] makePhoneCall ${args.phoneNumber}`),
      showShareMenu: () => void 0,
      hideShareMenu: () => void 0,
      updateShareMenu: () => void 0
    };
  }
  var clipboard = "";
  async function postDevServer(url, json) {
    const init = json ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) } : { method: "POST" };
    const response = await fetch(url, init);
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw new Error(body?.error || `\u5F00\u53D1\u670D\u52A1\u5668\u8FD4\u56DE HTTP ${response.status}`);
    return body;
  }
  function mockUser() {
    return { nickName: "wxa-runner", avatarUrl: "", gender: 0, country: "", province: "", city: "", language: "zh_CN" };
  }
  var PRIVACY_AUTH_INFO = { action_code: 0, need_popup_scope_list: [], unauth_scope_list: [], wording: {} };
  function bizDomainUnavailable(api) {
    return fail(api, "not available in wxa-runner");
  }

  // src/runtime/networkPanel.ts
  var PROXY_PREFIX = "/__wxa__/proxy/";
  var MOCK_PREFIX = "/__wxa__/mock/";
  var MOCK_ID_HEADER = "x-wxa-mock-id";
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
  function toHeaders(header) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(header)) {
      if (value === void 0 || value === null) continue;
      try {
        headers.set(name, String(value));
      } catch {
      }
    }
    return headers;
  }

  // src/runtime/host/api/network.ts
  var RequestLog = class {
    constructor(limit = 1e3) {
      this.limit = limit;
      this.items = [];
    }
    add(request) {
      this.items.push(request);
      if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    }
    /** 按发出顺序；返回副本，修改它不影响记录 */
    list() {
      return this.items.map((request) => ({ ...request, header: { ...request.header } }));
    }
    clear() {
      this.items = [];
    }
  };
  var taskSeq = 0;
  function createNetworkApis(options) {
    const controllers = /* @__PURE__ */ new Map();
    const sockets = /* @__PURE__ */ new Map();
    const pendingSockets = /* @__PURE__ */ new Set();
    const { emit } = options;
    const startTask = (args, run) => {
      const id = String(++taskSeq);
      const controller = new AbortController();
      const timeout = args.timeout || options.defaultTimeout();
      const timer = timeout > 0 ? setTimeout(() => controller.abort(new Error("timeout")), timeout) : null;
      controllers.set(id, controller);
      setTimeout(() => {
        run(controller.signal, id).finally(() => {
          if (timer) clearTimeout(timer);
          controllers.delete(id);
        });
      }, 0);
      return id;
    };
    const abortTask = (args, key) => {
      if (args.operationType === "abort") controllers.get(String(args[key]))?.abort(new Error("abort"));
    };
    const createRequestTask = (args, { api }) => {
      const request = { url: args.url, method: (args.method || "GET").toUpperCase(), header: { ...args.header }, data: args.data };
      const route = options.routes?.match(request);
      options.onRequest?.({ ...request, header: { ...request.header }, routedBy: route ? route.pattern : null });
      const requestTaskId = startTask(args, async (signal, id) => {
        try {
          const mocked = route?.respond(signal);
          if (mocked) options.onMocked?.(request, mocked, signal);
          const res = mocked ? await mocked.then(({ statusCode, header, body }) => ({ statusCode, header, cookies: [], response: new Response(body) })) : await proxyFetch(request.url, { method: request.method, header: args.header, body: args.data, signal });
          emit("onRequestTaskStateChange", {
            requestTaskId: id,
            state: "headersReceived",
            header: res.header,
            statusCode: res.statusCode,
            cookies: res.cookies
          });
          let data;
          if (args.enableChunked && res.response.body) {
            const reader = res.response.body.getReader();
            const chunks = [];
            let length = 0;
            try {
              for (; ; ) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                length += value.byteLength;
                emit("onRequestTaskStateChange", {
                  requestTaskId: id,
                  state: "chunked",
                  data: value.slice().buffer
                });
              }
            } finally {
              reader.releaseLock();
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            data = args.responseType === "arraybuffer" ? bytes.buffer : new TextDecoder().decode(bytes);
          } else {
            data = args.responseType === "arraybuffer" ? await res.response.arrayBuffer() : await res.response.text();
          }
          emit("onRequestTaskStateChange", {
            requestTaskId: id,
            state: "success",
            data,
            statusCode: res.statusCode,
            header: res.header,
            cookies: res.cookies,
            profile: {}
          });
        } catch (error) {
          emit("onRequestTaskStateChange", { requestTaskId: id, state: "fail", errMsg: `request:fail ${reason(error)}` });
        }
      });
      return ok(api, { requestTaskId });
    };
    const createDownloadTask = (args, { api }) => {
      const downloadTaskId = startTask(args, async (signal, id) => {
        try {
          const res = await proxyFetch(args.url, { method: "GET", header: args.header, signal });
          emit("onDownloadTaskStateChange", { downloadTaskId: id, state: "headersReceived", header: res.header, cookies: res.cookies });
          const blob = await res.response.blob();
          emit("onDownloadTaskStateChange", {
            downloadTaskId: id,
            state: "progressUpdate",
            progress: 100,
            totalBytesWritten: blob.size,
            totalBytesExpectedToWrite: blob.size
          });
          const fileName = new URL(args.url).pathname.split("/").pop() || "";
          const tempFilePath = await saveTempFile(blob, tempFileType(fileName, blob.type, "tmp"));
          emit("onDownloadTaskStateChange", {
            downloadTaskId: id,
            state: "success",
            tempFilePath,
            statusCode: res.statusCode,
            header: res.header,
            profile: {}
          });
        } catch (error) {
          emit("onDownloadTaskStateChange", { downloadTaskId: id, state: "fail", errMsg: `downloadFile:fail ${reason(error)}` });
        }
      });
      return ok(api, { downloadTaskId });
    };
    const createUploadTask = (args, { api }) => {
      const uploadTaskId = startTask(args, async (signal, id) => {
        try {
          const source = await fetch(args.filePath);
          if (!source.ok) throw new Error(`file not exist ${args.filePath}`);
          const file = await source.blob();
          const form = new FormData();
          for (const [key, value] of Object.entries(args.formData || {})) form.append(key, String(value));
          form.append(args.name || "file", file, String(args.filePath).split("/").pop() || "file");
          const res = await proxyFetch(args.url, { method: "POST", header: args.header, body: form, signal });
          const data = await res.response.text();
          emit("onUploadTaskStateChange", {
            uploadTaskId: id,
            state: "progressUpdate",
            progress: 100,
            totalBytesSent: file.size,
            totalBytesExpectedToSend: file.size
          });
          emit("onUploadTaskStateChange", { uploadTaskId: id, state: "success", data, statusCode: res.statusCode, header: res.header });
        } catch (error) {
          emit("onUploadTaskStateChange", { uploadTaskId: id, state: "fail", errMsg: `uploadFile:fail ${reason(error)}` });
        }
      });
      return ok(api, { uploadTaskId });
    };
    const createSocketTask = (args, { api }) => {
      const socketTaskId = String(++taskSeq);
      let socket;
      try {
        if (options.socketProxy) {
          const url = new URL("/__wxa__/socket", location.href);
          url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
          socket = new WebSocket(url);
          pendingSockets.add(socketTaskId);
        } else socket = new WebSocket(args.url, args.protocols && args.protocols.length ? args.protocols : void 0);
      } catch (error) {
        return fail(api, reason(error));
      }
      socket.binaryType = "arraybuffer";
      sockets.set(socketTaskId, socket);
      let failed = false;
      const onError = () => {
        failed = true;
        emit("onSocketTaskStateChange", { socketTaskId, state: "error", errMsg: "connectSocket:fail" });
      };
      socket.onopen = () => {
        if (options.socketProxy) socket.send(JSON.stringify({
          url: args.url,
          header: args.header,
          protocols: args.protocols,
          timeout: args.timeout || options.defaultSocketTimeout?.() || 6e4
        }));
        else emit("onSocketTaskStateChange", { socketTaskId, state: "open", header: {}, profile: {} });
      };
      socket.onmessage = (event) => {
        if (pendingSockets.has(socketTaskId)) {
          const result = JSON.parse(event.data);
          pendingSockets.delete(socketTaskId);
          emit("onSocketTaskStateChange", { socketTaskId, state: "open", header: result.header, profile: {} });
        } else emit("onSocketTaskStateChange", { socketTaskId, state: "message", data: event.data });
      };
      socket.onerror = onError;
      socket.onclose = (event) => {
        sockets.delete(socketTaskId);
        if (pendingSockets.delete(socketTaskId) && !failed) onError();
        emit("onSocketTaskStateChange", { socketTaskId, state: "close", code: event.code, reason: event.reason });
      };
      return ok(api, { socketTaskId });
    };
    const operateSocketTask = (args, { api }) => {
      const socket = sockets.get(String(args.socketTaskId));
      if (!socket) return fail(api, "socket task not found");
      if (args.operationType === "send") {
        if (pendingSockets.has(String(args.socketTaskId)) || socket.readyState !== WebSocket.OPEN) return fail(api, "socket is not open");
        socket.send(args.data);
      } else if (args.operationType === "close") {
        socket.close(args.code || 1e3, args.reason);
      }
      return ok(api);
    };
    const downloadAudio = (args, { api }) => {
      const requestTaskId = startTask(args, async (signal, id) => {
        try {
          const res = await proxyFetch(args.url, { method: "GET", header: args.header, signal });
          const meta = { requestTaskId: id, statusCode: res.statusCode, header: res.header, cookies: res.cookies };
          emit("onRequestTaskStateChange", { ...meta, state: "headersReceived" });
          emit("onRequestTaskStateChange", { ...meta, state: "success", data: await res.response.arrayBuffer(), profile: {} });
        } catch (error) {
          emit("onRequestTaskStateChange", { requestTaskId: id, state: "fail", errMsg: `request:fail ${reason(error)}` });
        }
      });
      return ok(api, { requestTaskId });
    };
    const requestTask = byCaller(createRequestTask, (args, context) => isAudioDownload(args) ? downloadAudio(args, context) : rejectBaseLib(args, context));
    const downloadTask = byCaller(createDownloadTask);
    const uploadTask = byCaller(createUploadTask);
    return {
      createRequestTask: requestTask,
      createRequestTaskAsync: requestTask,
      createDownloadTask: downloadTask,
      createDownloadTaskAsync: downloadTask,
      createUploadTask: uploadTask,
      createUploadTaskAsync: uploadTask,
      createSocketTask: byCaller(createSocketTask),
      operateRequestTask: (args) => abortTask(args, "requestTaskId"),
      operateDownloadTask: (args) => abortTask(args, "downloadTaskId"),
      operateUploadTask: (args) => abortTask(args, "uploadTaskId"),
      operateSocketTask
    };
  }
  var rejectBaseLib = (_args, { api }) => fail(api, "\u57FA\u7840\u5E93\u5185\u90E8\u7684\u7F51\u7EDC\u8BF7\u6C42\uFF0Cwxa-runner \u4E0D\u53D1\u51FA");
  function byCaller(forApp, forBaseLib = rejectBaseLib) {
    return (args, context) => args?.__skipDomainCheck__ === true && !hasPluginSign(args) ? forBaseLib(args, context) : forApp(args, context);
  }
  function hasPluginSign(args) {
    return Object.keys(args.header || {}).some((name) => name.toLowerCase() === "x-wechat-hostsign");
  }
  function isAudioDownload(args) {
    return args.responseType === "arraybuffer" && args.enableCache === true;
  }
  async function proxyFetch(url, init) {
    const path = toServerPath(PROXY_PREFIX, url);
    if (!path) throw new Error(`invalid url "${url}"`);
    const response = await fetch(path, {
      method: init.method,
      headers: { "x-wxa-headers": JSON.stringify(init.header || {}) },
      body: hasRequestBody(init.method, init.body) ? init.body : void 0,
      signal: init.signal
    });
    if (response.headers.get("x-wxa-proxy-error")) {
      throw new Error(await response.text());
    }
    return {
      statusCode: response.status,
      header: JSON.parse(decodeURIComponent(response.headers.get("x-wxa-headers") || "%7B%7D")),
      cookies: JSON.parse(decodeURIComponent(response.headers.get("x-wxa-set-cookie") || "%5B%5D")),
      response
    };
  }
  function hasRequestBody(method, body) {
    return body !== void 0 && body !== "" && !["GET", "HEAD"].includes(method);
  }
  function reason(error) {
    if (error instanceof DOMException && error.name === "AbortError") return "abort";
    return error instanceof Error ? error.message : String(error);
  }

  // src/runtime/host/api/mockMirror.ts
  var SERVICE_WORKER_URL = "/__wxa__/runtime/sw.js";
  var MockMirror = class {
    constructor(serviceWorker) {
      this.serviceWorker = serviceWorker;
      /** 正在显示的请求，Service Worker 按 id 来要响应 */
      this.replies = /* @__PURE__ */ new Map();
      this.seq = 0;
      serviceWorker.addEventListener("message", (event) => this.answer(event));
      serviceWorker.startMessages();
    }
    /** response 失败（规则出错、请求被取消）时这一行显示为失败；signal abort 时显示为取消 */
    show(request, response, signal) {
      const path = toServerPath(MOCK_PREFIX, request.url);
      if (!path || !this.serviceWorker.controller) return;
      const id = String(++this.seq);
      const cancelled = new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }));
      this.replies.set(id, Promise.race([response.catch(() => null), cancelled]));
      const headers = toHeaders(request.header);
      headers.set(MOCK_ID_HEADER, id);
      fetch(path, {
        method: request.method,
        headers,
        body: hasRequestBody(request.method, request.data) ? request.data : void 0,
        // 拦截规则给出 3xx 时只显示这个响应：跟随 Location 会真的发出请求，小程序那边也不跟随
        redirect: "manual",
        signal
      }).catch(() => void 0).finally(() => this.replies.delete(id));
    }
    answer(event) {
      const query = event.data;
      const port = event.ports[0];
      if (query?.type !== "wxa-mock-response" || !port) return;
      (this.replies.get(query.id) ?? Promise.resolve(null)).then((reply) => port.postMessage(reply));
    }
  };
  function installMockMirror(externalServiceWorker = false) {
    if (!externalServiceWorker && navigator.webdriver || !navigator.serviceWorker) return null;
    if (!externalServiceWorker) navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" }).catch((error) => console.warn("[wxa-runner] Service Worker \u6CE8\u518C\u5931\u8D25\uFF0C\u88AB\u62E6\u622A\u7684\u8BF7\u6C42\u4E0D\u4F1A\u663E\u793A\u5728 Network \u9762\u677F\u91CC", error));
    return new MockMirror(navigator.serviceWorker);
  }

  // src/runtime/host/api/picker.ts
  async function fetchRegionData(kind) {
    const res = await fetch(`/__wxa__/region/${kind}`);
    if (!res.ok) throw new Error("\u6CA1\u6709\u627E\u5230\u884C\u653F\u533A\u5212\u6570\u636E\uFF0C\u5730\u533A\u9009\u62E9\u5668\u9700\u8981\u672C\u673A\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u81EA\u5E26\u7684\u6570\u636E");
    return res.text();
  }
  function createPickerApis({ showPicker, emitToWebview, loadRegionData }) {
    let multiPicker = null;
    let regionTree = null;
    const loadRegionTree = () => {
      regionTree ?? (regionTree = loadRegionData("streets").then(parseRegionTree));
      regionTree.catch(() => {
        regionTree = null;
      });
      return regionTree;
    };
    const showCascade = (model) => {
      const session = showPicker({
        columns: model.columns(),
        current: model.current(),
        onColumnChange(column, index) {
          model.select(column, index);
          const columns = model.columns();
          const current = model.current();
          for (let next = column + 1; next < columns.length; next++) session.setColumn(next, columns[next], current[next]);
        }
      });
      return session.result;
    };
    return {
      showPickerView: async (args, { api }) => {
        const result = await showPicker({
          columns: [labels(args.array)],
          current: [Number(args.current) || 0]
        }).result;
        return result ? ok(api, { index: result[0] }) : fail(api, "cancel");
      },
      showMultiPickerView: async (args, { api, webviewId }) => {
        const session = showPicker({
          columns: (args.array || []).map(labels),
          current: (args.current || []).map((index) => Number(index) || 0),
          onColumnChange: (column, current) => emitToWebview(webviewId, "onMultiPickerViewChange", { column, current })
        });
        multiPicker = session;
        const result = await session.result;
        if (multiPicker === session) multiPicker = null;
        return result ? ok(api, { current: result }) : fail(api, "cancel");
      },
      updateMultiPickerView: (args, { api }) => {
        if (!multiPicker) return fail(api, "no picker is showing");
        multiPicker.setColumn(Number(args.column), labels(args.array), Number(args.current) || 0);
        return ok(api);
      },
      showDatePickerView: async (args, { api }) => {
        const model = new DateCascade(args.mode === "time" ? "time" : "date", args.fields, args.range || {}, String(args.current || ""));
        const result = await showCascade(model);
        return result ? ok(api, { value: model.value() }) : fail(api, "cancel");
      },
      showAddressPickerView: async (args, { api }) => {
        let tree;
        try {
          tree = await loadRegionTree();
        } catch (error) {
          return fail(api, error.message);
        }
        const model = new RegionCascade(tree, REGION_LEVELS[args.mode] || 3, args.current || []);
        const result = await showCascade(model);
        return result ? ok(api, { value: model.value() }) : fail(api, "cancel");
      },
      getRegionData: async (_args, { api }) => {
        try {
          return ok(api, { data: await loadRegionData("districts") });
        } catch (error) {
          return fail(api, error.message);
        }
      }
    };
  }
  function labels(items) {
    return Array.isArray(items) ? items.map((item) => String(item)) : [];
  }
  var DEFAULT_DATE_RANGE = { start: [1900, 1, 1], end: [2100, 12, 31] };
  var DATE_DEPTH = { year: 1, month: 2, day: 3 };
  var DateCascade = class {
    constructor(mode, fields, range, current) {
      this.mode = mode;
      this.parts = [];
      this.depth = mode === "time" ? 2 : DATE_DEPTH[String(fields)] || 3;
      const lowest = mode === "time" ? [0, 0] : DEFAULT_DATE_RANGE.start;
      const highest = mode === "time" ? [23, 59] : DEFAULT_DATE_RANGE.end;
      this.min = fillParts(parseParts(range.start), lowest);
      this.max = fillParts(parseParts(range.end), highest);
      let initial = fillParts(parseParts(current), lowest);
      if (compareParts(initial, this.min, this.depth) < 0) initial = this.min;
      else if (compareParts(initial, this.max, this.depth) > 0) initial = this.max;
      for (let column = 0; column < this.depth; column++) {
        const [low, high] = this.bounds(column);
        this.parts[column] = clamp(initial[column], low, high);
      }
    }
    columns() {
      return this.parts.map((_, column) => {
        const [low, high] = this.bounds(column);
        return Array.from({ length: high - low + 1 }, (__, offset) => this.label(column, low + offset));
      });
    }
    current() {
      return this.parts.map((value, column) => value - this.bounds(column)[0]);
    }
    select(column, index) {
      this.parts[column] = this.bounds(column)[0] + index;
      for (let next = column + 1; next < this.depth; next++) {
        const [low, high] = this.bounds(next);
        this.parts[next] = clamp(this.parts[next], low, high);
      }
    }
    value() {
      if (this.mode === "time") return this.parts.map(pad).join(":");
      return this.parts.map((value, column) => column === 0 ? String(value) : pad(value)).join("-");
    }
    bounds(column) {
      const before = this.parts.slice(0, column);
      let [low, high] = this.naturalBounds(column);
      if (before.every((value, i) => value === this.min[i])) low = Math.max(low, this.min[column]);
      if (before.every((value, i) => value === this.max[i])) high = Math.min(high, this.max[column]);
      return [low, Math.max(low, high)];
    }
    naturalBounds(column) {
      if (this.mode === "time") return column === 0 ? [0, 23] : [0, 59];
      if (column === 0) return [this.min[0], this.max[0]];
      if (column === 1) return [1, 12];
      return [1, new Date(this.parts[0], this.parts[1], 0).getDate()];
    }
    label(column, value) {
      if (this.mode === "time") return pad(value);
      return column === 0 ? value + "\u5E74" : pad(value) + ["\u6708", "\u65E5"][column - 1];
    }
  };
  function parseParts(text) {
    return String(text || "").split(/[-:]/).filter(Boolean).map(Number).filter((part) => Number.isInteger(part));
  }
  function fillParts(parts, defaults) {
    return parts.length ? defaults.map((value, i) => parts[i] ?? value) : defaults;
  }
  function compareParts(a, b, depth) {
    for (let i = 0; i < depth; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }
  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }
  function pad(value) {
    return String(value).padStart(2, "0");
  }
  var REGION_LEVELS = { province: 1, city: 2, region: 3, "sub-district": 4 };
  function parseRegionTree(text) {
    const roots = [];
    const lastAtDepth = [];
    for (const line of text.split("\n")) {
      const match = /^(\d+)(\t+)([^\t]+)\t(\d+)/.exec(line.trimEnd());
      if (!match) continue;
      const depth = match[2].length;
      const node = { code: match[1], name: match[3].trim(), postcode: match[4], children: [] };
      if (depth === 1) roots.push(node);
      else lastAtDepth[depth - 2]?.children.push(node);
      lastAtDepth[depth - 1] = node;
      lastAtDepth.length = depth;
    }
    return roots;
  }
  var RegionCascade = class {
    constructor(tree, levels, names) {
      this.tree = tree;
      this.levels = levels;
      this.path = [];
      for (let level = 0; level < levels; level++) {
        const index = this.options(level).findIndex((node) => node.name === names[level]);
        this.path[level] = Math.max(0, index);
      }
    }
    columns() {
      return this.path.map((_, level) => this.options(level).map((node) => node.name));
    }
    current() {
      return [...this.path];
    }
    select(column, index) {
      this.path[column] = index;
      for (let level = column + 1; level < this.levels; level++) this.path[level] = 0;
    }
    value() {
      const nodes = this.selectedNodes();
      return {
        value: nodes.map((node) => node.name),
        code: nodes.map((node) => node.code),
        postcode: nodes.at(-1)?.postcode ?? ""
      };
    }
    /** 某一级可选的节点：上一级选中节点的下级 */
    options(level) {
      if (level === 0) return this.tree;
      return this.selectedNodes(level).at(-1)?.children ?? [];
    }
    selectedNodes(levels = this.levels) {
      const nodes = [];
      let options = this.tree;
      for (let level = 0; level < levels; level++) {
        const node = options[this.path[level]];
        if (!node) break;
        nodes.push(node);
        options = node.children;
      }
      return nodes;
    }
  };

  // src/runtime/host/api/routes.ts
  var METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"];
  var RequestRoutes = class {
    constructor() {
      this.routes = [];
    }
    /**
     * 后添加的规则优先
     * @throws 规则写法不对时
     */
    add(pattern, handler) {
      const matches = compilePattern(pattern);
      if (typeof handler !== "function" && (handler === null || typeof handler !== "object")) {
        throw new Error("\u62E6\u622A\u89C4\u5219\u7684\u503C\u9700\u8981\u662F\u54CD\u5E94\u5BF9\u8C61 { status?, header?, body?, delay? }\uFF0C\u6216\u6309\u8BF7\u6C42\u8FD4\u56DE\u54CD\u5E94\u7684\u51FD\u6570");
      }
      if (typeof handler === "object") checkDelay(handler.delay);
      this.routes.unshift({ pattern, matches, handler });
    }
    /** 删除按这个写法添加的规则，不传时删除全部 */
    remove(pattern) {
      this.routes = pattern === void 0 ? [] : this.routes.filter((route) => route.pattern !== pattern);
    }
    /** 找到匹配的规则，没有时返回 undefined。响应在调用 respond 时才生成 */
    match(request) {
      const route = this.routes.find((r) => r.matches(request));
      if (!route) return void 0;
      return {
        pattern: route.pattern,
        async respond(signal) {
          console.info(`[wxa-runner] \u62E6\u622A\u8BF7\u6C42 ${request.method} ${request.url}\uFF08${route.pattern}\uFF09`);
          const response = typeof route.handler === "function" ? await route.handler(request) || {} : route.handler;
          checkDelay(response.delay);
          if (response.delay) await sleep(response.delay, signal);
          const { body } = response;
          const isJson = body !== void 0 && typeof body !== "string" && !isBinary(body);
          return {
            statusCode: response.status ?? 200,
            header: { ...isJson ? { "Content-Type": "application/json" } : {}, ...response.header },
            body: body === void 0 ? "" : isJson ? JSON.stringify(body) : body
          };
        }
      };
    }
  };
  function compilePattern(pattern) {
    const parts = pattern.trim().split(/\s+/);
    if (parts.length > 2 || parts.length === 2 && !METHODS.includes(parts[0].toUpperCase())) {
      throw new Error(`\u62E6\u622A\u89C4\u5219\u5E94\u5199\u6210 "[\u8BF7\u6C42\u65B9\u6CD5 ]\u5730\u5740"\uFF0C\u5982 "POST https://api.example.com/login"\u3001"**/auth/login"`);
    }
    const [method, url] = parts.length === 2 ? [parts[0].toUpperCase(), parts[1]] : [null, parts[0]];
    const regexp = globToRegExp(url);
    return (request) => (!method || method === request.method) && regexp.test(String(request.url).replace(/[?#].*$/, ""));
  }
  function isBinary(value) {
    return ArrayBuffer.isView(value) || Object.prototype.toString.call(value) === "[object ArrayBuffer]";
  }
  function checkDelay(delay) {
    if (delay !== void 0 && !(typeof delay === "number" && delay >= 0 && Number.isFinite(delay))) {
      throw new Error(`delay \u9700\u8981\u662F\u4E0D\u5C0F\u4E8E 0 \u7684\u6BEB\u79D2\u6570\uFF0C\u5B9E\u9645\u662F ${String(delay)}`);
    }
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  }
  function globToRegExp(glob) {
    const source = glob.split("**").map((part) => part.split("*").map(escapeRegExp).join("[^/]*")).join(".*");
    return new RegExp(`^${source}$`);
  }
  function escapeRegExp(text) {
    return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }

  // src/runtime/host/api/savedFiles.ts
  var NAMESPACE = "savedFiles";
  function createSavedFileApis(storage) {
    const record = (filePath) => storage.get(NAMESPACE, filePath)?.data;
    const liveRecord = async (filePath) => {
      const saved = record(filePath);
      if (!saved) return void 0;
      if (await tempFileSize(filePath) !== null) return saved;
      storage.remove(NAMESPACE, filePath);
      return void 0;
    };
    return {
      // 和真机一样：存成新文件，原来的临时文件随之删除
      saveFile: async (args) => {
        if (args.filePath) throw new Error("wxa-runner \u6682\u4E0D\u652F\u6301\u6307\u5B9A filePath\uFF0C\u4E0D\u4F20\u65F6\u4FDD\u5B58\u6210\u529F\u540E\u8FD4\u56DE savedFilePath");
        const res = isTempFile(args.tempFilePath) ? await fetch(args.tempFilePath) : null;
        if (!res?.ok) throw new Error(`tempFilePath file not exist ${args.tempFilePath}`);
        const data = await res.blob();
        const savedFilePath = await saveTempFile(data, tempFileType(args.tempFilePath, data.type, "tmp"));
        await removeTempFile(args.tempFilePath);
        storage.set(NAMESPACE, savedFilePath, { size: data.size, createTime: Math.floor(Date.now() / 1e3) });
        return { savedFilePath };
      },
      getSavedFileList: async () => {
        const fileList = [];
        for (const filePath of storage.keys(NAMESPACE)) {
          const saved = await liveRecord(filePath);
          if (saved) fileList.push({ filePath, ...saved });
        }
        return { fileList };
      },
      getSavedFileInfo: async (args) => {
        const saved = await liveRecord(args.filePath);
        if (!saved) throw new Error(`file not exist ${args.filePath}`);
        return { ...saved };
      },
      removeSavedFile: async (args) => {
        if (!record(args.filePath)) throw new Error(`file not exist ${args.filePath}`);
        storage.remove(NAMESPACE, args.filePath);
        await removeTempFile(args.filePath);
      }
    };
  }

  // src/runtime/host/api/storage.ts
  var LIMIT_SIZE_KB = 10 * 1024;
  var MiniProgramStorage = class {
    constructor(store, appid) {
      this.store = store;
      this.appid = appid;
    }
    set(namespace, key, data, dataType) {
      this.store.setItem(this.prefix(namespace) + key, JSON.stringify([data, dataType]));
    }
    get(namespace, key) {
      const raw = this.store.getItem(this.prefix(namespace) + key);
      if (raw === null) return null;
      const [data, dataType] = JSON.parse(raw);
      return { data, dataType };
    }
    remove(namespace, key) {
      this.store.removeItem(this.prefix(namespace) + key);
    }
    keys(namespace) {
      const prefix = this.prefix(namespace);
      const keys = [];
      for (let i = 0; i < this.store.length; i++) {
        const key = this.store.key(i);
        if (key && key.startsWith(prefix)) keys.push(key.slice(prefix.length));
      }
      return keys;
    }
    clear(namespace) {
      for (const key of this.keys(namespace)) this.remove(namespace, key);
    }
    info(namespace) {
      const prefix = this.prefix(namespace);
      const keys = this.keys(namespace);
      let bytes = 0;
      for (const key of keys) {
        bytes += (key.length + (this.store.getItem(prefix + key) || "").length) * 2;
      }
      return { keys, currentSize: Math.ceil(bytes / 1024), limitSize: LIMIT_SIZE_KB };
    }
    prefix(namespace) {
      return `wxa:${this.appid}:${namespace}:`;
    }
  };
  function encodeStorageValue(value) {
    const dataType = typeOf(value);
    switch (dataType) {
      case "Array":
      case "Object":
        return { data: JSON.stringify(value), dataType };
      case "String":
      case "Number":
      case "Boolean":
        return { data: String(value), dataType };
      case "Date":
        return { data: String(value.getTime()), dataType };
      case "Undefined":
      case "Null":
        return { data: dataType.toLowerCase(), dataType };
      default:
        throw new Error(`\u4E0D\u652F\u6301\u5B58\u50A8 ${dataType} \u7C7B\u578B\u7684\u503C`);
    }
  }
  function decodeStorageValue(item) {
    const { data, dataType } = item;
    if (typeof data !== "string" || !dataType) return data;
    switch (dataType) {
      case "String":
        return data;
      case "Array":
      case "Object":
        return JSON.parse(data);
      case "Number":
        return parseFloat(data);
      case "Boolean":
        return data === "true";
      case "Date":
        return new Date(parseInt(data, 10));
      case "Undefined":
        return void 0;
      case "Null":
        return null;
      default:
        return "";
    }
  }
  function typeOf(value) {
    return Object.prototype.toString.call(value).slice(8, -1);
  }
  function createStorageApis(storage) {
    const ns = (args) => `s${args.storageId || 0}`;
    const get = (args, { api }) => {
      const item = storage.get(ns(args), args.key);
      return item ? ok(api, item) : fail(api, "data not found");
    };
    const set = (args) => storage.set(ns(args), args.key, args.data, args.dataType);
    const remove = (args) => storage.remove(ns(args), args.key);
    const clear = (args) => storage.clear(ns(args));
    const info = (args) => storage.info(ns(args));
    const globalGet = (args, { api }) => {
      const item = storage.get("global", args.key);
      return item ? ok(api, { data: item.data }) : fail(api, "data not found");
    };
    return {
      getStorage: get,
      getStorageSync: get,
      setStorage: set,
      setStorageSync: set,
      removeStorage: remove,
      removeStorageSync: remove,
      clearStorage: clear,
      clearStorageSync: clear,
      getStorageInfo: info,
      getStorageInfoSync: info,
      getGlobalStorage: globalGet,
      getGlobalStorageSync: globalGet,
      setGlobalStorage: (args) => storage.set("global", args.key, args.data),
      setGlobalStorageSync: (args) => storage.set("global", args.key, args.data),
      removeGlobalStorage: (args) => storage.remove("global", args.key),
      clearGlobalStorage: () => storage.clear("global"),
      getGlobalStorageInfo: () => storage.info("global")
    };
  }

  // src/runtime/host/api/subpackages.ts
  function createSubpackageApis(options) {
    const names = /* @__PURE__ */ new Set(["__APP__"]);
    for (const pkg of options.subPackages) {
      names.add(normalizeName(pkg.root));
      if (pkg.name) names.add(normalizeName(pkg.name));
    }
    if (typeof options.workers === "object" && options.workers.isSubpackage) names.add("workers.js");
    let taskSeq2 = 0;
    const createLoadSubPackageTask = (args, { api }) => {
      const moduleName = args.moduleName;
      if (typeof moduleName !== "string" || !moduleName || !names.has(normalizeName(moduleName))) {
        return fail(api, "module not found");
      }
      const loadTaskId = String(++taskSeq2);
      setTimeout(() => {
        const event = { taskId: loadTaskId, moduleName };
        options.emit("onLoadSubPackageTaskStateChange", {
          ...event,
          state: "progressUpdate",
          progress: 100,
          // 没有网络下载，不伪造传输字节数。
          totalBytesWritten: 0,
          totalBytesExpectedToWrite: 0
        });
        options.emit("onLoadSubPackageTaskStateChange", { ...event, state: "success" });
      }, 0);
      return ok(api, { loadTaskId });
    };
    return {
      createLoadSubPackageTask,
      // 事件已由桥接广播，具体监听与回调由基础库管理，无需另建一套订阅状态。
      listenLoadSubPackageTaskStateChange: (_args, { api }) => ok(api),
      // 分包加载完成后渲染层请求注入分包的模板和样式，它们已经打进 page-frame.js，回调后基础库替换占位组件。
      injectSubPackages: (_args, { api }) => ok(api)
    };
  }
  function normalizeName(name) {
    return name.replace(/^\.?\//, "").replace(/\/$/, "");
  }

  // src/runtime/host/api/system.ts
  var NAVIGATION_BAR_HEIGHT = 44;
  var TAB_BAR_HEIGHT = 50;
  function menuButtonRect(device) {
    const width = 87;
    const height = 32;
    const top = device.statusBarHeight + 6;
    const right = device.screenWidth - 7;
    return { width, height, top, right, bottom: top + height, left: right - width };
  }
  function createSystemApis(options) {
    const { device } = options;
    const windowInfo = () => {
      const safeBottom = device.screenHeight - device.safeAreaBottom;
      return {
        pixelRatio: device.pixelRatio,
        screenWidth: device.screenWidth,
        screenHeight: device.screenHeight,
        windowWidth: device.screenWidth,
        windowHeight: options.windowHeight(),
        windowTop: 0,
        windowBottom: 0,
        statusBarHeight: device.statusBarHeight,
        safeArea: {
          left: 0,
          right: device.screenWidth,
          top: device.statusBarHeight,
          bottom: safeBottom,
          width: device.screenWidth,
          height: safeBottom - device.statusBarHeight
        },
        safeAreaInsets: { top: device.statusBarHeight, left: 0, right: 0, bottom: device.safeAreaBottom },
        screenTop: options.screenTop()
      };
    };
    const deviceInfo = () => ({
      brand: "devtools",
      model: device.model,
      system: device.system,
      platform: device.platform,
      benchmarkLevel: 1,
      abi: "arm64",
      deviceAbi: "arm64",
      cpuType: "unknown",
      memorySize: 4096
    });
    const appBaseInfo = () => ({
      SDKVersion: options.baseLibVersion,
      enableDebug: false,
      host: { env: "WeChat", appId: "" },
      language: "zh_CN",
      version: "8.0.50",
      theme: "light",
      fontSizeSetting: 16
    });
    const authorizeSetting = () => ({
      albumAuthorized: "authorized",
      bluetoothAuthorized: "authorized",
      cameraAuthorized: "authorized",
      locationAuthorized: "authorized",
      locationReducedAccuracy: false,
      microphoneAuthorized: "authorized",
      notificationAuthorized: "authorized",
      phoneCalendarAuthorized: "authorized"
    });
    const systemSetting = () => ({
      bluetoothEnabled: true,
      locationEnabled: true,
      wifiEnabled: true,
      deviceOrientation: "portrait"
    });
    const systemInfo = (args, { api }) => {
      switch (args.type) {
        case "windowInfo":
          return ok(api, windowInfo());
        case "deviceInfo":
          return ok(api, deviceInfo());
        case "appBaseInfo":
          return ok(api, appBaseInfo());
        case "appAuthorizeSetting":
          return ok(api, authorizeSetting());
        case "systemSetting":
          return ok(api, systemSetting());
      }
      return ok(api, {
        ...deviceInfo(),
        ...windowInfo(),
        ...appBaseInfo(),
        ...systemSetting(),
        albumAuthorized: true,
        cameraAuthorized: true,
        locationAuthorized: true,
        microphoneAuthorized: true,
        notificationAuthorized: true
      });
    };
    return {
      getSystemInfo: systemInfo,
      getSystemInfoSync: systemInfo,
      getSystemInfoAsync: systemInfo,
      getWindowInfo: (_args, { api }) => ok(api, windowInfo()),
      getDeviceInfo: (_args, { api }) => ok(api, deviceInfo()),
      getAppBaseInfo: (_args, { api }) => ok(api, appBaseInfo()),
      getAppAuthorizeSetting: (_args, { api }) => ok(api, authorizeSetting()),
      getSystemSetting: (_args, { api }) => ok(api, systemSetting()),
      getNetworkType: (_args, { api }) => ok(api, { networkType: "wifi", signalStrength: 100, hasSystemProxy: false }),
      getBatteryInfo: (_args, { api }) => ok(api, { level: 100, isCharging: true }),
      getBatteryInfoSync: (_args, { api }) => ok(api, { level: 100, isCharging: true }),
      getMenuButtonBoundingClientRect: (_args, { api }) => ok(api, menuButtonRect(device)),
      getScreenBrightness: (_args, { api }) => ok(api, { value: 0.8 }),
      setScreenBrightness: () => void 0,
      setKeepScreenOn: () => void 0,
      vibrateShort: () => void 0,
      vibrateLong: () => void 0
    };
  }

  // src/runtime/host/api/ui.ts
  function createUiApis({ shell, updateNavigation, setTabBarHidden }) {
    const updateTabBarItem = (api, index, item) => shell.updateTabBarItem(Number(index), item) ? void 0 : fail(api, "tabbar item not found");
    return {
      showToast: (args) => shell.showToast(args),
      hideToast: () => shell.hideToast(),
      showLoading: (args) => shell.showToast({ ...args, icon: "loading", duration: 0 }),
      hideLoading: () => shell.hideToast(),
      showModal: async (args, { api }) => ok(api, await shell.showModal(args)),
      showActionSheet: async (args, { api }) => {
        const tapIndex = await shell.showActionSheet(args);
        return tapIndex === null ? fail(api, "cancel") : ok(api, { tapIndex });
      },
      setNavigationBarTitle: (args) => updateNavigation({ title: String(args.title ?? "") }),
      setNavigationBarColor: (args) => updateNavigation({
        backgroundColor: args.backgroundColor,
        textStyle: String(args.frontColor).toLowerCase() === "#000000" ? "black" : "white"
      }),
      showNavigationBarLoading: () => shell.setNavigationLoading(true),
      hideNavigationBarLoading: () => shell.setNavigationLoading(false),
      hideTabBar: () => setTabBarHidden(true),
      showTabBar: () => setTabBarHidden(false),
      // 基础库把 removeTabBarBadge、showTabBarRedDot、hideTabBarRedDot 都转成 setTabBarBadge，用 type 区分；
      // 徽标文字超长时基础库已经换成 ...
      setTabBarBadge: (args, { api }) => updateTabBarItem(api, args.index, { mark: tabBarMark(args) }),
      setTabBarItem: (args, { api }) => updateTabBarItem(api, args.index, {
        text: args.text,
        iconPath: args.iconPath,
        selectedIconPath: args.selectedIconPath
      }),
      setTabBarStyle: (args) => shell.updateTabBarStyle({
        color: args.color,
        selectedColor: args.selectedColor,
        backgroundColor: args.backgroundColor,
        borderStyle: args.borderStyle
      }),
      hideHomeButton: () => void 0,
      setBackgroundColor: () => void 0,
      setBackgroundTextStyle: () => void 0,
      startPullDownRefresh: () => void 0,
      stopPullDownRefresh: () => void 0
    };
  }
  function tabBarMark(args) {
    if (args.type === "text") return { type: "text", text: String(args.badgeValue ?? "") };
    if (args.type === "redDot") return { type: "redDot" };
    return null;
  }

  // src/runtime/host/api/webView.ts
  function createWebViewApis(options) {
    const { documentOf, emitToWebview, windows } = options;
    if (windows) return createWindowApis(options);
    const find = (webviewId, htmlId) => documentOf(webviewId)?.querySelector(`iframe[data-wxa-html-id="${Number(htmlId)}"]`) ?? null;
    const reportStart = (webviewId, htmlId, src) => emitToWebview(webviewId, "onWebviewStartLoad", { htmlId, src, isMainFrame: true });
    const reportFinish = (webviewId, htmlId, src) => emitToWebview(webviewId, "onWebviewFinishLoad", { htmlId, src });
    return {
      insertHTMLWebView: (args, { api, webviewId }) => {
        const doc = documentOf(webviewId);
        if (!doc) return fail(api, "page not found");
        const htmlId = Number(args.htmlId);
        const frame = doc.createElement("iframe");
        frame.dataset.wxaHtmlId = String(htmlId);
        frame.style.cssText = "position:fixed;z-index:2147483647;border:0;background:#fff";
        place(frame, args.position);
        frame.addEventListener("load", () => {
          const requested = frame.dataset.wxaLoading;
          if (requested) {
            delete frame.dataset.wxaLoading;
            reportFinish(webviewId, htmlId, requested);
            return;
          }
          const src = readableUrl(frame);
          if (!src || src === "about:blank") return;
          reportStart(webviewId, htmlId, src);
          reportFinish(webviewId, htmlId, src);
        });
        doc.body.appendChild(frame);
        return ok(api);
      },
      updateHTMLWebView: (args, { api, webviewId }) => {
        const frame = find(webviewId, args.htmlId);
        if (!frame) return fail(api, "web-view not found");
        place(frame, args.position);
        if (args.src) {
          const src = rewriteSrc(options, webviewId, args.htmlId, String(args.src));
          warnCrossSite(src);
          frame.dataset.wxaLoading = src;
          frame.dataset.wxaSrc = src;
          reportStart(webviewId, Number(args.htmlId), src);
          frame.src = src;
        }
        return ok(api);
      },
      removeHTMLWebView: (args, { api, webviewId }) => {
        find(webviewId, args.htmlId)?.remove();
        return ok(api);
      }
    };
  }
  function createWindowApis(options) {
    const { documentOf, windows } = options;
    if (!windows) throw new Error("createWindowApis \u9700\u8981 windows");
    return {
      insertHTMLWebView: (args, { api, webviewId }) => {
        const doc = documentOf(webviewId);
        if (!doc) return fail(api, "page not found");
        windows.insert(webviewId, Number(args.htmlId), doc, args.position);
        return ok(api);
      },
      updateHTMLWebView: (args, { api, webviewId }) => {
        const src = args.src ? rewriteSrc(options, webviewId, args.htmlId, String(args.src)) : void 0;
        if (!windows.update(webviewId, Number(args.htmlId), args.position, src)) {
          return fail(api, "web-view not found");
        }
        return ok(api);
      },
      removeHTMLWebView: (args, { api, webviewId }) => {
        windows.remove(webviewId, Number(args.htmlId));
        return ok(api);
      }
    };
  }
  function rewriteSrc(options, webviewId, htmlId, src) {
    if (!options.rewriteUrl) return src;
    return options.rewriteUrl(src, {
      pagePath: options.pagePathOf?.(webviewId) ?? null,
      webviewId,
      htmlId: Number(htmlId)
    });
  }
  function iframeWebViews(doc) {
    return Array.from(doc?.querySelectorAll("iframe[data-wxa-src]") ?? []).map((frame) => ({ src: frame.dataset.wxaSrc, windowName: null }));
  }
  var COMMIT_WAIT_MS = 5e3;
  var WebViewWindows = class {
    /** @param isShown 页面当前是否显示：隐藏的页面先记下地址，显示时再打开窗口 */
    constructor(device, isShown) {
      this.device = device;
      this.isShown = isShown;
      this.records = /* @__PURE__ */ new Map();
    }
    insert(webviewId, htmlId, doc, position) {
      const previous = this.records.get(windowName(webviewId, htmlId));
      previous?.placeholder.remove();
      const placeholder = doc.createElement("div");
      placeholder.dataset.wxaHtmlId = String(htmlId);
      placeholder.style.cssText = "position:fixed;z-index:2147483647;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;background:#f7f7f7;color:#666;font:14px/1.6 sans-serif;text-align:center;word-break:break-all";
      const status = doc.createElement("div");
      const button = doc.createElement("button");
      button.textContent = "\u5728\u65B0\u7A97\u53E3\u6253\u5F00 H5";
      button.style.cssText = "padding:8px 16px;border:0;border-radius:4px;background:#07c160;color:#fff;font-size:14px";
      placeholder.append(status, button);
      place(placeholder, position);
      doc.body.appendChild(placeholder);
      const record = { webviewId, name: windowName(webviewId, htmlId), placeholder, status, src: previous?.src, win: previous?.win ?? null };
      this.records.set(record.name, record);
      button.addEventListener("click", () => {
        if (record.win && !record.win.closed) record.win.focus();
        else this.open(record);
      });
      this.render(record);
    }
    /** @returns 找不到这个 web-view 时为 false */
    update(webviewId, htmlId, position, src) {
      const record = this.records.get(windowName(webviewId, htmlId));
      if (!record) return false;
      place(record.placeholder, position);
      if (src && src !== record.src) {
        record.src = src;
        if (this.isShown(webviewId)) this.open(record);
        else this.render(record);
      }
      return true;
    }
    remove(webviewId, htmlId) {
      const record = this.records.get(windowName(webviewId, htmlId));
      if (!record) return;
      this.records.delete(record.name);
      close(record);
      record.placeholder.remove();
    }
    pageShown(webviewId) {
      for (const record of this.recordsOf(webviewId)) {
        if (record.src && !(record.win && !record.win.closed)) this.open(record);
      }
    }
    pageHidden(webviewId) {
      for (const record of this.recordsOf(webviewId)) {
        close(record);
        this.render(record);
      }
    }
    /** 页面关闭：渲染层已经或即将被删除，不必再动占位 */
    pageDestroyed(webviewId) {
      for (const record of this.recordsOf(webviewId)) {
        this.records.delete(record.name);
        close(record);
      }
    }
    closeAll() {
      for (const record of this.records.values()) close(record);
    }
    /** 页面里的 web-view，按创建顺序；还没设置 src 的不算 */
    list(webviewId) {
      return this.recordsOf(webviewId).flatMap((record) => record.src ? [{ src: record.src, windowName: record.name }] : []);
    }
    recordsOf(webviewId) {
      return [...this.records.values()].filter((record) => record.webviewId === webviewId);
    }
    open(record) {
      if (!record.src) return;
      if (record.win && !record.win.closed) {
        this.navigate(record);
      } else {
        const features = `popup,width=${this.device.screenWidth},height=${this.device.screenHeight}`;
        record.win = window.open(record.src, record.name, features);
        if (record.win) {
          record.opening = { src: record.src, at: Date.now() };
          notify("open", record.name, record.src);
        }
      }
      this.render(record);
    }
    /**
     * 已打开的窗口跳到最新的 src。用已有的引用跳转，不靠窗口名：网页可能改了自己的 window.name，按名字找不到时会多开一个窗口。
     *
     * Chrome 里新窗口的初始页面还没提交时改它的地址，这次跳转偶尔会被丢掉，窗口停在原来的网页上（不经过 CDP 也一样）。
     * 窗口刚打开就改 src 会碰上，所以等初始页面提交后再跳
     */
    navigate(record) {
      const win = record.win;
      if (!win || win.closed || !record.src || record.retry !== void 0) return;
      if (record.opening && !committed(win, record.opening.src) && Date.now() - record.opening.at < COMMIT_WAIT_MS) {
        record.retry = window.setTimeout(() => {
          record.retry = void 0;
          this.navigate(record);
        }, 20);
        return;
      }
      record.opening = void 0;
      win.location.href = record.src;
    }
    render(record) {
      const opened = record.win && !record.win.closed;
      const [title, detail] = !record.src ? ["web-view \u8FD8\u6CA1\u6709\u8BBE\u7F6E src", ""] : opened ? ["H5 \u5DF2\u5728\u65B0\u7A97\u53E3\u6253\u5F00", record.src] : record.win === null && this.isShown(record.webviewId) ? ["\u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u5F39\u51FA\u7A97\u53E3\uFF0C\u70B9\u4E0B\u9762\u7684\u6309\u94AE\u6253\u5F00 H5", record.src] : ["H5 \u5728\u65B0\u7A97\u53E3\u6253\u5F00", record.src];
      record.status.textContent = "";
      const heading = record.status.ownerDocument.createElement("div");
      heading.textContent = title;
      heading.style.cssText = "color:#333;font-size:16px";
      record.status.append(heading);
      if (detail) record.status.append(detail);
    }
  };
  function windowName(webviewId, htmlId) {
    return `wxa-h5-${webviewId}-${htmlId}`;
  }
  function committed(win, src) {
    try {
      return win.location.href !== "about:blank" || src === "about:blank";
    } catch {
      return true;
    }
  }
  function close(record) {
    clearTimeout(record.retry);
    record.retry = void 0;
    record.opening = void 0;
    if (!record.win) return;
    record.win.close();
    record.win = null;
    notify("close", record.name);
  }
  function notify(type, name, src) {
    const listener = window.__wxa_webview_window_event__;
    listener?.(type, name, src)?.catch(() => void 0);
  }
  function place(element2, position) {
    if (!position) return;
    for (const side of ["left", "top", "width", "height"]) {
      if (typeof position[side] === "number") element2.style[side] = `${position[side]}px`;
    }
  }
  var warnedOrigins = /* @__PURE__ */ new Set();
  function warnCrossSite(src) {
    let url;
    try {
      url = new URL(src, location.href);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(url.protocol)) return;
    if (url.hostname === location.hostname && url.protocol === location.protocol) return;
    if (warnedOrigins.has(url.origin)) return;
    warnedOrigins.add(url.origin);
    console.warn(
      `[wxa-runner] web-view \u52A0\u8F7D\u7684 ${url.origin} \u4E0E\u6A21\u62DF\u5668\uFF08${location.origin}\uFF09\u4E0D\u662F\u540C\u4E00\u4E2A\u7AD9\u70B9\uFF0C\u6D4F\u89C8\u5668\u6309\u8DE8\u7AD9\u5D4C\u5165\u5904\u7406\uFF0C\u7F51\u9875\u7684 Cookie \u53EF\u80FD\u4E0D\u751F\u6548\uFF08\u5FAE\u4FE1\u91CC\u7684\u5C0F\u7A0B\u5E8F\u6CA1\u6709\u8FD9\u4E2A\u95EE\u9898\uFF09\u3002\u9700\u8981 Cookie \u65F6\u8BA9\u7F51\u9875\u5728\u65B0\u7A97\u53E3\u6253\u5F00\uFF1A\u914D\u7F6E\u6587\u4EF6 wxa.config.ts \u91CC\u5199 webViewWindow: true\uFF0CPlaywright \u7528 test.use({ wxaWebView: 'window' })`
    );
  }
  function readableUrl(frame) {
    try {
      return frame.contentWindow?.location.href ?? null;
    } catch {
      return null;
    }
  }

  // src/runtime/host/webViewUrlHooks.ts
  var WebViewUrlHooks = class {
    constructor() {
      this.rewrites = [];
      /** 同一个 web-view 用同样的地址重复更新时不再重复打印 */
      this.logged = /* @__PURE__ */ new Set();
    }
    add(rewrite) {
      this.rewrites.push(rewrite);
    }
    get size() {
      return this.rewrites.length;
    }
    /** 依次套用所有规则；非 http(s) 地址原样返回 */
    rewrite(url, context) {
      if (!this.rewrites.length || !/^https?:/i.test(url)) return url;
      let current = url;
      for (const rewrite of this.rewrites) {
        try {
          const next = rewrite(current, context);
          if (typeof next === "string" && next && next !== current) current = next;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[wxa-runner] web-view \u5730\u5740\u6539\u5199\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\u8FD9\u6761\u89C4\u5219\uFF1A${message}`);
        }
      }
      if (current !== url) this.log(context, url, current);
      return current;
    }
    log(context, from, to) {
      const key = `${context.webviewId}-${context.htmlId}:${from}`;
      if (this.logged.has(key)) return;
      this.logged.add(key);
      console.info(`[wxa-runner] web-view \u5730\u5740\u88AB\u6539\u5199\uFF1A${from} \u2192 ${to}`);
    }
  };

  // src/runtime/host/PageStack.ts
  var MAX_PAGE_STACK = 10;
  var PageStack = class {
    constructor(max = MAX_PAGE_STACK) {
      this.max = max;
      this.items = [];
    }
    get size() {
      return this.items.length;
    }
    current() {
      return this.items[this.items.length - 1];
    }
    entries() {
      return [...this.items];
    }
    canPush() {
      return this.items.length < this.max;
    }
    push(item) {
      if (!this.canPush()) throw new Error("webview count limit exceed");
      this.items.push(item);
    }
    /** 至少保留栈底页面；返回被弹出的页面（栈顶在前） */
    pop(delta = 1) {
      const count = Math.max(0, Math.min(Math.floor(delta) || 1, this.items.length - 1));
      return this.items.splice(this.items.length - count, count).reverse();
    }
    /** 替换栈顶，返回原栈顶 */
    replaceTop(item) {
      const previous = this.items.pop();
      this.items.push(item);
      return previous;
    }
    /** 清空并放入新页面，返回原有页面 */
    reset(item) {
      const previous = this.items;
      this.items = [item];
      return previous.filter((existing) => existing !== item);
    }
  };

  // src/runtime/host/PageView.ts
  var PageView = class {
    constructor(id, path, query, container, version, navigation) {
      this.id = id;
      this.path = path;
      this.query = query;
      this.win = null;
      this.bridge = null;
      this.pending = [];
      this.navigation = navigation;
      this.ready = new Promise((resolve) => {
        this.markReady = resolve;
      });
      this.frame = document.createElement("iframe");
      this.frame.name = `wxa-webview-${id}`;
      this.frame.dataset.webviewId = String(id);
      this.frame.dataset.path = path;
      this.frame.style.visibility = "hidden";
      this.frame.src = `/__wxa__/webview/${path}.html?id=${id}&v=${version}`;
      container.appendChild(this.frame);
    }
    get url() {
      const query = new URLSearchParams(this.query).toString();
      return query ? `${this.path}?${query}` : this.path;
    }
    attach(win, bridge) {
      this.win = win;
      this.bridge = bridge;
      const pending = this.pending;
      this.pending = [];
      pending.forEach((dispatch) => dispatch(bridge, win));
    }
    /** 渲染层脚本全部执行完（含 generateFuncReady）后调用 */
    loaded() {
      this.markReady();
    }
    /** 渲染层还没注册桥时先缓存，注册后按顺序补发 */
    dispatch(fn) {
      if (this.bridge && this.win) fn(this.bridge, this.win);
      else this.pending.push(fn);
    }
    /**
     * 把逻辑层的画布放进这一页编号为 canvasNumber 的 wx-canvas，盖在它自己的 canvas 上（样式见 webviewHtml 的 .wxa-service-canvas）。
     * 编号在 wx-canvas 的组件实例上，DOM 节点经 __wxElement 找到组件实例
     */
    placeCanvas(canvas, canvasNumber) {
      const target = Array.from(this.win?.document.querySelectorAll("wx-canvas") ?? []).find((element2) => element2.__wxElement?._canvasNumber === canvasNumber);
      const own = target?.querySelector(":scope > canvas");
      if (!own) return false;
      canvas.classList.add("wxa-service-canvas");
      own.after(canvas);
      return true;
    }
    /** 页面样式里的 env(safe-area-inset-*) 构建时已改写成这些变量，见 rewriteSafeAreaInsets */
    setSafeAreaInsets(insets) {
      this.dispatch((_bridge, win) => {
        const style = win.document.documentElement.style;
        for (const [side, value] of Object.entries(insets)) {
          style.setProperty(`--wxa-safe-area-inset-${side}`, `${value}px`);
        }
      });
    }
    /** data-current 是给测试用的公开契约：iframe[data-current] 始终指向当前页 */
    show() {
      this.frame.style.visibility = "visible";
      this.frame.style.zIndex = "1";
      this.frame.dataset.current = "";
    }
    hide() {
      this.frame.style.visibility = "hidden";
      this.frame.style.zIndex = "0";
      delete this.frame.dataset.current;
    }
    destroy() {
      this.frame.remove();
      this.win = null;
      this.bridge = null;
    }
  };

  // src/runtime/host/realm.ts
  function cloneInto(win, value) {
    if (value === void 0) return value;
    return win.JSON.parse(JSON.stringify(value));
  }
  var BUFFER_KEY = "__wxa_array_buffer__";
  function cloneNativeInto(win, value) {
    if (value === void 0) return value;
    const buffers = [];
    const json = JSON.stringify(value, (_key, item) => {
      if (Object.prototype.toString.call(item) !== "[object ArrayBuffer]") return item;
      buffers.push(item);
      return { [BUFFER_KEY]: buffers.length - 1 };
    });
    const targetJson = win.JSON;
    if (!buffers.length) return targetJson.parse(json);
    return targetJson.parse(json, (_key, item) => item?.[BUFFER_KEY] === void 0 ? item : copyBuffer(win, buffers[item[BUFFER_KEY]]));
  }
  function copyBuffer(win, source) {
    const copy = new win.ArrayBuffer(source.byteLength);
    new Uint8Array(copy).set(new Uint8Array(source));
    return copy;
  }

  // src/runtime/host/ui/fileChooser.ts
  function chooseFiles(options) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = options.accept;
      input.multiple = options.multiple;
      if (options.capture) input.setAttribute("capture", "environment");
      input.style.display = "none";
      const finish = (files) => {
        input.remove();
        resolve(files);
      };
      input.addEventListener("change", () => finish(input.files?.length ? Array.from(input.files) : null));
      input.addEventListener("cancel", () => finish(null));
      document.body.appendChild(input);
      input.click();
    });
  }
  function hasUserActivation() {
    return navigator.userActivation?.isActive ?? true;
  }

  // src/runtime/host/ui/pageTransition.ts
  var DURATION = 300;
  function canAnimatePageTransition(frame) {
    return frame.isConnected && !document.hidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  async function animatePageTransition(previous, current, direction) {
    const viewport = current.parentElement;
    const body = current.contentDocument?.body;
    if (!viewport || previous.parentElement !== viewport || !body) return;
    const { visibility, zIndex } = previous.style;
    const outgoing = previous.contentDocument?.documentElement ?? previous;
    const wasInert = outgoing.inert;
    const shield = body.ownerDocument.createElement("div");
    shield.className = "wxa-page-transition-shield";
    shield.setAttribute("aria-hidden", "true");
    shield.style.cssText = "position: fixed; inset: 0; z-index: 2147483647; pointer-events: auto; background: transparent;";
    const sliding = direction === "push" ? current : previous;
    const transform = direction === "push" ? ["translateX(100%)", "translateX(0)"] : ["translateX(0)", "translateX(100%)"];
    let animation;
    let timer;
    try {
      outgoing.inert = true;
      body.append(shield);
      previous.style.visibility = "visible";
      if (direction === "pop") previous.style.zIndex = "2";
      animation = sliding.animate({ transform }, { duration: DURATION, easing: "ease", fill: "both" });
      await Promise.race([
        animation.finished.catch(() => void 0),
        // 切到后台后，浏览器可能暂停动画，路由队列仍需继续。
        new Promise((resolve) => {
          timer = setTimeout(resolve, DURATION + 60);
        })
      ]);
    } finally {
      clearTimeout(timer);
      animation?.cancel();
      previous.style.visibility = visibility;
      previous.style.zIndex = zIndex;
      outgoing.inert = wasInert;
      shield.remove();
    }
  }

  // src/runtime/host/ui/dom.ts
  function element(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== void 0) el.textContent = text;
    return el;
  }

  // src/runtime/host/ui/ImagePreview.ts
  function openImagePreview(container, urls, current) {
    const layer = element("div", "wxa-preview");
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-label", "\u56FE\u7247\u9884\u89C8");
    const image = document.createElement("img");
    image.className = "wxa-preview-image";
    const position = element("div", "wxa-preview-position");
    const prev = element("button", "wxa-preview-prev", "\u2039");
    prev.setAttribute("aria-label", "\u4E0A\u4E00\u5F20");
    const next = element("button", "wxa-preview-next", "\u203A");
    next.setAttribute("aria-label", "\u4E0B\u4E00\u5F20");
    let shown = 0;
    const show = (index) => {
      shown = Math.min(Math.max(index, 0), urls.length - 1);
      image.src = urls[shown];
      position.textContent = `${shown + 1}/${urls.length}`;
      prev.style.visibility = shown > 0 ? "" : "hidden";
      next.style.visibility = shown < urls.length - 1 ? "" : "hidden";
    };
    prev.addEventListener("click", () => show(shown - 1));
    next.addEventListener("click", () => show(shown + 1));
    layer.addEventListener("click", (event) => {
      if (event.target !== prev && event.target !== next) layer.remove();
    });
    layer.append(image, position, prev, next);
    container.appendChild(layer);
    show(current);
  }

  // src/runtime/host/ui/styles.ts
  var DEVICE_BEZEL = 13;
  var STAGE_PADDING = 24;
  var STAGE_GAP = 16;
  var PICKER_ITEM_HEIGHT = 48;
  var SHELL_CSS = `
html, body { margin: 0; height: 100%; background: radial-gradient(120% 80% at 50% 0%, #f6f7f9 0%, #e6e9ee 100%); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
.wxa-stage { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${STAGE_GAP}px; padding: ${STAGE_PADDING}px; box-sizing: border-box; }
.wxa-device-slot { position: relative; flex: none; }
.wxa-device { position: absolute; transform-origin: 0 0; overflow: hidden; background: #fff; border-radius: 6px; display: flex; flex-direction: column; box-shadow: 0 0 0 ${DEVICE_BEZEL - 2}px #111214, 0 0 0 ${DEVICE_BEZEL - 1}px #3a3b3f, 0 0 0 ${DEVICE_BEZEL}px #1b1c1f, 0 32px 64px -12px rgba(15,23,42,.35), 0 14px 28px -8px rgba(15,23,42,.18); }
.wxa-device.has-notch { border-radius: 40px; }
.wxa-notch { position: absolute; top: 0; left: 50%; z-index: 30; width: 209px; height: 30px; transform: translateX(-50%); background: #000; border-radius: 0 0 20px 20px; pointer-events: none; }
.wxa-notch::before, .wxa-notch::after { content: ''; position: absolute; top: 0; width: 6px; height: 6px; }
.wxa-notch::before { left: -6px; background: radial-gradient(circle at 0 100%, transparent 5.5px, #000 6px); }
.wxa-notch::after { right: -6px; background: radial-gradient(circle at 100% 100%, transparent 5.5px, #000 6px); }
.wxa-home-indicator { position: absolute; bottom: 8px; left: 50%; z-index: 30; width: 134px; height: 5px; transform: translateX(-50%); border-radius: 3px; background: rgba(0,0,0,.85); pointer-events: none; }
.wxa-statusbar { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; font-size: 12px; font-weight: 600; box-sizing: border-box; user-select: none; }
.wxa-statusbar-icons { display: flex; align-items: center; gap: 5px; }
.wxa-statusbar svg { display: block; }
.has-notch .wxa-statusbar { display: grid; grid-template-columns: 1fr 209px 1fr; align-items: start; padding: 15px 0 0; font-size: 15px; letter-spacing: -.2px; }
.has-notch .wxa-statusbar-time { grid-column: 1; justify-self: center; line-height: 20px; }
.has-notch .wxa-statusbar-icons { grid-column: 3; justify-self: center; height: 20px; }
.wxa-navbar { flex: none; height: 44px; position: relative; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
.wxa-navbar.is-hidden, .wxa-statusbar.is-hidden { display: none; }
.wxa-navbar-title { font-size: 17px; font-weight: 600; max-width: calc(100% - 204px); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wxa-navbar-back { position: absolute; left: 4px; top: 0; height: 44px; width: 44px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.wxa-navbar-loading { width: 14px; height: 14px; margin-right: 6px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: wxa-spin .8s linear infinite; display: none; }
.wxa-navbar.is-loading .wxa-navbar-loading { display: inline-block; }
.wxa-capsule { position: absolute; z-index: 6; display: flex; align-items: center; box-sizing: border-box; border-radius: 16px; border: .5px solid rgba(0,0,0,.12); background: rgba(255,255,255,.62); color: #000; -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); user-select: none; }
.wxa-capsule.is-light { border-color: rgba(255,255,255,.28); background: rgba(0,0,0,.18); color: #fff; }
.wxa-capsule > span { flex: 1; height: 100%; display: flex; align-items: center; justify-content: center; }
.wxa-capsule > span + span { position: relative; }
.wxa-capsule > span + span::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 1px; background: currentColor; opacity: .25; transform: scaleX(.5); }
.wxa-capsule svg { display: block; }
.wxa-pages { flex: 1; position: relative; overflow: hidden; }
.wxa-pages iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
.wxa-tabbar { flex: none; height: calc(50px + var(--wxa-safe-bottom, 0px)); padding-bottom: var(--wxa-safe-bottom, 0px); display: flex; border-top: .5px solid rgba(0,0,0,.1); box-sizing: border-box; }
.wxa-tabbar.is-hidden { display: none; }
.wxa-tabbar-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; cursor: pointer; user-select: none; gap: 2px; }
.wxa-tabbar-item img { width: 24px; height: 24px; display: block; }
.wxa-tabbar-icon, .wxa-tabbar-text { position: relative; }
.wxa-tabbar-badge { position: absolute; top: -4px; left: calc(100% - 6px); min-width: 16px; height: 16px; padding: 0 5px; box-sizing: border-box; border-radius: 8px; background: #fa5151; color: #fff; font-size: 11px; line-height: 16px; text-align: center; white-space: nowrap; }
.wxa-tabbar-dot { position: absolute; top: -2px; left: calc(100% - 2px); width: 8px; height: 8px; border-radius: 50%; background: #fa5151; }
.wxa-tabbar-text > .wxa-tabbar-badge { top: -10px; left: calc(100% + 1px); }
.wxa-tabbar-text > .wxa-tabbar-dot { top: -3px; left: calc(100% + 1px); }
.wxa-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 10; }
.wxa-mask { position: absolute; inset: 0; pointer-events: auto; }
.wxa-mask.is-dim { background: rgba(0,0,0,.5); }
.wxa-toast { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); min-width: 120px; max-width: 70%; padding: 14px 16px; border-radius: 8px; background: rgba(17,17,17,.75); color: #fff; font-size: 14px; text-align: center; box-sizing: border-box; pointer-events: none; }
.wxa-toast.has-icon { width: 136px; min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.wxa-toast-icon { font-size: 36px; line-height: 1; }
.wxa-toast-spinner { width: 34px; height: 34px; border: 3px solid #fff; border-right-color: transparent; border-radius: 50%; animation: wxa-spin .8s linear infinite; }
.wxa-modal { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 80%; background: #fff; border-radius: 12px; overflow: hidden; pointer-events: auto; text-align: center; }
.wxa-modal-title { padding: 24px 20px 8px; font-size: 17px; font-weight: 600; }
.wxa-modal-content { padding: 8px 20px 24px; font-size: 15px; color: #666; white-space: pre-wrap; word-break: break-word; }
.wxa-modal-input { width: calc(100% - 40px); margin: 0 20px 20px; padding: 8px; font-size: 15px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; }
.wxa-modal-actions { display: flex; border-top: 1px solid rgba(0,0,0,.1); }
.wxa-modal-actions button { flex: 1; height: 50px; border: 0; background: none; font-size: 17px; font-weight: 600; cursor: pointer; }
.wxa-modal-actions button + button { border-left: 1px solid rgba(0,0,0,.1); }
.wxa-actionsheet { position: absolute; left: 0; right: 0; bottom: 0; background: #f7f7f7; border-radius: 12px 12px 0 0; overflow: hidden; pointer-events: auto; }
.wxa-actionsheet-alert { padding: 16px; font-size: 13px; color: #888; text-align: center; background: #fff; }
.wxa-actionsheet button { display: block; width: 100%; height: 56px; border: 0; border-top: 1px solid rgba(0,0,0,.06); background: #fff; font-size: 17px; cursor: pointer; }
.wxa-actionsheet .wxa-actionsheet-cancel { margin-top: 8px; border-top: 0; }
.wxa-picker-layer .wxa-mask.is-dim { background: rgba(0,0,0,.6); animation: wxa-fade-in .3s ease forwards; }
.wxa-picker { position: absolute; left: 0; right: 0; bottom: 0; padding-bottom: var(--wxa-safe-bottom, 0px); background: #fff; pointer-events: auto; user-select: none; animation: wxa-slide-up .3s ease forwards; }
.wxa-picker-header { position: relative; display: flex; padding: 16px; font-size: 17px; line-height: 1.4; }
.wxa-picker-header::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; border-bottom: 1px solid rgba(0,0,0,.1); transform: scaleY(.5); transform-origin: 0 100%; }
.wxa-picker-header button { flex: 1; padding: 0; border: 0; background: none; font: inherit; cursor: pointer; }
.wxa-picker-cancel { color: rgba(0,0,0,.5); text-align: left; }
.wxa-picker-confirm { color: #07c160; text-align: right; }
.wxa-picker-body { position: relative; display: flex; height: ${PICKER_ITEM_HEIGHT * 5}px; overflow: hidden; }
.wxa-picker-column { flex: 1; min-width: 0; overflow-y: auto; padding: ${PICKER_ITEM_HEIGHT * 2}px 0; box-sizing: border-box; scroll-snap-type: y mandatory; overscroll-behavior: contain; scrollbar-width: none; }
.wxa-picker-column::-webkit-scrollbar { display: none; }
/* \u5F00\u53D1\u8005\u5DE5\u5177\u91CC\u9009\u9879\u6CA1\u6709\u5355\u72EC\u8BBE\u7F6E\u5B57\u53F7\uFF0C\u7EE7\u627F\u5230\u7684\u662F 11px\uFF08\u6309\u5B83\u7684\u622A\u56FE\u91CF\u5F97\uFF09 */
.wxa-picker-item { height: ${PICKER_ITEM_HEIGHT}px; line-height: ${PICKER_ITEM_HEIGHT}px; overflow: hidden; font-size: 11px; color: rgba(0,0,0,.9); text-align: center; white-space: nowrap; text-overflow: ellipsis; scroll-snap-align: center; cursor: pointer; }
.wxa-picker-mask { position: absolute; inset: 0; z-index: 1; pointer-events: none; background-image: linear-gradient(180deg, rgba(255,255,255,.95), rgba(255,255,255,.6)), linear-gradient(0deg, rgba(255,255,255,.95), rgba(255,255,255,.6)); background-position: top, bottom; background-size: 100% 92px; background-repeat: no-repeat; }
.wxa-picker-indicator { position: absolute; left: 0; right: 0; top: 92px; z-index: 1; height: 56px; pointer-events: none; }
.wxa-picker-indicator::before, .wxa-picker-indicator::after { content: ''; position: absolute; left: 0; right: 0; height: 1px; transform: scaleY(.5); }
.wxa-picker-indicator::before { top: 0; border-top: 1px solid rgba(0,0,0,.1); transform-origin: 0 0; }
.wxa-picker-indicator::after { bottom: 0; border-bottom: 1px solid rgba(0,0,0,.1); transform-origin: 0 100%; }
.wxa-preview { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #000; pointer-events: auto; }
.wxa-preview-image { max-width: 100%; max-height: 100%; object-fit: contain; }
.wxa-preview-position { position: absolute; top: 60px; left: 0; right: 0; color: #fff; font-size: 15px; text-align: center; pointer-events: none; }
.wxa-preview button { position: absolute; top: 50%; width: 40px; height: 56px; margin-top: -28px; border: 0; border-radius: 8px; background: rgba(255,255,255,.15); color: #fff; font-size: 28px; cursor: pointer; }
.wxa-preview .wxa-preview-prev { left: 8px; }
.wxa-preview .wxa-preview-next { right: 8px; }
.wxa-error { position: absolute; inset: 0; z-index: 20; overflow: auto; padding: 20px; background: #fff5f5; color: #c00; font: 12px/1.6 Menlo, monospace; white-space: pre-wrap; }
.wxa-toolbar { display: flex; align-items: center; gap: 10px; padding: 4px 4px 4px 12px; border-radius: 999px; background: rgba(255,255,255,.7); box-shadow: 0 1px 2px rgba(15,23,42,.08); font-size: 12px; color: #555; }
.wxa-toolbar button { border: 0; background: #111214; color: #fff; border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.wxa-toolbar .wxa-scale { min-width: 52px; background: #fff; color: #333; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); font-variant-numeric: tabular-nums; }
.wxa-route { font-family: Menlo, monospace; }
.wxa-notice { position: fixed; top: 16px; right: 16px; z-index: 100; display: flex; align-items: flex-start; gap: 10px; width: max-content; max-width: min(320px, calc(100vw - 32px)); padding: 12px 10px 12px 14px; box-sizing: border-box; border-radius: 12px; background: #fff; box-shadow: 0 0 0 1px rgba(15,23,42,.06), 0 12px 32px -8px rgba(15,23,42,.28); font-size: 13px; line-height: 20px; color: #555; animation: wxa-notice-in .18s ease-out; }
.wxa-notice-icon { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; background: #fa5151; color: #fff; font-size: 12px; font-weight: 700; line-height: 18px; text-align: center; }
.wxa-notice-text { flex: 1; min-width: 0; word-break: break-word; text-wrap: pretty; }
.wxa-notice-title { font-weight: 600; color: #111214; }
.wxa-notice-close { flex: none; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: none; color: #999; font-size: 16px; line-height: 20px; cursor: pointer; }
.wxa-notice-close:hover { background: rgba(0,0,0,.06); color: #111214; }
@keyframes wxa-spin { to { transform: rotate(360deg); } }
@keyframes wxa-fade-in { from { opacity: 0; } }
@keyframes wxa-slide-up { from { transform: translateY(100%); } }
@keyframes wxa-notice-in { from { opacity: 0; transform: translateY(-8px); } }
`;

  // src/runtime/host/ui/Picker.ts
  var SCROLL_SETTLE_DELAY = 100;
  function openPicker(container, options) {
    let resolve;
    const result = new Promise((done) => {
      resolve = done;
    });
    const layer = element("div", "wxa-picker-layer");
    const mask = element("div", "wxa-mask is-dim");
    const sheet = element("div", "wxa-picker");
    sheet.setAttribute("role", "dialog");
    const header = element("div", "wxa-picker-header");
    const cancel = element("button", "wxa-picker-cancel", "\u53D6\u6D88");
    const confirm = element("button", "wxa-picker-confirm", "\u786E\u5B9A");
    header.append(cancel, confirm);
    const body = element("div", "wxa-picker-body");
    const columns = options.columns.map((_, index) => new PickerColumn((next) => options.onColumnChange?.(index, next)));
    body.append(...columns.map((column) => column.el), element("div", "wxa-picker-mask"), element("div", "wxa-picker-indicator"));
    sheet.append(header, body);
    layer.append(mask, sheet);
    container.appendChild(layer);
    columns.forEach((column, index) => column.setItems(options.columns[index], options.current[index] ?? 0));
    const close2 = (value) => {
      layer.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => close2(null));
    mask.addEventListener("click", () => close2(null));
    confirm.addEventListener("click", () => {
      columns.forEach((column) => column.settle());
      close2(columns.map((column) => column.index));
    });
    return {
      result,
      setColumn(column, items, current) {
        columns[column]?.setItems(items, current);
      }
    };
  }
  var PickerColumn = class {
    constructor(onUserChange) {
      this.onUserChange = onUserChange;
      this.el = element("div", "wxa-picker-column");
      this.index = 0;
      this.items = [];
      this.el.addEventListener("scroll", () => {
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.settle(), SCROLL_SETTLE_DELAY);
      });
      this.el.addEventListener("click", (event) => {
        const item = event.target.closest(".wxa-picker-item");
        if (item) this.choose(Number(item.dataset.index));
      });
    }
    setItems(labels2, current) {
      this.items = labels2.map((label, index) => {
        const item = element("div", "wxa-picker-item", label);
        item.dataset.index = String(index);
        return item;
      });
      this.el.replaceChildren(...this.items);
      this.show(Math.min(Math.max(0, current), Math.max(0, labels2.length - 1)));
    }
    /** 滚动停下后，选中停在中间那一行的项 */
    settle() {
      clearTimeout(this.settleTimer);
      if (!this.items.length) return;
      const index = Math.min(this.items.length - 1, Math.max(0, Math.round(this.el.scrollTop / PICKER_ITEM_HEIGHT)));
      this.choose(index);
    }
    choose(index) {
      const changed = index !== this.index;
      this.show(index);
      if (changed) this.onUserChange(index);
    }
    show(index) {
      this.items[this.index]?.classList.remove("is-selected");
      this.index = index;
      this.items[index]?.classList.add("is-selected");
      this.el.scrollTo({ top: index * PICKER_ITEM_HEIGHT, behavior: "instant" });
    }
  };

  // src/runtime/host/ui/tabBarView.ts
  function tabBarView(config, selectedPath) {
    return {
      background: config.backgroundColor || "#f7f7f7",
      borderTopColor: config.borderStyle === "white" ? "rgba(255,255,255,.3)" : "rgba(0,0,0,.1)",
      items: config.list.map((item) => itemView(config, item, item.pagePath === selectedPath))
    };
  }
  function itemView(config, item, selected) {
    const icon = selected ? item.selectedIconPath || item.iconPath : item.iconPath;
    return {
      pagePath: item.pagePath,
      selected,
      color: selected ? config.selectedColor || "#07c160" : config.color || "#7a7e83",
      icon: icon ? iconUrl(icon) : null,
      text: item.text || "",
      mark: item.mark || null
    };
  }
  function iconUrl(path) {
    return /^https?:\/\//.test(path) ? path : "/" + path.replace(/^\//, "");
  }

  // src/runtime/host/ui/PhoneShell.ts
  var SCALE_STORAGE_KEY = "wxa-runner:scale";
  var MIN_SCALE = 0.5;
  var NOTICE_DURATION = 6e3;
  function loadScaleMode() {
    try {
      const saved = localStorage.getItem(SCALE_STORAGE_KEY);
      if (saved === "fit" || saved === "1") return saved;
    } catch {
    }
    return navigator.webdriver ? "1" : "fit";
  }
  var PhoneShell = class {
    constructor(root, profile) {
      this.profile = profile;
      this.scaleMode = loadScaleMode();
      this.toastEl = null;
      this.toastTimer = null;
      this.noticeEl = null;
      this.noticeTimer = null;
      this.tabBarConfig = null;
      this.onTabTap = () => void 0;
      this.navigation = { title: "", backgroundColor: "#000", textStyle: "white", showBack: false, custom: false };
      /** 当前页面是 tabBar 页面时为它的路径 */
      this.tabBarPath = null;
      /** wx.hideTabBar 设置，对所有 tab 页生效，直到 wx.showTabBar */
      this.tabBarHidden = false;
      const style = document.createElement("style");
      style.textContent = SHELL_CSS;
      document.head.appendChild(style);
      const hasNotch = profile.statusBarHeight > 20;
      const capsule = menuButtonRect(profile);
      root.innerHTML = `
      <div class="wxa-stage">
        <div class="wxa-device-slot">
          <div class="wxa-device${hasNotch ? " has-notch" : ""}" style="width:${profile.screenWidth}px;height:${profile.screenHeight}px;--wxa-safe-bottom:${profile.safeAreaBottom}px">
            <div class="wxa-statusbar" style="height:${profile.statusBarHeight}px">
              <span class="wxa-statusbar-time">9:41</span>
              <span class="wxa-statusbar-icons">${STATUS_ICONS}</span>
            </div>
            <div class="wxa-navbar">
              <button class="wxa-navbar-back" title="\u8FD4\u56DE" aria-label="\u8FD4\u56DE">${BACK_ICON}</button>
              <span class="wxa-navbar-loading"></span><span class="wxa-navbar-title"></span>
            </div>
            <div class="wxa-pages"></div>
            <div class="wxa-tabbar is-hidden"></div>
            <div class="wxa-capsule" style="top:${capsule.top}px;left:${capsule.left}px;width:${capsule.width}px;height:${capsule.height}px">
              <span class="wxa-capsule-more">${MORE_ICON}</span><span class="wxa-capsule-close">${CLOSE_ICON}</span>
            </div>
            <div class="wxa-overlay"></div>
            ${hasNotch ? '<div class="wxa-notch"></div>' : ""}
            ${profile.safeAreaBottom ? '<div class="wxa-home-indicator"></div>' : ""}
          </div>
        </div>
        <div class="wxa-toolbar">
          <span class="wxa-route"></span><button class="wxa-scale"></button><button class="wxa-reload">\u5237\u65B0</button>
        </div>
      </div>`;
      this.stage = root.querySelector(".wxa-stage");
      this.slot = root.querySelector(".wxa-device-slot");
      this.device = root.querySelector(".wxa-device");
      this.toolbar = root.querySelector(".wxa-toolbar");
      this.scaleButton = root.querySelector(".wxa-scale");
      this.statusBar = root.querySelector(".wxa-statusbar");
      this.navBar = root.querySelector(".wxa-navbar");
      this.capsule = root.querySelector(".wxa-capsule");
      this.navTitle = root.querySelector(".wxa-navbar-title");
      this.backButton = root.querySelector(".wxa-navbar-back");
      this.pages = root.querySelector(".wxa-pages");
      this.tabBar = root.querySelector(".wxa-tabbar");
      this.overlay = root.querySelector(".wxa-overlay");
      guardOverlayTouchClicks(this.overlay);
      this.routeLabel = root.querySelector(".wxa-route");
      root.querySelector(".wxa-reload").addEventListener("click", () => location.reload());
      this.scaleButton.addEventListener("click", () => {
        this.scaleMode = this.scaleMode === "fit" ? "1" : "fit";
        try {
          localStorage.setItem(SCALE_STORAGE_KEY, this.scaleMode);
        } catch {
        }
        this.applyScale();
      });
      window.addEventListener("resize", () => this.applyScale());
      this.applyScale();
    }
    /**
     * 窗口放不下时整体缩小手机。只用 transform：iframe 内的布局、字号、坐标都不变，
     * Playwright 也能正确换算点击位置；CSS zoom 会让 Playwright 点击错位。
     * transform 不改变占位，所以由外层 slot 按缩放后的尺寸占位。
     */
    applyScale() {
      const width = this.profile.screenWidth + DEVICE_BEZEL * 2;
      const height = this.profile.screenHeight + DEVICE_BEZEL * 2;
      let scale = 1;
      if (this.scaleMode === "fit") {
        const availableWidth = window.innerWidth - STAGE_PADDING * 2;
        const availableHeight = window.innerHeight - STAGE_PADDING * 2 - STAGE_GAP - this.toolbar.offsetHeight;
        const fit = Math.floor(Math.min(availableWidth / width, availableHeight / height) * 100) / 100;
        scale = Math.min(1, Math.max(MIN_SCALE, fit));
      }
      this.slot.style.width = `${width * scale}px`;
      this.slot.style.height = `${height * scale}px`;
      this.device.style.left = this.device.style.top = `${DEVICE_BEZEL * scale}px`;
      this.device.style.transform = scale === 1 ? "" : `scale(${scale})`;
      this.scaleButton.textContent = `${Math.round(scale * 100)}%`;
      this.scaleButton.title = this.scaleMode === "fit" ? "\u9002\u5E94\u7A97\u53E3\uFF0C\u70B9\u51FB\u5207\u6362\u4E3A\u5B9E\u9645\u5927\u5C0F" : "\u5B9E\u9645\u5927\u5C0F\uFF0C\u70B9\u51FB\u5207\u6362\u4E3A\u9002\u5E94\u7A97\u53E3";
    }
    onBack(handler) {
      this.backButton.addEventListener("click", handler);
    }
    async transitionPages(previous, current, direction) {
      const navWasInert = this.navBar.inert;
      const tabsWereInert = this.tabBar.inert;
      this.navBar.inert = true;
      this.tabBar.inert = true;
      try {
        await animatePageTransition(previous, current, direction);
      } finally {
        this.navBar.inert = navWasInert;
        this.tabBar.inert = tabsWereInert;
      }
    }
    setTabBar(config, onTap) {
      this.tabBarConfig = config && config.list?.length && !config.custom ? config : null;
      this.onTabTap = onTap;
    }
    setRoute(route) {
      this.routeLabel.textContent = route;
    }
    setNavigation(state) {
      this.navigation = { ...this.navigation, ...state };
      const { title, backgroundColor, textStyle, showBack, custom } = this.navigation;
      const color = textStyle === "black" ? "#000" : "#fff";
      this.navTitle.textContent = title;
      this.backButton.style.visibility = showBack ? "visible" : "hidden";
      this.navBar.classList.toggle("is-hidden", custom);
      this.navBar.style.background = backgroundColor;
      this.navBar.style.color = color;
      this.statusBar.style.background = custom ? "transparent" : backgroundColor;
      this.statusBar.style.color = color;
      this.capsule.classList.toggle("is-light", textStyle !== "black");
      this.statusBar.style.position = custom ? "absolute" : "";
      this.statusBar.style.left = this.statusBar.style.right = custom ? "0" : "";
      this.statusBar.style.zIndex = custom ? "5" : "";
    }
    getNavigation() {
      return { ...this.navigation };
    }
    setNavigationLoading(loading) {
      this.navBar.classList.toggle("is-loading", loading);
    }
    /** 该页面是否显示原生 tabBar（自定义 tabBar、被 wx.hideTabBar 隐藏的都不算） */
    hasTabBar(pagePath) {
      return !this.tabBarHidden && !!this.tabBarConfig?.list.some((item) => item.pagePath === pagePath);
    }
    setTabBarHidden(hidden) {
      this.tabBarHidden = hidden;
      this.renderTabBar(this.tabBarPath);
    }
    /** 没有原生 tabBar（未配置或自定义 tabBar）时什么都不做 */
    updateTabBarStyle(style) {
      if (!this.tabBarConfig) return;
      Object.assign(this.tabBarConfig, definedOnly(style));
      this.renderTabBar(this.tabBarPath);
    }
    /** 返回 false 表示 index 越界；没有原生 tabBar 时什么都不做 */
    updateTabBarItem(index, item) {
      if (!this.tabBarConfig) return true;
      const target = this.tabBarConfig.list[index];
      if (!target) return false;
      Object.assign(target, definedOnly(item));
      this.renderTabBar(this.tabBarPath);
      return true;
    }
    /**
     * 页面窗口里 env(safe-area-inset-*) 的取值：窗口贴着屏幕边缘的一侧才有安全区。
     * 默认导航栏下窗口在导航栏下方，tabBar 页面的窗口止于 tabBar 上方。
     */
    safeAreaInsetsFor(pagePath, navigation) {
      return {
        top: navigation.custom ? this.profile.statusBarHeight : 0,
        right: 0,
        bottom: this.hasTabBar(pagePath) ? 0 : this.profile.safeAreaBottom,
        left: 0
      };
    }
    /** 当前页面是 tabBar 页面时传入它的路径，否则传 null */
    renderTabBar(selectedPath) {
      const config = this.tabBarConfig;
      this.tabBarPath = selectedPath;
      const visible = this.tabBarVisible();
      this.tabBar.classList.toggle("is-hidden", !visible);
      if (!config || !visible) return;
      const view = tabBarView(config, selectedPath);
      this.tabBar.style.background = view.background;
      this.tabBar.style.borderTopColor = view.borderTopColor;
      this.tabBar.replaceChildren(...view.items.map((item, index) => this.tabBarItemElement(item, index)));
    }
    tabBarItemElement(item, index) {
      const el = element("div", "wxa-tabbar-item" + (item.selected ? " is-selected" : ""));
      el.dataset.pagePath = item.pagePath;
      el.style.color = item.color;
      const iconBox = element("span", "wxa-tabbar-icon");
      if (item.icon) {
        const img = document.createElement("img");
        img.src = item.icon;
        iconBox.appendChild(img);
        el.appendChild(iconBox);
      }
      const text = element("span", "wxa-tabbar-text", item.text);
      el.appendChild(text);
      if (item.mark) (item.icon ? iconBox : text).appendChild(markElement(item.mark));
      el.addEventListener("click", () => this.onTabTap(item.pagePath, index));
      return el;
    }
    tabBarVisible() {
      return this.tabBarPath !== null && this.hasTabBar(this.tabBarPath);
    }
    /** 页面可用高度，与 getSystemInfo().windowHeight 对应；tabBar 会连同底部安全区一起占掉 */
    windowHeight() {
      return this.profile.screenHeight - this.screenTop() - (this.tabBarVisible() ? TAB_BAR_HEIGHT + this.profile.safeAreaBottom : 0);
    }
    /** 页面窗口顶部到屏幕顶部的距离，与 getWindowInfo().screenTop 对应 */
    screenTop() {
      return this.navigation.custom ? 0 : this.profile.statusBarHeight + NAVIGATION_BAR_HEIGHT;
    }
    showToast(options) {
      this.hideToast();
      const icon = options.image ? "image" : options.icon || "success";
      const wrapper = document.createElement("div");
      if (options.mask) wrapper.appendChild(maskElement(false));
      const toast = document.createElement("div");
      toast.className = "wxa-toast" + (icon === "none" ? "" : " has-icon");
      toast.setAttribute("role", "alert");
      if (icon === "loading") {
        toast.appendChild(element("div", "wxa-toast-spinner"));
      } else if (icon === "image") {
        const img = document.createElement("img");
        img.src = options.image;
        img.width = img.height = 40;
        toast.appendChild(img);
      } else if (icon !== "none") {
        toast.appendChild(element("div", "wxa-toast-icon", icon === "error" ? "\u2715" : "\u2713"));
      }
      toast.appendChild(element("div", "wxa-toast-title", options.title || ""));
      wrapper.appendChild(toast);
      this.overlay.appendChild(wrapper);
      this.toastEl = wrapper;
      if (icon !== "loading" || options.duration) {
        this.toastTimer = setTimeout(() => this.hideToast(), options.duration ?? 1500);
      }
    }
    hideToast() {
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = null;
      this.toastEl?.remove();
      this.toastEl = null;
    }
    showModal(options) {
      return new Promise((resolve) => {
        const wrapper = document.createElement("div");
        wrapper.appendChild(maskElement(true));
        const modal = element("div", "wxa-modal");
        modal.setAttribute("role", "dialog");
        if (options.title) modal.appendChild(element("div", "wxa-modal-title", options.title));
        if (options.content && !options.editable) modal.appendChild(element("div", "wxa-modal-content", options.content));
        let input = null;
        if (options.editable) {
          input = document.createElement("input");
          input.className = "wxa-modal-input";
          input.value = options.content || "";
          input.placeholder = options.placeholderText || "";
          modal.appendChild(input);
        }
        const actions = element("div", "wxa-modal-actions");
        const close2 = (confirm2) => {
          wrapper.remove();
          resolve({ confirm: confirm2, cancel: !confirm2, ...options.editable ? { content: input.value } : {} });
        };
        if (options.showCancel !== false) {
          const cancel = element("button", "wxa-modal-cancel", options.cancelText || "\u53D6\u6D88");
          cancel.style.color = options.cancelColor || "#000";
          cancel.addEventListener("click", () => close2(false));
          actions.appendChild(cancel);
        }
        const confirm = element("button", "wxa-modal-confirm", options.confirmText || "\u786E\u5B9A");
        confirm.style.color = options.confirmColor || "#576b95";
        confirm.addEventListener("click", () => close2(true));
        actions.appendChild(confirm);
        modal.appendChild(actions);
        wrapper.appendChild(modal);
        this.overlay.appendChild(wrapper);
      });
    }
    showActionSheet(options) {
      return new Promise((resolve) => {
        const wrapper = document.createElement("div");
        const mask = maskElement(true);
        const sheet = element("div", "wxa-actionsheet");
        const close2 = (index) => {
          wrapper.remove();
          resolve(index);
        };
        if (options.alertText) sheet.appendChild(element("div", "wxa-actionsheet-alert", options.alertText));
        options.itemList.forEach((text, index) => {
          const button = element("button", "wxa-actionsheet-item", text);
          button.style.color = options.itemColor || "#000";
          button.addEventListener("click", () => close2(index));
          sheet.appendChild(button);
        });
        const cancel = element("button", "wxa-actionsheet-cancel", "\u53D6\u6D88");
        cancel.addEventListener("click", () => close2(null));
        sheet.appendChild(cancel);
        mask.addEventListener("click", () => close2(null));
        wrapper.append(mask, sheet);
        this.overlay.appendChild(wrapper);
      });
    }
    showPicker(options) {
      return openPicker(this.overlay, options);
    }
    showImagePreview(urls, current) {
      openImagePreview(this.overlay, urls, current);
    }
    /**
     * 在手机外面提示 wxa-runner 自身的问题（如借用开发者工具登录态失败），不混进小程序的界面。
     * 同一时间只显示一条，新的替换旧的：业务代码反复重试时不会堆满屏幕
     */
    showNotice(title, message) {
      this.hideNotice();
      const notice = element("div", "wxa-notice");
      notice.setAttribute("role", "alert");
      const text = element("div", "wxa-notice-text");
      text.append(element("div", "wxa-notice-title", title), element("div", "wxa-notice-message", message));
      const close2 = element("button", "wxa-notice-close", "\xD7");
      close2.setAttribute("aria-label", "\u5173\u95ED");
      close2.addEventListener("click", () => this.hideNotice());
      notice.append(element("span", "wxa-notice-icon", "!"), text, close2);
      this.stage.appendChild(notice);
      this.noticeEl = notice;
      this.noticeTimer = setTimeout(() => this.hideNotice(), NOTICE_DURATION);
    }
    hideNotice() {
      if (this.noticeTimer) clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
      this.noticeEl?.remove();
      this.noticeEl = null;
    }
    showError(message) {
      this.clearError();
      const el = element("div", "wxa-error", message);
      this.device.appendChild(el);
    }
    clearError() {
      this.device.querySelector(".wxa-error")?.remove();
    }
  };
  function markElement(mark) {
    return mark.type === "redDot" ? element("span", "wxa-tabbar-dot") : element("span", "wxa-tabbar-badge", mark.text);
  }
  function definedOnly(value) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== void 0));
  }
  function maskElement(dim) {
    return element("div", "wxa-mask" + (dim ? " is-dim" : ""));
  }
  function guardOverlayTouchClicks(overlay) {
    let press;
    overlay.addEventListener("pointerdown", (event) => {
      press = event.pointerType === "touch" && event.target instanceof Node ? { id: event.pointerId, target: event.target } : void 0;
    }, true);
    overlay.addEventListener("pointercancel", (event) => {
      if (press?.id === event.pointerId) press = void 0;
    }, true);
    overlay.addEventListener("click", (event) => {
      if (event.pointerType !== "touch") return;
      if (press?.id === event.pointerId) {
        const start = press;
        press = void 0;
        if (event.target instanceof Node && event.target.contains(start.target)) return;
      }
      event.stopPropagation();
    }, true);
  }
  var BACK_ICON = '<svg width="12" height="20" viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var MORE_ICON = '<svg width="22" height="8" viewBox="0 0 22 8" fill="currentColor"><circle cx="3.5" cy="4" r="2.3"/><circle cx="11" cy="4" r="3.3"/><circle cx="18.5" cy="4" r="2.3"/></svg>';
  var CLOSE_ICON = '<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="3.4" fill="currentColor"/></svg>';
  var STATUS_ICONS = [
    // 信号
    '<svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor"><rect x="0" y="7" width="3" height="4" rx=".8"/><rect x="4.6" y="5" width="3" height="6" rx=".8"/><rect x="9.2" y="2.6" width="3" height="8.4" rx=".8"/><rect x="13.8" y="0" width="3" height="11" rx=".8"/></svg>',
    // Wi-Fi
    '<svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 11.2L5.45 8.65A3.6 3.6 0 0 1 10.55 8.65ZM2.77 5.97A7.4 7.4 0 0 1 13.23 5.97L11.68 7.52A5.2 5.2 0 0 0 4.32 7.52ZM0.08 3.28A11.2 11.2 0 0 1 15.92 3.28L14.36 4.84A9 9 0 0 0 1.64 4.84Z"/></svg>',
    // 电池
    '<svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21.5" height="11" rx="3.2" fill="none" stroke="currentColor" stroke-opacity=".4"/><rect x="2" y="2" width="18.5" height="8" rx="1.8" fill="currentColor"/><path d="M23.4 4v4a2.2 2.2 0 0 0 0-4z" fill="currentColor" fill-opacity=".45"/></svg>'
  ].join("");

  // src/runtime/host/Host.ts
  var ROUTE_DONE_DELAY = 300;
  var PAGE_LOAD_TIMEOUT = 15e3;
  var BINDING_CANVAS_TYPES = /* @__PURE__ */ new Set(["2d", "webgl", "webgl2"]);
  var PROBE_TOP = -54321;
  var Host = class {
    /** @param sendReport 把报错发给开发服务器打印到终端，见 AppInfo.forwardConsole */
    constructor(info, root, sendReport = () => void 0) {
      this.info = info;
      this.errors = [];
      this.recentErrors = new RecentErrors();
      /** 小程序发出的 wx.request */
      this.requests = new RequestLog();
      this.api = new ApiRegistry((context) => this.reportUnimplemented(context));
      /** setup 和测试 API 声明的请求拦截 */
      this.routes = new RequestRoutes();
      /** setup 声明的 web-view 地址改写规则 */
      this.webViews = new WebViewUrlHooks();
      this.mapOperations = new MapOperations((webviewId, event, data) => this.publishToPages(event, data, [webviewId]));
      this.service = null;
      /** 新版基础库的业务子上下文；旧版基础库业务代码直接在逻辑层 iframe 里 */
      this.appContext = null;
      this.serviceReady = new Promise((resolve) => {
        this.serviceLoaded = resolve;
      });
      this.pages = /* @__PURE__ */ new Map();
      this.tabPages = /* @__PURE__ */ new Map();
      this.stack = new PageStack();
      this.nextWebviewId = 1;
      this.routeChain = Promise.resolve();
      this.routeListeners = [];
      /** 渲染层报来的 2d、webgl 画布，按编号记下所在页面和最近的位置，供 placeCanvas 认出逻辑层的画布元素 */
      this.canvases = /* @__PURE__ */ new Map();
      this.mockMirror = installMockMirror(info.externalServiceWorker);
      this.device = info.device;
      this.forwarder = new ConsoleForwarder(
        info.forwardConsole ?? false,
        sendReport,
        (kind, webviewId) => kind === "service" ? this.currentPage()?.path : this.pages.get(webviewId)?.path,
        (kind) => this.launchHints(kind)
      );
      this.shell = new PhoneShell(root, info.device);
      this.tabPaths = new Set((info.wxConfig.tabBar?.list || []).map((item) => stripHtml(item.pagePath)));
      this.storage = new MiniProgramStorage(window.localStorage, info.appid);
      this.webViewWindows = info.webViewWindow ? new WebViewWindows(info.device, (webviewId) => this.currentPage()?.id === webviewId) : null;
      if (this.webViewWindows) {
        const windows = this.webViewWindows;
        window.addEventListener("pagehide", () => windows.closeAll());
      }
      const tabBar = info.wxConfig.tabBar ? { ...info.wxConfig.tabBar, list: info.wxConfig.tabBar.list.map((item) => ({ ...item, pagePath: stripHtml(item.pagePath) })) } : void 0;
      this.shell.setTabBar(tabBar, (pagePath) => this.enqueueRoute(() => this.switchTab(pagePath)));
      this.shell.onBack(() => this.enqueueRoute(() => this.navigateBack(1)));
      this.registerApis();
    }
    async start(target) {
      const frame = document.createElement("iframe");
      frame.name = "wxa-appservice";
      frame.style.display = "none";
      const params = new URLSearchParams({ v: String(this.info.version), path: target.path, query: new URLSearchParams(target.query).toString() });
      frame.src = `/__wxa__/appservice.html?${params}`;
      document.body.appendChild(frame);
      document.addEventListener("visibilitychange", () => {
        const page = this.currentPage();
        if (!page) return;
        const event = document.hidden ? "onAppEnterBackground" : "onAppEnterForeground";
        this.emitToService(event, { path: page.path, query: page.query, scene: 1001, referrerInfo: {} });
      });
      await this.serviceReady;
      await this.enqueueRoute(() => this.launch(target));
    }
    // ---------------------------------------------------------------------------
    // HostApi：供 iframe 内的桥调用
    // ---------------------------------------------------------------------------
    registerFrame(kind, win, bridge, webviewId) {
      if (kind === "service") {
        this.service = { win, bridge };
      } else {
        this.pages.get(webviewId)?.attach(win, bridge);
      }
    }
    registerAppContext(win) {
      this.appContext = win;
    }
    /**
     * 逻辑层的画布元素上没有编号，只能问基础库：给每个还没放好的同类型画布发一条 top 带记号的 canvasUpdated，
     * 基础库把位置写到那个编号的元素上，记号落在这个元素上就是它；随后用原来的位置再发一次，恢复原样。
     * 基础库只在类型与画布一致时才调到元素的 getContext，按类型筛选不会漏掉
     */
    placeCanvas(canvas, type) {
      const service = this.service;
      if (!service) return;
      const update = (canvasNumber, record, top) => service.bridge.__dispatchSub(
        "canvasUpdated",
        this.cloneForService({ data: { canvasNumber, ...record.box, top }, options: { timestamp: Date.now() } }),
        record.webviewId
      );
      for (const [canvasNumber, record] of this.canvases) {
        if (record.placed || record.type !== type) continue;
        update(canvasNumber, record, PROBE_TOP);
        const matched = canvas.style.top === `${PROBE_TOP}px`;
        update(canvasNumber, record, record.box.top);
        if (matched) {
          record.placed = this.pages.get(record.webviewId)?.placeCanvas(canvas, canvasNumber) ?? false;
          return;
        }
      }
    }
    frameLoaded(kind, webviewId) {
      if (kind === "service") this.serviceLoaded();
      else this.pages.get(webviewId)?.loaded();
    }
    invoke(kind, win, api, args, callback) {
      const webviewId = kind === "webview" ? this.webviewIdOf(win) : this.currentPage()?.id ?? 0;
      const result = this.api.invoke(api, args, { api, from: kind, webviewId });
      const deliver = (res) => {
        if (callback) callback(cloneNativeInto(kind === "service" ? this.serviceWindow() : win, res));
      };
      if (result && typeof result.then === "function") {
        result.then(deliver);
      } else {
        deliver(result);
      }
    }
    publish(kind, win, event, data, webviewIds) {
      if (kind === "service") {
        this.publishToPages(event, data, webviewIds);
        return;
      }
      if (event === "operateMapCallback" && this.mapOperations.receive(data)) return;
      const fromId = this.webviewIdOf(win);
      this.trackCanvas(event, data?.data, fromId);
      const service = this.service;
      if (!service) return;
      const payload = this.cloneForService(data);
      queueMicrotask(() => service.bridge.__dispatchSub(event, payload, fromId));
    }
    /**
     * xr-frame 的画布不记：基础库收到它的 canvasUpdated 会派发 resize 给 xr-frame，探测会带来多余的 resize，
     * 而 xr-frame 在 wxa-runner 里没有验证过，保持原样
     */
    trackCanvas(event, data, webviewId) {
      if (!data) return;
      const record = this.canvases.get(data.canvasNumber);
      if (event === "canvasInserted" && data.type && BINDING_CANVAS_TYPES.has(data.type) && !data.isXrFrame) {
        this.canvases.set(data.canvasNumber, { webviewId, type: data.type, box: { top: 0, left: 0, width: 0, height: 0, ...boxOf(data) }, placed: false });
      } else if (event === "canvasUpdated" && record) {
        record.box = { ...record.box, ...boxOf(data) };
      } else if (event === "canvasRemoved") {
        this.canvases.delete(data.canvasNumber);
      }
    }
    /** 不指定目标时发给所有页面：旧版 canvas 的绘制指令就是这样发的，由 canvasNumber 找到对应画布 */
    publishToPages(event, data, webviewIds) {
      const targets = webviewIds?.length ? webviewIds.map((id) => this.pages.get(Number(id))) : this.livePages();
      const message = event === "canvasActionsChanged" ? withDrawableImages(data) : data;
      for (const page of targets) {
        page?.dispatch((bridge, target) => {
          const payload = cloneInto(target, message);
          queueMicrotask(() => bridge.__dispatchSub(event, payload, 0));
        });
      }
    }
    reportError(kind, webviewId, error) {
      const err = typeof error?.message === "string" ? error : null;
      const report = {
        kind,
        webviewId,
        message: err ? err.message : String(error),
        stack: typeof err?.stack === "string" ? err.stack : void 0
      };
      this.recordError(report);
    }
    get forwardConsole() {
      return this.forwarder.mode;
    }
    reportConsole(kind, webviewId, level, args) {
      const caught = level === "error" ? caughtError(args[0]) : null;
      if (caught) this.recordError({ kind, webviewId, ...caught });
      else this.forwarder.console(kind, webviewId, level, args);
    }
    recordError(report) {
      if (this.recentErrors.isRepeated(report.kind, report.webviewId, report.message, report.stack)) return;
      this.errors.push(report);
      this.forwarder.error(report.kind, report.webviewId, report.message, report.stack);
    }
    /**
     * 只记录逻辑层的公开 wx API 和 FileSystemManager 方法，每个原生接口一次。
     * 其余是基础库内部调用的原生接口（如 getPermissionBytes），业务既没调用也 mock 不了
     */
    reportUnimplemented({ api, from }) {
      if (from !== "service") return;
      const wx = this.serviceWindow()?.wx;
      const fileMethod = api.startsWith("fs_") ? api.slice(3) : api;
      const isFileApi = typeof wx?.getFileSystemManager?.()[fileMethod] === "function";
      if (typeof wx?.[api] !== "function" && !isFileApi) return;
      if (this.errors.some((error) => error.api === api)) return;
      const name = isFileApi ? `wx.getFileSystemManager().${fileMethod}` : `wx.${api}`;
      const message = `${name} \u5C1A\u672A\u5B9E\u73B0\uFF0C\u8FD4\u56DE\u4E86\u9ED8\u8BA4\u6210\u529F\u3002\u53EF\u4EE5\u7528 mock \u8986\u76D6\uFF0C\u542F\u52A8\u9636\u6BB5\u5C31\u8C03\u7528\u7684\u8981\u5728 setup \u91CC mock`;
      this.errors.push({ kind: "service", webviewId: 0, api, message });
      this.forwarder.warn(message);
    }
    /**
     * 逻辑层在首页创建前出错时的提示：onLaunch、启动阶段的接口回调里读 getCurrentPages()[0] 是常见原因，
     * 而报错本身只说读不到某个属性。被拦截的请求立即返回，比真机更容易在首页创建前执行回调
     */
    launchHints(kind) {
      return kind === "service" && !this.currentPage() ? ["\u51FA\u9519\u65F6\u9996\u9875\u8FD8\u6CA1\u521B\u5EFA\uFF0CgetCurrentPages() \u8FD4\u56DE\u7684\u662F\u7A7A\u6570\u7EC4"] : [];
    }
    // ---------------------------------------------------------------------------
    // 路由
    // ---------------------------------------------------------------------------
    currentPage() {
      return this.stack.current();
    }
    pageStack() {
      return this.stack.entries();
    }
    /** 所有活着的页面：页面栈加上隐藏中的 tabBar 页面 */
    livePages() {
      return [...this.pages.values()];
    }
    /** 业务代码所在的 window：getCurrentPages / wx 等在它上面 */
    serviceWindow() {
      return this.appContext ?? this.service?.win ?? null;
    }
    /**
     * 交给逻辑层的值属于业务代码所在的全局环境，而不是逻辑层 iframe：新版基础库不一定在业务子上下文里
     * 重建这些值，属于别的 iframe 的对象在业务代码里 instanceof 不成立，setData 也会把这样的数组当成普通对象
     */
    cloneForService(value) {
      return cloneInto(this.serviceWindow(), value);
    }
    onRoute(listener) {
      this.routeListeners.push(listener);
    }
    /** 路由操作串行执行，避免连续跳转时页面栈错乱 */
    enqueueRoute(operation) {
      const run = this.routeChain.then(operation, operation);
      this.routeChain = run.catch(() => void 0);
      return run;
    }
    async launch(target) {
      const page = await this.openPage(target.path, target.query);
      this.stack.reset(page);
      this.activate(page, "appLaunch");
    }
    async navigateTo(url, { animate = true } = {}) {
      if (!this.stack.canPush()) return fail("navigateTo", "webview count limit exceed");
      const { path, query } = this.resolveUrl(url);
      if (this.tabPaths.has(path)) return fail("navigateTo", "can not navigateTo a tabbar page");
      if (!this.hasPage(path)) return fail("navigateTo", `page "${path}" is not found`);
      const page = await this.openPage(path, query);
      const previous = this.currentPage();
      this.stack.push(page);
      this.activate(page, "navigateTo");
      if (animate && this.info.pageTransition && previous && canAnimatePageTransition(previous.frame)) {
        await this.shell.transitionPages(previous.frame, page.frame, "push");
      }
      return ok("navigateTo", { webviewId: page.id });
    }
    async navigateBack(delta) {
      if (this.stack.size <= 1) return fail("navigateBack", "cannot navigate back at first page.");
      const popped = this.stack.pop(delta);
      const outgoing = popped[0];
      const animate = this.info.pageTransition && outgoing && canAnimatePageTransition(outgoing.frame);
      for (const page of popped) {
        if (!animate || page !== outgoing) this.closePage(page);
      }
      const target = this.currentPage();
      try {
        this.activate(target, "navigateBack");
        if (animate) await this.shell.transitionPages(outgoing.frame, target.frame, "pop");
      } finally {
        if (animate) this.closePage(outgoing);
      }
      return ok("navigateBack");
    }
    async redirectTo(url) {
      const { path, query } = this.resolveUrl(url);
      if (this.tabPaths.has(path)) return fail("redirectTo", "can not redirectTo a tabbar page");
      if (!this.hasPage(path)) return fail("redirectTo", `page "${path}" is not found`);
      const page = await this.openPage(path, query);
      const previous = this.stack.replaceTop(page);
      if (previous) this.closePage(previous);
      this.activate(page, "redirectTo");
      return ok("redirectTo");
    }
    async reLaunch(url) {
      const { path, query } = this.resolveUrl(url);
      if (!this.hasPage(path)) return fail("reLaunch", `page "${path}" is not found`);
      const page = await this.openPage(path, query, { reuseTab: false });
      this.stack.reset(page).forEach((previous) => this.closePage(previous, { keepTab: false }));
      for (const [tabPath, tabPage] of this.tabPages) {
        if (tabPage !== page) {
          this.closePage(tabPage, { keepTab: false });
          this.tabPages.delete(tabPath);
        }
      }
      this.activate(page, "reLaunch");
      return ok("reLaunch");
    }
    async switchTab(url) {
      const { path } = this.resolveUrl(url);
      if (!this.tabPaths.has(path)) return fail("switchTab", "can not switch to no-tabBar page");
      if (this.currentPage()?.path === path && this.stack.size === 1) return ok("switchTab");
      const page = await this.openPage(path, {});
      this.stack.reset(page).forEach((previous) => this.closePage(previous));
      this.activate(page, "switchTab");
      return ok("switchTab");
    }
    async openPage(path, query, options = { reuseTab: true }) {
      const isTab = this.tabPaths.has(path);
      if (isTab && options.reuseTab && this.tabPages.has(path)) {
        return this.tabPages.get(path);
      }
      const page = new PageView(
        this.nextWebviewId++,
        path,
        query,
        this.shell.pages,
        this.info.version,
        this.navigationFor(path)
      );
      page.setSafeAreaInsets(this.shell.safeAreaInsetsFor(path, page.navigation));
      this.pages.set(page.id, page);
      if (isTab) this.tabPages.set(path, page);
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => {
          console.error(`[wxa-runner] \u9875\u9762 ${path} \u7684\u6E32\u67D3\u5C42 ${PAGE_LOAD_TIMEOUT}ms \u5185\u6CA1\u6709\u52A0\u8F7D\u5B8C\u6210\uFF0C\u8BF7\u68C0\u67E5\u63A7\u5236\u53F0\u62A5\u9519`);
          resolve();
        }, PAGE_LOAD_TIMEOUT);
      });
      await Promise.race([page.ready, timedOut]);
      clearTimeout(timer);
      return page;
    }
    closePage(page, options = { keepTab: true }) {
      if (options.keepTab && this.tabPaths.has(page.path) && this.tabPages.get(page.path) === page) {
        this.hidePage(page);
        return;
      }
      if (this.tabPages.get(page.path) === page) this.tabPages.delete(page.path);
      this.pages.delete(page.id);
      this.webViewWindows?.pageDestroyed(page.id);
      page.destroy();
      for (const [canvasNumber, record] of this.canvases) {
        if (record.webviewId === page.id) this.canvases.delete(canvasNumber);
      }
    }
    activate(page, openType) {
      for (const other of this.pages.values()) {
        if (other !== page) this.hidePage(other);
      }
      page.show();
      this.webViewWindows?.pageShown(page.id);
      page.navigation = { ...page.navigation, showBack: this.stack.size > 1 };
      this.shell.setNavigation(page.navigation);
      this.shell.renderTabBar(this.tabPaths.has(page.path) ? page.path : null);
      this.shell.setRoute(page.url);
      this.updateLocation(page);
      const data = { path: page.path, query: page.query, openType, webviewId: page.id };
      this.emitToService("onAppRoute", data, page.id);
      setTimeout(() => {
        if (this.currentPage() === page) this.emitToService("onAppRouteDone", data, page.id);
      }, ROUTE_DONE_DELAY);
      this.routeListeners.forEach((listener) => listener(page, openType));
    }
    hidePage(page) {
      page.hide();
      this.webViewWindows?.pageHidden(page.id);
    }
    /** 页面里设置过 src 的 web-view，按创建顺序 */
    webViewsOf(page) {
      return this.webViewWindows ? this.webViewWindows.list(page.id) : iframeWebViews(page.win?.document);
    }
    /** 宿主地址栏同步为当前页面，刷新后可回到同一页面 */
    updateLocation(page) {
      const params = new URLSearchParams(location.search);
      params.set("path", page.path);
      for (const key of [...params.keys()]) {
        if (key !== "path") params.delete(key);
      }
      for (const [key, value] of Object.entries(page.query)) params.set(key, value);
      history.replaceState(null, "", `${location.pathname}?${params}`);
    }
    navigationFor(path) {
      const window2 = {
        ...this.info.wxConfig.global?.window,
        ...this.info.wxConfig.page?.[path + ".html"]?.window
      };
      return {
        title: window2.navigationBarTitleText || "",
        backgroundColor: window2.navigationBarBackgroundColor || "#000000",
        textStyle: window2.navigationBarTextStyle === "black" ? "black" : "white",
        showBack: false,
        custom: window2.navigationStyle === "custom"
      };
    }
    hasPage(path) {
      return this.info.pages.includes(path);
    }
    /**
     * 基础库调用路由 API 前已经把相对路径解析成根路径并加上 .html（如 "pages/a/a.html?id=1"），
     * 这里只做格式归一。
     */
    resolveUrl(url) {
      const [rawPath, rawQuery = ""] = String(url || "").split("?");
      const path = stripHtml(rawPath.replace(/^\/+/, ""));
      return { path, query: Object.fromEntries(new URLSearchParams(rawQuery)) };
    }
    // ---------------------------------------------------------------------------
    // 事件
    // ---------------------------------------------------------------------------
    emitToService(event, data, webviewId) {
      const service = this.service;
      if (!service) return;
      const payload = cloneNativeInto(this.serviceWindow(), data);
      queueMicrotask(() => service.bridge.__dispatchOn(event, payload, webviewId));
    }
    /** 派发给渲染层的原生事件（渲染层里 WeixinJSBridge.on 收到） */
    emitToWebview(webviewId, event, data) {
      this.pages.get(webviewId)?.dispatch((bridge, target) => {
        const payload = cloneNativeInto(target, data);
        queueMicrotask(() => bridge.__dispatchOn(event, payload, webviewId));
      });
    }
    webviewIdOf(win) {
      for (const page of this.pages.values()) {
        if (page.win === win) return page.id;
      }
      return 0;
    }
    updateNavigation(state) {
      const page = this.currentPage();
      if (!page) return;
      page.navigation = { ...page.navigation, ...Object.fromEntries(Object.entries(state).filter(([, v]) => v !== void 0)) };
      this.shell.setNavigation(page.navigation);
    }
    /** tabBar 显隐改变 tab 页窗口是否贴着屏幕底边，已打开的 tab 页要同步底部安全区 */
    setTabBarHidden(hidden) {
      this.shell.setTabBarHidden(hidden);
      for (const page of this.tabPages.values()) {
        page.setSafeAreaInsets(this.shell.safeAreaInsetsFor(page.path, page.navigation));
      }
    }
    registerApis() {
      const routeApi = (handler) => (args) => this.enqueueRoute(() => handler(args));
      this.api.register({
        navigateTo: routeApi((args) => this.navigateTo(args.url)),
        navigateBack: routeApi((args) => this.navigateBack(args.delta || 1)),
        redirectTo: routeApi((args) => this.redirectTo(args.url)),
        reLaunch: routeApi((args) => this.reLaunch(args.url)),
        switchTab: routeApi((args) => this.switchTab(args.url)),
        ...createStorageApis(this.storage),
        ...createSubpackageApis({
          subPackages: this.info.wxConfig.subPackages || [],
          workers: this.info.wxConfig.workers,
          emit: (event, data) => this.emitToService(event, data)
        }),
        ...createSavedFileApis(this.storage),
        ...createFileSystemApis(),
        ...createSystemApis({
          device: this.device,
          baseLibVersion: this.info.baseLibVersion,
          windowHeight: () => this.shell.windowHeight(),
          screenTop: () => this.shell.screenTop()
        }),
        ...createNetworkApis({
          socketProxy: this.info.socketProxy,
          defaultSocketTimeout: () => this.info.wxConfig.networkTimeout?.connectSocket || 6e4,
          emit: (event, data) => this.emitToService(event, data),
          defaultTimeout: () => this.info.wxConfig.networkTimeout?.request || 6e4,
          routes: this.routes,
          onRequest: (request) => this.requests.add(request),
          onMocked: (request, response, signal) => this.mockMirror?.show(request, response, signal)
        }),
        ...createAudioApis({ emit: (event, data) => this.emitToService(event, data) }),
        ...createMapApis({ registry: this.api, operations: this.mapOperations }),
        ...createLibFileApis({ windowOf: (webviewId) => this.pages.get(webviewId)?.win }),
        ...createUiApis({
          shell: this.shell,
          updateNavigation: (state) => this.updateNavigation(state),
          setTabBarHidden: (hidden) => this.setTabBarHidden(hidden)
        }),
        ...createMediaApis({
          showActionSheet: (options) => this.shell.showActionSheet(options),
          chooseFiles,
          hasUserActivation,
          showImagePreview: (urls, current) => this.shell.showImagePreview(urls, current)
        }),
        ...createPickerApis({
          showPicker: (options) => this.shell.showPicker(options),
          emitToWebview: (webviewId, event, data) => this.emitToWebview(webviewId, event, data),
          loadRegionData: fetchRegionData
        }),
        ...createWebViewApis({
          documentOf: (webviewId) => this.pages.get(webviewId)?.win?.document,
          emitToWebview: (webviewId, event, data) => this.emitToWebview(webviewId, event, data),
          windows: this.webViewWindows,
          rewriteUrl: (url, context) => this.webViews.rewrite(url, context),
          pagePathOf: (webviewId) => this.pages.get(webviewId)?.path ?? null
        }),
        ...createMiscApis(this.info.appid, {
          devtoolsLogin: this.info.devtoolsLogin,
          onDevtoolsLoginFail: (api, reason2) => this.shell.showNotice(`wx.${api} \u501F\u7528\u5F00\u53D1\u8005\u5DE5\u5177\u767B\u5F55\u6001\u5931\u8D25`, reason2)
        })
      });
    }
  };
  function withDrawableImages(message) {
    const actions = message?.data?.actions;
    if (!Array.isArray(actions)) return message;
    return {
      ...message,
      data: {
        ...message.data,
        actions: actions.map((action) => {
          const [src, ...rest] = action.data ?? [];
          return action.method === "drawImage" && typeof src === "string" ? { ...action, data: [tempFileRootPath(src), ...rest] } : action;
        })
      }
    };
  }
  function boxOf(data) {
    const box = {};
    for (const key of ["top", "left", "width", "height"]) {
      if (data[key] !== void 0) box[key] = data[key];
    }
    return box;
  }
  function stripHtml(path) {
    return path.replace(/\.html$/, "");
  }

  // src/runtime/host/hmr.ts
  async function applyHotUpdate(host, update) {
    const code = await fetchHotCode(update);
    await host.enqueueRoute(async () => {
      const service = host.serviceWindow();
      if (!service?.__virtualDOM__?.updateWxAppCode) throw new Error("\u57FA\u7840\u5E93\u7684\u70ED\u66F4\u65B0\u5F00\u5173\u6CA1\u6709\u6253\u5F00");
      const pageWindows = host.livePages().flatMap((page) => page.win ? [page.win] : []);
      if (code.pageStyles !== null) {
        for (const win of pageWindows) updateStyles(win, code.pageStyles);
      }
      if (code.templates) {
        for (const win of pageWindows) updateTemplates(win, code.templates.page, update.templates);
        updateTemplates(service, code.templates.service, update.templates);
      }
      update.scripts.forEach((id, index) => updateScript(service, host, id, code.scripts[index]));
    });
  }
  async function fetchHotCode(update) {
    const v = `?v=${update.version}`;
    const [pageStyles, templates, scripts] = await Promise.all([
      update.styles.length > 0 ? fetchText(`/__wxa__/page-styles.js${v}`) : null,
      update.templates.length > 0 ? Promise.all([fetchText(`/__wxa__/page-templates.js${v}`), fetchText(`/__wxa__/service-templates.js${v}`)]).then(([page, service]) => ({ page, service })) : null,
      Promise.all(update.scripts.map((id) => fetchText(`/__wxa__/module/${encodeURI(id)}.js${v}`)))
    ]);
    return { pageStyles, templates, scripts };
  }
  function updateStyles(win, code) {
    const sheets = win.__styleSheetManager2__?._pathMap;
    if (!sheets) throw new Error("\u57FA\u7840\u5E93\u6CA1\u6709\u6837\u5F0F\u8868\u7BA1\u7406\u5668\uFF0C\u65E0\u6CD5\u70ED\u66FF\u6362\u6837\u5F0F");
    const applied = Object.keys(sheets);
    runScript2(win, code);
    for (const key of applied) {
      const [, file, classPrefix] = /^\.\/(.+\.wxss):(.*)$/.exec(key) || [];
      const inject = file && win.__wxAppCode__[file];
      if (typeof inject === "function") inject(classPrefix);
    }
    restoreSheetOrder(Object.values(sheets));
    win.wx.triggerPageReRender();
  }
  function restoreSheetOrder(sheets) {
    let next = null;
    for (const { inserted, style } of sheets.reverse()) {
      if (!inserted || !style.isConnected) continue;
      if (next && style.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_PRECEDING) next.before(style);
      next = style;
    }
  }
  function updateTemplates(win, code, units) {
    const cache = win.__WXML_GLOBAL__;
    if (cache) Object.assign(cache, { ops_cached: {}, ops_set: {}, ops_init: {}, debuginfo_set: {}, modules: {} });
    runScript2(win, code);
    for (const id of units) {
      const generate = win.__wxAppCode__[id + ".wxml"];
      if (generate) win.__virtualDOM__.updateWxAppCode(id + ".wxml", generate);
    }
  }
  var hotModuleSeq = 0;
  function updateScript(service, host, id, moduleScript) {
    const registration = loadModule(service, moduleScript, `${id}.hot-${++hotModuleSeq}.js`);
    if (!registration) throw new Error(`${id}.js \u6CA1\u6709\u8C03\u7528 Page() \u6216 Component()\uFF0C\u65E0\u6CD5\u70ED\u66F4\u65B0`);
    if (registration.constructor === service.Page) {
      for (const page of host.livePages()) {
        if (page.path !== id) continue;
        const instance = service.__virtualDOM__.getRootNode(page.id)?.__methodCaller;
        if (!instance) throw new Error(`\u627E\u4E0D\u5230\u9875\u9762 ${id}\uFF08webviewId ${page.id}\uFF09\u7684\u5B9E\u4F8B`);
        swapMethods(instance, registration.options);
      }
      register(service, id, registration);
      return;
    }
    let registered = false;
    service.__virtualDOM__.updateWxAppCode(`${id}.js`, () => {
      register(service, id, registration);
      registered = true;
    });
    if (!registered) throw new Error(`\u57FA\u7840\u5E93\u6CA1\u6709\u767B\u8BB0 ${id}.js \u7684\u70ED\u66F4\u65B0\u56DE\u8C03`);
  }
  function register(service, id, { constructor, options }) {
    service.__wxRoute = id;
    service.__wxRouteBegin = true;
    service.__wxAppCurrentFile__ = id + ".js";
    constructor(options);
  }
  function loadModule(service, script, hotId) {
    let factory;
    service.__wxaHotDefine__ = (_id, fn) => {
      factory = fn;
    };
    try {
      runScript2(service, `(function (define) {
${script}
})(__wxaHotDefine__);`);
    } finally {
      delete service.__wxaHotDefine__;
    }
    if (typeof factory !== "function") throw new Error("\u6A21\u5757\u811A\u672C\u6CA1\u6709 define \u6A21\u5757");
    service.define(hotId, factory);
    const { Page, Component } = service;
    let registration;
    service.Page = (options) => {
      registration = { constructor: Page, options };
    };
    service.Component = (options) => {
      registration = { constructor: Component, options };
    };
    try {
      if (service.Page === Page || service.Component === Component) throw new Error("\u65E0\u6CD5\u62E6\u622A Page / Component");
      service.require(hotId);
    } finally {
      service.Page = Page;
      service.Component = Component;
    }
    return registration;
  }
  function swapMethods(instance, definition) {
    for (const [key, value] of Object.entries(definition)) {
      if (typeof value === "function") instance[key] = value;
      else if (key !== "data" && !(key in instance)) instance[key] = value;
    }
    const data = definition.data || {};
    const added = Object.keys(data).filter((key) => !(key in instance.data));
    if (added.length) instance.setData(Object.fromEntries(added.map((key) => [key, data[key]])));
  }
  function runScript2(win, code) {
    let failed = false;
    let error;
    const onError = (event) => {
      failed = true;
      error = event.error ?? new Error(event.message);
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    const script = win.document.createElement("script");
    script.text = code;
    win.addEventListener("error", onError, true);
    try {
      win.document.head.appendChild(script);
    } finally {
      win.removeEventListener("error", onError, true);
      script.remove();
    }
    if (failed) throw error;
  }
  async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} ${response.status}`);
    return response.text();
  }

  // src/runtime/host/pageStackRestore.ts
  var PageStackRestore = class {
    /** 按 appid 区分：同一个标签页换了项目时不会串用 */
    constructor(appid) {
      this.key = `wxa-runner:reload-page-stack:${appid}`;
      this.saved = read(this.key);
      this.restoring = this.saved.length > 0;
    }
    /** 启动页：记下的第一页；记下的页面已经不存在时，从它开始往后都不恢复 */
    launchTarget(pages, fallback) {
      const invalid = this.saved.findIndex((entry) => !pages.includes(entry.path));
      if (invalid >= 0) this.saved = this.saved.slice(0, invalid);
      return this.saved[0] ?? fallback;
    }
    /**
     * 在已启动的第一页之上依次 navigateTo 其余页面；某一页打不开就停下
     *
     * 整段放进同一个路由任务：恢复期间开发者点返回、切 tab 会排在恢复完成之后
     */
    async reopen(host) {
      try {
        await host.enqueueRoute(async () => {
          for (const { path, query } of this.saved.slice(1)) {
            const search = new URLSearchParams(query).toString();
            const result = await host.navigateTo(search ? `${path}?${search}` : path, { animate: false });
            if (!String(result.errMsg).endsWith(":ok")) {
              console.warn(`[wxa-runner] \u6062\u590D\u9875\u9762\u6808\u65F6\u6253\u4E0D\u5F00 ${path}\uFF1A${result.errMsg}`);
              return;
            }
          }
        });
      } finally {
        this.restoring = false;
      }
    }
    /** 记下当前页面栈后整页刷新 */
    reload(host) {
      const stack = this.restoring ? this.saved : host?.pageStack().map((page) => ({ path: page.path, query: page.query })) ?? [];
      if (stack.length) {
        try {
          sessionStorage.setItem(this.key, JSON.stringify(stack));
        } catch {
        }
      }
      location.reload();
    }
  };
  function read(key) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "[]");
      sessionStorage.removeItem(key);
      if (!Array.isArray(saved)) return [];
      return saved.filter((entry) => entry && typeof entry.path === "string").map((entry) => ({ path: entry.path, query: { ...entry.query } }));
    } catch {
      return [];
    }
  }

  // src/runtime/host/setup.ts
  var CONFIG_KEYS = ["storage", "mock", "network", "webView", "run"];
  var NETWORK_KEYS = ["routes"];
  var WEBVIEW_KEYS = ["rewriteUrl"];
  var STORAGE_NAMESPACE = "s0";
  var TASK_APIS = /* @__PURE__ */ new Set(["request", "downloadFile", "uploadFile", "connectSocket"]);
  var STORAGE_API = /^(get|set|remove|clear)Storage(Info)?(Sync)?$/;
  async function applySetup(definition, target, env) {
    const summary = { storage: [], mock: [], network: [], webView: 0 };
    const record = (list, name) => {
      if (!list.includes(name)) list.push(name);
    };
    const setStorage = (key, value, label = key) => {
      let encoded;
      try {
        encoded = encodeStorageValue(value);
      } catch (error) {
        throw new Error(`storage.${label}\uFF1A${error.message}`);
      }
      target.storage.set(STORAGE_NAMESPACE, key, encoded.data, encoded.dataType);
      record(summary.storage, key);
    };
    const mock = (api, impl) => {
      checkMock(api, impl);
      target.api.mock(api, impl);
      record(summary.mock, api);
    };
    const route = (pattern, handler) => {
      try {
        target.routes.add(pattern, handler);
      } catch (error) {
        throw new Error(`network.routes[${JSON.stringify(pattern)}]\uFF1A${error.message}`);
      }
      record(summary.network, pattern);
    };
    const rewriteWebViewUrl = (rewrite) => {
      if (typeof rewrite !== "function") throw new Error("rewriteWebViewUrl \u9700\u8981\u4F20\u5165\u51FD\u6570");
      target.webViews.add(rewrite);
      summary.webView = target.webViews.size;
    };
    const config = await resolveConfig(definition, env);
    for (const [key, value] of Object.entries(config.storage || {})) setStorage(key, value);
    for (const [api, impl] of Object.entries(config.mock || {})) mock(api, impl);
    for (const [pattern, handler] of Object.entries(config.network?.routes || {})) route(pattern, handler);
    if (config.webView?.rewriteUrl) rewriteWebViewUrl(config.webView.rewriteUrl);
    if (config.run) {
      const wxa = {
        env,
        storage: {
          get: (key) => {
            const item = target.storage.get(STORAGE_NAMESPACE, key);
            return item ? decodeStorageValue(item) : void 0;
          },
          set: (key, value) => setStorage(key, value),
          remove: (key) => target.storage.remove(STORAGE_NAMESPACE, key),
          clear: () => target.storage.clear(STORAGE_NAMESPACE)
        },
        mock: (api, impl) => mock(api, impl),
        route,
        rewriteWebViewUrl,
        fetch: (url, init = {}) => proxyFetch(url, { method: (init.method || "GET").toUpperCase(), header: init.header, body: init.body }).then((res) => new Response(NULL_BODY_STATUS.has(res.statusCode) ? null : res.response.body, {
          status: res.statusCode,
          headers: res.header
        }))
      };
      await config.run(wxa);
    }
    return summary;
  }
  function formatSetupSummary(summary) {
    const lines = ["[wxa-runner] setup \u5DF2\u5E94\u7528"];
    if (summary.storage.length) lines.push(`  storage  ${summary.storage.join(", ")}`);
    if (summary.mock.length) lines.push(`  mock     ${summary.mock.join(", ")}`);
    if (summary.network.length) lines.push(`  network  ${summary.network.join(", ")}`);
    if (summary.webView) lines.push(`  webView  ${summary.webView} \u6761\u6539\u5199\u89C4\u5219`);
    return lines.join("\n");
  }
  var NULL_BODY_STATUS = /* @__PURE__ */ new Set([101, 204, 205, 304]);
  async function resolveConfig(definition, env) {
    const config = typeof definition === "function" ? await definition({ env }) : definition;
    if (!isPlainObject(config)) {
      throw new Error("setup \u6587\u4EF6\u9700\u8981 export default \u4E00\u4E2A\u914D\u7F6E\u5BF9\u8C61\uFF0C\u6216\u8FD4\u56DE\u914D\u7F6E\u5BF9\u8C61\u7684\u51FD\u6570\uFF08\u53EF\u7528 defineSetup \u5305\u4E00\u5C42\u83B7\u5F97\u7C7B\u578B\u63D0\u793A\uFF09");
    }
    const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.includes(key));
    if (unknown.length) {
      throw new Error(`\u672A\u77E5\u7684\u914D\u7F6E\u9879 ${unknown.join(", ")}\uFF0C\u53EF\u7528\u7684\u914D\u7F6E\u9879\uFF1A${CONFIG_KEYS.join(", ")}`);
    }
    if (config.storage !== void 0 && !isPlainObject(config.storage)) throw new Error("storage \u9700\u8981\u662F { key: \u503C } \u5F62\u5F0F\u7684\u5BF9\u8C61");
    if (config.mock !== void 0 && !isPlainObject(config.mock)) throw new Error("mock \u9700\u8981\u662F { API \u540D: \u8FD4\u56DE\u503C\u6216\u51FD\u6570 } \u5F62\u5F0F\u7684\u5BF9\u8C61");
    if (config.network !== void 0) {
      if (!isPlainObject(config.network)) throw new Error("network \u9700\u8981\u662F { routes: { \u89C4\u5219: \u54CD\u5E94 } } \u5F62\u5F0F\u7684\u5BF9\u8C61");
      const unknownNetwork = Object.keys(config.network).filter((key) => !NETWORK_KEYS.includes(key));
      if (unknownNetwork.length) throw new Error(`network \u4E0B\u672A\u77E5\u7684\u914D\u7F6E\u9879 ${unknownNetwork.join(", ")}\uFF0C\u53EF\u7528\u7684\u914D\u7F6E\u9879\uFF1A${NETWORK_KEYS.join(", ")}`);
      if (config.network.routes !== void 0 && !isPlainObject(config.network.routes)) {
        throw new Error("network.routes \u9700\u8981\u662F { \u89C4\u5219: \u54CD\u5E94 } \u5F62\u5F0F\u7684\u5BF9\u8C61");
      }
    }
    if (config.webView !== void 0) {
      if (!isPlainObject(config.webView)) throw new Error("webView \u9700\u8981\u662F { rewriteUrl: \u51FD\u6570 } \u5F62\u5F0F\u7684\u5BF9\u8C61");
      const unknownWebView = Object.keys(config.webView).filter((key) => !WEBVIEW_KEYS.includes(key));
      if (unknownWebView.length) {
        throw new Error(`webView \u4E0B\u672A\u77E5\u7684\u914D\u7F6E\u9879 ${unknownWebView.join(", ")}\uFF0C\u53EF\u7528\u7684\u914D\u7F6E\u9879\uFF1A${WEBVIEW_KEYS.join(", ")}`);
      }
      if (config.webView.rewriteUrl !== void 0 && typeof config.webView.rewriteUrl !== "function") {
        throw new Error("webView.rewriteUrl \u9700\u8981\u662F\u51FD\u6570\uFF0C\u8FD4\u56DE\u65B0\u7684\u5730\u5740\uFF1B\u4E0D\u66FF\u6362\u65F6\u8FD4\u56DE undefined");
      }
    }
    if (config.run !== void 0 && typeof config.run !== "function") throw new Error("run \u9700\u8981\u662F\u51FD\u6570");
    return config;
  }
  function checkMock(api, impl) {
    if (TASK_APIS.has(api)) {
      throw new Error(`mock.${api}\uFF1Awx.${api} \u7531\u57FA\u7840\u5E93\u5185\u90E8\u7684\u4EFB\u52A1\u5B9E\u73B0\uFF0Cmock \u65E0\u6CD5\u8986\u76D6\uFF1B\u62E6\u622A wx.request \u8BF7\u7528 network.routes\uFF08\u8BF7\u6C42\u62E6\u622A\uFF09`);
    }
    if (STORAGE_API.test(api)) {
      throw new Error(`mock.${api}\uFF1A\u5B58\u50A8\u6570\u636E\u8BF7\u7528 storage \u9884\u7F6E\uFF0C\u4E0D\u8981\u8986\u76D6\u5B58\u50A8 API`);
    }
    if (typeof impl !== "function" && !isPlainObject(impl)) {
      throw new Error(`mock.${api}\uFF1A\u9700\u8981\u662F\u4F5C\u4E3A\u8C03\u7528\u7ED3\u679C\u7684\u5BF9\u8C61\uFF0C\u6216\u6309\u8C03\u7528\u53C2\u6570\u8FD4\u56DE\u7ED3\u679C\u7684\u51FD\u6570`);
    }
  }
  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  // src/runtime/host/testApi.ts
  function installTestApi(host, ready) {
    const snapshot = (page) => page ? { webviewId: page.id, path: page.path, query: { ...page.query }, frameName: page.frame.name } : null;
    const pageInstance = (path) => {
      if (!path) return void 0;
      const pages = host.serviceWindow()?.getCurrentPages?.() || [];
      return [...pages].reverse().find((page) => page.route === path);
    };
    const api = {
      ready,
      currentPage: () => snapshot(host.currentPage()),
      pageStack: () => host.pageStack().map((page) => snapshot(page)),
      webViews: () => {
        const page = host.currentPage();
        return page ? host.webViewsOf(page) : [];
      },
      waitForPage(path, timeout = 1e4) {
        const target = path.replace(/^\//, "");
        return new Promise((resolve, reject) => {
          const current = host.currentPage();
          if (current?.path === target) return resolve(snapshot(current));
          const timer = setTimeout(() => reject(new Error(`\u7B49\u5F85\u9875\u9762 ${target} \u8D85\u65F6`)), timeout);
          host.onRoute((page) => {
            if (page.path === target) {
              clearTimeout(timer);
              resolve(snapshot(page));
            }
          });
        });
      },
      pageData(path) {
        const instance = pageInstance(path === void 0 ? host.currentPage()?.path : host.resolveUrl(path).path);
        if (!instance) return null;
        const { __webviewId__: _webviewId, ...data } = JSON.parse(JSON.stringify(instance.data));
        return data;
      },
      async callPageMethod(name, ...args) {
        const current = host.currentPage();
        if (!current) throw new Error("\u5C0F\u7A0B\u5E8F\u8FD8\u6CA1\u6709\u542F\u52A8");
        const instance = pageInstance(current.path);
        if (!instance) throw new Error(`\u9875\u9762 ${current.path} \u7684\u903B\u8F91\u5C42\u8FD8\u6CA1\u6709\u521B\u5EFA`);
        if (typeof instance[name] !== "function") throw new Error(`\u9875\u9762 ${current.path} \u6CA1\u6709\u65B9\u6CD5 ${name}`);
        return instance[name](...cloneInto(host.serviceWindow(), args));
      },
      mock(name, impl) {
        if (TASK_APIS.has(name)) {
          throw new Error(`wx.${name} \u7531\u57FA\u7840\u5E93\u5185\u90E8\u7684\u4EFB\u52A1\u5B9E\u73B0\uFF0Cmock \u4E0D\u4F1A\u751F\u6548\uFF1Bwx.request \u8BF7\u7528 route \u62E6\u622A`);
        }
        host.api.mock(name, impl);
      },
      unmock: (name) => host.api.unmock(name),
      route: (pattern, handler) => host.routes.add(pattern, handler),
      unroute: (pattern) => host.routes.remove(pattern),
      requests(pattern) {
        const matches = pattern === void 0 ? () => true : compilePattern(pattern);
        return host.requests.list().filter(matches);
      },
      clearRequests: () => host.requests.clear(),
      navigateTo: (url) => host.enqueueRoute(() => host.navigateTo(url)),
      navigateBack: (delta = 1) => host.enqueueRoute(() => host.navigateBack(delta)),
      redirectTo: (url) => host.enqueueRoute(() => host.redirectTo(url)),
      reLaunch: (url) => host.enqueueRoute(() => host.reLaunch(url)),
      switchTab: (url) => host.enqueueRoute(() => host.switchTab(url)),
      getStorage(key) {
        const item = host.storage.get("s0", key);
        return item ? decodeStorageValue(item) : void 0;
      },
      clearStorage: () => host.storage.clear("s0"),
      errors: () => [...host.errors]
    };
    window.__wxa_test_api__ = api;
    return api;
  }

  // src/runtime/host/index.ts
  async function main() {
    const root = document.getElementById("wxa-root");
    const info = await (await fetch("/__wxa__/app-info.json")).json();
    const restore = new PageStackRestore(info.appid);
    const sendReport = info.liveReload === false ? () => void 0 : connectDevServer(restore);
    if (info.buildError) {
      new PhoneShell(root, info.device).showError(`\u7F16\u8BD1\u5931\u8D25

${info.buildError}`);
      return;
    }
    if (window.__wxa_webview_window__ === true) info.webViewWindow = true;
    const host = new Host(info, root, sendReport);
    window.__wxaHost = host;
    let markReady;
    const ready = new Promise((resolve) => {
      markReady = resolve;
    });
    const testApi = installTestApi(host, ready);
    if (info.setup && !await runSetup(host, info.setup)) return;
    if (!await runBeforeLaunch(host, testApi)) return;
    await host.start(restore.launchTarget(info.pages, launchTarget(info)));
    await restore.reopen(host);
    markReady();
  }
  async function runSetup(host, setup) {
    try {
      if (setup.error) throw new Error(setup.error);
      const url = "/__wxa__/setup.js";
      const module = await import(url);
      console.info(formatSetupSummary(await applySetup(module.default, host, setup.env)));
      return true;
    } catch (error) {
      console.error("[wxa-runner] setup \u6267\u884C\u5931\u8D25", error);
      host.shell.showError(`setup \u6267\u884C\u5931\u8D25

${error.message}`);
      return false;
    }
  }
  async function runBeforeLaunch(host, testApi) {
    const hook = window.__wxa_before_launch__;
    if (typeof hook !== "function") return true;
    try {
      await hook(testApi);
      return true;
    } catch (error) {
      console.error("[wxa-runner] __wxa_before_launch__ \u6267\u884C\u5931\u8D25", error);
      host.shell.showError(`\u542F\u52A8\u524D\u7684\u6D4B\u8BD5\u51C6\u5907\uFF08__wxa_before_launch__\uFF09\u6267\u884C\u5931\u8D25

${error.message}`);
      return false;
    }
  }
  function launchTarget(info) {
    const params = new URLSearchParams(location.search);
    const path = (params.get("path") || "").replace(/^\//, "").replace(/\.html$/, "");
    params.delete("path");
    if (path && info.pages.includes(path)) {
      return { path, query: Object.fromEntries(params) };
    }
    const entry = String(info.wxConfig.entryPagePath || info.pages[0]).replace(/\.html$/, "");
    return { path: entry, query: {} };
  }
  function connectDevServer(restore) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/__wxa__/ws`);
    let hotChain = Promise.resolve();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "reload") restore.reload(currentHost());
      if (message.type === "hot") hotChain = hotChain.then(() => hotUpdate(message, restore));
      if (message.type === "error") {
        const host = currentHost();
        if (host) host.shell.showError(`\u7F16\u8BD1\u5931\u8D25

${message.message}`);
        else restore.reload(host);
      }
    };
    const pending = [];
    socket.onopen = () => pending.splice(0).forEach((data) => socket.send(data));
    return (report) => {
      const data = JSON.stringify(report);
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
      else if (socket.readyState === WebSocket.CONNECTING) pending.push(data);
    };
  }
  function currentHost() {
    return window.__wxaHost;
  }
  async function hotUpdate(update, restore) {
    const host = currentHost();
    const files = [
      ...update.styles.map((id) => id + ".wxss"),
      ...update.templates.map((id) => id + ".wxml"),
      ...update.scripts.map((id) => id + ".js")
    ].join(", ");
    try {
      if (!host) throw new Error("\u5BBF\u4E3B\u5C1A\u672A\u542F\u52A8");
      await applyHotUpdate(host, update);
      console.info(`[wxa-runner] \u70ED\u66F4\u65B0\u5B8C\u6210\uFF1A${files}`);
    } catch (error) {
      console.warn(`[wxa-runner] ${files} \u65E0\u6CD5\u70ED\u66F4\u65B0\uFF0C\u6574\u9875\u5237\u65B0\uFF1A`, error);
      restore.reload(host);
    }
  }
  main().catch((error) => {
    console.error("[wxa-runner] \u542F\u52A8\u5931\u8D25", error);
    document.body.textContent = `wxa-runner \u542F\u52A8\u5931\u8D25\uFF1A${error.message}`;
  });
})();
//# sourceMappingURL=host.js.map