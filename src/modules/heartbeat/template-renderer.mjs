import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTopProcesses, formatSystemStats, formatForeground } from "./system-sensor.mjs";
import { pickActivityLine } from "./koko-activity-templates.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, "..", "..", "..", "logs");
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const HEARTBEAT_TEMPLATES_FILE = join(PROJECT_ROOT, "config", "heartbeat-templates.json");
const ACTIVE_FILE = join(PROJECT_ROOT, "ACTIVE.md");

// v0.9.23: alive-v1 真实环境变量（5 个核心 + 6 个 legacy 兼容）
export const HEARTBEAT_VARIABLES = Object.freeze([
  // alive-v1 核心
  "{time}", "{fireCount}", "{intervalHuman}",
  "{topProcesses}", "{systemStats}", "{foregroundWindow}",
  "{kokoActivity}", "{guidance}",
  // legacy（保留向后兼容，alive-v1 不用）
  "{pid}", "{uptime}", "{uptimeHuman}", "{mode}",
  "{ocState}", "{ocPort}", "{queueSize}",
  "{think}", "{kokoIdle}", "{fileChanges}",
  "{topTask}",
]);

function dayPeriodForHour(h) {
  if (h < 6) return "深夜";
  if (h < 12) return "早晨/上午";
  if (h < 14) return "中午";
  if (h < 18) return "下午";
  if (h < 22) return "晚上";
  return "深夜";
}

function humanizeSeconds(sec) {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.round((sec % 3600) / 60)} 分`;
}

function loadTemplates() {
  try {
    if (!existsSync(HEARTBEAT_TEMPLATES_FILE)) return [];
    const data = JSON.parse(readFileSync(HEARTBEAT_TEMPLATES_FILE, "utf-8"));
    return Array.isArray(data.templates) ? data.templates : [];
  } catch {
    return [];
  }
}

function getTopTask() {
  try {
    if (existsSync(ACTIVE_FILE)) {
      const active = readFileSync(ACTIVE_FILE, "utf-8");
      const m = active.match(/<!--\s*topTask:\s*(.+?)\s*-->/);
      if (m) return m[1].trim();
    }
  } catch {}
  return "(无 ACTIVE.md topTask)";
}

function readVoiceTarget(logsDir) {
  try {
    const tf = join(logsDir, "voice-input-target.json");
    if (!existsSync(tf)) return "未绑定(跟随默认)";
    const data = JSON.parse(readFileSync(tf, "utf-8"));
    return `已绑定→${data.title || data.sessionId?.slice(0, 14)}`;
  } catch {
    return "未绑定(跟随默认)";
  }
}

/**
 * Render a heartbeat template using the runtime context.
 *
 * v0.9.23: 支持 alive-v1 真实环境变量
 *
 * @param {string} template - raw template body
 * @param {object} ctx - { time, fireCount, task, korina, injector, queue, presets, sidecarStatus?, snapshot?, guidance?, thinkPrompt?, now, logsDir }
 * @returns {string}
 */
export function renderHeartbeatMessage(template, ctx = {}) {
  if (typeof template !== "string") return "";
  const {
    time = new Date().toTimeString().slice(0, 5),
    fireCount = 0,
    task = { fireCount: 0, intervalMs: 0, _ocState: "unknown" },
    korina = {},
    injector = korina.injector || null,
    queue = null,
    presets = null,
    sidecarStatus = korina.sidecars || {},
    snapshot = null,        // v0.9.23: system-sensor 快照
    guidance = "",          // v0.9.23: 基于真实数据的引导
    thinkPrompt = "",
    now = Date.now(),
    logsDir = LOGS_DIR,
  } = ctx;

  let msg = template;
  const date = new Date(now);
  const hour = date.getHours();

  // ===== alive-v1 核心变量 =====
  msg = msg.replace(/\{time\}/g, time);
  msg = msg.replace(/\{fireCount\}/g, String(fireCount));
  if (msg.includes("{intervalHuman}")) {
    msg = msg.replace(/\{intervalHuman\}/g, humanizeMs(task.intervalMs ?? 0));
  }

  // 真实环境快照（v0.9.23）
  if (msg.includes("{topProcesses}")) {
    msg = msg.replace(/\{topProcesses\}/g, formatTopProcesses(snapshot));
  }
  if (msg.includes("{systemStats}")) {
    msg = msg.replace(/\{systemStats\}/g, formatSystemStats(snapshot));
  }
  if (msg.includes("{foregroundWindow}")) {
    msg = msg.replace(/\{foregroundWindow}\}/g, formatForeground(snapshot));
    msg = msg.replace(/\{foregroundWindow\}/g, formatForeground(snapshot));
  }

  // Koko 活跃状态描述
  if (msg.includes("{kokoActivity}")) {
    msg = msg.replace(/\{kokoActivity\}/g, describeKokoActivity(injector, snapshot, now));
  }

  // 引导思考（caller 已根据环境数据生成）
  if (msg.includes("{guidance}")) {
    msg = msg.replace(/\{guidance\}/g, guidance || "现在该不该说话？");
  }

  // ===== legacy 变量（保留兼容，alive-v1 不用）=====
  msg = msg.replace(/\{hourOfDay\}/g, String(hour));
  msg = msg.replace(/\{dayPeriod\}/g, dayPeriodForHour(hour));

  if (msg.includes("{pid}")) msg = msg.replace(/\{pid\}/g, String(process.pid));
  if (msg.includes("{uptime}") || msg.includes("{uptimeHuman}")) {
    const sec = Math.round(process.uptime());
    msg = msg.replace(/\{uptime\}/g, String(sec));
    msg = msg.replace(/\{uptimeHuman\}/g, humanizeSeconds(sec));
  }

  if (msg.includes("{tasks}")) {
    const arr = Array.isArray(ctx.tasks) ? ctx.tasks : [];
    const summary = arr
      .map((t) => `${t.name}(${t.fireCount ?? 0}次${t.enabled === false ? ",停" : ""})`)
      .join(", ");
    msg = msg.replace(/\{tasks\}/g, `${arr.length} 个：${summary || "(无)"}`);
  }

  if (msg.includes("{mode}")) {
    const mode = presets ? (presets.get("mode") || "silent") : "silent";
    msg = msg.replace(/\{mode\}/g, mode);
  }

  if (msg.includes("{ocState}")) msg = msg.replace(/\{ocState\}/g, task._ocState || "unknown");
  if (msg.includes("{ocPort}")) {
    let port = "?";
    try {
      const base = korina.ocBase || injector?.serverConfig?.base || "";
      const m = String(base).match(/:(\d+)/);
      if (m) port = m[1];
    } catch {}
    msg = msg.replace(/\{ocPort\}/g, port);
  }
  if (msg.includes("{queueSize}") && queue) msg = msg.replace(/\{queueSize\}/g, String(queue.size ?? 0));

  if (msg.includes("{kokoIdle}")) {
    const lastActive = injector?.lastKokoTime || 0;
    const idleMs = lastActive > 0 ? now - lastActive : -1;
    let s = "未知";
    if (idleMs >= 0) {
      const minutes = Math.floor(idleMs / 60000);
      if (minutes < 1) s = "刚活跃（<1 分钟）";
      else if (minutes < 60) s = `${minutes} 分钟`;
      else s = `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
    }
    msg = msg.replace(/\{kokoIdle\}/g, s);
  }

  if (msg.includes("{fileChanges}")) {
    const fw = korina.fileWatcher;
    let count = "0";
    if (fw && fw.getRecentChangeCount) count = String(fw.getRecentChangeCount(60 * 60 * 1000));
    msg = msg.replace(/\{fileChanges\}/g, count);
  }

  if (msg.includes("{topTask}")) msg = msg.replace(/\{topTask\}/g, getTopTask());

  if (msg.includes("{think}")) {
    msg = msg.replace(/\{think\}/g, thinkPrompt || "回顾当前状态，简短思考");
  }

  return msg;
}

/**
 * v0.9.23: 基于真实环境生成 Koko 活跃描述
 * - 用描述池随机匹配（抗 DSA 衰减，不重复）
 * - v0.9.28 manual #53: 数据源改用 snapshot.idleSec（PowerShell GetLastInputInfo）
 *   - 之前用 injector.lastKokoTime（oc 互动），和 generateGuidance 的 idleSec 不一致
 *   - 现在统一用 snapshot.idleSec，fallback 到 lastKokoTime
 * - 结合前台窗口推断 Koko 在干嘛
 */
function describeKokoActivity(injector, snapshot, now) {
  const idleSec = (snapshot && typeof snapshot.idleSec === "number") ? snapshot.idleSec : -1;
  let idleMin;
  if (idleSec >= 0) {
    idleMin = Math.floor(idleSec / 60);
  } else {
    // 兜底：用 lastKokoTime
    const lastActive = injector?.lastKokoTime || 0;
    idleMin = lastActive > 0 ? Math.floor((now - lastActive) / 60000) : -1;
  }

  const foreground = snapshot?.foreground || "";
  const { text } = pickActivityLine({ idleMin, foreground });
  return text;
}

function humanizeMs(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} 分钟`;
  return `${(ms / 3600000).toFixed(1)} 小时`;
}

export const _internal = { loadTemplates, getTopTask, readVoiceTarget, humanizeMs, dayPeriodForHour };
