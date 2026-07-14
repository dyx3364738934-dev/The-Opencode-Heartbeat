/**
 * src/memory.mjs
 *
 * 记忆区：上下文压缩（v0.8 极简）
 *
 * v0.8 改动：砍掉记忆注入链路（recall / recentRecall / checkpoint-recall）
 *   原因：记忆检索交给 oc 自己（oc 有 search_oc_memory 工具，支持语义搜索/画像/去重），
 *         korina 不再依赖私有 search_oc_memory.py，公开发布干净。
 *
 * 现在只保留：
 *   - record()：计数消息/token，到阈值触发 summarize
 *   - checkpoint()：调 oc 内置 summarize（压缩当前 session 上下文）
 *   - getStats()：状态查询
 *
 * oc 需要历史记忆时，自己调 search_oc_memory（主动、灵活），不靠 korina 注入。
 */

export class Memory {
  constructor(injector, config = {}) {
    this.injector = injector;
    this.maxMessages = config.maxMessages ?? 40;
    this.maxTokens = config.maxTokens ?? 30000;
    this.charsPerToken = config.charsPerToken ?? 2.5; // 中文约 2.5 字/token

    this.messageCount = 0;
    this.estimatedTokens = 0;
    this.lastCheckpoint = Date.now();
    this.compressing = false;
  }

  /**
   * 记录一轮对话，返回是否触发了压缩
   */
  async record(userText, assistantText) {
    this.messageCount += 2; // 一问一答
    const chars = (userText?.length || 0) + (assistantText?.length || 0);
    this.estimatedTokens += Math.ceil(chars / this.charsPerToken);

    const shouldCompress =
      this.messageCount >= this.maxMessages || this.estimatedTokens >= this.maxTokens;

    if (shouldCompress && !this.compressing) {
      await this.checkpoint();
      return true;
    }
    return false;
  }

  /**
   * 检查点：触发 oc 内置 summarize（上下文压缩）
   * v0.8：不再 recall，记忆交给 oc 自己
   */
  async checkpoint() {
    if (this.compressing) return false;
    this.compressing = true;
    try {
      console.log("[memory] 触发 oc summarize...");
      const ok = await this.injector.summarize();
      console.log(`[memory] summarize: ${ok ? "ok" : "failed"}`);

      // v0.8.7: 修复 #21 -- summarize 失败时不重置计数器（上下文实际未被压缩）
      if (ok) {
        this.messageCount = 0;
        this.estimatedTokens = 0;
        this.lastCheckpoint = Date.now();
      }
      console.log(`[memory] checkpoint 完成 (summarize=${ok ? "ok" : "skip"})`);
      return ok;
    } catch (e) {
      console.error("[memory] checkpoint 失败:", e.message);
      return false;
    } finally {
      this.compressing = false;
    }
  }

  getStats() {
    return {
      messageCount: this.messageCount,
      estimatedTokens: this.estimatedTokens,
      maxMessages: this.maxMessages,
      maxTokens: this.maxTokens,
      lastCheckpointAgo: Math.round((Date.now() - this.lastCheckpoint) / 1000) + "s",
      compressing: this.compressing,
    };
  }
}
