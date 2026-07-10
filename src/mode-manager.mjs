/**
 * src/mode-manager.mjs
 *
 * 模式管理器：五种工作模式
 *
 * 模式：
 *   silent     完全不主动注入（agent 完全自由）
 *   idle       只发心跳（timer-sensor 触发），不派活
 *   task       心跳 + 派活提示
 *   self-talk  空闲时注入 selfTalkPrompts 轮转消息
 *   find-work  空闲时注入 findWorkPrompts 探索性任务
 *   observe    只监测不主动注入，检测到关键词才介入
 *
 * 空闲注入由 HealthChecker.onIdle 触发（仅 self-talk/find-work 模式）
 */

export class ModeManager {
  constructor(injector, presets, healthChecker) {
    this.injector = injector;
    this.presets = presets;
    this.healthChecker = healthChecker;

    // 统计
    this.stats = {
      idleTriggered: 0,
      selfTalkInjected: 0,
      findWorkInjected: 0,
      observeIntervened: 0,
    };

    // 接管 healthChecker 的 onIdle 回调
    this.healthChecker.onIdle = () => this._onIdle();
  }

  getMode() {
    return this.presets.get("mode");
  }

  setMode(mode) {
    if (["silent", "idle", "task", "self-talk", "find-work", "observe"].includes(mode)) {
      this.presets.set("mode", mode);
      console.log(`[mode] 切换到 ${mode}`);
      return true;
    }
    return false;
  }

  /**
   * 空闲触发：根据当前模式注入对应消息
   * v0.7.10: silent/idle 模式不响应 onIdle（避免干扰）
   */
  async _onIdle() {
    this.stats.idleTriggered++;
    const mode = this.getMode();
    console.log(`[mode] 空闲触发，当前模式: ${mode}`);

    try {
      switch (mode) {
        case "silent":
          console.log("[mode] silent 模式，不主动注入");
          break;
        case "idle":
          console.log("[mode] idle 模式：依赖 timer-sensor 发心跳");
          break;
        case "task":
          await this._findWork(); // 复用 findWork 逻辑
          break;
        case "self-talk":
          await this._selfTalk();
          break;
        case "find-work":
          await this._findWork();
          break;
        case "observe":
          console.log("[mode] 观察模式，不主动注入");
          break;
      }
    } catch (e) {
      console.error(`[mode] 空闲注入失败: ${e.message}`);
    }
  }

  async _selfTalk() {
    const prompt = this.presets.nextPrompt("selfTalkPrompts");
    if (!prompt) {
      console.log("[mode] selfTalkPrompts 为空，跳过");
      return;
    }
    console.log(`[mode] 自我对话注入: ${prompt}`);
    await this.injector.inject(prompt);
    this.stats.selfTalkInjected++;
    this.healthChecker.startTracking();
  }

  async _findWork() {
    const prompt = this.presets.nextPrompt("findWorkPrompts");
    if (!prompt) {
      console.log("[mode] findWorkPrompts 为空，跳过");
      return;
    }
    console.log(`[mode] 找事做注入: ${prompt}`);
    await this.injector.inject(prompt);
    this.stats.findWorkInjected++;
    this.healthChecker.startTracking();
  }

  /**
   * 观察模式下的关键词介入
   */
  async intervene(originalMessage) {
    const mode = this.getMode();
    if (mode !== "observe") return false;

    const observe = this.presets.get("observe") || {};
    const keywords = observe.interveneKeywords || [];
    const hasKeyword = keywords.some((kw) => originalMessage?.includes(kw));

    if (hasKeyword) {
      const msg = observe.interveneMessage || "[heartbeat] 检测到呼叫，我在线";
      console.log(`[mode] 观察模式关键词介入: ${msg}`);
      await this.injector.inject(msg);
      this.stats.observeIntervened++;
      this.healthChecker.startTracking();
      return true;
    }
    return false;
  }

  getStats() {
    return {
      ...this.stats,
      mode: this.getMode(),
    };
  }
}
