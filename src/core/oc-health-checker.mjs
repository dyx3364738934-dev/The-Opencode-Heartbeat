import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 3_000;

function normalizeInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(100, Math.floor(ms)); // 最低 100ms（生产默认 10s）
}

function normalizeTimeout(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(100, Math.floor(ms));
}

/**
 * OcHealthChecker -- 每隔 intervalMs 探测 oc /status 端点是否真活。
 *
 * 跟 ProcessHeartbeat 的区别：
 * - ProcessHeartbeat 是"本地写文件"（给 watchdog 读）
 * - OcHealthChecker 是"远程端点探测"（内存状态，给 /status 输出）
 *
 * 设计取舍：
 * - 用 GET /status 不用 HEAD（oc 端不一定实现 HEAD）
 * - oc 的 /status 需要 Basic auth（OpenCode 服务端要求）
 * - 用 AbortController 实现超时（避免探测本身挂死）
 * - 失败时不抛异常（写入 _lastResult.alive=false 即可）
 *
 * v0.9.23 (manual #22 B1 修复): baseUrl 改为动态
 *   - 之前: 构造时硬编码 baseUrl，oc 重启换端口后 ocHealth 持续报 alive=false（误报）
 *   - 现在: 接受 getBaseUrl 函数，每次 probeOnce 时调用拿最新值
 *   - 如果 ocBase 变化（oc 重启换 port），ocHealth 自动跟随
 */
export class OcHealthChecker {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || "http://127.0.0.1:7574";
    // v0.9.23: 动态 baseUrl（优先级高于静态 baseUrl）
    this.getBaseUrl = options.getBaseUrl || null;
    this.intervalMs = normalizeInterval(options.intervalMs);
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.now = options.now || (() => Date.now());
    this._fetch = options.fetch || ((url, init) => globalThis.fetch(url, init));
    // oc 的 /status 需要 Basic auth；OpenCode 默认用户名 "opencode"，密码读 logs/oc-password.txt
    this.auth = options.auth || null; // null = 不带 auth（探测自己 korina 时用）

    this._timer = null;
    this._lastResult = {
      alive: false,
      lastCheckedAt: 0,
      latencyMs: null,
      consecutiveFailures: 0,
      lastError: "not_yet_probed",
    };
  }

  // v0.9.23: 拿当前 effective baseUrl（动态优先，静态兜底）
  get effectiveBaseUrl() {
    if (this.getBaseUrl) {
      try {
        const dynamic = this.getBaseUrl();
        if (dynamic) return dynamic;
      } catch {}
    }
    return this.baseUrl;
  }

  _fail(latencyMs, reason) {
    this._lastResult = {
      alive: false,
      lastCheckedAt: this.now(),
      latencyMs,
      consecutiveFailures: this._lastResult.consecutiveFailures + 1,
      lastError: reason,
    };
  }

  _ok(latencyMs) {
    this._lastResult = {
      alive: true,
      lastCheckedAt: this.now(),
      latencyMs,
      consecutiveFailures: 0,
      lastError: null,
    };
  }

  async probeOnce() {
    const t0 = this.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const headers = this.auth ? { Authorization: this.auth } : {};
    // v0.9.23: 用 effectiveBaseUrl（动态跟随 ocBase）
    const base = this.effectiveBaseUrl;
    try {
      const res = await this._fetch(`${base}/status`, {
        method: "GET",
        headers,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const latencyMs = this.now() - t0;
      if (res && res.ok) {
        this._ok(latencyMs);
      } else {
        const status = res ? res.status : null;
        this._fail(latencyMs, status != null ? `HTTP ${status}` : "no_response");
      }
    } catch (e) {
      clearTimeout(timer);
      const latencyMs = this.now() - t0;
      const reason = e?.name === "AbortError"
        ? `timeout_${this.timeoutMs}ms`
        : (e?.message || String(e));
      this._fail(latencyMs, reason);
    }
    return this.snapshot();
  }

  start() {
    if (this._timer) return { ok: true, alreadyRunning: true };
    // fire-and-forget；不 await，避免阻塞 main.mjs 启动
    this.probeOnce().catch(() => {});
    this._timer = setInterval(() => {
      // 每个 fire 独立跑 probeOnce，不串行（探测是独立的，每次带新 AbortController）
      this.probeOnce().catch(() => {});
    }, this.intervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
    return { ok: true, started: true };
  }

  stop() {
    if (!this._timer) return { ok: true, alreadyStopped: true };
    clearInterval(this._timer);
    this._timer = null;
    return { ok: true, stopped: true };
  }

  snapshot() {
    return { ...this._lastResult };
  }

  status() {
    return {
      baseUrl: this.effectiveBaseUrl,  // v0.9.23: 用 effective（动态）
      intervalMs: this.intervalMs,
      timeoutMs: this.timeoutMs,
      running: !!this._timer,
      ...this._lastResult,
    };
  }
}