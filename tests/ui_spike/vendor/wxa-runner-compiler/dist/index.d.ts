/**
 * WXML 编译（wcc）
 *
 * 所有 wxml/wxs 一次性编译成一个 $gwx 函数，模板 import/include 和 wxs 引用由 wcc 自己解析。
 */
interface ComponentTags {
    /** 页面或组件路径，不带扩展名，如 "pages/index/index" */
    path: string;
    /** 该 wxml 中属于自定义组件（含抽象节点）的标签名 */
    tags: string[];
}
interface WxmlCompileOptions {
    /** 小程序根目录 */
    cwd: string;
    /** 相对 cwd 的 ./ 开头路径，包含 .wxml 和 .wxs */
    files: string[];
    components: ComponentTags[];
    /**
     * true：逻辑层使用的裁剪版（-xc），只保留组件结构信息；
     * false：渲染层使用的完整版（-cc）
     */
    cut: boolean;
    genfuncName?: string;
}
declare function compileWxml(options: WxmlCompileOptions): Promise<string>;

/**
 * WXSS 编译（wcsc）
 *
 * 输出是 "key=value=key=value" 交替的字符串，value 是转义过的 JS 源码：
 *   comm            公共运行时（setCssToHead、rpx 换算）以及非页面样式（app.wxss 等）的立即执行代码
 *   ./pages/a.wxss  每个页面/组件一个 setCssToHead(...)，返回的函数在页面创建时调用
 */
interface WxssCompileOptions {
    cwd: string;
    /** 页面和组件的 wxss，./ 开头 */
    pageFiles: string[];
    /** 其余样式（app.wxss），以公共样式形式写入 comm */
    commonFiles: string[];
}
interface WxssCompileResult {
    comm: string;
    /** 键为不带 ./ 的路径，如 "pages/index/index.wxss" */
    pages: Record<string, string>;
}
declare function compileWxss(options: WxssCompileOptions): Promise<WxssCompileResult>;
declare function parseWcscOutput(output: string): Record<string, string>;
declare function unescapeJsString(value: string): string;

/**
 * 定位 wcc / wcsc 可执行文件
 *
 * 使用开发者工具自带的命令行版本（node_modules/wcc-exec），而不是 wcc.node 原生模块：
 * 原生模块在 Node 进程里重复调用会随机触发 std::bad_alloc 崩溃，
 * 子进程方式则天然隔离，单次编译只需几毫秒。
 *
 * 没有开发者工具时（如 Linux、CI），用微信官方 npm 包 miniprogram-compiler 自带的编译器。
 * 它的编译内核较旧（20200413，开发者工具为 20211229）：页面的编译结果相同，
 * 只有模板运行时有少量差异，如旧版限制单页最多 16000 个节点。
 */
interface CompilerBinaries {
    wcc: string;
    wcsc: string;
}
declare function findCompilerBinaries(): CompilerBinaries;

export { type CompilerBinaries, type ComponentTags, type WxmlCompileOptions, type WxssCompileOptions, type WxssCompileResult, compileWxml, compileWxss, findCompilerBinaries, parseWcscOutput, unescapeJsString };
