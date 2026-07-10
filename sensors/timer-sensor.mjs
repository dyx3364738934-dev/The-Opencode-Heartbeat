/**
 * sensors/timer-sensor.mjs
 *
 * 定时感知器：周期性发出 timer.tick 事件，用于周期性 dogfooding
 *
 * 配置：
 *   intervalMs: 周期（默认 300000 = 5 分钟）
 *   initialDelayMs: 启动后多久第一次触发（默认 0）
 *   message: 触发时的消息文本（默认 "例行检查"）
 *   priority: 事件优先级（默认 LOW = 20）
 *   enabled: 是否启用（默认 true，false 可临时禁用而不卸载）
 *
 * 用途：
 *   - dogfooding：让 furina 在空闲时周期性注入任务给自己
 *   - 健康检查：定时探活
 *   - 周期任务：定时总结、备份、清理
 */

import { BaseSensor } from "./base-sensor.mjs";
import { PRIORITY } from "../src/event-queue.mjs";

export class TimerSensor extends BaseSensor {
  constructor(eventQueue, config = {}) {
    super("timer-sensor", eventQueue, config);
    // v0.7.10.2: 支持 presets 引用，热加载时读最新值
    this.presets = config.presets || null;
    this.intervalMs = config.intervalMs ?? this.presets?.get?.("timer")?.intervalMs ?? 180000;
    this.initialDelayMs = config.initialDelayMs ?? this.presets?.get?.("timer")?.initialDelayMs ?? 60000;
    this.message = config.message ?? this.presets?.get?.("timer")?.message ?? "[heartbeat] {time}";
    this.priority = config.priority ?? this.presets?.get?.("timer")?.priority ?? PRIORITY.LOW;
    this.enabled = config.enabled ?? this.presets?.get?.("timer")?.enabled ?? true;
    // v0.3: 触发时自动 recall（让 furina 维护 recentRecall）
    this.autoRecall = config.autoRecall ?? this.presets?.get?.("timer")?.autoRecall ?? false;
    // v0.7.10: oc 闲置检测（可选）—— 心跳只在 oc 闲置时发送，避免打断
    this.isOCIdle = config.isOCIdle || (async () => true);
    // v0.7.10: oc 忙时最大重试次数（之后强制发送，兜底防止心跳永远跳过）
    this.maxIdleRetries = config.maxIdleRetries ?? 3;
    this.idleRetries = 0;
    this.timer = null;
    this.tickCount = 0;
    this.skippedCount = 0;

    // v0.7.10.2: 监听 presets 热加载，动态更新
    if (this.presets?.onReload) {
      this.presets.onReload((newData) => {
        this._reloadConfig();
      });
    }
  }

  _reloadConfig() {
    if (!this.presets) return;
    const timer = this.presets.get("timer") || {};
    const newInterval = timer.intervalMs ?? this.intervalMs;
    const newMessage = timer.message ?? this.message;
    const newAutoRecall = timer.autoRecall ?? this.autoRecall;
    const newEnabled = timer.enabled ?? this.enabled;
    if (newInterval !== this.intervalMs) {
      console.log(`[timer-sensor] intervalMs 热更新 ${this.intervalMs}ms → ${newInterval}ms（下次 fire 生效）`);
      this.intervalMs = newInterval;
    }
    if (newMessage !== this.message) {
      console.log(`[timer-sensor] message 热更新`);
      this.message = newMessage;
    }
    if (newAutoRecall !== this.autoRecall) {
      console.log(`[timer-sensor] autoRecall 热更新 ${this.autoRecall} → ${newAutoRecall}`);
      this.autoRecall = newAutoRecall;
    }
    if (newEnabled !== this.enabled) {
      console.log(`[timer-sensor] enabled 热更新 ${this.enabled} → ${newEnabled}`);
      this.enabled = newEnabled;
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log(`[timer-sensor] 启动 interval=${this.intervalMs}ms delay=${this.initialDelayMs}ms autoRecall=${this.autoRecall} idleCheck=${typeof this.isOCIdle === "function"}`);

    const fire = async () => {
      if (!this.running || !this.enabled) return;

      // v0.7.10: oc 闲置检测 —— 忙时跳过（不重试，下一轮 10 分钟后再判断）
      try {
        const idle = await this.isOCIdle();
        if (!idle) {
          this.idleRetries++;
          if (this.idleRetries <= this.maxIdleRetries) {
            this.skippedCount++;
            console.log(`[timer-sensor] oc 忙，跳过本次心跳 (${this.idleRetries}/${this.maxIdleRetries}，已跳过 ${this.skippedCount} 次)`);
            this.timer = setTimeout(fire, this.intervalMs);
            return;
          }
          console.log(`[timer-sensor] oc 持续忙 ${this.maxIdleRetries} 轮，强制发送心跳`);
          this.idleRetries = 0;
        } else {
          this.idleRetries = 0;
        }
      } catch (e) {
        console.warn(`[timer-sensor] 闲置检测失败: ${e.message?.slice(0, 80)}`);
      }

      this.tickCount++;
      // v0.7.10: 动态插入时间戳（如果有 {time} 占位符）
      const time = new Date().toTimeString().slice(0, 5);
      const message = this.message.replace(/\{time\}/g, time);
      this.emit({
        type: "timer.tick",
        payload: {
          message,
          tick: this.tickCount,
          intervalMs: this.intervalMs,
          autoRecall: this.autoRecall, // v0.3: 提示 dispatchHandler 自动 recall
        },
        priority: this.priority,
      });
      this.timer = setTimeout(fire, this.intervalMs);
    };

    if (this.initialDelayMs > 0) {
      this.timer = setTimeout(fire, this.initialDelayMs);
    } else {
      this.timer = setTimeout(fire, this.intervalMs);
    }
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log(`[timer-sensor] 已停止 (累计触发 ${this.tickCount} 次)`);
  }

  /**
   * 立即触发一次（手动戳醒用）
   */
  poke() {
    if (!this.running) return false;
    this.tickCount++;
    this.emit({
      type: "timer.tick",
      payload: {
        message: this.message + "（手动戳醒）",
        tick: this.tickCount,
        intervalMs: this.intervalMs,
        manual: true,
        autoRecall: this.autoRecall,
      },
      priority: this.priority,
    });
    return true;
  }
}
