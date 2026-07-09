/**
 * src/health-checker.mjs
 *
 * 健康检测器：追踪 oc 的 state 判断死活，戳醒升级链
 *
 * 核心逻辑：
 *   注入消息后，轮询最后一条消息的 state
 *   - state = streaming/tool_call + parts 在变 -> 正常思考
 *   - state = streaming/tool_call + parts N 秒不变 -> 可能卡了 -> 戳醒
 *   - state = completed -> 正常完成，通知空闲
 *   - state = error/aborted -> 直接戳醒
 *
 * 戳醒升级链：
 *   第1轮：发 pokeMessages[0] -> 等 pokeIntervalMs
 *   第2轮：发 pokeMessages[1] -> 等 pokeIntervalMs
 *   仍无响应 -> 触发 onDead 回调（看门狗重启 oc）
 */

export class HealthChecker {
  constructor(injector, presets, callbacks = {}) {
    this.injector = injector;
    this.presets = presets;
    this.onIdle = callbacks.onIdle || (() => {});
    this.onStale = callbacks.onStale || (() => {});
    this.onDead = callbacks.onDead || (() => {});
    this.onRecover = callbacks.onRecover || (() => {});

    this.tracking = false;
    this.lastState = null;
    this.lastPartsHash = "";
    this.lastChangeTime = 0;
    this.pokeRound = 0;
    this.injectedTime = 0;
    this.pollTimer = null;
  }

  /**
   * 开始追踪一次注入后的健康状态
   * @param {number} injectedMessageTime - 注入消息的时间戳
   */
  startTracking(injectedMessageTime = Date.now()) {
    this.stopTracking();
    this.tracking = true;
    this.injectedTime = injectedMessageTime;
    this.lastState = null;
    this.lastPartsHash = "";
    this.lastChangeTime = Date.now();
    this.pokeRound = 0;
    this._poll();
  }

  stopTracking() {
    this.tracking = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async _poll() {
    if (!this.tracking) return;

    const hc = this.presets.get("healthCheck");
    const pollInterval = 5000; // 5 秒轮询一次

    try {
      const { base, headers } = await this.injector.discover();
      const sid = this.injector.sessionId;
      if (!sid) {
        this.pollTimer = setTimeout(() => this._poll(), pollInterval);
        return;
      }

      const r = await fetch(`${base}/session/${sid}/message?limit=1`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        this.pollTimer = setTimeout(() => this._poll(), pollInterval);
        return;
      }
      const msgs = await r.json();
      if (!Array.isArray(msgs) || !msgs.length) {
        this.pollTimer = setTimeout(() => this._poll(), pollInterval);
        return;
      }

      const latest = msgs[msgs.length - 1];
      const state = latest.info?.state || "";
      const partsHash = this._hashParts(latest.parts || []);
      const now = Date.now();

      // 检测变化
      const stateChanged = state !== this.lastState;
      const partsChanged = partsHash !== this.lastPartsHash;

      if (stateChanged || partsChanged) {
        this.lastState = state;
        this.lastPartsHash = partsHash;
        this.lastChangeTime = now;
        // 有变化，重置戳醒计数
        if (this.pokeRound > 0) {
          console.log(`[health] 检测到恢复，state=${state}`);
          this.pokeRound = 0;
          this.onRecover();
        }
      }

      // 判断状态
      const staleMs = now - this.lastChangeTime;

      if (state === "completed" || state === "") {
        // 完成或无 state（旧消息）-> 检查是否空闲
        const idleThreshold = this.presets.get("idleThresholdMs");
        const idleMs = now - this.injectedTime;
        if (idleMs > idleThreshold && this.pokeRound === 0) {
          // 空闲了，触发模式逻辑
          this.onIdle();
          // 空闲后重置注入时间，避免重复触发
          this.injectedTime = now;
        }
      } else if (state === "error" || state === "aborted") {
        // 出错 -> 直接戳醒
        console.log(`[health] state=${state}，直接戳醒`);
        await this._poke();
      } else if (staleMs > hc.staleStateMs) {
        // streaming/tool_call 但长时间没变化 -> 戳醒
        console.log(`[health] state=${state} ${staleMs}ms 无变化，戳醒第 ${this.pokeRound + 1} 轮`);
        await this._poke();
      } else {
        // 正常思考中
        if (staleMs > 30000) {
          console.log(`[health] 思考中 state=${state} ${Math.round(staleMs / 1000)}s`);
        }
      }
    } catch (e) {
      // 网络/解析错误，继续轮询
      console.warn(`[health] 轮询错误: ${e.message}`);
    }

    this.pollTimer = setTimeout(() => this._poll(), pollInterval);
  }

  async _poke() {
    const hc = this.presets.get("healthCheck");
    const pokeMessages = hc.pokeMessages || [];

    if (this.pokeRound >= hc.maxPokeRounds) {
      // 戳醒用尽了，判定死亡
      console.error(`[health] 戳醒 ${hc.maxPokeRounds} 轮失败，判定 oc 死亡`);
      this.onDead("poke_exhausted");
      return;
    }

    const msg = pokeMessages[this.pokeRound] || `你还在吗？（第 ${this.pokeRound + 1} 轮戳醒）`;
    console.log(`[health] 戳醒: ${msg}`);
    this.onStale(this.pokeRound, msg);

    try {
      await this.injector.inject(msg);
      this.pokeRound++;
      // 戳醒后重置变化时间，给 oc 时间响应
      this.lastChangeTime = Date.now();
    } catch (e) {
      console.error(`[health] 戳醒注入失败: ${e.message}`);
      // 注入都失败了，oc 可能已经挂了
      this.onDead("inject_failed");
    }
  }

  _hashParts(parts) {
    // 简单 hash：type + text 长度 + 前 50 字符
    return parts
      .map((p) => `${p.type}:${(p.text || "").length}:${(p.text || "").slice(0, 50)}`)
      .join("|")
      .slice(0, 500);
  }
}
