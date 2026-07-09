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

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
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
const sessionArg = getArg("session", null);

// ============================================================
// 模块导入
// ============================================================

import { EventQueue, PRIORITY } from "./event-queue.mjs";
import { Injector } from "./injector.mjs";
import { Memory } from "./memory.mjs";
import { FileWatcher } from "../sensors/file-watcher.mjs";
import { ControlChannel } from "./control-channel.mjs";
import { Presets } from "./presets.mjs";
import { HealthChecker } from "./health-checker.mjs";
import { ModeManager } from "./mode-manager.mjs";

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
});

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
    console.error(`[main] OC 判定死亡 (${reason})，触发看门狗重启`);
    // 写一个特殊心跳让看门狗知道需要重启 oc
    try {
      writeFileSync(join(LOGS_DIR, "oc-dead.flag"), JSON.stringify({ reason, ts: Date.now() }));
    } catch {}
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

  // 构造注入给 oc 的消息
  const message = formatEventMessage(event);
  console.log(`[dispatch] 注入: ${message.slice(0, 100)}...`);

  // 注入并等待回复
  const reply = await injector.injectAndWait(message, (progress) => {
    if (progress.elapsed % 20000 === 0) {
      console.log(`  等待中... ${progress.elapsed / 1000}s state=${progress.state}`);
    }
  });

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
 * 把感知层事件格式化成 oc 能理解的注入消息
 */
function formatEventMessage(event) {
  switch (event.type) {
    case "file.changed":
      return `[furina 感知] 文件变化：${event.payload.event} ${event.payload.path} (size=${event.payload.size})。\n请判断这个变化是否需要处理。如果需要，用可用工具分析或操作；如果不需要，回复：[furina] 忽略。`;

    case "manual.inject":
      return event.payload.text;

    case "timer.tick":
      return `[furina 定时] ${event.payload.message || "例行检查"}`;

    default:
      return `[furina] 事件 ${event.type}: ${JSON.stringify(event.payload).slice(0, 200)}`;
  }
}

// ============================================================
// 启动
// ============================================================

async function main() {
  // 1. 发现 oc server
  console.log("\n[init] 发现 oc server...");
  const server = await injector.discover();
  console.log(`  server: ${server.base}`);

  // 2. 解析 session
  const sid = await injector.resolveSession();
  console.log(`  session: ${sid}`);

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
