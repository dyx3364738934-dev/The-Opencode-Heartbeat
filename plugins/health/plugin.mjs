/**
 * plugins/health/plugin.mjs
 *
 * v0.9: 健康检查插件 -- 检测 oc 卡死 + 拉起 oc
 *
 * 注入后追踪 oc state，state 不变超阈值 -> 戳醒
 * 戳醒 2 轮失败 -> 判定死亡 -> 拉起 oc
 */

import { HealthChecker } from "../../src/health-checker.mjs";

export default {
  name: "health",
  dependencies: ["oc-injector"],

  async init(ctx) {
    const { bus, presets, korina } = ctx;
    const injector = korina.injector;

    const healthChecker = new HealthChecker(injector, presets, {
      onIdle: null,
      onStale: (round, msg) => {
        ctx.log(`戳醒第${round + 1}轮: ${msg}`);
        bus.emit("health.stale", { round, msg });
      },
      onDead: (reason) => {
        ctx.log(`OC 判定死亡 (${reason})，拉起 oc`);
        bus.emit("health.dead", { reason });
        injector.spawnOC();
      },
      onRecover: () => {
        ctx.log("OC 恢复响应");
        bus.emit("health.recover");
      },
    });

    korina.healthChecker = healthChecker;
    ctx.log("健康检查就绪");

    return { healthChecker };
  },

  destroy() {},
};
