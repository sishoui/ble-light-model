"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/web.ts
var web_exports = {};
__export(web_exports, {
  DEFAULT_DEVICE: () => DEFAULT_DEVICE,
  FileStore: () => FileStore,
  MOCK_ID_HEADER: () => MOCK_ID_HEADER,
  MOCK_PREFIX: () => MOCK_PREFIX,
  PROXY_PREFIX: () => PROXY_PREFIX,
  SETUP_MODULE: () => SETUP_MODULE,
  SETUP_MODULE_SOURCE: () => SETUP_MODULE_SOURCE,
  extname: () => extname,
  hostHtml: () => hostHtml,
  mimeType: () => mimeType,
  mockedResponse: () => mockedResponse,
  proxyFetch: () => proxyFetch,
  routeApp: () => routeApp
});
module.exports = __toCommonJS(web_exports);

// src/project/toJs.ts
function toJs(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// src/server/pluginCode.ts
function findPluginPage(build, pagePath) {
  for (const plugin of build.plugins) {
    const prefix = `__plugin__/${plugin.provider}/`;
    if (plugin.pages.includes(pagePath)) return { plugin, innerPath: pagePath.slice(prefix.length) };
  }
  return null;
}
function pluginScriptUrl(plugin, file) {
  return `/__wxa__/plugin/${encodeURIComponent(plugin.provider)}/${encodeURIComponent(plugin.version)}/${file}`;
}

// src/server/html.ts
function hostHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wxa-runner</title>
</head>
<body>
  <div id="wxa-root"></div>
  <script src="/__wxa__/runtime/host.js"><\/script>
</body>
</html>`;
}
function enableHotUpdate(hot) {
  return hot ? `<script>if (typeof __virtualDOM__ !== 'undefined' && __virtualDOM__.enableUpdateWxAppCode) __virtualDOM__.enableUpdateWxAppCode();<\/script>
` : "";
}
function appserviceHtml(build, launch, options) {
  const wxConfig = {
    ...build.wxConfig,
    appLaunchInfo: { scene: 1001, path: launch.path, query: launch.query },
    ...options.isolated ? { isIsolateContext: true } : {}
  };
  const v = build.version;
  const pluginUrls = build.plugins.map((plugin) => pluginScriptUrl(plugin, "appservice.js"));
  const moduleUrls = build.modules.map((id) => `/__wxa__/module/${encodeURI(id)}?v=${v}`);
  const bootstrapUrl = `/__wxa__/service-bootstrap.js?v=${v}`;
  if (options.isolated) {
    const scripts = [...pluginUrls, ...moduleUrls, bootstrapUrl];
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>appservice</title>
<script>var __wxConfig = ${toJs(wxConfig)};<\/script>
<script src="/__wxa__/runtime/frame.js" data-kind="service" data-app-service="${escapeHtml(JSON.stringify(scripts))}"${options.hot ? ' data-hot="1"' : ""}><\/script>
<script src="/__baselib__/WAServiceMainContext.js"><\/script>
</head>
<body></body>
</html>`;
  }
  const modules = [...pluginUrls, ...moduleUrls].map((src) => `<script src="${src}"><\/script>`).join("\n");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>appservice</title>
<script>var __wxConfig = ${toJs(wxConfig)};<\/script>
<script src="/__wxa__/runtime/frame.js" data-kind="service"><\/script>
<script src="/__baselib__/WAService.js"><\/script>
${enableHotUpdate(options.hot)}<script>
if (typeof define !== 'function') {
  console.error('[wxa-runner] \u57FA\u7840\u5E93\u6CA1\u6709\u5B8C\u6210\u521D\u59CB\u5316\uFF08define \u4E0D\u5B58\u5728\uFF09\uFF0C\u5F53\u524D\u57FA\u7840\u5E93\u7248\u672C\u53EF\u80FD\u4E0D\u53D7\u652F\u6301');
}
<\/script>
${modules}
<script src="${bootstrapUrl}"><\/script>
<script>parent.__wxaHost.frameLoaded('service', 0);<\/script>
</head>
<body></body>
</html>`;
}
function subcontextHtml(id, empty) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>subcontext ${id}</title>
<script src="/__wxa__/runtime/frame.js" data-kind="service" data-context-id="${id}"><\/script>
${empty ? "" : '<script src="/__baselib__/WASubContext.js"><\/script>\n'}<script>parent.__wxaContexts.loaded(${id});<\/script>
</head>
<body></body>
</html>`;
}
function webviewHtml(build, pagePath, webviewId, options) {
  const id = Number(webviewId) || 0;
  return `<!DOCTYPE html>
<html>
<head>
${webviewHead(build, pagePath, id, options.scripts)}
${enableHotUpdate(options.hot)}<script src="/__wxa__/page-frame.js?v=${build.version}"><\/script>
${pageWindow(build, pagePath).disableScroll ? "<style>body{overflow-y:hidden}</style>" : ""}
</head>
<body>
${scriptTags(options.scripts, "body")}<script>
(function () {
  var path = ${toJs(pagePath)};
  if (typeof __wxAppCode__[path + '.wxss'] === 'function') __wxAppCode__[path + '.wxss']();
  var generateFunc = $gwx('./' + path + '.wxml');
  if (generateFunc) {
    document.dispatchEvent(new CustomEvent('generateFuncReady', { detail: { generateFunc: generateFunc } }));
  } else {
    document.body.innerText = './' + path + '.wxml not found';
    console.error('[wxa-runner] ./' + path + '.wxml not found');
  }
  parent.__wxaHost.frameLoaded('webview', ${id});
})();
<\/script>
</body>
</html>`;
}
function workerScript(build, baseLib) {
  const modules = build.workerModules.map((id) => `/__wxa__/module/${encodeURI(id)}?v=${build.version}`);
  const prelude = `var __wxConfig = ${toJs(build.wxConfig)}; __wxConfig.env.USER_DATA_PATH = location.origin + "/__wxa__/usr/" + new URL(location.href).searchParams.get("session");
importScripts('/__wxa__/runtime/worker.js');
`;
  if (!baseLib.hasWorker) {
    const message = `[wxa-runner] \u57FA\u7840\u5E93 ${baseLib.version} \u91CC\u6CA1\u6709 WAWorker.js\uFF0CWorker \u4E0D\u80FD\u8FD0\u884C\u3002\u6362\u7528\u5F00\u53D1\u8005\u5DE5\u5177\u4E0B\u8F7D\u7684\u57FA\u7840\u5E93\uFF0C\u6216\u5347\u7EA7 wxa-runner \u5E26\u4E0A\u65B0\u7684\u5185\u7F6E\u57FA\u7840\u5E93`;
    return `${prelude}throw new Error(${toJs(message)});
`;
  }
  return `${prelude}var __wxaConsole = self.console;
importScripts('/__baselib__/WAWorker.js');
self.console = __wxaConsole;
importScripts(${modules.map((url) => toJs(url)).join(", ")});
`;
}
function pluginWebviewHtml(build, plugin, innerPath, pagePath, webviewId, options = {}) {
  const id = Number(webviewId) || 0;
  const html2 = plugin.files.get(`/${innerPath}.html`);
  const page = html2 ? new TextDecoder().decode(html2) : `<script>console.error(${JSON.stringify(`[wxa-runner] \u63D2\u4EF6 ${plugin.alias} \u91CC\u6CA1\u6709\u9875\u9762 ${innerPath}`)})<\/script>`;
  return `<!DOCTYPE html>
<html>
<head>
${webviewHead(build, pagePath, id, options.scripts)}
<script src="${pluginScriptUrl(plugin, "pageframe.js")}"><\/script>
${pageWindow(build, pagePath).disableScroll ? "<style>body{overflow-y:hidden}</style>" : ""}
</head>
<body>
${scriptTags(options.scripts, "body")}${page}
<script>parent.__wxaHost.frameLoaded('webview', ${id});<\/script>
</body>
</html>`;
}
function pageWindow(build, pagePath) {
  return { ...build.wxConfig.global?.window, ...build.wxConfig.page?.[pagePath + ".html"]?.window };
}
function webviewHead(build, pagePath, id, scripts) {
  const wxConfig = { ...build.wxConfig, window: pageWindow(build, pagePath) };
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${escapeHtml(pagePath)}</title>
<!-- \u5C0F\u7A0B\u5E8F\u6E32\u67D3\u5C42\u7684\u9ED8\u8BA4\u5B57\u53F7\u662F 16px\uFF1B\u4E0D\u58F0\u660E\u7684\u8BDD\u4F1A\u7EE7\u627F\u6D4F\u89C8\u5668\u8BBE\u7F6E\u91CC\u7684\u9ED8\u8BA4\u5B57\u53F7\u3002\u653E\u5728\u6700\u524D\u9762\uFF0C\u57FA\u7840\u5E93\u548C\u9875\u9762\u6837\u5F0F\u90FD\u80FD\u8986\u76D6\u5B83 -->
<style>html{font-size:16px}</style>
<!-- \u771F\u673A\u7684\u6EDA\u52A8\u6761\u662F\u4E0D\u5360\u5E03\u5C40\u7684\u6D6E\u5C42\uFF1B\u684C\u9762\u6D4F\u89C8\u5668\u7684\u5E38\u89C4\u6EDA\u52A8\u6761\u548C\u81EA\u5B9A\u4E49 ::-webkit-scrollbar \u4F1A\u6324\u7A84\u9875\u9762\uFF0C\u4E00\u5F8B\u9690\u85CF\u3002
     scrollbar-width \u4F18\u5148\u4E8E ::-webkit-scrollbar\uFF0C\u9875\u9762\u6837\u5F0F\u4E0D\u4F1A\u518D\u628A\u6EDA\u52A8\u6761\u52A0\u56DE\u6765 -->
<style>*{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>
<!-- \u903B\u8F91\u5C42\u5EFA\u7684 2d\u3001webgl \u753B\u5E03\u642C\u8FDB wx-canvas \u540E\u94FA\u6EE1\u5B83\uFF08\u89C1 frame.ts \u7684 moveCanvasesIntoPages\uFF09\u3002
     \u57FA\u7840\u5E93\u8FD8\u4F1A\u6309\u903B\u8F91\u5C42\u91CC\u7684\u5E03\u5C40\u6539\u5B83\u7684\u4F4D\u7F6E\u548C\u663E\u9690\uFF0C\u8FD9\u91CC\u4E00\u5F8B\u538B\u4F4F\uFF1B\u89E6\u6478\u7167\u5E38\u4EA4\u7ED9 wx-canvas \u81EA\u5DF1\u7684 canvas -->
<style>.wxa-service-canvas{position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;visibility:inherit!important;pointer-events:none}</style>
<script>var __wxConfig = ${toJs(wxConfig)};<\/script>
<script src="/__wxa__/runtime/frame.js" data-kind="webview" data-webview-id="${id}"><\/script>
${scriptTags(scripts, "head")}<script src="/__baselib__/WAWebview.js"><\/script>`;
}
function scriptTags(scripts, position) {
  return (scripts ?? []).filter((script) => (script.position ?? "body") === position).map((script) => script.src !== void 0 ? `<script src="${escapeHtml(script.src)}"><\/script>
` : `<script>${script.content.replace(/<\/script/gi, "<\\/script")}<\/script>
`).join("");
}
function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

// src/server/appRoutes.ts
var DEFAULT_DEVICE = {
  model: "iPhone X",
  screenWidth: 375,
  screenHeight: 812,
  pixelRatio: 3,
  statusBarHeight: 44,
  safeAreaBottom: 34,
  system: "iOS 16.0",
  platform: "devtools"
};
var PLUGIN_SCRIPT = /^\/__wxa__\/plugin\/([^/]+)\/([^/]+)\/(appservice\.js|pageframe\.js)$/;
function routeApp(source, url) {
  const { build } = source;
  const pathname = safeDecode(url.pathname);
  if (pathname === null) return null;
  const query = url.searchParams;
  switch (pathname) {
    case "/__wxa__/appservice.html": {
      const launchPath = (query.get("path") || "").replace(/^\//, "");
      const launch = build.pages.includes(launchPath) ? { path: launchPath, query: Object.fromEntries(new URLSearchParams(query.get("query") || "")) } : { path: build.pages[0], query: {} };
      return html(appserviceHtml(build, launch, { hot: source.hot, isolated: source.isolated }));
    }
    case "/__wxa__/subcontext.html": {
      const id = Number(query.get("id"));
      if (!Number.isInteger(id) || id <= 0) return { status: 400, type: "text", body: "\u5B50\u4E0A\u4E0B\u6587 id \u65E0\u6548" };
      return html(subcontextHtml(id, query.get("empty") === "1"));
    }
    case "/__wxa__/worker.js":
      return js(workerScript(build, source.baseLib));
    case "/__wxa__/service-bootstrap.js":
      return js(build.serviceBootstrap);
    case "/__wxa__/service-templates.js":
      return js(build.serviceTemplates);
    case "/__wxa__/page-templates.js":
      return js(build.pageTemplates);
    case "/__wxa__/page-styles.js":
      return js(build.pageStyles);
    case "/__wxa__/page-frame.js":
      return js(build.pageFrame);
  }
  const webview = /^\/__wxa__\/webview\/(.+)\.html$/.exec(pathname);
  if (webview) {
    const pagePath = webview[1];
    if (!build.pages.includes(pagePath)) return null;
    const webviewId = Number(query.get("id"));
    const pluginPage = findPluginPage(build, pagePath);
    return html(pluginPage ? pluginWebviewHtml(build, pluginPage.plugin, pluginPage.innerPath, pagePath, webviewId, { scripts: source.webviewScripts }) : webviewHtml(build, pagePath, webviewId, { hot: source.hot, scripts: source.webviewScripts }));
  }
  const pluginScript = PLUGIN_SCRIPT.exec(pathname);
  if (pluginScript) {
    const [, provider, version, file] = pluginScript;
    const code = build.plugins.find((plugin) => plugin.provider === provider && plugin.version === version)?.files.get(`/${file}`);
    return code ? { status: 200, type: "js", body: code } : null;
  }
  const pluginFile = /^\/__plugin__\/([^/]+)(\/.+)$/.exec(pathname);
  if (pluginFile) {
    const file = build.plugins.find((plugin) => plugin.provider === pluginFile[1])?.files.get(pluginFile[2]);
    return file ? { status: 200, type: extname(pluginFile[2]) || "application/octet-stream", body: file } : null;
  }
  const module2 = /^\/__wxa__\/module\/(.+\.js)$/.exec(pathname);
  if (module2) {
    const id = module2[1];
    if (!build.modules.includes(id) && !build.workerModules.includes(id)) {
      return { status: 404, type: "js", body: `console.error(${JSON.stringify(`[wxa-runner] \u6A21\u5757 ${id} \u4E0D\u5B58\u5728`)})` };
    }
    return js(source.moduleScript(id));
  }
  return null;
}
var MIME_TYPES = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  text: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  css: "text/css; charset=utf-8",
  wxss: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm"
};
function mimeType(type) {
  if (type.includes("/")) return type;
  return MIME_TYPES[type.replace(/^\./, "").toLowerCase()] ?? "application/octet-stream";
}
function extname(filePath) {
  const match = /\.[^./]+$/.exec(filePath);
  return match ? match[0] : "";
}
function html(body) {
  return { status: 200, type: "html", body };
}
function js(body) {
  return { status: 200, type: "js", body };
}
function safeDecode(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

// src/server/FileStore.ts
var storeSequence = 0;
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
function normalizeEncoding(encoding) {
  switch (String(encoding).toLowerCase()) {
    case "utf8":
    case "utf-8":
      return "utf8";
    case "utf16le":
    case "utf-16le":
    case "ucs2":
    case "ucs-2":
      return "utf16le";
    case "latin1":
    case "binary":
      return "latin1";
    case "ascii":
      return "ascii";
    case "base64":
    case "base64url":
      return String(encoding).toLowerCase();
    case "hex":
      return "hex";
    default:
      throw new Error(`Unknown encoding: ${encoding}`);
  }
}
function encodeText(text, encoding) {
  const format = normalizeEncoding(encoding);
  if (format === "utf8") return textEncoder.encode(text);
  if (format === "base64" || format === "base64url") {
    let base64 = text.split("=", 1)[0].replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
    if (base64.length % 4 === 1) base64 = base64.slice(0, -1);
    base64 = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  }
  if (format === "hex") {
    const bytes2 = [];
    for (let index = 0; index + 1 < text.length; index += 2) {
      const pair = text.slice(index, index + 2);
      if (!/^[\da-f]{2}$/i.test(pair)) break;
      bytes2.push(parseInt(pair, 16));
    }
    return new Uint8Array(bytes2);
  }
  const bytes = new Uint8Array(text.length * (format === "utf16le" ? 2 : 1));
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (format === "utf16le") {
      bytes[index * 2] = code & 255;
      bytes[index * 2 + 1] = code >>> 8;
    } else bytes[index] = code & 255;
  }
  return bytes;
}
function decodeText(bytes, encoding) {
  const format = normalizeEncoding(encoding);
  if (format === "utf8") return textDecoder.decode(bytes);
  if (format === "hex") return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    const chunk = bytes.subarray(offset, offset + 32768);
    const codes = [];
    for (let index = 0; index < chunk.length; index++) {
      if (format === "utf16le") {
        if (index + 1 < chunk.length) codes.push(chunk[index] | chunk[++index] << 8);
      } else codes.push(format === "ascii" ? chunk[index] & 127 : chunk[index]);
    }
    chunks.push(String.fromCharCode(...codes));
  }
  const text = chunks.join("");
  if (format === "base64") return btoa(text);
  if (format === "base64url") return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return text;
}
var FileStore = class {
  /** @param roots 预先创建的目录（如用户目录）。rmdir 不能删除它们和它们的上级目录：删掉之后再写 USER_DATA_PATH 都会失败 */
  constructor(roots = []) {
    this.etagPrefix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++storeSequence}-${Math.random().toString(36).slice(2)}`;
    this.version = 0;
    this.nodes = /* @__PURE__ */ new Map([["/", { dir: true, data: new Uint8Array(0), mtime: Date.now(), etag: "" }]]);
    this.operations = {
      readFile: ({ filePath, encoding }) => {
        const data = this.read(filePath);
        return encoding === void 0 ? { data: decodeText(data, "base64"), binary: true } : { data: decodeText(data, encoding) };
      },
      writeFile: (args) => this.writeEncoded(args, false),
      appendFile: (args) => this.writeEncoded(args, true),
      copyFile: ({ srcPath, destPath }) => {
        this.write(destPath, this.read(srcPath));
        return {};
      },
      rename: ({ oldPath, newPath }) => {
        const source = this.normalize(oldPath);
        const target = this.normalize(newPath);
        const node = this.existing(oldPath);
        this.assertNotRoot(source);
        this.assertNotRoot(target);
        if (source === target) return {};
        const parent = target.slice(0, target.lastIndexOf("/")) || "/";
        if (!this.nodes.get(parent)?.dir) throw new Error(`no such file or directory ${newPath}`);
        if (node.dir && target.startsWith(source + "/")) throw new Error("invalid argument: directory moved into itself");
        const destination = this.nodes.get(target);
        if (destination) {
          if (destination.dir !== node.dir) throw new Error(`incompatible file type ${newPath}`);
          if (destination.dir && this.readdir(target).length) throw new Error(`directory not empty ${newPath}`);
        }
        const entries = [...this.nodes].filter(([key]) => key === source || node.dir && key.startsWith(source + "/"));
        for (const [key] of entries) this.nodes.delete(key);
        for (const [key, value] of entries) this.nodes.set(target + key.slice(source.length), value);
        return {};
      },
      access: ({ path }) => {
        this.existing(path);
        return {};
      },
      stat: ({ path }) => {
        const node = this.existing(path);
        const stats = {
          mode: node.dir ? 16877 : 33188,
          size: node.data.length,
          lastAccessedTime: Math.floor(node.mtime / 1e3),
          lastModifiedTime: Math.floor(node.mtime / 1e3)
        };
        return { stats, ...stats };
      },
      getFileInfo: ({ filePath }) => ({ size: this.read(filePath).length }),
      mkdir: ({ dirPath, recursive }) => {
        this.mkdir(dirPath, !!recursive);
        return {};
      },
      readdir: ({ dirPath }) => ({ files: this.readdir(dirPath) }),
      unlink: ({ filePath }) => {
        this.remove(filePath, { dir: false });
        return {};
      },
      rmdir: ({ dirPath, recursive }) => {
        this.assertNotRoot(dirPath);
        this.remove(dirPath, { dir: true, recursive: !!recursive });
        return {};
      }
    };
    this.roots = roots.map((root) => this.normalize(root));
    for (const root of this.roots) this.mkdir(root, true);
  }
  normalize(filePath) {
    const stripped = String(filePath || "").replace(/^[a-z]+:\/\/[^/]*/i, "");
    const parts = [];
    for (const part of stripped.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return "/" + parts.join("/");
  }
  stat(filePath) {
    return this.nodes.get(this.normalize(filePath));
  }
  mkdir(dirPath, recursive = false) {
    const target = this.normalize(dirPath);
    if (this.nodes.has(target)) throw new Error(`file already exists ${dirPath}`);
    const parent = target.slice(0, target.lastIndexOf("/")) || "/";
    if (!this.nodes.get(parent)?.dir) {
      if (!recursive) throw new Error(`no such file or directory ${dirPath}`);
      this.mkdir(parent, true);
    }
    this.nodes.set(target, { dir: true, data: new Uint8Array(0), mtime: Date.now(), etag: "" });
  }
  write(filePath, input, append = false) {
    const data = typeof input === "string" ? textEncoder.encode(input) : new Uint8Array(input);
    const target = this.normalize(filePath);
    const parent = target.slice(0, target.lastIndexOf("/")) || "/";
    if (!this.nodes.get(parent)?.dir) throw new Error(`no such file or directory ${filePath}`);
    const existing = this.nodes.get(target);
    if (existing?.dir) throw new Error(`illegal operation on a directory ${filePath}`);
    let contents = data;
    if (append && existing) {
      contents = new Uint8Array(existing.data.length + data.length);
      contents.set(existing.data);
      contents.set(data, existing.data.length);
    }
    this.nodes.set(target, { dir: false, data: contents, mtime: Date.now(), etag: `${this.etagPrefix}-${++this.version}` });
  }
  read(filePath) {
    const node = this.stat(filePath);
    if (!node) throw new Error(`no such file or directory, open ${filePath}`);
    if (node.dir) throw new Error(`illegal operation on a directory ${filePath}`);
    return node.data;
  }
  readdir(dirPath) {
    const target = this.normalize(dirPath);
    if (!this.nodes.get(target)?.dir) throw new Error(`no such file or directory ${dirPath}`);
    const prefix = target === "/" ? "/" : target + "/";
    return [...this.nodes.keys()].filter((key) => key.startsWith(prefix) && key !== target && !key.slice(prefix.length).includes("/")).map((key) => key.slice(prefix.length));
  }
  remove(filePath, options) {
    const target = this.normalize(filePath);
    const node = this.nodes.get(target);
    if (!node) throw new Error(`no such file or directory ${filePath}`);
    if (node.dir !== options.dir) throw new Error(options.dir ? `not a directory ${filePath}` : `operation not permitted ${filePath}`);
    if (node.dir) {
      const children = this.readdir(target);
      if (children.length && !options.recursive) throw new Error(`directory not empty ${filePath}`);
      for (const key of [...this.nodes.keys()]) if (key.startsWith(target + "/")) this.nodes.delete(key);
    }
    this.nodes.delete(target);
  }
  /** 文件 API 经开发服务器调用的操作，参数和返回值的字段名与基础库一致 */
  execute(operation, args) {
    if (!Object.prototype.hasOwnProperty.call(this.operations, operation)) {
      throw new Error(`unsupported filesystem operation ${operation}`);
    }
    return this.operations[operation](args);
  }
  writeEncoded(args, append) {
    this.write(args.filePath, encodeText(args.data ?? "", args.binary ? "base64" : args.encoding || "utf8"), append);
    return {};
  }
  existing(filePath) {
    const node = this.stat(filePath);
    if (!node) throw new Error(`no such file or directory ${filePath}`);
    return node;
  }
  assertNotRoot(dirPath) {
    const target = this.normalize(dirPath);
    const prefix = target === "/" ? "/" : target + "/";
    if (this.roots.some((root) => root === target || root.startsWith(prefix))) {
      throw new Error(`operation not permitted ${dirPath}`);
    }
  }
};

// src/runtime/networkPanel.ts
var PROXY_PREFIX = "/__wxa__/proxy/";
var MOCK_PREFIX = "/__wxa__/mock/";
var MOCK_ID_HEADER = "x-wxa-mock-id";
function fromServerPath(prefix, serverPath) {
  if (!serverPath.startsWith(prefix)) return null;
  const match = /^(https?)\/([^/?#]+)(.*)$/.exec(serverPath.slice(prefix.length));
  if (!match) return null;
  const url = `${match[1]}://${match[2]}${match[3]}`;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
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

// src/server/proxyFetch.ts
var DROPPED_REQUEST_HEADERS = /* @__PURE__ */ new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "expect"]);
var DROPPED_RESPONSE_HEADERS = /* @__PURE__ */ new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
async function proxyFetch(request, options = {}) {
  const url = new URL(request.url);
  const path = url.pathname + url.search;
  const target = fromServerPath(PROXY_PREFIX, path);
  if (!target) return proxyError(400, `invalid url "${path}"`);
  try {
    let current = new URL(target);
    if (options.isAllowed && !options.isAllowed(current)) return forbiddenHost(current, 0);
    const headers = new Headers(
      forwardedRequestHeaders(request.headers.get("x-wxa-headers") ?? void 0, request.headers.get("content-type") ?? "")
    );
    let method = request.method;
    let body = request.body && !["GET", "HEAD"].includes(method) ? await request.arrayBuffer() : void 0;
    const send = options.fetch ?? fetch;
    let upstream;
    for (let hop = 0; ; hop++) {
      upstream = await send(current.href, {
        method,
        headers,
        body,
        redirect: options.isAllowed ? "manual" : "follow",
        signal: request.signal
      });
      const location = upstream.headers.get("location");
      if (!options.isAllowed || !REDIRECT_STATUSES.has(upstream.status) || location === null) break;
      await upstream.body?.cancel();
      const next = new URL(location, current);
      if (hop >= 20) return proxyError(403, `host "${next.hostname}": redirect hop ${hop + 1} exceeds limit 20`);
      if (!["http:", "https:"].includes(next.protocol) || !options.isAllowed(next)) return forbiddenHost(next, hop + 1);
      if (upstream.status === 303 && method !== "GET" && method !== "HEAD" || (upstream.status === 301 || upstream.status === 302) && method === "POST") {
        method = "GET";
        body = void 0;
        for (const name of ["content-type", "content-encoding", "content-language", "content-location"]) headers.delete(name);
      }
      if (next.origin !== current.origin) {
        for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name);
      }
      current = next;
    }
    return relayResponse(upstream);
  } catch (error) {
    return proxyError(502, fetchErrorMessage(error));
  }
}
function forbiddenHost(url, hop) {
  return proxyError(403, `host "${url.hostname}" is not in the allowlist (redirect hop ${hop})`);
}
function proxyError(status, message) {
  return new Response(message, { status, headers: { "x-wxa-proxy-error": "1", "content-type": "text/html; charset=utf-8" } });
}
function fetchErrorMessage(error) {
  const detail = error;
  return detail?.cause?.message || detail?.message || String(error);
}
function forwardedRequestHeaders(encoded, browserContentType = "") {
  const multipart = browserContentType.startsWith("multipart/form-data");
  const headers = {};
  for (const [key, value] of Object.entries(parseHeaders(encoded))) {
    const name = key.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(name) || multipart && name === "content-type" || value === void 0 || value === null) continue;
    headers[key] = String(value);
  }
  if (multipart) headers["content-type"] = browserContentType;
  return headers;
}
function parseHeaders(encoded = "{}") {
  try {
    const parsed = JSON.parse(encoded);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function relayResponse(upstream) {
  const responseHeaders = {};
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    responseHeaders[key] = value;
    if (!DROPPED_RESPONSE_HEADERS.has(key)) headers.set(key, value);
  });
  const setCookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  if (setCookies.length > 0) {
    const joined = setCookies.join(", ");
    responseHeaders["set-cookie"] = joined;
    responseHeaders["Set-Cookie"] = joined;
  }
  headers.set("x-wxa-headers", encodeURIComponent(JSON.stringify(responseHeaders)));
  headers.set("x-wxa-set-cookie", encodeURIComponent(JSON.stringify(setCookies)));
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

// src/runtime/mockResponse.ts
var NULL_BODY_STATUSES = /* @__PURE__ */ new Set([204, 205, 304]);
async function mockedResponse(client, id) {
  if (!client) return Response.error();
  const reply = await new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      channel.port1.close();
      resolve(event.data);
    };
    client.postMessage({ type: "wxa-mock-response", id }, [channel.port2]);
  });
  if (!reply) return Response.error();
  try {
    return new Response(NULL_BODY_STATUSES.has(reply.statusCode) ? null : reply.body, {
      status: reply.statusCode,
      headers: toHeaders(reply.header)
    });
  } catch {
    return Response.error();
  }
}

// src/runtime/setupModule.ts
var SETUP_MODULE = "@open-wxa/wxa-runner-core/setup";
var SETUP_MODULE_SOURCE = "export function defineSetup(setup) { return setup; }";
//# sourceMappingURL=web.js.map