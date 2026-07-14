/**
 * watchdog/watchdog.mjs
 *
 * 看门狗：独立进程，监控 korina 主进程心跳
 *
 * 职责：
 *   1. 定时读心跳文件，超时则重启 korina
 *   2. 重启前检测 oc 进程是否在线--在线则直接唤醒 korina（续唤醒）
 *   3. 看门狗自身代码 korina 无写权限（文件系统层面保护）
 *
 * 用法：node watchdog/watchdog.mjs [--interval 5000] [--timeout 30000]
 *
 * 心跳机制：
 *   korina 主进程每 2s 写一次 heartbeat.json（{ ts, pid, stats }）
 *   看门狗每 interval 读一次，如果 ts 距现在 > timeout，判定 korina 挂了
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const WATCHDOG_LOG = join(PROJECT_ROOT, "logs", "watchdog.log");
const KORINA_ENTRY = join(PROJECT_ROOT, "src", "main.mjs");

// 解析命令行参数
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
}
const INTERVAL_MS = parseInt(getArg("interval", 5000));
const TIMEOUT_MS = parseInt(getArg("timeout", 30000)); // 心跳超时 30s 判死
const MAX_RESTART = parseInt(getArg("max-restart", 10)); // 每 port 最大重启次数 10 次
const RESTART_COOLDOWN = parseInt(getArg("cooldown", 60000)); // 重启冷却 60s

// v0.9.12 (L5.2 manual #36): 多 port 支持
// 优先 --ports "9999,10001"（逗号分隔），兼容老的 --port 单值
// 测试方便：接受可选 argv + env 参数（默认 process.argv / process.env）
export function parsePortsArg(argv = process.argv.slice(2), env = process.env) {
  function getArgLocal(name, defaultValue) {
    const idx = argv.indexOf(`--${name}`);
    return idx !== -1 ? argv[idx + 1] : defaultValue;
  }
  const portsCsv = getArgLocal("ports", null);
  if (portsCsv) {
    const parsed = portsCsv
      .split(",")
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => Number.isFinite(p) && p > 0 && p <= 65535);
    // v0.9.12 (manual #36 test 8 bug fix): 全无效时 fallback 到 --port / 默认 9999
    if (parsed.length > 0) return parsed;
    console.warn(`[watchdog] --ports="${portsCsv}" 解析为空（无有效 port），fallback 到 --port 或默认 9999`);
  }
  const single = parseInt(getArgLocal("port", env.KORINA_PORT || "9999"), 10);
  return Number.isFinite(single) && single > 0 ? [single] : [9999];
}
const WATCHDOG_PORTS = parsePortsArg();

// per-port state（v0.9.12 manual #36）：每个 port 独立 restart 计数、korina process
// 之前全局 restartCount 在多 port 场景下会冲突（一个 port 失败计数会被另一个 port 重置）
function heartbeatFileFor(port) {
  return join(PROJECT_ROOT, "logs", `heartbeat.${port}.json`);
}
const portStates = new Map();
WATCHDOG_PORTS.forEach((port) => {
  portStates.set(port, {
    restartCount: 0,
    lastRestartTime: 0,
    korinaProcess: null,
    heartbeatFile: heartbeatFileFor(port),
    restartLimitReached: false, // 达到上限后跳过该 port 但 watchdog 进程不退
  });
});

// 日志统一用 logSync
function logSync(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(WATCHDOG_LOG, line);
  } catch {}
}

/**
 * 读心跳文件
 *
 * v0.9.12 (L5.2 manual #36): 接受 port 参数（之前固定读 HEARTBEAT_FILE 全局变量）
 */
function readHeartbeat(portOrFile) {
  const file = typeof portOrFile === "string"
    ? portOrFile
    : heartbeatFileFor(portOrFile);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 检测指定端口是否被占用（v0.9.9 manual #33 N2 修复）
 *
 * 返回占用端口的 PID（number），或 null（端口空闲）。
 * 用 netstat -ano | findstr :PORT 实现，跨 Windows 通用。
 */
function isPortBusy(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    });
    // 找 LISTENING 行的 owning PID
    const match = out.match(new RegExp(`LISTENING\\s+(\\d+)`, 'm'));
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * 检测 oc 进程是否在线
 */
function isOcOnline() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq OpenCode.exe" /FO CSV /NH', {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    return /OpenCode\.exe/.test(out);
  } catch {
    return false;
  }
}

/**
 * 检测 korina 进程是否在线（通过 PID）
 */
function isKorinaOnline(pid) {
  if (!pid) return false;
  try {
    const out = execSync("tasklist /FO CSV /NH", {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    return new RegExp(`"${pid}"`).test(out);
  } catch {
    return false;
  }
}

/**
 * v0.9.5.5: BUG-008 修复 — 清理孤儿 sidecar 进程
 *
 * 历史背景：v0.9.3-v0.9.19 era korina 用 `detached: true + CREATE_NEW_PROCESS_GROUP`
 * 拉 sidecar，副作用 = korina 硬杀后 Python 不死，变孤儿。
 *
 * v0.9.20 L5.4 (manual #50): 治根因，删 detached + CREATE_NEW_PROCESS_GROUP + unref()，
 * Python 现在是 korina 的真子进程（gracefulShutdown 时主动 stopAll），
 * 不再有 orphan 累积。本函数保留作为兜底（防止历史残留 / 异常崩溃路径漏杀），
 * 但理论上不应该再触发。如果监控到本函数实际杀掉 Python，是回归。
 *
 * v0.9.23: 修引号转义 bug —— 之前用 `powershell -Command "...${psCmd}..."` 嵌套调用，
 * psCmd 内部的双引号在 cmd 解析层被吞掉，PowerShell 拿到残缺命令必报错。
 * 改用 base64 + -EncodedCommand 传递（彻底绕开引号转义陷阱）。
 *
 * 方案：用 PowerShell + Get-CimInstance 按命令行匹配找 python 进程，
 * taskkill /F 强杀。wmic 在新版 Windows 不可用，改用 PowerShell。
 */
function runPowerShell(psCmd, timeoutMs = 15000) {
  // v0.9.23: 用 -EncodedCommand 传递 base64(UTF-16LE) 命令，绕开所有引号转义
  const encoded = Buffer.from(psCmd, "utf16le").toString("base64");
  return execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
    encoding: "utf-8",
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function cleanupOrphanSidecars() {
  const scripts = ["voice-input.py", "desktop-lyrics.py"];
  for (const script of scripts) {
    try {
      const psCmd =
        `Get-CimInstance Win32_Process -Filter "Name='python.exe'" ` +
        `| Where-Object { $_.CommandLine -like '*${script}*' } ` +
        `| Select-Object -ExpandProperty ProcessId`;
      const out = runPowerShell(psCmd);
      const pids = out
        .split(/\r?\n/)
        .map((l) => parseInt(l.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      for (const pid of pids) {
        if (pid === process.pid) continue;
        try {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, windowsHide: true });
          logSync(`[watchdog] 清理孤儿 sidecar: ${script} PID=${pid}`);
        } catch (e) {
          logSync(`[watchdog] taskkill PID=${pid} 失败: ${e.message?.split("\n")[0]}`);
        }
      }
    } catch (e) {
      logSync(`[watchdog] 查找孤儿 ${script} 失败: ${e.message?.split("\n")[0]}`);
    }
  }
}

/**
 * v0.9.5.6: BUG-009 修复 — 清理 cmd /K 启动留下的僵尸 cmd 窗口
 *
 * 场景：用 cmd /K 启动 korina，korina 死后 cmd 父进程不退出（/K 设计就是留着 cmd），
 *       留下一个永远不退的 cmd 黑窗。
 *
 * 检测：cmd.exe 命令行含 /K 且**当前没有 node 子进程**（说明 korina 已死，
 *       这个 cmd 父是孤儿窗口）。
 *
 * 杀法：taskkill /F /PID（不杀 cmd /T，因为没有子进程可杀；/F 强杀就行）。
 */
function cleanupOrphanCmdK() {
  try {
    const psCmd =
      `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" ` +
      `| Where-Object { $_.CommandLine -like '*cmd*' -and $_.CommandLine -like '*/K*' } ` +
      `| ForEach-Object { ` +
      `  $parentId = $_.ProcessId; ` +
      `  $hasNodeChild = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentId" ` +
      `    | Where-Object { $_.Name -eq 'node.exe' }).Count; ` +
      `  if ($hasNodeChild -eq 0) { $parentId } ` +
      `}`;
    const out = runPowerShell(psCmd);
    const pids = out
      .split(/\r?\n/)
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    for (const pid of pids) {
      if (pid === process.pid) continue;
      try {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, windowsHide: true });
        logSync(`[watchdog] 清理 cmd /K 僵尸窗口: PID=${pid}`);
      } catch (e) {
        logSync(`[watchdog] taskkill cmd /K PID=${pid} 失败: ${e.message?.split("\n")[0]}`);
      }
    }
  } catch (e) {
    logSync(`[watchdog] 清理 cmd /K 失败: ${e.message?.split("\n")[0]}`);
  }
}

/**
 * 启动 korina 主进程
 *
 * v0.9.8 (L5.0 manual #30): 把 WATCHDOG_PORT 透传给 korina
 * v0.9.12 (L5.2 manual #36): 接受 port + state 参数（per-port 独立拉起）
 * v0.9.18.1 (R1 wire-up manual #43): 多 port 时自动设 KORINA_BIND_SESSION=peer-avoid-{其他 port}，
 *   让 10001 启动时避开 9999 绑的 session（R1 治根因）。允许 KORINA_BIND_SESSION env 显式覆盖。
 */
function startKorina(port, state) {
  const env = { ...process.env, KORINA_PORT: String(port) };
  // v0.9.18.1 (manual #43): 多 port 默认 peer-avoid，避免 R1 回归（10001 撞 9999 session）
  if (!process.env.KORINA_BIND_SESSION) {
    const otherPorts = WATCHDOG_PORTS.filter((p) => p !== port);
    if (otherPorts.length > 0) {
      // 多 port 场景：自动避第一个其他 port（当前仅 9999 + 10001，简单避 9999 即可）
      env.KORINA_BIND_SESSION = `peer-avoid-${otherPorts[0]}`;
      logSync(`[watchdog] [port=${port}] 自动设 KORINA_BIND_SESSION=${env.KORINA_BIND_SESSION}（治 R1 回归）`);
    }
  }
  logSync(`[watchdog] [port=${port}] 启动 korina: node ${KORINA_ENTRY}`);
  const proc = spawn("node", [KORINA_ENTRY], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",   // v0.9.3: 默认前台，日志输出到终端
    detached: false,
    windowsHide: false, // 默认可见窗口
    env,
  });

  proc.on("exit", (code, signal) => {
    logSync(`[watchdog] [port=${port}] korina 退出 code=${code} signal=${signal}`);
    if (state.korinaProcess === proc) state.korinaProcess = null;
  });

  state.korinaProcess = proc;
  logSync(`[watchdog] [port=${port}] korina PID=${proc.pid}`);
  return proc;
}

/**
 * 杀掉 korina 进程（防止僵尸）
 */
function killKorina(pid) {
  if (!pid) return;
  try {
    process.kill(pid);
    logSync(`[watchdog] 已发送 SIGTERM 到 PID ${pid}`);
  } catch (e) {
    logSync(`[watchdog] kill ${pid} 失败: ${e.message}`);
  }
}

/**
 * 主监控循环
 *
 * v0.9.12 (L5.2 manual #36): per-port 独立监控。
 * 多个 port 的 watcher 用 Promise.all 并行；每个 port 独立 restart 计数 + korina process。
 */
async function main() {
  logSync(`=== korina 看门狗启动 ===`);
  logSync(`  监控 ports: ${WATCHDOG_PORTS.join(", ")}`);
  logSync(`  心跳文件 pattern: logs/heartbeat.{port}.json`);
  logSync(`  检查间隔: ${INTERVAL_MS}ms`);
  logSync(`  超时阈值: ${TIMEOUT_MS}ms`);
  logSync(`  最大重启/port: ${MAX_RESTART}`);
  logSync(`  重启冷却: ${RESTART_COOLDOWN}ms`);

  // 每个 port 启动独立 watcher（并行）
  await Promise.all(WATCHDOG_PORTS.map((port) => watchPort(port).catch((e) => {
    logSync(`[watchdog] [port=${port}] 异常退出: ${e?.message || e}`);
  })));
}

/**
 * 单个 port 的 watcher（v0.9.12 L5.2 manual #36 引入）
 */
async function watchPort(port) {
  const state = portStates.get(port);
  if (!state) {
    logSync(`[watchdog] [port=${port}] 无 state（编程错误）`);
    return;
  }

  // 启动时检查 + 决策
  const hb = readHeartbeat(state.heartbeatFile);
  const portOwner = isPortBusy(port);
  if (portOwner && portOwner !== hb?.pid) {
    logSync(`[watchdog] [port=${port}] 端口被 PID=${portOwner} 占但 heartbeat 不匹配（hb.pid=${hb?.pid}），跳过拉起`);
    logSync(`[watchdog] [port=${port}] orphan 残留，需要人工清理`);
    return; // 该 port 不进入监控循环
  }
  if (!hb || !isKorinaOnline(hb.pid)) {
    logSync(`[watchdog] [port=${port}] korina 未运行，启动...`);
    startKorina(port, state);
  } else {
    logSync(`[watchdog] [port=${port}] korina 已在运行 PID=${hb.pid}`);
    state.korinaProcess = { pid: hb.pid }; // 占位
  }

  // 该 port 的监控循环
  while (true) {
    await sleep(INTERVAL_MS);
    if (state.restartLimitReached) {
      // 达到上限后只 sleep 不再检查（避免重启浪费）
      continue;
    }

    const heartbeat = readHeartbeat(state.heartbeatFile);
    const now = Date.now();

    if (!heartbeat) {
      logSync(`[watchdog] [port=${port}] 心跳文件缺失或无效`);
      await _handleDead(port, state, "no_heartbeat");
      continue;
    }

    const age = now - (heartbeat.ts || 0);
    if (age > TIMEOUT_MS) {
      logSync(`[watchdog] [port=${port}] 心跳超时: ${age}ms > ${TIMEOUT_MS}ms`);
      await _handleDead(port, state, "heartbeat_timeout", heartbeat.pid);
      continue;
    }

    if (heartbeat.pid && !isKorinaOnline(heartbeat.pid)) {
      logSync(`[watchdog] [port=${port}] 心跳正常但 PID=${heartbeat.pid} 进程不存在`);
      await _handleDead(port, state, "process_gone", heartbeat.pid);
      continue;
    }
  }
}

/**
 * v0.9.12 (L5.2 manual #36): per-port 状态隔离
 * - restartCount / lastRestartTime / korinaProcess 都按 port 存
 * - 达到 MAX_RESTART 后只跳过该 port，不退出 watchdog 进程
 */
async function _handleDead(port, state, reason, deadPid) {
  const sinceRestart = Date.now() - state.lastRestartTime;
  if (sinceRestart < RESTART_COOLDOWN) {
    const wait = RESTART_COOLDOWN - sinceRestart;
    logSync(`[watchdog] [port=${port}] 冷却中，${Math.round(wait / 1000)}s 后可重启`);
    await sleep(wait);
  }

  if (state.restartCount >= MAX_RESTART) {
    logSync(`[watchdog] [port=${port}] 已达最大重启次数 ${MAX_RESTART}，跳过该 port`);
    state.restartLimitReached = true;
    return; // 不退出 watchdog 进程（其他 port 继续监控）
  }

  // 先杀残留进程（per-port）
  if (deadPid) killKorina(deadPid);
  if (state.korinaProcess?.pid && state.korinaProcess.pid !== deadPid) {
    killKorina(state.korinaProcess.pid);
  }

  // v0.9.5.5: BUG-008 修复 — 清理孤儿 sidecar
  cleanupOrphanSidecars();
  // v0.9.5.6: BUG-009 修复 — 清理 cmd /K 窗口
  cleanupOrphanCmdK();

  const ocOnline = isOcOnline();
  logSync(`[watchdog] [port=${port}] oc 进程${ocOnline ? "在线" : "离线"}`);

  if (ocOnline) {
    logSync(`[watchdog] [port=${port}] oc 在线，续唤醒 korina`);
  } else {
    logSync(`[watchdog] [port=${port}] oc 离线，尝试启动...`);
    await _tryStartOc();
  }

  state.restartCount++;
  state.lastRestartTime = Date.now();
  logSync(`[watchdog] [port=${port}] 第 ${state.restartCount} 次重启 korina (reason=${reason})`);
  startKorina(port, state);
}

async function _tryStartOc() {
  // 尝试常见路径启动 oc 桌面版
  const paths = [
    join(process.env.LOCALAPPDATA || "", "Programs", "@opencode-ai", "desktop", "OpenCode.exe"),
    join(process.env.LOCALAPPDATA || "", "OpenCode", "OpenCode.exe"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      logSync(`[watchdog] 启动 oc: ${p}`);
      try {
        spawn(p, { detached: true, stdio: "ignore", windowsHide: false });
        logSync("[watchdog] oc 启动命令已发送，等待 10s...");
        await sleep(10000);
        return;
      } catch (e) {
        logSync(`[watchdog] oc 启动失败: ${e.message}`);
      }
    }
  }
  logSync("[watchdog] 未找到 oc 可执行文件，korina 将在无 oc 状态下启动");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  logSync(`[watchdog] 致命错误: ${e.message}`);
  process.exit(1);
});
