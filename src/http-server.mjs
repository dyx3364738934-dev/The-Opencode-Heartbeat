/**
 * src/http-server.mjs
 *
 * furina HTTP API server（v0.4 新增）
 *
 * 让 oc 能调 furina 工具集，实现自我迭代闭环
 *
 * 端点：
 *   GET  /status          furina 当前状态
 *   POST /inject          主动注入消息
 *   POST /switch-session  切换 session
 *   POST /set-preset      改配置
 *   POST /recall          手动 recall
 *   POST /summarize       触发压缩
 *   POST /memory-set      设置 recentRecall（冬蕴雪手动记忆）
 *   POST /restart-furina  优雅重启 furina
 *   POST /restart-oc      重启 oc
 *   GET  /heartbeat       furina 心跳
 *   GET  /presets         读所有配置
 *
 * 认证：Basic auth（用 oc-password.txt 的密码）
 */

import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const PASSWORD_FILE = join(PROJECT_ROOT, "logs", "oc-password.txt");

export class FurinaHTTPServer {
  constructor({ injector, queue, memory, presets, workflowPresets, port = 9999 }) {
    this.injector = injector;
    this.queue = queue;
    this.memory = memory;
    this.presets = presets;
    this.workflowPresets = workflowPresets || null;
    this.port = port;
    this.server = null;
  }

  /**
   * v0.4: 启动 HTTP server（默认 9999 端口）
   */
  start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.listen(this.port, "127.0.0.1", () => {
      console.log(`[furina-http] HTTP server 已启动: http://127.0.0.1:${this.port}/`);
      console.log(`[furina-http] oc 可以调工具集了（v0.4 自迭代）`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * 读 oc-password.txt 拿密码做 Basic auth 验证
   */
  _checkAuth(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Basic ")) return false;
    if (!existsSync(PASSWORD_FILE)) return false;
    try {
      const data = JSON.parse(readFileSync(PASSWORD_FILE, "utf-8"));
      const expected = "Basic " + Buffer.from(`opencode:${data.password}`).toString("base64");
      return auth === expected;
    } catch {
      return false;
    }
  }

  async _handle(req, res) {
    // 认证
    if (!this._checkAuth(req)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // 路由
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;

    // 解析 body
    let body = null;
    if (method === "POST" || method === "PUT") {
      body = await this._readBody(req);
    }

    try {
      const response = await this._route(method, path, body);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response, null, 2));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  /**
   * v0.4: 获取 oc 连接配置（不阻塞事件循环）
   * 优先用缓存，无缓存用异步端口探测
   */
  async _getOcConfig() {
    if (this.injector.serverConfig) {
      return this.injector.serverConfig;
    }
    const pwdData = this.injector._readPasswordFile();
    if (!pwdData?.password) {
      throw new Error("密码文件不可用，oc 可能未启动");
    }
    const ports = await this.injector._findPortsByProcessAsync("OpenCode.exe");
    if (ports.length === 0) {
      throw new Error("oc 进程无监听端口，oc 可能未启动");
    }
    const port = ports[ports.length - 1];
    const auth = "Basic " + Buffer.from(`opencode:${pwdData.password}`).toString("base64");
    const headers = { "Content-Type": "application/json", Authorization: auth };
    return { port, auth, base: `http://127.0.0.1:${port}`, headers };
  }

  async _readBody(req) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  async _route(method, path, body) {
    // GET 路由
    if (method === "GET" && path === "/status") {
      return {
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        session: this.injector.sessionId,
        queue: this.queue.getStats(),
        memory: this.memory.getStats(),
        presets_mode: this.presets.get("mode"),
      };
    }

    if (method === "GET" && path === "/heartbeat") {
      return { alive: true, ts: Date.now() };
    }

    if (method === "GET" && path === "/presets") {
      return this.presets.get();
    }

    if (method === "GET" && path === "/session") {
      return { sessionId: this.injector.sessionId };
    }

    // POST 路由
    if (method === "POST" && path === "/inject") {
      if (!body?.text) throw new Error("inject 需要 { text }");
      // 只推队列，由 dispatch 统一注入（避免双重注入）
      this.queue.push("http", "manual.inject", { text: body.text, intent: body.intent, source: body.source }, 80);
      return { ok: true, msg: "已推入队列" };
    }

    // v0.5: 自由注入 -- 不进队列，silent 模式，oc 自由控制
    // POST /inject/intent  body = { text, intent?, source?, silent? }
    if (method === "POST" && path === "/inject/intent") {
      if (!body?.text) throw new Error("inject/intent 需要 { text }");
      const opts = {
        intent: body.intent || "user",
        source: body.source || "http",
      };
      const ok = await this.injector.silentInject(body.text, opts);
      return { ok, intent: opts.intent, source: opts.source, msg: "silent 注入完成（不进 dispatch，不写记忆）" };
    }

    if (method === "POST" && path === "/switch-session") {
      if (!body?.sessionId) throw new Error("switch-session 需要 { sessionId }");
      this.injector.sessionId = body.sessionId;
      this.injector.lastAssistantTime = 0;
      this.injector.saveSession(body.sessionId);
      return { ok: true, sessionId: body.sessionId };
    }

    if (method === "POST" && path === "/set-preset") {
      if (!body?.key) throw new Error("set-preset 需要 { key, value }");
      const ok = this.presets.set(body.key, body.value);
      return { ok, key: body.key, value: body.value };
    }

    if (method === "POST" && path === "/recall") {
      const query = body?.query || null;
      const last = body?.last || "1h";
      const result = await this.memory.recall(query, { last });
      if (result) {
        this.memory.setRecentRecall(result);
        return { ok: true, length: result.length };
      }
      return { ok: false, msg: "no result" };
    }

    if (method === "POST" && path === "/summarize") {
      const ok = await this.memory.checkpoint();
      return { ok };
    }

    if (method === "POST" && path === "/memory-set") {
      if (!body?.text) throw new Error("memory-set 需要 { text }");
      this.memory.setRecentRecall(body.text);
      return { ok: true, length: body.text.length };
    }

    if (method === "POST" && path === "/restart-furina") {
      // 优雅重启：让 watchdog 拉起新 furina
      const reason = body?.reason || "oc 通过 tool 请求重启";
      console.log(`[furina-http] restart-furina: ${reason}`);
      // 写一个标志文件让 watchdog 检测（如果 watchdog 逻辑支持）
      // 或：直接 process.exit(0) 让 watchdog 兜底
      setTimeout(() => process.exit(0), 500);
      return { ok: true, msg: "furina 将在 500ms 后退出，watchdog 会拉起新实例" };
    }

    if (method === "POST" && path === "/restart-oc") {
      // v0.4: 重启 oc（furina 内部 watchdog 拉起 oc）
      const reason = body?.reason || "oc 通过 tool 请求重启自己";
      console.log(`[furina-http] restart-oc: ${reason}`);
      try {
        execSync("taskkill /F /IM OpenCode.exe", { encoding: "utf-8" });
        return { ok: true, msg: "已 kill oc，furina watchdog 会拉起新实例" };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    // ============================================================
    // v0.4: 对话管理端点（agent 集群基础）
    // ============================================================

    // 列所有对话
    if (method === "GET" && path === "/sessions") {
      console.log("[furina-http] /sessions 请求");
      const oc = await this._getOcConfig();
      console.log(`[furina-http] oc config: port=${oc.port} base=${oc.base}`);
      const r = await fetch(`${oc.base}/session`, { headers: oc.headers, signal: AbortSignal.timeout(10000) });
      console.log(`[furina-http] oc /session 响应: ${r.status}`);
      if (!r.ok) throw new Error(`GET /session HTTP ${r.status}`);
      const text = await r.text();
      console.log(`[furina-http] session 文本长度: ${text.length}`);
      const sessions = JSON.parse(text);
      return {
        count: sessions.length,
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          model: s.model?.id,
          updated: s.time?.updated,
          tokens: s.tokens?.input,
        })),
      };
    }

    // 新开对话
    if (method === "POST" && path === "/session/create") {
      const title = body?.title || "furina-agent";
      const { base, headers } = await this._getOcConfig();
      const r = await fetch(`${base}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`POST /session HTTP ${r.status}`);
      const session = JSON.parse(await r.text());
      console.log(`[furina-http] 新建对话: ${session.id} (title="${title}")`);
      return { ok: true, sessionId: session.id, title: session.title };
    }

    // 读对话消息内容
    if (method === "GET" && path === "/session/messages") {
      const sid = body?.sessionId || this.injector.sessionId;
      const limit = body?.limit || 20;
      const { base, headers } = await this._getOcConfig();
      const r = await fetch(`${base}/session/${sid}/message?limit=${limit}`, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`GET /message HTTP ${r.status}`);
      const msgs = JSON.parse(await r.text());
      return {
        sessionId: sid,
        count: msgs.length,
        messages: msgs.map((m) => ({
          role: m.info?.role,
          state: m.info?.state,
          created: m.info?.time?.created,
          text: (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("").slice(0, 500),
        })),
      };
    }

    // 发任务给指定对话（不切换 furina 的锁定 session）
    if (method === "POST" && path === "/session/send") {
      if (!body?.sessionId) throw new Error("需要 { sessionId, text }");
      if (!body?.text) throw new Error("需要 { text }");
      const { base, headers } = await this._getOcConfig();
      const r = await fetch(`${base}/session/${body.sessionId}/prompt_async`, {
        method: "POST",
        headers,
        body: JSON.stringify({ parts: [{ type: "text", text: body.text }] }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.status !== 204 && !r.ok) throw new Error(`prompt_async HTTP ${r.status}`);
      return { ok: true, sessionId: body.sessionId, msg: "已发送" };
    }

    // 切换 furina 锁定的对话
    if (method === "POST" && path === "/session/switch") {
      if (!body?.sessionId) throw new Error("需要 { sessionId }");
      this.injector.sessionId = body.sessionId;
      this.injector.lastAssistantTime = 0;
      this.injector.saveSession(body.sessionId);
      return { ok: true, sessionId: body.sessionId };
    }

    // 列所有 provider 和模型
    if (method === "GET" && path === "/providers") {
      const { base, headers } = await this._getOcConfig();
      const r = await fetch(`${base}/provider`, { headers, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`GET /provider HTTP ${r.status}`);
      const data = JSON.parse(await r.text());
      const providers = (data.all || []).map((p) => ({
        id: p.id,
        name: p.name,
        models: Object.keys(p.models || {}).map((mid) => ({
          id: mid,
          name: p.models[mid].name,
        })),
      }));
      return { count: providers.length, providers };
    }

    // 触发工作汇报
    if (method === "POST" && path === "/worklog/generate") {
      // worklog 实例通过构造器传入或全局引用
      // 暂时用 control channel 的方式触发
      return { ok: true, msg: "worklog 由定时器自动生成，路径 logs/work-reports/" };
    }

    // ============================================================
    // v0.4: agent 集群端点
    // ============================================================

    // 创建 agent 集群（批量新开对话 + 发任务）
    if (method === "POST" && path === "/cluster/create") {
      if (!body?.tasks || !Array.isArray(body.tasks)) {
        throw new Error("需要 { tasks: [{title, text, model?}, ...] }");
      }
      const oc = await this._getOcConfig();
      const results = [];
      for (const task of body.tasks) {
        try {
          // 新开对话
          const createR = await fetch(`${oc.base}/session`, {
            method: "POST",
            headers: oc.headers,
            body: JSON.stringify({ title: task.title || "furina-agent" }),
            signal: AbortSignal.timeout(8000),
          });
          if (!createR.ok) throw new Error(`POST /session HTTP ${createR.status}`);
          const session = JSON.parse(await createR.text());
          // 发任务
          if (task.text) {
            const sendR = await fetch(`${oc.base}/session/${session.id}/prompt_async`, {
              method: "POST",
              headers: oc.headers,
              body: JSON.stringify({ parts: [{ type: "text", text: task.text }] }),
              signal: AbortSignal.timeout(30000),
            });
            if (sendR.status !== 204 && !sendR.ok) throw new Error(`prompt_async HTTP ${sendR.status}`);
          }
          results.push({ ok: true, sessionId: session.id, title: session.title });
          console.log(`[furina-http] 集群 agent 创建: ${session.id} (title="${task.title}")`);
        } catch (e) {
          results.push({ ok: false, title: task.title, error: e.message });
        }
      }
      return { count: results.length, results };
    }

    // 收集集群所有对话的最新回复
    if (method === "POST" && path === "/cluster/collect") {
      if (!body?.sessionIds || !Array.isArray(body.sessionIds)) {
        throw new Error("需要 { sessionIds: [...] }");
      }
      const oc = await this._getOcConfig();
      const results = [];
      for (const sid of body.sessionIds) {
        try {
          const r = await fetch(`${oc.base}/session/${sid}/message?limit=1`, {
            headers: oc.headers,
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const msgs = JSON.parse(await r.text());
          const latest = msgs[msgs.length - 1];
          results.push({
            sessionId: sid,
            ok: true,
            role: latest?.info?.role,
            state: latest?.info?.state,
            text: (latest?.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("").slice(0, 500),
          });
        } catch (e) {
          results.push({ sessionId: sid, ok: false, error: e.message });
        }
      }
      return { count: results.length, results };
    }

    // ============================================================
    // v0.4: 预设工作流端点
    // ============================================================

    // 列所有预设
    if (method === "GET" && path === "/workflow/list") {
      if (!this.workflowPresets) throw new Error("workflow 预设系统未启用");
      return {
        current: this.workflowPresets.getCurrent(),
        presets: this.workflowPresets.list(),
      };
    }

    // 应用预设（往当前 session 注入 persona 切换消息）
    if (method === "POST" && path === "/workflow/apply") {
      if (!this.workflowPresets) throw new Error("workflow 预设系统未启用");
      if (!body?.preset) throw new Error("需要 { preset }");
      const result = this.workflowPresets.apply(body.preset);
      if (result.ok) {
        // 推入队列，由 dispatch 注入
        this.queue.push("http", "manual.inject", { text: result.injectMessage }, 80);
      }
      return result;
    }

    // 获取当前预设
    if (method === "GET" && path === "/workflow/current") {
      if (!this.workflowPresets) throw new Error("workflow 预设系统未启用");
      return { current: this.workflowPresets.getCurrent() };
    }

    // 添加自定义预设
    if (method === "POST" && path === "/workflow/add") {
      if (!this.workflowPresets) throw new Error("workflow 预设系统未启用");
      if (!body?.id || !body?.preset) throw new Error("需要 { id, preset }");
      return this.workflowPresets.add(body.id, body.preset);
    }

    throw new Error(`404 Not Found: ${method} ${path}`);
  }
}