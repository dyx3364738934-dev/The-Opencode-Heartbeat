/**
 * src/main.mjs
 *
 * v0.9: 插件系统架构 -- main.mjs 只负责加载插件 + 启动队列 + 退出清理
 *
 * 架构：
 *   core/   -- 事件队列 + HTTP 路由 + 事件总线 + 插件加载器 + 配置系统
 *   plugins/ -- 业务插件（每个独立目录，互不 import）
 *
 * 插件通过 ctx（queue/bus/http/presets/korina）交互，互相不直接依赖。
 * 加功能 = 新建 plugins/xxx/plugin.mjs，不改核心代码。
 */

import { writeFileSync, mkdirSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessHeartbeat } from "./core/process-heartbeat.mjs";
import { OcHealthChecker } from "./core/oc-health-checker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const LIVE_LOG = join(LOGS_DIR, "korina-live.log");

export const KORINA_VERSION = "0.9.3";
export const KORINA_BUILD_DATE = "2026-07-11";
// v0.9.22 (manual #49): 强绑定 worker 模式（删 --mode 解析 + scheduler mode 死代码）
//   之前 v0.9.5.5 注释"ARCH-001 调度器架构第一步"——生产永远 worker，scheduler 模式 0 次用过（manual #24 O2 已标死代码）
//   KOKO 拍板 A = 治根因（删画饼 + 强绑定唯一真用模式）
export const KORINA_MODE = "worker";

// 确保日志目录存在
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// ============================================================
// 实时日志（500ms flush 到 logs/korina-live.log）
// ============================================================
import { EventQueue } from "./core/event-queue.mjs";
import { EventBus } from "./core/event-bus.mjs";
import { HTTPRouter } from "./core/http-router.mjs";
import { PluginLoader } from "./core/plugin-loader.mjs";
import { Presets } from "./core/presets.mjs";

if (existsSync(LIVE_LOG)) writeFileSync(LIVE_LOG, "");
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr = console.error.bind(console);
const _strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
let _logBuf = [];
let _logFlushTimer = null;
const _queueLog = (level, args) => {
  const line = `[${new Date().toISOString().slice(11, 19)}][${level}] ` + args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  _logBuf.push(_strip(line));
  if (_logBuf.length >= 20 && !_logFlushTimer) _logFlushTimer = setTimeout(_flushLog, 0);
};
const _flushLog = () => {
  if (_logBuf.length === 0) { _logFlushTimer = null; return; }
  try { appendFileSync(LIVE_LOG, _logBuf.join("\n") + "\n"); } catch {}
  _logBuf = [];
  _logFlushTimer = null;
};
const _logFlushInterval = setInterval(_flushLog, 500);
console.log = (...args) => { _queueLog("INF", args); _origLog(...args); };
console.warn = (...args) => { _queueLog("WRN", args); _origWarn(...args); };
console.error = (...args) => { _queueLog("ERR", args); _origErr(...args); };

console.log(`=== korina v${KORINA_VERSION} 启动 ===`);
console.log(`  PID: ${process.pid}`);
console.log(`  构建: ${KORINA_BUILD_DATE}`);
console.log(`  模式: ${KORINA_MODE}（manual #49 强绑定 worker）`);
console.log(`  架构: 插件系统（core + plugins）`);
console.log(`  实时日志: ${LIVE_LOG}`);

// ============================================================
// 全局异常兜底
// ============================================================
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.message || err);
});

// ============================================================
// 初始化核心组件
// ============================================================
const queue = new EventQueue({
  maxBurst: 10,
  refillRate: 5,
  hourlyLimit: 200,
  debounceMs: 500,
  maxQueueSize: 500,
});

const bus = new EventBus();

const KORINA_PORT = (() => {
  const raw = process.env.KORINA_PORT;
  if (!raw) return 9999;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    console.warn(`[main] 无效 KORINA_PORT=${raw}，回落 9999`);
    return 9999;
  }
  return n;
})();

const http = new HTTPRouter({ port: KORINA_PORT });

const presets = new Presets();

// v0.9.3: 注册 preset HTTP 端点（MCP server 依赖）
http.post("/preset", (body) => {
  if (!body?.key) throw new Error("需要 { key, value }");
  presets.set(body.key, body.value);
  return { ok: true, key: body.key };
});
http.get("/presets", () => presets.getAll());

// v0.9.4: 优雅关闭端点（补齐此前缺失的 /shutdown）
// 注：Windows 上对后台 node 发 SIGINT/SIGTERM 跨控制台组不可达，
// 故提供 HTTP 触发，确保 loader.shutdown() 回收所有 sidecar 后再退出。
http.post("/shutdown", async () => {
  gracefulShutdown("HTTP /shutdown");
  return { ok: true, msg: "shutting down" };
});

// 迁移 presets 文件路径（core/presets.mjs 的相对路径要调整）
presets._fixPath?.();

const loader = new PluginLoader({ queue, bus, http, presets });
// v0.9.5.5: 把 mode 暴露给所有插件（ctx.korina.mode 可读）
loader.korina.mode = KORINA_MODE;
// v0.9.10 (L5.1 manual #34): 把 port 暴露给所有插件（Inject / SessionBindingStore 用）
loader.korina.port = KORINA_PORT;
// v0.9.20 (L5.4 shadow mode manual #45): instanceRole = "main"（主实例，9999）| "shadow"（备用实例，非 9999）
//   shadow 实例不 fire 任何主动 agent loop（保留 HTTP 端点 + 被动查询 + watchdog 拉起）
//   治 L5.0-5.3 治不到的"10001 自言自语"问题（KOKO 在 9999 对话时 10001 timer 注入到 oc 干扰）
//
// v0.9.22 (manual #50): 接受 KORINA_INSTANCE_ROLE env 覆盖硬编码的"9999=main"。
//   修 korina-1测 对话发现的硬编码 bug：10001 想开全部插件时强制降级为 shadow。
//   优先级：env > 端口推断 > 默认值。
const _explicitRole = process.env.KORINA_INSTANCE_ROLE;
if (_explicitRole === "main" || _explicitRole === "shadow") {
  loader.korina.instanceRole = _explicitRole;
} else {
  loader.korina.instanceRole = KORINA_PORT === 9999 ? "main" : "shadow";
}
console.log(`[main] instanceRole: ${loader.korina.instanceRole} (port=${KORINA_PORT})`);

// v0.9.6: 能力清单端点。MCP/文档不应再凭空声明能力，先以 HTTP 实际路由为真相源。
http.get("/capabilities", () => ({
  version: KORINA_VERSION,
  buildDate: KORINA_BUILD_DATE,
  mode: KORINA_MODE,
  httpRoutes: http.listRoutes(),
  plugins: loader.list(),
}));

// ============================================================
// v0.9.6 (Milestone 4.2): 进程心跳 — 委托给 ProcessHeartbeat
// 写 logs/heartbeat.json 给 watchdog 看，schema 与 v0.9.3 兼容
// ============================================================
const processHeartbeat = new ProcessHeartbeat({
  logsDir: LOGS_DIR,
  port: KORINA_PORT, // v0.9.8 (L5.0 manual #30): 文件按 port 命名，多实例独立心跳
  version: KORINA_VERSION,
  mode: KORINA_MODE,
  intervalMs: 2000,
  getLoader: () => loader,
  getQueue: () => queue,
});

// ============================================================
// v0.9.7 (manual #17): OC 链路健康探测器 — 给 /status 输出 ocReachable
// 弥补"heartbeat 不依赖 oc"的盲点：korina 自己能感知 oc 端点是否真活
// ============================================================
function _readOcAuth() {
  // 从 logs/oc-password.txt 读 OpenCode Basic auth（oc /status 需要）
  const pwdFile = join(LOGS_DIR, "oc-password.txt");
  if (!existsSync(pwdFile)) return null;
  try {
    const data = JSON.parse(readFileSync(pwdFile, "utf-8"));
    if (!data.password) return null;
    return "Basic " + Buffer.from(`opencode:${data.password}`).toString("base64");
  } catch {
    return null;
  }
}

const ocHealth = new OcHealthChecker({
  // v0.9.23 (manual #22 B1 修复): baseUrl 动态跟随 korina.ocBase
  // oc-injector plugin init 后 korina.ocBase 才有值；ocHealth 每次 probeOnce 时调本函数拿最新
  // 老 bug: 之前硬编码 baseUrl=7574，oc 重启换端口后 ocHealth 持续误报 alive=false
  getBaseUrl: () => loader.korina?.ocBase,
  baseUrl: "http://127.0.0.1:7574",  // 兜底（ocBase 还没设时用）
  intervalMs: 10_000,
  timeoutMs: 3_000,
  auth: _readOcAuth(),
});
loader.korina.ocHealth = ocHealth;

// ============================================================
// 主函数
// ============================================================
async function main() {
  // 1. 加载插件
  await loader.loadAll();
  await loader.initAll();

  // 2. 启动 HTTP server
  http.start();

  // 3. 启动 process heartbeat（让 watchdog 立即看到一次）
  processHeartbeat.writeOnce();
  processHeartbeat.start();

  // v0.9.7 (manual #17): 启动 OC 链路健康探测（每 10s 探一次 /status）
  ocHealth.start();

  console.log("\n=== korina 就绪，等待事件 ===\n");

// 4. 启动事件队列调度
    // dispatchHandler 由 oc-injector 插件通过 korina.dispatchHandler 提供
    // v0.9.22 (manual #49): 删 scheduler mode 分支（强绑定 worker 模式，dispatchHandler 必须有）
    const dispatchHandler = loader.korina.dispatchHandler;
    if (!dispatchHandler) {
      console.error("[main] 无 dispatchHandler（oc-injector 插件未加载？），退出");
      process.exit(1);
    }
    await queue.start(dispatchHandler, 200);
}

// ============================================================
// 优雅退出
// ============================================================
let _shuttingDown = false;
async function gracefulShutdown(signal) {
  if (_shuttingDown) {
    console.log(`[korina] 已在关闭中（${signal}），忽略重复触发`);
    return;
  }
  _shuttingDown = true;
  console.log(`\n[korina] 收到 ${signal}，开始清理...`);

  try { queue.stop(); } catch {}
  try {
    await Promise.race([
      loader.shutdown().catch((e) => console.warn("[korina] loader.shutdown 出错:", e?.message)),
      new Promise((r) => setTimeout(() => {
        console.warn("[korina] loader.shutdown 超时(8s)，强制继续退出");
        r();
      }, 8000)),
    ]);
  } catch (e) {
    console.warn("[korina] loader.shutdown 包裹失败:", e?.message);
  }

  // v0.9.6 (Milestone 5.2): SidecarRegistry 统一关所有 sidecar
  if (processHeartbeat) processHeartbeat.stop();
  if (loader.korina?.sidecarRegistry) {
    try {
      await loader.korina.sidecarRegistry.stopAll(5000);
    } catch (e) {
      console.warn("[korina] sidecarRegistry.stopAll 包裹失败:", e?.message);
    }
  } else {
    console.warn("[korina] 未发现 sidecarRegistry，跳过 stopAll");
  }

  // v0.9.7 (manual #17): 停 OC 链路健康探测器
  if (ocHealth) ocHealth.stop();
  
  // v0.9.3: 等子进程优雅退出
  console.log("[korina] 等待子进程退出（最多5秒）...");
  await new Promise(r => setTimeout(r, 5000));
  
  try { http.stop(); } catch {}

  if (_logFlushInterval) clearInterval(_logFlushInterval);
  if (_logFlushTimer) clearTimeout(_logFlushTimer);

  try { _flushLog(); } catch {}

  console.log("[korina] 清理完成，退出");
  setTimeout(() => process.exit(0), 300);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

main().catch((e) => {
  console.error("[korina] 致命错误:", e.message);
  console.error(e.stack);
  process.exit(1);
});
