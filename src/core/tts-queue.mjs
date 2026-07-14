/**
 * src/core/tts-queue.mjs
 *
 * v0.9.5: TTS 播放队列共享工具 -- 之前 sse-tts-pipeline 和 tts-tool 各有一份 push 实现
 * （tts-tool 叫 pushToQueue，sse-tts-pipeline 叫 pushTTS），逻辑完全相同。
 * 抽到这里统一，避免改一处忘另一处。
 *
 * 用法：
 *   import { pushTTS } from "../../src/core/tts-queue.mjs";
 *   pushTTS(queue, text, result, { logger: ctx.log, maxQueueSize: 50 });
 */

const DEFAULT_MAX_QUEUE = 50;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function pushTTS(queue, text, result, opts = {}) {
  if (!Array.isArray(queue)) throw new Error("tts-queue: queue 必须是数组");
  if (!text) throw new Error("tts-queue: text 必填");
  if (!result || !result.audio) throw new Error("tts-queue: result.audio 必填");

  const maxQueueSize = opts.maxQueueSize || DEFAULT_MAX_QUEUE;
  const logger = opts.logger || console;

  if (queue.length >= maxQueueSize) {
    queue.shift();
    (logger.warn || console.warn)(`[tts-queue] 队列已满(${maxQueueSize})，丢弃最旧项`);
  }

  queue.push({
    id: `tts_${Date.now()}_${generateId(6)}`,
    text,
    audioBase64: result.audio.toString("base64"),
    format: result.format,
    duration: result.duration,
    createdAt: Date.now(),
  });
}

function generateId(len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return s;
}