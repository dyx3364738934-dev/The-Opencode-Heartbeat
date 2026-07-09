/**
 * core/memory.mjs
 *
 * 记忆区：上下文压缩 + 记忆落盘
 *
 * 触发条件（满足任一）：
 *   1. 消息数 >= maxMessages（默认 40 条）
 *   2. 估算 token 数 >= maxTokens（默认 30000）
 *   3. 外部显式调用 forceCheckpoint()
 *
 * 压缩流程：
 *   1. 调 oc HTTP API POST /session/:id/summarize 触发内置压缩
 *   2. 调 search_oc_memory.py --last 1h --by session 把近期对话写入 opencode.db
 *   3. 可选：fork 新 session 继承摘要（防止单 session 无限膨胀）
 *
 * 记忆落盘不是"永久存储"--opencode.db 本身就是 sqlite，
 * search_oc_memory.py 只是把"最近 1 小时的对话按 session 聚合"读出来，
 * 方便下次新 session 启动时 AI 能 search 到历史。
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export class Memory {
  constructor(injector, config = {}) {
    this.injector = injector;
    this.maxMessages = config.maxMessages ?? 40;
    this.maxTokens = config.maxTokens ?? 30000;
    this.charsPerToken = config.charsPerToken ?? 2.5; // 中文约 2.5 字/token

    // search_oc_memory.py 路径
    this.memoryScript = config.memoryScript ?? join(homedir(), "search_oc_memory.py");
    this.pythonCmd = config.pythonCmd ?? "python";

    // 状态
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
   * 强制检查点：压缩 + 记忆落盘
   */
  async checkpoint() {
    if (this.compressing) return false;
    this.compressing = true;
    try {
      // 1. 触发 oc 内置压缩
      console.log("[memory] 触发 oc summarize...");
      const ok = await this.injector.summarize();
      console.log(`[memory] summarize: ${ok ? "ok" : "failed"}`);

      // 2. 记忆落盘到 opencode.db（通过 search_oc_memory.py 读取，本身不写入--
      //    opencode.db 是 oc 自己写的，我们只是确认能读到）
      //    真正的"落盘"是 oc summarize 后 compaction part 自动写入 db
      await this._verifyMemoryAccessible();

      // 3. 重置计数
      this.messageCount = 0;
      this.estimatedTokens = 0;
      this.lastCheckpoint = Date.now();
      console.log("[memory] checkpoint 完成");
      return true;
    } catch (e) {
      console.error("[memory] checkpoint 失败:", e.message);
      return false;
    } finally {
      this.compressing = false;
    }
  }

  /**
   * 验证记忆可读（调 search_oc_memory.py --last 1h --stats）
   * 如果脚本能跑通，说明 opencode.db 里的对话历史是可检索的
   */
  async _verifyMemoryAccessible() {
    if (!existsSync(this.memoryScript)) {
      console.warn(`[memory] search_oc_memory.py 不存在: ${this.memoryScript}`);
      return false;
    }
    try {
      const out = execFileSync(this.pythonCmd, [this.memoryScript, "--last", "1h", "--stats"], {
        encoding: "utf-8",
        timeout: 15000,
        windowsHide: true,
      });
      console.log("[memory] 近 1h 记忆统计:", out.trim().slice(0, 200));
      return true;
    } catch (e) {
      console.warn("[memory] 记忆验证失败:", e.message?.slice(0, 100));
      return false;
    }
  }

  /**
   * 检索历史记忆（给 AI 用的上下文补充）
   */
  async recall(query, options = {}) {
    if (!existsSync(this.memoryScript)) return null;
    const args = [this.memoryScript];
    if (query) {
      args.push("--query", query);
    } else {
      args.push("--last", options.last ?? "7d");
    }
    if (options.by) args.push("--by", options.by);
    if (options.limit) args.push("--limit", String(options.limit));
    args.push("--json");

    try {
      const out = execFileSync(this.pythonCmd, args, {
        encoding: "utf-8",
        timeout: 15000,
        windowsHide: true,
      });
      return out.trim() || null;
    } catch (e) {
      console.warn("[memory] recall 失败:", e.message?.slice(0, 100));
      return null;
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
