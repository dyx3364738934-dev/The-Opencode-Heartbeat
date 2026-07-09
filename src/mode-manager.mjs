/**
 * src/mode-manager.mjs
 *
 * 模式管理器：三种工作模式 + 空闲注入
 *
 * 模式：
 *   self-talk  空闲时注入 selfTalkPrompts 轮转消息，形成自循环
 *   find-work  空闲时注入 findWorkPrompts 探索性任务
 *   observe    只监测不主动注入，检测到关键词才介入
 *
 * 空闲注入由 HealthChecker.onIdle 触发
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
    if (["self-talk", "find-work", "observe"].includes(mode)) {
      this.presets.set("mode", mode);
      console.log(`[mode] 切换到 ${mode}`);
      return true;
    }
    return false;
  }

  /**
   * 空闲触发：根据当前模式注入对应消息
   */
  async _onIdle() {
    this.stats.idleTriggered++;
    const mode = this.getMode();
    console.log(`[mode] 空闲触发，当前模式: ${mode}`);

    try {
      switch (mode) {
        case "self-talk":
          await this._selfTalk();
          break;
        case "find-work":
          await this._findWork();
          break;
        case "observe":
          // 观察模式不主动注入
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
    // 重新开始健康追踪
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
   * 被 main.mjs 在检测到新消息含关键词时调用
   */
  async intervene(originalMessage) {
    const mode = this.getMode();
    if (mode !== "observe") return false;

    const observe = this.presets.get("observe") || {};
    const keywords = observe.interveneKeywords || [];
    const hasKeyword = keywords.some((kw) => originalMessage?.includes(kw));

    if (hasKeyword) {
      const msg = observe.interveneMessage || "[furina] 检测到呼叫，我在线";
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
