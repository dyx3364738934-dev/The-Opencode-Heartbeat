/**
 * plugins/sidecar-launcher/plugin.mjs
 *
 * v0.9.6 (Milestone 5.1): 委托 SidecarRegistry 管理 voice-input。
 *
 * 之前：自行维护 sidecarStatus + checkInterval + launchSidecar
 * 现在：ko.sidecarRegistry 统一所有 sidecar，launcher 只做 wiring
 *
 * v0.9.13 (L5.3 manual #37): voice-input 改为按需启动
 *   - sidecar-launcher 不再自动拉起 voice-input
 *   - 由 /voice-input/start 端点触发（voice-input plugin 自己注册）
 *   - 多实例场景：只有"正在对话"的 korina 实例启动 voice-input，治 R3（双实例抢 Alt）
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SidecarRegistry } from "../../src/core/sidecar-registry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

export default {
  name: "sidecar-launcher",
  dependencies: ["sse-tts-pipeline"],

  async init(ctx) {
    // L5.4 shadow mode (manual #45): shadow 实例不拉 sidecar（但保留 registry 实例供 stopAll 调用）
    if (ctx.korina?.instanceRole === "shadow") {
      ctx.log("shadow 模式：跳过 sidecar 自动拉起（registry 仍创建供 gracefulShutdown stopAll）");
    }
    const { presets, korina, log } = ctx;
    const registry = new SidecarRegistry({ log });
    korina.sidecarRegistry = registry;

    // v0.9.13 (L5.3 manual #37): voice-input 改为按需启动（enabled: false）
    // 启动 /voice-input/start 端点触发（不在这里自动拉起）
    registry.register("voice-input", { scriptName: "voice-input.py", enabled: false });
    log("voice-input 已注册为按需启动（默认不拉起，由 /voice-input/start 端点触发）");

    // 启动存活检测（10s 间隔，进程死了自动把 alive=false）
    registry.startHealthCheck();

    // 暴露给 /status 用
    korina.sidecars = registry.snapshot();
    // snapshot 是 snapshot，不是引用；每 10s 同步一次保证新鲜
    const refreshTimer = setInterval(() => {
      korina.sidecars = registry.snapshot();
    }, 10000);
    if (typeof refreshTimer.unref === "function") refreshTimer.unref();

    // /sidecars/ping { name } -- 委给 registry.recordPing
    ctx.http.post("/sidecars/ping", (body) => {
      const name = body?.name;
      const result = registry.recordPing(name);
      if (!result.ok) throw new Error(result.error);
      // 立刻把新 snapshot 同步到 korina.sidecars
      korina.sidecars = registry.snapshot();
      return { ok: true, name: result.name, lastPingAt: result.lastPingAt };
    });

    // v0.9.13 (L5.3 manual #37): 删除原来的"延迟 3 秒拉起 voice-input"逻辑
    // voice-input 现在按需启动，不再自动拉起

    log("sidecar 启动器就绪（voice-input 按需启动）");

    return {
      stop() {
        clearInterval(refreshTimer);
        // gracefulShutdown 时会调 stopAll；这里只清 refresh 定时器
      },
    };
  },

  destroy() {
    if (this.stop) this.stop();
  },
};
