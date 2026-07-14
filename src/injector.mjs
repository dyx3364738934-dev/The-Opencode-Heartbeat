/**
 * core/injector.mjs
 *
 * 注入区：发现 oc session、注入消息、轮询取返回值
 *
 * 对接 opencode HTTP API：
 *   POST /session/:id/prompt_async  -- 异步注入（立即 204，不阻塞）
 *   GET  /session/:id/message       -- 取消息列表
 *   POST /session/:id/summarize     -- 触发上下文压缩
 *   GET  /session                   -- 列所有 session
 *   GET  /global/health             -- 健康检查
 */

import { execSync, spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInjectMessage } from "./inject-intent.mjs";
import { SessionBindingStore } from "./state/session-binding-store.mjs";
// v0.9.15 (manual #39 J 第一刀): oc 发现 / 密码 / 端口探测 抽到独立模块
import * as Ocd from "./injector-oc-discovery.mjs";
// v0.9.16 (manual #40 J 第二刀): Session 绑定管理 抽到独立模块
import * as Smgr from "./injector-session.mjs";
// v0.9.17 (manual #41 J 第三刀): Session 选择策略 + oc session 列表 抽到独立模块
import * as Ssel from "./injector-session-selection.mjs";
// v0.9.19 (J 第四刀 manual #44): HTTP 注入 + 轮询 + 健康监控 + 压缩/计数 抽到独立模块
import * as Hop from "./injector-http-ops.mjs";
// v0.9.22 (manual #50): 修 isOCIdleAsync 的 sleep ReferenceError 隐性 bug。
// 此前 injector.mjs:488 用 await sleep(3000) 但 sleep 未 import 也未本地定义，
// 每次 ReferenceError → catch 兜底 return true（idle）→ isOCIdleAsync 从未真正工作。
import { sleep } from "./utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
// v0.9.10 (L5.1 manual #34): SESSION_LOCK 由 bindingStore 持有（按 port 命名 session.{port}.lock），
// 这里只保留常量引用路径用于 _readPasswordFile 替换兼容代码（兼容老 oc-password.txt 路径）。
const SESSION_LOCK = join(PROJECT_ROOT, "logs", "session.lock");
const LAST_KOKO_TIME_FILE = join(PROJECT_ROOT, "logs", "last-koko-time.json");

export class Injector {
  constructor(config = {}) {
    this.serverConfig = null; // { port, auth, base, headers }
    this.sessionId = config.sessionId ?? null; // 主会话（锁定，null=自动找最新）
    this.sessions = new Set(); // v0.8: 多会话绑定（per-session 心跳/任务）
    this.persistSession = config.persistSession ?? true; // 是否持久化 session 锁定
    // v0.9.17 (manual #41 J 集成 bugfix): projectRoot + logsDir 必须设实例字段
    // ——oc-discovery/session-selection 模块用 `{ logsDir, projectRoot }` 参数，
    // 老代码用模块顶层 const SESSION_LOCK 派生，J 抽出后这两个字段不能少
    this.projectRoot = config.projectRoot || PROJECT_ROOT;
    this.logsDir = config.logsDir || join(this.projectRoot, "logs");
    // v0.9.10 (L5.1 manual #34): 接受 options.port 透传到 SessionBindingStore（文件按 port 命名）
    const storeOpts = { persist: this.persistSession };
    if (config.port) storeOpts.port = config.port;
    if (config.sessionLockFile) storeOpts.sessionLockFile = config.sessionLockFile;
    this.bindingStore = config.bindingStore || new SessionBindingStore(storeOpts);
    // SESSION_LOCK 也跟着 bindingStore 走（确保 _readPasswordFile 替换用的路径一致）
    if (this.bindingStore.sessionLockFile) {
      // 反射覆盖 SESSION_LOCK 路径（保持 injector.mjs 其他引用 .replace("session.lock", ...) 仍能工作）
    }
    if (this.sessionId) {
      this.bindingStore.bindSession(this.sessionId, { makePrimary: true, persist: false, reason: "injector.constructor" });
      this._syncSessionStateFromStore();
    }
    this.lastAssistantTime = 0; // 用于区分新旧消息
    this.lastKokoTime = 0; // v0.9.5: Koko 真实活跃时间（按 source=koko 更新），区别于 lastAssistantTime
    // v0.9.5: 跨重启持久化 -- 启动时从文件读，避免重启后 {kokoIdle} 显示"未知"
    // v0.9.23: 修 disk 误导（manual #46 实证 bug）
    //   - 之前: 无脑信任 disk 值 → korina 重启后渲染"15 小时前活跃"误报
    //   - 现在: disk 值超过 1 小时就不信任（设为 0=未知），让 SSE 重新捕获真实活跃时间
    const KOKO_TIME_TRUST_MS = 60 * 60 * 1000;  // 1 小时
    try {
      if (existsSync(LAST_KOKO_TIME_FILE)) {
        const data = JSON.parse(readFileSync(LAST_KOKO_TIME_FILE, "utf-8"));
        if (data.lastKokoTime && data.lastKokoTime > 0) {
          const ageMs = Date.now() - data.lastKokoTime;
          if (ageMs <= KOKO_TIME_TRUST_MS) {
            this.lastKokoTime = data.lastKokoTime;
            console.log(`[injector] 加载 lastKokoTime from disk: ${new Date(data.lastKokoTime).toISOString()} (${Math.round(ageMs / 60000)} 分钟前)`);
          } else {
            console.log(`[injector] lastKokoTime disk 值过期（${Math.round(ageMs / 36000) / 100} 小时前），丢弃等 SSE 重捕获`);
          }
        }
      }
    } catch (e) {
      console.warn(`[injector] 读 lastKokoTime 文件失败: ${e.message?.slice(0, 60)}`);
    }
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.pollTimeoutMs = config.pollTimeoutMs ?? 180000; // 单次等待最长 3 分钟
    // v0.8.7: per-session 注入记录（修复 H11：原实例属性跨 session 共享导致 re-inject 到错误 session）
    this._lastInjected = new Map(); // sid -> { text, opts, ts }
    this.onOCRestarted = config.onOCRestarted || null; // v0.4: oc 重启回调（端口变化时触发）
    this._lastKnownPort = null; // v0.8.1: 记录已知端口（实例属性，discover 同步更新，防误触发续命）
  }

  _syncSessionStateFromStore() {
    this.sessionId = this.bindingStore.getPrimarySessionId();
    this.sessions = new Set(this.bindingStore.listBoundSessionIds());
    if (this.sessionId && !this.sessions.has(this.sessionId)) this.sessions.add(this.sessionId);
  }

  // ============================================================
  // v0.4: 密码主动匹配 + oc 拉起（watchdog 融入 korina）
  // v0.9.15 (manual #39): 这些方法委托给 src/injector-oc-discovery.mjs
  //   公共 API 保持不变（外部插件 + 测试零改动），仅实现搬到独立模块
  // ============================================================

  /**
   * v0.4: 主动轮询密码匹配 → 委托 Ocd.waitForPassword
   * 等 oc-password.txt 出现且密码有效（verify_server 通过）
   */
  async waitForPassword(maxWaitMs = 120000) {
    const cfg = await Ocd.waitForPassword({ logsDir: this.logsDir, maxWaitMs });
    this.serverConfig = cfg;
    this._lastKnownPort = cfg.port;
    return cfg;
  }

  _readPasswordFile() {
    return Ocd.readPasswordFile({ logsDir: this.logsDir });
  }

  isOCRunning() {
    return Ocd.isOCRunning({ projectRoot: this.projectRoot });
  }

  async isOCRunningAsync() {
    return Ocd.isOCRunningAsync({ projectRoot: this.projectRoot });
  }

  spawnOC() {
    return Ocd.spawnOC();
  }

  async ensureOCAndDiscover() {
    if (!Ocd.isOCRunning({ projectRoot: this.projectRoot })) {
      console.log("[injector] oc 不在线，拉起...");
      Ocd.spawnOC();
    }
    const cfg = await Ocd.waitForPassword({ logsDir: this.logsDir });
    this.serverConfig = cfg;
    this._lastKnownPort = cfg.port;
    return cfg;
  }

  async discover() {
    if (this.serverConfig) return this.serverConfig;
    const cfg = await Ocd.ensureOCAndDiscover({
      logsDir: this.logsDir,
      projectRoot: this.projectRoot,
    });
    this.serverConfig = cfg;
    this._lastKnownPort = cfg.port;
    return cfg;
  }

  _findPortsByProcessAsync(processName) {
    return Ocd.findPortsByProcessAsync({ processName, projectRoot: this.projectRoot });
  }

  _findPortsByProcess(processName) {
    return Ocd.findPortsByProcess({ processName });
  }

  async _tryPort(port, headers) {
    return Ocd.tryPort({ port, auth: headers.Authorization });
  }

  // ============================================================
  // v0.9.16 (manual #40 J 第二刀): Session 绑定管理 → 委托给 injector-session.mjs
  //   saveSession / loadSession / bindSession / unbindSession / listBoundSessions
  //   公共 API 不变（外部插件 + 测试零改动）
  // ============================================================

  saveSession(sid) {
    const ok = Smgr.saveSession({ bindingStore: this.bindingStore, persistSession: this.persistSession, sid });
    if (ok) this._syncSessionStateFromStore();
  }

  loadSession() {
    const sid = Smgr.loadSession({ bindingStore: this.bindingStore, persistSession: this.persistSession });
    if (sid) this._syncSessionStateFromStore();
    return sid;
  }

  bindSession(sid) {
    const result = Smgr.bindSession({ bindingStore: this.bindingStore, sid });
    if (result.ok) this._syncSessionStateFromStore();
    console.log(`[injector] bindSession ${sid}（${result.ok ? (result.isNew ? "新增" : "已存在") : "失败"}，共 ${this.sessions.size} 个绑定）`);
    return result;
  }

  unbindSession(sid) {
    const result = Smgr.unbindSession({ bindingStore: this.bindingStore, sid });
    if (result.ok) this._syncSessionStateFromStore();
    console.log(`[injector] unbindSession ${sid}（剩余 ${this.sessions.size} 个绑定）`);
    return result;
  }

  listBoundSessions() {
    return Smgr.listBoundSessions({ bindingStore: this.bindingStore });
  }

  // ============================================================
  // v0.9.19 (J 第四刀 manual #44): HTTP 注入 / 轮询 / 健康监控 / 压缩 / 计数 → 委托给 injector-http-ops.mjs
  //   公共 API 不变（外部插件 + 测试零改动）
  // ============================================================

  /**
   * 内部回调：source=koko 时更新 lastKokoTime + 持久化
   * 之前在 inject() 内联处理，抽出后由 Hop.inject 回调
   */
  _onKokoActive(ts) {
    this.lastKokoTime = ts;
    try {
      writeFileSync(LAST_KOKO_TIME_FILE, JSON.stringify({
        lastKokoTime: ts,
        savedAt: Date.now(),
      }));
    } catch {}
  }

  /**
   * v0.5: silent 注入（不写记忆、不等回复）—— 委托 Hop.silentInject
   * 重试 2 次（避免瞬时网络抖动）；不重置 serverConfig（避免触发 health monitor 误判）
   *
   * v0.9.22 (manual #50): silentInject 入口加 audit log（治 manual #46 错位 audit 设计）。
   * 此前 audit 在 /inject HTTP 端点，但 silentInject 真源头是这里，测试套调 inj.silentInject()
   * 内存直调不经过 HTTP 端点 → audit 永远抓不到。现在 silentInject 是真源头，开 KORINA_AUDIT=1 才打。
   */
  async silentInject(text, opts = {}) {
    if (process.env.KORINA_AUDIT === "1") {
      console.log(`[audit] silentInject source=${opts.source || "?"} intent=${opts.intent || "?"} textLen=${text.length} ts=${new Date().toISOString()}`);
    }
    const { base, headers } = await this.discover();
    const sid = opts.sessionId || this.sessionId || await this.resolveSession();
    return await Hop.silentInject(text, opts, {
      base, headers, sid,
      render: renderInjectMessage,
      onKokoActive: (ts) => this._onKokoActive(ts),
    });
  }

  /**
   * 注入一条消息（异步，立即返回）—— 委托 Hop.inject
   * v0.5: 支持意图系统 opts = { intent, source, customPrefix, customWrap, skipLog }
   */
  async inject(text, opts = {}) {
    const { base, headers } = await this.discover();
    const sid = opts.sessionId || this.sessionId || await this.resolveSession();
    return await Hop.inject(text, opts, {
      base, headers, sid,
      render: renderInjectMessage,
      onKokoActive: (ts) => this._onKokoActive(ts),
    });
  }

  /**
   * 注入并等待回复 —— 委托 Hop.injectAndWait
   * v0.2.1: fire-and-forget 模式（inject 失败不阻塞）
   * v0.5: opts 透传
   */
  async injectAndWait(text, onProgress = null, opts = {}) {
    const beforeTime = this.lastAssistantTime;
    const { base, headers } = await this.discover();
    const sid = opts.sessionId || this.sessionId || await this.resolveSession();
    return await Hop.injectAndWait(text, onProgress, opts, {
      base, headers, sid, beforeTime,
      render: renderInjectMessage,
      onKokoActive: (ts) => this._onKokoActive(ts),
      onLastInjected: (s, rec) => this._lastInjected.set(s, rec),
      pollIntervalMs: this.pollIntervalMs,
      pollTimeoutMs: this.pollTimeoutMs,
      lastInjected: this._lastInjected,
      injectFn: (text, opts) => this.inject(text, opts),
    });
  }

  /**
   * v0.4: health check loop —— 委托 Hop.startHealthMonitor
   * - oc 进程不在 -> spawnOC 主动拉起
   * - oc 在但 health 请求失败 -> 重置 serverConfig + 重读密码
   * - oc 在且 health OK -> 正常
   */
  startHealthMonitor(intervalMs = 15000) {
    this._healthHandle = Hop.startHealthMonitor(intervalMs, {
      _healthTimer: this._healthTimer,
      isOCRunningAsync: () => this.isOCRunningAsync(),
      waitForPassword: (ms) => this.waitForPassword(ms),
      findPortsByProcess: (name) => this._findPortsByProcessAsync(name),
      spawnOC: () => this.spawnOC(),
      refreshPassword: () => this._refreshPasswordFromFile(),
      getServerConfig: () => this.serverConfig,
      setServerConfig: (cfg) => { this.serverConfig = cfg; },
      onOCRestarted: this.onOCRestarted,
      getLastKnownPort: () => this._lastKnownPort,
      setLastKnownPort: (p) => { this._lastKnownPort = p; },
    });
    this._healthTimer = this._healthHandle.timer;
    return this._healthHandle;
  }

  stopHealthMonitor() {
    if (this._healthHandle) {
      this._healthHandle.stop();
      this._healthHandle = null;
      this._healthTimer = null;
    }
  }

  /**
   * v0.3.1: 从 oc-password.txt 读最新密码 —— 委托 Hop.refreshPasswordFromFile
   */
  _refreshPasswordFromFile() {
    Hop.refreshPasswordFromFile({ logsDir: this.logsDir });
  }

  /**
   * 触发上下文压缩 —— 委托 Hop.summarize
   */
  async summarize() {
    const { base, headers } = await this.discover();
    const sid = this.sessionId || await this.resolveSession();
    return await Hop.summarize({ base, headers, sid });
  }

  /**
   * 获取 session 消息数量 —— 委托 Hop.getMessageCount
   */
  async getMessageCount() {
    const { base, headers } = await this.discover();
    const sid = this.sessionId || await this.resolveSession();
    return await Hop.getMessageCount({ base, headers, sid });
  }

  async _getLastAssistantTime() {
    const { base, headers } = await this.discover();
    return await Ssel.getLastAssistantTime({ base, headers, sid: this.sessionId });
  }

  /**
   * 列出 oc 当前所有 session id（用于校验 voice target / secondary 绑定是否还有效）
   * v0.9.17 (manual #41): 委托 Ssel.listOcSessionIds
   * @returns {Promise<string[]>} 返回 sessionId 列表（任意错误返回空数组）
   */
  async listOcSessionIds() {
    try {
      const { base, headers } = await this.discover();
      return await Ssel.listOcSessionIds({ base, headers });
    } catch {
      return [];
    }
  }

  /**
   * v0.9.3: 灵活启动绑定 — 每次启动都找 oc 里最新更新的 session
   *
   * 不再优先用 session.lock 中锁定的 session。
   * 如果 session.lock 里恰好是最新的，就延续；否则切到最新的。
   * 这样 Koko 在哪个 chat 里最近活跃，korina 就绑哪个。
   */
  /**
   * v0.9.11 (L5.1 第二刀 manual #35): session 选择策略
   *
   * 通过环境变量 KORINA_BIND_SESSION 控制（按优先级匹配）：
   *   1. 直接指定 session ID（"ses_xxx"）—— 找到就绑那个
   *   2. 策略关键字：
   *      - "second-newest" → 拿 sorted[1]（避开最新）
   *      - "oldest" → 拿 sorted[N-1]（最老）
   *      - "random" → 随机一个
   *   3. peer-avoid-{port}：fetch 该 port 的 korina /status，避开它绑的 session
   *   4. 不设 env / 无法识别 → 拿 sorted[0]（最新，向后兼容）
   */
  async _selectTargetSession(sorted) {
    const bindSpec = process.env.KORINA_BIND_SESSION;
    if (!bindSpec) return sorted[0];

    // 1. 直接 session ID
    const direct = sorted.find((s) => s.id === bindSpec);
    if (direct) {
      console.log(`[injector] KORINA_BIND_SESSION=${bindSpec} 命中直接 ID: ${bindSpec}`);
      return direct;
    }

    // 2. 策略关键字
    if (bindSpec === "second-newest") {
      return sorted[1] || sorted[0];
    }
    if (bindSpec === "oldest") {
      return sorted[sorted.length - 1];
    }
    if (bindSpec === "random") {
      return sorted[Math.floor(Math.random() * sorted.length)];
    }

    // 3. peer-avoid-{port}
    const peerMatch = bindSpec.match(/^peer-avoid-(\d+)$/);
    if (peerMatch) {
      const peerPort = parseInt(peerMatch[1], 10);
      const peerSession = await this._fetchPeerSession(peerPort);
      if (peerSession) {
        const filtered = sorted.filter((s) => s.id !== peerSession);
        if (filtered.length > 0) {
          console.log(`[injector] peer-avoid-${peerPort} 避开 ${peerSession}，剩余 ${filtered.length} 个 session，绑 ${filtered[0].id}`);
          return filtered[0];
        }
        console.warn(`[injector] peer-avoid-${peerPort} 所有 session 都被占（peer=${peerSession}），回落拿最新`);
      } else {
        console.log(`[injector] peer-avoid-${peerPort} 拿不到 peer /status（peer 不在跑？），回落拿最新`);
      }
    }

    console.warn(`[injector] KORINA_BIND_SESSION=${bindSpec} 无法识别，回落拿最新`);
    return sorted[0];
  }

  /**
   * v0.9.11 (L5.1 第二刀 manual #35): session 选择策略 → 委托 Ssel.selectTargetSession
   * 通过环境变量 KORINA_BIND_SESSION 控制（按优先级匹配）：
   *   1. 直接 session ID → 2. 策略关键字 → 3. peer-avoid-{port} → 4. fallback 最新
   */
  async _selectTargetSession(sorted) {
    return await Ssel.selectTargetSession({ sorted });
  }

  /**
   * v0.9.11 (manual #35): 拉 peer korina 实例 /status → 委托 Ssel.fetchPeerSession
   */
  async _fetchPeerSession(port) {
    return await Ssel.fetchPeerSession({ port });
  }

  async resolveSession() {
    const { base, headers } = await this.discover();
    const sorted = await Ssel.fetchOcSessionsSorted({ base, headers });
    // v0.9.17 (manual #41): 用 _selectTargetSession 替代硬编码 sorted[0]
    const target = await this._selectTargetSession(sorted);

    // 如果锁定的 session 恰好就是选中的，延续（避免不必要的切换日志）
    const locked = this.sessionId || this.loadSession();
    if (locked === target.id) {
      console.log(`[injector] 绑定 session（延续）: ${target.id} (title="${target.title}")`);
    } else {
      console.log(`[injector] 绑定 session（切换）: ${target.id} (title="${target.title}")，旧: ${locked || "(无)"}`);
    }

    this.sessionId = target.id;
    this.saveSession(target.id);
    this.lastAssistantTime = await Ssel.getLastAssistantTime({ base, headers, sid: target.id });
    return target.id;
  }

  /**
   * v0.7.10: 检查 oc 是否闲置
   * 闲置定义：最近 30 秒内没有新 assistant 消息 AND 当前消息 state=completed/idle
   * @param {number} quietThresholdMs - 多少秒内无新消息算闲置（默认 30s）
   * @returns {Promise<boolean>}
   */
  /**
   * v0.8: 判断指定 session 的 oc 是否闲置
   * 修复：不再依赖不可靠的 state（opencode 的 state 常为空字符串），
   *       改成两次采样比较 content/parts/created —— 有变化 = oc 在输出 = 忙
   * @param {string|null} sessionId 指定 session（null 用主会话 this.sessionId）
   * @param {number} quietThresholdMs 无变化多久算闲置
   */
  async isOCIdleAsync(sessionId = null, quietThresholdMs = 30000) {
    try {
      const { base, headers } = await this.discover();
      const sid = sessionId || this.sessionId;
      if (!sid) return true;

      const sample = async () => {
        const r = await fetch(`${base}/session/${sid}/message?limit=1`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return null;
        const msgs = await r.json();
        if (!Array.isArray(msgs) || !msgs.length) return null;
        let latest = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].info?.role === "assistant") {
            latest = msgs[i];
            break;
          }
        }
        if (!latest) return null;
        const text = (latest.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
        const reasoning = (latest.parts || [])
          .filter((p) => p.type === "reasoning" || p.type === "thinking")
          .map((p) => p.text)
          .join("");
        return {
          created: latest.info?.time?.created || 0,
          contentLen: text.length + reasoning.length,
          partsLen: (latest.parts || []).length,
        };
      };

      const s1 = await sample();
      if (!s1) return true;
      await sleep(3000); // 等 3s 再采一次
      const s2 = await sample();
      if (!s2) return true;

      // 有变化 = oc 在输出（思考/tool 执行）= 忙，不闲置
      const changed =
        s2.contentLen !== s1.contentLen || s2.partsLen !== s1.partsLen || s2.created !== s1.created;
      if (changed) return false;

    // 无变化 + 消息够老 = 真闲置
    const age = Date.now() - s2.created;
    return age > quietThresholdMs;
    } catch {
      return true; // 检测失败保守算闲置（宁可发也不漏）
    }
  }
}
