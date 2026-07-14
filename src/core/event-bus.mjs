/**
 * src/core/event-bus.mjs
 *
 * v0.9: 插件间事件总线
 *
 * 插件通过 bus.on() 订阅事件，bus.emit() 发布事件。
 * 核心是 EventEmitter，加了命名空间和错误隔离。
 *
 * 约定的事件名（插件可自由扩展）：
 *   oc.discovered       oc 端口/密码发现成功
 *   oc.injected         消息已注入 oc { sid, text, intent, source }
 *   oc.restarted        oc 重启检测 { newPort }
 *   oc.idle             oc 进入闲置 { sid }
 *   sse.connected       SSE 连接建立
 *   sse.textDelta       SSE 文本增量 { delta, fullText, generation }
 *   sse.messageComplete SSE 消息完成 { fullText, reason, generation }
 *   tts.chunk           TTS 音频块就绪 { id, audio, text, duration }
 *   queue.beforeDispatch 事件 dispatch 前 { event } （可修改 event）
 *   queue.afterDispatch  事件 dispatch 后 { event, reply }
 *   mode.detected       模式检测命中 { mode, text }
 *   file.changed        文件变化 { path, event, size }
 *   timer.tick          定时器触发 { taskName, message, tick }
 *   health.stale        oc 卡住 { round, msg }
 *   health.dead         oc 死亡 { reason }
 *   health.recover      oc 恢复
 */

import { EventEmitter } from "node:events";

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // 插件多，提高上限
  }

  /**
   * 发布事件（所有 listener 的异常被捕获，不影响其他 listener）
   */
  emit(event, ...args) {
    const listeners = this.listeners(event);
    for (const fn of listeners) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`[bus] listener "${event}" 异常: ${e.message}`);
      }
    }
    return listeners.length > 0;
  }

  /**
   * 一次性订阅
   */
  once(event, fn) {
    super.once(event, (err, ...args) => {
      if (err) return;
      try { fn(...args); } catch (e) {
        console.error(`[bus] once "${event}" 异常: ${e.message}`);
      }
    });
  }
}
