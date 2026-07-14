import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_INTERVAL_MS = 2000;

function normalizeInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(500, Math.floor(ms));
}

function safePluginList(loader) {
  if (loader && typeof loader.list === "function") {
    try { return loader.list(); } catch { return []; }
  }
  return [];
}

function safeQueueStats(queue) {
  if (queue && typeof queue.getStats === "function") {
    try { return queue.getStats(); } catch { return null; }
  }
  return null;
}

/**
 * ProcessHeartbeat -- writes logs/heartbeat.{port}.json for the watchdog.
 *
 * Milestone 4.2 keeps the existing on-disk format (so watchdog still works)
 * but moves the setInterval loop out of main.mjs.
 *
 * v0.9.8 (L5.0 manual #30): 文件名按 port 命名，支持多实例（多 korina 实例
 * 跑在不同 port 时各写各的 heartbeat 文件，不冲突）。
 * 默认 port=9999 → logs/heartbeat.9999.json。
 * 如果显式传 options.file 则优先用 file（向后兼容测试）。
 */
export class ProcessHeartbeat {
  constructor(options = {}) {
    const projectRoot = options.projectRoot || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    this.logsDir = options.logsDir || join(projectRoot, "logs");
    this.port = options.port || 9999;
    // 向后兼容：显式传 file 优先（测试和老 watchdog 协议）
    this.file = options.file || join(this.logsDir, `heartbeat.${this.port}.json`);
    this.intervalMs = normalizeInterval(options.intervalMs);
    this.version = options.version || "0.0.0";
    this.mode = options.mode || "worker";
    this.getLoader = options.getLoader || (() => null);
    this.getQueue = options.getQueue || (() => null);
    this.now = options.now || (() => Date.now());

    this._timer = null;
    this._lastWrite = 0;
    this._lastError = null;
  }

  buildPayload() {
    return {
      ts: this.now(),
      pid: process.pid,
      version: this.version,
      mode: this.mode,
      plugins: this._safePlugins(),
      queue: this._safeQueue(),
    };
  }

  _safePlugins() {
    try { return this.getLoader()?.list?.() || []; } catch { return []; }
  }

  _safeQueue() {
    try { return this.getQueue()?.getStats?.() ?? null; } catch { return null; }
  }

  writeOnce() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.buildPayload()));
      this._lastWrite = this.now();
      this._lastError = null;
      return { ok: true, ts: this._lastWrite };
    } catch (e) {
      this._lastError = e.message;
      return { ok: false, error: e.message };
    }
  }

  start() {
    if (this._timer) return { ok: true, alreadyRunning: true };
    this.writeOnce();
    this._timer = setInterval(() => this.writeOnce(), this.intervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
    return { ok: true, started: true };
  }

  stop() {
    if (!this._timer) return { ok: true, alreadyStopped: true };
    clearInterval(this._timer);
    this._timer = null;
    return { ok: true, stopped: true };
  }

  status() {
    return {
      file: this.file,
      exists: existsSync(this.file),
      intervalMs: this.intervalMs,
      running: !!this._timer,
      lastWrite: this._lastWrite,
      lastError: this._lastError,
    };
  }
}
