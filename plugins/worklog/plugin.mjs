/**
 * plugins/worklog/plugin.mjs
 *
 * v0.9: 工作汇报插件 -- 每小时生成一份工作日志
 */

import { WorkLog } from "../../src/worklog.mjs";

export default {
  name: "worklog",
  dependencies: [],

  async init(ctx) {
    // L5.4 shadow mode (manual #45): shadow 实例不写 worklog（不主动 fire）
    if (ctx.korina?.instanceRole === "shadow") {
      ctx.log("shadow 模式：跳过 worklog 主动 fire");
      return { stop() {} };
    }
    const worklog = new WorkLog({ intervalMs: 60 * 60 * 1000 });
    worklog.start();
    ctx.log("工作汇报系统已启动 (1h)");
    return { worklog };
  },

  destroy() {
    this.worklog?.stop?.();
  },
};
