/**
 * plugins/sse-tts-pipeline/plugin.mjs
 *
 * v0.9: SSE 流式监听 + 句子分段 + 流式 TTS 合成
 *
 * 这条管道不可拆 -- SSE 增量 -> 分句 -> TTS 合成必须紧耦合，
 * 才能实现"句子一好就合成"的低延迟流式播放。
 *
 * 订阅事件：
 *   queue.dispatch -- 收到 dispatch 事件时，启动 SSE 监听 + 流式 TTS
 *
 * 发布事件：
 *   sse.connected      SSE 连接建立
 *   sse.textDelta      文本增量
 *   sse.messageComplete 消息完成
 *   tts.chunk          TTS 音频块就绪
 *   queue.afterDispatch dispatch 完成
 *
 * 依赖：
 *   oc-injector（提供 injector 实例）
 */

import { SSEListener } from "../../src/sse-listener.mjs";
import { SentenceSegmenter } from "../../src/sentence-segmenter.mjs";
import { TTS } from "../../src/tts.mjs";
import { pushTTS } from "../../src/core/tts-queue.mjs";

export default {
  name: "sse-tts-pipeline",
  dependencies: ["oc-injector"],

  async init(ctx) {
    // L5.4 shadow mode (manual #45): shadow 实例不启动 SSE 监听（sseListener.start() 是主动 fire）
    if (ctx.korina?.instanceRole === "shadow") {
      ctx.log("shadow 模式：跳过 sse-tts-pipeline 主动 fire（保留 HTTP 端点）");
      return { stop() {} };
    }
    const { bus, presets, korina, http } = ctx;
    const injector = korina.injector;

    // TTS 模块
    const ttsConfig = presets.get("tts") || {};
    const tts = new TTS(ttsConfig);
    // v0.9.21 (manual #47): 删 autoTTS 路径 -- TTS 100% 仅工具调用（KOKO 拍板 B）
    //   - 之前 autoTTS=true 时 sse-tts-pipeline 自动合成所有 oc 回复（违反"绑定仅工具调用"）
    //   - 现在 TTS 仅在 agent 显式调 /tts/speak / /tts/speak-and-inject / /tts/quick 端点时合成（走 tts-tool）
    //   - 保留 tts 实例供流式路径可能用（实际下游不再合成）
    ctx.log(`TTS ${tts.enabled ? "启用" : "禁用"} model=${tts.model} autoTTS=false (manual #47 删)`);

    // SSE 监听器
    const sseListener = new SSEListener(injector);
    sseListener.start();
    ctx.log("SSE 监听已启动（/global/event）");

    // v0.9.3: 桥接 SSE 用户消息 → EventBus（供 mode-router 检测关键词）
    sseListener.on("userTextSeen", (data) => {
      bus.emit("sse.userTextSeen", data);
    });

    // v0.9.28 manual #53: 桥接 SSE assistant 完成 → EventBus（供 timer 归零心跳计时）
    //   - KOKO 设计："AI 输出回复"是唯一有效的"在思考"信号
    //   - 之前监听 messageComplete 错了——oc 不发 session.status idle，永不触发
    //   - 现在 assistantActive 覆盖所有 message.part.* 事件（reasoning/tool/text/delta）
    sseListener.on("messageComplete", () => {
      bus.emit("sse.assistantReply", {});
    });
    sseListener.on("assistantActive", () => {
      bus.emit("sse.assistantReply", {});
    });

    // TTS 播放队列（HTTP 轮询端点）
    const ttsQueue = [];
    const MAX_TTS_QUEUE = 50;

    // 启动自检
    if (tts.enabled) {
      setTimeout(async () => {
        try {
          ctx.log("TTS 自检...");
          const r = await tts.synthesize("korina 自检");
          if (r.ok) ctx.log(`TTS OK: ${r.elapsed}ms, audio=${r.audio.length}B`);
          else ctx.log(`TTS FAIL: ${r.error}`);
        } catch (e) {
          ctx.log(`TTS 异常: ${e.message?.slice(0, 60)}`);
        }
      }, 5000);
    }

    // ===== 订阅 queue.dispatch -- 核心流式管道 =====
    bus.on("queue.dispatch", async (data) => {
      const { event, message, intent, source, targetSid, skipTTS } = data;

      // v0.9.1: skipTTS 事件（心跳/文件变化）走 fire-and-forget
      // inject 后立即返回，不等回复 -- 回复由 SSE 异步捕获，不阻塞队列
      if (skipTTS) {
        try {
          await injector.inject(message, { intent, source, sessionId: targetSid });
          ctx.log(`fire-and-forget 注入完成 (skipTTS): ${message.slice(0, 40)}...`);
        } catch (e) {
          ctx.log(`fire-and-forget 注入失败: ${e.message?.slice(0, 60)}`);
        }
        await bus.emit("queue.afterDispatch", { event, reply: { text: "", state: "fire_and_forget" } });
        return true;
      }

      // 流式路径：SSE 监听 + 分句 + TTS
      const useStreaming = tts.enabled && sseListener.running;
      if (!useStreaming) {
        // TTS 未启用或 SSE 未连接 -- fallback 到 injectAndWait
        const reply = await injector.injectAndWait(message, null, { intent, source, sessionId: targetSid });

        // v0.9.21 (manual #47): 删 autoTTS 自动合成块（KOKO 拍板 B：100% 仅工具调用）
        //   - 之前：if (autoTTS && tts.enabled && reply.text...) 自动合成 reply
        //   - 现在：reply 不再自动 TTS，要读需 agent 显式调 /tts/speak

        await bus.emit("queue.afterDispatch", { event, reply });
        return true;
      }

      // 流式路径
      await streamingInject(message, { intent, source, sessionId: targetSid });
      return true;
    });

    // ===== 流式注入 =====
    async function streamingInject(message, { intent, source, sessionId }) {
      const MAX_WAIT_MS = 5 * 60 * 1000;
      const startTime = Date.now();

      sseListener.setTarget(sessionId, null);
      const myGeneration = sseListener.getGeneration();

      // 等 assistant 开始
      const ASSISTANT_WAIT_MS = 8000;
      const assistantReady = new Promise((resolve) => {
        if (sseListener.assistantActive) return resolve();
        const checkActive = () => {
          if (sseListener.assistantActive) {
            sseListener.off("partSeen", checkActive);
            clearTimeout(timer);
            resolve();
          }
        };
        sseListener.on("partSeen", checkActive);
        const timer = setTimeout(() => {
          sseListener.off("partSeen", checkActive);
          resolve();
        }, ASSISTANT_WAIT_MS);
      });

      // 分句器
      const segmenter = new SentenceSegmenter({ minLen: 2, maxLen: 150 });
      let fullText = "";
      let completed = false;
      let completeReason = "";

      // v0.9.23 (manual #48): TTS 并发控制块**已删**（autoTTS 路径移除后无消费者）
      //   - 之前 ttsSlots/pendingTTS/ttsWaiters 控制并发合成 N 句
      //   - 现在 segmenter.on("sentence") 是 no-op，永远不会 push pendingTTS
      //   - 字段全删，finally 等待 pendingTTS 也删

    // v0.9.23 (manual #48): autoTTS 订阅器**已删**（之前注释说删但代码残留）
    //   - 修复前：segmenter.on("sentence") 仍调 tts.synthesize(sentence) + pushTTS
    //   - 症状：oc AI message（含 reasoning/inner-think 当 text 输出的内容）被 SSE 监听
    //           → SentenceSegmenter 分句 → autoTTS 念出来（包括内心独白）
    //   - 修复：TTS 100% 仅工具调用（agent 显式调 /tts/speak / speak-and-inject / quick）
    //   - segmenter 实例保留（feed/flush 调用兼容），仅无 sentence 事件订阅者
    //   - ttsSlots / pendingTTS / ttsWaiters 暂保留作为未来回归字段（不活跃）
    segmenter.on("sentence", () => {}); // no-op 订阅器（保留 event 总线兼容）

      // SSE 事件
      const onTextDelta = (delta, full) => {
        if (sseListener.getGeneration() !== myGeneration) return;
        fullText = full;
        segmenter.feed(delta);
        bus.emit("sse.textDelta", { delta, fullText, generation: myGeneration });
      };
      const onComplete = (text, reason) => {
        if (sseListener.getGeneration() !== myGeneration) return;
        completed = true;
        completeReason = reason;
        if (text) fullText = text;
        segmenter.flush();
        bus.emit("sse.messageComplete", { fullText, reason, generation: myGeneration });
      };

      sseListener.on("textDelta", onTextDelta);
      sseListener.on("messageComplete", onComplete);

      try {
        ctx.log(`开始流式注入 (sid=${sessionId?.slice(0, 16)}...)`);
        await injector.inject(message, { intent, source, sessionId });
        await assistantReady;

        const IDLE_THRESHOLD_MS = 5000;
        const V4F_SILENT_MS = 30000;

        while (!completed && Date.now() - startTime < MAX_WAIT_MS) {
          await new Promise((r) => setTimeout(r, 500));
          if (sseListener.lastDeltaTime > 0 && Date.now() - sseListener.lastDeltaTime > IDLE_THRESHOLD_MS) {
            completeReason = "idle_timeout";
            completed = true;
            segmenter.flush();
          } else if (!sseListener.assistantActive && Date.now() - startTime > V4F_SILENT_MS) {
            completeReason = "v4f_silent";
            completed = true;
            segmenter.flush();
          }
        }

        if (!completed) segmenter.flush();

        const reply = {
          text: fullText || "",
          reasoning: "",
          state: completeReason || "streamed",
          created: Date.now(),
          parts: [],
        };
        await bus.emit("queue.afterDispatch", { event: { type: "streamed" }, reply });
        return reply;
      } finally {
        sseListener.off("textDelta", onTextDelta);
        sseListener.off("messageComplete", onComplete);
        // v0.9.23 (manual #48): 删 pendingTTS 等待（autoTTS 路径移除）
      }
    }

    // ===== 工具函数 =====
// v0.9.5: pushTTS 已抽到 src/core/tts-queue.mjs（之前这里有一份重复实现）

function _unused_old_pushTTS_REMOVED() {} // marker -- 已迁出
    http.get("/tts/queue", () => {
      const items = ttsQueue.splice(0); // 取出并清空
      // v0.9.5: 移除 playedCount 字段（永远是 0，从未被更新）
      return { items, count: items.length };
    });

    http.get("/tts/status", () => ({
      enabled: tts.enabled,
      model: tts.model,
      voiceId: tts.voiceId,
      callCount: tts._callCount,
      queueSize: ttsQueue.length,
      // v0.9.5: 移除 korinaVersion 硬编码（"0.9.0" 过期，实际 0.9.3）
    }));

    http.post("/tts/synthesize", async (body) => {
      if (!body?.text) throw new Error("tts/synthesize 需要 { text }");
      const text = body.text.slice(0, 500);
      const result = await tts.synthesize(text);
      if (result.ok) {
        pushTTS(ttsQueue, text, result);
        return { ok: true, duration: result.duration, queueSize: ttsQueue.length };
      }
      return { ok: false, error: result.error };
    });

    // ===== TTS 队列 TTL 清理 =====
    const cleanupInterval = setInterval(() => {
      if (ttsQueue.length === 0) return;
      const TTL = 5 * 60 * 1000;
      const now = Date.now();
      const before = ttsQueue.length;
      const filtered = ttsQueue.filter((item) => now - item.createdAt < TTL);
      ttsQueue.length = 0;
      ttsQueue.push(...filtered);
      const removed = before - ttsQueue.length;
      if (removed > 0) ctx.log(`TTS 队列清理 ${removed} 个过期项`);
    }, 60000);

    // 暴露
    korina.tts = tts;
    korina.sseListener = sseListener;
    korina.ttsQueue = ttsQueue;

    return {
      tts, sseListener, ttsQueue,
      _cleanupInterval: cleanupInterval, // v0.9.2: 暴露给 destroy 清理
    };
  },

  destroy() {
    // SSE listener stop
    this.sseListener?.stop?.();
    // v0.9.2: 清理 TTL 定时器（之前由闭包持有无法清除，热重载或重启插件时会泄漏）
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  },
};
// v0.9.5: pushTTS 已抽到 src/core/tts-queue.mjs（消除 sse-tts-pipeline + tts-tool 重复实现）
