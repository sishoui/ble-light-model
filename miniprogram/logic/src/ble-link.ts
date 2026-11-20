// BleLink：连接状态机 + 命令会话（miniprogram.md §6）。
// 不认识灯效语义；SET_EFFECT 参数由 DeviceController 按 protocol.md §6 编码。
// 计时全部走注入 Clock（单测用假时钟推进，不真等）。逻辑层无 wx / setTimeout。

import { Transport, TransportError, Unsubscribe } from "./transport";
import { Clock, Timers } from "./clock";
import { Feeder, Type, FeedEvent, encode } from "./codec";

export type LinkState = "idle" | "scanning" | "connecting" | "ready" | "reconnecting" | "failed";

export interface HelloCaps {
  version: number;
  fw: { major: number; minor: number; patch: number };
  stripCount: number;
  ledsPerStrip: number;
  caps: number;
  effectBitmap: Uint8Array;
}

export interface Status {
  uptimeS: number;
  glitchCount: number;
  dropCount: number;
  stripFault: number;
  activeEffect: number[];
}

export interface SceneStrip {
  effectId: number;
  params: number[];
}

export interface Scene {
  strips: SceneStrip[];
}

export type CommandErrorKind = "rejected" | "timeout" | "link-failed";

export class CommandError extends Error {
  readonly kind: CommandErrorKind;
  readonly nakError?: number;
  constructor(kind: CommandErrorKind, message: string, nakError?: number) {
    super(message);
    this.name = "CommandError";
    this.kind = kind;
    this.nakError = nakError;
  }
}

export interface BleLinkOptions {
  transport: Transport;
  clock: Clock & Timers;
  filter: { serviceUuid: string; namePrefix?: string };
  reconnectDelays?: number[]; // 默认 [500, 1000, 2000]
  halfFrameTimeoutMs?: number;
}

const DEFAULT_RECONNECT_DELAYS = [500, 1000, 2000];
const ACK_TIMEOUT_MS = 500;
const ACK_MAX_RETRIES = 3;
const QUERY_TIMEOUT_MS = 1000;
const PACKET_TIMEOUT_MS = 3000;
const HELLO_TIMEOUT_MS = 1500;
const SCAN_TIMEOUT_MS = 8000;
const WATCHDOG_MS = 10000;
const FALLBACK_PACKET_SIZE = 20;

export class BleLink {
  private transport: Transport;
  private clock: Clock & Timers;
  private filter: { serviceUuid: string; namePrefix?: string };
  private reconnectDelays: number[];

  private _state: LinkState = "idle";
  private _caps: HelloCaps | null = null;

  private feeder: Feeder;
  private notifyUnsub: Unsubscribe | null = null;
  private disconnUnsub: Unsubscribe | null = null;
  private deviceFoundUnsub: Unsubscribe | null = null;
  private scanTimer: unknown = null;
  private helloTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private reconnectAttempts = 0;
  private matchedDevice: { deviceId: string; name: string } | null = null;
  private bestRssi = -Infinity;

  private stateCbs: Array<(s: LinkState) => void> = [];
  private statusCbs: Array<(s: Status) => void> = [];
  private sceneCbs: Array<(s: Scene) => void> = [];

  // 命令会话
  private busy = false;
  private pendingQueue: Array<{ run: () => Promise<void> }> = [];
  private inFlightSeq: number | null = null;
  private ackTimer: unknown = null;
  private ackAttempts = 0;
  private pendingAckHandler: ((seq: number) => void) | null = null;
  private pendingNakHandler: ((seq: number, err: number) => void) | null = null;

  private pendingQuery: {
    kind: "status" | "scene";
    seq: number;
    resolve: (v: Status | Scene) => void;
    reject: (e: Error) => void;
    timer: unknown;
  } | null = null;

  private txSeq = 0;

  constructor(opts: BleLinkOptions) {
    this.transport = opts.transport;
    this.clock = opts.clock;
    this.filter = opts.filter;
    this.reconnectDelays = opts.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS.slice();
    this.feeder = new Feeder({ halfFrameTimeoutMs: opts.halfFrameTimeoutMs ?? 200 });
  }

  get state(): LinkState {
    return this._state;
  }

  get caps(): HelloCaps | null {
    return this._caps;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._state === "ready") return;
    this.ensureSubscriptions();
    this._setState("scanning");
    this.startScanning();
  }

  async stop(): Promise<void> {
    this.clearAllTimers();
    this.pendingQueue = [];
    this.busy = false;
    this.feeder.reset();
    this._caps = null;
    await this.safeDisconnect();
    this._setState("idle");
  }

  async retry(): Promise<void> {
    if (this._state !== "failed") return;
    this.ensureSubscriptions();
    this._setState("scanning");
    this.startScanning();
  }

  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------

  async setEffect(stripMask: number, effectId: number, params: Uint8Array): Promise<void> {
    if (this._state !== "ready") throw new CommandError("link-failed", "not ready");
    const frame = encode({
      type: Type.SET_EFFECT,
      seq: this.nextSeq(),
      flags: 1,
      stripMask,
      payload: [effectId, ...Array.from(params)],
    });
    await this.sendFrame(frame);
  }

  getStatus(): Promise<Status> {
    if (this._state !== "ready") return Promise.reject(new CommandError("link-failed", "not ready"));
    return this.query(Type.GET_STATUS, "status") as Promise<Status>;
  }

  getScene(): Promise<Scene> {
    if (this._state !== "ready") return Promise.reject(new CommandError("link-failed", "not ready"));
    return this.query(Type.GET_SCENE, "scene") as Promise<Scene>;
  }

  onState(cb: (s: LinkState) => void): Unsubscribe {
    this.stateCbs.push(cb);
    return () => {
      this.stateCbs = this.stateCbs.filter((x) => x !== cb);
    };
  }

  onStatus(cb: (s: Status) => void): Unsubscribe {
    this.statusCbs.push(cb);
    return () => {
      this.statusCbs = this.statusCbs.filter((x) => x !== cb);
    };
  }

  onScene(cb: (s: Scene) => void): Unsubscribe {
    this.sceneCbs.push(cb);
    return () => {
      this.sceneCbs = this.sceneCbs.filter((x) => x !== cb);
    };
  }

  // -------------------------------------------------------------------------
  // 扫描与连接
  // -------------------------------------------------------------------------

  private startScanning(): void {
    this.transport.startScan(this.filter);
    this.matchedDevice = null;
    this.bestRssi = -Infinity;
    // 订阅设备发现（扫描阶段）；多个候选取 RSSI 最强者
    if (!this.deviceFoundUnsub) {
      this.deviceFoundUnsub = this.transport.onDeviceFound((adv) => this.onDeviceFound(adv));
    }
    // 8s 无匹配 → failed（扫描阶段）
    this.scanTimer = this.clock.setTimer(() => {
      if (this._state === "scanning" && !this.matchedDevice) {
        this.fail("scan timeout: no device matched");
      }
    }, SCAN_TIMEOUT_MS);
  }

  private onDeviceFound(adv: { deviceId: string; name: string; rssi: number }): void {
    if (this._state !== "scanning") return;
    // 按 namePrefix 过滤（由 transport 已过滤，这里再确认）
    if (this.filter.namePrefix && !adv.name.startsWith(this.filter.namePrefix)) return;
    // 多个候选取 RSSI 最强者
    if (this.matchedDevice === null || adv.rssi > this.bestRssi) {
      this.matchedDevice = { deviceId: adv.deviceId, name: adv.name };
      this.bestRssi = adv.rssi;
    }
    // 一旦有匹配即开始连接
    if (this.matchedDevice) {
      void this.startConnecting(this.matchedDevice);
    }
  }

  private ensureSubscriptions(): void {
    if (!this.notifyUnsub) {
      this.notifyUnsub = this.transport.onNotify((chunk) => this.onNotifyChunk(chunk));
    }
    if (!this.disconnUnsub) {
      this.disconnUnsub = this.transport.onDisconnect((err) => this.onUnexpectedDisconnect(err));
    }
  }

  private onNotifyChunk(chunk: Uint8Array): void {
    const now = this.clock.now();
    const events = this.feeder.feed(chunk, now);
    this.armWatchdog();
    for (const ev of events) {
      this.onFeedEvent(ev, now);
    }
  }

  private armWatchdog(): void {
    if (this._state !== "ready" && this._state !== "connecting" && this._state !== "reconnecting") return;
    if (this.watchdogTimer !== null) this.clock.clearTimer(this.watchdogTimer);
    this.watchdogTimer = this.clock.setTimer(() => {
      if (this._state === "ready") {
        this.goReconnecting(new TransportError("timeout", "watchdog: no frame for 10s"));
      }
    }, WATCHDOG_MS);
  }

  private onFeedEvent(ev: FeedEvent, _now: number): void {
    switch (ev.kind) {
      case "frame": {
        const f = ev.frame;
        if (f.type === Type.HELLO) {
          this.onHello(f.payload, f.ver);
        } else if (f.type === Type.STATUS) {
          const status = parseStatus(f.payload);
          this.resolveQuery("status", status);
          this.emitStatus(status);
        } else if (f.type === Type.SCENE) {
          const scene = parseScene(f.payload);
          this.resolveQuery("scene", scene);
          this.emitScene(scene);
        } else if (f.type === Type.ACK) {
          const ackSeq = (f.payload[0] ?? 0) | ((f.payload[1] ?? 0) << 8);
          this.onAck(ackSeq);
        } else if (f.type === Type.NAK) {
          const nakSeq = (f.payload[0] ?? 0) | ((f.payload[1] ?? 0) << 8);
          const err = f.payload[2] ?? 0;
          this.onNak(nakSeq, err);
        }
        break;
      }
      default:
        break;
    }
  }

  private onHello(payload: number[], ver: number): void {
    this._caps = parseHello(payload, ver);
    if (this._state === "connecting" || this._state === "reconnecting") {
      if (this.helloTimer !== null) this.clock.clearTimer(this.helloTimer);
      this.helloTimer = null;
      this._setState("ready");
      this.armWatchdog();
      this.drainQueue();
    }
  }

  private async startConnecting(device: { deviceId: string; name: string }): Promise<void> {
    this._setState("connecting");
    if (this.scanTimer !== null) this.clock.clearTimer(this.scanTimer);
    this.scanTimer = null;
    this.transport.stopScan();
    this.ensureSubscriptions();
    this.helloTimer = this.clock.setTimer(() => {
      if (this._state === "connecting") {
        if (this.reconnectAttempts > 0) {
          this.onReconnectAttemptFailed();
        } else {
          this.fail("HELLO timeout");
        }
      }
    }, HELLO_TIMEOUT_MS);
    try {
      await this.transport.connect(device.deviceId);
      // connect resolve 后等待 HELLO（由 onHello 迁移到 ready）
    } catch (e) {
      if (this.helloTimer !== null) this.clock.clearTimer(this.helloTimer);
      this.helloTimer = null;
      const kind = e instanceof TransportError ? e.kind : "system";
      // reconnectAttempts > 0 表示这是重连尝试（首连失败 → failed，不自动重试）
      if (this.reconnectAttempts > 0) {
        this.onReconnectAttemptFailed();
      } else {
        this.fail(`connect failed: ${kind}`);
      }
    }
  }

  private onUnexpectedDisconnect(err: TransportError): void {
    this.feeder.reset();
    if (this._state === "ready" || this._state === "connecting") {
      this.goReconnecting(err);
    } else if (this._state === "reconnecting") {
      this.onReconnectAttemptFailed();
    }
  }

  private goReconnecting(err: TransportError): void {
    if (this._state === "reconnecting" || this._state === "failed" || this._state === "idle") return;
    this._setState("reconnecting");
    this.failInflight(new CommandError("link-failed", `link dropped: ${err.message}`));
    this.safeDisconnect();
    this.reconnectAttempts = 0;
    this.feeder.reset();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.reconnectDelays.length) {
      this.fail("reconnect: out of attempts");
      return;
    }
    const delay = this.reconnectDelays[this.reconnectAttempts];
    this.reconnectTimer = this.clock.setTimer(() => {
      if (this._state !== "reconnecting") return;
      this.reconnectAttempts++;
      this.startConnecting(
        this.matchedDevice ?? { deviceId: "", name: this.filter.namePrefix ?? "" },
      );
    }, delay);
  }

  private onReconnectAttemptFailed(): void {
    if (this.reconnectAttempts >= this.reconnectDelays.length) {
      this.fail("reconnect: out of attempts");
      return;
    }
    // 回到 reconnecting 等下次退避（startConnecting 会把状态置成 connecting）
    this._setState("reconnecting");
    this.scheduleReconnect();
  }

  private fail(reason: string): void {
    this.clearAllTimers();
    this.failInflight(new CommandError("link-failed", reason));
    this._setState("failed");
  }

  // -------------------------------------------------------------------------
  // 命令会话
  // -------------------------------------------------------------------------

  private query(type: number, kind: "status" | "scene"): Promise<Status | Scene> {
    return new Promise<Status | Scene>((resolve, reject) => {
      this.pendingQueue.push({
        run: () => this.runQuery(type, kind, resolve, reject),
      });
      if (!this.busy) this.drainQueue();
    });
  }

  private sendFrame(frame: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingQueue.push({
        run: () => this.runSendFrame(frame, resolve, reject),
      });
      if (!this.busy) this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.busy) return;
    const next = this.pendingQueue.shift();
    if (!next) return;
    this.busy = true;
    next
      .run()
      .then(() => this.finishCommand())
      .catch(() => this.finishCommand());
  }

  private finishCommand(): void {
    this.busy = false;
    this.inFlightSeq = null;
    this.ackAttempts = 0;
    this.clearAckTimer();
    this.drainQueue();
  }

  private runSendFrame(
    frame: Uint8Array,
    resolve: () => void,
    reject: (e: Error) => void,
  ): Promise<void> {
    const seq = frame[3] | (frame[4] << 8);
    this.inFlightSeq = seq;
    this.ackAttempts = 0;
    return new Promise<void>((res, rej) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        this.clearAckTimer();
        resolve();
        res();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        this.clearAckTimer();
        this.pendingAckHandler = null;
        this.pendingNakHandler = null;
        reject(err);
        rej(err);
      };
      const doWrite = () => {
        this.writeFragmented(frame)
          .then(() => {
            // 若已被 NAK/ACK 结算则不再起 ACK 计时（防挂起的重发）
            if (settled) return;
            // 写成功后起 500ms ACK 计时
            this.ackTimer = this.clock.setTimer(() => {
              if (this.ackAttempts < ACK_MAX_RETRIES) {
                this.ackAttempts++;
                doWrite(); // 整帧重发（协议幂等）
              } else {
                settleReject(new CommandError("timeout", "no ACK after retries"));
              }
            }, ACK_TIMEOUT_MS);
          })
          .catch((e: unknown) => {
            const terr = e instanceof TransportError ? e : new TransportError("system", "write failed");
            this.goReconnecting(terr);
            settleReject(new CommandError("link-failed", "write failed"));
          });
      };
      this.pendingAckHandler = (ackSeq: number) => {
        if (ackSeq === seq) settleResolve();
      };
      this.pendingNakHandler = (nakSeq: number, err: number) => {
        if (nakSeq === seq) settleReject(new CommandError("rejected", "NAK", err));
      };
      doWrite();
    });
  }

  private runQuery(
    type: number,
    kind: "status" | "scene",
    resolve: (v: Status | Scene) => void,
    reject: (e: Error) => void,
  ): Promise<void> {
    const seq = this.nextSeq();
    const frame = encode({ type, seq, flags: 0, stripMask: 0, payload: [] });
    return new Promise<void>((res, rej) => {
      let settled = false;
      const settleResolve = (v: Status | Scene) => {
        if (settled) return;
        settled = true;
        if (this.pendingQuery) {
          this.clock.clearTimer(this.pendingQuery.timer);
          this.pendingQuery = null;
        }
        resolve(v);
        res();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        if (this.pendingQuery) {
          this.clock.clearTimer(this.pendingQuery.timer);
          this.pendingQuery = null;
        }
        reject(err);
        rej(err);
      };
      const timer = this.clock.setTimer(() => {
        settleReject(new CommandError("timeout", `${kind} timeout`));
      }, QUERY_TIMEOUT_MS);
      this.pendingQuery = { kind, seq, resolve: settleResolve, reject: settleReject, timer };
      this.writeFragmented(frame).catch((e: unknown) => {
        const terr = e instanceof TransportError ? e : new TransportError("system", "query write failed");
        this.goReconnecting(terr);
        settleReject(new CommandError("link-failed", "write failed"));
      });
    });
  }

  private resolveQuery(kind: "status" | "scene", value: Status | Scene): void {
    if (this.pendingQuery && this.pendingQuery.kind === kind) {
      this.pendingQuery.resolve(value);
    }
  }

  private onAck(ackSeq: number): void {
    if (this.pendingAckHandler) this.pendingAckHandler(ackSeq);
  }

  private onNak(nakSeq: number, err: number): void {
    if (this.pendingNakHandler) this.pendingNakHandler(nakSeq, err);
  }

  private async writeFragmented(frame: Uint8Array): Promise<void> {
    const packetSize = Math.max(FALLBACK_PACKET_SIZE, this.transport.mtuPayloadBytes);
    const packets: Uint8Array[] = [];
    for (let i = 0; i < frame.length; i += packetSize) {
      packets.push(frame.slice(i, i + packetSize));
    }
    for (const pkt of packets) {
      await this.writePacketWithTimeout(pkt);
    }
  }

  private writePacketWithTimeout(pkt: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimer(() => {
        if (settled) return;
        settled = true;
        reject(new TransportError("timeout", "single packet write timeout"));
      }, PACKET_TIMEOUT_MS);
      this.transport
        .writePacket(pkt)
        .then(() => {
          if (settled) return;
          settled = true;
          this.clock.clearTimer(timer);
          resolve();
        })
        .catch((e: unknown) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimer(timer);
          reject(e instanceof TransportError ? e : new TransportError("system", "write failed"));
        });
    });
  }

  private nextSeq(): number {
    const s = this.txSeq;
    this.txSeq = (this.txSeq + 1) & 0xffff;
    return s;
  }

  // -------------------------------------------------------------------------
  // 清理
  // -------------------------------------------------------------------------

  private clearAckTimer(): void {
    if (this.ackTimer !== null) this.clock.clearTimer(this.ackTimer);
    this.ackTimer = null;
  }

  private clearAllTimers(): void {
    for (const t of [
      this.scanTimer,
      this.helloTimer,
      this.watchdogTimer,
      this.reconnectTimer,
      this.ackTimer,
    ]) {
      if (t !== null) this.clock.clearTimer(t);
    }
    this.scanTimer = null;
    this.helloTimer = null;
    this.watchdogTimer = null;
    this.reconnectTimer = null;
    this.ackTimer = null;
    if (this.pendingQuery) {
      this.clock.clearTimer(this.pendingQuery.timer);
      this.pendingQuery = null;
    }
  }

  private failInflight(err: Error): void {
    this.pendingQueue = [];
    if (this.pendingQuery) {
      this.clock.clearTimer(this.pendingQuery.timer);
      this.pendingQuery.reject(err);
      this.pendingQuery = null;
    }
    this.pendingAckHandler = null;
    this.pendingNakHandler = null;
  }

  private async safeDisconnect(): Promise<void> {
    try {
      await this.transport.disconnect();
    } catch {
      /* 忽略 */
    }
  }

  private _setState(s: LinkState): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of this.stateCbs) cb(s);
  }

  private emitStatus(s: Status): void {
    for (const cb of this.statusCbs) cb(s);
  }

  private emitScene(s: Scene): void {
    for (const cb of this.sceneCbs) cb(s);
  }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function parseHello(payload: number[], ver: number): HelloCaps {
  return {
    version: ver,
    fw: {
      major: payload[1] ?? 0,
      minor: payload[2] ?? 0,
      patch: payload[3] ?? 0,
    },
    stripCount: payload[4] ?? 0,
    ledsPerStrip: payload[5] ?? 0,
    caps: payload[6] ?? 0,
    effectBitmap: Uint8Array.from(payload.slice(7, 23)),
  };
}

function parseStatus(payload: number[]): Status {
  const u32 = (o: number) =>
    (payload[o] ?? 0) | ((payload[o + 1] ?? 0) << 8) | ((payload[o + 2] ?? 0) << 16) | ((payload[o + 3] ?? 0) << 24);
  const u16 = (o: number) => (payload[o] ?? 0) | ((payload[o + 1] ?? 0) << 8);
  return {
    uptimeS: u32(0),
    glitchCount: u16(4),
    dropCount: u16(6),
    stripFault: payload[8] ?? 0,
    activeEffect: payload.slice(9, 17),
  };
}

function parseScene(payload: number[]): Scene {
  const stripCount = payload[0] ?? 0;
  const strips: SceneStrip[] = [];
  let o = 1;
  for (let i = 0; i < stripCount; i++) {
    const effectId = payload[o] ?? 0;
    const paramLen = payload[o + 1] ?? 0;
    strips.push({ effectId, params: payload.slice(o + 2, o + 2 + paramLen) });
    o += 2 + paramLen;
  }
  return { strips };
}