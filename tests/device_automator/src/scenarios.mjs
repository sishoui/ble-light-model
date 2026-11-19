/**
 * 真机场景 1–6（spec §3.4 场景表，数据驱动）。
 *
 * 每个场景 = 步骤数组；步骤语义见 runner.mjs executeStep。共享的
 * connectPrelude() 做确定性前置（reLaunch → 扫描 → 连接 → HELLO → 基线全灭 →
 * GET_STATUS 校验），与 PC harness startup 同思路：不依赖上次 NVS 状态。
 *
 * 断言口径（spec §3.4）：
 * - page.data 只断公开 data；element.attribute 只断 disabled 等状态类；
 * - console 只断领域错误出现 / 不出现；
 * - COM6 事件级断言：seq 关联 + Δ 默认 500ms（DELTA），连接 / 重连放宽 5s（DELTA_CONN）；
 * - strip_mask / payload 本体不在固件 JSONL rx 事件里，由 STATUS active_effect 逐字段兜底；
 * - 灯带颜色只由人工看，不机器断言。
 *
 * 连跑门槛：场景 1 / 2 / 4 支持 --repeat 3（run.js），失败即停。
 */

import { readFileSync } from 'node:fs';

const EFFECT_TABLE = JSON.parse(readFileSync(new URL('../effects.json', import.meta.url), 'utf8'));
const EFFECTS = EFFECT_TABLE.effects;

/** 默认 Δ 上限（spec §3.4）。 */
export const DELTA = 500;
/** 连接 / 重连放宽档（spec §3.4）。 */
export const DELTA_CONN = 5000;

const RX_SET_EFFECT = (len) => ({ ev: 'rx', type: 2, flags: 1, len });
const RX_GET_STATUS = { ev: 'rx', type: 6, flags: 0, len: 0 };
const RX_SET_BRIGHTNESS = { ev: 'rx', type: 3, flags: 1, len: 1 };
const RX_UNLOCK = { ev: 'rx', type: 5, flags: 1, len: 1 };
const ACK_THEN = [{ ev: 'ack', seq: 'rx' }];

/**
 * 确定性前置（所有场景共享）：冷启动连接 + HELLO + 基线全灭 + GET_STATUS 校验。
 * 页面默认 selectedEffect=1（静态）、color=(255,0,0)，基线用“关灯 + 全选”。
 */
function connectPrelude() {
  return [
    { op: 'reLaunch', path: '/pages/index/index', desc: '重启页面（冷启动确定态）' },
    { op: 'waitPageData', expect: { state: 'idle', connected: false }, timeoutMs: 5000, desc: '页面就绪（未连接）' },
    { op: 'tap', selector: 'button.btn', desc: '点击“扫描设备”' },
    { op: 'waitPageData', expect: { scanning: true }, timeoutMs: 3000, desc: '扫描中' },
    { op: 'assertElement', selector: 'button.btn', attribute: 'disabled', state: 'disabled', desc: '扫描中：扫描按钮 disabled' },
    {
      op: 'waitPageData',
      expect: { scanning: false, devices: { __op: 'includes', value: { name: /BLELight-C3/ } } },
      timeoutMs: 8000,
      desc: '扫描完成：设备列表含 BLELight-C3',
    },
    { op: 'tap', selector: '.device', desc: '点击 C3 设备行（连接）' },
    {
      op: 'waitPageData',
      expect: { state: 'ready', connected: true, deviceName: /BLELight-C3/, stateText: '已就绪' },
      timeoutMs: 10000,
      desc: '连接完成：state=ready / deviceName',
    },
    { op: 'com6Wait', rx: { ev: 'gap', what: 'connect' }, deltaLimitMs: DELTA_CONN, timeoutMs: 8000, desc: 'COM6：gap connect 事件（连接阶段 Δ 放宽 5s）' },
    { op: 'notifyWait', type: 1, timeoutMs: 8000, desc: 'notify：HELLO（订阅后 C3 主动下发）' },
    { op: 'assertPageData', expect: { helloText: { __op: 'includes', value: '固件' } }, desc: 'page.data：HELLO 文案' },
    { op: 'assertElement', selector: 'button.btn--ghost', desc: '已连接：出现“断开”按钮' },
    { op: 'assertElement', selector: 'button.btn', attribute: 'disabled', state: 'disabled', desc: '已连接：扫描按钮 disabled' },
    { op: 'assertElement', selector: 'button.btn--primary', desc: '控制区已渲染（应用灯效按钮存在）' },
    // 基线：全选 + 全灭 + GET_STATUS 校验（不依赖上次 NVS 状态）
    { op: 'tap', selector: 'button[data-all="true"]', desc: '全选 8 路' },
    {
      op: 'waitPageData',
      expect: { mask: 255, allLanesSelected: true, maskText: { __op: 'includes', value: '全路' } },
      timeoutMs: 3000,
      desc: 'page.data：mask=0xFF',
    },
    { op: 'tap', selector: '.effect[data-index="0"]', desc: '选择“关灯”' },
    { op: 'tap', selector: 'button.btn--primary', desc: '应用灯效（全灭基线）' },
    {
      op: 'com6Exchange',
      rx: RX_SET_EFFECT(1),
      then: ACK_THEN,
      deltaLimitMs: DELTA_CONN,
      timeoutMs: 8000,
      desc: 'COM6：SET_EFFECT 关灯 rx + ACK（连接阶段放宽）',
    },
    { op: 'waitPageData', expect: { applying: false }, timeoutMs: 3000, desc: 'applying 回落' },
    { op: 'callMethod', method: 'onRefreshStatus', desc: '请求 STATUS' },
    {
      op: 'com6Exchange',
      rx: RX_GET_STATUS,
      then: [{ ev: 'status', seq: 'rx' }],
      timeoutMs: 5000,
      desc: 'COM6：GET_STATUS rx + STATUS 事件（seq 关联）',
    },
    {
      op: 'notifyWait',
      type: 9,
      anchor: 'prev',
      expectFields: { activeEffect: [0, 0, 0, 0, 0, 0, 0, 0] },
      timeoutMs: 5000,
      desc: 'notify：STATUS active_effect 全 0（基线生效，strip_mask 兜底）',
    },
    { op: 'consoleClean', desc: 'console 无未预期错误' },
  ];
}

/** 清空选择并只留 L0（mask=0x01），供单路效果步骤使用。 */
function selectLane0Steps() {
  return [
    { op: 'tap', selector: 'button[data-all="false"]', desc: '清空灯带选择' },
    { op: 'waitPageData', expect: { mask: 0, allLanesSelected: false }, timeoutMs: 3000, desc: 'page.data：mask=0' },
    { op: 'tap', selector: '.lane[data-index="0"]', desc: '选中 L0' },
    { op: 'waitPageData', expect: { mask: 1, maskText: { __op: 'includes', value: '0x01' } }, timeoutMs: 3000, desc: 'page.data：mask=0x01' },
  ];
}

/** 场景 2 主体：单路 × 7 效果 + 多路 mask + 亮度 0/100% 边界（含锁定 NAK 与解锁）。 */
function writeEffectsSteps() {
  const steps = [];
  for (const eff of EFFECTS) {
    const len = eff.payloadHex.length / 2;
    steps.push(
      ...selectLane0Steps(),
      { op: 'tap', selector: `.effect[data-index="${eff.index}"]`, desc: `选择“${eff.name}”` },
      {
        op: 'waitPageData',
        expect: { selectedEffect: eff.index, effectName: eff.name },
        timeoutMs: 3000,
        desc: `page.data：当前效果=${eff.name}`,
      },
      { op: 'tap', selector: 'button.btn--primary', desc: `应用“${eff.name}”（mask 0x01）` },
      {
        op: 'com6Exchange',
        rx: RX_SET_EFFECT(len),
        then: ACK_THEN,
        timeoutMs: 5000,
        desc: `COM6：SET_EFFECT ${eff.name} rx(type=0x02 flags=1 len=${len}) + ACK（Δ<500ms）`,
      },
      { op: 'waitPageData', expect: { applying: false }, timeoutMs: 3000, desc: 'applying 回落' },
      { op: 'callMethod', method: 'onRefreshStatus', desc: '请求 STATUS' },
      {
        op: 'com6Exchange',
        rx: RX_GET_STATUS,
        then: [{ ev: 'status', seq: 'rx' }],
        timeoutMs: 5000,
        desc: 'COM6：GET_STATUS rx + STATUS 事件',
      },
      {
        op: 'notifyWait',
        type: 9,
        anchor: 'prev',
        expectFields: { activeEffect: [eff.effectId, 0, 0, 0, 0, 0, 0, 0] },
        timeoutMs: 5000,
        desc: `notify：STATUS active_effect[0]=0x${eff.effectId.toString(16).padStart(2, '0')}（${eff.name} + mask 逐字段兜底）`,
      },
    );
  }
  // 多路 strip_mask
  steps.push(
    { op: 'tap', selector: 'button[data-all="false"]', desc: '清空灯带选择' },
    { op: 'tap', selector: '.lane[data-index="0"]', desc: '选中 L0' },
    { op: 'tap', selector: '.lane[data-index="1"]', desc: '选中 L1' },
    { op: 'tap', selector: '.lane[data-index="2"]', desc: '选中 L2' },
    {
      op: 'waitPageData',
      expect: { mask: 7, maskText: { __op: 'includes', value: '0x07' } },
      timeoutMs: 3000,
      desc: 'page.data：mask=0x07（三路）',
    },
    { op: 'tap', selector: '.effect[data-index="1"]', desc: '选择“静态”' },
    { op: 'tap', selector: 'button.btn--primary', desc: '应用“静态”（mask 0x07）' },
    {
      op: 'com6Exchange',
      rx: RX_SET_EFFECT(4),
      then: ACK_THEN,
      timeoutMs: 5000,
      desc: 'COM6：SET_EFFECT 静态 rx(len=4) + ACK',
    },
    { op: 'callMethod', method: 'onRefreshStatus', desc: '请求 STATUS' },
    {
      op: 'com6Exchange',
      rx: RX_GET_STATUS,
      then: [{ ev: 'status', seq: 'rx' }],
      timeoutMs: 5000,
      desc: 'COM6：GET_STATUS rx + STATUS 事件',
    },
    {
      op: 'notifyWait',
      type: 9,
      anchor: 'prev',
      expectFields: { activeEffect: [1, 1, 1, 0, 0, 0, 0, 0] },
      timeoutMs: 5000,
      desc: 'notify：STATUS active_effect=[1,1,1,0,…]（多路 mask 逐字段兜底）',
    },
  );
  // 亮度边界：0（ACK）/ 100%（锁定 → NAK 0x06）/ 解锁 → 100%（ACK）
  steps.push(
    { op: 'callMethod', method: 'onBrightness', args: [{ detail: { value: 0 } }], desc: '亮度滑条 → 0' },
    { op: 'waitPageData', expect: { brightness: 0 }, timeoutMs: 3000, desc: 'page.data：brightness=0' },
    { op: 'callMethod', method: 'onApplyBrightness', desc: '应用亮度 0' },
    {
      op: 'com6Exchange',
      rx: RX_SET_BRIGHTNESS,
      then: ACK_THEN,
      timeoutMs: 5000,
      desc: 'COM6：SET_BRIGHTNESS 0 rx(type=0x03 flags=1 len=1) + ACK',
    },
    { op: 'callMethod', method: 'onBrightness', args: [{ detail: { value: 255 } }], desc: '亮度滑条 → 255（100%）' },
    { op: 'waitPageData', expect: { brightness: 255 }, timeoutMs: 3000, desc: 'page.data：brightness=255' },
    { op: 'callMethod', method: 'onApplyBrightness', desc: '应用亮度 255（锁定态）' },
    {
      op: 'com6Exchange',
      rx: RX_SET_BRIGHTNESS,
      then: [{ ev: 'nak', seq: 'rx', err: 6 }],
      timeoutMs: 5000,
      desc: 'COM6：SET_BRIGHTNESS 255 rx + NAK 0x06（超 50% 需解锁）',
    },
    {
      op: 'waitPageData',
      expect: { log: { __op: 'includes', value: '需满功率解锁' } },
      timeoutMs: 3000,
      desc: 'page.data：领域错误提示（需满功率解锁）',
    },
    { op: 'callMethod', method: 'onToggleUnlock', args: [{ detail: { value: true } }], desc: '满功率解锁' },
    {
      op: 'com6Exchange',
      rx: RX_UNLOCK,
      then: ACK_THEN,
      timeoutMs: 5000,
      desc: 'COM6：UNLOCK_FULL_POWER rx(type=0x05 flags=1 len=1) + ACK',
    },
    {
      op: 'waitPageData',
      expect: { fullPowerUnlocked: true },
      timeoutMs: 3000,
      desc: 'page.data：fullPowerUnlocked=true',
    },
    { op: 'callMethod', method: 'onApplyBrightness', desc: '应用亮度 255（已解锁）' },
    {
      op: 'com6Exchange',
      rx: RX_SET_BRIGHTNESS,
      then: ACK_THEN,
      timeoutMs: 5000,
      desc: 'COM6：SET_BRIGHTNESS 255 rx + ACK（解锁后放行）',
    },
    { op: 'callMethod', method: 'onRefreshStatus', desc: '请求 STATUS' },
    {
      op: 'com6Exchange',
      rx: RX_GET_STATUS,
      then: [{ ev: 'status', seq: 'rx' }],
      timeoutMs: 5000,
      desc: 'COM6：GET_STATUS rx + STATUS 事件',
    },
    {
      op: 'notifyWait',
      type: 9,
      anchor: 'prev',
      expectFields: { brightness: 255 },
      timeoutMs: 5000,
      desc: 'notify：STATUS brightness=255（亮度边界生效）',
    },
    { op: 'consoleClean', desc: 'console 无未预期错误' },
  );
  return steps;
}

/** 场景 3 主体：周期 STATUS → 页面状态跟随。 */
function statusRefreshSteps() {
  return [
    {
      op: 'com6Count',
      rx: { ev: 'status' },
      anchor: 'self',
      withinMs: 8000,
      gte: 2,
      desc: 'COM6：8s 内 ≥2 条周期 STATUS 事件（内容与周期）',
    },
    {
      op: 'notifyCount',
      rx: { type: 9 },
      anchor: 'self',
      withinMs: 8000,
      gte: 2,
      desc: 'notify：8s 内 ≥2 条 STATUS 帧',
    },
    { op: 'assertPageStatusMatchesNotify', timeoutMs: 3000, desc: 'page.data.status 与最新 notify STATUS 一致' },
    { op: 'callMethod', method: 'onBrightness', args: [{ detail: { value: 0 } }], desc: '亮度滑条 → 0' },
    { op: 'waitPageData', expect: { brightness: 0 }, timeoutMs: 3000, desc: 'page.data：brightness=0' },
    { op: 'callMethod', method: 'onApplyBrightness', desc: '应用亮度 0' },
    {
      op: 'com6Exchange',
      rx: RX_SET_BRIGHTNESS,
      then: ACK_THEN,
      timeoutMs: 5000,
      desc: 'COM6：SET_BRIGHTNESS 0 rx + ACK',
    },
    { op: 'callMethod', method: 'onRefreshStatus', desc: '请求 STATUS' },
    {
      op: 'com6Exchange',
      rx: RX_GET_STATUS,
      then: [{ ev: 'status', seq: 'rx' }],
      timeoutMs: 5000,
      desc: 'COM6：GET_STATUS rx + STATUS 事件',
    },
    {
      op: 'notifyWait',
      type: 9,
      anchor: 'prev',
      expectFields: { brightness: 0 },
      timeoutMs: 6000,
      desc: 'notify：STATUS brightness=0（C3 周期 STATUS 跟随）',
    },
    { op: 'assertPageStatusMatchesNotify', timeoutMs: 3000, desc: 'page.data.status 跟随最新 notify STATUS（brightness=0）' },
    { op: 'consoleClean', desc: 'console 无未预期错误' },
  ];
}

/** 场景 4 主体：被动断连 + 重连（手机蓝牙关 → 开，含人工操作点）。 */
function disconnectReconnectSteps() {
  return [
    {
      op: 'human',
      instruction: '请现在关闭手机蓝牙（通知栏下拉 → 蓝牙），关好后按回车',
    },
    {
      op: 'waitPageData',
      expect: { state: { __op: 'oneOf', values: ['reconnecting', 'fault'] } },
      timeoutMs: 5000,
      desc: '5s 内进入 fault / 未连接态（spec §3.4）',
    },
    {
      op: 'com6Wait',
      rx: { ev: 'gap', what: 'disconnect' },
      deltaLimitMs: DELTA_CONN,
      timeoutMs: 8000,
      desc: 'COM6：gap disconnect 事件（断连日志）',
    },
    {
      op: 'human',
      instruction: '请打开手机蓝牙，然后按回车',
    },
    { op: 'tap', selector: '.device', desc: '点击设备行（触发重连：fault/reconnecting 态允许）' },
    {
      op: 'waitPageData',
      expect: { state: 'ready', connected: true },
      timeoutMs: 10000,
      desc: '重连后 ready',
    },
    {
      op: 'com6Wait',
      rx: { ev: 'gap', what: 'connect' },
      deltaLimitMs: DELTA_CONN,
      timeoutMs: 8000,
      desc: 'COM6：gap connect 事件（重连后连接事件，Δ 放宽 5s）',
    },
    { op: 'notifyWait', type: 1, anchor: 'prev', deltaLimitMs: DELTA_CONN, timeoutMs: 5000, desc: 'notify：重连后 HELLO（连接阶段口径）' },
    { op: 'assertPageData', expect: { stateText: '已就绪' }, desc: 'page.data：状态文案已就绪' },
    { op: 'consoleClean', desc: 'console 无未预期错误' },
  ];
}

/** 场景 5 主体：后台恢复（onHide 短 / 长；onShow 后 ready、无重复连接风暴）。 */
function backgroundResumeSteps() {
  return [
    {
      op: 'human',
      instruction: '短后台：按 Home / 上滑把小程序切到后台，约 5 秒后切回，再回电脑按回车',
    },
    {
      op: 'com6Count',
      rx: { ev: 'gap', what: 'connect' },
      anchor: 'prev',
      withinMs: 3000,
      equals: 0,
      desc: '短后台无重连（ready 连接保留）',
    },
    { op: 'waitPageData', expect: { state: 'ready' }, timeoutMs: 10000, desc: '短后台切回：ready' },
    {
      op: 'human',
      instruction: '长后台：再按 Home 切后台，停留约 30 秒（别锁屏太久以免系统杀小程序），切回后按回车',
    },
    { op: 'waitPageData', expect: { state: 'ready' }, timeoutMs: 15000, desc: '长后台切回：ready（onShow 校验 / 重连）' },
    {
      op: 'com6Count',
      rx: { ev: 'gap', what: 'connect' },
      anchor: 'prev',
      withinMs: 45000,
      lte: 1,
      desc: '无重复连接风暴（至多 1 次重连）',
    },
    // 恢复后链路可用
    { op: 'tap', selector: '.lane[data-index="0"]', desc: '选中 L0' },
    { op: 'waitPageData', expect: { mask: 1 }, timeoutMs: 3000, desc: 'page.data：mask=0x01' },
    { op: 'tap', selector: 'button.btn--primary', desc: '应用灯效（静态，恢复后可用性）' },
    {
      op: 'com6Exchange',
      rx: RX_SET_EFFECT(4),
      then: ACK_THEN,
      timeoutMs: 5000,
      desc: 'COM6：SET_EFFECT 静态 rx + ACK（恢复后可写）',
    },
    { op: 'callMethod', method: 'onRefreshStatus', desc: '请求 STATUS' },
    {
      op: 'com6Exchange',
      rx: RX_GET_STATUS,
      then: [{ ev: 'status', seq: 'rx' }],
      timeoutMs: 5000,
      desc: 'COM6：GET_STATUS rx + STATUS 事件',
    },
    {
      op: 'notifyWait',
      type: 9,
      anchor: 'prev',
      expectFields: { activeEffect: [1, 0, 0, 0, 0, 0, 0, 0] },
      timeoutMs: 5000,
      desc: 'notify：STATUS active_effect[0]=1（恢复后灯效生效）',
    },
    { op: 'consoleClean', desc: 'console 无未预期错误' },
  ];
}

/** 场景 6 主体：失败路径（C3 断电 / 写无 ACK → 3s 超时、不重试；恢复后重连）。 */
function failurePathSteps() {
  return [
    { op: 'tap', selector: 'button[data-all="false"]', desc: '清空灯带选择' },
    { op: 'tap', selector: '.lane[data-index="0"]', desc: '选中 L0' },
    { op: 'waitPageData', expect: { mask: 1 }, timeoutMs: 3000, desc: 'page.data：mask=0x01' },
    {
      op: 'human',
      instruction: '请断开 C3 电源（拔 USB 线或关电源开关），然后按回车',
    },
    { op: 'tap', selector: 'button.btn--primary', desc: '应用灯效（静态，C3 断电 → 写无 ACK）' },
    {
      op: 'waitPageData',
      expect: { applying: false, log: { __op: 'includes', value: '超时' } },
      timeoutMs: 3000,
      desc: '3s 内 TimeoutError（LightService ACK 超时 500ms）',
    },
    {
      op: 'com6Absent',
      rx: { ev: 'ack' },
      anchor: 'prev',
      withinMs: 3000,
      desc: 'COM6：无 ACK（C3 断电）',
    },
    {
      op: 'com6Count',
      rx: { ev: 'rx' },
      anchor: 'prev',
      withinMs: 3000,
      equals: 0,
      desc: 'COM6：无 rx / 无重试帧（失败仅一次，不自动重试）',
    },
    {
      op: 'assertPageData',
      expect: { log: { __op: 'includes', value: '应用灯效失败' } },
      desc: 'page.data：领域错误（应用灯效失败）',
    },
    {
      op: 'waitPageData',
      expect: { state: { __op: 'oneOf', values: ['reconnecting', 'fault'] } },
      timeoutMs: 45000,
      desc: '链路丢失（监督超时）→ reconnecting / fault',
    },
    {
      op: 'human',
      instruction: '请恢复 C3 供电，等 C3 启动完成（约 2 秒），然后按回车',
    },
    { op: 'tap', selector: '.device', desc: '点击设备行（恢复后重连）' },
    {
      op: 'waitPageData',
      expect: { state: 'ready', connected: true },
      timeoutMs: 15000,
      desc: '恢复后重连 ready',
    },
    {
      op: 'com6Wait',
      rx: { ev: 'gap', what: 'connect' },
      deltaLimitMs: DELTA_CONN,
      timeoutMs: 8000,
      desc: 'COM6：gap connect 事件（恢复后重连，Δ 放宽 5s）',
    },
    { op: 'notifyWait', type: 1, anchor: 'prev', deltaLimitMs: DELTA_CONN, timeoutMs: 5000, desc: 'notify：恢复后 HELLO（连接阶段口径）' },
    { op: 'tap', selector: 'button.btn--primary', desc: '应用灯效（恢复后可用性）' },
    {
      op: 'com6Exchange',
      rx: RX_SET_EFFECT(4),
      then: ACK_THEN,
      timeoutMs: 5000,
      desc: 'COM6：SET_EFFECT 静态 rx + ACK（恢复后可写）',
    },
    { op: 'consoleClean', desc: 'console 无未预期错误' },
  ];
}

export const SCENARIOS = [
  {
    id: 'cold_start',
    title: '① 冷启动连接',
    gate: true, // 连跑门槛：--repeat 3
    description: '扫描 → 连接 → 发现 → 订阅 → HELLO + 基线；page.data 连接态 / 设备名 / 按钮 disabled；COM6 HELLO / ACK / 首条 STATUS',
    steps: connectPrelude(),
  },
  {
    id: 'write_effects',
    title: '② 写灯效',
    gate: true,
    description: '单 / 多 strip_mask × 7 种效果 + 亮度 0/100% 边界（含锁定 NAK 与解锁）；COM6 rx 逐字段 + ACK；STATUS active_effect 逐字段兜底',
    steps: [...connectPrelude(), ...writeEffectsSteps()],
  },
  {
    id: 'status_refresh',
    title: '③ 通知刷新',
    gate: false,
    description: 'C3 周期 STATUS → page.data 状态跟随；COM6 STATUS 内容与周期；亮度变化经周期 STATUS 反映',
    steps: [...connectPrelude(), ...statusRefreshSteps()],
  },
  {
    id: 'disconnect_reconnect',
    title: '④ 被动断连 + 重连',
    gate: true,
    description: '手机蓝牙关 → 开；5s 内 fault / 未连接态；重连后 ready；COM6 gap disconnect / connect + 重连 HELLO',
    steps: [...connectPrelude(), ...disconnectReconnectSteps()],
  },
  {
    id: 'background_resume',
    title: '⑤ 后台恢复',
    gate: false,
    description: 'onHide 短 / 长两种；onShow 后 ready；无重复连接风暴（gap connect ≤ 1）；恢复后可写',
    steps: [...connectPrelude(), ...backgroundResumeSteps()],
  },
  {
    id: 'failure_path',
    title: '⑥ 失败路径',
    gate: false,
    description: 'C3 断电 / 写无 ACK → 3s 超时 TimeoutError、不自动重试；COM6 无 ACK / 无重试帧；恢复供电后重连可用',
    steps: [...connectPrelude(), ...failurePathSteps()],
  },
];

export function getScenario(id) {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

export function listScenarios() {
  return SCENARIOS.map((s) => ({ id: s.id, title: s.title, gate: s.gate, steps: s.steps.length }));
}