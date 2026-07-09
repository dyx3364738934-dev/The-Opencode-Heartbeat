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

import { execSync } from "node:child_process";

export class Injector {
  constructor(config = {}) {
    this.serverConfig = null; // { port, auth, base, headers }
    this.sessionId = config.sessionId ?? null; // 锁定 session（null=自动找最新）
    this.lastAssistantTime = 0; // 用于区分新旧消息
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.pollTimeoutMs = config.pollTimeoutMs ?? 180000; // 单次等待最长 3 分钟
    this.stableThreshold = config.stableThreshold ?? 3; // 文本稳定几轮判完成
  }

  /**
   * 发现 oc server：从环境变量继承密码 + netstat 找端口
   */
  async discover() {
    if (this.serverConfig) return this.serverConfig;

    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) {
      throw new Error("OPENCODE_SERVER_PASSWORD 未设置（需在 oc 桌面版环境内运行）");
    }
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    const headers = { "Content-Type": "application/json", Authorization: auth };

    // 端口发现
    const envPort = parseInt(process.env.OPENCODE_SERVER_PORT);
    if (envPort > 0 && (await this._tryPort(envPort, headers))) {
      this.serverConfig = {
        port: envPort,
        auth,
        base: `http://127.0.0.1:${envPort}`,
        headers,
      };
      return this.serverConfig;
    }

    // netstat 找 OpenCode.exe 的监听端口
    const candidates = this._findPortsByProcess("OpenCode.exe");
    for (const p of candidates) {
      if (await this._tryPort(p, headers)) {
        this.serverConfig = { port: p, auth, base: `http://127.0.0.1:${p}`, headers };
        return this.serverConfig;
      }
    }

    throw new Error("找不到 opencode server");
  }

  _findPortsByProcess(processName) {
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
        signal: AbortSignal.timeout(2000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  /**
   * 找最新 session（或返回锁定的 session）
   */
  async resolveSession() {
    const { base, headers } = await this.discover();

    if (this.sessionId) {
      // 验证锁定的 session 是否还存在
      try {
        const r = await fetch(`${base}/session/${this.sessionId}`, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok) return this.sessionId;
      } catch {}
    }

    // 列所有 session，取 time.updated 最大的
    const r = await fetch(`${base}/session`, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`GET /session HTTP ${r.status}`);
    const sessions = await r.json();
    if (!sessions.length) throw new Error("没有任何 session");

    sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
    this.sessionId = sessions[0].id;
    this.lastAssistantTime = await this._getLastAssistantTime();
    return this.sessionId;
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
   * 注入一条消息（异步，立即返回）
   */
  async inject(text) {
    const { base, headers } = await this.discover();
    const sid = await this.resolveSession();

    const body = JSON.stringify({ parts: [{ type: "text", text }] });
    const r = await fetch(`${base}/session/${sid}/prompt_async`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (r.status !== 204 && !r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`prompt_async HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    return true;
  }

  /**
   * 注入并等待回复
   * @returns {Promise<{text, reasoning, state, created, parts}>}
   */
  async injectAndWait(text, onProgress = null) {
    // 注入前记录基准时间
    const beforeTime = this.lastAssistantTime;
    await this.inject(text);

    // 轮询等待新回复
    const reply = await this._poll(beforeTime, onProgress);
    this.lastAssistantTime = reply.created;
    return reply;
  }

  async _poll(sinceCreated, onProgress) {
    const { base, headers } = await this.discover();
    const sid = this.sessionId;
    const start = Date.now();
    let stableCount = 0;
    let lastText = "";

    while (Date.now() - start < this.pollTimeoutMs) {
      await sleep(this.pollIntervalMs);
      try {
        const r = await fetch(`${base}/session/${sid}/message?limit=3`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) continue;
        const msgs = await r.json();
        if (!Array.isArray(msgs) || !msgs.length) continue;

        // 找最新的 assistant 消息
        let latest = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].info?.role === "assistant") {
            latest = msgs[i];
            break;
          }
        }
        if (!latest) continue;

        const created = latest.info?.time?.created || 0;
        if (created <= sinceCreated) continue; // 旧消息

        const state = latest.info?.state || "";
        const text = (latest.parts || [])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
        const reasoning = (latest.parts || [])
          .filter((p) => p.type === "reasoning" || p.type === "thinking")
          .map((p) => p.text)
          .join("");

        const stateDone = state === "completed" || state === "error" || state === "aborted";

        if (onProgress) onProgress({ state, textLen: text.length, elapsed: Date.now() - start });

        if (stateDone) {
          return { text, reasoning, state, created, parts: latest.parts };
        }

        // 文本稳定判断（防 state 不更新）
        if (text && text === lastText) {
          stableCount++;
          if (stableCount >= this.stableThreshold) {
            return { text, reasoning, state, created, parts: latest.parts };
          }
        } else {
          stableCount = 0;
          lastText = text;
        }
      } catch {}
    }
    throw new Error(`轮询超时 (${this.pollTimeoutMs / 1000}s)`);
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
