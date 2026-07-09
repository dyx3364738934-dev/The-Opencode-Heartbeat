/**
 * sensors/base-sensor.mjs
 *
 * 感知器基类：所有传感器继承此类
 *
 * 子类需实现：
 *   - start(): 启动监听
 *   - stop(): 停止监听
 *   - 在检测到变化时调用 this.emit(event) 推入事件队列
 */

export class BaseSensor {
  constructor(name, eventQueue, config = {}) {
    this.name = name;
    this.queue = eventQueue;
    this.config = config;
    this.running = false;
  }

  /**
   * 推一条事件到队列
   */
  emit(event) {
    // event: { type, payload, priority }
    this.queue.push(
      this.name,
      event.type,
      event.payload || {},
      event.priority || 50 // 默认 NORMAL
    );
  }

  async start() {
    throw new Error(`${this.name}: start() 未实现`);
  }

  stop() {
    throw new Error(`${this.name}: stop() 未实现`);
  }
}
