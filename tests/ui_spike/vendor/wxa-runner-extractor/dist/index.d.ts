/**
 * .wxvpkg 解包器
 *
 * 文件格式（大端序）：
 *   0      u8   0xBE 魔数
 *   1..12       保留字段（info、索引长度、数据长度）
 *   13     u8   0xED 索引起始标记
 *   14     u32  文件数量
 *   之后每个文件：u32 名称长度 + 名称(utf8) + u32 偏移 + u32 长度
 */
interface WxvpkgEntry {
    /** 包内路径，如 "/WAService.js" */
    name: string;
    offset: number;
    size: number;
}
declare function readWxvpkgIndex(buf: Buffer): WxvpkgEntry[];
declare function readWxvpkgFile(buf: Buffer, entry: WxvpkgEntry): Buffer;

/**
 * 定位本机微信开发者工具的安装目录和用户数据目录
 *
 * 基础库（WeappVendor/*.wxvpkg）、登录态在用户数据目录，编译器（wcc/wcsc）、行政区划数据在安装目录。
 * 两者都可以用环境变量覆盖，便于 CI 或非标准安装位置。
 */
/** 开发者工具放程序文件的目录（package.nw 或 app.asar.unpacked），编译器在里面的 node_modules/wcc-exec */
declare function findDevtoolsPackageDirs(): string[];
/**
 * 新版开发者工具（Electron）的命令行。新版把登录态加密存放，ticket 要通过命令行开启的自动化接口向正在运行的开发者工具要
 *
 * @returns 找到的第一个开发者工具是旧版（package.nw）或者没装时返回 null，ticket 照旧从 findDeveloperTicket 读
 */
declare function findElectronDevtoolsCli(): string | null;
declare const REGION_DATA_FILES: {
    districts: string;
    streets: string;
};
type RegionDataKind = keyof typeof REGION_DATA_FILES;
/**
 * 开发者工具自带的行政区划数据，picker 的地区选择器用它：districts 到区县三级，streets 到街道四级。
 * 旧版在 package.nw/js/libs 下，新版打包在 app.asar 里。找不到时返回 null
 */
declare function readRegionData(kind: RegionDataKind): Buffer | null;
/** 用户数据目录下各账号的目录（每个登录过的账号一个），里面有 WeappVendor、WeappLocalData 等 */
declare function findProfileDirs(): string[];
/** 用户数据目录下所有的 WeappVendor 目录 */
declare function findVendorDirs(): string[];
/**
 * 指定开发者 ticket 的环境变量，优先于开发者工具的登录态，用于 CI 等没有开发者工具的环境。
 * 不能用 WXA_ 前缀：WXA_ 前缀的变量会下发给浏览器里的 setup
 */
declare const TICKET_ENV = "WECHAT_DEV_TICKET";
interface DeveloperTicket {
    newticket: string;
    /** 毫秒时间戳；来自环境变量时没有 */
    expiredAt?: number;
}
/**
 * 开发者工具扫码登录后保存的开发者 ticket，向微信换取真实 wx.login code、手机号要用它
 *
 * 环境变量 WECHAT_DEV_TICKET 优先。多个账号都登录过时取过期时间最晚的；
 * 已过期的也会返回，由调用方提示用户刷新登录态。
 *
 * @returns 都没有登录过时返回 null
 * @throws 找不到可用的登录记录、且有登录数据文件读取失败时，消息里带出错的目录
 */
declare function findDeveloperTicket(profileDirs?: string[]): DeveloperTicket | null;

/**
 * 基础库版本选择与提取
 *
 * 基础库有两个来源：本机开发者工具下载的 .wxvpkg（用时解包到缓存目录），
 * 和内置基础库 @open-wxa/wxa-baselib（已解包，给没有开发者工具的 Linux / CI 用）。
 * 同一版本优先用开发者工具的，内置的只在开发者工具没有该版本时兜底。
 */
/**
 * 已验证的最高版本：不指定版本时只在这个范围里选，指定更高的版本照常运行，但会警告
 */
declare const MAX_COMPATIBLE_VERSION = "3.7.0";
/**
 * 从这个版本起，逻辑层分主上下文和子上下文：业务代码放进由原生 WeixinJSContext 创建的
 * 隔离上下文（3.8 起 WAService.js 只是占位），运行时按此切换加载方式，见 core/runtime/context.ts。
 * 与 MAX_COMPATIBLE_VERSION 无关：提高已验证的范围不改变某个版本的结构
 */
declare const ISOLATED_CONTEXT_SINCE = "3.7.1";
declare const DEFAULT_CACHE_DIR: string;
declare const BUNDLED_BASELIB_PACKAGE = "@open-wxa/wxa-baselib";
/** 开发者工具下载的基础库 */
interface InstalledBaseLib {
    source: 'devtools';
    version: string;
    /** .wxvpkg 文件，用时解包 */
    file: string;
    compatible: boolean;
}
interface ResolvedBaseLib {
    source: 'devtools' | 'bundled';
    version: string;
    /** 解包后的目录，包含 WAService.js / WAWebview.js 等 */
    dir: string;
    compatible: boolean;
}
/** 内置基础库里的一个版本，已经是解包后的目录 */
interface BundledBaseLib extends ResolvedBaseLib {
    source: 'bundled';
}
type BaseLib = InstalledBaseLib | BundledBaseLib;
declare function compareVersions(a: string, b: string): number;
declare function usesIsolatedContext(version: string): boolean;
declare function isCompatibleVersion(version: string): boolean;
/** 列出本机开发者工具下载过的所有基础库，版本从新到旧 */
declare function listInstalledBaseLibs(vendorDirs?: string[]): InstalledBaseLib[];
/** 内置基础库的安装目录；它是可选依赖，没装上时返回 null */
declare function findBundledBaseLibRoot(): string | null;
/**
 * 开发者工具和内置基础库里的所有版本，从新到旧；同一版本只列开发者工具的
 *
 * @param bundledRoot 内置基础库目录，下面每个版本一个子目录；为 null 时只列开发者工具的
 */
declare function listBaseLibs(vendorDirs?: string[], bundledRoot?: string | null): BaseLib[];
/**
 * 不指定版本时选择最新的兼容版本。
 * 指定了不兼容的版本也照常返回（compatible=false），由调用方决定是否警告。
 */
declare function selectBaseLib<T extends BaseLib>(libs: T[], version?: string): T;
/** 解包到缓存目录；已解包过的版本直接复用 */
declare function extractBaseLib(lib: InstalledBaseLib, cacheDir?: string): ResolvedBaseLib;
/** 没指定版本时用环境变量 WXA_BASELIB 指定的版本，如 WXA_BASELIB=3.8.8 pnpm test 在这个版本上跑全部测试 */
declare function resolveBaseLib(options?: {
    version?: string;
    cacheDir?: string;
}): ResolvedBaseLib;

export { BUNDLED_BASELIB_PACKAGE, type BaseLib, type BundledBaseLib, DEFAULT_CACHE_DIR, type DeveloperTicket, ISOLATED_CONTEXT_SINCE, type InstalledBaseLib, MAX_COMPATIBLE_VERSION, type RegionDataKind, type ResolvedBaseLib, TICKET_ENV, type WxvpkgEntry, compareVersions, extractBaseLib, findBundledBaseLibRoot, findDeveloperTicket, findDevtoolsPackageDirs, findElectronDevtoolsCli, findProfileDirs, findVendorDirs, isCompatibleVersion, listBaseLibs, listInstalledBaseLibs, readRegionData, readWxvpkgFile, readWxvpkgIndex, resolveBaseLib, selectBaseLib, usesIsolatedContext };
