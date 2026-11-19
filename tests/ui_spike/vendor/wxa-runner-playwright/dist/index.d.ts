import * as _playwright_test from '@playwright/test';
import { FrameLocator, Page } from '@playwright/test';
import { RecordedRequest, WxaTestApi, ApiResult, ApiContext, MockResponse, FrameError, DevServerOptions, DevServer } from '@open-wxa/wxa-runner-core';
export { WebViewInfo } from '@open-wxa/wxa-runner-core';

/** 小程序发出的一个 wx.request */
interface MiniProgramRequest extends RecordedRequest {
    /** 按 Content-Type 解析后的请求体：JSON 解析成对象，表单解析成 { 字段: 值 }，解析不了时同 data */
    body: any;
}

/**
 * miniProgram fixture：在 Node 里驱动浏览器中的 window.__wxa_test_api__
 *
 * mock、unmock、route、unroute 按调用顺序记在 Node 侧，页面每次加载时由 __wxa_before_launch__ 取回、
 * 在 setup 之后重放：打开页面前声明的在 App.onLaunch 里就生效，整页重新加载后状态与加载前一致。
 * 函数形式的 mock、route 留在 Node 里执行，浏览器经 page.exposeFunction 的通道按编号调用。
 */

type Remote<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
/** 原样转发给浏览器的测试 API，说明复用 WxaTestApi 的注释 */
type ForwardedApi = Remote<Pick<WxaTestApi, 'currentPage' | 'pageStack' | 'webViews' | 'waitForPage' | 'pageData' | 'callPageMethod' | 'navigateTo' | 'navigateBack' | 'redirectTo' | 'reLaunch' | 'switchTab' | 'getStorage' | 'clearStorage' | 'clearRequests'>>;
/** 在 Node 里执行的 mock：args 是小程序调用时传的参数（不含回调），返回调用结果 */
type MockHandler = (args: any, context: ApiContext) => ApiResult | void | Promise<ApiResult | void>;
/** 在 Node 里执行的拦截：按请求返回响应，不返回时为 200 空响应。request.routedBy 是这条规则 */
type RouteHandler = (request: MiniProgramRequest) => MockResponse | void | Promise<MockResponse | void>;
interface MiniProgram extends ForwardedApi {
    /** 当前页的渲染层，始终指向页面栈顶：跳转后不用重新获取 */
    readonly current: FrameLocator;
    /**
     * 打开小程序，等它启动完成。同一个用例里再次调用会整页重新加载，之前的 mock、route（包括撤销）仍然生效
     * @param url 启动页和参数，如 pages/detail/detail?id=1，开头的 / 可有可无；默认是首页
     * @throws 页面不在 app.json 里；编译失败、setup 或启动前声明的 mock、route 出错时，错误信息同模拟器上显示的
     */
    open(url?: string): Promise<void>;
    /**
     * 覆盖原生 API，同名的 setup mock 也被覆盖。打开页面前调用的，在 App.onLaunch 里就生效
     * @param api 与 wx 上的名字相同，如 login、getLocation
     * @param impl 对象作为调用结果。函数在 Node 里执行：能用用例里的变量、检查调用参数，
     *   但结果是异步返回的，参数和返回值要能序列化；函数抛错时这次调用失败，用例结束后也失败
     * @throws 基础库同步调用的 API（以 Sync 结尾的，以及 getSystemInfo、getMenuButtonBoundingClientRect）传了函数时；
     *   api 是 request 等 mock 不会生效的 API 时（请求用 route 拦截），打开页面前调用的在 open 时报错
     */
    mock(api: string, impl: ApiResult | MockHandler): Promise<void>;
    /** 撤销 mock，恢复内置实现；不传 api 时撤销全部，包括 setup 声明的。再次 open 后仍是撤销的 */
    unmock(api?: string): Promise<void>;
    /**
     * 拦截 wx.request：命中的请求不发往网络，直接返回给定的响应，后添加的规则优先。打开页面前调用的，在 App.onLaunch 里就生效
     * @param pattern '[请求方法 ]地址'，如 'POST https://api.example.com/login'；* 匹配一段路径，** 匹配任意内容（可以不写域名）
     * @param handler 响应 { status?, header?, body?, delay? }。或者在 Node 里执行、按请求返回响应的函数，
     *   函数抛错时请求失败，用例结束后也失败
     * @throws 规则写法不对时，打开页面前调用的在 open 时报错
     */
    route(pattern: string, handler: MockResponse | RouteHandler): Promise<void>;
    /** 删除按这个写法添加的拦截规则；不传时删除全部，包括 setup 声明的。已经发出的请求不受影响，再次 open 后仍是删除的 */
    unroute(pattern?: string): Promise<void>;
    /**
     * 小程序发出的 wx.request，按发出顺序，被拦截的和经代理转发的都有。每次打开页面从头记录，只保留最近 1000 个
     * @param pattern 只返回匹配的请求，写法同 route
     */
    requests(pattern?: string): Promise<MiniProgramRequest[]>;
    /**
     * 等到小程序发出匹配的请求，返回最近的一个。已经发出的也算：只关心某个操作之后的请求时，操作前先 clearRequests()
     * @param pattern 写法同 route
     * @param options.timeout 毫秒，默认 10000
     * @throws 超时，错误信息里列出已发出的请求
     */
    waitForRequest(pattern: string, options?: {
        timeout?: number;
    }): Promise<MiniProgramRequest>;
    /**
     * 逻辑层、渲染层的运行时错误，以及业务代码调用过的未实现 wx API（api 为 API 名称，每个 API 记一次），
     * 包括本用例里之前打开页面时出现的。用例结束时 fixture 会检查它为空（wxaCheckErrors）
     */
    errors(): Promise<FrameError[]>;
    /**
     * 当前页 web-view 打开的网页窗口，只在新窗口模式下可用（test.use({ wxaWebView: 'window' })）。
     * 网页窗口跟着所在页面走：跳到别的页面时关闭，返回时重新打开，之后要重新获取
     * @param options.index 当前页有多个 web-view 时取第几个，从 0 开始，顺序同 webViews()
     * @param options.timeout 等窗口打开的毫秒数，默认 10000
     * @throws 不是新窗口模式；当前页有多个 web-view 却没给 index；超时，错误信息里列出可能的原因
     */
    webView(options?: {
        index?: number;
        timeout?: number;
    }): Promise<Page>;
}

/** 开发服务器的其余参数，如 baseLibVersion、device、setup */
type WxaServerOptions = Omit<DevServerOptions, 'projectPath' | 'port' | 'host' | 'watch' | 'runtimeDir' | 'logger'>;

/** 在 playwright.config.ts 的 use 里配置，或在用例文件里用 test.use 修改 */
interface WxaOptions {
    /**
     * 小程序项目目录（project.config.json 所在目录）。相对路径基于 Playwright 配置文件所在目录，默认就是这个目录。
     * 每个 worker 启动一个开发服务器，所以只能在配置文件或用例文件顶层修改（test.use），修改后 Playwright 会换一个 worker
     */
    wxaProject: string;
    /** 开发服务器的其余参数，其中 setup 等路径也相对配置文件所在目录。同 wxaProject，只能在配置文件或用例文件顶层修改 */
    wxaServerOptions: WxaServerOptions;
    /** 用例结束时检查 errors() 为空，默认 true。有意触发运行时错误的用例用 test.use({ wxaCheckErrors: false }) 关掉 */
    wxaCheckErrors: boolean;
    /**
     * web-view 的网页怎么打开，默认 'iframe'：嵌在模拟器里，网页和模拟器域名不同时，SameSite 为 Lax、Strict 或没写的 Cookie 不生效。
     * 'window' 在新窗口里打开，网页是顶层页面，Cookie 能正常使用，用 miniProgram.webView() 拿到网页窗口。可以按用例修改
     */
    wxaWebView: 'iframe' | 'window';
}
interface WxaFixtures {
    /** 当前用例的小程序：每个用例一个新的浏览器上下文，Storage、页面栈互不影响 */
    miniProgram: MiniProgram;
}
interface WxaWorkerFixtures {
    /** 本 worker 的开发服务器，所有用例共用：编译只做一次 */
    wxaServer: DevServer;
}
declare const test: _playwright_test.TestType<_playwright_test.PlaywrightTestArgs & _playwright_test.PlaywrightTestOptions & WxaFixtures & Pick<WxaOptions, "wxaCheckErrors" | "wxaWebView">, _playwright_test.PlaywrightWorkerArgs & _playwright_test.PlaywrightWorkerOptions & WxaWorkerFixtures & Pick<WxaOptions, "wxaProject" | "wxaServerOptions">>;
declare const expect: _playwright_test.Expect<{
    toHavePath(this: _playwright_test.ExpectMatcherState, miniProgram: MiniProgram, path: string, options?: {
        timeout?: number;
    }): Promise<_playwright_test.MatcherReturnType>;
    toHavePageData(this: _playwright_test.ExpectMatcherState, miniProgram: MiniProgram, expected: Record<string, unknown>, options?: {
        path?: string;
        timeout?: number;
    }): Promise<_playwright_test.MatcherReturnType>;
}>;

export { type MiniProgram, type MiniProgramRequest, type MockHandler, type RouteHandler, type WxaFixtures, type WxaOptions, type WxaServerOptions, type WxaWorkerFixtures, expect, test };
