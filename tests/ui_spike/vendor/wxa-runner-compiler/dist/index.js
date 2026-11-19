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
  compileWxml: () => compileWxml,
  compileWxss: () => compileWxss,
  findCompilerBinaries: () => findCompilerBinaries,
  parseWcscOutput: () => parseWcscOutput,
  unescapeJsString: () => unescapeJsString
});
module.exports = __toCommonJS(index_exports);

// src/wcc.ts
var import_fs2 = __toESM(require("fs"));
var import_os = __toESM(require("os"));
var import_path2 = __toESM(require("path"));

// src/exec.ts
var import_child_process = require("child_process");
var MAX_OUTPUT = 512 * 1024 * 1024;
function runCompiler(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    (0, import_child_process.execFile)(bin, args, { cwd, maxBuffer: MAX_OUTPUT, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || stdout || error.message).trim();
        reject(new Error(`${bin.split(/[\\/]/).pop()} \u7F16\u8BD1\u5931\u8D25\uFF1A
${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// src/locate.ts
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_wxa_runner_extractor = require("@open-wxa/wxa-runner-extractor");
var cached = null;
function findCompilerBinaries() {
  if (!cached) cached = locateCompilerBinaries((0, import_wxa_runner_extractor.findDevtoolsPackageDirs)());
  return cached;
}
function locateCompilerBinaries(devtoolsDirs) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidates = [];
  if (process.env.WXA_WCC && process.env.WXA_WCSC) {
    candidates.push({ wcc: process.env.WXA_WCC, wcsc: process.env.WXA_WCSC });
  }
  for (const dir of devtoolsDirs) {
    const execDir = import_path.default.join(dir, "node_modules", "wcc-exec");
    candidates.push({ wcc: import_path.default.join(execDir, "wcc" + ext), wcsc: import_path.default.join(execDir, "wcsc" + ext) });
  }
  const packaged = findPackagedCompiler(ext);
  if (packaged) candidates.push(packaged);
  const found = candidates.find((c) => import_fs.default.existsSync(c.wcc) && import_fs.default.existsSync(c.wcsc));
  if (!found) {
    throw new Error(
      "\u6CA1\u6709\u627E\u5230 wcc/wcsc \u7F16\u8BD1\u5668\u3002\u8BF7\u5B89\u88C5\u5FAE\u4FE1\u5F00\u53D1\u8005\u5DE5\u5177\uFF0C\u6216\u91CD\u65B0\u5B89\u88C5\u4F9D\u8D56\u4EE5\u5B89\u88C5 miniprogram-compiler\uFF08Linux \u53EA\u652F\u6301 x86-64\uFF09\uFF0C\u6216\u901A\u8FC7 WXA_DEVTOOLS_PATH / WXA_WCC + WXA_WCSC \u6307\u5B9A\u4F4D\u7F6E\u3002"
    );
  }
  if (found === packaged) {
    for (const file of [found.wcc, found.wcsc]) {
      try {
        import_fs.default.accessSync(file, import_fs.default.constants.X_OK);
      } catch {
        import_fs.default.chmodSync(file, 493);
      }
    }
  }
  return found;
}
function findPackagedCompiler(ext) {
  const platformDir = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : process.platform === "linux" && process.arch === "x64" ? "linux" : null;
  if (!platformDir) return null;
  let root;
  try {
    root = import_path.default.dirname(require.resolve("miniprogram-compiler/package.json"));
  } catch {
    return null;
  }
  const dir = import_path.default.join(root, "bin", platformDir);
  return { wcc: import_path.default.join(dir, "wcc" + ext), wcsc: import_path.default.join(dir, "wcsc" + ext) };
}

// src/wcc.ts
var MAX_INLINE_ARGS_LENGTH = 3e4;
var SPLIT = ">_<1024";
async function compileWxml(options) {
  const { wcc } = findCompilerBinaries();
  const config = [options.components.length];
  for (const component of options.components) {
    config.push(`./${component.path}.wxml`, component.tags.length, ...component.tags);
  }
  const args = ["-d", "--split", SPLIT, options.cut ? "-xc" : "-cc", config.join(SPLIT)];
  if (options.files.some((file) => file.endsWith(".wxs"))) {
    args.unshift("-ds");
  }
  args.push(...options.files, "-gn", options.genfuncName || "$gwx");
  if (args.join(" ").length <= MAX_INLINE_ARGS_LENGTH) {
    return runCompiler(wcc, args, options.cwd);
  }
  const configFile = import_path2.default.join(import_os.default.tmpdir(), `wxa-runner-wcc-${process.pid}-${Date.now()}.txt`);
  import_fs2.default.writeFileSync(configFile, args.join("\n"));
  try {
    return await runCompiler(wcc, ["--config-path", configFile], options.cwd);
  } finally {
    import_fs2.default.rmSync(configFile, { force: true });
  }
}

// src/wcsc.ts
async function compileWxss(options) {
  const { wcsc } = findCompilerBinaries();
  const files = [...options.pageFiles, ...options.commonFiles];
  if (files.length === 0) {
    return { comm: "", pages: {} };
  }
  const args = ["-db", "-pc", String(options.pageFiles.length), ...files];
  const raw = parseWcscOutput(await runCompiler(wcsc, args, options.cwd));
  const pages = {};
  for (const file of options.pageFiles) {
    if (raw[file] !== void 0) pages[file.replace(/^\.\//, "")] = raw[file];
  }
  return { comm: raw.comm || "", pages };
}
function parseWcscOutput(output) {
  const parts = output.split("=");
  const result = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    result[parts[i]] = unescapeJsString(parts[i + 1]);
  }
  return result;
}
var SIMPLE_ESCAPES = {
  n: "\n",
  t: "	",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0"
};
function unescapeJsString(value) {
  return value.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (_, seq) => {
    if ((seq[0] === "x" || seq[0] === "u") && seq.length > 1) {
      return String.fromCharCode(parseInt(seq.slice(1), 16));
    }
    return SIMPLE_ESCAPES[seq] ?? seq;
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  compileWxml,
  compileWxss,
  findCompilerBinaries,
  parseWcscOutput,
  unescapeJsString
});
//# sourceMappingURL=index.js.map