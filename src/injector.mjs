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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInjectMessage } from "./inject-intent.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const SESSION_LOCK = join(PROJECT_ROOT, "logs", "session.lock");

export class Injector {
  constructor(config = {}) {
    this.serverConfig = null; // { port, auth, base, headers }
    this.sessionId = config.sessionId ?? null; // 锁定 session（null=自动找最新）
    this.lastAssistantTime = 0; // 用于区分新旧消息
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.pollTimeoutMs = config.pollTimeoutMs ?? 180000; // 单次等待最长 3 分钟
    this.persistSession = config.persistSession ?? true; // 是否持久化 session 锁定
    this._lastInjectedText = null; // 记录最后注入的文本（ping 重发用）
    this.onOCRestarted = config.onOCRestarted || null; // v0.4: oc 重启回调（端口变化时触发）
  }

  // ============================================================
  // v0.4: 密码主动匹配 + oc 拉起（watchdog 融入 furina）
  // ============================================================

  /**
   * v0.4: 主动轮询密码匹配
   * 等 oc-password.txt 出现且密码有效（verify_server 通过）
   * 不依赖 health monitor 的 30s tick，furina 启动时直接用
   */
  async waitForPassword(maxWaitMs = 120000) {
    const start = Date.now();
    let lastErr = "";
    while (Date.now() - start < maxWaitMs) {
      const pwdData = this._readPasswordFile();
      if (pwdData?.password) {
        const ports = await this._findPortsByProcessAsync("OpenCode.exe");
        if (ports.length > 0) {
          for (const port of ports) {
            const auth = "Basic " + Buffer.from(`opencode:${pwdData.password}`).toString("base64");
            if (await this._tryPort(port, { Authorization: auth })) {
              const username = pwdData.username || "opencode";
              const headers = { "Content-Type": "application/json", Authorization: auth };
              this.serverConfig = { port, auth, base: `http://127.0.0.1:${port}`, headers };
              console.log(`[injector] 密码匹配成功 (port=${port}, age=${Math.round((Date.now() - (pwdData.leakedAt || 0)) / 1000)}s)`);
              return this.serverConfig;
            }
          }
          lastErr = `密码验证失败（${ports.length} 个端口都不通，密码可能过期）`;
        } else {
          lastErr = "oc 进程无监听端口（启动中？）";
        }
      } else {
        lastErr = "密码文件不存在或无效（plugin 还没泄露）";
      }
      await sleep(2000);
    }
    throw new Error(`密码匹配超时 (${maxWaitMs / 1000}s): ${lastErr}`);
  }

  _readPasswordFile() {
    const pwdFile = SESSION_LOCK.replace("session.lock", "oc-password.txt");
    if (!existsSync(pwdFile)) return null;
    try {
      return JSON.parse(readFileSync(pwdFile, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * v0.4: 检测 oc 进程是否在线（同步版，短阻塞，仅用于非热路径）
   */
  isOCRunning() {
    return this._findPortsByProcess("OpenCode.exe").length > 0;
  }

  /**
   * v0.4: 检测 oc 进程是否在线（异步版，不阻塞事件循环）
   */
  async isOCRunningAsync() {
    const ports = await this._findPortsByProcessAsync("OpenCode.exe");
    return ports.length > 0;
  }

  /**
   * v0.4: 拉起 oc 桌面版（watchdog 职责融入 furina）
   */
  spawnOC() {
    const { LOCALAPPDATA } = process.env;
    const candidates = [
      join(LOCALAPPDATA || "", "Programs", "@opencode-aidesktop", "OpenCode.exe"),
      join(LOCALAPPDATA || "", "Programs", "@opencode-ai", "desktop", "OpenCode.exe"),
      join(LOCALAPPDATA || "", "OpenCode", "OpenCode.exe"),
    ];
    const exe = candidates.find((p) => existsSync(p));
    if (!exe) {
      console.error("[injector] 找不到 OpenCode.exe");
      return false;
    }
    try {
      spawn(exe, [], { cwd: dirname(exe), detached: true, stdio: "ignore" }).unref();
      console.log(`[injector] oc 已拉起: ${exe}`);
      return true;
    } catch (e) {
      console.error(`[injector] 拉起 oc 失败: ${e.message}`);
      return false;
    }
  }

  /**
   * v0.4: 确保 oc 在线 + 密码匹配（冷启动入口）
   * 如果 oc 不在 -> spawn -> 等密码
   */
  async ensureOCAndDiscover() {
    if (!this.isOCRunning()) {
      console.log("[injector] oc 不在线，拉起...");
      this.spawnOC();
    }
    return await this.waitForPassword();
  }

  /**
   * 持久化 session 锁定到 logs/session.lock，重启 furina 时可恢复
   */
  saveSession(sid) {
    if (!this.persistSession) return;
    try {
      mkdirSync(dirname(SESSION_LOCK), { recursive: true });
      writeFileSync(SESSION_LOCK, JSON.stringify({ sessionId: sid, savedAt: Date.now() }, null, 2));
    } catch (e) {
      console.warn(`[injector] 保存 session.lock 失败: ${e.message}`);
    }
  }

  /**
   * 从 logs/session.lock 恢复 session 锁定
   * @returns {string|null} sessionId 或 null（lock 不存在/无效/已被 oc 清理）
   */
  loadSession() {
    if (!this.persistSession) return null;
    if (!existsSync(SESSION_LOCK)) return null;
    try {
      const data = JSON.parse(readFileSync(SESSION_LOCK, "utf-8"));
      if (!data?.sessionId) return null;
      // 检查新鲜度：超过 7 天的 lock 视为过期
      if (Date.now() - (data.savedAt || 0) > 7 * 24 * 3600 * 1000) {
        console.warn(`[injector] session.lock 过期 (${Math.round((Date.now() - data.savedAt) / 86400000)}d)`);
        return null;
      }
      return data.sessionId;
    } catch (e) {
      console.warn(`[injector] 读 session.lock 失败: ${e.message}`);
      return null;
    }
  }

  /**
   * v0.4: 发现 oc server
   * 改为主动匹配：oc 不在就拉起，轮询密码直到有效
   * 不再依赖被动等 plugin 泄露 + health monitor 30s tick
   */
  async discover() {
    if (this.serverConfig) return this.serverConfig;
    return await this.ensureOCAndDiscover();
  }

  /**
   * v0.4: 异步版 _findPortsByProcess（不阻塞事件循环）
   * 用 execFile + Promise 替代 execSync
   */
  _findPortsByProcessAsync(processName) {
    return new Promise((resolve) => {
      let ns = "", tl = "";
      let done = 0;
      const check = () => {
        done++;
        if (done < 2) return;
        const ports = [];
        try {
          const pids = new Set();
          for (const m of tl.matchAll(new RegExp(`"${processName.replace(/\./g, "\\.")}","(\\d+)"`, "g"))) {
            pids.add(parseInt(m[1]));
          }
          for (const m of ns.matchAll(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)/gm)) {
            if (pids.has(parseInt(m[2]))) ports.push(parseInt(m[1]));
          }
        } catch {}
        resolve(ports);
      };
      execFile("netstat", ["-ano"], { encoding: "utf-8", timeout: 8000, windowsHide: true }, (err, stdout) => {
        ns = stdout || "";
        check();
      });
      execFile("tasklist", ["/FI", `IMAGENAME eq ${processName}`, "/FO", "CSV", "/NH"], { encoding: "utf-8", timeout: 5000, windowsHide: true }, (err, stdout) => {
        tl = stdout || "";
        check();
      });
    });
  }

  _findPortsByProcess(processName) {
    // 保留同步版供 isOCRunning 用（内部调用，可接受短阻塞）
    const ports = [];
    try {
      const ns = execSync("netstat -ano", { encoding: "utf-8", timeout: 8000, windowsHide: true });
      const tl = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`, {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      const pids = new Set();
      for (const m of tl.matchAll(new RegExp(`"${processName.replace(/\./g, "\\.")}","(\\d+)"`, "g"))) {
        pids.add(parseInt(m[1]));
      }
      for (const m of ns.matchAll(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)/gm)) {
        if (pids.has(parseInt(m[2]))) ports.push(parseInt(m[1]));
      }
    } catch {}
    return ports;
  }

  async _tryPort(port, headers) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/global/health`, {
        headers: { Authorization: headers.Authorization },
        signal: AbortSignal.timeout(8000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  /**
   * 找最新 session（或返回锁定的 session）
   * 
   * 默认创建/使用 title="furina-autonomous" 的专用 session，
   * 避免注入消息干扰用户当前 session。
   * 可通过 sessionId 参数锁定到其他 session。
   */
  /**
   * v0.4: 解析 session
   * 锁定到固定 session ID（从 session.lock 或构造参数读），不自动找最新
   * 如果锁定的 session 不存在了（被 oc 清理），才回退找最新
   */
  async resolveSession() {
    const { base, headers } = await this.discover();

    // 优先用已锁定的 sessionId
    let sid = this.sessionId || this.loadSession();

    if (sid) {
      // 验证锁定的 session 是否还存在
      try {
        const r = await fetch(`${base}/session/${sid}`, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          this.sessionId = sid;
          this.saveSession(sid);
          this.lastAssistantTime = await this._getLastAssistantTime();
          return sid;
        }
      } catch {}
      // 锁定的 session 不在了，回退找最新
      console.warn(`[injector] 锁定的 session ${sid} 不存在，回退找最新`);
    }

    // 回退：列所有 session，找最新 updated 的
    const r = await fetch(`${base}/session`, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`GET /session HTTP ${r.status}`);
    const sessions = await r.json();

    if (!Array.isArray(sessions) || sessions.length === 0) {
      throw new Error("oc 无可用 session");
    }

    const sorted = sessions
      .filter((s) => s.time?.updated)
      .sort((a, b) => (b.time.updated || 0) - (a.time.updated || 0));

    if (sorted.length === 0) {
      throw new Error("所有 session 无 updated 时间戳");
    }

    const latest = sorted[0];
    console.log(`[injector] 定位最新 session: ${latest.id} (title="${latest.title}")`);
    this.sessionId = latest.id;
    this.saveSession(latest.id);
    this.lastAssistantTime = await this._getLastAssistantTime();
    return latest.id;
  }

  async _getLastAssistantTime() {
    const { base, headers } = await this.discover();
    const sid = this.sessionId;
    if (!sid) return 0;
    try {
      const r = await fetch(`${base}/session/${sid}/message?limit=5`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return 0;
      const msgs = await r.json();
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].info?.role === "assistant") {
          return msgs[i].info?.time?.created || 0;
        }
      }
    } catch {}
    return 0;
  }

  /**
   * v0.5: silent 注入 -- 只发到 oc，不进 dispatch 队列，不等回复，不写记忆
   * 用于 agent 内部通讯（oc 派给自己的任务、agent 集群通知、系统级消息）
   * v0.5.1: 失败时重试 2 次（避免瞬时网络抖动）
   * v0.5.2: 不重置 serverConfig（避免触发 health monitor 的 onOCRestarted 误判）
   * @param {string} text
   * @param {object} opts - 同 inject
   * @returns {Promise<boolean>}
   */
  async silentInject(text, opts = {}) {
    const MAX_RETRY = 2;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        return await this.inject(text, { ...opts, skipLog: false });
      } catch (e) {
        const isLast = attempt === MAX_RETRY;
        console.error(`[injector] silentInject 失败 (第 ${attempt + 1}/${MAX_RETRY + 1} 次): ${e.message?.slice(0, 100)}`);
        if (isLast) return false;
        // 只 sleep 重试，不重置 serverConfig（让 health monitor 自己处理）
        await sleep(1500);
      }
    }
    return false;
  }

  /**
   * 注入一条消息（异步，立即返回）
   * v0.5: 支持意图系统 opts = { intent, source, customPrefix, customWrap, skipLog }
   * @param {string} text - 要注入的正文
   * @param {object} opts - { intent?: string, source?: string, customPrefix?: fn, customWrap?: fn, skipLog?: boolean }
   * @returns {Promise<boolean>}
   */
  async inject(text, opts = {}) {
    const { base, headers } = await this.discover();
    const sid = await this.resolveSession();

    // v0.5: 渲染消息（按 intent 包装 + agent-hint 前缀）
    const rendered = renderInjectMessage(text, opts);
    const body = JSON.stringify({ parts: [{ type: "text", text: rendered }] });

    if (!opts.skipLog) {
      const intent = opts.intent || "user";
      const source = opts.source || "unknown";
      console.log(`[injector] inject intent=${intent} source=${source} textLen=${rendered.length}`);
    }

    // v0.2.1: oc backlog 时 prompt_async 响应可能超过 10s，延长到 30s
    const r = await fetch(`${base}/session/${sid}/prompt_async`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (r.status !== 204 && !r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`prompt_async HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    return true;
  }

  /**
   * 注入并等待回复（v0.2.1: inject 失败不阻塞，fire-and-forget 模式）
   * v0.5: 支持 opts 透传给 inject（intent/source/...）
   *
   * 流程：
   *   1. fire-and-forget 调 prompt_async（不等返回，避免 oc backlog 阻塞）
   *   2. 立即进入 _poll 等 oc 处理
   *
   * 即使 inject 因为 oc backlog 30s+ 超时，消息可能已被 oc 内部接受
   * （oc prompt_async 在 backlog 时会排队），_poll 仍能找到对应回复
   */
  async injectAndWait(text, onProgress = null, opts = {}) {
    const beforeTime = this.lastAssistantTime;
    this._lastInjectedText = text; // 记录最后注入文本（poll 重新 inject 时用）
    console.log(`[injector] injectAndWait 开始, intent=${opts.intent || "user"}, text len=${text.length}`);
    // v0.2.1: fire-and-forget inject，30s 后还没返回就放弃 await，但继续 _poll
    let injectSubmitted = false;
    try {
      await Promise.race([
        this.inject(text, opts).then(() => { injectSubmitted = true; }),
        sleep(30000).then(() => { throw new Error("inject race timeout 30s"); }),
      ]);
      console.log(`[injector] inject OK, 进入 _poll`);
    } catch (e) {
      console.error(`[injector] inject 超时/失败但继续 _poll (submitted=${injectSubmitted}): ${e.message?.slice(0, 200)}`);
      // 不 throw，继续 _poll（消息可能已被 oc 接受或在内部排队）
    }

    try {
      const reply = await this._poll(beforeTime, onProgress);
      this.lastAssistantTime = reply.created;
      console.log(`[injector] _poll 返回 state=${reply.state} text_len=${reply.text?.length || 0}`);
      return reply;
    } catch (e) {
      console.error(`[injector] _poll 抛错: ${e.message?.slice(0, 200)}`);
      throw e;
    }
  }

  /**
   * v0.4: health check loop
   * - oc 进程不在 -> spawnOC 主动拉起
   * - oc 在但 health 请求失败 -> 重置 serverConfig + 重读密码
   * - oc 在且 health OK -> 正常
   */
  startHealthMonitor(intervalMs = 15000) {
    if (this._healthTimer) return; // 已启动
    let _spawnCooldown = 0; // 防止反复 spawn
    let _rediscoverInProgress = false; // 防止并发 discover
    let _lastKnownPort = this.serverConfig?.port || null; // 记录端口变化
    const tick = async () => {
      // v0.4: 先检测 oc 进程是否在线（异步，不阻塞事件循环）
      // 重试 2 次避免 execFile 偶尔失败导致误判
      let ocOnline = false;
      for (let i = 0; i < 2; i++) {
        if (await this.isOCRunningAsync()) { ocOnline = true; break; }
        if (i === 0) await sleep(500);
      }
      if (!ocOnline) {
        const now = Date.now();
        if (now - _spawnCooldown < 60000) return; // 1 分钟内不重复 spawn
        _spawnCooldown = now;
        console.warn("[injector] health: oc 进程不在线（2 次确认），主动拉起");
        this.serverConfig = null;
        this.spawnOC();
        return;
      }
      // oc 进程在，检测 serverConfig 是否有效
      if (!this.serverConfig) {
        // serverConfig 被重置后，主动重新匹配密码+端口
        if (_rediscoverInProgress) return;
        _rediscoverInProgress = true;
        try {
          console.log("[injector] health: serverConfig 为空，主动重新匹配...");
          await this.waitForPassword(15000);
          console.log("[injector] health: 重新匹配成功");
          const newPort = this.serverConfig?.port;
          if (newPort && newPort !== _lastKnownPort) {
            console.log(`[injector] health: 端口变化 ${_lastKnownPort} -> ${newPort}，触发 onOCRestarted`);
            _lastKnownPort = newPort;
            if (this.onOCRestarted) this.onOCRestarted(newPort);
          }
        } catch (e) {
          console.warn(`[injector] health: 重新匹配失败: ${e.message?.slice(0, 80)}`);
        } finally {
          _rediscoverInProgress = false;
        }
        return;
      }
      // serverConfig 存在，用端口探测检测 oc 是否还在（不 fetch，避免连接池耗尽）
      // 重试 2 次避免 execFile 偶尔失败
      let currentPorts = [];
      for (let i = 0; i < 2; i++) {
        currentPorts = await this._findPortsByProcessAsync("OpenCode.exe");
        if (currentPorts.length > 0) break;
        if (i === 0) await sleep(500);
      }
      if (currentPorts.length === 0) {
        // 2 次都无端口，oc 确实没了
        console.warn("[injector] health: 端口探测 2 次无结果，oc 已退出，主动拉起");
        this.serverConfig = null;
        const now = Date.now();
        if (now - _spawnCooldown < 60000) return;
        _spawnCooldown = now;
        this.spawnOC();
        return;
      }
      const currentPort = currentPorts[currentPorts.length - 1];
      if (currentPort !== this.serverConfig.port) {
        // 端口变了，重新匹配
        console.warn(`[injector] health: 端口变化 ${this.serverConfig.port} -> ${currentPort}，重新匹配`);
        this.serverConfig = null;
        this._refreshPasswordFromFile();
      }
      // 端口没变，serverConfig 仍然有效，不 fetch
    };
    this._healthTimer = setInterval(tick, intervalMs);
    console.log(`[injector] health check loop 已启动 (interval=${intervalMs}ms)`);
  }

  /**
   * v0.3.1: 从 oc-password.txt 读最新密码，覆盖 process.env
   * 让后续 discover 用最新密码
   */
  _refreshPasswordFromFile() {
    // v0.4: 此函数仅用于日志记录密码文件状态
    // discover/waitForPassword 直接读文件，不依赖 process.env
    try {
      const pwdFile = SESSION_LOCK.replace("session.lock", "oc-password.txt");
      if (existsSync(pwdFile)) {
        const data = JSON.parse(readFileSync(pwdFile, "utf-8"));
        if (data.password) {
          console.log(`[injector] 密码文件可用 (age=${Math.round((Date.now() - (data.leakedAt || 0)) / 1000)}s)`);
        }
      }
    } catch (e) {
      console.warn(`[injector] 读密码文件失败: ${e.message?.slice(0, 100)}`);
    }
  }

  stopHealthMonitor() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  /**
   * v0.4: 动态活动检测 _poll（替代固定软超时）
   *
   * 核心逻辑：
   *   - 内容长度在涨 = oc 活着，继续等（无上限）
   *   - 3 分钟无内容变化 = 发 ping 戳一下
   *   - 2 次 ping 后仍无变化 = 判定卡死
   *   - fetch 连续失败 30s = 判定 oc 死了
   *   - 60s 无新消息 = 重新 inject（可能 inject 丢了）
   *
   * state 探测日志：每次 poll 打 state+textLen+reasoningLen+contentLen+created
   * Koko 压缩上下文时可以观察 state 字段变化
   */
  async _poll(sinceCreated, onProgress) {
    const { base, headers } = await this.discover();
    const sid = this.sessionId;
    const start = Date.now();

    // 动态活动检测参数
    const PING_THRESHOLD_MS = 3 * 60 * 1000;     // 3 分钟无内容变化 -> ping
    const MAX_PINGS = 2;                           // ping 2 次还不动 -> 判定卡死
    const FETCH_FAIL_THRESHOLD_MS = 30 * 1000;    // fetch 连续失败 30s -> oc 死
    const NO_MSG_REINJECT_MS = 60 * 1000;         // 60s 无新消息 -> 重新 inject
    const FETCH_TIMEOUT_MS = 15000;                // 单次 fetch 超时

    let lastContentLen = 0;
    let lastChangeTime = Date.now();
    let pingCount = 0;
    let fetchFailStart = 0;
    let noMsgStart = 0;
    let stableCount = 0;
    const STABLE_THRESHOLD = 5; // 内容连续 5 次 poll（约 10s）不变 = 视为完成

    while (true) {
      await sleep(this.pollIntervalMs);
      const elapsed = Date.now() - start;

      // === fetch oc message ===
      let r;
      try {
        r = await fetch(`${base}/session/${sid}/message?limit=3`, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        fetchFailStart = 0;
      } catch (e) {
        if (!fetchFailStart) fetchFailStart = Date.now();
        const failDur = Date.now() - fetchFailStart;
        console.warn(`[poll] fetch 失败 ${Math.round(failDur / 1000)}s: ${e.message?.slice(0, 80)}`);
        if (failDur > FETCH_FAIL_THRESHOLD_MS) {
          return { text: `[oc fetch 连续失败 ${Math.round(failDur / 1000)}s，判定死亡]`, reasoning: "", state: "fetch_dead", created: Date.now(), parts: [] };
        }
        continue;
      }

      if (!r.ok) {
        if (!fetchFailStart) fetchFailStart = Date.now();
        const failDur = Date.now() - fetchFailStart;
        if (failDur > FETCH_FAIL_THRESHOLD_MS) {
          return { text: `[oc HTTP ${r.status} 连续 ${Math.round(failDur / 1000)}s]`, reasoning: "", state: "http_error", created: Date.now(), parts: [] };
        }
        continue;
      }

      const msgs = await r.json().catch(() => []);
      if (!Array.isArray(msgs) || !msgs.length) continue;

      // 找最新 assistant message
      let latest = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].info?.role === "assistant") { latest = msgs[i]; break; }
      }
      if (!latest) continue;

      const created = latest.info?.time?.created || 0;
      const state = latest.info?.state || "";
      const text = (latest.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
      const reasoning = (latest.parts || []).filter((p) => p.type === "reasoning" || p.type === "thinking").map((p) => p.text).join("");
      const contentLen = text.length + reasoning.length;

      // === state 探测日志（Koko 压缩时观察 state 变化用）===
      console.log(`[poll] elapsed=${Math.round(elapsed / 1000)}s state="${state}" textLen=${text.length} reasoningLen=${reasoning.length} contentLen=${contentLen} created=${created}`);

      // 无新消息？（created <= sinceCreated 说明 inject 的消息还没被 oc 处理成 assistant 回复）
      if (created <= sinceCreated) {
        if (!noMsgStart) noMsgStart = Date.now();
        const noMsgDur = Date.now() - noMsgStart;
        if (noMsgDur > NO_MSG_REINJECT_MS) {
          console.warn(`[poll] ${Math.round(noMsgDur / 1000)}s 无新消息，重新 inject`);
          try {
            const body = JSON.stringify({ parts: [{ type: "text", text: this._lastInjectedText || "[furina] 确认状态" }] });
            await fetch(`${base}/session/${sid}/prompt_async`, { method: "POST", headers, body, signal: AbortSignal.timeout(30000) });
          } catch (e) {
            console.warn(`[poll] 重新 inject 失败: ${e.message?.slice(0, 80)}`);
          }
          noMsgStart = 0;
        }
        continue;
      }
      noMsgStart = 0;

      // 有新消息，检查内容变化
      if (contentLen > lastContentLen) {
        console.log(`[poll] 内容变化 ${lastContentLen} -> ${contentLen}，oc 活着`);
        lastContentLen = contentLen;
        lastChangeTime = Date.now();
        pingCount = 0;
        stableCount = 0; // 内容变了，重置稳定计数
      } else if (contentLen > 0 && contentLen === lastContentLen) {
        // 内容没变但有内容，累计稳定计数
        stableCount++;
        console.log(`[poll] 内容稳定 ${stableCount}/${STABLE_THRESHOLD} (contentLen=${contentLen})`);
        if (stableCount >= STABLE_THRESHOLD) {
          console.log(`[poll] 内容连续 ${STABLE_THRESHOLD} 次不变，视为完成`);
          return { text, reasoning, state: state || "stable", created, parts: latest.parts };
        }
      }

      if (onProgress) onProgress({ state, textLen: text.length, elapsed });

      // state 完成 -> 返回
      const stateDone = state === "completed" || state === "error" || state === "aborted";
      if (stateDone) {
        return { text, reasoning, state, created, parts: latest.parts };
      }

      // 内容无变化超时 -> ping 戳一下
      const staleTime = Date.now() - lastChangeTime;
      if (staleTime > PING_THRESHOLD_MS) {
        if (pingCount < MAX_PINGS) {
          pingCount++;
          console.warn(`[poll] ${Math.round(staleTime / 1000)}s 无内容变化，第 ${pingCount} 次 ping`);
          const pingText = `[furina ping] ${Math.round(staleTime / 1000)}s 无输出。如果正常请继续；如果卡住请回复状态。`;
          const body = JSON.stringify({ parts: [{ type: "text", text: pingText }] });
          // fire-and-forget ping（不嵌套 poll）
          fetch(`${base}/session/${sid}/prompt_async`, { method: "POST", headers, body, signal: AbortSignal.timeout(30000) }).catch(() => {});
          lastChangeTime = Date.now(); // 重置，给 oc 时间响应 ping
        } else {
          return { text: `[oc ${MAX_PINGS} 次 ping 后仍无响应，判定卡死]`, reasoning: "", state: "stale_dead", created: Date.now(), parts: [] };
        }
      }
    }
  }
  /**
   * 触发上下文压缩
   */
  async summarize() {
    const { base, headers } = await this.discover();
    const sid = await this.resolveSession();
    const r = await fetch(`${base}/session/${sid}/summarize`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30000),
    });
    return r.ok;
  }

  /**
   * 获取 session 消息数量（用于记忆区判断上下文长度）
   */
  async getMessageCount() {
    const { base, headers } = await this.discover();
    const sid = await this.resolveSession();
    try {
      const r = await fetch(`${base}/session/${sid}/message?limit=1`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return 0;
      const msgs = await r.json();
      return Array.isArray(msgs) ? msgs.length : 0;
    } catch {
      return 0;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
