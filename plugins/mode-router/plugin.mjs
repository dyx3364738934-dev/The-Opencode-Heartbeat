/**
 * plugins/mode-router/plugin.mjs
 *
 * v0.9: 模式检测插件
 *
 * 订阅 queue.beforeDispatch，检测用户消息中的模式关键词。
 * 命中时先 silentInject 模式提示词，再联动 korina 配置。
 */

import { detectMode } from "../../src/mode-router.mjs";

export default {
  name: "mode-router",
  dependencies: ["oc-injector"],

  async init(ctx) {
    const { bus, presets, korina, http } = ctx;
    const injector = korina.injector;

    // v0.9.3: 通用模式切换处理（去重 + 注入 + 配置联动）
    let _lastDetectedAt = 0;
    async function handleModeDetection(detectedMode, targetSessionId = null) {
      // 去重：1 分钟内不重复触发同一模式
      if (Date.now() - _lastDetectedAt < 60000) return;
      const currentMode = presets.get("mode");
      if (currentMode === detectedMode.korinaMode) return; // 已在目标模式

      _lastDetectedAt = Date.now();
      ctx.log(`检测到模式切换: ${detectedMode.name} (关键词命中)` + (targetSessionId ? ` session=${targetSessionId.slice(0,16)}` : ""));
      try {
        // v0.9.3: 如果有关键词所在的 sessionId，注入到那个 session
        // 否则注入到 korina 绑定的 session
        const opts = { intent: "self-direct", source: "korina" };
        if (targetSessionId) opts.sessionId = targetSessionId;
        // v0.9.5: silentInject 在 3 次重试后失败返回 false（不 throw）
        // 必须显式查返回值。注入失败就不联动 preset.mode/interval，否则
        // agent 没收到约束文本但 preset 已切到新模式 → 静默 desync (BUG-005)
        const ok = await injector.silentInject(detectedMode.prompt, opts);
        if (!ok) {
          ctx.warn(`模式提示词注入失败（silentInject 重试 3 次后放弃），模式切换回滚以避免 desync`);
          _lastDetectedAt = 0; // 回滚去重，让下次 dispatch 能重试
          return;
        }
        ctx.log(`模式提示词已注入: ${detectedMode.name}` + (targetSessionId ? ` -> ${targetSessionId.slice(0,16)}` : ""));
        if (detectedMode.korinaMode) {
          presets.set("mode", detectedMode.korinaMode);
          ctx.log(`korina 模式联动: -> ${detectedMode.korinaMode}`);
        }
        if (detectedMode.timerIntervalMs) {
          presets.set("timer.intervalMs", detectedMode.timerIntervalMs);
          ctx.log(`korina 心跳联动: -> ${detectedMode.timerIntervalMs}ms`);
        }
        bus.emit("mode.detected", { mode: detectedMode });
      } catch (e) {
        ctx.log(`模式切换失败: ${e.message?.slice(0, 80)}`);
        _lastDetectedAt = 0; // 异常也回滚
      }
    }

    // 订阅 dispatch 队列（korina 内部事件：HTTP inject / timer / file-watcher）
    bus.on("queue.beforeDispatch", async (data) => {
      const { event, message } = data;
      const detectedMode = detectMode(message);
      if (!detectedMode) return;
      await handleModeDetection(detectedMode);
    });

    // v0.9.3: 订阅 SSE 用户消息（用户在 oc UI 中直接打字，不限 session）
    bus.on("sse.userTextSeen", async (data) => {
      const detectedMode = detectMode(data.text);
      if (!detectedMode) return;
      ctx.log(`SSE 检测到模式关键词: "${data.text.slice(0, 40)}" session=${(data.sessionID || "?").slice(0, 16)}`);
      await handleModeDetection(detectedMode, data.sessionID);
    });

    // HTTP 端点
    http.get("/modes", async () => {
      const { getModeInfo } = await import("../../src/mode-router.mjs");
      return { mode: getModeInfo() };
    });

    ctx.log("模式检测就绪");
    return {};
  },

  destroy() {},
};
