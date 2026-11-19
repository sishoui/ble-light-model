/**
 * 浏览器端运行时共享类型
 *
 * 宿主页面（host）与逻辑层/渲染层 iframe 同源，iframe 内的桥直接调用宿主对象，
 * 不经过 postMessage：同步 API（如 getStorageSync）因此可以同步返回。
 */
type FrameKind = 'service' | 'webview';
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
 * 原生 API 注册表
 *
 * 处理函数返回结果对象（可以是 Promise）。结果能同步得到时同步回调——
 * 基础库在一些非 Sync 结尾的 API（如带 type 参数的 getSystemInfo）上也依赖同步回调。
 * 少数原生接口的结果是字符串，由基础库自己解析（如地图的 private_geolocation），原样交回。
 */

type ApiResult = Record<string, any>;
interface ApiContext {
    api: string;
    from: FrameKind;
    /** 发起调用的渲染层 id，逻辑层调用时为当前页面 */
    webviewId: number;
}
type ApiHandler = (args: any, context: ApiContext) => ApiResult | string | void | Promise<ApiResult | string | void>;

/**
 * setup：小程序启动前准备运行环境（@open-wxa/wxa-runner-core/setup）
 *
 * 浏览器里拿不到真实的登录 code、用户信息、定位等，setup 在 App.onLaunch 之前
 * 预置存储、覆盖原生 API、拦截请求，让小程序直接进入「已登录」之类的状态。
 *
 *   // wxa.setup.ts（放在项目根目录自动生效，或用 --setup 指定）
 *   import { defineSetup } from '@open-wxa/wxa-runner-core/setup';
 *
 *   export default defineSetup(({ env }) => ({
 *     storage: { token: env.WXA_TOKEN },
 *     mock: { login: { code: 'dev_code' } }
 *   }));
 *
 * 执行顺序固定为 storage → mock → network → run，每次打开或刷新页面都会重新执行。
 */

/** 启动命令所在环境中以 WXA_ 开头的环境变量 */
type SetupEnv = Record<string, string | undefined>;
interface SetupContext {
    env: SetupEnv;
}
/**
 * 原生 API 的替身：对象直接作为调用结果；函数按调用参数返回结果，抛错即调用失败（errMsg 为 `<api>:fail <message>`）
 */
type MockValue<T extends ApiResult = ApiResult> = T | ((args: any) => T | void | Promise<T | void>);
interface UserInfo {
    nickName: string;
    avatarUrl: string;
    gender: 0 | 1 | 2;
    country: string;
    province: string;
    city: string;
    language: string;
}
/** 常用 API 的返回值提示；其他 API 也可以按名字覆盖 */
interface KnownMocks {
    /** 业务后端通常要把 code 换成 token，可配合测试环境后端约定的固定 code */
    login: MockValue<{
        code: string;
    }>;
    checkSession: MockValue<{}>;
    getUserProfile: MockValue<{
        userInfo: Partial<UserInfo>;
        encryptedData?: string;
        iv?: string;
    }>;
    getUserInfo: MockValue<{
        userInfo: Partial<UserInfo>;
        encryptedData?: string;
        iv?: string;
    }>;
    getSetting: MockValue<{
        authSetting: Record<string, boolean>;
    }>;
    authorize: MockValue<{}>;
    getLocation: MockValue<{
        latitude: number;
        longitude: number;
        speed?: number;
        accuracy?: number;
    }>;
    chooseLocation: MockValue<{
        name: string;
        address: string;
        latitude: number;
        longitude: number;
    }>;
    scanCode: MockValue<{
        result: string;
        scanType?: string;
        charSet?: string;
        path?: string;
    }>;
    requestPayment: MockValue<{}>;
    requestSubscribeMessage: MockValue<Record<string, string>>;
}
type MockConfig = Partial<KnownMocks> & Record<string, MockValue>;
/** 小程序发出的 wx.request */
interface MockRequest {
    /** 完整地址；GET 请求的 data 已由基础库拼进查询参数 */
    url: string;
    /** 大写，如 POST */
    method: string;
    /** 请求头，基础库已补上默认的 content-type */
    header: Record<string, string>;
    /** 基础库序列化后交给原生层的请求体，通常是 JSON 字符串；业务传的是 ArrayBuffer 时原样是 ArrayBuffer */
    data: unknown;
}
interface MockResponse {
    /** 默认 200 */
    status?: number;
    header?: Record<string, string>;
    /**
     * 字符串原样返回；ArrayBuffer、Uint8Array 等（包括 Node 的 Buffer）按二进制返回；其他值按 JSON 返回。
     * 小程序拿到的 res.data 和真机一样按请求的 responseType：arraybuffer 时是 ArrayBuffer，否则是文本，JSON 文本再解析成对象
     */
    body?: unknown;
    /**
     * 模拟网络延迟（毫秒），默认 0。拦截的响应是瞬间返回的，比真机早到，
     * 可能暴露业务代码里依赖网络耗时的时序问题（如登录回调里假设首页已创建）
     */
    delay?: number;
}
type RouteHandler = MockResponse | ((request: MockRequest) => MockResponse | void | Promise<MockResponse | void>);
interface NetworkConfig {
    /**
     * 拦截 wx.request：key 写成 '[请求方法 ]地址'，如 'POST https://api.example.com/login'。
     * 地址里 * 匹配一段路径，** 匹配任意内容（可以不写域名），查询参数不参与匹配；没匹配上的请求照常发出
     */
    routes?: Record<string, RouteHandler>;
}
/** web-view 改写时提供的上下文 */
interface WebViewRewriteContext {
    /** web-view 所属页面，如 pages/index/index；页面已关闭时为 null */
    pagePath: string | null;
    /** web-view 所在渲染层的编号 */
    webviewId: number;
    /** 页面里 web-view 的 htmlId */
    htmlId: number;
}
/** 改写 web-view 的地址：返回字符串则替换，返回 undefined / 空串则保持原样 */
type WebViewUrlRewrite = (url: string, context: WebViewRewriteContext) => string | void;
interface WebViewConfig {
    /**
     * web-view 真正加载前改写地址，iframe 内嵌和新窗口两种模式都生效。
     * 典型用途：模拟器里给 H5 追加一个只在本机出现的标记
     */
    rewriteUrl?: WebViewUrlRewrite;
}
interface SetupConfig {
    /** 预置到 wx.setStorage 的数据，值保持原类型（对象、数字、Date 等），覆盖同名旧值 */
    storage?: Record<string, unknown>;
    /** 按 wx API 名覆盖原生实现，如 login、getLocation */
    mock?: MockConfig;
    network?: NetworkConfig;
    webView?: WebViewConfig;
    /** 声明式配置之后执行，适合异步或动态逻辑（如现场向测试后端换一个新 token） */
    run?(wxa: SetupApi): void | Promise<void>;
}
type SetupDefinition = SetupConfig | ((context: SetupContext) => SetupConfig | Promise<SetupConfig>);
/** run 里可用的能力，与声明式配置一一对应 */
interface SetupApi {
    env: SetupEnv;
    storage: {
        get(key: string): unknown;
        set(key: string, value: unknown): void;
        remove(key: string): void;
        /** 清空小程序的业务存储 */
        clear(): void;
    };
    mock<K extends string>(api: K, impl: K extends keyof KnownMocks ? NonNullable<KnownMocks[K]> : MockValue): void;
    /** 与 network.routes 相同，后添加的规则优先 */
    route(pattern: string, handler: RouteHandler): void;
    /** 与 webView.rewriteUrl 相同；多条规则按添加顺序依次执行，后添加的拿到前面的结果 */
    rewriteWebViewUrl(rewrite: WebViewUrlRewrite): void;
    /** 经开发服务器代理发请求，没有跨域限制 */
    fetch(url: string, init?: {
        method?: string;
        header?: Record<string, string>;
        body?: string;
    }): Promise<Response>;
}
/** 只用于获得类型提示，原样返回传入的配置 */
declare function defineSetup<T extends SetupDefinition>(setup: T): T;

export { type ApiContext as A, type DeviceProfile as D, type ForwardConsole as F, type KnownMocks as K, type MockConfig as M, type NetworkConfig as N, type RouteHandler as R, type SetupApi as S, type UserInfo as U, type WebViewConfig as W, type ApiHandler as a, type ApiResult as b, type AppInfo as c, type MockRequest as d, type MockResponse as e, type MockValue as f, type SetupConfig as g, type SetupContext as h, type SetupDefinition as i, type FrameKind as j, type SetupEnv as k, type WebViewRewriteContext as l, type WebViewUrlRewrite as m, defineSetup as n };
