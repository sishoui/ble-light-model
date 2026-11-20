// PcBleTransport（miniprogram.md §4.2 / §5）：Node 桥客户端，stdio JSONL 请求/事件。
//
// 本文件属于 transport/ 目录，允许引用 child_process / process（lint 只查 logic/src）。
// 桥是纯电台：不编解码帧、不认灯效、不做重连；这些全在 BleLink（§5.3）。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { TransportError } from "@ble-light/logic";
import type { DeviceAdvertisement, DeviceId, Transport, TransportErrorKind, Unsubscribe } from "@ble-light/logic";

// 默认从进程工作目录定位 bridge/（影子跑从仓库根启动，见 miniprogram.md §9.4）。
// 显式传入 bridgeDir 可覆盖；避免 import.meta 与 CJS/ESM 模块模式的耦合。
const DEFAULT_BRIDGE_DIR = resolve(process.cwd(), "bridge");
const READY_TIMEOUT_MS = 5000; // 握手 5s（§5.2）
const CONNECT_TIMEOUT_MS = 15000; // connect 15s
const REQ_TIMEOUT_MS = 5000; // 其余 5s
const KILL_GRACE_MS = 2000; // dispose 关 stdin 后等 2s（§5.5）

interface BridgeMsg {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: { kind?: TransportErrorKind; message?: string };
  event?: string;
  data?: unknown;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

export interface PcBleTransportOptions {
  bridgeDir?: string;
  python?: string;
}

export class PcBleTransport implements Transport {
  mtuPayloadBytes = 20;

  private readonly bridgeDir: string;
  private readonly pythonCmd: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private ready = false;
  private disposed = false;
  private deviceId: DeviceId | null = null;

  private deviceCbs: Array<(adv: DeviceAdvertisement) => void> = [];
  private notifyCbs: Array<(chunk: Uint8Array) => void> = [];
  private disconnectCbs: Array<(err: TransportError) => void> = [];

  constructor(opts?: PcBleTransportOptions) {
    this.bridgeDir = opts?.bridgeDir ?? DEFAULT_BRIDGE_DIR;
    this.pythonCmd = opts?.python ?? "python";
  }

  async connect(deviceId: DeviceId, opts?: { timeoutMs?: number }): Promise<void> {
    await this.ensureBridge();
    if (this.deviceId === deviceId) return;
    const r = await this.request("connect", { deviceId, timeoutMs: opts?.timeoutMs ?? CONNECT_TIMEOUT_MS });
    const mtu = (r as { mtuPayloadBytes?: number })?.mtuPayloadBytes;
    this.mtuPayloadBytes = mtu && mtu > 0 ? mtu : 20;
    this.deviceId = deviceId;
  }

  disconnect(): Promise<void> {
    if (!this.proc || this.disposed) return Promise.resolve();
    return this.request("disconnect", {}).then(
      () => { this.deviceId = null; },
      (e: TransportError) => { throw e; },
    );
  }

  startScan(filter: { serviceUuid: string; namePrefix?: string }): void {
    void this.request("scan.start", { serviceUuid: filter.serviceUuid, namePrefix: filter.namePrefix });
  }

  stopScan(): void {
    void this.request("scan.stop", {});
  }

  onDeviceFound(cb: (adv: DeviceAdvertisement) => void): Unsubscribe {
    this.deviceCbs.push(cb);
    return () => { this.deviceCbs = this.deviceCbs.filter((x) => x !== cb); };
  }

  async writePacket(bytes: Uint8Array): Promise<void> {
    await this.ensureBridge();
    if (bytes.length > this.mtuPayloadBytes) {
      throw new TransportError("invalid-data", `packet ${bytes.length}B > mtu ${this.mtuPayloadBytes}B`);
    }
    await this.request("write", { data: Buffer.from(bytes).toString("base64") });
  }

  onNotify(cb: (chunk: Uint8Array) => void): Unsubscribe {
    this.notifyCbs.push(cb);
    return () => { this.notifyCbs = this.notifyCbs.filter((x) => x !== cb); };
  }

  onDisconnect(cb: (err: TransportError) => void): Unsubscribe {
    this.disconnectCbs.push(cb);
    return () => { this.disconnectCbs = this.disconnectCbs.filter((x) => x !== cb); };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new TransportError("bridge-unavailable", "bridge disposed"));
    }
    this.pending.clear();
    try { p.stdin.end(); } catch { /* ignore */ }
    await new Promise<void>((resolveKill) => {
      const to = setTimeout(() => {
        try { p.kill(); } catch { /* ignore */ }
        resolveKill();
      }, KILL_GRACE_MS);
      p.once("exit", () => { clearTimeout(to); resolveKill(); });
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async ensureBridge(): Promise<void> {
    if (this.proc && this.ready) return;
    if (this.disposed) throw new TransportError("bridge-unavailable", "bridge disposed");
    await this.spawnBridge();
    await this.waitReady();
  }

  private spawnBridge(): Promise<void> {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    return new Promise((resolveSpawn, rejectSpawn) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.pythonCmd, ["-m", "ble_bridge"], { cwd: this.bridgeDir, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        rejectSpawn(new TransportError("bridge-unavailable", "failed to spawn bridge: " + String(e)));
        return;
      }
      this.proc = child;
      const stderrBuf: Buffer[] = [];
      child.stderr.on("data", (d: Buffer) => {
        stderrBuf.push(d);
        if (stderrBuf.length > 16) stderrBuf.shift();
      });
      child.stdout.on("data", (d: Buffer) => this.onStdout(d));
      child.on("error", (e) => {
        this.ready = false;
        rejectSpawn(new TransportError("bridge-unavailable", "bridge error: " + e.message));
      });
      child.on("exit", () => {
        if (this.proc === child) this.proc = null;
        this.ready = false;
        // 连接期间桥崩：先触发 onDisconnect，再让后续调用失败（§4.2）
        if (this.deviceId) {
          this.deviceId = null;
          const e = new TransportError("bridge-unavailable", "bridge process exited");
          for (const cb of this.disconnectCbs) cb(e);
        }
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(new TransportError("bridge-unavailable", "bridge exited"));
        }
        this.pending.clear();
      });
      resolveSpawn();
    });
  }

  private waitReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolveReady, rejectReady) => {
      const to = setTimeout(() => {
        rejectReady(new TransportError("bridge-unavailable", "bridge ready handshake timeout"));
      }, READY_TIMEOUT_MS);
      const check = () => {
        if (this.ready) { clearTimeout(to); resolveReady(); }
      };
      (this as unknown as { _readyHook?: () => void })._readyHook = check;
    });
  }

  private onStdout(data: Buffer): void {
    const text = data.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let msg: BridgeMsg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event === "ready") {
        this.ready = true;
        const hook = (this as unknown as { _readyHook?: () => void })._readyHook;
        if (hook) hook();
        continue;
      }
      if (msg.event === "device") {
        const d = msg.data as { deviceId?: string; name?: string; rssi?: number };
        if (d?.deviceId) {
          const adv: DeviceAdvertisement = { deviceId: d.deviceId, name: d.name ?? "", rssi: d.rssi ?? 0 };
          for (const cb of this.deviceCbs) cb(adv);
        }
        continue;
      }
      if (msg.event === "notify") {
        const chunk = base64ToBytes(msg.data as string);
        for (const cb of this.notifyCbs) cb(chunk);
        continue;
      }
      if (msg.event === "disconnect") {
        if (this.deviceId) this.deviceId = null;
        const e = new TransportError("not-connected", "bridge reported disconnect");
        for (const cb of this.disconnectCbs) cb(e);
        continue;
      }
      if (msg.event === "overflow") {
        // Node 把 overflow 当链路失败处理（§5.2），不展示给页面
        if (this.deviceId) this.deviceId = null;
        const e = new TransportError("bridge-unavailable", "bridge notify overflow");
        for (const cb of this.disconnectCbs) cb(e);
        continue;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) continue; // 未知 id 丢弃
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) {
          p.resolve(msg.result);
        } else {
          const kind = msg.error?.kind ?? "system";
          p.reject(new TransportError(kind, msg.error?.message ?? "bridge request failed"));
        }
      }
    }
  }

  private request(op: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.proc || this.disposed) {
      return Promise.reject(new TransportError("bridge-unavailable", "bridge not running"));
    }
    const id = this.nextId++;
    const timeoutMs = op === "connect" ? CONNECT_TIMEOUT_MS : REQ_TIMEOUT_MS;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new TransportError("bridge-unavailable", `bridge request ${op} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      this.proc!.stdin.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }
}