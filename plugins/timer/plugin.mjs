/**
 * plugins/timer/plugin.mjs
 *
 * v0.9: 定时器插件 -- 心跳
 * v0.9.23: 重写为 alive-v1 真实环境感知
 *   - 删模板池轮转 / 印章机制 / 闲置唤醒元指令
 *   - 加 system-sensor 调用（top 进程 / 内存 / 磁盘 / 前台窗口）
 *   - guidance 基于真实数据生成（不预设元指令）
 *
 * 从 sensors/timer-sensor.mjs 迁移，改为插件模式。
 */

import { PRIORITY } from "../../src/core/event-queue.mjs";
import { renderHeartbeatMessage, HEARTBEAT_VARIABLES } from "../../src/modules/heartbeat/template-renderer.mjs";
import { collectSystemSnapshot, formatTopProcesses, formatSystemStats, formatForeground } from "../../src/modules/heartbeat/system-sensor.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, "..", "..", "logs");
const PROJECT_ROOT = join(__dirname, "..", "..");
const HEARTBEAT_TEMPLATES_FILE = join(PROJECT_ROOT, "config", "heartbeat-templates.json");

const MIN_INTERVAL_MS = 10000;
const MAX_INTERVAL_MS = 3600000;
function humanizeMs(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} 分钟`;
  return `${(ms / 3600000).toFixed(1)} 小时`;
}
function clampInterval(ms) {
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, ms || 180000));
}

const POLL_INTERVAL_MS = 10000;

// v0.9.23: 读 alive-v1 模板（templates[0]，单模板设计）
function loadTemplate() {
  try {
    if (!existsSync(HEARTBEAT_TEMPLATES_FILE)) return "[heartbeat] {time} 第 {fireCount} 次";
    const data = JSON.parse(readFileSync(HEARTBEAT_TEMPLATES_FILE, "utf-8"));
    const pool = Array.isArray(data.templates) ? data.templates : [];
    return pool[0]?.body || "[heartbeat] {time} 第 {fireCount} 次";
  } catch {
    return "[heartbeat] {time} 第 {fireCount} 次";
  }
}

/**
 * v0.9.23: 基于真实环境数据生成引导（不是预设元指令）
 * 优先级：异常检测 > 时间感知 > 默认（该不该说话）
 *
 * v0.9.23 manual #49: idleSec 替代 idleMin（KOKO 元洞察"凭什么能看出来我'在'不在"）
 *   - 数据源：PowerShell GetLastInputInfo（鼠标+键盘真实活动）
 *   - 之前用 voice-input 活跃度是单一指标冒充综合判断
 *   - idleSec < 0 是 unknown（snapshot 失败兜底后仍未知）
 *
 * 注：top.CPU 是累计秒数（不是当前占用率），所以异常判断用 MEM（更稳定）
 */
function generateGuidance({ snapshot, kokoActivity, hour, idleSec }) {
  const top1 = snapshot?.top?.[0];
  const top1MemMB = top1?.mem || 0;
  const fg = snapshot?.foreground || "";

  // 异常：top1 进程内存 > 1.5GB（重负载）
  if (top1 && top1MemMB > 1500 && !/korina|node|powershell/i.test(top1.name)) {
    return `${top1.name}.exe 占了 ${top1MemMB}MB 内存，是不是卡了？需要的话简短说一句。`;
  }

  // idleSec 未知（snapshot 失败且 lastKokoTime 也为 0）
  if (idleSec == null || idleSec < 0) {
    return `Koko 状态未知（sensor 不可用 + lastKokoTime 为空）——主动冒泡问一句"在吗"，不要机械静默。`;
  }

  const idleMin = Math.floor(idleSec / 60);

  // 时间感知：深夜还在 oc
  // v0.9.28 manual #53: 扩展到 23-9 点（KOKO 可能睡懒觉，5 点跳到"应该不在"是误判）
  if (hour >= 23 || hour < 9) {
    if (idleMin < 30 && /OpenCode|opencode/i.test(fg)) {
      return `现在 ${hour}:${new Date().getMinutes().toString().padStart(2, "0")}，Koko 还在 oc，要不要劝睡？`;
    }
    if (idleMin < 60) {
      return `深夜 ${hour} 点，Koko ${idleMin} 分钟前活跃，无 TTS。`;
    }
    return `深夜 ${hour} 点，Koko ${Math.floor(idleMin / 60)} 小时没动，可能在睡觉，无 TTS。`;
  }

  // 默认：该不该说话
  // v0.9.28 manual #53: 5 分钟间隔下的陪伴感 guidance
  //   - KOKO 设计："时不时问一下我在干什么的那种感觉"
  //   - 心跳间隔 5 分钟，每次 fire 都是一次"轻拍"
  //   - idleMin 分档决定陪伴强度
  //   - v0.9.28b: KOKO 离开时（idleMin > 15）不主动 TTS（避免骚扰，TTS 给空气是浪费）
  if (idleMin < 5) {
    return `Koko 在线（${idleMin} 分钟前活跃）——继续刚才话题，或者主动说一句"我还在"。`;
  }
  if (idleMin < 15) {
    return `Koko ${idleMin} 分钟没说话——轻拍一下：问"在忙什么呢"或者分享自己刚才想到的小事，别机械静默。`;
  }
  if (idleMin < 60) {
    return `Koko ${idleMin} 分钟没动——可能切走了。fire 记录系统状态，但**不主动 TTS**（避免骚扰，TTS 给空气是浪费）。等 Koko 回来。`;
  }
  return `Koko ${Math.floor(idleMin / 60)} 小时没动，长时间无操作，无 TTS。`;
}

// v0.9.25 manual #50: heartbeat 投递白名单
//   - 之前 broadcast 到所有 session，打扰 KOKO 隔壁对话
//   - 现在默认只投当前 binding session；白名单扩展可投其他 session
const heartbeatFollowedSessions = new Set();

function getHeartbeatTargets(injector) {
  const targets = [];
  const primary = injector?.sessionId;
  if (primary) targets.push(primary);
  for (const sid of heartbeatFollowedSessions) {
    if (sid !== primary) targets.push(sid);
  }
  return targets;
}

export default {
  name: "timer",
  dependencies: ["oc-injector"],

  async init(ctx) {
    if (ctx.korina?.instanceRole === "shadow") {
      ctx.log("shadow 模式：跳过 timer 主动 fire（保留 HTTP 端点 /timer/tasks）");
      return { stop() {} };
    }
    const { queue, bus, presets, korina, http } = ctx;
    const injector = korina.injector;

    const tasks = new Map();
    let pollTimer = null;
    let running = false;

    // v0.9.28 manual #53: 心跳单轨——intervalMs 走完没 AI 回复就 fire
    //   - KOKO 设计（最终拍板）："AI 输出回复"是唯一有效的"在思考"信号
    //   - 信号源：sse.assistantReply（sseListener.assistantActive 桥接，覆盖 message.part.* 所有事件）
    //   - 之前 messageComplete 错了——oc 不发 session.status idle，永不触发
    //   - 新逻辑：AI 任何输出 → hb.lastFireAt = now（归零）；poll 检查 elapsed > intervalMs → fire
    //   - 节流：1 秒内只归零一次（避免高频 delta 浪费 CPU + log 刷屏）
    //   - fireCount 单一 counter（task.fireCount）
    let lastResetAt = 0;
    bus.on("sse.assistantReply", () => {
      const now = Date.now();
      if (now - lastResetAt < 1000) return;  // 1 秒节流
      lastResetAt = now;
      const hb = tasks.get("heartbeat");
      if (hb) {
        const prev = hb.lastFireAt;
        hb.lastFireAt = now;
        ctx.log(`heartbeat 计时归零（AI 回复完成）: ${prev} -> ${hb.lastFireAt}`);
      }
    });

    function loadHeartbeat() {
      const timerCfg = presets.get("timer") || {};
      const existing = tasks.get("heartbeat");
      const intervalMs = clampInterval(timerCfg.intervalMs ?? 180000);
      const message = loadTemplate();
      if (existing) {
        existing.intervalMs = intervalMs;
        existing.message = message;
        existing.enabled = timerCfg.enabled ?? true;
      } else {
        tasks.set("heartbeat", {
          name: "heartbeat",
          intervalMs,
          message,
          intent: "sensor",
          sessionId: null,
          enabled: timerCfg.enabled ?? true,
          modes: null,
          system: true,
          lastFireAt: 0,
          fireCount: 0,
        });
      }
    }
    loadHeartbeat();

    presets.onReload(() => {
      loadHeartbeat();
      const hb = tasks.get("heartbeat");
      const timerCfg = presets.get("timer") || {};
      const newInterval = clampInterval(timerCfg.intervalMs ?? hb.intervalMs);
      if (newInterval !== hb.intervalMs) {
        ctx.log(`heartbeat interval 热更新 ${humanizeMs(hb.intervalMs)} -> ${humanizeMs(newInterval)}`);
        hb.intervalMs = newInterval;
      }
    });

    // 渲染心跳消息：调 sensor + 生成 guidance
    async function renderMessageAsync(template, time, task) {
      const now = Date.now();
      const hour = new Date(now).getHours();

      // 并行采 sensor
      const snapshot = await collectSystemSnapshot();

      // v0.9.23 manual #49: Koko 活跃度改用真实鼠标+键盘 idle（PowerShell GetLastInputInfo）
      //   - 之前：injector.lastKokoTime（仅 voice-input 录音活跃度，KOKO 元洞察"凭什么能看出来我'在'不在'"）
      //   - 现在：snapshot.idleSec（鼠标+键盘真实活动秒数，Windows API 准确）
      //   - fallback：snapshot 失败时仍用 lastKokoTime（向后兼容）
      const snapshotIdleSec = (snapshot && typeof snapshot.idleSec === "number") ? snapshot.idleSec : null;
      let idleSec;
      if (snapshotIdleSec != null) {
        idleSec = snapshotIdleSec;
      } else {
        // 兜底：voice-input 活跃度（窄数据，但至少不是 0）
        const lastActive = injector?.lastKokoTime || 0;
        idleSec = lastActive > 0 ? Math.floor((now - lastActive) / 1000) : -1;
      }

      // 生成引导（基于真实数据）
      const guidance = generateGuidance({
        snapshot,
        kokoActivity: "",
        hour,
        idleSec,
      });

      return renderHeartbeatMessage(template, {
        time,
        fireCount: task.fireCount,
        task,
        korina,
        injector,
        queue,
        presets,
        snapshot,
        guidance,
        now,
        logsDir: LOGS_DIR,
        tasks: Array.from(tasks.values()).map((t) => ({
          name: t.name,
          fireCount: t.fireCount,
          enabled: t.enabled,
        })),
      });
    }

    // 轮询
    async function poll() {
      if (!running) return;
      const now = Date.now();

      for (const [name, task] of tasks) {
        if (!task.enabled) continue;
        const elapsed = now - (task.lastFireAt || 0);
        if (elapsed < task.intervalMs) continue;

        // v0.9.23: 不再做 isOCIdleAsync 闲置检测（治标不治本，且阻塞主循环 3s）
        // 改为：直接触发，sensor 数据本身就是真实的，oc 看到自行判断

        task.fireCount++;
        task.lastFireAt = now;
        const time = new Date().toTimeString().slice(0, 5);
        const message = await renderMessageAsync(task.message, time, task);

        // v0.9.25 manual #50: 去 broadcast，改用白名单 targets
        const targets = task.sessionId ? [task.sessionId] : getHeartbeatTargets(injector);
        for (const sid of targets) {
          if (!sid) continue;
          queue.push("timer-sensor", "timer.tick", {
            taskName: name, message, tick: task.fireCount,
            intent: task.intent, sessionId: sid,
          }, PRIORITY.LOW);
        }
        bus.emit("timer.tick", { taskName: name, message, tick: task.fireCount });
        ctx.log(`${name} fire #${task.fireCount}: ${message.slice(0, 80).replace(/\n/g, " | ")} -> ${targets.length} sessions (followed=${heartbeatFollowedSessions.size})`);
      }

      if (running) pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    running = true;
    poll();
    ctx.log(`启动，${tasks.size} 个任务 [heartbeat]，poll=${humanizeMs(POLL_INTERVAL_MS)}`);

    // ===== HTTP 端点（保持不变） =====
    http.get("/heartbeat/interval", () => {
      const hb = tasks.get("heartbeat");
      const elapsed = Date.now() - (hb?.lastFireAt || Date.now());
      const nextFireInMs = hb?.enabled ? Math.max(0, hb.intervalMs - elapsed) : null;
      return {
        intervalMs: hb?.intervalMs,
        intervalHuman: humanizeMs(hb?.intervalMs ?? 0),
        nextFireInMs,
        nextFireInHuman: nextFireInMs === null ? null : humanizeMs(nextFireInMs),
        tickCount: hb?.fireCount ?? 0,
        enabled: hb?.enabled,
      };
    });

    http.post("/heartbeat/interval", (body) => {
      let ms = body.ms;
      if (body.minutes) ms = body.minutes * 60 * 1000;
      if (body.seconds) ms = body.seconds * 1000;
      if (!ms) throw new Error("需要 minutes / seconds / ms");
      const clamped = clampInterval(ms);
      const hb = tasks.get("heartbeat");
      hb.intervalMs = clamped;
      presets.set("timer.intervalMs", clamped);
      return { ok: true, intervalMs: clamped, intervalHuman: humanizeMs(clamped) };
    });

    http.get("/timer/tasks", () => ({
      tasks: Array.from(tasks.values()).map((t) => ({
        name: t.name, intervalMs: t.intervalMs, intervalHuman: humanizeMs(t.intervalMs),
        message: t.message.slice(0, 60), enabled: t.enabled, fireCount: t.fireCount,
        system: t.system,
      })),
    }));

    http.post("/timer/tasks", (body) => {
      if (!body?.name) throw new Error("需要 name");
      if (!body?.message) throw new Error("需要 message");
      if (tasks.has(body.name)) throw new Error(`任务 '${body.name}' 已存在`);
      tasks.set(body.name, {
        name: body.name,
        intervalMs: clampInterval(body.intervalMs ?? 180000),
        message: body.message,
        intent: body.intent || "sensor",
        sessionId: body.sessionId || null,
        enabled: true,
        modes: body.modes || null,
        system: false,
        lastFireAt: 0, fireCount: 0,
      });
      return { ok: true, name: body.name };
    });

    http.post("/timer/tasks/delete", (body) => {
      const t = tasks.get(body?.name);
      if (!t) throw new Error(`任务不存在`);
      if (t.system) throw new Error(`系统任务不可删`);
      tasks.delete(body.name);
      return { ok: true };
    });

    // v0.9.25 manual #50: heartbeat 投递白名单端点
    http.post("/session/follow-heartbeat", (body) => {
      const sid = body?.sessionId;
      if (!sid) throw new Error("需要 sessionId");
      heartbeatFollowedSessions.add(sid);
      ctx.log(`heartbeat follow +${sid} (total=${heartbeatFollowedSessions.size})`);
      return {
        ok: true,
        sessionId: sid,
        followed: Array.from(heartbeatFollowedSessions),
        targets: getHeartbeatTargets(injector),
      };
    });
    http.post("/session/unfollow-heartbeat", (body) => {
      const sid = body?.sessionId;
      if (!sid) throw new Error("需要 sessionId");
      const removed = heartbeatFollowedSessions.delete(sid);
      ctx.log(`heartbeat follow -${sid} removed=${removed}`);
      return {
        ok: true,
        sessionId: sid,
        removed,
        followed: Array.from(heartbeatFollowedSessions),
        targets: getHeartbeatTargets(injector),
      };
    });
    http.get("/session/followed-heartbeat", () => ({
      primary: injector.sessionId,
      followed: Array.from(heartbeatFollowedSessions),
      targets: getHeartbeatTargets(injector),
    }));

    http.post("/heartbeat/prompt", (body) => {
      if (!body?.message) throw new Error("需要 message 模板");
      const hb = tasks.get("heartbeat");
      if (!hb) throw new Error("heartbeat 任务不存在");
      hb.message = body.message;
      presets.set("timer.message", body.message);
      ctx.log(`heartbeat 提示词模板已更新 (${body.message.length} 字符)`);
      return {
        ok: true,
        message: body.message.slice(0, 100) + (body.message.length > 100 ? "..." : ""),
        variables: HEARTBEAT_VARIABLES,
      };
    });

    http.get("/heartbeat/prompt", () => {
      const hb = tasks.get("heartbeat");
      return {
        message: hb?.message || "",
        variables: HEARTBEAT_VARIABLES,
      };
    });

    http.post("/heartbeat/pause", () => {
      const hb = tasks.get("heartbeat");
      if (!hb) throw new Error("heartbeat 任务不存在");
      hb.enabled = false;
      ctx.log("heartbeat 已暂停");
      return { ok: true, paused: true };
    });

    http.post("/heartbeat/resume", () => {
      const hb = tasks.get("heartbeat");
      if (!hb) throw new Error("heartbeat 任务不存在");
      hb.enabled = true;
      ctx.log("heartbeat 已恢复");
      return { ok: true, paused: false };
    });

    korina.timerTasks = tasks;

    return {
      stop() {
        running = false;
        if (pollTimer) clearTimeout(pollTimer);
      },
    };
  },

  destroy() {
    if (this.stop) this.stop();
  },
};
