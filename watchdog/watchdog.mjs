/**
 * watchdog/watchdog.mjs
 *
 * 看门狗：独立进程，监控 furina 主进程心跳
 *
 * 职责：
 *   1. 定时读心跳文件，超时则重启 furina
 *   2. 重启前检测 oc 进程是否在线--在线则直接唤醒 furina（续唤醒）
 *   3. 看门狗自身代码 furina 无写权限（文件系统层面保护）
 *
 * 用法：node watchdog/watchdog.mjs [--interval 5000] [--timeout 30000]
 *
 * 心跳机制：
 *   furina 主进程每 2s 写一次 heartbeat.json（{ ts, pid, stats }）
 *   看门狗每 interval 读一次，如果 ts 距现在 > timeout，判定 furina 挂了
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const HEARTBEAT_FILE = join(PROJECT_ROOT, "logs", "heartbeat.json");
const WATCHDOG_LOG = join(PROJECT_ROOT, "logs", "watchdog.log");
const FURINA_ENTRY = join(PROJECT_ROOT, "src", "main.mjs");

// 解析命令行参数
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
}
const INTERVAL_MS = parseInt(getArg("interval", 5000));
const TIMEOUT_MS = parseInt(getArg("timeout", 30000)); // 心跳超时 30s 判死
const MAX_RESTART = parseInt(getArg("max-restart", 10)); // 最大重启次数
const RESTART_COOLDOWN = parseInt(getArg("cooldown", 60000)); // 重启冷却 60s

let restartCount = 0;
let lastRestartTime = 0;
let furinaProcess = null;

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
 */
function readHeartbeat() {
  if (!existsSync(HEARTBEAT_FILE)) return null;
  try {
    const raw = readFileSync(HEARTBEAT_FILE, "utf-8");
    return JSON.parse(raw);
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
 * 检测 furina 进程是否在线（通过 PID）
 */
function isFurinaOnline(pid) {
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
 * 启动 furina 主进程
 */
function startFurina() {
  logSync(`[watchdog] 启动 furina: node ${FURINA_ENTRY}`);
  furinaProcess = spawn("node", [FURINA_ENTRY], {
    cwd: PROJECT_ROOT,
    stdio: "ignore", // furina 自己写日志
    detached: false,
    windowsHide: true,
  });

  furinaProcess.on("exit", (code, signal) => {
    logSync(`[watchdog] furina 退出 code=${code} signal=${signal}`);
    furinaProcess = null;
  });

  logSync(`[watchdog] furina PID=${furinaProcess.pid}`);
  return furinaProcess;
}

/**
 * 杀掉 furina 进程（防止僵尸）
 */
function killFurina(pid) {
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
 */
async function main() {
  logSync("=== furina 看门狗启动 ===");
  logSync(`  心跳文件: ${HEARTBEAT_FILE}`);
  logSync(`  检查间隔: ${INTERVAL_MS}ms`);
  logSync(`  超时阈值: ${TIMEOUT_MS}ms`);
  logSync(`  最大重启: ${MAX_RESTART}`);
  logSync(`  重启冷却: ${RESTART_COOLDOWN}ms`);

  // 首次启动 furina（如果没在跑）
  const hb = readHeartbeat();
  if (!hb || !isFurinaOnline(hb.pid)) {
    logSync("[watchdog] furina 未运行，启动...");
    startFurina();
  } else {
    logSync(`[watchdog] furina 已在运行 PID=${hb.pid}`);
    furinaProcess = { pid: hb.pid }; // 占位
  }

  // 监控循环
  while (true) {
    await sleep(INTERVAL_MS);

    const heartbeat = readHeartbeat();
    const now = Date.now();

    // 情况 1：心跳文件不存在或无法解析
    if (!heartbeat) {
      logSync("[watchdog] 心跳文件缺失或无效");
      await _handleDead("no_heartbeat");
      continue;
    }

    // 情况 2：心跳超时
    const age = now - (heartbeat.ts || 0);
    if (age > TIMEOUT_MS) {
      logSync(`[watchdog] 心跳超时: ${age}ms > ${TIMEOUT_MS}ms`);
      await _handleDead("heartbeat_timeout", heartbeat.pid);
      continue;
    }

    // 情况 3：心跳正常但 furina 进程不在了（异常退出）
    if (heartbeat.pid && !isFurinaOnline(heartbeat.pid)) {
      logSync(`[watchdog] 心跳正常但 PID=${heartbeat.pid} 进程不存在`);
      await _handleDead("process_gone", heartbeat.pid);
      continue;
    }

    // 一切正常，重置重启计数（连续正常运行一段时间后清零）
    if (restartCount > 0 && age < INTERVAL_MS) {
      // 心跳很新，说明稳定运行
    }
  }
}

async function _handleDead(reason, deadPid) {
  // 重启冷却检查
  const sinceRestart = Date.now() - lastRestartTime;
  if (sinceRestart < RESTART_COOLDOWN) {
    const wait = RESTART_COOLDOWN - sinceRestart;
    logSync(`[watchdog] 冷却中，${Math.round(wait / 1000)}s 后可重启`);
    await sleep(wait);
  }

  // 重启次数上限
  if (restartCount >= MAX_RESTART) {
    logSync(`[watchdog] 已达最大重启次数 ${MAX_RESTART}，放弃`);
    process.exit(1);
  }

  // 先杀残留进程
  if (deadPid) killFurina(deadPid);
  if (furinaProcess?.pid && furinaProcess.pid !== deadPid) {
    killFurina(furinaProcess.pid);
  }

  // 检测 oc 是否在线
  const ocOnline = isOcOnline();
  logSync(`[watchdog] oc 进程${ocOnline ? "在线" : "离线"}`);

  if (ocOnline) {
    // oc 在线 -> 直接续唤醒 furina（注入区会发现 oc 端口，重新对接）
    logSync("[watchdog] oc 在线，续唤醒 furina");
  } else {
    // oc 离线 -> 尝试启动 oc（桌面版路径）
    logSync("[watchdog] oc 离线，尝试启动...");
    await _tryStartOc();
  }

  restartCount++;
  lastRestartTime = Date.now();
  logSync(`[watchdog] 第 ${restartCount} 次重启 furina (reason=${reason})`);
  startFurina();
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
  logSync("[watchdog] 未找到 oc 可执行文件，furina 将在无 oc 状态下启动");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  logSync(`[watchdog] 致命错误: ${e.message}`);
  process.exit(1);
});
