/**
 * plugins/tts-tool/plugin.mjs
 *
 * v0.9.2: TTS 工具化插件 -- 让 oc 把 TTS 当作"表达工具"调用
 *
 * 背景：
 *   之前 TTS 是 korina 自动合成的（收到 oc 回复就合成）。
 *   现在 oc 可以主动决定"我说什么、怎么说、带什么情绪"，通过 korina HTTP 端点调用。
 *
 * 端点：
 *   GET  /tts/capabilities          -- 参数能力（emotion / speed / pitch / vol 范围 + 文本标记语法）
 *   POST /tts/preview               -- 只合成不入播放队列（用于测试参数组合）
 *   POST /tts/speak                 -- 合成 + 加入桌面歌词播放队列
 *   POST /tts/speak-and-inject      -- 合成播放 + 同时注入 oc（用于"我需要解释一下"场景）
 *   POST /tts/quick                 -- 快捷方式：默认参数 + 入队（最常用）
 *
 * 设计：
 *   - 依赖 sse-tts-pipeline 提供的 tts 实例 + ttsQueue（避免重复创建 TTS 连接）
 *   - 所有参数走预设范围验证（防止 oc 传越界值）
 *   - 文本自动清理（去 markdown、控制字数）
 */

import { pushTTS } from "../../src/core/tts-queue.mjs";

export default {
  name: "tts-tool",
  dependencies: ["sse-tts-pipeline"],

  async init(ctx) {
    const { http, korina } = ctx;
    const tts = korina.tts;
    const ttsQueue = korina.ttsQueue;

    if (!tts) {
      ctx.log("TTS 实例不可用（sse-tts-pipeline 未加载？），tts-tool 退化为只读");
    }

    // ===== 工具函数 =====

    // 清理文本：去 markdown 标记、控制字数、保留 TTS 标记（<#x#>, (laughs)）
    function sanitizeText(text, maxChars = 500) {
      if (!text || typeof text !== "string") return "";
      let t = text.trim();
      // 去代码块 ```...```
      t = t.replace(/```[\s\S]*?```/g, "");
      // 去行内代码 `xxx`
      t = t.replace(/`([^`]+)`/g, "$1");
      // 去 markdown 链接 [text](url) -> text
      t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      // 去粗体/斜体标记
      t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
      t = t.replace(/\*([^*]+)\*/g, "$1");
      // 去标题前缀
      t = t.replace(/^#{1,6}\s*/gm, "");
      // 多余空白
      t = t.replace(/\s+/g, " ").trim();
      // 截断
      if (t.length > maxChars) t = t.slice(0, maxChars) + "...";
      return t;
    }

    // v0.9.5: pushToQueue 改用共享实现 src/core/tts-queue.mjs
    function pushToQueue(text, result) {
      pushTTS(ttsQueue, text, result, { logger: ctx.log });
    }

    // ===== HTTP 端点 =====

    // 能力查询 -- 让 oc 知道能用什么参数 + 当前 TTS 服务状态
    http.get("/tts/capabilities", () => {
      const stats = tts?.getStats?.() || {};
      return {
        ok: true,
        enabled: stats.enabled ?? false,
        voiceId: stats.voiceId,
        model: stats.model,
        callCount: stats.callCount,
        apiKeyConfigured: stats.apiKeyConfigured,
        capabilities: stats.capabilities || {
          emotions: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"],
          speedRange: [0.5, 2],
          pitchRange: [-12, 12],
          volRange: [0.1, 10],
          pauseInText: "<#seconds#>",
          exclamations: ["(laughs)", "(sighs)", "(breath)", "(emm)"],
        },
        // 让模型一眼看清楚："TTS 是唯一输出通道"
        description: "TTS 是你唯一能让 Koko 听到你声音的渠道。调用 /tts/speak = 你说话。不调用 = Koko 听不到你（仅看到桌面字幕的旧文本）。",
        decisionLogic: {
          whenToSpeak: [
            "Koko 问你问题 → 必调 /tts/speak 回复（Koko 听不到文字）",
            "Koko 发了一段消息 → 必调 /tts/speak 回复",
            "心跳场景判断有 Koko 应知道的事（错误/异常/重要变化）→ 必调 /tts/speak 报警",
            "TTS 失败或太长 → 简短文字回复保底",
          ],
          whenToStaySilent: [
            "心跳场景 Koko 在睡觉（kokoIdle > 30 分钟或深夜）且无异常 → 不调 TTS",
            "Koko 自己输入了一堆调试内容（不需要 TTS 念出） → 简短文字",
            "TTS 调用失败 → 降级到文字",
          ],
        },
        usage: {
          endpoint: "POST /tts/speak",
          body: { text: "string", emotion: "string?", speed: "number?", pitch: "number?", vol: "number?" },
          examples: [
            { text: "嗯，让我查一下", emotion: "neutral", speed: 0.9 },
            { text: "找到答案了！", emotion: "happy", speed: 1.1 },
            { text: "这个问题有点深<sighs>", emotion: "sad", vol: 0.8 },
          ],
          textMarkup: {
            pause: "<#0.5#> = 0.5 秒停顿",
            exclamation: "(laughs)/(sighs)/(breath) 等插入语（speech-2.8 专属）",
          },
          note: "情绪会染色整段文本，无法精确控制某一句。分段情绪需多次调用 /tts/speak。",
        },
      };
    });

    // 预览 -- 只合成不入队（测试参数）
    http.post("/tts/preview", async (body) => {
      if (!tts) throw new Error("TTS 不可用");
      const text = sanitizeText(body?.text, body?.maxChars || 200);
      if (!text) throw new Error("text 为空");

      const result = await tts.synthesize(text, {
        emotion: body?.emotion,
        speed: body?.speed,
        pitch: body?.pitch,
        vol: body?.vol,
        retries: body?.retries ?? 1,
      });

      if (!result.ok) return { ok: false, error: result.error };

      return {
        ok: true,
        text,
        emotion: result.emotion,
        durationMs: result.duration,
        characters: result.characters,
        audioLength: result.audio.length,
        audioBase64: result.audio.toString("base64"), // 返回 base64 给 oc 测试
        format: result.format,
        elapsedMs: result.elapsed,
      };
    });

    // 说话 -- 合成 + 入播放队列（核心端点）
    http.post("/tts/speak", async (body) => {
      if (!tts) throw new Error("TTS 不可用");
      const text = sanitizeText(body?.text, body?.maxChars || 500);
      if (!text) throw new Error("text 为空");

      const result = await tts.synthesize(text, {
        emotion: body?.emotion,
        speed: body?.speed,
        pitch: body?.pitch,
        vol: body?.vol,
        retries: body?.retries ?? 1,
      });

      if (!result.ok) return { ok: false, error: result.error };

      pushToQueue(text, result);
      ctx.log(`/tts/speak 入队: "${text.slice(0, 40)}..." emotion=${result.emotion || "default"}`);

      return {
        ok: true,
        text,
        emotion: result.emotion,
        durationMs: result.duration,
        queueSize: ttsQueue.length,
      };
    });

    // 说话 + 注入 oc -- 用于"我需要解释一下"场景
    // 不阻塞：注入返回后立即返回，播放由桌面歌词 sidecar 异步处理
    http.post("/tts/speak-and-inject", async (body, req) => {
      if (!tts) throw new Error("TTS 不可用");
      const injector = korina.injector;
      if (!injector) throw new Error("injector 不可用");

      // v0.9.21 (audit log manual #46): 记录 tts/speak-and-inject 端点 source metadata
      console.log(`[audit] /tts/speak-and-inject from=${req?.socket?.remoteAddress || "?"} ua="${req?.headers?.["user-agent"] || "?"}" text="${(body?.text || "").slice(0, 60).replace(/"/g, "'")}" ts=${new Date().toISOString()}`);

      const text = sanitizeText(body?.text, body?.maxChars || 500);
      if (!text) throw new Error("text 为空");

      // 先合成入队（让用户先听到）
      const result = await tts.synthesize(text, {
        emotion: body?.emotion,
        speed: body?.speed,
        pitch: body?.pitch,
        vol: body?.vol,
        retries: body?.retries ?? 1,
      });

      if (!result.ok) return { ok: false, error: result.error };

      pushToQueue(text, result);

      // 同时注入 oc（让 oc 自己也能看到这段话作为上下文）
      // 注意：用 silentInject 不阻塞播放
      try {
        await injector.silentInject(`[voice note] ${text}`, {
          intent: "self-direct",
          source: "tts-tool",
        });
      } catch (e) {
        ctx.log(`tts-tool 注入 oc 失败: ${e.message?.slice(0, 60)}`);
      }

      return {
        ok: true,
        text,
        emotion: result.emotion,
        durationMs: result.duration,
        queueSize: ttsQueue.length,
        injectedToOc: true,
      };
    });

    // 快捷方式 -- 默认参数 + 入队
    http.post("/tts/quick", async (body) => {
      if (!tts) throw new Error("TTS 不可用");
      const text = sanitizeText(body?.text, body?.maxChars || 300);
      if (!text) throw new Error("text 为空");

      const result = await tts.synthesize(text); // 全默认参数
      if (!result.ok) return { ok: false, error: result.error };

      pushToQueue(text, result);

      return { ok: true, durationMs: result.duration, queueSize: ttsQueue.length };
    });

    ctx.log("TTS 工具化端点就绪 (/tts/speak, /tts/speak-and-inject, /tts/preview, /tts/capabilities, /tts/quick)");
    return {};
  },

  destroy() {},
};