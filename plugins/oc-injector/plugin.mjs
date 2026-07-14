/**
 * plugins/oc-injector/plugin.mjs
 *
 * v0.9: oc 注入器插件
 *
 * 职责：
 *   - 发现 oc 端口 + 密码匹配
 *   - 注入消息到 oc（inject / silentInject / injectAndWait）
 *   - 提供 dispatchHandler（事件队列调度器）
 *   - health monitor（检测 oc 重启 + 拉起 oc）
 *
 * 暴露给其他插件：
 *   ctx.korina.injector     -- Injector 实例
 *   ctx.korina.dispatchHandler -- 事件调度函数
 *   ctx.korina.inject       -- 便捷方法
 *   ctx.korina.silentInject -- 便捷方法
 */

import { Injector } from "../../src/injector.mjs";
import { renderInjectMessage } from "../../src/inject-intent.mjs";
import { LifelineRuntime } from "../../src/lifeline/lifeline-runtime.mjs";
import { LifelineRegistry } from "../../src/lifeline/lifeline-registry.mjs";

export default {
  name: "oc-injector",
  dependencies: [],

  async init(ctx) {
    const { queue, bus, presets, korina } = ctx;
    const mode = ctx.korina.mode || "worker";

    // v0.9.5.5: ARCH-001 调度器架构第二步
    // scheduler 模式：不直接和 oc 对话，只做路由
    // 跳过的部分：session 绑定、health monitor、dispatchHandler 设置
    if (mode === "scheduler") {
      ctx.log("scheduler 模式：跳过 oc session 绑定 + health monitor + dispatchHandler");
      ctx.log("  （scheduler 暂时不做路由——那是 v0.9.7+ 范围）");

      // 注册基础 /status + /binding 端点（universal，scheduler 模式也要能 health check）
      ctx.http.get("/status", () => ({
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        mode: "scheduler",
        session: null,
        ocBase: null,
        bindingLocked: false,
        queue: queue.getStats(),
        // v0.9.7 (manual #17): OC 链路健康（即使 scheduler 没真正和 oc 对话，也透出探测结果）
        ocReachable: korina.ocHealth ? korina.ocHealth.status() : null,
      }));
      ctx.http.get("/binding", () => ({
        ocBase: null,
        sessionId: null,
        bindingLocked: false,
        note: "scheduler 模式：无 oc 绑定",
      }));

      // 暴露 null injector 给需要 type 校验的调用方
      korina.injector = null;
      korina.bindingStore = null;
      korina.lifelineRegistry = new LifelineRegistry();
      korina.primaryLifeline = null;
      korina.sessionId = null;
      return { injector: null };
    }

    const injector = new Injector({
      pollIntervalMs: 2000,
      pollTimeoutMs: 180000,
      // v0.9.10 (L5.1 manual #34): port 透传给 Injector → SessionBindingStore，
      // session lock 文件按 port 命名（多实例独立 lock 文件）
      port: korina.port || 9999,
      onOCRestarted: async (newPort) => {
        bus.emit("oc.restarted", { newPort });
        // 续命消息注入逻辑（从 main.mjs 迁移）
        ctx.log(`oc 重启检测 (port=${newPort})，等 25 秒后注入续命消息...`);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        await sleep(25000);

        let targetPort = newPort;
        const ports = injector._findPortsByProcess("OpenCode.exe");
        if (ports.length > 0) {
          targetPort = ports[ports.length - 1];
        }

        const pwdData = injector._readPasswordFile();
        if (!pwdData?.password) {
          ctx.log("密码文件不可用，放弃续命注入");
          return;
        }
        const auth = "Basic " + Buffer.from(`opencode:${pwdData.password}`).toString("base64");
        const sid = injector.sessionId || injector.loadSession();

        const rendered = renderInjectMessage("你醒了。", { intent: "survival", source: "korina" });
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const body = JSON.stringify({ parts: [{ type: "text", text: rendered }] });
            const r = await fetch(`http://127.0.0.1:${targetPort}/session/${sid}/prompt_async`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: auth },
              body,
              signal: AbortSignal.timeout(30000),
            });
            if (r.status === 204 || r.ok) {
              ctx.log(`续命消息已注入 (第 ${attempt} 次成功)`);
              return;
            }
            throw new Error(`HTTP ${r.status}`);
          } catch (e) {
            ctx.log(`续命注入第 ${attempt} 次失败: ${e.message?.slice(0, 60)}`);
            if (attempt < 3) await sleep(5000);
          }
        }
      },
    });

    // 启动 health monitor
    injector.startHealthMonitor(15000);

    // 发现 oc + 解析 session
    ctx.log("等待 oc server 就绪...");
    const server = await retry(() => injector.discover(), "oc server", 60, 2000);
    ctx.log(`server: ${server.base}`);

    ctx.log("等待 session 就绪...");
    const sid = await retry(() => injector.resolveSession(), "session", 30, 2000);
    ctx.log(`session: ${sid}`);

    const primaryLifeline = new LifelineRuntime({
      id: "main",
      injector,
      bindingStore: injector.bindingStore,
      metadata: { owner: "oc-injector", mode },
    });
    const lifelineRegistry = new LifelineRegistry();
    lifelineRegistry.register(primaryLifeline, { primary: true });
    ctx.log(`lifeline registered: main -> ${primaryLifeline.primarySessionId?.slice(0, 16)}`);

    // v0.9.3: 支持热切换 — POST /rebind 重新绑定到最新 session，无需重启
    ctx.log(`🔒 绑定: oc=${injector.serverConfig?.base} session=${sid}`);
    ctx.log(`   POST /rebind 热切换到最新 session`);

    // POST /rebind — 热切换到最新 session
    ctx.http.post("/rebind", async () => {
      const oldSid = injector.sessionId;
      const newSid = await injector.resolveSession();
      korina.sessionId = newSid;
      injector.saveSession(newSid);
      ctx.log(`热切换: ${oldSid?.slice(0,16)} -> ${newSid?.slice(0,16)}`);
      return { ok: true, oldSession: oldSid?.slice(0,16), newSession: newSid?.slice(0,16) };
    });

    // v0.9.3: 多 session 绑定 — 每个 session 独立通道
    ctx.http.post("/bind-session", (body) => {
      if (!body?.sessionId) throw new Error("需要 sessionId");
      const result = injector.bindSession(body.sessionId);
      if (result.ok) korina.sessionId = result.sessionId;
      return result;
    });
    ctx.http.post("/unbind-session", (body) => {
      if (!body?.sessionId) throw new Error("需要 sessionId");
      const result = injector.unbindSession(body.sessionId);
      if (result.ok && injector.sessionId) korina.sessionId = injector.sessionId;
      return result;
    });
    ctx.http.get("/sessions/bound", () => ({
      primary: injector.sessionId,
      bound: injector.listBoundSessions(),
    }));

    // 暴露给其他插件
    korina.injector = injector;
    korina.bindingStore = injector.bindingStore;
    korina.lifelineRegistry = lifelineRegistry;
    korina.primaryLifeline = primaryLifeline;
    korina.inject = (text, opts) => injector.inject(text, opts);
    korina.silentInject = (text, opts) => injector.silentInject(text, opts);
    korina.injectAndWait = (text, onProgress, opts) => injector.injectAndWait(text, onProgress, opts);
    korina.sessionId = sid;
    korina.ocBase = injector.serverConfig?.base;
    // 锁定标志 -- /switch-session / 任何修改 sessionId 的端点会检查这个
    korina.bindingLocked = true;

    ctx.http.get("/lifelines", () => ({
      primary: lifelineRegistry.primaryId,
      lifelines: lifelineRegistry.list(),
    }));
    ctx.http.get("/lifelines/main", () => primaryLifeline.status());

    // dispatchHandler -- 事件队列调度器
    // 从队列取事件 -> 模式检测 -> 注入 oc -> SSE/TTS -> 记忆
    // 通过事件总线协调其他插件
    korina.dispatchHandler = async (event) => {
      // silent/idle/task 模式下 file.changed 静默忽略
      const currentMode = presets.get("mode") || "silent";
      if (event.type === "file.changed" && !["observe", "self-talk", "find-work"].includes(currentMode)) {
        return;
      }

      ctx.log(`[dispatch] ${event.source}/${event.type} (priority=${event.priority})`);

      // waitIdle 支持
      if (event.type === "manual.inject" && event.payload?.waitIdle) {
        const maxWait = event.payload.maxIdleWaitMs || 120000;
        const start = Date.now();
        let idle = await injector.isOCIdleAsync(event.payload?.sessionId, 30000);
        while (!idle && Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 10000));
          idle = await injector.isOCIdleAsync(event.payload?.sessionId, 30000);
        }
        if (!idle) {
          ctx.log(`waitIdle 超时，放弃注入: ${event.payload.text?.slice(0, 50)}`);
          return;
        }
      }

      const intent = event.payload?.intent || inferIntent(event);
      const source = event.payload?.source || event.source || "korina";
      let message = formatEventMessage(event);

      // 发布 beforeDispatch 事件（mode-router 订阅 -> 检测模式）
      await bus.emit("queue.beforeDispatch", { event, message });

      // 检查事件是否被 beforeDispatch 修改
      if (event._skip) return;
      message = event._modifiedMessage || message;

      ctx.log(`注入 intent=${intent} source=${source}: ${message.slice(0, 80)}...`);

      const targetSid = event.payload?.sessionId || injector.sessionId;
      const skipTTS = event.type === "timer.tick" || event.type === "file.changed";

      // 发布 dispatch 事件（sse-tts-pipeline / memory 订阅）
      const dispatchResult = await bus.emit("queue.dispatch", {
        event, message, intent, source, targetSid, skipTTS,
        injector,
      });

      // 如果没有插件处理 dispatch（比如 sse-tts-pipeline 没加载），用 injectAndWait fallback
      if (!dispatchResult) {
        // v0.9.5: 包 try/catch，注入失败不导致整个 dispatch handler 崩溃
        try {
          const reply = await injector.injectAndWait(message, null, { intent, source, sessionId: targetSid });
          await bus.emit("queue.afterDispatch", { event, reply });
        } catch (e) {
          ctx.log(`fallback injectAndWait 失败: ${e.message?.slice(0, 80)}`);
        }
      }
    };

    // 注册 HTTP 端点
    ctx.http.post("/inject", (body, req) => {
      if (!body?.text) throw new Error("inject 需要 { text }");
      queue.push("http", "manual.inject", {
        text: body.text,
        intent: body.intent,
        source: body.source,
        waitIdle: body.waitIdle || false,
        maxIdleWaitMs: body.maxIdleWaitMs || 120000,
        sessionId: body.sessionId || null,
      }, 80);
      return { ok: true, msg: body.waitIdle ? "已推入队列（waitIdle）" : "已推入队列" };
    });

    ctx.http.post("/inject/intent", async (body, req) => {
      if (!body?.text) throw new Error("inject/intent 需要 { text }");
      const opts = { intent: body.intent || "user", source: body.source || "http" };
      const ok = await injector.silentInject(body.text, opts);
      return { ok, intent: opts.intent, source: opts.source };
    });

    ctx.http.get("/status", () => ({
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      session: injector.sessionId,
      ocBase: korina.ocBase,
      bindingLocked: korina.bindingLocked === true,
      queue: queue.getStats(),
      // v0.9.3: sidecar 健康状态（来自 sidecar-launcher）
      sidecars: korina.sidecars || null,
      // v0.9.7 (manual #17): OC 链路健康（弥补 heartbeat 不依赖 oc 的盲点）
      ocReachable: korina.ocHealth ? korina.ocHealth.status() : null,
    }));

    // GET /binding -- 查询绑定状态（端口锁定的详细信息）
    ctx.http.get("/binding", () => ({
      ocBase: korina.ocBase,
      sessionId: injector.sessionId,
      bindingLocked: korina.bindingLocked === true,
      note: "当前实例绑定到 primary session；可用 POST /rebind 重新绑定到最新 session。多端口 lifeline 尚未实现，不能依赖“不同 9999 端口”这种旧文档说法。修改心跳、任务、TTS 仍可通过 korina HTTP 端点。",
    }));

    // v0.9.2: /switch-session 已删除 -- 端口绑定不再靠旧 switch-session 修改
    // 当前可用路径：POST /rebind 重新绑定到最新 session；单次 RPC 可指定 sessionId（如 /session/send）
    // 多端口 lifeline 尚未实现，文档/adapter 不应承诺“不同端口实例”。

    // ===== v0.9.2: 多 session 管理 + cluster 端点（补全缺失 API） =====
    // 透传到 oc HTTP API，支持 model 参数，让 korina 能跑任意模型（包括 v4f）
    const { base: ocBase, headers: ocHeaders } = injector.serverConfig;

    // GET /sessions -- 列所有 session
    ctx.http.get("/sessions", async (body) => {
      const r = await fetch(`${ocBase}/session`, {
        headers: ocHeaders,
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`oc /session 返回 ${r.status}`);
      const list = await r.json();
      // 简化字段（避免大对象）
      return {
        count: list.length,
        sessions: list.map((s) => ({
          id: s.id,
          title: s.title,
          model: s.model?.id,
          providerID: s.model?.providerID,
          cost: s.cost,
          created: s.time?.created,
          updated: s.time?.updated,
        })),
      };
    });

    // GET /session/messages?sessionId=...&limit=N -- 读 session 消息
    ctx.http.get("/session/messages", async (body) => {
      const sid = body?.sessionId || injector.sessionId;
      const limit = body?.limit || 10;
      const r = await fetch(`${ocBase}/session/${sid}/message?limit=${limit}`, {
        headers: ocHeaders,
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`oc /message 返回 ${r.status}`);
      const msgs = await r.json();
      return {
        sessionId: sid,
        count: msgs.length,
        messages: msgs.map((m) => ({
          id: m.info.id,
          role: m.info.role,
          state: m.info.state,
          modelID: m.info.modelID,
          text: (m.parts || [])
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join(""),
          time: m.info.time,
        })),
      };
    });

    // POST /session/create {title?, agent?, model?} -- 创建新 session
    // model 字段格式: { providerID: "opencode", modelID: "deepseek-v4-flash-free" }
    // 注：POST /session 不支持 model 参数，model 会在第一次发消息时设置
    ctx.http.post("/session/create", async (body) => {
      const r = await fetch(`${ocBase}/session`, {
        method: "POST",
        headers: { ...ocHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: body?.title || `korina-${new Date().toISOString().slice(0, 16)}`,
          parentID: body?.parentID || undefined,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`oc /session 创建失败: ${r.status}`);
      const s = await r.json();
      return {
        ok: true,
        id: s.id,
        title: s.title,
        slug: s.slug,
        model: s.model?.id,
        providerID: s.model?.providerID,
        // 提醒用户：model 需要在第一次 /session/send 时附带
        hint: body?.model
          ? `session 创建成功，model={providerID: "${body.model.providerID}", modelID: "${body.model.modelID}"} 会在第一次 /session/send 时应用`
          : "session 创建成功（未指定 model）",
      };
    });

    // POST /session/send {sessionId, text, model?, agent?, noReply?} -- 发消息到指定 session
    // 这是 v4f 跑起来的核心端点！支持 model 参数覆盖
    ctx.http.post("/session/send", async (body) => {
      if (!body?.text) throw new Error("session/send 需要 { sessionId, text }");
      const sid = body.sessionId || injector.sessionId;
      if (!sid) throw new Error("session/send 需要 sessionId（无可用 session）");

      // 构造 body，支持 model + agent 覆盖
      const msgBody = {
        parts: [{ type: "text", text: body.text }],
      };
      if (body.model) msgBody.model = body.model; // {providerID, modelID}
      if (body.agent) msgBody.agent = body.agent;
      if (body.noReply) msgBody.noReply = true;

      const mode = body.waitForReply !== false ? "message" : "prompt_async";
      const url = `${ocBase}/session/${sid}/${mode}`;

      const r = await fetch(url, {
        method: "POST",
        headers: { ...ocHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(msgBody),
        signal: AbortSignal.timeout(body.timeoutMs || 180000),
      });

      if (mode === "message") {
        if (!r.ok) throw new Error(`oc /message 返回 ${r.status}`);
        const result = await r.json();
        return {
          ok: true,
          sessionId: sid,
          messageId: result.info?.id,
          modelUsed: result.info?.modelID,
          reply: (result.parts || [])
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join(""),
          cost: result.info?.cost,
          tokens: result.info?.tokens,
        };
      } else {
        // prompt_async: 204 No Content
        return {
          ok: true,
          sessionId: sid,
          mode: "async",
          msg: "已异步发送，session.model 会在下次查询时显示新值",
        };
      }
    });

    // POST /session/model {sessionId, providerID, modelID}
    // v0.9.5: 诚实标注 — oc 没有单独切 model 的 API，这个端点只是"标记意图"
    // 实际切换要靠下次 /session/send 传 model 字段
    ctx.http.post("/session/model", async (body) => {
      if (!body?.sessionId) throw new Error("session/model 需要 { sessionId, providerID, modelID }");
      if (!body?.providerID || !body?.modelID) throw new Error("session/model 需要 providerID + modelID");

      // 之前实现：返回 ok: true + pending 标记，但什么都没存
      // 用户调用 N 次效果相同，且和 /session/send 的 model 字段无关
      // 修：明确返回 ok:false，提示走 /session/send 路径
      return {
        ok: false,
        sessionId: body.sessionId,
        requested: { providerID: body.providerID, modelID: body.modelID },
        reason: "OpenCode server 没有单独切 model 的端点。要换 model 必须发一条带 model 字段的消息（/session/send 时附带 body.model）。",
        workaround: `POST /session/send 同一 sessionId 时附带 body.model={providerID: "${body.providerID}", modelID: "${body.modelID}"}`,
      };
    });

    // POST /cluster/create {tasks: [{title, text, model?, agent?}]} -- 批量创建 session + 发首条消息
    ctx.http.post("/cluster/create", async (body) => {
      if (!body?.tasks || !Array.isArray(body.tasks)) {
        throw new Error("cluster/create 需要 { tasks: [{title, text, model?}, ...] }");
      }

      const results = [];
      for (const task of body.tasks) {
        try {
          // 1. 创建 session
          const cr = await fetch(`${ocBase}/session`, {
            method: "POST",
            headers: { ...ocHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ title: task.title || `cluster-${Date.now()}` }),
            signal: AbortSignal.timeout(10000),
          });
          if (!cr.ok) {
            results.push({ title: task.title, ok: false, error: `创建 session 失败: ${cr.status}` });
            continue;
          }
          const sess = await cr.json();

          // 2. 发首条消息（带 model）
          const msgBody = {
            parts: [{ type: "text", text: task.text || "" }],
          };
          if (task.model) msgBody.model = task.model;
          if (task.agent) msgBody.agent = task.agent;

          const sr = await fetch(`${ocBase}/session/${sess.id}/message`, {
            method: "POST",
            headers: { ...ocHeaders, "Content-Type": "application/json" },
            body: JSON.stringify(msgBody),
            signal: AbortSignal.timeout(task.timeoutMs || 180000),
          });

          let reply = "";
          if (sr.ok) {
            const result = await sr.json();
            reply = (result.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
          }

          results.push({
            title: task.title,
            sessionId: sess.id,
            ok: sr.ok,
            modelUsed: task.model ? `${task.model.providerID}/${task.model.modelID}` : sess.model?.id,
            reply,
          });
        } catch (e) {
          results.push({ title: task.title, ok: false, error: e.message?.slice(0, 100) });
        }
      }

      return { ok: true, count: results.length, results };
    });

    // POST /cluster/collect {sessionIds: ["..."], timeoutMs?} -- 收集多个 session 的最新 assistant 回复
    ctx.http.post("/cluster/collect", async (body) => {
      if (!body?.sessionIds || !Array.isArray(body.sessionIds)) {
        throw new Error("cluster/collect 需要 { sessionIds: [...] }");
      }

      const results = [];
      for (const sid of body.sessionIds) {
        try {
          const r = await fetch(`${ocBase}/session/${sid}/message?limit=2`, {
            headers: ocHeaders,
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) {
            results.push({ sessionId: sid, ok: false, error: `HTTP ${r.status}` });
            continue;
          }
          const msgs = await r.json();
          const lastAssistant = msgs.filter((m) => m.info.role === "assistant").pop();
          results.push({
            sessionId: sid,
            ok: true,
            modelUsed: lastAssistant?.info?.modelID,
            text: lastAssistant
              ? (lastAssistant.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("")
              : "",
            state: lastAssistant?.info?.state,
            time: lastAssistant?.info?.time,
          });
        } catch (e) {
          results.push({ sessionId: sid, ok: false, error: e.message?.slice(0, 100) });
        }
      }

      return { ok: true, count: results.length, results };
    });

    // v0.9.23: 订阅 SSE 用户消息 → 更新 lastKokoTime
    // 之前 lastKokoTime 只在 source=koko 的 korina inject 时更新（极少触发），
    // 实际 Koko 在 oc 桌面版直接打字根本不走 korina，导致 lastKokoTime 永远是旧值。
    // 通过 SSE 看到用户消息 = Koko 真在打字 = 更新 lastKokoTime。
    bus.on("sse.userTextSeen", (data) => {
      try {
        injector._onKokoActive(Date.now());
      } catch {}
    });

    bus.emit("oc.discovered", { base: server.base, sid });
    return { injector };
  },

  destroy() {
    this.injector?.stopHealthMonitor?.();
  },
};

// ===== 工具函数 =====

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function retry(fn, label, maxAttempts, intervalMs) {
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === 0) console.log(`[init] ${label} 未就绪: ${e.message}，等待重试...`);
      await sleep(intervalMs);
    }
  }
  throw new Error(`${label} 等待超时`);
}

function inferIntent(event) {
  if (event.type === "file.changed") return "sensor";
  if (event.type === "timer.tick") return event.payload?.intent || "sensor";
  if (event.type === "manual.inject") return "user";
  return "sensor";
}

function formatEventMessage(event) {
  switch (event.type) {
    case "file.changed":
      return `文件变化：${event.payload.event} ${event.payload.path} (size=${event.payload.size})。\n请判断这个变化是否需要处理。如果需要，用可用工具分析或操作；如果不需要，回复 [korina] 忽略。`;
    case "manual.inject":
      return event.payload.text;
    case "timer.tick":
      return event.payload.message || "例行检查";
    default:
      return `事件 ${event.type}: ${JSON.stringify(event.payload).slice(0, 200)}`;
  }
}
