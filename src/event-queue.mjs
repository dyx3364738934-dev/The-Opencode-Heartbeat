/**
 * core/event-queue.mjs
 *
 * 事件队列 + 令牌桶代谢率控制 + 优先级调度
 *
 * 这是 furina 的"肝脏"--所有感知层事件进队列，令牌桶控制代谢率，
 * 调度器按优先级取出事件交给注入区。
 *
 * 令牌桶原理：
 *   - 桶容量 = MAX_BURST（允许瞬时突发）
 *   - 每秒补充 = REFILL_RATE（长期平均速率）
 *   - 取事件前检查令牌，不够就等
 *   - 这样既能处理突发，又不会长期超载
 */

import { EventEmitter } from "node:events";

// 优先级：数字越大越先处理
export const PRIORITY = {
  CRITICAL: 100, // 看门狗/致命错误
  HIGH: 80, // 用户主动触发
  NORMAL: 50, // 文件变化等常规感知
  LOW: 20, // 定时轮询/空闲探测
};

/**
 * 单条事件结构：
 * { id, source, type, payload, priority, createdAt }
 */
let _idCounter = 0;
function newId() {
  return `evt_${Date.now()}_${_idCounter++}`;
}

export class EventQueue extends EventEmitter {
  constructor(config = {}) {
    super();
    // 令牌桶参数
    this.maxBurst = config.maxBurst ?? 10; // 桶容量：瞬时最多 10 个事件
    this.refillRate = config.refillRate ?? 5; // 每秒补 5 个令牌（= 平均 5 事件/秒）
    this.tokens = this.maxBurst; // 初始满桶
    this.lastRefill = Date.now();

    // 代谢率上限（每小时硬上限，防止令牌桶补太快）
    this.hourlyLimit = config.hourlyLimit ?? 200; // 每小时最多 200 事件
    this.hourlyCount = 0;
    this.hourlyResetAt = this._nextHourStart();

    // 队列：按优先级分桶（同优先级 FIFO）
    this.buckets = new Map(); // priority -> []
    this.size = 0;

    // 去抖：相同 source+type+payload.hash 在 debounceMs 内只保留最后一个
    this.debounceMs = config.debounceMs ?? 500;
    this.debounceKeys = new Map(); // key -> timer

    // 状态
    this.running = false;
    this.dispatchHandler = null; // 外部注入的 dispatch 函数

    // 统计
    this.stats = {
      enqueued: 0,
      dispatched: 0,
      dropped: 0,
      debounced: 0,
      throttled: 0,
    };
  }

  /**
   * 入队一条事件
   */
  push(source, type, payload = {}, priority = PRIORITY.NORMAL) {
    // 1. 每小时上限检查
    if (this.hourlyCount >= this.hourlyLimit) {
      this.stats.dropped++;
      this.emit("drop", { reason: "hourly_limit", source, type });
      return null;
    }

    // 2. 去抖：相同 key 的事件合并
    const key = this._debounceKey(source, type, payload);
    if (key && this.debounceMs > 0) {
      return this._debouncePush(key, source, type, payload, priority);
    }

    return this._directPush(source, type, payload, priority);
  }

  _debounceKey(source, type, payload) {
    // 文件变化等事件用路径做 key；其他用 source+type
    if (payload.path) return `${source}:${type}:${payload.path}`;
    if (payload.text) return `${source}:${type}:${payload.text.slice(0, 50)}`;
    return `${source}:${type}`;
  }

  _debouncePush(key, source, type, payload, priority) {
    // 已有待去抖事件 -> 取消旧的，统计一次 debounce
    if (this.debounceKeys.has(key)) {
      clearTimeout(this.debounceKeys.get(key));
      this.stats.debounced++;
    }
    // 新建去抖 timer
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.debounceKeys.delete(key);
        resolve(this._directPush(source, type, payload, priority));
      }, this.debounceMs);
      this.debounceKeys.set(key, timer);
    });
  }

  _directPush(source, type, payload, priority) {
    const event = {
      id: newId(),
      source,
      type,
      payload,
      priority,
      createdAt: Date.now(),
    };

    if (!this.buckets.has(priority)) this.buckets.set(priority, []);
    this.buckets.get(priority).push(event);
    this.size++;
    this.stats.enqueued++;
    this.hourlyCount++;

    this.emit("push", event);
    return event.id;
  }

  /**
   * 出队一条事件（按优先级降序，同优先级 FIFO）
   * 如果令牌不够，返回 null（调用方应等待）
   */
  pop() {
    // 令牌补充
    this._refillTokens();
    if (this.tokens < 1) {
      this.stats.throttled++;
      return null;
    }

    // 按优先级从高到低找
    const priorities = [...this.buckets.keys()].sort((a, b) => b - a);
    for (const p of priorities) {
      const bucket = this.buckets.get(p);
      if (bucket && bucket.length > 0) {
        const event = bucket.shift();
        if (bucket.length === 0) this.buckets.delete(p);
        this.size--;
        this.tokens -= 1; // 消耗一个令牌
        this.stats.dispatched++;
        return event;
      }
    }
    return null; // 队列空
  }

  _refillTokens() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const refilled = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxBurst, this.tokens + refilled);
    this.lastRefill = now;

    // 每小时计数重置
    if (now >= this.hourlyResetAt) {
      this.hourlyCount = 0;
      this.hourlyResetAt = this._nextHourStart();
    }
  }

  _nextHourStart() {
    return Date.now() + 60 * 60 * 1000;
  }

  /**
   * 启动调度循环
   * @param {Function} handler - async (event) => {}，处理事件（注入 oc）
   * @param {number} intervalMs - 轮询间隔
   */
  async start(handler, intervalMs = 200) {
    if (this.running) return;
    this.running = true;
    this.dispatchHandler = handler;
    this.emit("start");

    while (this.running) {
      const event = this.pop();
      if (event) {
        this.emit("dispatch", event);
        try {
          await handler(event);
        } catch (e) {
          this.emit("error", { event, error: e });
        }
      } else {
        // 队列空或令牌不够，等一会儿
        await sleep(intervalMs);
      }
    }
    this.emit("stop");
  }

  stop() {
    this.running = false;
  }

  getStats() {
    return {
      ...this.stats,
      size: this.size,
      tokens: this.tokens.toFixed(2),
      hourlyCount: this.hourlyCount,
      hourlyLimit: this.hourlyLimit,
      buckets: [...this.buckets.entries()].map(([p, arr]) => ({
        priority: p,
        count: arr.length,
      })),
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
