/**
 * src/tts.mjs
 *
 * TTS 模块 -- MiniMax T2A 封装
 *
 * 端点：https://api.minimaxi.com/v1/t2a_v2（国内版）
 * 模型：speech-2.8-turbo（快）/ speech-2.8-hd（高质量）
 *
 * v0.9.2: 完整表达参数支持
 *   - emotion: 7 种情绪（happy/sad/angry/fearful/disgusted/surprised/neutral + calm[2.5+]）
 *   - speed: [0.5, 2]，默认 1.0
 *   - pitch: [-12, 12]，默认 0
 *   - vol: (0, 10]，默认 1.0
 *   - 文本内停顿：`<#0.5#>`（秒，0.01-99.99）
 *   - 文本内感叹词：(laughs) (sighs) (breath) (emm) 等 19 种（speech-2.8 专属）
 *
 * 用法：
 *   const tts = new TTS(config);
 *
 *   // 基础用法（用默认参数）
 *   const r1 = await tts.synthesize("你好");
 *
 *   // 带情绪 + 语速
 *   const r2 = await tts.synthesize("太好了！", { emotion: "happy", speed: 1.2 });
 *
 *   // 带停顿 + 感叹词（speech-2.8 专属）
 *   const r3 = await tts.synthesize(
 *     "嗯<#0.5#>让我想想(sighs)好吧",
 *     { emotion: "neutral", speed: 0.9 }
 *   );
 *
 *   // 保存到文件
 *   const f = await tts.synthesizeToFile("你好", "hello.mp3");
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// v0.9.2: keepAlive agent 复用 TCP+TLS 连接
// 修复 agent: false 导致每次请求新建连接 -- 首次请求 DNS+TCP+TLS 延迟方差大，稳定超时
// 定期销毁重建（5 分钟）避免 socket pool 长跑死锁
let _ttsAgent = null;
let _ttsAgentCreatedAt = 0;
const AGENT_TTL = 5 * 60 * 1000; // 5 分钟重建

function getTtsAgent() {
  const now = Date.now();
  if (_ttsAgent && now - _ttsAgentCreatedAt < AGENT_TTL) return _ttsAgent;
  // 销毁旧 agent
  if (_ttsAgent) {
    try { _ttsAgent.destroy(); } catch {}
  }
  _ttsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 5,
    maxFreeSockets: 2,
    timeout: 30000,
    scheduling: "lifo", // 优先用最近空闲的 socket（热连接）
  });
  _ttsAgentCreatedAt = now;
  return _ttsAgent;
}

export class TTS {
  constructor(config = {}) {
    this.enabled = config.enabled ?? true;
    this.endpoint = config.endpoint || "https://api.minimaxi.com/v1/t2a_v2";
    this.apiKey = config.apiKey || process.env.MINIMAX_API_KEY || "";
    this.model = config.model || "speech-2.8-turbo";
    this.voiceId = config.voiceId || "Chinese (Mandarin)_IntellectualGirl";
    this.voiceSetting = config.voiceSetting || { speed: 1.0, vol: 1.0, pitch: 0 };
    this.audioSetting = config.audioSetting || {
      sample_rate: 32000,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    };
    this.outputDir = config.outputDir || join(PROJECT_ROOT, "logs", "tts");

    if (!existsSync(this.outputDir)) {
      try {
        mkdirSync(this.outputDir, { recursive: true });
      } catch (e) {
        console.warn(`[tts] 创建输出目录失败: ${e.message}`);
      }
    }

    this._callCount = 0;
  }

  /**
   * 合成语音（带重试 + 完整参数控制）
   * @param {string} text - 要合成的文本。可包含：
   *                         - `<#0.5#>` 停顿标记（秒，0.01-99.99）
   *                         - `(laughs)` `(sighs)` `(breath)` 等 19 种感叹词（speech-2.8 专属）
   * @param {object} [opts] - 表达参数
   * @param {string} [opts.emotion] - 情绪：happy/sad/angry/fearful/disgusted/surprised/neutral/calm（2.5+）
   *                                   注：情绪会"染色"整段文本，但无法精确控制某一段
   * @param {number} [opts.speed] - 语速 [0.5, 2]，默认 1.0
   * @param {number} [opts.pitch] - 音调 [-12, 12]，默认 0
   * @param {number} [opts.vol] - 音量 (0, 10]，默认 1.0
   * @param {number} [opts.retries] - 重试次数（默认 2）
   * @returns {Promise<{ok, audio?, format?, duration?, characters?, elapsed?, emotion?, error?}>}
   */
  async synthesize(text, opts = {}) {
    if (!this.enabled) return { ok: false, error: "TTS 未启用" };
    if (!this.apiKey) return { ok: false, error: "apiKey 未配置" };
    if (!text || !text.trim()) return { ok: false, error: "text 为空" };

    // 参数验证（超出范围直接拒绝，不让 API 报错）
    const emotion = opts.emotion;
    const validEmotions = ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral", "calm"];
    if (emotion && !validEmotions.includes(emotion)) {
      return { ok: false, error: `无效 emotion: ${emotion}（可选: ${validEmotions.join(", ")}）` };
    }

    const speed = opts.speed ?? this.voiceSetting.speed ?? 1.0;
    const pitch = opts.pitch ?? this.voiceSetting.pitch ?? 0;
    const vol = opts.vol ?? this.voiceSetting.vol ?? 1.0;
    if (speed < 0.5 || speed > 2) return { ok: false, error: `speed 越界: ${speed}（[0.5, 2]）` };
    if (pitch < -12 || pitch > 12) return { ok: false, error: `pitch 越界: ${pitch}（[-12, 12]）` };
    if (vol <= 0 || vol > 10) return { ok: false, error: `vol 越界: ${vol}（(0, 10]）` };

    const retries = opts.retries ?? 2;
    const params = { emotion, speed, pitch, vol };

    for (let attempt = 0; attempt <= retries; attempt++) {
      const result = await this._synthesizeOnce(text, params);
      if (result.ok) return result;
      // v0.8.7: H4-tts 修复 -- 不可恢复的错误不重试（401 鉴权失败 / 400 参数错误 / 余额不足）
      if (result.status === 1004 || result.status === 2013 || result.status === 1042) {
        console.warn(`[tts] 不可恢复错误 (status=${result.status})，不重试: ${result.error}`);
        return result;
      }
      if (attempt < retries) {
        console.log(`[tts] 重试 ${attempt + 1}/${retries}...`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        return result;
      }
    }
    // v0.8.7: 兜底（retries 为负数时不会进循环）
    return { ok: false, error: "unreachable" };
  }

  async _synthesizeOnce(text, params = {}) {
    const url = new URL(this.endpoint);
    // v0.9.2: 完整参数透传（emotion + speed + pitch + vol）
    const voiceSetting = {
      voice_id: this.voiceId,
      ...this.voiceSetting,
      speed: params.speed,
      vol: params.vol,
      pitch: params.pitch,
    };
    // emotion 在 voice_setting 之外（API 文档位置）
    const bodyObj = {
      model: this.model,
      text,
      voice_setting: voiceSetting,
      audio_setting: this.audioSetting,
    };
    if (params.emotion) {
      bodyObj.emotion = params.emotion;
    }
    const body = JSON.stringify(bodyObj);

    const start = Date.now();

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          agent: getTtsAgent(), // v0.9.2: keepAlive 复用连接（修复 agent:false 稳定超时）
          timeout: 30000, // v0.9.2: 15s -> 30s（给首次连接留余量）
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const elapsed = Date.now() - start;
            const raw = Buffer.concat(chunks).toString("utf-8");
            try {
              const data = JSON.parse(raw);
              if (data.base_resp?.status_code !== 0) {
                console.warn(`[tts] 合成失败 (${elapsed}ms): ${data.base_resp?.status_msg}`);
                return resolve({ ok: false, status: data.base_resp?.status_code, error: data.base_resp?.status_msg || "TTS 失败", elapsed });
              }
              this._callCount++;
              const audioHex = data.data?.audio || "";
              const audioBuf = Buffer.from(audioHex, "hex");
              const emotionTag = params.emotion ? ` emotion=${params.emotion}` : "";
              console.log(
                `[tts] 合成成功 (${elapsed}ms): ${text.length}字 -> ${audioBuf.length}bytes, ` +
                  `时长=${data.extra_info?.audio_length}ms, speed=${params.speed}, pitch=${params.pitch}, vol=${params.vol}${emotionTag}, 累计调用=${this._callCount}`
              );
              resolve({
                ok: true,
                audio: audioBuf,
                format: data.extra_info?.audio_format || "mp3",
                duration: data.extra_info?.audio_length || 0,
                characters: data.extra_info?.word_count || text.length,
                elapsed,
                emotion: params.emotion,
              });
            } catch (e) {
              resolve({ ok: false, error: `解析失败: ${e.message?.slice(0, 60)}`, elapsed });
            }
          });
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error("timeout 30s"));
      });
      req.on("error", (e) => {
        const elapsed = Date.now() - start;
        console.warn(`[tts] 合成异常 (${elapsed}ms): ${e.message?.slice(0, 100)}`);
        resolve({ ok: false, error: `${e.message?.slice(0, 80)}`, elapsed });
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * 合成并保存到文件
   * @param {string} text - 要合成的文本
   * @param {string} filename - 文件名（如 "001.mp3"）
   * @returns {Promise<{ok, filepath?, duration?, error?}>}
   */
  async synthesizeToFile(text, filename) {
    const result = await this.synthesize(text);
    if (!result.ok) return result;

    const filepath = join(this.outputDir, filename);
    try {
      writeFileSync(filepath, result.audio);
      return { ...result, filepath };
    } catch (e) {
      return { ok: false, error: `写入文件失败: ${e.message}` };
    }
  }

  /**
   * 获取状态
   */
  getStats() {
    return {
      enabled: this.enabled,
      endpoint: this.endpoint,
      model: this.model,
      voiceId: this.voiceId,
      outputDir: this.outputDir,
      callCount: this._callCount,
      apiKeyConfigured: !!this.apiKey,
      capabilities: {
        emotions: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral", "calm"],
        speedRange: [0.5, 2],
        pitchRange: [-12, 12],
        volRange: [0.1, 10],
        pauseInText: "<#seconds#>", // e.g. <#0.5#> = 0.5s pause
        exclamations: ["(laughs)", "(chuckle)", "(coughs)", "(clear-throat)", "(groans)",
                        "(breath)", "(pant)", "(inhale)", "(exhale)", "(gasps)",
                        "(sniffs)", "(sighs)", "(snorts)", "(burps)", "(lip-smacking)",
                        "(humming)", "(hissing)", "(emm)", "(sneezes)"],
        requiresModel28: "speech-2.8+",
      },
    };
  }
}
