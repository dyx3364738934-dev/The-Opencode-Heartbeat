/**
 * src/main.mjs
 *
 * furina 主入口：串联 感知层 -> 核心区 -> 注入区 -> 记忆区
 * 看门狗是独立进程，单独启动
 *
 * 用法：
 *   node src/main.mjs [--watch <path>] [--session <id>]
 *
 * 环境要求：
 *   - 在 opencode 桌面版环境内运行（继承 OPENCODE_SERVER_PASSWORD）
 *   - 或手动设置 OPENCODE_SERVER_PASSWORD 环境变量
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const HEARTBEAT_FILE = join(LOGS_DIR, "heartbeat.json");

// 确保日志目录存在
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// 解析命令行参数
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
}
function getArgMulti(name) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) {
      result.push(args[i + 1]);
      i++;
    }
  }
  return result;
}

const watchPaths = getArgMulti("watch");
// v0.2: 如果没传 --watch，尝试从环境变量 FURINA_WATCH_PATH 读（多个用 ; 分隔）
if (watchPaths.length === 0 && process.env.FURINA_WATCH_PATH) {
  for (const p of process.env.FURINA_WATCH_PATH.split(/[;|]/)) {
    const trimmed = p.trim();
    if (trimmed) watchPaths.push(trimmed);
  }
}
const sessionArg = getArg("session", null);

// ============================================================
// 模块导入
// ============================================================

import { EventQueue, PRIORITY } from "./event-queue.mjs";
import { Injector } from "./injector.mjs";
import { Memory } from "./memory.mjs";
import { FileWatcher } from "../sensors/file-watcher.mjs";
import { TimerSensor } from "../sensors/timer-sensor.mjs";
import { ControlChannel } from "./control-channel.mjs";
import { Presets } from "./presets.mjs";
import { HealthChecker } from "./health-checker.mjs";
import { ModeManager } from "./mode-manager.mjs";
import { FurinaHTTPServer } from "./http-server.mjs";
import { WorkLog } from "./worklog.mjs";
import { WorkflowPresets } from "./workflow-presets.mjs";
import { INTENTS, renderInjectMessage } from "./inject-intent.mjs";

// ============================================================
// 初始化各分区
// ============================================================

console.log("=== furina 启动 ===");
console.log(`  PID: ${process.pid}`);
console.log(`  项目根: ${PROJECT_ROOT}`);

// 核心区：事件队列 + 令牌桶
const queue = new EventQueue({
  maxBurst: 10,
  refillRate: 5,
  hourlyLimit: 200,
  debounceMs: 500,
});
console.log(`  核心区: 令牌桶 ${queue.maxBurst}/${queue.refillRate}/s, 每小时上限 ${queue.hourlyLimit}`);

// 注入区
const injector = new Injector({
  sessionId: sessionArg,
  pollIntervalMs: 2000,
  pollTimeoutMs: 180000,
  onOCRestarted: async (newPort) => {
    // v0.4: oc 重启后注入"你醒了"（续命消息）
    // oc 启动后约 20 秒进入对话窗口，直接等 25 秒再注入
    // 不探测 /session（health monitor 的 execSync 会阻塞 fetch，导致探测超时）
    console.log(`[main] oc 重启检测 (port=${newPort})，等 25 秒后注入续命消息...`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(25000);

    // 重新读密码 + 找当前 oc 端口（端口可能在 25 秒内又变了）
    let targetPort = newPort;
    const ports = injector._findPortsByProcess("OpenCode.exe");
    if (ports.length > 0) {
      targetPort = ports[ports.length - 1]; // 取最后一个（通常是最新启动的）
      if (targetPort !== newPort) {
        console.log(`[main] 端口变化 ${newPort} -> ${targetPort}（25 秒内）`);
      }
    }

    const pwdData = injector._readPasswordFile();
    if (!pwdData?.password) {
      console.warn("[main] 密码文件不可用，放弃续命注入");
      return;
    }
    const auth = "Basic " + Buffer.from(`opencode:${pwdData.password}`).toString("base64");
    const sid = injector.sessionId || injector.loadSession();

    console.log(`[main] 注入续命消息 (port=${targetPort}, sid=${sid?.slice(0,16)}...)`);
    // v0.5: 用意图系统渲染续命消息（intent=survival, source=furina）
    const rendered = renderInjectMessage("你醒了。", { intent: "survival", source: "furina" });
    // 重试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const body = JSON.stringify({ parts: [{ type: "text", text: rendered }] });
        const r = await fetch(`http://127.0.0.1:${targetPort}/session/${sid}/prompt_async`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body,
          signal: AbortSignal.timeout(30000),
        });
        if (r.status === 204 || r.ok) {
          console.log(`[main] 续命消息已注入 (第 ${attempt} 次成功, intent=survival)`);
          return;
        }
        throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        console.warn(`[main] 续命注入第 ${attempt} 次失败: ${e.message?.slice(0, 60)}`);
        if (attempt < 3) await sleep(5000);
      }
    }
    console.warn("[main] 续命消息 3 次都失败");
  },
});

// v0.4: health check loop（15s 间隔，fetch 失败立刻重新匹配）
injector.startHealthMonitor(15000);

// 记忆区
const memory = new Memory(injector, {
  maxMessages: 40,
  maxTokens: 30000,
});

// 预设系统
const presets = new Presets();
console.log(`  预设: 模式=${presets.get("mode")}, 空闲阈值=${presets.get("idleThresholdMs") / 1000}s`);

// 健康检测器
const healthChecker = new HealthChecker(injector, presets, {
  onIdle: null, // 会被 ModeManager 接管
  onStale: (round, msg) => console.log(`[main] 戳醒第${round + 1}轮: ${msg}`),
  onDead: (reason) => {
    console.error(`[main] OC 判定死亡 (${reason})，furina 主动拉起 oc`);
    injector.spawnOC();
  },
  onRecover: () => console.log("[main] OC 恢复响应"),
});

// 模式管理器
const modeManager = new ModeManager(injector, presets, healthChecker);

// 感知层：文件 watcher（首个感知器）
const sensors = [];
if (watchPaths.length > 0) {
  const fw = new FileWatcher(queue, {
    paths: watchPaths,
    debounceMs: 1000,
  });
  sensors.push(fw);
  console.log(`  感知层: file-watcher 监听 ${watchPaths.length} 路径`);
} else {
  console.log("  感知层: 未指定 --watch，无文件感知器（仅手动注入模式）");
}

// 感知层：timer sensor（v0.2 新增）—— 周期性触发用于 dogfooding
// 默认启用，周期可由 presets.timer.intervalMs 配置
const timerConfig = presets.get("timer") || {};
const ts = new TimerSensor(queue, {
  intervalMs: timerConfig.intervalMs ?? 600000, // 默认 10 分钟
  initialDelayMs: timerConfig.initialDelayMs ?? 30000, // 默认 30s 后第一次
  message: timerConfig.message ?? "[furina 周期] 例行检查。请简短汇报当前状态或寻找新的改进点。",
  priority: timerConfig.priority ?? PRIORITY.LOW,
  enabled: timerConfig.enabled ?? true,
});
sensors.push(ts);
console.log(`  感知层: timer-sensor ${timerConfig.enabled === false ? "禁用" : "启用"} interval=${timerConfig.intervalMs ?? 600000}ms`);

// ============================================================
// 心跳写入（给看门狗用）
// ============================================================

function writeHeartbeat() {
  const hb = {
    ts: Date.now(),
    pid: process.pid,
    stats: {
      queue: queue.getStats(),
      memory: memory.getStats(),
      mode: modeManager.getStats(),
      presets: {
        mode: presets.get("mode"),
        idleThresholdMs: presets.get("idleThresholdMs"),
      },
      health: {
        tracking: healthChecker.tracking,
        lastState: healthChecker.lastState,
        pokeRound: healthChecker.pokeRound,
      },
    },
  };
  try {
    writeFileSync(HEARTBEAT_FILE, JSON.stringify(hb));
  } catch (e) {
    console.error("[heartbeat] 写入失败:", e.message);
  }
}

setInterval(writeHeartbeat, 2000);
writeHeartbeat(); // 立即写一次

// ============================================================
// 事件调度：从队列取事件 -> 注入 oc -> 记忆
// ============================================================

async function dispatchHandler(event) {
  console.log(`\n[dispatch] ${event.source}/${event.type} (priority=${event.priority})`);

  // v0.3: timer 触发时自动 recall，维护 recentRecall（让 furina 持续有上下文）
  if (event.type === "timer.tick" && event.payload?.autoRecall) {
    console.log(`[dispatch] timer.tick 自动 recall...`);
    try {
      const recalled = await memory.recall(null, { last: memory.recallWindow });
      if (recalled) {
        memory.setRecentRecall(recalled);
        console.log(`[dispatch] 自动 recall 完成（${recalled.length} 字符）`);
      }
    } catch (e) {
      console.warn(`[dispatch] 自动 recall 失败: ${e.message?.slice(0, 100)}`);
    }
  }

  // v0.5: 解析 event 的 intent / source（payload 里透传）
  const intent = event.payload?.intent || inferIntent(event);
  const source = event.payload?.source || event.source || "furina";

  // 构造注入给 oc 的消息（v0.5: 用 intent 系统而非硬编码标签）
  let message = formatEventMessage(event);

  // v0.2: 如果有近期工作记忆（来自 checkpoint 后的 recall），附加到 message
  // 这样 oc 在压缩后能自动恢复上下文，无需再问"刚才说了什么"
  const recall = memory.getRecentRecall();
  if (recall) {
    const recallBlock = `\n\n[furina 近期记忆]\n${recall}\n[furina 记忆结束]`;
    message = message + recallBlock;
    console.log(`[dispatch] 已附加工作记忆（${recall.length} 字符）`);
    // 一次性使用，避免后续 dispatch 重复附加
    memory.clearRecentRecall();
  }

  console.log(`[dispatch] 注入 intent=${intent} source=${source}: ${message.slice(0, 80)}...`);

  // 注入并等待回复（v0.5: 透传 intent/source 给 injector）
  const reply = await injector.injectAndWait(message, (progress) => {
    if (progress.elapsed % 20000 === 0) {
      console.log(`  等待中... ${progress.elapsed / 1000}s state=${progress.state}`);
    }
  }, { intent, source });

  console.log(`[dispatch] 回复 (${reply.text.length} 字, state=${reply.state}):`);
  console.log(reply.text.slice(0, 300));

  // 记忆区记录
  const compressed = await memory.record(message, reply.text);
  if (compressed) {
    console.log("[dispatch] 记忆区触发了压缩检查点");
  }

  // 写心跳（带最新状态）
  writeHeartbeat();
}

/**
 * v0.5: 从 event 类型推断默认 intent
 */
function inferIntent(event) {
  if (event.type === "file.changed") return "system";      // 文件变化是系统感知
  if (event.type === "timer.tick") return "auto-recall";   // 定时检查
  if (event.type === "manual.inject") return "user";        // 手动注入 = 用户
  return "system";
}

/**
 * 把感知层事件格式化成 oc 能理解的注入消息
 * v0.5: 返回纯正文（标签由 injector.renderInjectMessage 统一加）
 */
function formatEventMessage(event) {
  switch (event.type) {
    case "file.changed":
      return `文件变化：${event.payload.event} ${event.payload.path} (size=${event.payload.size})。\n请判断这个变化是否需要处理。如果需要，用可用工具分析或操作；如果不需要，回复 [furina] 忽略。`;

    case "manual.inject":
      return event.payload.text;

    case "timer.tick":
      return event.payload.message || "例行检查";

    default:
      return `事件 ${event.type}: ${JSON.stringify(event.payload).slice(0, 200)}`;
  }
}

// ============================================================
// 启动
// ============================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function retry(fn, label, maxAttempts, intervalMs) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === 0) console.log(`[init] ${label} 未就绪: ${e.message}，等待重试...`);
      await sleep(intervalMs);
    }
  }
  throw new Error(`${label} 等待超时`);
}

async function main() {
  // 1. 发现 oc server（等 oc server 就绪，最多 120s）
  console.log("\n[init] 等待 oc server 就绪...");
  const server = await retry(() => injector.discover(), "oc server", 60, 2000);
  console.log(`  server: ${server.base}`);

  // 2. 解析 session（等 session 创建，最多 60s）
  console.log("[init] 等待 session 就绪...");
  const sid = await retry(() => injector.resolveSession(), "session", 30, 2000);
  console.log(`  session: ${sid}`);

  // v0.4: furina 启动时不注入恢复消息
  // 续命消息只由 onOCRestarted 回调触发（oc 重启时）
  // furina 重启 = 升级，oc 没死，冬蕴雪没变，不需要注入

  // 3. 启动感知器
  for (const sensor of sensors) {
    console.log(`[init] 启动 ${sensor.name}...`);
    await sensor.start();
  }

  // 3.5 启动控制通道（运行时热切换 session / 手动注入 / 查看状态 / 预设管理）
  const control = new ControlChannel({
    injector,
    queue,
    memory,
    sensors,
    presets,
    modeManager,
    healthChecker,
    onAddWatch: (paths) => {
      // 动态添加文件监听
      const fw = new FileWatcher(queue, { paths, debounceMs: 1000 });
      fw.start();
      sensors.push(fw);
    },
  });
  control.start();

  // 4. 启动事件调度循环
  console.log("\n[init] 启动事件调度循环");
  console.log("=== furina 就绪，等待感知事件 ===\n");

  // v0.4: 启动 HTTP server（让 oc 能调 furina 工具集）
  const workflowPresets = new WorkflowPresets();
  const httpServer = new FurinaHTTPServer({
    injector,
    queue,
    memory,
    presets,
    workflowPresets,
    port: 9999,
  });
  httpServer.start();

  // v0.4: 启动工作汇报系统（每小时生成一份）
  const worklog = new WorkLog({ intervalMs: 60 * 60 * 1000 });
  worklog.start();

  queue.on("push", (e) => {
    console.log(`[queue+] ${e.source}/${e.type} (size=${queue.size})`);
  });
  queue.on("dispatch", (e) => {
    console.log(`[queue>] ${e.source}/${e.type}`);
  });
  queue.on("drop", (info) => {
    console.warn(`[queue!] 丢弃: ${info.reason} ${info.source}/${info.type}`);
  });
  queue.on("error", ({ event, error }) => {
    console.error(`[queue!] 处理错误: ${event.source}/${event.type}: ${error.message}`);
  });

  // 启动调度（阻塞）
  await queue.start(dispatchHandler, 200);
}

// 优雅退出
process.on("SIGINT", () => {
  console.log("\n[furina] 收到 SIGINT，停止...");
  for (const s of sensors) s.stop();
  queue.stop();
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGTERM", () => {
  console.log("\n[furina] 收到 SIGTERM，停止...");
  for (const s of sensors) s.stop();
  queue.stop();
  setTimeout(() => process.exit(0), 500);
});

main().catch((e) => {
  console.error("[furina] 致命错误:", e.message);
  console.error(e.stack);
  process.exit(1);
});
