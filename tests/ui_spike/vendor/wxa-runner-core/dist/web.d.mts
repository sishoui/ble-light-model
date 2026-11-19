/** 把浏览器里的报错转发到开发服务器的终端：errors 只转发报错，all 再加上 console.warn / console.error，false 不转发 */
type ForwardConsole = 'errors' | 'all' | false;
interface DeviceProfile {
    model: string;
    screenWidth: number;
    screenHeight: number;
    pixelRatio: number;
    statusBarHeight: number;
    /** 底部安全区高度（Home Indicator），无刘海机型为 0 */
    safeAreaBottom: number;
    system: string;
    platform: string;
}
/** /__wxa__/app-info.json */
interface AppInfo {
    version: number;
    appid: string;
    baseLibVersion: string;
    wxConfig: Record<string, any>;
    pages: string[];
    device: DeviceProfile;
    /** navigateTo / navigateBack 时滑动页面内容，默认 false */
    pageTransition?: boolean;
    /** 开启了 --devtools-login */
    devtoolsLogin?: boolean;
    /** 开发服务器提供 WebSocket 请求头转发；静态查看器未提供时保持直连 */
    socketProxy?: boolean;
    /** false 表示没有开发服务器，不建立热更新和报错转发连接 */
    liveReload?: boolean;
    /** 使用查看器已经注册的 Service Worker，宿主不能用 sw.js 替换它 */
    externalServiceWorker?: boolean;
    buildError?: string;
    /** 配置了 setup 文件时存在；error 是 setup 的编译错误 */
    setup?: {
        env: Record<string, string>;
        error?: string;
    };
    /** 没有时不转发 */
    forwardConsole?: ForwardConsole;
    /** web-view 的网页在新窗口打开，见 api/webView.ts 的 WebViewWindows */
    webViewWindow?: boolean;
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

/**
 * 插件代码的数据结构与页面查找，下载见 plugins.ts。
 * 不依赖 Node：查看器的 Service Worker 也按同样的结构生成页面
 */

interface PluginCode {
    /** app.json 里的引用名，plugin://<alias>/页面名 */
    alias: string;
    /** 插件 appid */
    provider: string;
    version: string;
    /** 包内路径（/ 开头）→ 内容 */
    files: Map<string, Uint8Array>;
    /** 插件页面的路径，如 __plugin__/wx…/pages/index/index */
    pages: string[];
    /** 插件页面的配置，键同 __wxConfig.page（路径加 .html） */
    pageConfigs: Record<string, unknown>;
}
/** 构建结果加上用到的插件：插件页面并入 pages，配置并入 __wxConfig.page */
interface AppBuild extends BuildResult {
    plugins: PluginCode[];
}

/**
 * 小程序页面与代码的路由：逻辑层、子上下文、渲染层的 HTML，业务模块、模板、样式和插件代码
 *
 * 开发服务器和查看器（wxapack）的 Service Worker 共用这一份，两边生成的页面才不会走样，所以不依赖 Node。
 * app-info、setup、静态资源、文件接口等和运行环境有关的路由各自实现。
 */

declare const DEFAULT_DEVICE: DeviceProfile;
interface AppSource {
    build: AppBuild;
    /** 业务模块的 define 脚本，id 已确认在 modules 或 workerModules 里 */
    moduleScript(id: string): string;
    baseLib: {
        version: string;
        hasWorker: boolean;
    };
    /** 新版基础库的隔离上下文，见 html.ts 的 appserviceHtml */
    isolated: boolean;
    /** 打开基础库的热更新开关 */
    hot: boolean;
    webviewScripts?: WebviewScript[];
}
interface RouteResponse {
    status: number;
    /** express 的 res.type() 能识别的写法：'html'、'js'、'text' 或带点的扩展名；在 Service Worker 里用 mimeType() 换成 Content-Type */
    type: string;
    body: string | Uint8Array;
}
/** @returns 不归这里管、或请求的页面和文件不存在时为 null，交给后面的路由 */
declare function routeApp(source: AppSource, url: URL): RouteResponse | null;
/** RouteResponse.type 或文件扩展名对应的 Content-Type；认不出的按二进制处理 */
declare function mimeType(type: string): string;
/** 带点的扩展名，没有时为空串 */
declare function extname(filePath: string): string;

/**
 * 宿主、逻辑层、渲染层的 HTML，以及 Worker 的入口脚本
 *
 * 不依赖 Node：查看器的 Service Worker 也用这些函数生成页面
 */

declare function hostHtml(): string;

/** 文件 API、下载、上传和资源 URL 共用这些字节；不依赖 Node，以便 Service Worker 也能直接使用。 */
interface FsNode {
    dir: boolean;
    data: Uint8Array;
    mtime: number;
    etag: string;
}
/** 基础库会往 http://usr/ 写运行日志；业务代码也可以通过 FileSystemManager 读写 */
declare class FileStore {
    private readonly etagPrefix;
    private version;
    private nodes;
    private readonly roots;
    /** @param roots 预先创建的目录（如用户目录）。rmdir 不能删除它们和它们的上级目录：删掉之后再写 USER_DATA_PATH 都会失败 */
    constructor(roots?: string[]);
    normalize(filePath: string): string;
    stat(filePath: string): FsNode | undefined;
    mkdir(dirPath: string, recursive?: boolean): void;
    write(filePath: string, input: string | Uint8Array, append?: boolean): void;
    read(filePath: string): Uint8Array;
    readdir(dirPath: string): string[];
    remove(filePath: string, options: {
        dir: boolean;
        recursive?: boolean;
    }): void;
    /** 文件 API 经开发服务器调用的操作，参数和返回值的字段名与基础库一致 */
    execute(operation: string, args: any): Record<string, any>;
    private readonly operations;
    private writeEncoded;
    private existing;
    private assertNotRoot;
}

/**
 * 网络代理：浏览器端的 wx.request 经由这里转发到真实服务器
 *
 * - 原地址写在路径里：/__wxa__/proxy/https/api.example.com/a?b=1（见 networkPanel.ts）
 * - 绕开 CORS
 * - 小程序设置的请求头放在 x-wxa-headers（JSON）里传过来，
 *   这样 cookie / referer / user-agent 等浏览器禁止设置的头也能带上
 * - 响应头和 set-cookie 以 URL 编码的 JSON 返回，浏览器端可以完整读取
 *
 * 只用标准 Fetch API：开发服务器（proxy.ts）和其他支持 Fetch API 的运行时共用。
 */
declare function proxyFetch(request: Request, options?: {
    fetch?: typeof fetch;
    isAllowed?: (url: URL) => boolean;
}): Promise<Response>;

/**
 * 小程序的请求在浏览器 Network 面板里的样子，宿主、Service Worker 和开发服务器共用
 *
 * 原地址放在路径里：/__wxa__/proxy/https/api.example.com/user/info?id=1。Name 列显示接口名（info?id=1），
 * 按域名、路径过滤也直接可用；放在查询参数里时每一行都是 proxy?url=https%3A%2F%2F…，分不出是哪个接口。
 *
 * - 经开发服务器转发的请求：/__wxa__/proxy/…
 * - 被拦截规则拦下的请求：/__wxa__/mock/…，由 Service Worker 返回规则给出的响应，只用于显示（见 sw.ts）
 */

declare const PROXY_PREFIX = "/__wxa__/proxy/";
declare const MOCK_PREFIX = "/__wxa__/mock/";
/** 显示被拦截请求的 fetch 带上这个头，Service Worker 凭它向宿主要对应的响应 */
declare const MOCK_ID_HEADER = "x-wxa-mock-id";
/** Service Worker 向宿主要响应时发的消息，附带一个 MessagePort，宿主从这个端口回复 MockReply */
interface MockQuery {
    type: 'wxa-mock-response';
    id: string;
}

/**
 * 被拦截的 wx.request 在 Network 面板里的响应：Service Worker 向发出请求的页面要拦截规则给出的结果。
 * 开发服务器的 sw.ts 和查看器的 packSw.ts 共用
 */

interface MockClient {
    postMessage(message: MockQuery, transfer: Transferable[]): void;
}
/** 向发起请求的页面索取拦截响应；页面失效或响应无法表示时让 Network 面板显示请求失败。 */
declare function mockedResponse(client: MockClient | undefined, id: string): Promise<Response>;

/** setup 打包时对 wxa-runner-core/setup 的替换：开发服务器和在浏览器里编译 setup 的宿主（如查看器）共用同一实现；defineSetup 只提供类型提示，运行时原样返回。 */
declare const SETUP_MODULE = "@open-wxa/wxa-runner-core/setup";
declare const SETUP_MODULE_SOURCE = "export function defineSetup(setup) { return setup; }";

export { type AppBuild, type AppInfo, type AppSource, type BuildResult, DEFAULT_DEVICE, type DeviceProfile, FileStore, MOCK_ID_HEADER, MOCK_PREFIX, type MockClient, PROXY_PREFIX, type PluginCode, type RouteResponse, SETUP_MODULE, SETUP_MODULE_SOURCE, extname, hostHtml, mimeType, mockedResponse, proxyFetch, routeApp };
