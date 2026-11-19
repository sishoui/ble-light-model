/**
 * COM6 串口（USB CDC）事件日志（spec §3.4）：按 VID（Espressif 0x303A）枚举
 * 可选自动发现，默认 COM6；读取固件 JSONL 事件行（与 pc_integration 同 schema：
 * boot / gap / rx / ack / nak / status / nvs / drop / glitch）。
 *
 * 本模块只用 serialport；解析逻辑（parseJsonlLine / normalizeLine）是纯函数，
 * 无硬件可单测。
 */

import { ReadlineParser, SerialPort } from 'serialport';

import { matchEvent } from './assert.mjs';

export const ESPRESSIF_VID = 0x303a; // Espressif 系设备（ESP32-C3 原生 USB CDC）
export const DEFAULT_BAUDRATE = 115200; // 仅参数位，CDC 实际不受波特率影响
export const DEFAULT_PORT = 'COM6'; // #18 定稿：B 场景断言 COM6（可用 --port 覆盖）

/** 一行串口文本 -> JSON 事件；非 JSON / 损坏返回 null（ESP_LOG* 行混流不影响断言）。 */
export function parseJsonlLine(raw) {
  const stripped = String(raw).trim();
  if (stripped === '') return null;
  try {
    const event = JSON.parse(stripped);
    return typeof event === 'object' && event !== null ? event : null;
  } catch {
    return null;
  }
}

/** 规范化 ReadlineParser 吐出的行（剥尾部 \r / \n）；返回 { line, event }。 */
export function normalizeLine(raw) {
  const line = String(raw).replace(/[\r\n]+$/, '');
  return { line, event: parseJsonlLine(line) };
}

export class ComLog {
  constructor({ portName, baudRate = DEFAULT_BAUDRATE, clock = Date.now }) {
    if (!portName) throw new Error('ComLog 需要 portName');
    this.portName = portName;
    this.baudRate = baudRate;
    this.clock = clock;
    this.lines = []; // { tsMs, tsWall, raw, event }
    this._port = null;
    this._parser = null;
  }

  static async open(options) {
    const com = new ComLog(options);
    await com._open();
    return com;
  }

  async _open() {
    this._port = new SerialPort({ path: this.portName, baudRate: this.baudRate, autoOpen: false });
    await new Promise((resolve, reject) => {
      this._port.open((err) => (err ? reject(err) : resolve()));
    });
    this._parser = this._port.pipe(new ReadlineParser({ delimiter: '\n' }));
    this._parser.on('data', (chunk) => this._onLine(String(chunk)));
  }

  _onLine(raw) {
    const { line, event } = normalizeLine(raw);
    if (line === '') return;
    this.lines.push({ tsMs: this.clock(), tsWall: Date.now(), raw: line, event });
  }

  /** 第一条匹配事件（spec 见 assert.mjs matchEvent）。 */
  findEvent(spec) {
    for (const rec of this.lines) {
      if (rec.event && matchEvent(rec, spec)) return rec;
    }
    return null;
  }

  /** 匹配事件计数（com6Count / 无重试 / 无风暴断言用）。 */
  countEvents(spec) {
    let n = 0;
    for (const rec of this.lines) {
      if (rec.event && matchEvent(rec, spec)) n += 1;
    }
    return n;
  }

  /** 已解析事件（取证 dump 用）。 */
  parsedEvents() {
    return this.lines.filter((rec) => rec.event !== null);
  }

  async close() {
    if (this._parser) {
      try {
        this._parser.removeAllListeners('data');
      } catch {
        /* ignore */
      }
      this._parser = null;
    }
    if (this._port && this._port.isOpen) {
      await new Promise((resolve) => this._port.close(() => resolve()));
    }
    this._port = null;
  }
}

/** 按 USB VID 枚举 Espressif 串口（自动发现用；多设备报错要求 --port 覆盖）。 */
export async function discoverEspPort({ vid = ESPRESSIF_VID } = {}) {
  const ports = await SerialPort.list();
  const matches = ports.filter((p) => {
    const raw = p.vendorId ?? p.vid;
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 16);
    return n === vid;
  });
  if (matches.length === 0) {
    throw new Error(
      `未发现 USB VID=${vid.toString(16).toUpperCase()} 的 Espressif 串口（检查 C3 已接入，或 --port 指定）`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`发现多个 Espressif 串口：${matches.map((p) => p.path).join(', ')}；请用 --port 指定`);
  }
  return matches[0].path;
}