/**
 * plugins/voice-input/plugin.mjs
 *
 * v0.9.3: 语音输入 HTTP 端点插件
 *
 * STT sidecar（voice-input.py）把 whisper 转写文本 POST 到 /stt/text，
 * 推入事件队列，oc 回复后走 SSE -> TTS -> 桌面歌词播放。
 *
 * 新增：
 *   - POST /voice-input/bind: 把语音端口锁定到当前 oc session（AI 调用）
 *   - 共享文件 logs/voice-input-target.json：voice-input.py 轮询读取
 */

export default {
  name: "voice-input",
  dependencies: ["oc-injector"],

  async init(ctx) {
    const { queue, http, korina } = ctx;
    const injector = korina.injector;
    const bindingStore = korina.bindingStore;
    if (!bindingStore) throw new Error("voice-input 需要 korina.bindingStore（oc-injector 未正确初始化）");

    // v0.9.6: 启动时校验 voice target 是否仍指向 oc 中存在的 session，
    // 避免启动后 voice 一直发到已删除的旧 session。
    // 校验失败时静默回退到 primary session（用 log 告知），不抛错。
    if (injector && typeof injector.listOcSessionIds === "function") {
      try {
        const ids = await injector.listOcSessionIds();
        const result = bindingStore.validateAndCleanVoiceTarget((sid) => ids.includes(sid));
        if (result.cleared) ctx.log(`旧 voice target 已清除，fallback 到 primary session`);
        else if (result.target) ctx.log(`voice target 校验通过: ${result.target.sessionId.slice(0, 16)}`);
        else ctx.log(`当前无 voice target，fallback 到 primary session`);
      } catch (e) {
        ctx.log(`voice target 校验失败 (${e.message?.slice(0, 60)})，保留当前状态`);
      }
    }

    // POST /stt/text -- 接收 STT 转写文本
    http.post("/stt/text", (body, req) => {
      if (!body?.text || !body.text.trim()) throw new Error("stt/text 需要 { text }");
      // v0.9.21 (audit log manual #46): 记录 STT 端点 source metadata
      console.log(`[audit] /stt/text from=${req?.socket?.remoteAddress || "?"} ua="${req?.headers?.["user-agent"] || "?"}" text="${body.text.slice(0, 60).replace(/"/g, "'")}" ts=${new Date().toISOString()}`);

      // v0.9.3: 语音发到显式 body.sessionId、语音锁定目标或 korina 主 session
      const sid = body.sessionId || bindingStore.getVoiceTargetSessionId() || korina.sessionId;

      queue.push("voice", "manual.inject", {
        text: body.text.slice(0, 2000),
        intent: "user",
        source: "koko", // v0.9.5: 语义修正，source 标识消息来源主体（Koko），不是通道
        sessionId: sid,
      }, 80);
      ctx.log(`语音输入入队: "${body.text.slice(0, 40)}..." (${body.text.length}字) -> ${sid?.slice(0,16)}`);
      return { ok: true, msg: "语音文本已入队", chars: body.text.length, sessionId: sid?.slice(0,16) };
    });

    // GET /stt/status -- sidecar 判断是否安全录音
    http.get("/stt/status", () => {
      const ttsQueue = korina.ttsQueue || [];
      return {
        ttsActive: ttsQueue.length > 0,
        queueSize: ttsQueue.length,
      };
    });

    // v0.9.3: POST /voice-input/bind -- 把语音端口锁定到指定 oc session
    // 可选 body.sessionId：传则绑该对话，省略则绑 korina 主 session（兼容旧行为）
    http.post("/voice-input/bind", async (body) => {
      const sid = body?.sessionId || korina.sessionId;
      if (!sid) throw new Error("未提供 sessionId 且 korina 未绑定 oc session，无法绑定语音端口");

      // 尝试获取 session 标题（更友好）
      let title = sid.slice(0, 16);
      try {
        const { base: ocBase, headers: ocHeaders } = injector.serverConfig || {};
        if (ocBase) {
          const r = await fetch(`${ocBase}/session/${sid}`, { headers: ocHeaders, signal: AbortSignal.timeout(3000) });
          if (r.ok) {
            const info = await r.json();
            title = info.title || title;
          }
        }
      } catch {}

      const result = bindingStore.setVoiceTargetSessionId(sid, { title });
      if (!result.ok) throw new Error(result.error || "绑定语音端口失败");
      const target = result.target;
      ctx.log(`语音端口已绑定 -> ${title} (${sid.slice(0, 16)})`);
      return { ok: true, target: { sessionId: sid, title, setAt: target.setAt } };
    });

    // v0.9.3: GET /voice-input/bind -- 查询当前绑定
    http.get("/voice-input/bind", () => {
      const target = bindingStore.getVoiceTarget();
      if (!target) return { bound: false, fallback: korina.sessionId };
      return { bound: true, ...target, ageMs: Date.now() - (target.setAt || 0) };
    });

    // v0.9.3: DELETE /voice-input/bind -- 解绑（恢复默认：跟 korina 绑定 session）
    http.delete("/voice-input/bind", () => {
      bindingStore.clearVoiceTargetSessionId();
      ctx.log("语音端口已解绑（恢复跟随 korina 绑定 session）");
      return { ok: true, msg: "语音端口已解绑" };
    });

    // v0.9.13 (L5.3 manual #37): 按需启动 voice-input 端点（治 R3 双实例抢 Alt）
    // 工作流：OC 想录音 → 调 POST /voice-input/start → voice-input.py 拉起 + warm-up whisper → KOKO 按 F8 → STT → POST /stt/text → OC 想结束 → 调 POST /voice-input/stop
    // POST /voice-input/start -- 拉起 voice-input 进程
    http.post("/voice-input/start", async () => {
      const registry = korina.sidecarRegistry;
      if (!registry) throw new Error("sidecarRegistry 未初始化");
      const snapshot = registry.snapshot();
      const existing = snapshot["voice-input"];
      if (existing && existing.alive) {
        ctx.log("voice-input 已在跑，跳过 start");
        return { ok: true, msg: "already_running", status: snapshot };
      }
      const { join: pjoin, dirname: pdirname } = await import("node:path");
      const { fileURLToPath: pfileURLToPath } = await import("node:url");
      const __d = pdirname(pfileURLToPath(import.meta.url));
      const projectRoot = pjoin(__d, "..", "..");
      const logsDir = pjoin(projectRoot, "logs");
      const result = registry.launch("voice-input", { projectRoot, logsDir });
      if (!result.ok) throw new Error(`voice-input 拉起失败: ${result.error}`);
      korina.sidecars = registry.snapshot();
      ctx.log(`voice-input 已拉起 PID=${result.entry.pid}（OC 触发按需启动）`);
      return { ok: true, msg: "started", pid: result.entry.pid, status: registry.snapshot() };
    });

    // POST /voice-input/stop -- 杀掉 voice-input 进程
    http.post("/voice-input/stop", () => {
      const registry = korina.sidecarRegistry;
      if (!registry) throw new Error("sidecarRegistry 未初始化");
      const result = registry.stop("voice-input");
      if (!result.ok && !result.error.includes("未启动")) {
        // 未启动也返回 ok（stop 一个未启动的 = no-op）
        throw new Error(result.error);
      }
      korina.sidecars = registry.snapshot();
      ctx.log("voice-input 已停（OC 触发停止）");
      return { ok: true, msg: "stopped", status: registry.snapshot() };
    });

    // GET /voice-input/status -- 当前状态（idle / started / error）
    http.get("/voice-input/status", () => {
      const registry = korina.sidecarRegistry;
      if (!registry) throw new Error("sidecarRegistry 未初始化");
      const entry = registry.get("voice-input");
      if (!entry) return { state: "unknown", error: "voice-input 未注册" };
      const snapshot = registry.snapshot()["voice-input"];
      if (!snapshot || !snapshot.alive) {
        return { state: "idle", startedAt: snapshot?.startedAt || null, pid: null, alive: false };
      }
      return {
        state: "started",
        pid: snapshot.pid,
        alive: true,
        startedAt: snapshot.startedAt,
        lastPingAt: snapshot.lastPingAt,
      };
    });

    ctx.log("语音输入端点就绪 (/stt/text, /stt/status, /voice-input/bind, /voice-input/start, /stop, /status)");
    return {};
  },

  destroy() {},
};
