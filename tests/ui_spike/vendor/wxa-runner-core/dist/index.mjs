import {
  __dirname
} from "./chunk-NGXYLLYS.mjs";

// src/server/DevServer.ts
import { randomUUID as randomUUID2 } from "crypto";

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
      access: ({ path: path8 }) => {
        this.existing(path8);
        return {};
      },
      stat: ({ path: path8 }) => {
        const node = this.existing(path8);
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

// src/server/DevServer.ts
import fs6 from "fs";
import http from "http";
import net from "net";
import os3 from "os";
import path6 from "path";
import express2 from "express";
import { WebSocket as WebSocket3, WebSocketServer as WebSocketServer2 } from "ws";
import { readRegionData, resolveBaseLib, usesIsolatedContext } from "@open-wxa/wxa-runner-extractor";

// src/project/AppBuilder.ts
import { compileWxml, compileWxss } from "@open-wxa/wxa-runner-compiler";
import { transformSync } from "esbuild";

// src/project/StyleMirror.ts
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
var PLUGIN_EXTENSIONS = {
  less: [".less"],
  sass: [".sass", ".scss"]
};
var IMPORT_WXSS = /(?:^|\s)?(?:@import)(?:\s*)?(["'])([^"']+.wxss)\1(?:\s*);/g;
function readStyleSetting(setting) {
  const plugins = [];
  let lessGlobalVars = {};
  for (const item of Array.isArray(setting?.useCompilerPlugins) ? setting.useCompilerPlugins : []) {
    const [name, options] = Array.isArray(item) ? item : [item, void 0];
    if (name !== "less" && name !== "sass" || plugins.includes(name)) continue;
    plugins.push(name);
    if (name === "less" && options?.globalVars) lessGlobalVars = options.globalVars;
  }
  return {
    plugins,
    lessGlobalVars,
    lessCommonFile: setting?.lessSetting?.commonUseFilePath || "app.less",
    sassCommonFile: setting?.sassSetting?.sassCommonUseFilePath || "global.sass",
    scssCommonFile: setting?.sassSetting?.scssCommonUseFilePath || "global.scss"
  };
}
function ignoredStyleSources(project, setting) {
  return Object.keys(PLUGIN_EXTENSIONS).filter((plugin) => !setting.plugins.includes(plugin)).map((plugin) => ({ plugin, files: project.listFiles(PLUGIN_EXTENSIONS[plugin]) })).filter(({ files }) => files.length > 0);
}
var StyleMirror = class {
  constructor(setting) {
    this.setting = setting;
    this.dir = null;
    /** 已写入的 .wxss 与写入的内容 */
    this.files = /* @__PURE__ */ new Map();
    this.compilers = /* @__PURE__ */ new Map();
  }
  /** 镜像目录；还没同步过时为 null */
  get directory() {
    return this.dir;
  }
  /**
   * 编译全部预处理文件，与原有的 .wxss 一起写进镜像目录。
   * @returns 镜像目录，以及其中全部 .wxss 的相对路径
   */
  async sync(project) {
    const sources = this.pickSources(project);
    const outputs = await Promise.all(
      [...sources].map(async ([target, source]) => [target, await this.compile(project, source)])
    );
    const dir = this.dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "wxa-runner-wxss-"));
    for (const rel of [...this.files.keys()]) {
      if (sources.has(rel)) continue;
      fs.rmSync(path.join(dir, rel), { force: true });
      this.files.delete(rel);
    }
    for (const [rel, css] of outputs) {
      if (this.files.get(rel) === css) continue;
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, css);
      this.files.set(rel, css);
    }
    return { cwd: dir, files: [...sources.keys()] };
  }
  dispose() {
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
    this.files.clear();
  }
  /** 每个 .wxss 由哪个源文件生成：键为 .wxss 的相对路径 */
  pickSources(project) {
    const extensions = [".wxss", ...this.setting.plugins.flatMap((plugin) => PLUGIN_EXTENSIONS[plugin])];
    const sources = /* @__PURE__ */ new Map();
    for (const file of project.listFiles(extensions)) {
      const ext = path.extname(file);
      const target = file.slice(0, -ext.length) + ".wxss";
      const current = sources.get(target);
      if (!current || extensions.indexOf(ext) > extensions.indexOf(path.extname(current))) sources.set(target, file);
    }
    return sources;
  }
  async compile(project, file) {
    const ext = path.extname(file);
    if (ext === ".wxss") return project.readText(file);
    const compiler = await this.loadCompiler(ext === ".less" ? "less" : "sass", project);
    try {
      return ext === ".less" ? await this.compileLess(compiler, project, file) : this.compileSass(compiler, project, file);
    } catch (error) {
      throw new Error(`${file} \u7F16\u8BD1\u5931\u8D25\uFF1A${describeError(project, error)}`);
    }
  }
  async compileLess(less, project, file) {
    const common = this.setting.lessCommonFile;
    const prefix = Object.entries(this.setting.lessGlobalVars).map(([name, value]) => `@${name.replace(/^@/, "")}: ${value};`);
    if (file !== common && project.exists(common)) prefix.push(`@import (optional, reference) '${toRoot(file)}/${common}';`);
    let code = prefix.map((statement) => statement + " ").join("") + project.readText(file);
    code = code.replace(IMPORT_WXSS, (statement, _quote, target) => statement.replace(target, `${target}?css`));
    const { css } = await less.render(code, {
      filename: path.join(project.root, file),
      paths: [project.root]
    });
    return css.replace(/(@import\s*["'][^"']+\.wxss)\?css(["'])/g, "$1$2");
  }
  compileSass(sass, project, file) {
    const indented = file.endsWith(".sass");
    const preferred = indented ? this.setting.sassCommonFile : this.setting.scssCommonFile;
    const fallback = indented ? this.setting.scssCommonFile : this.setting.sassCommonFile;
    const common = project.exists(preferred) ? preferred : project.exists(fallback) ? fallback : null;
    let code = project.readText(file);
    if (common && file !== preferred && file !== fallback) {
      code = `@use '${toRoot(file)}/${common}'${indented ? "\n" : "; "}${code}`;
    }
    const imported = /* @__PURE__ */ new Set();
    code = code.replace(IMPORT_WXSS, (statement, _quote, target) => {
      imported.add(target);
      return statement.replace(target, `${target.slice(0, -".wxss".length)}.css`);
    });
    const css = typeof sass.compileString === "function" ? sass.compileString(code, { url: pathToFileURL(path.join(project.root, file)), syntax: indented ? "indented" : "scss", loadPaths: [project.root] }).css : sass.renderSync({ data: code, file: path.join(project.root, file), indentedSyntax: indented, includePaths: [project.root] }).css.toString();
    return css.replace(
      /(@import\s*["'])([^"']+)\.css(["'])/g,
      (statement, head, target, tail) => imported.has(`${target}.wxss`) ? `${head}${target}.wxss${tail}` : statement
    );
  }
  /** 用到时才加载：先从小程序根目录和项目目录向上查找 node_modules，找不到时用 wxa-runner 自带的 */
  loadCompiler(name, project) {
    let loading = this.compilers.get(name);
    if (!loading) {
      loading = importCompiler(name, project);
      this.compilers.set(name, loading);
    }
    return loading;
  }
};
async function importCompiler(name, project) {
  let resolved = null;
  try {
    resolved = createRequire(path.join(project.root, "package.json")).resolve(name, { paths: [project.root, project.projectPath] });
  } catch {
  }
  const module = resolved ? await import(pathToFileURL(resolved).href) : name === "less" ? await import("less") : await import("sass");
  const entry = name === "less" ? "render" : "renderSync";
  return typeof module[entry] === "function" ? module : module.default;
}
function toRoot(file) {
  const dir = path.posix.dirname(file);
  return dir === "." ? "." : dir.split("/").map(() => "..").join("/");
}
function describeError(project, error) {
  if (typeof error?.line === "number" && error.filename) {
    const file = path.relative(project.root, error.filename).split(path.sep).join("/");
    return `${file}:${error.line}:${(error.column ?? 0) + 1} ${error.message}`;
  }
  return error?.message ?? String(error);
}

// src/project/toJs.ts
function toJs(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// src/project/wxConfig.ts
var DEFAULT_WINDOW = {
  navigationBarBackgroundColor: "#000000",
  navigationBarTextStyle: "white",
  navigationBarTitleText: "",
  backgroundColor: "#ffffff",
  backgroundTextStyle: "dark",
  enablePullDownRefresh: false,
  onReachBottomDistance: 50
};
function createWxConfig(input) {
  const { app, pages, unitJson, appid, extJson } = input;
  const entryPage = app.entryPagePath || app.pages[0];
  const page = {};
  for (const id of pages) {
    const { singlePage, ...window } = unitJson.get(id) || { usingComponents: {} };
    page[id + ".html"] = { window, singlePage, renderer: window.renderer };
  }
  const tabBar = app.tabBar ? { ...app.tabBar, list: app.tabBar.list.map((item) => ({ ...item, pagePath: item.pagePath + ".html" })) } : void 0;
  return {
    ...app,
    pages: app.pages,
    resizable: !!app.resizable,
    subPackages: input.subPackages.length ? input.subPackages : void 0,
    debug: !!app.debug,
    widgets: app.widgets || [],
    customClose: !!app.customClose,
    workers: app.workers || "",
    cloud: !!app.cloud,
    global: { window: { ...DEFAULT_WINDOW, ...app.window } },
    page,
    networkTimeout: { request: 6e4, uploadFile: 6e4, connectSocket: 6e4, downloadFile: 6e4, ...app.networkTimeout },
    // 三方平台代开发：基础库的 wx.getExtConfig / getExtConfigSync 直接读这两个字段，
    // 所以 ext.json 必须在这里合并，和开发者工具一致
    ext: extJson?.ext || app.ext || {},
    extAppid: extJson?.extAppid || app.extAppid || "",
    extEnable: !!extJson,
    plugins: app.plugins || {},
    mainPlugins: { ...app.plugins },
    useExtendedLib: app.useExtendedLib || {},
    requiredPrivateInfos: app.requiredPrivateInfos || [],
    __warning__: "",
    entryPagePath: entryPage + ".html",
    tabBar,
    isLazyLoad: false,
    lazyCodeLoading: void 0,
    // 以下字段由开发者工具在运行时注入
    appname: appid,
    accountInfo: { appId: appid, icon: "", nickname: appid },
    appLaunchInfo: { scene: 1001, path: entryPage, query: {} },
    envVersion: "develop",
    platform: "devtools",
    env: { USER_DATA_PATH: "http://usr" },
    isPluginMiniProgram: false,
    wxAppInfo: { maxRequestConcurrent: 10, maxUploadConcurrent: 10, maxDownloadConcurrent: 10, maxWebsocketConnect: 5 },
    deviceinfo: {}
  };
}

// src/project/WxmlMirror.ts
import fs2 from "fs";
import os2 from "os";
import path2 from "path";
var WxmlMirror = class {
  constructor(transform2) {
    this.transform = transform2;
    this.dir = null;
    /** 已写入的文件：源内容（判断要不要重新转换）与写入的内容 */
    this.files = /* @__PURE__ */ new Map();
  }
  /** 镜像目录；还没同步过时为 null */
  get directory() {
    return this.dir;
  }
  /**
   * 让镜像目录与项目里的 wxml / wxs 一致，返回镜像目录。
   * 只重写源内容变化的文件；项目里已删除的文件同时从镜像目录删除，被引用时 wcc 照常报错
   */
  sync(project, relPaths) {
    const dir = this.dir ??= fs2.mkdtempSync(path2.join(os2.tmpdir(), "wxa-runner-wxml-"));
    const current = new Set(relPaths);
    for (const rel of [...this.files.keys()]) {
      if (current.has(rel)) continue;
      fs2.rmSync(path2.join(dir, rel), { force: true });
      this.files.delete(rel);
    }
    for (const rel of relPaths) {
      const source = project.readText(rel);
      if (this.files.get(rel) === source) continue;
      const target = path2.join(dir, rel);
      fs2.mkdirSync(path2.dirname(target), { recursive: true });
      fs2.writeFileSync(target, rel.endsWith(".wxml") ? this.transform(source, rel) : source);
      this.files.set(rel, source);
    }
    return dir;
  }
  dispose() {
    if (this.dir) fs2.rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
    this.files.clear();
  }
};

// src/project/AppBuilder.ts
var MODULE_PARAMS = [
  "require",
  "module",
  "exports",
  "window",
  "document",
  "frames",
  "self",
  "location",
  "navigator",
  "localStorage",
  "history",
  "Caches",
  "screen",
  "alert",
  "confirm",
  "prompt",
  "XMLHttpRequest",
  "WebSocket",
  "Reporter",
  "webkit",
  "WeixinJSCore"
].join(", ");
var ESM_SYNTAX = /(?:^|[;}])\s*(?:import\s*[{*'"]|import\s+[\w$]|export\s*[{*]|export\s+(?:default|const|let|var|function|class|async)\b)/m;
var AppBuilder = class {
  constructor(project, options = {}) {
    this.project = project;
    this.version = 0;
    /** invalidate 标记过的变化次数；每次构建记下开始时覆盖到第几次 */
    this.changes = 0;
    this.pending = null;
    this.last = null;
    this.dirty = /* @__PURE__ */ new Set(["config", "wxml", "wxss", "js"]);
    this.wxmlCache = null;
    this.wxssCache = null;
    /** 开启了 less / sass 编译插件时才有；插件设置变了就换一个 */
    this.styleMirror = null;
    this.wxmlMirror = options.wxmlTransform ? new WxmlMirror(options.wxmlTransform) : null;
  }
  /** wxmlTransform 的镜像目录；没有设置转换或还没编译过时为 null */
  get wxmlMirrorDir() {
    return this.wxmlMirror?.directory ?? null;
  }
  /** 删除 wxmlTransform 和样式预处理的镜像目录，开发服务器关闭时调用 */
  dispose() {
    this.wxmlMirror?.dispose();
    this.styleMirror?.mirror.dispose();
  }
  /** 根据变化的文件标记需要重新构建的部分；返回 true 表示需要刷新 */
  invalidate(changedFiles = []) {
    if (changedFiles.length === 0) {
      ["config", "wxml", "wxss", "js"].forEach((kind) => this.dirty.add(kind));
      this.changes++;
      return true;
    }
    let relevant = false;
    for (const file of changedFiles) {
      const kind = classifyFile(file);
      if (!kind) continue;
      relevant = true;
      this.dirty.add(kind);
      if (kind === "config") {
        this.dirty.add("wxml");
        this.dirty.add("wxss");
      }
    }
    if (relevant) this.changes++;
    return relevant;
  }
  /**
   * 返回包含调用前所有变化的构建结果。并发调用共享同一次构建；
   * 进行中的构建开始得比最近一次变化早时（可能已读到旧文件），等它结束后再构建一次
   */
  async build() {
    const wanted = this.changes;
    for (; ; ) {
      if (!this.pending && this.dirty.size === 0 && this.last) return this.last;
      if (!this.pending) {
        const result2 = this.doBuild().finally(() => {
          this.pending = null;
        });
        this.pending = { covers: this.changes, result: result2 };
      }
      const { covers, result } = this.pending;
      if (covers >= wanted) return result;
      await result.catch(() => void 0);
    }
  }
  /**
   * 单个 JS 模块的 define 包装
   *
   * 包装头和代码第一行写在同一行，行号与源文件一致。使用 import/export 的文件
   * 先转换为 CommonJS（对应开发者工具的「ES6 转 ES5」），并内联 source map。
   */
  getModuleScript(id) {
    let code = this.project.readText(id);
    if (ESM_SYNTAX.test(code)) {
      try {
        code = transformSync(code, {
          format: "cjs",
          loader: "js",
          target: "es2020",
          sourcefile: id,
          sourcemap: "inline"
        }).code;
      } catch (error) {
        const message = `[wxa-runner] ${id} \u8F6C\u6362\u5931\u8D25\uFF1A${error.message}`;
        return `console.error(${JSON.stringify(message)});
`;
      }
    }
    return `define(${JSON.stringify(id)}, function(${MODULE_PARAMS}){${code}
});
`;
  }
  async doBuild() {
    const start = Date.now();
    const dirty = new Set(this.dirty);
    this.dirty.clear();
    try {
      const extJson = this.project.activeExtJson();
      const app = this.project.applyExtJson(this.project.readAppJson());
      const { pages, components } = this.project.collectUnits(app);
      const units = [...components, ...pages];
      const unitJson = new Map(units.map((id) => [id, this.project.readUnitJson(id, app)]));
      this.project.applyExtPages(unitJson);
      const [wxml, wxss] = await Promise.all([
        dirty.has("wxml") || !this.wxmlCache ? this.compileTemplates(units, unitJson) : this.wxmlCache,
        dirty.has("wxss") || !this.wxssCache ? this.compileStyles(units) : this.wxssCache
      ]);
      this.wxmlCache = wxml;
      this.wxssCache = wxss;
      const workersDir = this.project.workersDir(app);
      const inWorkers = (file) => workersDir !== null && file.startsWith(workersDir + "/");
      const scripts = this.project.listFiles([".js"]);
      const modules = scripts.filter((file) => !inWorkers(file));
      const serviceTemplates = this.createTemplates(app, units, unitJson, wxml.cut);
      const pageTemplates = this.createTemplates(app, units, unitJson, wxml.full);
      const pageStyles = createStyles(units, wxss);
      const result = {
        version: ++this.version,
        wxConfig: createWxConfig({
          app,
          pages,
          unitJson,
          appid: this.project.runtimeAppid,
          subPackages: this.project.subPackages(app),
          extJson
        }),
        modules,
        workerModules: scripts.filter(inWorkers),
        serviceTemplates,
        serviceBootstrap: this.createServiceBootstrap(serviceTemplates, units, modules),
        pageFrame: `${pageTemplates}
${pageStyles}`,
        pageTemplates,
        pageStyles,
        pages,
        components,
        durationMs: Date.now() - start
      };
      this.last = result;
      return result;
    } catch (error) {
      dirty.forEach((kind) => this.dirty.add(kind));
      throw error;
    }
  }
  async compileTemplates(units, unitJson) {
    const files = this.project.listFiles([".wxml", ".wxs"]).map((f) => "./" + f);
    const components = units.filter((id) => this.project.exists(id + ".wxml")).map((id) => {
      const json = unitJson.get(id);
      return { path: id, tags: Object.keys({ ...json.usingComponents, ...json.componentGenerics }) };
    });
    const cwd = this.wxmlMirror ? this.wxmlMirror.sync(this.project, files.map((file) => file.slice(2))) : this.project.root;
    const [full, cut] = await Promise.all([
      compileWxml({ cwd, files, components, cut: false }),
      compileWxml({ cwd, files, components, cut: true })
    ]);
    return { full: rewriteSafeAreaInsets(full), cut };
  }
  /** 与开发者工具一致，项目里的 wxss 全部交给 wcsc：被 @import 的文件（如 uni-app 的 common/main.wxss）也要在列表里 */
  async compileStyles(units) {
    const mirror = this.currentStyleMirror();
    const { cwd, files } = mirror ? await mirror.sync(this.project) : { cwd: this.project.root, files: this.project.listFiles([".wxss"]) };
    const styles = new Set(files);
    const pageFiles = units.filter((id) => styles.has(id + ".wxss")).map((id) => `./${id}.wxss`);
    const commonFiles = files.map((file) => `./${file}`).filter((file) => !pageFiles.includes(file));
    const { comm, pages } = await compileWxss({ cwd, pageFiles, commonFiles });
    return {
      comm: rewriteSafeAreaInsets(comm),
      pages: Object.fromEntries(Object.entries(pages).map(([file, css]) => [file, rewriteSafeAreaInsets(css)]))
    };
  }
  currentStyleMirror() {
    const setting = this.project.styleSetting;
    const key = JSON.stringify(setting);
    if (this.styleMirror?.setting !== key) {
      this.styleMirror?.mirror.dispose();
      this.styleMirror = setting.plugins.length > 0 ? { setting: key, mirror: new StyleMirror(setting) } : null;
    }
    return this.styleMirror?.mirror ?? null;
  }
  /** $gwx 加上各页面、组件的 json / wxml 注册；逻辑层用裁剪版 $gwx，渲染层用完整版 */
  createTemplates(app, units, unitJson, gwx) {
    const lines = [gwx, `__wxAppCode__["app.json"] = ${toJs(app)};`];
    for (const id of units) {
      lines.push(`__wxAppCode__[${toJs(id + ".json")}] = ${toJs(unitJson.get(id))};`);
      if (this.project.exists(id + ".wxml")) {
        lines.push(`__wxAppCode__[${toJs(id + ".wxml")}] = $gwx(${toJs("./" + id + ".wxml")});`);
      }
    }
    return lines.join("\n");
  }
  createServiceBootstrap(serviceTemplates, units, modules) {
    const lines = [serviceTemplates];
    if (modules.includes("app.js")) {
      lines.push(requireStatement("app.js", null));
    }
    for (const id of units) {
      if (modules.includes(id + ".js")) lines.push(requireStatement(id + ".js", id));
    }
    return lines.join("\n");
  }
};
function createStyles(units, wxss) {
  const lines = [wxss.comm];
  for (const id of units) {
    const css = wxss.pages[id + ".wxss"];
    if (css) lines.push(`__wxAppCode__[${toJs(id + ".wxss")}] = ${css};`);
  }
  return lines.join("\n");
}
function requireStatement(file, route) {
  const routeSetup = route ? `__wxRoute = ${toJs(route)}; __wxRouteBegin = true; __wxAppCurrentFile__ = ${toJs(file)};` : `__wxAppCurrentFile__ = ${toJs(file)};`;
  return `${routeSetup}
try { require(${toJs(file)}); } catch (error) { console.error(${toJs("[wxa-runner] " + file + " \u6267\u884C\u51FA\u9519\n")}, error); }`;
}
function rewriteSafeAreaInsets(code) {
  return code.replace(/\b(?:env|constant)\(\s*safe-area-inset-(top|right|bottom|left)\b/g, "var(--wxa-safe-area-inset-$1");
}
function classifyFile(file) {
  if (file.endsWith(".json")) return "config";
  if (file.endsWith(".wxml") || file.endsWith(".wxs")) return "wxml";
  if (/\.(wxss|less|scss|sass|css)$/.test(file)) return "wxss";
  if (file.endsWith(".js")) return "js";
  return null;
}

// src/project/MiniProgram.ts
import fs3 from "fs";
import path3 from "path";
var EXT_APP_FIELDS = [
  "window",
  "tabBar",
  "networkTimeout",
  "plugins",
  "debug",
  "permission",
  "requiredPrivateInfos",
  "resizable"
];
var IGNORED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", ".idea", ".vscode"]);
var PROJECT_FILES = /* @__PURE__ */ new Set(["project.config.json", "project.private.config.json", "sitemap.json", "app.json", "ext.json", "wxa.setup.js"]);
var MiniProgram = class {
  constructor(projectPath) {
    this.projectPath = projectPath;
    const projectConfig = readJsonFile(path3.join(projectPath, "project.config.json")) || {};
    this.root = path3.resolve(projectPath, projectConfig.miniprogramRoot || "");
    this.appid = projectConfig.appid || "touristappid";
    if (!fs3.existsSync(path3.join(this.root, "app.json"))) {
      throw new Error(`${this.root} \u4E0B\u6CA1\u6709 app.json\uFF0C\u4E0D\u662F\u6709\u6548\u7684\u5C0F\u7A0B\u5E8F\u76EE\u5F55`);
    }
  }
  /** project.config.json 里与 less / sass 编译插件有关的设置；每次重新读取，开发中修改了也能生效 */
  get styleSetting() {
    return readStyleSetting(readJsonFile(path3.join(this.projectPath, "project.config.json"))?.setting);
  }
  /** ext.json 的原始内容；没有这个文件时为 null */
  readExtJson() {
    const file = path3.join(this.root, "ext.json");
    if (!fs3.existsSync(file)) return null;
    const json = readJsonFile(file);
    if (!json) throw new Error(`${file} \u4E0D\u662F\u5408\u6CD5\u7684 JSON`);
    return json;
  }
  /**
   * 生效的 ext.json：只有 extEnable 为 true 才启用，与微信文档一致（extEnable 必填、为 true 时生效）。
   * 没写 extEnable 时按不启用处理，和开发者工具的布尔判断一致
   */
  activeExtJson() {
    const ext = this.readExtJson();
    return ext && ext.extEnable === true ? ext : null;
  }
  /**
   * 运行时 appid：第三方平台代开发时以 ext.json 的 extAppid（授权方小程序）为准，
   * 与开发者工具在代开发项目里的行为一致；其余情况用 project.config.json 的 appid
   */
  get runtimeAppid() {
    return this.activeExtJson()?.extAppid || this.appid;
  }
  /** 按 ext.json 覆盖 app.json 中允许覆盖的字段；没启用时原样返回 */
  applyExtJson(app) {
    const ext = this.activeExtJson();
    if (!ext) return app;
    const merged = { ...app };
    for (const field of EXT_APP_FIELDS) {
      if (ext[field] !== void 0) merged[field] = ext[field];
    }
    return merged;
  }
  /** ext.json 的 extPages：按微信客户端的规则直接覆盖指定页面的配置，不接受新增页面 */
  applyExtPages(unitJson) {
    const extPages = this.activeExtJson()?.extPages;
    if (!extPages) return;
    for (const [id, override] of Object.entries(extPages)) {
      const current = unitJson.get(id);
      if (current && override && typeof override === "object") unitJson.set(id, { ...current, ...override });
    }
  }
  readAppJson() {
    const app = readJsonFile(path3.join(this.root, "app.json"));
    if (!app || !Array.isArray(app.pages) || app.pages.length === 0) {
      throw new Error("app.json \u7F3A\u5C11 pages \u914D\u7F6E");
    }
    return app;
  }
  subPackages(app) {
    return app.subPackages || app.subpackages || [];
  }
  /** Worker 代码所在目录，不带首尾的 /；没有配置 workers 时为 null */
  workersDir(app) {
    const dir = typeof app.workers === "string" ? app.workers : app.workers?.path;
    return dir ? path3.posix.normalize(dir).replace(/^\/+|\/+$/g, "") : null;
  }
  /** 主包页面 + 分包页面（带 root 前缀） */
  allPages(app) {
    const pages = [...app.pages];
    for (const pkg of this.subPackages(app)) {
      for (const page of pkg.pages) {
        const full = path3.posix.join(pkg.root, page);
        if (!pages.includes(full)) pages.push(full);
      }
    }
    return pages;
  }
  /**
   * 读取并预处理页面/组件 json，id 不带扩展名。
   * 基础库运行时只把组件引用和当前路径拼在一起，不查找 miniprogram_npm、不补 /index（开发者工具编译时已解析好），
   * 所以能解析到的引用都换成组件的绝对路径
   */
  readUnitJson(id, app) {
    const json = { ...readJsonFile(path3.join(this.root, id + ".json")) };
    const resolve = (fromId, ref) => {
      const resolved = this.resolveComponent(fromId, ref);
      return resolved ? "/" + resolved : null;
    };
    json.usingComponents = Object.fromEntries(
      Object.entries(json.usingComponents || {}).map(([tag, ref]) => [tag, resolve(id, ref) ?? ref])
    );
    if (json.componentGenerics) {
      json.componentGenerics = Object.fromEntries(Object.entries(json.componentGenerics).map(([name, generic]) => [
        name,
        typeof generic === "object" && generic.default ? { ...generic, default: resolve(id, generic.default) ?? generic.default } : generic
      ]));
    }
    if (!/(^|\/)miniprogram_npm\//.test(id) && !this.isInIndependentSubPackage(id, app)) {
      for (const [tag, ref] of Object.entries(app.usingComponents || {})) {
        if (json.usingComponents[tag]) continue;
        const resolved = resolve("app", ref);
        if (resolved || ref.startsWith("/") || /^plugin(-private)?:\/\//.test(ref)) {
          json.usingComponents[tag] = resolved ?? ref;
        } else {
          const relative = path3.posix.relative(path3.posix.dirname(id), ref);
          json.usingComponents[tag] = relative.startsWith(".") ? relative : "./" + relative;
        }
      }
    }
    return json;
  }
  /**
   * 解析组件引用到组件路径（不带扩展名）；插件组件或找不到时返回 null。
   * 规则：/ 开头为根目录绝对路径；否则先按相对路径找，再沿目录向上查找 miniprogram_npm。
   */
  resolveComponent(fromId, ref) {
    if (!ref || ref.startsWith("plugin://") || ref.startsWith("plugin-private://")) return null;
    const fromDir = path3.posix.dirname(fromId);
    const candidates = [];
    if (ref.startsWith("/")) {
      candidates.push(ref.slice(1));
    } else {
      candidates.push(path3.posix.join(fromDir, ref));
      if (!ref.startsWith(".")) {
        let dir = fromDir;
        for (; ; ) {
          candidates.push(path3.posix.join(dir === "." ? "" : dir, "miniprogram_npm", ref));
          if (dir === "." || dir === "") break;
          dir = path3.posix.dirname(dir);
        }
      }
    }
    for (const candidate of candidates) {
      const normalized = path3.posix.normalize(candidate);
      for (const id of [normalized, path3.posix.join(normalized, "index")]) {
        if (fs3.existsSync(path3.join(this.root, id + ".json"))) return id;
      }
    }
    return null;
  }
  /** 收集页面、隐式自定义 tabBar 及它们（递归）引用到的组件 */
  collectUnits(app) {
    const pages = this.allPages(app);
    const components = [];
    const visited = new Set(pages);
    const visit = (id) => {
      const json = this.readUnitJson(id, app);
      const refs = Object.values(json.usingComponents);
      for (const generic of Object.values(json.componentGenerics || {})) {
        if (typeof generic === "object" && generic.default) refs.push(generic.default);
      }
      for (const ref of refs) enter(this.resolveComponent(id, ref));
    };
    const enter = (id) => {
      if (!id || visited.has(id)) return;
      visited.add(id);
      components.push(id);
      visit(id);
    };
    if (app.tabBar?.custom) enter(this.resolveComponent("app", "/custom-tab-bar/index"));
    pages.forEach(visit);
    return { pages, components };
  }
  /** 列出代码根目录下指定扩展名的文件，返回 posix 风格的相对路径 */
  listFiles(extensions) {
    const result = [];
    const walk = (dir, rel) => {
      for (const entry of fs3.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path3.join(dir, entry.name), childRel);
        } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
          if (!rel && PROJECT_FILES.has(entry.name)) continue;
          result.push(childRel);
        }
      }
    };
    walk(this.root, "");
    return result.sort();
  }
  exists(relPath) {
    return fs3.existsSync(path3.join(this.root, relPath));
  }
  readText(relPath) {
    return fs3.readFileSync(path3.join(this.root, relPath), "utf8");
  }
  isInIndependentSubPackage(id, app) {
    return this.subPackages(app).some((pkg) => pkg.independent && id.startsWith(pkg.root.replace(/\/?$/, "/")));
  }
};
function readJsonFile(file) {
  if (!fs3.existsSync(file)) return null;
  const text = fs3.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} \u4E0D\u662F\u5408\u6CD5\u7684 JSON\uFF1A${error.message}`);
  }
}

// src/runtime/networkPanel.ts
var PROXY_PREFIX = "/__wxa__/proxy/";
var MOCK_PREFIX = "/__wxa__/mock/";
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

// src/server/pluginCode.ts
function withPlugins(build2, plugins) {
  if (!plugins.length) return { ...build2, plugins };
  return {
    ...build2,
    plugins,
    pages: [...build2.pages, ...plugins.flatMap((plugin) => plugin.pages)],
    wxConfig: {
      ...build2.wxConfig,
      page: { ...build2.wxConfig.page, ...Object.assign({}, ...plugins.map((plugin) => plugin.pageConfigs)) }
    }
  };
}
function findPluginPage(build2, pagePath) {
  for (const plugin of build2.plugins) {
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
  <script src="/__wxa__/runtime/host.js"></script>
</body>
</html>`;
}
function enableHotUpdate(hot) {
  return hot ? `<script>if (typeof __virtualDOM__ !== 'undefined' && __virtualDOM__.enableUpdateWxAppCode) __virtualDOM__.enableUpdateWxAppCode();</script>
` : "";
}
function appserviceHtml(build2, launch, options) {
  const wxConfig = {
    ...build2.wxConfig,
    appLaunchInfo: { scene: 1001, path: launch.path, query: launch.query },
    ...options.isolated ? { isIsolateContext: true } : {}
  };
  const v = build2.version;
  const pluginUrls = build2.plugins.map((plugin) => pluginScriptUrl(plugin, "appservice.js"));
  const moduleUrls = build2.modules.map((id) => `/__wxa__/module/${encodeURI(id)}?v=${v}`);
  const bootstrapUrl = `/__wxa__/service-bootstrap.js?v=${v}`;
  if (options.isolated) {
    const scripts = [...pluginUrls, ...moduleUrls, bootstrapUrl];
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>appservice</title>
<script>var __wxConfig = ${toJs(wxConfig)};</script>
<script src="/__wxa__/runtime/frame.js" data-kind="service" data-app-service="${escapeHtml(JSON.stringify(scripts))}"${options.hot ? ' data-hot="1"' : ""}></script>
<script src="/__baselib__/WAServiceMainContext.js"></script>
</head>
<body></body>
</html>`;
  }
  const modules = [...pluginUrls, ...moduleUrls].map((src) => `<script src="${src}"></script>`).join("\n");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>appservice</title>
<script>var __wxConfig = ${toJs(wxConfig)};</script>
<script src="/__wxa__/runtime/frame.js" data-kind="service"></script>
<script src="/__baselib__/WAService.js"></script>
${enableHotUpdate(options.hot)}<script>
if (typeof define !== 'function') {
  console.error('[wxa-runner] \u57FA\u7840\u5E93\u6CA1\u6709\u5B8C\u6210\u521D\u59CB\u5316\uFF08define \u4E0D\u5B58\u5728\uFF09\uFF0C\u5F53\u524D\u57FA\u7840\u5E93\u7248\u672C\u53EF\u80FD\u4E0D\u53D7\u652F\u6301');
}
</script>
${modules}
<script src="${bootstrapUrl}"></script>
<script>parent.__wxaHost.frameLoaded('service', 0);</script>
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
<script src="/__wxa__/runtime/frame.js" data-kind="service" data-context-id="${id}"></script>
${empty ? "" : '<script src="/__baselib__/WASubContext.js"></script>\n'}<script>parent.__wxaContexts.loaded(${id});</script>
</head>
<body></body>
</html>`;
}
function webviewHtml(build2, pagePath, webviewId, options) {
  const id = Number(webviewId) || 0;
  return `<!DOCTYPE html>
<html>
<head>
${webviewHead(build2, pagePath, id, options.scripts)}
${enableHotUpdate(options.hot)}<script src="/__wxa__/page-frame.js?v=${build2.version}"></script>
${pageWindow(build2, pagePath).disableScroll ? "<style>body{overflow-y:hidden}</style>" : ""}
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
</script>
</body>
</html>`;
}
function workerScript(build2, baseLib) {
  const modules = build2.workerModules.map((id) => `/__wxa__/module/${encodeURI(id)}?v=${build2.version}`);
  const prelude = `var __wxConfig = ${toJs(build2.wxConfig)}; __wxConfig.env.USER_DATA_PATH = location.origin + "/__wxa__/usr/" + new URL(location.href).searchParams.get("session");
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
function pluginWebviewHtml(build2, plugin, innerPath, pagePath, webviewId, options = {}) {
  const id = Number(webviewId) || 0;
  const html2 = plugin.files.get(`/${innerPath}.html`);
  const page = html2 ? new TextDecoder().decode(html2) : `<script>console.error(${JSON.stringify(`[wxa-runner] \u63D2\u4EF6 ${plugin.alias} \u91CC\u6CA1\u6709\u9875\u9762 ${innerPath}`)})</script>`;
  return `<!DOCTYPE html>
<html>
<head>
${webviewHead(build2, pagePath, id, options.scripts)}
<script src="${pluginScriptUrl(plugin, "pageframe.js")}"></script>
${pageWindow(build2, pagePath).disableScroll ? "<style>body{overflow-y:hidden}</style>" : ""}
</head>
<body>
${scriptTags(options.scripts, "body")}${page}
<script>parent.__wxaHost.frameLoaded('webview', ${id});</script>
</body>
</html>`;
}
function pageWindow(build2, pagePath) {
  return { ...build2.wxConfig.global?.window, ...build2.wxConfig.page?.[pagePath + ".html"]?.window };
}
function webviewHead(build2, pagePath, id, scripts) {
  const wxConfig = { ...build2.wxConfig, window: pageWindow(build2, pagePath) };
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
<script>var __wxConfig = ${toJs(wxConfig)};</script>
<script src="/__wxa__/runtime/frame.js" data-kind="webview" data-webview-id="${id}"></script>
${scriptTags(scripts, "head")}<script src="/__baselib__/WAWebview.js"></script>`;
}
function scriptTags(scripts, position) {
  return (scripts ?? []).filter((script) => (script.position ?? "body") === position).map((script) => script.src !== void 0 ? `<script src="${escapeHtml(script.src)}"></script>
` : `<script>${script.content.replace(/<\/script/gi, "<\\/script")}</script>
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
  const { build: build2 } = source;
  const pathname = safeDecode(url.pathname);
  if (pathname === null) return null;
  const query = url.searchParams;
  switch (pathname) {
    case "/__wxa__/appservice.html": {
      const launchPath = (query.get("path") || "").replace(/^\//, "");
      const launch = build2.pages.includes(launchPath) ? { path: launchPath, query: Object.fromEntries(new URLSearchParams(query.get("query") || "")) } : { path: build2.pages[0], query: {} };
      return html(appserviceHtml(build2, launch, { hot: source.hot, isolated: source.isolated }));
    }
    case "/__wxa__/subcontext.html": {
      const id = Number(query.get("id"));
      if (!Number.isInteger(id) || id <= 0) return { status: 400, type: "text", body: "\u5B50\u4E0A\u4E0B\u6587 id \u65E0\u6548" };
      return html(subcontextHtml(id, query.get("empty") === "1"));
    }
    case "/__wxa__/worker.js":
      return js(workerScript(build2, source.baseLib));
    case "/__wxa__/service-bootstrap.js":
      return js(build2.serviceBootstrap);
    case "/__wxa__/service-templates.js":
      return js(build2.serviceTemplates);
    case "/__wxa__/page-templates.js":
      return js(build2.pageTemplates);
    case "/__wxa__/page-styles.js":
      return js(build2.pageStyles);
    case "/__wxa__/page-frame.js":
      return js(build2.pageFrame);
  }
  const webview = /^\/__wxa__\/webview\/(.+)\.html$/.exec(pathname);
  if (webview) {
    const pagePath = webview[1];
    if (!build2.pages.includes(pagePath)) return null;
    const webviewId = Number(query.get("id"));
    const pluginPage = findPluginPage(build2, pagePath);
    return html(pluginPage ? pluginWebviewHtml(build2, pluginPage.plugin, pluginPage.innerPath, pagePath, webviewId, { scripts: source.webviewScripts }) : webviewHtml(build2, pagePath, webviewId, { hot: source.hot, scripts: source.webviewScripts }));
  }
  const pluginScript = PLUGIN_SCRIPT.exec(pathname);
  if (pluginScript) {
    const [, provider, version, file] = pluginScript;
    const code = build2.plugins.find((plugin) => plugin.provider === provider && plugin.version === version)?.files.get(`/${file}`);
    return code ? { status: 200, type: "js", body: code } : null;
  }
  const pluginFile = /^\/__plugin__\/([^/]+)(\/.+)$/.exec(pathname);
  if (pluginFile) {
    const file = build2.plugins.find((plugin) => plugin.provider === pluginFile[1])?.files.get(pluginFile[2]);
    return file ? { status: 200, type: extname(pluginFile[2]) || "application/octet-stream", body: file } : null;
  }
  const module = /^\/__wxa__\/module\/(.+\.js)$/.exec(pathname);
  if (module) {
    const id = module[1];
    if (!build2.modules.includes(id) && !build2.workerModules.includes(id)) {
      return { status: 404, type: "js", body: `console.error(${JSON.stringify(`[wxa-runner] \u6A21\u5757 ${id} \u4E0D\u5B58\u5728`)})` };
    }
    return js(source.moduleScript(id));
  }
  return null;
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

// src/server/ignoreList.ts
var STRIDE = 100;
var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function ignoreListSourceMap(code, source) {
  let previousColumn = 0;
  const mappings = code.split("\n").map((line, index) => {
    const segments = [];
    for (let column = 0; column === 0 || column < line.length; column += STRIDE) {
      const sourceLine = column === 0 && index > 0 ? 1 : 0;
      segments.push(vlq(column === 0 ? 0 : STRIDE) + vlq(0) + vlq(sourceLine) + vlq(column - previousColumn));
      previousColumn = column;
    }
    return segments.join(",");
  });
  return JSON.stringify({ version: 3, sources: [source], names: [], mappings: mappings.join(";"), x_google_ignoreList: [0] });
}
function vlq(value) {
  let rest = value < 0 ? -value << 1 | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

// src/server/forwardConsole.ts
var MAX_LENGTH = 4e3;
var LIMIT_PER_SECOND = 20;
var CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
function printBrowserReports(socket, logger) {
  let windowStart = 0;
  let printed = 0;
  let dropped = 0;
  socket.on("message", (data) => {
    const report = parseReport(data);
    if (!report) return;
    const now = Date.now();
    if (now - windowStart >= 1e3) {
      windowStart = now;
      printed = 0;
    }
    if (printed >= LIMIT_PER_SECOND) {
      if (dropped++ === 0) {
        setTimeout(() => {
          logger.warn(`[wxa-runner] \u6D4F\u89C8\u5668 1 \u79D2\u5185\u8F6C\u53D1\u7684\u62A5\u9519\u592A\u591A\uFF0C\u7701\u7565\u4E86 ${dropped} \u6761`);
          dropped = 0;
        }, windowStart + 1e3 - now).unref();
      }
      return;
    }
    printed++;
    logger[report.level](`[wxa-runner] ${clean(report.text)}`);
  });
}
function parseReport(data) {
  try {
    const report = JSON.parse(data.toString());
    if (report?.type === "console" && (report.level === "warn" || report.level === "error") && typeof report.text === "string") return report;
  } catch {
  }
  return null;
}
function clean(text) {
  const printable = text.replace(CONTROL_CHARS, "");
  return printable.length > MAX_LENGTH ? `${printable.slice(0, MAX_LENGTH)}\u2026\uFF08\u5DF2\u622A\u65AD\uFF09` : printable;
}
function ignoreConsoleHook(sourceMap) {
  const map = JSON.parse(sourceMap);
  map.x_google_ignoreList = map.sources.flatMap((source, index) => source.endsWith("consoleHook.ts") ? [index] : []);
  return JSON.stringify(map);
}

// src/server/proxy.ts
import { Readable } from "stream";
import { pipeline } from "stream/promises";

// src/server/proxyFetch.ts
var DROPPED_REQUEST_HEADERS = /* @__PURE__ */ new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "expect"]);
var DROPPED_RESPONSE_HEADERS = /* @__PURE__ */ new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
async function proxyFetch(request, options = {}) {
  const url = new URL(request.url);
  const path8 = url.pathname + url.search;
  const target = fromServerPath(PROXY_PREFIX, path8);
  if (!target) return proxyError(400, `invalid url "${path8}"`);
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

// src/server/proxy.ts
async function handleProxy(req, res) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once("close", cancel);
  try {
    const headers = new Headers();
    for (const name of ["x-wxa-headers", "content-type"]) {
      const value = req.get(name);
      if (value !== void 0) headers.set(name, value);
    }
    const hasBody = !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
    const request = new globalThis.Request(`http://localhost${req.originalUrl}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : void 0,
      signal: controller.signal
    });
    const response = await proxyFetch(request);
    if (res.destroyed || controller.signal.aborted) {
      await response.body?.cancel();
      return;
    }
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.status(response.status);
    res.flushHeaders();
    if (!response.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (!res.destroyed) res.destroy(error);
  } finally {
    res.off("close", cancel);
  }
}

// src/server/socketProxy.ts
import { WebSocket, WebSocketServer } from "ws";
function mirrorClose(to, code, reason) {
  if (code === 1005) to.close();
  else if (code === 1006 || code === 1015) to.terminate();
  else to.close(code, reason);
}
function createSocketProxy() {
  const server = new WebSocketServer({
    noServer: true,
    // 不能让其他网站借本地开发服务器建立任意带凭据的连接。
    verifyClient: ({ origin, req }) => origin === `http://${req.headers.host}`
  });
  server.on("connection", (client) => {
    let upstream;
    const timer = setTimeout(() => client.close(1008, "Missing socket request"), 1e4);
    timer.unref();
    client.on("error", () => void 0);
    client.once("message", (data, binary) => {
      clearTimeout(timer);
      try {
        if (binary || data.toString().length > 64 * 1024) throw new Error("Invalid socket request");
        const { url, header: header2, protocols, timeout } = JSON.parse(data.toString());
        const target = new URL(url);
        if (!["ws:", "wss:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid socket URL");
        upstream = new WebSocket(target, protocols || [], {
          headers: header2 || {},
          handshakeTimeout: typeof timeout === "number" && timeout > 0 ? timeout : 6e4
        });
      } catch {
        client.close(1008, "Invalid socket request");
        return;
      }
      const socket = upstream;
      let header = {};
      socket.on("upgrade", (response) => {
        header = response.headers;
      });
      socket.on("open", () => {
        if (client.readyState !== WebSocket.OPEN) {
          socket.close();
          return;
        }
        client.send(JSON.stringify({ ready: true, header }));
      });
      socket.on("message", (message, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(message, { binary: isBinary });
      });
      client.on("message", (message, isBinary) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(message, { binary: isBinary });
      });
      socket.on("error", () => client.terminate());
      socket.on("close", (code, reason) => {
        if (client.readyState === WebSocket.OPEN) mirrorClose(client, code, reason);
      });
    });
    client.on("close", (code, reason) => {
      clearTimeout(timer);
      if (upstream?.readyState === WebSocket.OPEN) mirrorClose(upstream, code, reason);
      else if (upstream) upstream.terminate();
    });
  });
  return server;
}

// src/server/hmr.ts
var STYLE_FILE = /\.(wxss|less|scss|sass|css)$/;
function planHotUpdate(files, units) {
  const owners = /* @__PURE__ */ new Set([...units.pages, ...units.components]);
  const plan = { templates: [], scripts: [], styles: [] };
  for (const file of files) {
    const id = file.replace(/\.(wxml|js|wxss|less|scss|sass|css)$/, "");
    const target = STYLE_FILE.test(file) ? plan.styles : !owners.has(id) ? null : file.endsWith(".wxml") ? plan.templates : file.endsWith(".js") ? plan.scripts : null;
    if (!target) return null;
    if (!target.includes(id)) target.push(id);
  }
  return plan;
}

// src/server/developerTicket.ts
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { setTimeout as sleep } from "timers/promises";
import { WebSocket as WebSocket2 } from "ws";
import { findDeveloperTicket, findElectronDevtoolsCli, TICKET_ENV } from "@open-wxa/wxa-runner-extractor";
var AUTO_PORT = 9420;
var CLI_TIMEOUT = 6e4;
var AUTOMATOR_TIMEOUT = 5e3;
var LOGIN_TIMEOUT = 2e4;
var WINDOW_TIMEOUT = 1e4;
var WINDOW_RETRY_INTERVAL = 500;
function devtoolsSession(projectPath, logger, options = {}) {
  const cli = findElectronDevtoolsCli();
  if (!cli) return { findTicket: async () => findDeveloperTicket(), loginCode: null };
  let automatorPort = null;
  const startOnce = () => {
    if (!automatorPort) {
      const starting = startAutomation(cli, projectPath).then((port) => {
        logger.log(`[wxa-runner] --devtools-login\uFF1A\u5DF2\u5728\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u91CC\u4E3A\u9879\u76EE\u5F00\u542F\u81EA\u52A8\u5316\u63A5\u53E3\uFF08\u7AEF\u53E3 ${port}\uFF09\uFF0Cticket \u4ECE\u5F00\u53D1\u8005\u5DE5\u5177\u5B9E\u65F6\u83B7\u53D6`);
        return port;
      });
      starting.catch(() => {
        if (automatorPort === starting) automatorPort = null;
      });
      automatorPort = starting;
    }
    return automatorPort;
  };
  const withRestart = async (run) => {
    const port = startOnce();
    try {
      return await run(await port);
    } catch (error) {
      if (!(error instanceof AutomatorGone)) throw error;
      if (automatorPort === port) automatorPort = null;
      return run(await startOnce());
    }
  };
  let loginCodeNoticed = false;
  return {
    findTicket: async () => {
      if (process.env[TICKET_ENV]) return { newticket: process.env[TICKET_ENV] };
      return withRestart((port) => onceWindowReady(() => requestTicket(port), projectPath));
    },
    loginCode: async () => {
      const code = await withRestart((port) => onceWindowReady(() => requestLoginCode(port), projectPath));
      if (!loginCodeNoticed) {
        loginCodeNoticed = true;
        logger.log(
          options.simulatorLogin ? "[wxa-runner] --devtools-login\uFF1A\u4E09\u65B9\u5E73\u53F0\u4EE3\u5F00\u53D1\uFF0Cwx.login \u7684 code \u7531\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u6A21\u62DF\u5668\u81EA\u5DF1\u8C03\uFF08\u6309 ext.json \u7684 extAppid\uFF0C\u5C5E\u4E8E\u6388\u6743\u65B9\uFF09\uFF1B\u624B\u673A\u53F7\u3001\u670D\u52A1\u5E02\u573A\u548C\u63D2\u4EF6\u4ECD\u8D70 ticket\uFF0C\u5728\u8FD9\u4E2A appid \u4E0B\u53EF\u80FD\u53D6\u4E0D\u5230" : "[wxa-runner] --devtools-login\uFF1A\u5FAE\u4FE1\u540E\u53F0\u4E0D\u7ED9\u8FD9\u4E2A appid \u53D6\u767B\u5F55\u7968\u636E\uFF0Cwx.login \u7684 code \u6539\u7531\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u6A21\u62DF\u5668\u83B7\u53D6\uFF1B\u624B\u673A\u53F7\u3001\u670D\u52A1\u5E02\u573A\u548C\u63D2\u4EF6\u6CA1\u6709\u8FD9\u6761\u8DEF\uFF0C\u8C03\u7528\u65F6\u4F1A\u5931\u8D25"
        );
      }
      return code;
    }
  };
}
var AutomatorGone = class extends Error {
};
var WindowNotFound = class extends Error {
};
var TicketNotAllowed = class extends Error {
};
async function onceWindowReady(run, projectPath) {
  const deadline = Date.now() + WINDOW_TIMEOUT;
  for (; ; ) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof WindowNotFound)) throw error;
      if (Date.now() >= deadline) throw new Error(`\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u91CC\u627E\u4E0D\u5230\u9879\u76EE\u7A97\u53E3\uFF0C\u8BF7\u5728\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u91CC\u6253\u5F00\u9879\u76EE ${projectPath}`);
      await sleep(WINDOW_RETRY_INTERVAL);
    }
  }
}
async function startAutomation(cli, projectPath) {
  const stdout = await runCli(cli, ["agent", "start", "--project", projectPath, "--auto-port", String(AUTO_PORT), "--lang", "zh"]);
  let autoPort = NaN;
  try {
    autoPort = Number(JSON.parse(stdout.match(/^\{$[\s\S]*?^\}$/m)?.[0] ?? "").autoPort);
  } catch {
  }
  if (Number.isInteger(autoPort) && autoPort > 0) return autoPort;
  if (stdout.includes("\u670D\u52A1\u7AEF\u53E3\u5DF2\u5173\u95ED")) {
    throw new Error("\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u670D\u52A1\u7AEF\u53E3\u5DF2\u5173\u95ED\uFF0C\u8BF7\u5728\u5F00\u53D1\u8005\u5DE5\u5177\u300C\u8BBE\u7F6E \u2192 \u5B89\u5168\u8BBE\u7F6E\u300D\u91CC\u5F00\u542F\u670D\u52A1\u7AEF\u53E3");
  }
  throw new Error(`\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u6CA1\u80FD\u4E3A\u9879\u76EE\u5F00\u542F\u81EA\u52A8\u5316\u63A5\u53E3\uFF1A${cliErrorMessage(stdout)}`);
}
function runCli(cli, args) {
  const bat = cli.endsWith(".bat");
  const [file, fileArgs] = bat ? [`"${cli}"`, args.map((arg) => `"${arg}"`)] : [cli, args];
  return new Promise((resolve, reject) => {
    const child = execFile(file, fileArgs, { shell: bat, timeout: CLI_TIMEOUT, windowsHide: true }, (error, stdout) => {
      if (error?.killed) {
        reject(new Error(`\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u547D\u4EE4\u884C ${CLI_TIMEOUT / 1e3}s \u5185\u6CA1\u6709\u5B8C\u6210\uFF0C\u8BF7\u770B\u5F00\u53D1\u8005\u5DE5\u5177\u91CC\u662F\u5426\u6709\u7B49\u5F85\u786E\u8BA4\u7684\u5F39\u7A97\uFF08\u5982\u4FE1\u4EFB\u9879\u76EE\u3001\u626B\u7801\u767B\u5F55\uFF09`));
      } else if (error && !stdout) {
        reject(new Error(`\u8FD0\u884C\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u547D\u4EE4\u884C\u5931\u8D25\uFF1A${error.message}`));
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.end();
  });
}
function cliErrorMessage(stdout) {
  const output = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const start = output.indexOf("[error]");
  const error = (start < 0 ? output : output.slice(start + "[error]".length)).trim();
  const message = error.match(/message: (['"`])((?:\\.|(?!\1)[^\\])*?)(?:\\n|\1)/)?.[2];
  return message ?? (error.replace(/\s+/g, " ").slice(0, 200) || "\u547D\u4EE4\u884C\u6CA1\u6709\u8F93\u51FA");
}
function sendCommand(port, method, params, timeout) {
  return new Promise((resolve, reject) => {
    const id = `wxa-runner-${randomUUID()}`;
    const socket = new WebSocket2(`ws://127.0.0.1:${port}`);
    const settle = (finish) => {
      clearTimeout(timer);
      socket.removeAllListeners().on("error", () => void 0).terminate();
      finish();
    };
    const timer = setTimeout(
      () => settle(() => reject(new AutomatorGone(`\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u81EA\u52A8\u5316\u63A5\u53E3 ${timeout / 1e3}s \u5185\u6CA1\u6709\u54CD\u5E94\uFF0C\u8BF7\u786E\u8BA4\u5F00\u53D1\u8005\u5DE5\u5177\u91CC\u6253\u5F00\u4E86\u9879\u76EE\u7A97\u53E3`))),
      timeout
    );
    const gone = () => settle(() => reject(new AutomatorGone(`\u8FDE\u4E0D\u4E0A\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u81EA\u52A8\u5316\u63A5\u53E3\uFF08\u7AEF\u53E3 ${port}\uFF09\uFF0C\u8BF7\u786E\u8BA4\u5F00\u53D1\u8005\u5DE5\u5177\u5728\u8FD0\u884C`)));
    socket.on("error", gone);
    socket.on("close", gone);
    socket.on("open", () => socket.send(JSON.stringify({ id, method, params })));
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message?.id !== id) return;
      if (message.error) settle(() => reject(explainAutomatorError(String(message.error.message))));
      else settle(() => resolve(message.result ?? {}));
    });
  });
}
async function requestTicket(port) {
  const result = await sendCommand(port, "Tool.getTicket", {}, AUTOMATOR_TIMEOUT);
  if (typeof result.ticket !== "string") throw new Error("\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u6CA1\u6709\u8FD4\u56DE\u767B\u5F55\u7968\u636E");
  return { newticket: result.ticket, expiredAt: result.expiredTime };
}
async function requestLoginCode(port) {
  const result = await sendCommand(port, "App.callWxMethod", { method: "login", args: [{}] }, LOGIN_TIMEOUT);
  const { code, errMsg } = result.result ?? {};
  if (typeof code !== "string" || !code) {
    throw new Error(`\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u6A21\u62DF\u5668\u6CA1\u6709\u8FD4\u56DE code${errMsg ? `\uFF1A${errMsg}` : ""}`);
  }
  return code;
}
function explainAutomatorError(message) {
  if (message.includes("GUI project window is not found")) return new WindowNotFound(message);
  if (message.includes("navigate to security settings")) {
    return new Error("\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u4E0D\u5141\u8BB8\u83B7\u53D6\u767B\u5F55\u7968\u636E\uFF0C\u8BF7\u5728\u5F00\u53D1\u8005\u5DE5\u5177\u300C\u8BBE\u7F6E \u2192 \u5B89\u5168\u8BBE\u7F6E\u300D\u91CC\u6253\u5F00\u300C\u5141\u8BB8\u83B7\u53D6\u5DE5\u5177\u767B\u5F55\u7968\u636E\u300D");
  }
  if (message.includes("not allow to get")) {
    return new TicketNotAllowed(
      `\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u4E0D\u7ED9\u8FD9\u4E2A appid \u53D6\u767B\u5F55\u7968\u636E\uFF1A\u662F\u5426\u5141\u8BB8\u7531\u5FAE\u4FE1\u540E\u53F0\u4E0B\u53D1\uFF0C\u8FD9\u4E2A appid \u6CA1\u6709\u5F00\uFF0C\u300C\u8BBE\u7F6E \u2192 \u5B89\u5168\u8BBE\u7F6E\u300D\u91CC\u4E5F\u5C31\u4E0D\u663E\u793A\u300C\u5141\u8BB8\u83B7\u53D6\u5DE5\u5177\u767B\u5F55\u7968\u636E\u300D\uFF0C\u672C\u673A\u6539\u4E0D\u4E86\u3002wx.login \u4F1A\u81EA\u52A8\u6539\u7531\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u6A21\u62DF\u5668\u83B7\u53D6\uFF1B\u624B\u673A\u53F7\u548C\u670D\u52A1\u5E02\u573A\u8BF7\u53BB\u6389 --devtools-login\uFF0C\u7528 setup \u7684 mock \u9020\u6570\u636E\uFF0C\u6216\u53E6\u53D6\u4E00\u5F20\u7968\u636E\u7528\u73AF\u5883\u53D8\u91CF ${TICKET_ENV} \u4F20\u8FDB\u6765`
    );
  }
  if (message.includes("need to login")) return new Error("\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u672A\u767B\u5F55\uFF0C\u8BF7\u5148\u5728\u5F00\u53D1\u8005\u5DE5\u5177\u91CC\u767B\u5F55");
  return new Error(`\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u8FD4\u56DE\u9519\u8BEF\uFF1A${message}`);
}

// src/server/plugins.ts
import { readWxvpkgFile, readWxvpkgIndex } from "@open-wxa/wxa-runner-extractor";

// src/server/wechatDev.ts
import { TICKET_ENV as TICKET_ENV2 } from "@open-wxa/wxa-runner-extractor";
var BASE_URL = "https://servicewechat.com";
var CLIENT_VERSION = "1021810240";
var DEFAULT_TIMEOUT = 1e4;
var ERROR_HINTS = {
  // 40001：开发者工具刷新过 ticket，旧的随即作废
  40001: "\uFF08\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5728\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u91CC\u91CD\u65B0\u767B\u5F55\uFF09",
  40029: "\uFF08\u767B\u5F55\u6001\u5DF2\u5931\u6548\uFF0C\u8BF7\u5728\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u91CC\u91CD\u65B0\u767B\u5F55\uFF09",
  85023: "\uFF08\u5F53\u524D\u5FAE\u4FE1\u8D26\u53F7\u4E0D\u662F\u8BE5\u5C0F\u7A0B\u5E8F\u7684\u5F00\u53D1\u8005\uFF09"
};
function requireUsableTicket(ticket) {
  if (!ticket) throw new Error(`\u672A\u627E\u5230\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u767B\u5F55\u6001\uFF0C\u8BF7\u767B\u5F55\u5F00\u53D1\u8005\u5DE5\u5177\uFF0C\u6216\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF ${TICKET_ENV2}`);
  if (ticket.expiredAt !== void 0 && ticket.expiredAt <= Date.now()) {
    throw new Error("\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u767B\u5F55\u6001\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u6253\u5F00\u5F00\u53D1\u8005\u5DE5\u5177\u5237\u65B0\u767B\u5F55\u6001");
  }
  return ticket.newticket;
}
function explainErrcode(errcode) {
  return errcode !== void 0 && ERROR_HINTS[errcode] || "";
}
function requireOk(body, action) {
  const errcode = body.baseresponse?.errcode;
  if (errcode !== 0) throw new Error(`${action} ${errcode}: ${body.baseresponse?.errmsg || "\u672A\u77E5\u9519\u8BEF"}${explainErrcode(errcode)}`);
  return body;
}
var WechatDevClient = class {
  /**
   * @param findTicket 每次请求都重新取：开发者工具重新登录、切换账号后不用重启服务器
   */
  constructor(appid, findTicket) {
    this.appid = appid;
    this.findTicket = findTicket;
  }
  /**
   * POST JSON 到 path（如 wxa-dev-logic/jslogin），带上 appid 和开发者 ticket
   *
   * @throws 没有可用的登录态、超时、连不上、HTTP 状态不是 2xx 时，消息是给用户看的原因
   */
  async post(path8, body, timeout = DEFAULT_TIMEOUT) {
    const query = new URLSearchParams({ appid: this.appid, newticket: requireUsableTicket(await this.findTicket()), clientversion: CLIENT_VERSION });
    const response = await fetch(`${BASE_URL}/${path8}?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    }).catch((error) => {
      throw new Error(error.name === "TimeoutError" ? `\u8BF7\u6C42\u5FAE\u4FE1\u670D\u52A1\u5668\u8D85\u65F6\uFF08${timeout / 1e3}s\uFF09` : `\u8BF7\u6C42\u5FAE\u4FE1\u670D\u52A1\u5668\u5931\u8D25\uFF1A${error.cause?.message ?? error.message}`);
    });
    if (!response.ok) throw new Error(`\u5FAE\u4FE1\u670D\u52A1\u5668\u8FD4\u56DE HTTP ${response.status}`);
    return response;
  }
  /** 同 post，返回解析后的 JSON */
  async postJson(path8, body) {
    return (await this.post(path8, body)).json();
  }
};

// src/server/plugins.ts
var DOWNLOAD_TIMEOUT = 3e4;
var PACKAGE_MAGIC = 190;
var PluginStore = class {
  /**
   * @param wechat 开启 --devtools-login 时才有，没有时不下载插件
   */
  constructor(wechat, logger) {
    this.wechat = wechat;
    this.logger = logger;
    /** provider@version → 下载结果；失败的不留，下次打开小程序时重试 */
    this.downloads = /* @__PURE__ */ new Map();
    /**
     * 这次打开小程序时决定用哪些插件。同一次打开的逻辑层、业务模块、渲染层等请求都按它处理：
     * 各自去下载的话，下载失败时每个请求都会重试，结果还可能前后不一，页面列表和逻辑层对不上
     */
    this.selection = null;
    /** 没开 --devtools-login 的提示每个插件只说一次 */
    this.warned = /* @__PURE__ */ new Set();
  }
  /** 打开小程序时（宿主取 app-info）调用：重新决定用哪些插件，下载过的直接用，上次失败的重试 */
  async refresh(build2) {
    this.selection = this.select(build2);
    return withPlugins(build2, await this.selection);
  }
  /** 其余请求沿用这次打开时的决定，不触发下载；还没决定过时（如直接请求逻辑层）先决定一次 */
  async current(build2) {
    this.selection ??= this.select(build2);
    return withPlugins(build2, await this.selection);
  }
  /** app.json 声明的插件；下载不了的跳过，在终端说明原因，小程序自己的页面照常可用 */
  async select(build2) {
    const declared = build2.wxConfig.plugins || {};
    const results = await Promise.all(Object.entries(declared).map(
      ([alias, { provider, version }]) => provider && version ? this.load(alias, provider, version) : null
    ));
    return results.filter((plugin) => !!plugin);
  }
  async load(alias, provider, version) {
    const label = `\u63D2\u4EF6 ${alias}\uFF08${provider}@${version}\uFF09`;
    if (!this.wechat) {
      this.warnOnce(label, `[wxa-runner] ${label} \u7684\u4EE3\u7801\u8981\u7528\u5F00\u53D1\u8005\u7684\u767B\u5F55\u6001\u5411\u5FAE\u4FE1\u4E0B\u8F7D\uFF0C\u542F\u52A8\u65F6\u52A0 --devtools-login`);
      return null;
    }
    const key = `${provider}@${version}`;
    let download = this.downloads.get(key);
    if (!download) {
      download = this.download(this.wechat, alias, provider, version);
      this.downloads.set(key, download);
      download.catch(() => this.downloads.delete(key));
    }
    try {
      return await download;
    } catch (error) {
      this.logger.warn(`[wxa-runner] ${label} \u4E0B\u8F7D\u5931\u8D25\uFF1A${error.message}`);
      return null;
    }
  }
  /** @throws 没有登录态、连不上、微信拒绝或返回的不是插件代码包时，消息是原因 */
  async download(wechat, alias, provider, version) {
    const response = await wechat.post("wxa-dev/getplugincode", { plugin_id: provider, plugin_version: version }, DOWNLOAD_TIMEOUT);
    const data = Buffer.from(await response.arrayBuffer());
    if (data[0] !== PACKAGE_MAGIC) {
      let body = {};
      try {
        body = JSON.parse(data.toString("utf8"));
      } catch {
      }
      if (body.baseresponse?.errcode) requireOk(body, "\u5FAE\u4FE1\u62D2\u7EDD\u4E0B\u8F7D");
      throw new Error("\u5FAE\u4FE1\u6CA1\u6709\u8FD4\u56DE\u63D2\u4EF6\u4EE3\u7801");
    }
    const files = new Map(readWxvpkgIndex(data).map((entry) => [entry.name, Buffer.from(readWxvpkgFile(data, entry))]));
    const pluginJson = JSON.parse(files.get("/plugin.json")?.toString("utf8") || "{}");
    return {
      alias,
      provider,
      version,
      files,
      pages: Object.values(pluginJson.pages || {}),
      pageConfigs: pluginJson.page || {}
    };
  }
  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
};

// src/server/devtoolsLogin.ts
import express from "express";
import { findDeveloperTicket as findDeveloperTicket2 } from "@open-wxa/wxa-runner-extractor";
var LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
var LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
var FORWARDED_WX_DATA_APIS = ["webapi_servicemarket_jsapi_comm"];
function devtoolsLoginRouter(appid, findTicket = findDeveloperTicket2, loginCode, options = {}) {
  const wechat = new WechatDevClient(appid, findTicket);
  const router = express.Router();
  router.use(onlyLoopback);
  router.post("/login", respond(async () => {
    if (loginCode && options.simulatorLogin) {
      return { code: await loginCode() };
    }
    try {
      const body = requireOk(await wechat.postJson("wxa-dev-logic/jslogin", { scope: ["snsapi_base"] }), "\u5FAE\u4FE1\u767B\u5F55\u5931\u8D25");
      if (!body.code) throw new Error("\u5FAE\u4FE1\u767B\u5F55\u5931\u8D25\uFF1A\u5FAE\u4FE1\u6CA1\u6709\u8FD4\u56DE code");
      return { code: body.code };
    } catch (error) {
      if (!loginCode || !(error instanceof TicketNotAllowed)) throw error;
      return { code: await loginCode() };
    }
  }));
  router.post("/phone-number", respond(async () => {
    const body = await wechat.postJson("wxa-dev-logic/jsgetuserwxphone", { appid });
    const errcode = body.jsapi_baseresponse?.errcode ?? body.BaseResponse?.Ret;
    if (errcode !== 0 || typeof body.data !== "string") {
      const errmsg = body.jsapi_baseresponse?.errmsg || body.BaseResponse?.ErrMsg?.String || "\u672A\u77E5\u9519\u8BEF";
      throw new Error(`\u83B7\u53D6\u624B\u673A\u53F7\u5931\u8D25 ${errcode}: ${errmsg}${explainErrcode(errcode)}`);
    }
    const { encryptedData, iv } = JSON.parse(body.data);
    return { data: body.data, encryptedData, iv };
  }));
  router.post("/operate-wx-data", express.json({ limit: "10mb" }), (req, res, next) => {
    const apiName = req.body?.data?.api_name;
    if (FORWARDED_WX_DATA_APIS.includes(apiName)) return next();
    res.status(403).json({ error: `operateWXData \u53EA\u8F6C\u53D1\u670D\u52A1\u5E02\u573A\u7684\u8BF7\u6C42\uFF0C\u4E0D\u8F6C\u53D1 ${apiName}` });
  }, respond(async (req) => {
    const body = requireOk(await wechat.postJson("wxa-dev-logic/jsoperatewxdata", { data: JSON.stringify(req.body.data) }), "\u670D\u52A1\u5E02\u573A\u8C03\u7528\u5931\u8D25");
    if (typeof body.data !== "string") throw new Error("\u670D\u52A1\u5E02\u573A\u8C03\u7528\u5931\u8D25\uFF1A\u5FAE\u4FE1\u6CA1\u6709\u8FD4\u56DE\u7ED3\u679C");
    return { data: JSON.parse(body.data) };
  }));
  router.post("/verify-plugin", express.json(), respond(async (req) => {
    const body = requireOk(await wechat.postJson("wxa-dev-logic/verifyplugin", { ext_info: JSON.stringify(req.body?.data || {}) }), "\u63D2\u4EF6\u6821\u9A8C\u5931\u8D25");
    return { data: { list: body.list || [] } };
  }));
  router.post("/batch-get-contact", express.json(), respond(async (req) => {
    const body = requireOk(await wechat.postJson("wxa-dev-logic/batchgetcontact", { appid_list: req.body?.appIds || [] }), "\u83B7\u53D6\u63D2\u4EF6\u4FE1\u606F\u5931\u8D25");
    const contacts = body.contact_list || [];
    return { contactList: contacts.filter((contact) => contact.plugin_info).map((contact) => ({ appId: contact.appid, plugin_list: contact.plugin_info.plugin_list })) };
  }));
  return router;
}
function onlyLoopback(req, res, next) {
  if (!LOOPBACK_ADDRESSES.includes(req.socket.remoteAddress || "") || !LOOPBACK_HOSTS.includes(req.hostname)) {
    res.status(403).json({ error: "\u5F00\u53D1\u8005\u767B\u5F55\u6001\u63A5\u53E3\u53EA\u5141\u8BB8\u672C\u673A\u8BBF\u95EE" });
    return;
  }
  next();
}
function respond(action) {
  return async (req, res) => {
    try {
      res.json(await action(req));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
}

// src/server/setup.ts
import fs4 from "fs";
import path4 from "path";
import { build } from "esbuild";

// src/runtime/setupModule.ts
var SETUP_MODULE = "@open-wxa/wxa-runner-core/setup";
var SETUP_MODULE_SOURCE = "export function defineSetup(setup) { return setup; }";

// src/server/setup.ts
var SETUP_FILE_NAMES = ["wxa.setup.ts", "wxa.setup.js", "wxa.setup.mjs"];
var ENV_PREFIX = "WXA_";
function findSetupFile(projectPath) {
  for (const name of SETUP_FILE_NAMES) {
    const file = path4.join(projectPath, name);
    if (fs4.existsSync(file)) return file;
  }
  return null;
}
function collectSetupEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry) => entry[0].startsWith(ENV_PREFIX) && entry[1] !== void 0)
  );
}
async function bundleSetup(file) {
  const result = await build({
    entryPoints: [file],
    absWorkingDir: path4.dirname(file),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    write: false,
    logLevel: "silent",
    sourcemap: "inline",
    plugins: [builtinSetupModule()]
  });
  return result.outputFiles[0].text;
}
function builtinSetupModule() {
  return {
    name: "wxa-setup-module",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: new RegExp(`^${SETUP_MODULE}$`) }, () => ({ path: SETUP_MODULE, namespace: "wxa-setup" }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "wxa-setup" }, () => ({
        contents: SETUP_MODULE_SOURCE,
        loader: "js"
      }));
    }
  };
}

// src/server/watcher.ts
import { createHash } from "crypto";
import fs5 from "fs";
import path5 from "path";
import chokidar from "chokidar";
var DEBOUNCE = 120;
var IGNORED = /(^|[/\\])(node_modules|\.git)([/\\]|$)/;
var FINGERPRINTED = /\.(js|mjs|ts|json|wxml|wxss|wxs|less|scss|sass|css)$/;
function watchProject(root, paths, onChange) {
  let changed = /* @__PURE__ */ new Set();
  let structural = false;
  let timer = null;
  const fingerprints = /* @__PURE__ */ new Map();
  let scanned = false;
  const watcher = chokidar.watch(paths, { ignored: IGNORED });
  const ready = new Promise((resolve) => {
    watcher.on("ready", () => {
      scanned = true;
      resolve();
    });
  });
  const flush = () => {
    const changes = { files: [...changed], structural };
    changed = /* @__PURE__ */ new Set();
    structural = false;
    onChange(changes);
  };
  watcher.on("all", (event, file) => {
    const unchanged = updateFingerprint(fingerprints, file, event);
    if (!scanned || unchanged) return;
    if (event !== "change") structural = true;
    changed.add(path5.relative(root, file).split(path5.sep).join("/"));
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE);
  });
  return { ready, close: () => watcher.close() };
}
function updateFingerprint(fingerprints, file, event) {
  if (event === "unlink") {
    fingerprints.delete(file);
    return false;
  }
  if (event !== "add" && event !== "change" || !FINGERPRINTED.test(file)) return false;
  let next;
  try {
    next = createHash("sha1").update(fs5.readFileSync(file)).digest("hex");
  } catch {
    return false;
  }
  const previous = fingerprints.get(file);
  fingerprints.set(file, next);
  return previous === next;
}

// src/server/extensions.ts
function applyExtensions(base, extensions, context) {
  const webviewScripts = [...base.webviewScripts ?? []];
  const middlewares = [...base.middlewares ?? []];
  const transforms = base.wxmlTransform ? [base.wxmlTransform] : [];
  const entries = [];
  for (const extension of extensions) {
    let setup;
    try {
      setup = extension.setup(context);
    } catch (error) {
      throw new Error(`\u6269\u5C55 ${extension.name} \u521D\u59CB\u5316\u5931\u8D25\uFF1A${error.message}`);
    }
    webviewScripts.push(...setup.webviewScripts ?? []);
    middlewares.push(...setup.middlewares ?? []);
    if (setup.wxmlTransform) transforms.push(setup.wxmlTransform);
    if (setup.entry) entries.push({ name: extension.name, ...setup.entry });
  }
  const wxmlTransform = transforms.length === 0 ? void 0 : (code, file) => transforms.reduce((result, transform2) => transform2(result, file), code);
  return { webviewScripts, middlewares, wxmlTransform, entries };
}

// src/server/DevServer.ts
var RESERVED_PREFIXES = ["/__wxa__", "/__baselib__", "/__plugin__"];
var APP_ROUTES = /^\/(?:__wxa__\/(?:appservice\.html|subcontext\.html|worker\.js|service-|page-|webview\/.+\.html$|plugin\/|module\/)|__plugin__\/)/;
var DevServer = class {
  constructor(options) {
    this.options = options;
    this.server = null;
    this.socketProxy = null;
    this.sockets = null;
    this.watcher = null;
    /** 上次编译失败时页面上显示着错误，修好后整页刷新才能清掉 */
    this.lastBuildFailed = false;
    this.address = "";
    this.lanAccess = false;
    /** 运行时生成的临时文件（canvas 导出、拍照等），随服务器进程存在 */
    this.fileSessions = /* @__PURE__ */ new Map();
    this.logger = options.logger || console;
    this.project = new MiniProgram(path6.resolve(options.projectPath));
    for (const { plugin, files } of ignoredStyleSources(this.project, this.project.styleSetting)) {
      this.logger.warn(
        `[wxa-runner] ${files.length} \u4E2A ${plugin} \u6837\u5F0F\u6587\u4EF6\u4E0D\u4F1A\u751F\u6548\uFF08\u5982 ${files[0]}\uFF09\uFF1Aproject.config.json \u7684 setting.useCompilerPlugins \u6CA1\u6709\u5F00\u542F ${plugin}\uFF0C\u5F00\u53D1\u8005\u5DE5\u5177\u540C\u6837\u4E0D\u7F16\u8BD1\u5B83\u4EEC`
      );
    }
    const extended = applyExtensions(options, options.extensions ?? [], { projectPath: this.project.projectPath, root: this.project.root });
    extended.middlewares.forEach(({ path: mountPath }) => assertMountPath(mountPath));
    this.webviewScripts = extended.webviewScripts;
    this.middlewares = extended.middlewares;
    this.extensionEntries = extended.entries;
    this.baseLib = resolveBaseLib({ version: options.baseLibVersion, cacheDir: options.baseLibCacheDir });
    if (!this.baseLib.compatible) {
      this.logger.warn(`[wxa-runner] \u57FA\u7840\u5E93 ${this.baseLib.version} \u9AD8\u4E8E\u5DF2\u9A8C\u8BC1\u7684\u7248\u672C\u8303\u56F4\uFF0C\u53EF\u80FD\u65E0\u6CD5\u6B63\u5E38\u8FD0\u884C`);
    }
    this.devtoolsLogin = options.devtoolsLogin === true;
    if (this.project.activeExtJson()) {
      const projectAppid = this.project.appid;
      this.logger.log(
        `[wxa-runner] \u4E09\u65B9\u5E73\u53F0\u4EE3\u5F00\u53D1\u6A21\u5F0F\uFF08ext.json\uFF09\uFF1A\u8FD0\u884C\u65F6 appid ${this.project.runtimeAppid}` + (this.project.runtimeAppid === projectAppid ? "" : `\uFF0C\u9879\u76EE appid ${projectAppid}`)
      );
    }
    this.devtools = this.devtoolsLogin ? devtoolsSession(this.project.projectPath, this.logger, { simulatorLogin: this.project.activeExtJson() !== null }) : null;
    this.ticketSource = this.devtools?.findTicket ?? null;
    this.plugins = new PluginStore(this.ticketSource && new WechatDevClient(this.project.runtimeAppid, this.ticketSource), this.logger);
    this.device = { ...DEFAULT_DEVICE, ...options.device };
    this.builder = new AppBuilder(this.project, { wxmlTransform: extended.wxmlTransform });
    this.setupFile = resolveSetupFile(options.setup, this.project.projectPath);
    this.setupEnv = collectSetupEnv(process.env);
    this.app = this.createApp();
  }
  /** 本机访问的地址 */
  get url() {
    return this.address;
  }
  /** 局域网里其他设备访问的地址，每块网卡一个；只监听本机时为空 */
  get networkUrls() {
    if (!this.lanAccess) return [];
    const { port } = new URL(this.address);
    return Object.values(os3.networkInterfaces()).flat().filter((net2) => net2 && net2.family === "IPv4" && !net2.internal).map((net2) => `http://${net2.address}:${port}`);
  }
  async start() {
    if (this.options.watch !== false) await this.startWatching();
    try {
      const build2 = await this.builder.build();
      this.logger.log(`[wxa-runner] \u7F16\u8BD1\u5B8C\u6210\uFF1A${build2.pages.length} \u4E2A\u9875\u9762\uFF0C${build2.components.length} \u4E2A\u7EC4\u4EF6\uFF0C${build2.durationMs}ms`);
    } catch (error) {
      this.lastBuildFailed = true;
      this.logger.error(`[wxa-runner] \u7F16\u8BD1\u5931\u8D25\uFF1A
${error.message}`);
    }
    const server = http.createServer(this.app);
    this.sockets = new WebSocketServer2({ noServer: true, maxPayload: 64 * 1024 });
    this.sockets.on("connection", (socket) => {
      socket.on("error", () => void 0);
      if (this.options.forwardConsole) printBrowserReports(socket, this.logger);
    });
    this.socketProxy = createSocketProxy();
    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/__wxa__/socket") {
        this.socketProxy.handleUpgrade(req, socket, head, (ws) => this.socketProxy.emit("connection", ws, req));
        return;
      }
      if (req.url?.startsWith("/__wxa__/ws")) {
        this.sockets.handleUpgrade(req, socket, head, (ws) => this.sockets.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });
    const host = this.options.host || "localhost";
    let port;
    try {
      port = await listen(server, this.options.port, host, this.logger);
    } catch (error) {
      await this.watcher?.close();
      this.watcher = null;
      throw error;
    }
    this.server = server;
    this.lanAccess = LOCAL_HOST_OF_ANY_ADDRESS.has(host);
    this.address = `http://${LOCAL_HOST_OF_ANY_ADDRESS.get(host) ?? host}:${port}`;
    this.ticketSource?.().then(requireUsableTicket).catch((error) => {
      if (error instanceof TicketNotAllowed && this.devtools?.loginCode) return;
      this.logger.warn(`[wxa-runner] \u5F00\u53D1\u8005\u5DE5\u5177\u7684\u767B\u5F55\u6001\u6682\u4E0D\u53EF\u7528\uFF08--devtools-login\uFF09\uFF1A${error.message}`);
    });
    return this.address;
  }
  async close() {
    await this.watcher?.close();
    this.sockets?.clients.forEach((client) => client.terminate());
    this.sockets?.close();
    this.socketProxy?.clients.forEach((client) => client.terminate());
    this.socketProxy?.close();
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    this.fileSessions.clear();
    this.builder.dispose();
  }
  createApp() {
    const app = express2();
    const root = this.project.root;
    const noStore = (res) => res.setHeader("Cache-Control", "no-store");
    for (const { path: mountPath, handler } of this.middlewares) {
      app.use(mountPath, (req, res, next) => handler(req, res, next));
    }
    app.get("/", (_req, res) => {
      noStore(res);
      res.type("html").send(hostHtml());
    });
    app.get("/favicon.ico", (_req, res) => {
      res.status(204).end();
    });
    app.get("/__wxa__/app-info.json", async (_req, res) => {
      noStore(res);
      const common = {
        baseLibVersion: this.baseLib.version,
        device: this.device,
        pageTransition: this.options.pageTransition ?? false,
        devtoolsLogin: this.devtoolsLogin,
        socketProxy: true,
        forwardConsole: this.options.forwardConsole ?? false,
        webViewWindow: this.options.webViewWindow ?? false
      };
      try {
        const build2 = await this.plugins.refresh(await this.builder.build());
        const info = {
          ...common,
          appid: this.project.runtimeAppid,
          version: build2.version,
          wxConfig: build2.wxConfig,
          pages: build2.pages
        };
        if (this.setupFile) info.setup = await this.setupInfo(this.setupFile);
        res.json(info);
      } catch (error) {
        res.json({ ...common, appid: this.project.appid, version: 0, wxConfig: {}, pages: [], buildError: error.message });
      }
    });
    app.get("/__wxa__/setup.js", async (_req, res) => {
      noStore(res);
      if (!this.setupFile) {
        res.status(404).type("text").send("\u6CA1\u6709 setup \u6587\u4EF6");
        return;
      }
      try {
        res.type("js").send(await bundleSetup(this.setupFile));
      } catch (error) {
        res.status(500).type("text").send(error.message);
      }
    });
    app.get(APP_ROUTES, this.withBuild((build2, req, res, next) => {
      const response = routeApp(this.appSource(build2), new URL(req.originalUrl, "http://localhost"));
      if (!response) return next();
      res.status(response.status).type(response.type);
      res.send(typeof response.body === "string" ? response.body : Buffer.from(response.body.buffer, response.body.byteOffset, response.body.byteLength));
    }));
    app.get("/__wxa__/runtime/frame.js.map", (_req, res, next) => {
      const file = path6.join(this.runtimeDir(), "frame.js.map");
      if (!fs6.existsSync(file)) return next();
      res.type("json").send(ignoreConsoleHook(fs6.readFileSync(file, "utf8")));
    });
    app.use("/__wxa__/runtime", express2.static(this.runtimeDir(), {
      cacheControl: false,
      // Service Worker 默认只能接管自己所在目录下的页面，宿主页面在根路径
      setHeaders: (res, file) => {
        if (path6.basename(file) === "sw.js") res.setHeader("Service-Worker-Allowed", "/");
      }
    }));
    const sourceMaps = /* @__PURE__ */ new Map();
    app.get(/^\/__baselib__\/(.+\.js)\.map$/, (req, res, next) => {
      const file = path6.resolve(this.baseLib.dir, req.params[0]);
      if (!file.startsWith(this.baseLib.dir + path6.sep) || !fs6.existsSync(file)) return next();
      if (!sourceMaps.has(file)) sourceMaps.set(file, ignoreListSourceMap(fs6.readFileSync(file, "utf8"), `${path6.basename(file)}?original`));
      res.type("json").send(sourceMaps.get(file));
    });
    app.use("/__baselib__", express2.static(this.baseLib.dir, {
      maxAge: "1d",
      setHeaders: (res, file) => {
        if (file.endsWith(".js")) res.setHeader("SourceMap", `${path6.basename(file)}.map`);
      }
    }));
    app.use(PROXY_PREFIX, express2.raw({ type: () => true, limit: "100mb" }), handleProxy);
    app.use(MOCK_PREFIX, (_req, res) => {
      res.status(503).type("text").send("\u8FD9\u4E2A\u8BF7\u6C42\u5DF2\u88AB\u62E6\u622A\u89C4\u5219\u62E6\u4E0B\uFF0C\u8FD9\u91CC\u53EA\u7528\u4E8E\u5728 Network \u9762\u677F\u91CC\u663E\u793A\u5B83\u3002Service Worker \u6CA1\u6709\u751F\u6548\uFF08\u5982 DevTools \u52FE\u9009\u4E86 Bypass for network\uFF09\uFF0C\u770B\u4E0D\u5230\u62E6\u622A\u89C4\u5219\u7ED9\u51FA\u7684\u54CD\u5E94");
    });
    const sessionFiles = (session) => {
      if (!/^[a-z0-9-]{1,80}$/i.test(session)) return null;
      let files = this.fileSessions.get(session);
      if (!files) {
        files = new FileStore([`/__wxa__/usr/${session}`, `/__wxa__/tmp/${session}`]);
        this.fileSessions.set(session, files);
      }
      return files;
    };
    app.post("/__wxa__/fs/:session", express2.json({ limit: "150mb" }), (req, res) => {
      const files = sessionFiles(req.params.session);
      if (!files) {
        res.status(400).json({ error: `invalid filesystem session ${req.params.session}` });
        return;
      }
      try {
        res.json({ result: files.execute(req.body.operation, req.body.args || {}) });
      } catch (error) {
        res.json({ error: error.message });
      }
    });
    app.post("/__wxa__/tmp/:session", express2.raw({ type: () => true, limit: "100mb" }), (req, res) => {
      const type = String(req.query.type || "png");
      if (!/^[a-z0-9]+$/i.test(type)) {
        res.status(400).type("text").send(`\u975E\u6CD5\u7684\u6587\u4EF6\u7C7B\u578B ${type}`);
        return;
      }
      const files = sessionFiles(req.params.session);
      if (!files) {
        res.status(400).type("text").send(`\u975E\u6CD5\u7684\u4F1A\u8BDD\u6807\u8BC6 ${req.params.session}`);
        return;
      }
      const filePath = `/__wxa__/tmp/${req.params.session}/${randomUUID2()}.${type}`;
      files.write(filePath, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      res.json({ url: `${req.protocol}://${req.get("host")}${filePath}` });
    });
    app.get("/__wxa__/region/:kind", (req, res) => {
      const kind = req.params.kind;
      const data = kind === "districts" || kind === "streets" ? readRegionData(kind) : null;
      if (!data) {
        res.status(404).end();
        return;
      }
      res.type("text/plain; charset=utf-8").set("Cache-Control", "public, max-age=86400").send(data);
    });
    app.get("/__wxa__/:kind(usr|tmp)/:session/*", (req, res) => {
      const files = this.fileSessions.get(req.params.session);
      const node = files?.stat(`/__wxa__/${req.params.kind}/${req.params.session}/` + req.params[0]);
      if (!node || node.dir) {
        res.status(404).end();
        return;
      }
      const data = Buffer.from(node.data.buffer, node.data.byteOffset, node.data.byteLength);
      res.type(path6.extname(req.params[0]));
      res.setHeader("ETag", `"${node.etag}"`);
      res.setHeader("Accept-Ranges", "bytes");
      const ranges = req.range(data.length);
      if (ranges === -1) {
        res.status(416).setHeader("Content-Range", `bytes */${data.length}`);
        res.end();
        return;
      }
      if (Array.isArray(ranges) && ranges.type === "bytes" && ranges.length === 1) {
        const { start, end } = ranges[0];
        res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${data.length}`);
        res.send(data.subarray(start, end + 1));
        return;
      }
      res.send(data);
    });
    app.delete("/__wxa__/tmp/:session/*", (req, res) => {
      try {
        const files = this.fileSessions.get(req.params.session);
        if (!files) throw new Error("file not exist");
        files.remove(`/__wxa__/tmp/${req.params.session}/` + req.params[0], { dir: false });
        res.status(204).end();
      } catch {
        res.status(404).end();
      }
    });
    if (this.devtools) {
      app.use(
        "/__wxa__/api",
        devtoolsLoginRouter(this.project.appid, this.devtools.findTicket, this.devtools.loginCode, {
          simulatorLogin: this.project.activeExtJson() !== null
        })
      );
    }
    app.use("/__wxa__/webview", express2.static(root));
    app.use(express2.static(root));
    app.use((error, _req, res, _next) => {
      this.logger.error("[wxa-runner]", error);
      res.status(500).type("text").send(error.message);
    });
    return app;
  }
  /** 先编译一遍 setup：编译错误随 app-info 交给宿主显示，而不是让浏览器 import 失败 */
  async setupInfo(file) {
    try {
      await bundleSetup(file);
      return { env: this.setupEnv };
    } catch (error) {
      return { env: this.setupEnv, error: error.message };
    }
  }
  /** 构建结果并入这次打开小程序时决定用的插件 */
  async currentBuild() {
    return this.plugins.current(await this.builder.build());
  }
  /** 需要构建结果的路由；构建失败时返回错误文本 */
  appSource(build2) {
    return {
      build: build2,
      moduleScript: (id) => this.builder.getModuleScript(id),
      baseLib: { version: this.baseLib.version, hasWorker: fs6.existsSync(path6.join(this.baseLib.dir, "WAWorker.js")) },
      isolated: usesIsolatedContext(this.baseLib.version),
      hot: this.hotEnabled,
      webviewScripts: this.webviewScripts
    };
  }
  withBuild(handler) {
    return async (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      let build2;
      try {
        build2 = await this.currentBuild();
      } catch (error) {
        res.status(500).type("text").send(error.message);
        return;
      }
      try {
        handler(build2, req, res, next);
      } catch (error) {
        next(error);
      }
    };
  }
  runtimeDir() {
    return findRuntimeDir(this.options.runtimeDir);
  }
  /** 只在监听文件变化时打开基础库的热更新开关，跑测试（watch: false）时运行环境与真机一致 */
  get hotEnabled() {
    return this.options.watch !== false;
  }
  /** 返回初次扫描完成的时刻，此前已存在的文件不会作为改动报告 */
  startWatching() {
    const watched = [this.project.root];
    const outsideRoot = (file) => path6.relative(this.project.root, file).startsWith("..");
    if (this.setupFile && outsideRoot(this.setupFile)) watched.push(this.setupFile);
    const projectConfig = path6.join(this.project.projectPath, "project.config.json");
    if (outsideRoot(projectConfig) && fs6.existsSync(projectConfig)) watched.push(projectConfig);
    this.watcher = watchProject(this.project.root, watched, async ({ files, structural }) => {
      const reloadOnly = structural || this.lastBuildFailed;
      this.builder.invalidate(files);
      const label = files.length > 3 ? `${files.slice(0, 3).join(", ")} \u7B49 ${files.length} \u4E2A\u6587\u4EF6` : files.join(", ");
      try {
        const build2 = await this.builder.build();
        this.lastBuildFailed = false;
        const plan = reloadOnly ? null : planHotUpdate(files, build2);
        this.logger.log(`[wxa-runner] ${label} \u5DF2\u66F4\u65B0\uFF0C\u91CD\u65B0\u7F16\u8BD1 ${build2.durationMs}ms${plan ? "\uFF0C\u70ED\u66F4\u65B0" : ""}`);
        this.broadcast(plan ? { type: "hot", version: build2.version, ...plan } : { type: "reload" });
      } catch (error) {
        this.lastBuildFailed = true;
        const message = error.message;
        this.logger.error(`[wxa-runner] \u7F16\u8BD1\u5931\u8D25\uFF1A
${message}`);
        this.broadcast({ type: "error", message });
      }
    });
    return this.watcher.ready;
  }
  broadcast(message) {
    const data = JSON.stringify(message);
    this.sockets?.clients.forEach((client) => {
      if (client.readyState === WebSocket3.OPEN) client.send(data);
    });
  }
};
var DEFAULT_PORT = 3e3;
var LOCAL_HOST_OF_ANY_ADDRESS = /* @__PURE__ */ new Map([["0.0.0.0", "127.0.0.1"], ["::", "localhost"]]);
async function listen(server, port, host, logger) {
  for (let candidate = port ?? DEFAULT_PORT; ; candidate++) {
    const taken = await takenOnLocalAddresses(candidate) || !await bind(server, candidate, host);
    if (!taken) {
      const actual = server.address().port;
      if (port === void 0 && actual !== DEFAULT_PORT) logger.warn(`[wxa-runner] \u7AEF\u53E3 ${DEFAULT_PORT} \u5DF2\u88AB\u5360\u7528\uFF0C\u6539\u7528 ${actual}`);
      return actual;
    }
    if (port !== void 0) throw new Error(`\u7AEF\u53E3 ${port} \u5DF2\u88AB\u5360\u7528\uFF1A\u5148\u5173\u95ED\u5360\u7528\u5B83\u7684\u8FDB\u7A0B\uFF0C\u6216\u7528 --port \u6362\u4E00\u4E2A\u7AEF\u53E3`);
  }
}
function bind(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => error.code === "EADDRINUSE" ? resolve(false) : reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(true);
    });
  });
}
async function takenOnLocalAddresses(port) {
  for (const address of ["127.0.0.1", "::1", "0.0.0.0", "::"]) {
    const probe = net.createServer();
    const free = await bind(probe, port, address).catch(() => true);
    if (!free) return true;
    await new Promise((resolve) => probe.close(resolve));
  }
  return false;
}
function assertMountPath(mountPath) {
  const literal = typeof mountPath === "string" && /^(\/[\w.~-]+)+$/.test(mountPath);
  const lower = literal ? mountPath.toLowerCase() : "";
  const reserved = RESERVED_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix + "/"));
  if (!literal || reserved) {
    throw new Error(
      `\u4E2D\u95F4\u4EF6\u8DEF\u5F84 ${String(mountPath)} \u4E0D\u53EF\u7528\uFF1A\u8981\u4EE5 / \u5F00\u5934\uFF0C\u53EA\u542B\u5B57\u6BCD\u3001\u6570\u5B57\u548C _ . ~ -\uFF08\u4E0D\u652F\u6301\u901A\u914D\u7B26\u548C\u53C2\u6570\uFF09\uFF0C\u4E0D\u80FD\u662F /\uFF0C\u4E5F\u4E0D\u80FD\u7528 wxa-runner \u4FDD\u7559\u7684\u524D\u7F00 ${RESERVED_PREFIXES.join("\u3001")}\uFF08\u4E0D\u533A\u5206\u5927\u5C0F\u5199\uFF09`
    );
  }
}
function resolveSetupFile(option, projectPath) {
  if (option === false) return null;
  if (!option) return findSetupFile(projectPath);
  const file = path6.resolve(option);
  if (!fs6.existsSync(file)) throw new Error(`\u627E\u4E0D\u5230 setup \u6587\u4EF6\uFF1A${file}`);
  return file;
}
function findRuntimeDir(explicit) {
  const candidates = [
    explicit,
    path6.join(__dirname, "runtime"),
    path6.join(__dirname, "../runtime"),
    path6.join(__dirname, "../../dist/runtime")
  ].filter((dir) => !!dir);
  const found = candidates.find((dir) => fs6.existsSync(path6.join(dir, "host.js")));
  if (!found) {
    throw new Error("\u627E\u4E0D\u5230\u6D4F\u89C8\u5668\u7AEF\u8FD0\u884C\u65F6\uFF08host.js\uFF09\uFF0C\u8BF7\u5148\u6267\u884C pnpm build");
  }
  return found;
}

// src/server/config.ts
import { randomUUID as randomUUID3 } from "crypto";
import fs7 from "fs";
import path7 from "path";
import { pathToFileURL as pathToFileURL2 } from "url";
import { transform } from "esbuild";
var CONFIG_FILE_NAMES = ["wxa.config.ts", "wxa.config.mts", "wxa.config.js", "wxa.config.mjs", "wxa.config.cjs"];
var CONFIG_KEYS = /* @__PURE__ */ new Set([
  "project",
  "port",
  "host",
  "open",
  "baselib",
  "watch",
  "setup",
  "devtoolsLogin",
  "forwardConsole",
  "extensions",
  "pageTransition",
  "webViewWindow"
]);
function findConfigFile(dir) {
  for (const name of CONFIG_FILE_NAMES) {
    const file = path7.join(dir, name);
    if (fs7.existsSync(file)) return file;
  }
  return null;
}
async function loadConfigFile(file, warn) {
  let exported;
  try {
    exported = await importConfig(file);
  } catch (error) {
    throw new Error(`\u914D\u7F6E\u6587\u4EF6 ${file} \u52A0\u8F7D\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof exported !== "object" || exported === null || Array.isArray(exported)) {
    throw new Error(`\u914D\u7F6E\u6587\u4EF6 ${file} \u8981\u9ED8\u8BA4\u5BFC\u51FA\u4E00\u4E2A\u5BF9\u8C61\uFF0C\u5982 export default { port: 3000 }`);
  }
  const config = exported;
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length) warn(`\u914D\u7F6E\u6587\u4EF6 ${file} \u91CC\u6709\u4E0D\u8BA4\u8BC6\u7684\u914D\u7F6E\u9879\uFF1A${unknown.join("\u3001")}\uFF0C\u5DF2\u5FFD\u7565`);
  const dir = path7.dirname(file);
  const resolve = (value) => path7.resolve(dir, value);
  return {
    ...config,
    project: config.project && resolve(config.project),
    setup: typeof config.setup === "string" ? resolve(config.setup) : config.setup,
    extensions: config.extensions?.map((extension) => typeof extension === "string" && extension.startsWith(".") ? resolve(extension) : extension)
  };
}
async function importConfig(file) {
  if (!/\.m?ts$/.test(file)) return defaultExport(await import(pathToFileURL2(file).href));
  const { code } = await transform(fs7.readFileSync(file, "utf8"), {
    loader: "ts",
    format: "esm",
    platform: "node",
    sourcefile: file,
    define: {
      __dirname: JSON.stringify(path7.dirname(file)),
      __filename: JSON.stringify(file),
      "import.meta.url": JSON.stringify(pathToFileURL2(file).href)
    }
  });
  const compiled = `${file}.${randomUUID3()}.mjs`;
  fs7.writeFileSync(compiled, code);
  try {
    return defaultExport(await import(pathToFileURL2(compiled).href));
  } finally {
    fs7.rmSync(compiled, { force: true });
  }
}
function defaultExport(module) {
  const exported = module.default;
  return exported?.__esModule ? exported.default : exported;
}
export {
  AppBuilder,
  CONFIG_FILE_NAMES,
  DEFAULT_DEVICE,
  DevServer,
  LOCAL_HOST_OF_ANY_ADDRESS,
  MiniProgram,
  bundleSetup,
  createWxConfig,
  findConfigFile,
  findRuntimeDir,
  findSetupFile,
  handleProxy,
  listen,
  loadConfigFile
};
//# sourceMappingURL=index.mjs.map