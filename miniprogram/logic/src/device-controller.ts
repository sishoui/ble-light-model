// DeviceController：场景镜像、8 行状态、总开关、乐观更新与回滚（miniprogram.md §8）。
// 依赖 BleLink 与纯类型；不认识传输层。非 ready 时点击 no-op。

import { BleLink, CommandError, LinkState, Scene } from "./ble-link";
import { Unsubscribe } from "./transport";
import {
  RowView,
  ViewState,
  STRIP_COUNT,
  DEFAULT_ON_EFFECT_ID,
  DEFAULT_ON_PARAMS,
  allOnFromRows,
  emptyRowView,
} from "./view-state";

interface StripState {
  effectId: number;
  params: Uint8Array;
  /** 最近一次非关灯快照；仅收到 ACK 后更新（§8.1） */
  lastOn: { effectId: number; params: Uint8Array } | null;
}

export interface DeviceControllerOptions {
  link: BleLink;
}

/** NAK code → 页面文案（§7.2） */
export function nakText(code: number): string {
  switch (code) {
    case 0x01:
      return "数据校验失败";
    case 0x02:
      return "固件不支持该命令";
    case 0x03:
      return "固件不支持该灯效";
    case 0x04:
      return "固件版本不匹配";
    case 0x05:
      return "参数不合法";
    case 0x07:
      return "设备忙，请稍后";
    case 0x08:
      return "固件版本不支持";
    default:
      return "设备拒绝该命令";
  }
}

export function commandErrorText(err: unknown): string {
  if (err instanceof CommandError) {
    if (err.kind === "rejected" && err.nakError !== undefined) return nakText(err.nakError);
    if (err.kind === "timeout") return "设备无响应";
    return "链路已断开";
  }
  return "设备无响应";
}

export class DeviceController {
  private link: BleLink;
  private strips: StripState[] = [];
  private rows: RowView[] = [];
  private linkState: LinkState = "idle";
  private banner: string | null = null;
  private cbs: Array<(s: ViewState) => void> = [];
  private unsubs: Unsubscribe[] = [];
  private started = false;
  private sceneLoaded = false;

  constructor(opts: DeviceControllerOptions) {
    this.link = opts.link;
    for (let i = 0; i < STRIP_COUNT; i++) {
      this.strips.push({ effectId: 0, params: new Uint8Array(0), lastOn: null });
      this.rows.push(emptyRowView(i));
    }
    this.unsubs.push(this.link.onState((s) => this.onLinkState(s)));
    this.unsubs.push(this.link.onScene((scene) => this.onScene(scene)));
  }

  // -------------------------------------------------------------------------
  // 快照
  // -------------------------------------------------------------------------

  get state(): ViewState {
    return {
      link: this.linkState,
      banner: this.banner,
      allOn: allOnFromRows(this.rows),
      rows: this.rows.map((r) => ({ ...r, params: r.params.slice() })),
    };
  }

  onChange(cb: (s: ViewState) => void): Unsubscribe {
    this.cbs.push(cb);
    return () => {
      this.cbs = this.cbs.filter((x) => x !== cb);
    };
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.banner = "正在连接…";
    this.emit();
    await this.link.start();
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.link.stop();
  }

  async retry(): Promise<void> {
    await this.link.retry();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.cbs = [];
  }

  private onLinkState(s: LinkState): void {
    this.linkState = s;
    if (s === "ready") {
      // ready 后先 getScene() 覆盖，banner 由 scene 应用后清除（§8.2）
      this.sceneLoaded = false;
      this.getSceneAndApply();
    } else if (s === "reconnecting") {
      this.banner = "重连中…";
      // 进行中的命令全部回滚（§8.2）
      this.rollbackAllPending();
      this.emit();
    } else if (s === "failed") {
      this.banner = "重连失败";
      this.rollbackAllPending();
      this.emit();
    } else if (s === "connecting" || s === "scanning") {
      this.banner = "正在连接…";
      this.emit();
    } else if (s === "idle") {
      this.banner = null;
      this.emit();
    }
  }

  private async getSceneAndApply(): Promise<void> {
    try {
      const scene = await this.link.getScene();
      this.applyScene(scene);
      this.sceneLoaded = true;
      this.banner = null;
      this.emit();
    } catch {
      // GET_SCENE 失败：保持「重连中/正在连接」banner，等看门狗触发重连
      this.banner = this.linkState === "ready" ? "正在读取场景…" : this.banner;
      this.emit();
    }
  }

  private onScene(scene: Scene): void {
    // 主动 getScene 的应答也会走到这里；由 applyScene 覆盖
    if (!this.sceneLoaded) {
      this.applyScene(scene);
      this.sceneLoaded = true;
      this.banner = null;
      this.emit();
    }
  }

  private applyScene(scene: Scene): void {
    for (let i = 0; i < STRIP_COUNT; i++) {
      const entry = scene.strips[i];
      const effectId = entry ? entry.effectId : 0;
      const params = entry ? Uint8Array.from(entry.params) : new Uint8Array(0);
      this.strips[i].effectId = effectId;
      this.strips[i].params = params;
      // SCENE 里 effectId === 0 的条目 lastOn = null（§8.1）
      this.strips[i].lastOn = effectId === 0 ? null : { effectId, params: params.slice() };
      this.rows[i] = {
        strip: i,
        on: effectId !== 0,
        effectId,
        params: params.slice(),
        pending: false,
        error: null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  private get canInteract(): boolean {
    return this.linkState === "ready" && this.sceneLoaded;
  }

  /** 行内开关 */
  async toggleStrip(strip: number): Promise<void> {
    if (!this.canInteract) return;
    if (strip < 0 || strip >= STRIP_COUNT) return;
    const cur = this.strips[strip];
    const old = this.rows[strip];
    if (cur.effectId !== 0) {
      // 关灯：0x00，单 bit
      await this.commitStrip(strip, 0x00, new Uint8Array(0), old, 1 << strip);
    } else {
      // 开灯：lastOn ?? 默认静态白
      const target = cur.lastOn ?? { effectId: DEFAULT_ON_EFFECT_ID, params: Uint8Array.from(DEFAULT_ON_PARAMS) };
      await this.commitStrip(strip, target.effectId, target.params.slice(), old, 1 << strip);
    }
  }

  /** 参数页控件变化即时下发（§8.3） */
  async setStripEffect(strip: number, effectId: number, params: Uint8Array): Promise<void> {
    if (!this.canInteract) return;
    if (strip < 0 || strip >= STRIP_COUNT) return;
    const old = this.rows[strip];
    await this.commitStrip(strip, effectId, params.slice(), old, 1 << strip);
  }

  /** 总开关 */
  async setMaster(on: boolean): Promise<void> {
    if (!this.canInteract) return;
    const anyOn = allOnFromRows(this.rows);
    if (!on && anyOn) {
      // 全关：一帧 SET_EFFECT(0x00)、strip_mask = 0xFF
      const oldRows = this.rows.map((r) => ({ ...r, params: r.params.slice() }));
      for (let i = 0; i < STRIP_COUNT; i++) {
        this.rows[i] = { ...this.rows[i], on: false, effectId: 0, params: new Uint8Array(0), pending: true, error: null };
      }
      this.emit();
      try {
        await this.link.setEffect(0xff, 0x00, new Uint8Array(0));
        for (let i = 0; i < STRIP_COUNT; i++) {
          this.rows[i] = { ...this.rows[i], pending: false };
          this.strips[i].effectId = 0;
          this.strips[i].params = new Uint8Array(0);
          // 保留 lastOn（关灯不回退 lastOn）
        }
        this.emit();
      } catch (err) {
        // 回滚所有行
        this.rows = oldRows;
        for (const r of this.rows) {
          r.error = this.linkState === "ready" ? commandErrorText(err) : null;
        }
        this.emit();
      }
      return;
    }
    if (on && !anyOn) {
      // 全开：逐条一帧按 lastOn 恢复；某条失败只回滚该行，后续继续
      for (let i = 0; i < STRIP_COUNT; i++) {
        const cur = this.strips[i];
        const target = cur.lastOn ?? { effectId: DEFAULT_ON_EFFECT_ID, params: Uint8Array.from(DEFAULT_ON_PARAMS) };
        // 逐条串行；单条失败不影响后续
        // eslint-disable-next-line no-await-in-loop
        await this.commitStrip(i, target.effectId, target.params.slice(), this.rows[i], 1 << i);
      }
    }
  }

  /** 单条下发 + 乐观更新/回滚 */
  private async commitStrip(
    strip: number,
    effectId: number,
    params: Uint8Array,
    old: RowView,
    mask: number,
  ): Promise<void> {
    // 乐观应用
    this.rows[strip] = {
      strip,
      on: effectId !== 0,
      effectId,
      params: params.slice(),
      pending: true,
      error: null,
    };
    this.emit();
    try {
      await this.link.setEffect(mask, effectId, params);
      // ACK → pending=false，提交 lastOn
      this.strips[strip].effectId = effectId;
      this.strips[strip].params = params.slice();
      if (effectId !== 0) {
        this.strips[strip].lastOn = { effectId, params: params.slice() };
      }
      this.rows[strip] = { ...this.rows[strip], pending: false, error: null };
      this.emit();
    } catch (err) {
      // 回滚旧 RowView
      this.rows[strip] = { ...old, pending: false, error: commandErrorText(err) };
      this.emit();
    }
  }

  private rollbackAllPending(): void {
    // 断连时进行中的命令全部回滚（这里把 pending 行复位为已确认的 strips 状态）
    for (let i = 0; i < STRIP_COUNT; i++) {
      const r = this.rows[i];
      if (r.pending) {
        const cur = this.strips[i];
        this.rows[i] = {
          strip: i,
          on: cur.effectId !== 0,
          effectId: cur.effectId,
          params: cur.params.slice(),
          pending: false,
          error: null,
        };
      } else {
        this.rows[i] = { ...r, error: r.error };
      }
    }
  }

  private emit(): void {
    const snap = this.state;
    for (const cb of this.cbs) cb(snap);
  }
}