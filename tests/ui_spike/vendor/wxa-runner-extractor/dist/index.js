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
var index_exports = {};
__export(index_exports, {
  BUNDLED_BASELIB_PACKAGE: () => BUNDLED_BASELIB_PACKAGE,
  DEFAULT_CACHE_DIR: () => DEFAULT_CACHE_DIR,
  ISOLATED_CONTEXT_SINCE: () => ISOLATED_CONTEXT_SINCE,
  MAX_COMPATIBLE_VERSION: () => MAX_COMPATIBLE_VERSION,
  TICKET_ENV: () => TICKET_ENV,
  compareVersions: () => compareVersions,
  extractBaseLib: () => extractBaseLib,
  findBundledBaseLibRoot: () => findBundledBaseLibRoot,
  findDeveloperTicket: () => findDeveloperTicket,
  findDevtoolsPackageDirs: () => findDevtoolsPackageDirs,
  findElectronDevtoolsCli: () => findElectronDevtoolsCli,
  findProfileDirs: () => findProfileDirs,
  findVendorDirs: () => findVendorDirs,
  isCompatibleVersion: () => isCompatibleVersion,
  listBaseLibs: () => listBaseLibs,
  listInstalledBaseLibs: () => listInstalledBaseLibs,
  readRegionData: () => readRegionData,
  readWxvpkgFile: () => readWxvpkgFile,
  readWxvpkgIndex: () => readWxvpkgIndex,
  resolveBaseLib: () => resolveBaseLib,
  selectBaseLib: () => selectBaseLib,
  usesIsolatedContext: () => usesIsolatedContext
});
module.exports = __toCommonJS(index_exports);

// src/wxvpkg.ts
var HEAD_MAGIC = 190;
var INDEX_MAGIC = 237;
function readWxvpkgIndex(buf) {
  if (buf.length < 18 || buf[0] !== HEAD_MAGIC || buf[13] !== INDEX_MAGIC) {
    throw new Error("\u4E0D\u662F\u6709\u6548\u7684 .wxvpkg \u6587\u4EF6");
  }
  const count = buf.readUInt32BE(14);
  const entries = [];
  let pos = 18;
  for (let i = 0; i < count; i++) {
    const nameLength = buf.readUInt32BE(pos);
    pos += 4;
    const name = buf.toString("utf8", pos, pos + nameLength);
    pos += nameLength;
    const offset = buf.readUInt32BE(pos);
    const size = buf.readUInt32BE(pos + 4);
    pos += 8;
    if (offset + size > buf.length) {
      throw new Error(`.wxvpkg \u5DF2\u635F\u574F\uFF1A${name} \u8D85\u51FA\u6587\u4EF6\u8303\u56F4`);
    }
    entries.push({ name, offset, size });
  }
  return entries;
}
function readWxvpkgFile(buf, entry) {
  return buf.subarray(entry.offset, entry.offset + entry.size);
}

// src/devtools.ts
var import_fs2 = __toESM(require("fs"));
var import_os = __toESM(require("os"));
var import_path = __toESM(require("path"));

// src/asar.ts
var import_fs = __toESM(require("fs"));
function readAsarFile(archive, filePath) {
  const fd = import_fs.default.openSync(archive, "r");
  try {
    const sizes = Buffer.alloc(16);
    import_fs.default.readSync(fd, sizes, 0, sizes.length, 0);
    const headerSize = sizes.readUInt32LE(4);
    const json = Buffer.alloc(sizes.readUInt32LE(12));
    import_fs.default.readSync(fd, json, 0, json.length, 16);
    let node = JSON.parse(json.toString("utf8"));
    for (const name of filePath.split("/").filter(Boolean)) {
      node = node?.files && Object.prototype.hasOwnProperty.call(node.files, name) ? node.files[name] : void 0;
    }
    if (node?.offset === void 0 || node.size === void 0) return null;
    const data = Buffer.alloc(node.size);
    import_fs.default.readSync(fd, data, 0, node.size, 8 + headerSize + Number(node.offset));
    return data;
  } finally {
    import_fs.default.closeSync(fd);
  }
}

// src/devtools.ts
var PACKAGE_LAYOUTS = [
  "Contents/Resources/package.nw",
  "Contents/Resources/app.asar.unpacked",
  "code/package.nw",
  "resources/app.asar.unpacked",
  "package.nw"
];
function findDevtoolsPackageDirs() {
  const roots = [];
  const candidates = [];
  if (process.env.WXA_DEVTOOLS_PATH) {
    roots.push(process.env.WXA_DEVTOOLS_PATH);
    candidates.push(process.env.WXA_DEVTOOLS_PATH);
  }
  if (process.platform === "darwin") {
    roots.push("/Applications/wechatwebdevtools.app", import_path.default.join(import_os.default.homedir(), "Applications/wechatwebdevtools.app"));
  } else if (process.platform === "win32") {
    for (const programFiles of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
      if (programFiles) roots.push(import_path.default.join(programFiles, "Tencent", "\u5FAE\u4FE1web\u5F00\u53D1\u8005\u5DE5\u5177"));
    }
  }
  for (const root of roots) {
    candidates.push(...PACKAGE_LAYOUTS.map((layout) => import_path.default.join(root, layout)));
  }
  return [...new Set(candidates)].filter((dir) => import_fs2.default.existsSync(import_path.default.join(dir, "package.json")));
}
function findElectronDevtoolsCli() {
  const [packageDir] = findDevtoolsPackageDirs();
  if (!packageDir?.endsWith("app.asar.unpacked")) return null;
  const candidates = [import_path.default.join(packageDir, "../../MacOS/cli"), import_path.default.join(packageDir, "../../cli.bat")];
  return candidates.find((file) => import_fs2.default.existsSync(file)) ?? null;
}
var REGION_DATA_FILES = {
  districts: "region_sub_strict_third",
  streets: "region_sub_strict"
};
function readRegionData(kind) {
  const file = `js/libs/${REGION_DATA_FILES[kind]}`;
  for (const dir of findDevtoolsPackageDirs()) {
    if (import_fs2.default.existsSync(import_path.default.join(dir, file))) return import_fs2.default.readFileSync(import_path.default.join(dir, file));
    const archive = dir.replace(/\.asar\.unpacked$/, ".asar");
    if (archive !== dir && import_fs2.default.existsSync(archive)) {
      const data = readAsarFile(archive, file);
      if (data) return data;
    }
  }
  return null;
}
function findProfileDirs() {
  const roots = [];
  if (process.platform === "darwin") {
    roots.push(import_path.default.join(import_os.default.homedir(), "Library/Application Support/\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177"));
  } else if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    roots.push(import_path.default.join(process.env.LOCALAPPDATA, "\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177", "User Data"));
  } else {
    roots.push(import_path.default.join(import_os.default.homedir(), ".config/wechat_devtools"));
  }
  const dirs = [];
  for (const root of roots) {
    if (!import_fs2.default.existsSync(root)) continue;
    for (const child of import_fs2.default.readdirSync(root)) dirs.push(import_path.default.join(root, child));
  }
  return dirs;
}
function findVendorDirs() {
  if (process.env.WXA_VENDOR_DIR) {
    return import_fs2.default.existsSync(process.env.WXA_VENDOR_DIR) ? [process.env.WXA_VENDOR_DIR] : [];
  }
  return findProfileDirs().map((dir) => import_path.default.join(dir, "WeappVendor")).filter((dir) => import_fs2.default.existsSync(dir));
}
var TICKET_ENV = "WECHAT_DEV_TICKET";
function findDeveloperTicket(profileDirs = findProfileDirs()) {
  if (process.env[TICKET_ENV]) return { newticket: process.env[TICKET_ENV] };
  const tickets = [];
  let readError = "";
  for (const dir of profileDirs) {
    try {
      const ticket = readProfileTicket(import_path.default.join(dir, "WeappLocalData"));
      if (ticket) tickets.push(ticket);
    } catch (error) {
      readError = `${dir}: ${error.message}`;
    }
  }
  if (tickets.length) return tickets.reduce((latest, ticket) => ticket.expiredAt > latest.expiredAt ? ticket : latest);
  if (readError) throw new Error(`\u8BFB\u53D6\u5F00\u53D1\u8005\u5DE5\u5177\u767B\u5F55\u6001\u5931\u8D25\uFF08${readError}\uFF09`);
  return null;
}
function readProfileTicket(localDataDir) {
  const hashMapFile = import_path.default.join(localDataDir, "hash_key_map_2.json");
  if (!import_fs2.default.existsSync(hashMapFile)) return null;
  const hashMap = JSON.parse(import_fs2.default.readFileSync(hashMapFile, "utf8"));
  const hash = Object.keys(hashMap).find((key) => hashMap[key] === "reduxPersist:user");
  if (!hash) return null;
  const userFile = import_path.default.join(localDataDir, `localstorage_${hash}.json`);
  if (!import_fs2.default.existsSync(userFile)) return null;
  const data = JSON.parse(import_fs2.default.readFileSync(userFile, "utf8"));
  const user = data.currentUser ?? data;
  if (user.loginStatus !== void 0 && user.loginStatus !== "SUCCESS") return null;
  if (typeof user.newticket !== "string" || !user.newticket || typeof user.ticketExpiredTime !== "number") return null;
  return { newticket: user.newticket, expiredAt: user.ticketExpiredTime };
}

// src/baselib.ts
var import_fs3 = __toESM(require("fs"));
var import_os2 = __toESM(require("os"));
var import_path2 = __toESM(require("path"));
var MAX_COMPATIBLE_VERSION = "3.7.0";
var ISOLATED_CONTEXT_SINCE = "3.7.1";
var DEFAULT_CACHE_DIR = import_path2.default.join(import_os2.default.homedir(), ".wxa-runner", "baselib");
var BUNDLED_BASELIB_PACKAGE = "@open-wxa/wxa-baselib";
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
function usesIsolatedContext(version) {
  return compareVersions(version, ISOLATED_CONTEXT_SINCE) >= 0;
}
function isCompatibleVersion(version) {
  return compareVersions(version, MAX_COMPATIBLE_VERSION) <= 0;
}
function listInstalledBaseLibs(vendorDirs = findVendorDirs()) {
  const byVersion = /* @__PURE__ */ new Map();
  for (const dir of vendorDirs) {
    for (const file of import_fs3.default.readdirSync(dir)) {
      const match = /^(\d+\.\d+\.\d+)\.wxvpkg$/.exec(file);
      if (!match || byVersion.has(match[1])) continue;
      byVersion.set(match[1], {
        source: "devtools",
        version: match[1],
        file: import_path2.default.join(dir, file),
        compatible: isCompatibleVersion(match[1])
      });
    }
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}
function findBundledBaseLibRoot() {
  try {
    return import_path2.default.dirname(require.resolve(`${BUNDLED_BASELIB_PACKAGE}/package.json`));
  } catch {
    return null;
  }
}
function listBaseLibs(vendorDirs = findVendorDirs(), bundledRoot = findBundledBaseLibRoot()) {
  const installed = listInstalledBaseLibs(vendorDirs);
  const bundled = (bundledRoot ? import_fs3.default.readdirSync(bundledRoot) : []).filter((name) => /^\d+\.\d+\.\d+$/.test(name) && !installed.some((lib) => lib.version === name)).map((version) => ({ source: "bundled", version, dir: import_path2.default.join(bundledRoot, version), compatible: isCompatibleVersion(version) }));
  return [...installed, ...bundled].sort((a, b) => compareVersions(b.version, a.version));
}
function selectBaseLib(libs, version) {
  if (version) {
    const found = libs.find((lib) => lib.version === version);
    if (!found) {
      const available = libs.map((lib) => lib.source === "bundled" ? `${lib.version}\uFF08\u5185\u7F6E\uFF09` : lib.version);
      throw new Error(
        `\u6CA1\u6709\u57FA\u7840\u5E93 ${version}\u3002\u53EF\u7528\u7684\u7248\u672C\uFF1A${available.join(", ") || "\u65E0"}\u3002\u53EF\u4EE5\u5728\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u7684\u300C\u8BE6\u60C5 \u2192 \u672C\u5730\u8BBE\u7F6E \u2192 \u8C03\u8BD5\u57FA\u7840\u5E93\u300D\u4E2D\u4E0B\u8F7D\u3002`
      );
    }
    return found;
  }
  const compatible = libs.find((lib) => lib.compatible);
  if (!compatible) {
    throw new Error(
      libs.length === 0 ? `\u6CA1\u6709\u627E\u5230\u57FA\u7840\u5E93\uFF1A\u672C\u673A\u6CA1\u6709\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\u4E0B\u8F7D\u7684\u57FA\u7840\u5E93\uFF08WeappVendor/*.wxvpkg\uFF09\uFF0C\u4E5F\u6CA1\u6709\u5B89\u88C5\u5185\u7F6E\u57FA\u7840\u5E93 ${BUNDLED_BASELIB_PACKAGE}\u3002\u8BF7\u5B89\u88C5\u5E76\u6253\u5F00\u4E00\u6B21\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\uFF08\u6216\u8BBE\u7F6E WXA_VENDOR_DIR\uFF09\uFF0C\u6216\u91CD\u65B0\u5B89\u88C5\u4F9D\u8D56\u3002` : `\u53EF\u7528\u7684\u57FA\u7840\u5E93\u90FD\u9AD8\u4E8E ${MAX_COMPATIBLE_VERSION}\uFF0C\u8BF7\u5728\u5F00\u53D1\u8005\u5DE5\u5177\u4E2D\u4E0B\u8F7D ${MAX_COMPATIBLE_VERSION} \u6216\u66F4\u4F4E\u7248\u672C\u3002`
    );
  }
  return compatible;
}
function extractBaseLib(lib, cacheDir = DEFAULT_CACHE_DIR) {
  const dir = import_path2.default.join(cacheDir, lib.version);
  const marker = import_path2.default.join(dir, ".complete");
  if (!import_fs3.default.existsSync(marker)) {
    const buf = import_fs3.default.readFileSync(lib.file);
    const tmpDir = `${dir}.tmp-${process.pid}`;
    import_fs3.default.rmSync(tmpDir, { recursive: true, force: true });
    for (const entry of readWxvpkgIndex(buf)) {
      const dest = import_path2.default.join(tmpDir, entry.name);
      if (!dest.startsWith(tmpDir + import_path2.default.sep)) {
        throw new Error(`.wxvpkg \u4E2D\u5305\u542B\u975E\u6CD5\u8DEF\u5F84\uFF1A${entry.name}`);
      }
      import_fs3.default.mkdirSync(import_path2.default.dirname(dest), { recursive: true });
      import_fs3.default.writeFileSync(dest, readWxvpkgFile(buf, entry));
    }
    import_fs3.default.writeFileSync(import_path2.default.join(tmpDir, ".complete"), lib.file);
    import_fs3.default.rmSync(dir, { recursive: true, force: true });
    import_fs3.default.mkdirSync(import_path2.default.dirname(dir), { recursive: true });
    import_fs3.default.renameSync(tmpDir, dir);
  }
  return { source: "devtools", version: lib.version, dir, compatible: lib.compatible };
}
function resolveBaseLib(options = {}) {
  const lib = selectBaseLib(listBaseLibs(), options.version || process.env.WXA_BASELIB || void 0);
  return lib.source === "bundled" ? lib : extractBaseLib(lib, options.cacheDir);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BUNDLED_BASELIB_PACKAGE,
  DEFAULT_CACHE_DIR,
  ISOLATED_CONTEXT_SINCE,
  MAX_COMPATIBLE_VERSION,
  TICKET_ENV,
  compareVersions,
  extractBaseLib,
  findBundledBaseLibRoot,
  findDeveloperTicket,
  findDevtoolsPackageDirs,
  findElectronDevtoolsCli,
  findProfileDirs,
  findVendorDirs,
  isCompatibleVersion,
  listBaseLibs,
  listInstalledBaseLibs,
  readRegionData,
  readWxvpkgFile,
  readWxvpkgIndex,
  resolveBaseLib,
  selectBaseLib,
  usesIsolatedContext
});
//# sourceMappingURL=index.js.map