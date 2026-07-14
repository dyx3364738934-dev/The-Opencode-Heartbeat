/**
 * plugins/desktop-lyrics/plugin.mjs
 *
 * v0.9.6 (Milestone 5.2): 委托 SidecarRegistry。
 *
 * 之前：self manage handle + 写 korina.sidecars[desktop-lyrics]
 * 现在：registry.register/launch，korina.sidecars 来自 registry.snapshot
 *
 * 依赖顺序保证：sidecar-launcher 先 init 完建好 registry，
 * desktop-lyrics 后 init 拿 korina.sidecarRegistry 注入。
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

export default {
  name: "desktop-lyrics",
  dependencies: ["sidecar-launcher"],

  async init(ctx) {
    const { korina, log } = ctx;
    const registry = korina.sidecarRegistry;
    if (!registry) {
      log("[desktop-lyrics] korina.sidecarRegistry 未初始化（sidecar-launcher 还没跑？）");
      return {};
    }

    registry.register("desktop-lyrics", { scriptName: "desktop-lyrics.py", enabled: true });

    // 立即拉起（无需像 voice-input 等 3s）
    const result = registry.launch("desktop-lyrics", { projectRoot: PROJECT_ROOT, logsDir: LOGS_DIR });
    if (!result.ok) {
      log(`desktop-lyrics 拉起失败: ${result.error}`);
    } else {
      // 同步 korina.sidecars（让 /status 立即看到新 sidecar）
      korina.sidecars = registry.snapshot();
    }

    log("桌面歌词插件就绪（字幕 sidecar 由 SidecarRegistry 纳管）");

    return {};
  },

  destroy() {
    // stopAll 由 main.mjs.gracefulShutdown 统一调用
  },
};
