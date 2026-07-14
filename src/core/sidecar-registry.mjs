/**
 * src/core/sidecar-registry.mjs
 *
 * Milestone 5.0: 统一 sidecar 生命周期管理。
 *
 * 抽象 launchSidecar 返回的 handle，让 voice-input / desktop-lyrics
 * 共用一套存活检测、ping 记录、stop / cleanup 入口。
 *
 * 之前状态：
 *   - plugins/sidecar-launcher 维护 voice-input 的 alive 状态
 *   - plugins/desktop-lyrics 维护自己的 alive 状态
 *   - 两条 sidecarStatus 字段不统一
 *
 * 现在状态：
 *   - 一个 SidecarRegistry 实例管理所有 sidecar
 *   - 每个 sidecar { name, pid, alive, startedAt, lastPingAt, handle, scriptName, enabled }
 *   - /status 暴露 korina.sidecars = registry.snapshot()
 *   - /sidecars/ping 由 registry 处理
 *   - stopAll() 给 gracefulShutdown 调用
 *   - 旧 plugins/sidecar-launcher 暂不改逻辑，下一阶段把 desktop-lyrics 也接入
 */

import { launchSidecar } from "./sidecar.mjs";

const DEFAULT_CHECK_INTERVAL_MS = 10000;

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class SidecarRegistry {
  constructor(options = {}) {
    this.entries = new Map();
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this._checkTimer = null;
    this._log = options.log || (() => {});
    this._options = options;
  }

  startHealthCheck() {
    if (this._checkTimer) return { ok: true, alreadyRunning: true };
    this._checkTimer = setInterval(() => this._refreshAll(), this.checkIntervalMs);
    if (typeof this._checkTimer.unref === "function") this._checkTimer.unref();
    return { ok: true, started: true };
  }

  stopHealthCheck() {
    if (!this._checkTimer) return { ok: true, alreadyStopped: true };
    clearInterval(this._checkTimer);
    this._checkTimer = null;
    return { ok: true, stopped: true };
  }

  register(name, options = {}) {
    if (!name || typeof name !== "string") throw new Error("sidecar name 必填");
    if (this.entries.has(name) && !options.replace) {
      throw new Error(`sidecar 已存在: ${name}`);
    }

    const entry = {
      name,
      scriptName: options.scriptName || null,
      enabled: options.enabled !== false,
      pid: null,
      alive: false,
      startedAt: null,
      lastPingAt: null,
      handle: null,
    };
    this.entries.set(name, entry);
    return entry;
  }

  get(name) {
    return this.entries.get(name) || null;
  }

  unregister(name) {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: `sidecar 不存在: ${name}` };
    if (entry.handle) entry.handle.stop();
    this.entries.delete(name);
    return { ok: true, name };
  }

  /**
   * v0.9.13 (L5.3 manual #37): 停 sidecar 但保留 entry（保留历史 startedAt 等元数据）
   * 用于按需启动场景（voice-input start/stop 端点）
   * @param {string} name
   * @returns {{ok: boolean, name?: string, error?: string}}
   */
  stop(name) {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: `sidecar 不存在: ${name}` };
    if (!entry.handle) return { ok: false, error: `sidecar 未启动: ${name}`, name };
    entry.handle.stop();
    entry.handle = null;
    entry.pid = null;
    entry.alive = false;
    // 不删 entry；保留以便 /status 显示"曾经启动过"
    return { ok: true, name };
  }

  list() {
    return Array.from(this.entries.keys());
  }

  snapshot() {
    const out = {};
    for (const [name, entry] of this.entries) {
      out[name] = {
        pid: entry.pid,
        alive: entry.alive,
        startedAt: entry.startedAt,
        lastPingAt: entry.lastPingAt,
        scriptName: entry.scriptName,
      };
    }
    return out;
  }

  /**
   * Launch a sidecar and register its handle.
   * @param {string} name
   * @param {object} options
   *   - scriptName, projectRoot, logsDir (required for launchSidecar)
   *   - enabled, replace
   * @returns {{ok: boolean, entry: object|null, error?: string}}
   */
  launch(name, options = {}) {
    const entry = this.entries.get(name) || this.register(name, { replace: true, ...options });
    if (entry.handle) entry.handle.stop();

    if (options.enabled === false) {
      entry.enabled = false;
      this._log(`[${name}] 显式 disabled，跳过 launch`);
      return { ok: true, entry, skipped: true };
    }

    const handle = launchSidecar({
      scriptName: entry.scriptName || options.scriptName,
      label: name,
      projectRoot: options.projectRoot,
      logsDir: options.logsDir,
      log: this._log,
    });
    if (!handle || !handle.child) {
      return { ok: false, error: `sidecar 拉起失败: ${name}`, entry };
    }

    entry.enabled = true;
    entry.pid = handle.child.pid;
    entry.alive = true;
    entry.startedAt = Date.now();
    entry.handle = handle;
    return { ok: true, entry };
  }

  /**
   * Record a sidecar self-ping (e.g. voice-input.py POST /sidecars/ping).
   * @param {string} name
   */
  recordPing(name) {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: `未知 sidecar: ${name}` };
    entry.lastPingAt = Date.now();
    if (entry.pid && isAlive(entry.pid)) entry.alive = true;
    return { ok: true, name, lastPingAt: entry.lastPingAt };
  }

  _refreshAll() {
    for (const entry of this.entries.values()) {
      if (!entry.pid) continue;
      const alive = isAlive(entry.pid);
      if (alive !== entry.alive) {
        if (entry.alive) this._log(`[${entry.name}] 进程 ${entry.pid} 已退出`);
        entry.alive = alive;
      }
    }
  }

  /**
   * Gracefully stop all sidecars. 8s 超时后强杀。
   */
  async stopAll(timeoutMs = 8000) {
    for (const entry of this.entries.values()) {
      if (!entry.handle) continue;
      try { entry.handle.stop(); } catch {}
    }
    // 等所有 sidecar 自然退出
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const allDown = Array.from(this.entries.values()).every((e) => !e.pid || !isAlive(e.pid));
      if (allDown) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    this.stopHealthCheck();
    return { ok: true, stopped: Array.from(this.entries.keys()) };
  }
}
