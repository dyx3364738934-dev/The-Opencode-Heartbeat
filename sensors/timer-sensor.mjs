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
    this.intervalMs = config.intervalMs ?? 300000; // 5 分钟
    this.initialDelayMs = config.initialDelayMs ?? 0;
    this.message = config.message ?? "例行检查：周期性任务触发，请汇报状态或寻找改进点";
    this.priority = config.priority ?? PRIORITY.LOW;
    this.enabled = config.enabled ?? true;
    // v0.3: 触发时自动 recall（让 furina 维护 recentRecall）
    this.autoRecall = config.autoRecall ?? true;
    this.timer = null;
    this.tickCount = 0;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log(`[timer-sensor] 启动 interval=${this.intervalMs}ms delay=${this.initialDelayMs}ms autoRecall=${this.autoRecall}`);

    const fire = () => {
      if (!this.running || !this.enabled) return;
      this.tickCount++;
      this.emit({
        type: "timer.tick",
        payload: {
          message: this.message,
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
