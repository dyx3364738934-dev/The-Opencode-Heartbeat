/**
 * src/sentence-segmenter.mjs
 *
 * 增量文本按句分段器
 *
 * 接收 SSE textDelta 事件（增量文本片段），按句子边界切分：
 *   - 中文句号 。！？
 *   - 英文 . ! ?
 *   - 换行 \n
 *   - 分号 ；;
 *   - 省略号 …
 *
 * 完整句子立即输出（emit "sentence"），不完整部分缓冲等待后续 delta
 *
 * 用法：
 *   const seg = new SentenceSegmenter();
 *   seg.on("sentence", (sentence) => { tts.play(sentence); });
 *   seg.feed("你好，我是");      // 缓冲（无句号）
 *   seg.feed("冬蕴雪。");        // emit "你好，我是冬蕴雪。"
 *   seg.flush();                 // 强制输出剩余缓冲
 */

import { EventEmitter } from "node:events";

// 句子结束符（遇到这些就切句）
// v0.8.7: 修复 #12 -- …+ 贪婪匹配连续省略号（中文标准 …… = 两个 U+2026）
const SENTENCE_ENDINGS = /([。！？!?；;\n…]+)/;

// 最小句子长度（太短不单独成句，合并到下一句）
const MIN_SENTENCE_LENGTH = 2;

// 最大缓冲长度（超过就强制切句，防止无限累积）
const MAX_BUFFER_LENGTH = 200;

export class SentenceSegmenter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.buffer = "";
    this.minLen = options.minLen || MIN_SENTENCE_LENGTH;
    this.maxLen = options.maxLen || MAX_BUFFER_LENGTH;
    this.totalOutput = "";
    this.sentenceCount = 0;
  }

  /**
   * 喂入增量文本
   * @param {string} delta - 新增文本片段
   */
  feed(delta) {
    if (!delta) return;
    this.buffer += delta;

    // v0.8.7: 修复 #13 -- 引号状态跟踪，引号内不切句
    // 注意：不用 g flag 的正则做 .test()（g flag 会保持 lastIndex 导致结果不确定）
    const OPEN_Q = /["「『]/;
    const CLOSE_Q = /["」』]/;

    // 按句号切分
    while (true) {
      const match = this.buffer.match(SENTENCE_ENDINGS);
      if (!match) break;

      const idx = match.index;
      const ending = match[0];

      // v0.8.7: 修复 #13 -- 引号内不切句（除非缓冲超长强制切）
      if (this.buffer.length <= this.maxLen) {
        // 检查切点之前（含切点）的引号配对：如果开引号 > 闭引号，说明切点在引号内
        const beforeCut = this.buffer.slice(0, idx + ending.length);
        let qCount = 0;
        for (const ch of beforeCut) {
          if (OPEN_Q.test(ch)) qCount++;
          else if (CLOSE_Q.test(ch)) qCount--;
        }
        if (qCount > 0) break; // 切点在引号内，不切
      }

      const sentence = this.buffer.slice(0, idx + ending.length);

      // 太短的句子不单独输出，留给下一句
      if (sentence.length < this.minLen) {
        // 但如果缓冲太长，强制输出
        if (this.buffer.length > this.maxLen) {
          this._emitSentence(sentence);
          this.buffer = this.buffer.slice(idx + ending.length);
        } else {
          break; // 等更多文本
        }
      } else {
        this._emitSentence(sentence);
        this.buffer = this.buffer.slice(idx + ending.length);
      }
    }

    // 缓冲太长（没有句号但超长），强制切句
    if (this.buffer.length > this.maxLen) {
      this._emitSentence(this.buffer);
      this.buffer = "";
    }
  }

  /**
   * 强制输出缓冲区剩余文本（用于消息结束时）
   */
  flush() {
    if (this.buffer.trim()) {
      this._emitSentence(this.buffer);
      this.buffer = "";
    }
  }

  /**
   * 重置（新消息开始时）
   */
  reset() {
    this.buffer = "";
    this.totalOutput = "";
    this.sentenceCount = 0;
  }

  _emitSentence(sentence) {
    const trimmed = sentence.trim();
    if (!trimmed) return;
    this.sentenceCount++;
    this.totalOutput += trimmed;
    this.emit("sentence", trimmed, this.sentenceCount);
  }

  /**
   * 获取当前累积全文
   */
  getFullText() {
    return this.totalOutput + this.buffer;
  }

  getStats() {
    return {
      bufferLength: this.buffer.length,
      sentenceCount: this.sentenceCount,
      totalLength: this.totalOutput.length,
    };
  }
}
