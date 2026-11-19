import http, { IncomingMessage, ServerResponse } from 'http';
import { ResolvedBaseLib } from '@open-wxa/wxa-runner-extractor';
import { D as DeviceProfile, F as ForwardConsole } from './setup-D38utuW1.mjs';
export { A as ApiContext, a as ApiHandler, b as ApiResult, c as AppInfo, M as MockConfig, d as MockRequest, e as MockResponse, f as MockValue, N as NetworkConfig, R as RouteHandler, S as SetupApi, g as SetupConfig, h as SetupContext, i as SetupDefinition } from './setup-D38utuW1.mjs';
import { Request, Response } from 'express';
export { F as FrameError, P as PageSnapshot, R as RecordedRequest, W as WebViewInfo, a as WxaTestApi } from './testApi-czPhXmLd.mjs';

/**
 * 样式预处理：project.config.json 的 setting.useCompilerPlugins 开启 less / sass 时，
 * 按开发者工具（summer 编译器的 summer-less、summer-sass 插件）的规则把 .less / .scss / .sass 编译成同名的 .wxss
 *
 * - 同一路径有多种源文件时，预处理文件覆盖 .wxss；less 和 sass 都开启时，在 useCompilerPlugins 里排在后面的优先，.scss 优先于 .sass
 * - 除公共文件本身外，每个 .less 先引用小程序根目录的 app.less（lessSetting.commonUseFilePath），
 *   每个 .scss / .sass 先 @use global.scss 或 global.sass（sassSetting）；公共文件不存在时跳过
 * - @import "x.wxss"; 原样保留，由 wcsc 处理
 * - 编译器优先用项目里安装的 less / sass，没装时用 wxa-runner 自带的（开发者工具也自带编译器）
 *
 * wcsc 只接收文件路径、自己从磁盘读文件：和 WxmlMirror 一样，把编译结果和原有的 .wxss 写进临时目录，让 wcsc 在这里编译。
 */

type StylePluginName = 'less' | 'sass';
interface StyleSetting {
    /** 开启的样式插件，按 useCompilerPlugins 里的顺序 */
    plugins: StylePluginName[];
    /** ["less", { globalVars }] 写法给出的 less 全局变量 */
    lessGlobalVars: Record<string, string>;
    /** 相对小程序根目录 */
    lessCommonFile: string;
    sassCommonFile: string;
    scssCommonFile: string;
}

/**
 * 小程序项目结构解析
 *
 * 负责读取 app.json / 页面与组件 json，并按开发者工具的规则做预处理：
 * - app.json 的全局 usingComponents 展开到每个页面和组件（miniprogram_npm 内除外）
 * - 每个页面/组件 json 都保证有 usingComponents 字段
 */

interface AppJson {
    pages: string[];
    entryPagePath?: string;
    window?: Record<string, any>;
    tabBar?: {
        custom?: boolean;
        list: Array<{
            pagePath: string;
            text?: string;
            iconPath?: string;
            selectedIconPath?: string;
        }>;
        [key: string]: any;
    };
    subPackages?: Array<{
        root: string;
        pages: string[];
        independent?: boolean;
        [key: string]: any;
    }>;
    subpackages?: AppJson['subPackages'];
    usingComponents?: Record<string, string>;
    /** isSubpackage：Worker 代码作为分包，业务先调 wx.preDownloadSubpackage({ packageType: 'workers' }) 再创建 Worker */
    workers?: string | {
        path: string;
        isSubpackage?: boolean;
    };
    [key: string]: any;
}
interface UnitJson {
    usingComponents: Record<string, string>;
    componentGenerics?: Record<string, boolean | {
        default?: string;
    }>;
    component?: boolean;
    [key: string]: any;
}
/**
 * ext.json：第三方平台代开发时由微信客户端（开发者工具）合并到 app.json 的配置。
 * 文档：https://developers.weixin.qq.com/miniprogram/dev/devtools/ext.html
 */
interface ExtJson {
    /** false 时不启用，其余字段忽略；缺省视为启用 */
    extEnable?: boolean;
    /** 授权方小程序的 appid，启用时代替 project.config.json 的 appid 作为运行时 appid */
    extAppid?: string;
    /** 第三方平台自定义的数据，wx.getExtConfig / wx.getExtConfigSync 返回它 */
    ext?: Record<string, any>;
    /** 覆盖指定页面的配置（通常只有 window），不能新增页面 */
    extPages?: Record<string, Record<string, any>>;
    [key: string]: any;
}
declare class MiniProgram {
    readonly projectPath: string;
    /** 小程序代码根目录（已考虑 project.config.json 的 miniprogramRoot） */
    readonly root: string;
    readonly appid: string;
    constructor(projectPath: string);
    /** project.config.json 里与 less / sass 编译插件有关的设置；每次重新读取，开发中修改了也能生效 */
    get styleSetting(): StyleSetting;
    /** ext.json 的原始内容；没有这个文件时为 null */
    readExtJson(): ExtJson | null;
    /**
     * 生效的 ext.json：只有 extEnable 为 true 才启用，与微信文档一致（extEnable 必填、为 true 时生效）。
     * 没写 extEnable 时按不启用处理，和开发者工具的布尔判断一致
     */
    activeExtJson(): ExtJson | null;
    /**
     * 运行时 appid：第三方平台代开发时以 ext.json 的 extAppid（授权方小程序）为准，
     * 与开发者工具在代开发项目里的行为一致；其余情况用 project.config.json 的 appid
     */
    get runtimeAppid(): string;
    /** 按 ext.json 覆盖 app.json 中允许覆盖的字段；没启用时原样返回 */
    applyExtJson(app: AppJson): AppJson;
    /** ext.json 的 extPages：按微信客户端的规则直接覆盖指定页面的配置，不接受新增页面 */
    applyExtPages(unitJson: Map<string, UnitJson>): void;
    readAppJson(): AppJson;
    subPackages(app: AppJson): {
        [key: string]: any;
        root: string;
        pages: string[];
        independent?: boolean;
    }[];
    /** Worker 代码所在目录，不带首尾的 /；没有配置 workers 时为 null */
    workersDir(app: AppJson): string | null;
    /** 主包页面 + 分包页面（带 root 前缀） */
    allPages(app: AppJson): string[];
    /**
     * 读取并预处理页面/组件 json，id 不带扩展名。
     * 基础库运行时只把组件引用和当前路径拼在一起，不查找 miniprogram_npm、不补 /index（开发者工具编译时已解析好），
     * 所以能解析到的引用都换成组件的绝对路径
     */
    readUnitJson(id: string, app: AppJson): UnitJson;
    /**
     * 解析组件引用到组件路径（不带扩展名）；插件组件或找不到时返回 null。
     * 规则：/ 开头为根目录绝对路径；否则先按相对路径找，再沿目录向上查找 miniprogram_npm。
     */
    resolveComponent(fromId: string, ref: string): string | null;
    /** 收集页面、隐式自定义 tabBar 及它们（递归）引用到的组件 */
    collectUnits(app: AppJson): {
        pages: string[];
        components: string[];
    };
    /** 列出代码根目录下指定扩展名的文件，返回 posix 风格的相对路径 */
    listFiles(extensions: string[]): string[];
    exists(relPath: string): boolean;
    readText(relPath: string): string;
    private isInIndependentSubPackage;
}

/**
 * 把小程序项目构建成官方基础库能直接加载的形式
 *
 * 逻辑层（appservice）:
 *   1. 裁剪版 $gwx（wcc -xc），基础库用它了解组件的节点结构
 *   2. 每个 JS 文件单独一个 define("x.js", fn) 脚本（便于在 DevTools 里按原文件调试）
 *   3. bootstrap：注册 __wxAppCode__ 的 json/wxml（serviceTemplates，热更新时单独下发），
 *      require("app.js")，再依次 require 组件和页面
 *
 * 渲染层（page-frame）:
 *   1. 完整版 $gwx（wcc -cc）与每个页面/组件的 __wxAppCode__ json / wxml（pageTemplates）
 *   2. wcsc 的公共样式运行时 + app.wxss，与每个页面/组件的 __wxAppCode__ wxss（pageStyles）。
 *      开启 less / sass 编译插件时，先把 .less / .scss / .sass 编译成 .wxss（见 StyleMirror）
 *   两部分在热更新时分别下发
 *   样式和模板里的 env(safe-area-inset-*) 改写成 CSS 变量，见 rewriteSafeAreaInsets
 *
 * Worker：workers 目录下的 JS 不进逻辑层，同样包装成 define 脚本，由 Worker 入口（server/html.ts 的 workerScript）加载
 */

interface BuildResult {
    version: number;
    wxConfig: Record<string, any>;
    /** 所有 JS 模块 id（如 "pages/index/index.js"），逻辑层按此顺序加载 define 脚本 */
    modules: string[];
    /** workers 目录下的 JS 模块 id，Worker 按此顺序加载 define 脚本 */
    workerModules: string[];
    /** 逻辑层的 $gwx 与 __wxAppCode__ json/wxml，不含 require */
    serviceTemplates: string;
    serviceBootstrap: string;
    pageFrame: string;
    /** 渲染层的 $gwx 与 __wxAppCode__ json/wxml，不含样式（热更新时单独下发） */
    pageTemplates: string;
    /** 渲染层的样式：公共样式立即注入，页面和组件的样式注册到 __wxAppCode__（热更新时单独下发） */
    pageStyles: string;
    pages: string[];
    components: string[];
    durationMs: number;
}
interface AppBuilderOptions {
    /** wxml 交给 wcc 前的转换，见 DevServerOptions.wxmlTransform */
    wxmlTransform?: (code: string, file: string) => string;
}
declare class AppBuilder {
    readonly project: MiniProgram;
    private version;
    /** invalidate 标记过的变化次数；每次构建记下开始时覆盖到第几次 */
    private changes;
    private pending;
    private last;
    private dirty;
    private wxmlCache;
    private wxssCache;
    /** 设置了 wxmlTransform 时才有 */
    private readonly wxmlMirror;
    /** 开启了 less / sass 编译插件时才有；插件设置变了就换一个 */
    private styleMirror;
    constructor(project: MiniProgram, options?: AppBuilderOptions);
    /** wxmlTransform 的镜像目录；没有设置转换或还没编译过时为 null */
    get wxmlMirrorDir(): string | null;
    /** 删除 wxmlTransform 和样式预处理的镜像目录，开发服务器关闭时调用 */
    dispose(): void;
    /** 根据变化的文件标记需要重新构建的部分；返回 true 表示需要刷新 */
    invalidate(changedFiles?: string[]): boolean;
    /**
     * 返回包含调用前所有变化的构建结果。并发调用共享同一次构建；
     * 进行中的构建开始得比最近一次变化早时（可能已读到旧文件），等它结束后再构建一次
     */
    build(): Promise<BuildResult>;
    /**
     * 单个 JS 模块的 define 包装
     *
     * 包装头和代码第一行写在同一行，行号与源文件一致。使用 import/export 的文件
     * 先转换为 CommonJS（对应开发者工具的「ES6 转 ES5」），并内联 source map。
     */
    getModuleScript(id: string): string;
    private doBuild;
    private compileTemplates;
    /** 与开发者工具一致，项目里的 wxss 全部交给 wcsc：被 @import 的文件（如 uni-app 的 common/main.wxss）也要在列表里 */
    private compileStyles;
    private currentStyleMirror;
    /** $gwx 加上各页面、组件的 json / wxml 注册；逻辑层用裁剪版 $gwx，渲染层用完整版 */
    private createTemplates;
    private createServiceBootstrap;
}

/**
 * 小程序页面与代码的路由：逻辑层、子上下文、渲染层的 HTML，业务模块、模板、样式和插件代码
 *
 * 开发服务器和查看器（wxapack）的 Service Worker 共用这一份，两边生成的页面才不会走样，所以不依赖 Node。
 * app-info、setup、静态资源、文件接口等和运行环境有关的路由各自实现。
 */

declare const DEFAULT_DEVICE: DeviceProfile;

/**
 * 开发服务器扩展：检查器这类开发工具把要用的扩展点打包成一个扩展，
 * 由 DevServer 的 extensions 选项、命令行的 --extension 或配置文件的 extensions 加载。runner 只认这个约定，不认识具体的工具。
 *
 * （「插件」在 runner 里指小程序插件，见 plugins.ts，所以这里叫扩展）
 */

interface DevServerExtension {
    /** 出现在报错和启动信息里 */
    name: string;
    /** 开发服务器构造时调用一次 */
    setup(context: ExtensionContext): ExtensionSetup;
}
interface ExtensionContext {
    /** 项目目录（DevServer 的 projectPath，绝对路径） */
    projectPath: string;
    /** 小程序代码根目录，已考虑 project.config.json 的 miniprogramRoot */
    root: string;
}
interface ExtensionSetup {
    webviewScripts?: WebviewScript[];
    middlewares?: DevServerMiddleware[];
    wxmlTransform?: (code: string, file: string) => string;
    /** 扩展自己的页面：启动信息里打印，命令行 --open 时打开 */
    entry?: {
        label: string;
        path: string;
    };
}
interface ExtensionEntry {
    name: string;
    label: string;
    path: string;
}

/**
 * 开发服务器
 *
 *   /                          宿主页面
 *   /__wxa__/app-info.json     构建信息（__wxConfig、页面列表、设备参数、setup）
 *   /__wxa__/setup.js          编译后的 setup 文件
 *   /__wxa__/appservice.html   逻辑层
 *   /__wxa__/webview/<page>.html  渲染层（路径与页面一致，wxml 里的相对资源路径因此能正确解析）
 *   /__wxa__/module/<file>.js  单个业务 JS 模块（含 workers 目录下的）
 *   /__wxa__/worker.js?id=     Worker 的入口
 *   /__wxa__/service-templates.js、page-templates.js  两层的模板（热更新时重新下发）
 *   /__wxa__/page-styles.js    渲染层的样式（热更新时重新下发）
 *   /__baselib__/*             官方基础库
 *   /__wxa__/proxy/<协议>/<域名><路径>  网络代理，如 /__wxa__/proxy/https/api.example.com/a?b=1
 *   /__wxa__/mock/<协议>/<域名><路径>   被拦截的请求在 Network 面板里的地址，由 Service Worker（runtime/sw.js）返回响应
 *   /__wxa__/fs/<会话>          文件系统接口（FileSystemManager），每个浏览器会话一份文件，会话标识见 runtime/fileSession.ts
 *   /__wxa__/tmp/<会话>         临时文件：POST ?type=png 保存，返回可直接访问的地址（GET 支持分段请求）；对该地址 HEAD 查大小、DELETE 删除
 *   /__wxa__/usr/<会话>/<路径>   用户目录（USER_DATA_PATH）下的文件，image 等组件和 uploadFile 按地址读取
 *   /__wxa__/region/<kind>     地区选择器用的行政区划数据（districts / streets），取自本机开发者工具
 *   /__wxa__/api/*             --devtools-login：wx.login 的 code、手机号，服务市场、插件的请求转发，只允许本机访问
 *   /__wxa__/socket            带自定义请求头的 WebSocket 转发，只接受同源连接
 *   /__wxa__/ws                文件变化通知：热更新（hot）或整页刷新（reload）；开启 forwardConsole 时浏览器从这里发来报错
 *   middlewares / 扩展挂载的路径  排在 runner 自己的路由之前
 *   其余路径                    小程序目录下的静态资源
 */

/** 注入每个渲染层页面的脚本，src 与 content 二选一 */
type WebviewScript = ({
    src: string;
    content?: never;
} | {
    content: string;
    src?: never;
}) & {
    /**
     * 'head'：在基础库（WAWebview.js）之前执行，用于要赶在基础库之前注册事件监听的脚本，执行时还没有 document.body；
     * 'body'（默认）：在 <body> 开头、页面开始渲染之前执行。不能放在 <body> 末尾：基础库渲染时会换掉 body，
     *   之后才解析到的脚本落在脱离文档的旧 body 里，不会执行
     */
    position?: 'head' | 'body';
};
/** 挂在开发服务器上的中间件：按前缀匹配，handler 收到的 req.url 已去掉 path 这段前缀 */
interface DevServerMiddleware {
    /** 以 / 开头的字面量路径前缀，如 /__tool__；不能是 /，不能含通配符和参数，也不能落在 runner 保留的前缀下（见 RESERVED_PREFIXES） */
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
}
interface DevServerOptions {
    projectPath: string;
    /** 不传时从 3000 起找空闲的端口；指定的端口被占用时启动失败；传 0 使用随机端口 */
    port?: number;
    /** 监听地址，默认 localhost；0.0.0.0 或 :: 时局域网也能访问 */
    host?: string;
    /** 指定基础库版本，默认使用本机已安装的最新兼容版本 */
    baseLibVersion?: string;
    baseLibCacheDir?: string;
    watch?: boolean;
    device?: Partial<DeviceProfile>;
    /** navigateTo / navigateBack 时滑动页面内容，默认 false */
    pageTransition?: boolean;
    /**
     * 小程序启动前执行的 setup 文件；默认使用项目目录下的 wxa.setup.ts / .js / .mjs，传 false 不使用
     * 环境变量在构造时读取，只暴露 WXA_ 前缀的变量
     */
    setup?: string | false;
    /** 浏览器端运行时（host.js / frame.js）所在目录，默认取构建产物 */
    runtimeDir?: string;
    /**
     * 借本机微信开发者工具的登录态访问微信后台：真实的 wx.login code 和手机号、服务市场、插件。
     * 要先登录开发者工具，会真实请求微信
     */
    devtoolsLogin?: boolean;
    /**
     * 把浏览器里的报错打印到终端：'errors' 转发运行时错误和未实现 API 的提醒，'all' 再加上 console.warn / console.error。
     * 默认不转发；命令行默认 'errors'，检测到编程助手时 'all'
     */
    forwardConsole?: ForwardConsole;
    /**
     * web-view 的网页在新窗口打开，而不是嵌在模拟器里的 iframe 中。网页成为顶层页面，
     * 和模拟器域名不同时 Cookie 也能正常使用；默认 false
     */
    webViewWindow?: boolean;
    /** 注入每个渲染层页面（含插件页面、跳转后新建的页面）的脚本，供检查器等开发工具使用 */
    webviewScripts?: WebviewScript[];
    /** 挂在开发服务器上的中间件，供开发工具提供自己的页面和接口 */
    middlewares?: DevServerMiddleware[];
    /**
     * wxml 交给 wcc 编译前的转换，file 是相对小程序根目录的路径（如 pages/index/index.wxml）。
     * 不能改变行数，编译错误和热更新才能对应到源文件；相同输入要返回相同输出。源文件不会被修改
     */
    wxmlTransform?: (code: string, file: string) => string;
    /** 开发服务器扩展：把上面几个扩展点打包在一起的开发工具，按顺序合并在直接给出的选项之后，见 extensions.ts */
    extensions?: DevServerExtension[];
    logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

declare class DevServer {
    private readonly options;
    readonly project: MiniProgram;
    readonly builder: AppBuilder;
    readonly baseLib: ResolvedBaseLib;
    /** 生效的 setup 文件绝对路径，没有时为 null */
    readonly setupFile: string | null;
    /** 扩展提供的页面，按扩展的顺序 */
    readonly extensionEntries: ExtensionEntry[];
    private readonly setupEnv;
    private readonly device;
    private readonly logger;
    private readonly app;
    private server;
    private socketProxy;
    private sockets;
    private watcher;
    /** 上次编译失败时页面上显示着错误，修好后整页刷新才能清掉 */
    private lastBuildFailed;
    private address;
    private lanAccess;
    /** 运行时生成的临时文件（canvas 导出、拍照等），随服务器进程存在 */
    private readonly fileSessions;
    private readonly devtoolsLogin;
    /** 开启 --devtools-login 时才有 */
    private readonly devtools;
    private readonly ticketSource;
    private readonly plugins;
    /** 选项里直接给出的扩展点与各个扩展合并后的结果 */
    private readonly webviewScripts;
    private readonly middlewares;
    constructor(options: DevServerOptions);
    /** 本机访问的地址 */
    get url(): string;
    /** 局域网里其他设备访问的地址，每块网卡一个；只监听本机时为空 */
    get networkUrls(): string[];
    start(): Promise<string>;
    close(): Promise<void>;
    private createApp;
    /** 先编译一遍 setup：编译错误随 app-info 交给宿主显示，而不是让浏览器 import 失败 */
    private setupInfo;
    /** 构建结果并入这次打开小程序时决定用的插件 */
    private currentBuild;
    /** 需要构建结果的路由；构建失败时返回错误文本 */
    private appSource;
    private withBuild;
    private runtimeDir;
    /** 只在监听文件变化时打开基础库的热更新开关，跑测试（watch: false）时运行环境与真机一致 */
    private get hotEnabled();
    /** 返回初次扫描完成的时刻，此前已存在的文件不会作为改动报告 */
    private startWatching;
    private broadcast;
}
/** 监听所有地址时，本机访问用的地址：0.0.0.0 只监听 IPv4，localhost 可能解析到 IPv6 的 ::1 */
declare const LOCAL_HOST_OF_ANY_ADDRESS: Map<string, string>;
/** 开始监听，返回实际的端口。没指定端口时从 3000 起往后找空闲的，换了端口在终端提示 */
declare function listen(server: http.Server, port: number | undefined, host: string, logger: Pick<Console, 'warn'>): Promise<number>;
/**
 * 浏览器端运行时（host.js、frame.js 等）所在目录：给了 explicit 就用它，否则找本包的构建产物
 * @throws 都没有 host.js 时（源码运行但还没 pnpm build）
 */
declare function findRuntimeDir(explicit?: string): string;

/** 项目目录（project.config.json 所在目录）下约定名称的 setup 文件 */
declare function findSetupFile(projectPath: string): string | null;
/**
 * 把 setup 文件连同它 import 的文件打成一个浏览器 ES 模块
 *
 * 用户的小程序项目里通常没装本包，对它的引用直接换成运行时自带的实现。
 *
 * @throws 语法错误、import 找不到等编译错误，消息里带相对 setup 文件目录的位置
 */
declare function bundleSetup(file: string): Promise<string>;

/**
 * 命令行 dev 的配置文件 wxa.config.*：项目里长期不变的启动参数。默认导出普通对象，不用引入 wxa-runner，
 * 要类型提示时用 import type { WxaConfig } from 'wxa-runner'
 */

declare const CONFIG_FILE_NAMES: string[];
/** 配置文件的内容；命令行写了的参数优先，路径相对配置文件所在目录 */
interface WxaConfig {
    /** 小程序项目目录（project.config.json 所在目录），写了之后命令行可以不写项目目录 */
    project?: string;
    /** 端口号，默认 3000，被占用时换用后面空闲的端口 */
    port?: number;
    /** 监听地址，默认 localhost；true 时监听所有地址，局域网也能访问 */
    host?: string | true;
    /** 启动后打开浏览器 */
    open?: boolean;
    /** 基础库版本，默认使用本机已安装的最新兼容版本 */
    baselib?: string;
    /** 监听文件变化并热更新，默认 true */
    watch?: boolean;
    /** 小程序启动前执行的 setup 文件，默认使用项目目录下的 wxa.setup.ts / .js / .mjs；false 不执行 */
    setup?: string | false;
    /** 借本机微信开发者工具的登录态访问微信后台：真实的 code 和手机号、服务市场、插件 */
    devtoolsLogin?: boolean;
    /** true 时 console.warn / console.error 也转发到终端，false 时报错也不转发；默认只转发报错，检测到编程助手时全部转发 */
    forwardConsole?: boolean;
    /** 开发服务器扩展：扩展对象、不带参数调用后返回扩展的函数，或 npm 包名、文件路径。排在命令行 --extension 之前 */
    extensions?: Array<DevServerExtension | (() => DevServerExtension) | string>;
    /** （实验性）navigateTo 和 navigateBack 时播放页面滑动过渡，导航栏和 tabBar 暂不跟随 */
    pageTransition?: boolean;
    /** web-view 的网页在新窗口打开：网页和模拟器域名不同时，Cookie 也能正常使用 */
    webViewWindow?: boolean;
}
/** dir 下约定名称的配置文件，没有时为 null */
declare function findConfigFile(dir: string): string | null;
/**
 * 加载配置文件，project、setup 和以 . 开头的扩展路径换成绝对路径
 * @param warn 收到不认识的配置项时调用：可能是拼错了，也可能是给更新的版本写的
 * @throws 文件执行出错，或默认导出不是对象
 */
declare function loadConfigFile(file: string, warn: (message: string) => void): Promise<WxaConfig>;

/**
 * 开发服务器和本机查看器的网络代理：把 express 的请求转成 Fetch 请求交给 proxyFetch.ts，再把响应流式写回
 */

/**
 * 用 app.use 挂载，保留未解码的 originalUrl：Express 通配路由会解码 %2F，甚至拒绝单独的 %。
 */
declare function handleProxy(req: Request, res: Response): Promise<void>;

/**
 * 生成基础库读取的 __wxConfig，字段与开发者工具保持一致
 */

interface WxConfigInput {
    app: AppJson;
    pages: string[];
    unitJson: Map<string, UnitJson>;
    appid: string;
    subPackages: NonNullable<AppJson['subPackages']>;
    /** 生效的 ext.json（三方平台代开发），没有时不影响输出 */
    extJson?: ExtJson | null;
}
declare function createWxConfig(input: WxConfigInput): Record<string, any>;

export { AppBuilder, type AppBuilderOptions, type AppJson, type BuildResult, CONFIG_FILE_NAMES, DEFAULT_DEVICE, DevServer, type DevServerExtension, type DevServerMiddleware, type DevServerOptions, DeviceProfile, type ExtensionContext, type ExtensionEntry, type ExtensionSetup, ForwardConsole, LOCAL_HOST_OF_ANY_ADDRESS, MiniProgram, type UnitJson, type WebviewScript, type WxaConfig, bundleSetup, createWxConfig, findConfigFile, findRuntimeDir, findSetupFile, handleProxy, listen, loadConfigFile };
