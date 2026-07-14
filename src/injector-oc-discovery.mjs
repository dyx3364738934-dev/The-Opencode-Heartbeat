/**
 * src/injector-oc-discovery.mjs
 *
 * v0.9.15 (manual #39 J 第一刀): 抽出 oc 进程发现 + 密码匹配 + 端口探测 + oc 拉起 逻辑
 *
 * 包含原 injector.mjs 的 10 个方法（按"高内聚低耦合"切分）：
 *   - readPasswordFile / waitForPassword
 *   - isOCRunning / isOCRunningAsync
 *   - spawnOC
 *   - ensureOCAndDiscover / discover
 *   - _findPortsByProcess / _findPortsByProcessAsync / _tryPort
 *
 * 设计：纯函数模块（不依赖 Injector 实例状态）
 *   - 每个函数接收所需参数（logsDir / projectRoot / serverConfig / log）
 *   - 返回值由调用方设置到 Injector 实例
 *   - 没有 this.xxx 依赖 → 易测、易维护
 *
 * 公共 API 保持兼容：injector.mjs 委托这些函数，对外接口零变化。
 */

import { execFile, execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const DEFAULT_PORT_PROBE_TIMEOUT_MS = 8000;
const PASSWORD_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_WAIT_MS = 120000;

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 读 logs/oc-password.txt（v0.9.15：从 injector.mjs 抽出，原用全局 SESSION_LOCK 常量替换）
 * @param {object} opts
 * @param {string} opts.logsDir
 * @returns {object|null} 解析后的密码数据（{ password, username, leakedAt }）或 null
 */
export function readPasswordFile({ logsDir }) {
  const pwdFile = join(logsDir, "oc-password.txt");
  if (!existsSync(pwdFile)) return null;
  try {
    return JSON.parse(readFileSync(pwdFile, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 异步版：通过 netstat + tasklist 找出 processName 监听的 127.0.0.1 端口
 * 不阻塞事件循环（用 execFile + Promise）
 * @param {object} opts
 * @param {string} opts.processName - 进程名如 "OpenCode.exe"
 * @param {string} opts.projectRoot
 * @returns {Promise<number[]>} 端口列表
 */
export function findPortsByProcessAsync({ processName, projectRoot }) {
  return new Promise((resolve) => {
    let ns = "", tl = "";
    let done = 0;
    const check = () => {
      done++;
      if (done < 2) return;
      const ports = [];
      try {
        const pids = new Set();
        for (const m of tl.matchAll(new RegExp(`"${processName.replace(/\./g, "\\.")}","(\\d+)"`, "g"))) {
          pids.add(parseInt(m[1]));
        }
        for (const m of ns.matchAll(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)/gm)) {
          if (pids.has(parseInt(m[2]))) ports.push(parseInt(m[1]));
        }
      } catch {}
      resolve(ports);
    };
    execFile("netstat", ["-ano"], { encoding: "utf-8", timeout: DEFAULT_PORT_PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      ns = stdout || "";
      check();
    });
    execFile("tasklist", ["/FI", `IMAGENAME eq ${processName}`, "/FO", "CSV", "/NH"], { encoding: "utf-8", timeout: 5000, windowsHide: true }, (err, stdout) => {
      tl = stdout || "";
      check();
    });
  });
}

/**
 * 同步版 findPortsByProcess（短阻塞，可接受）
 * @param {object} opts
 * @param {string} opts.processName
 * @returns {number[]}
 */
export function findPortsByProcess({ processName }) {
  const ports = [];
  try {
    const ns = execSync("netstat -ano", { encoding: "utf-8", timeout: DEFAULT_PORT_PROBE_TIMEOUT_MS, windowsHide: true });
    const tl = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`, {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    const pids = new Set();
    for (const m of tl.matchAll(new RegExp(`"${processName.replace(/\./g, "\\.")}","(\\d+)"`, "g"))) {
      pids.add(parseInt(m[1]));
    }
    for (const m of ns.matchAll(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)/gm)) {
      if (pids.has(parseInt(m[2]))) ports.push(parseInt(m[1]));
    }
  } catch {}
  return ports;
}

/**
 * 探测给定端口 + auth 头是否 oc 响应 200
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.auth - "Basic xxxx"
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<boolean>}
 */
export async function tryPort({ port, auth, timeoutMs = DEFAULT_PORT_PROBE_TIMEOUT_MS }) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/global/health`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * v0.4: 主动轮询密码匹配（冷启动入口）
 * 等 oc-password.txt 出现 + 密码有效（verify_server 通过）
 * @param {object} opts
 * @param {string} opts.logsDir
 * @param {number} [opts.maxWaitMs=120000]
 * @param {function} [opts.log] - 日志函数（默认 console.log）
 * @returns {Promise<{port, auth, base, headers}>} serverConfig
 */
export async function waitForPassword({ logsDir, maxWaitMs = DEFAULT_MAX_WAIT_MS, log = console.log }) {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < maxWaitMs) {
    const pwdData = readPasswordFile({ logsDir });
    if (pwdData?.password) {
      const ports = await findPortsByProcessAsync({ processName: "OpenCode.exe" });
      if (ports.length > 0) {
        for (const port of ports) {
          const auth = "Basic " + Buffer.from(`opencode:${pwdData.password}`).toString("base64");
          if (await tryPort({ port, auth })) {
            const username = pwdData.username || "opencode";
            const headers = { "Content-Type": "application/json", Authorization: auth };
            const serverConfig = { port, auth, base: `http://127.0.0.1:${port}`, headers };
            log(`[oc-discovery] 密码匹配成功 (port=${port}, age=${Math.round((Date.now() - (pwdData.leakedAt || 0)) / 1000)}s)`);
            return serverConfig;
          }
        }
        lastErr = `密码验证失败（${ports.length} 个端口都不通，密码可能过期）`;
      } else {
        lastErr = "oc 进程无监听端口（启动中？）";
      }
    } else {
      lastErr = "密码文件不存在或无效（plugin 还没泄露）";
    }
    await _sleep(PASSWORD_POLL_INTERVAL_MS);
  }
  throw new Error(`密码匹配超时 (${maxWaitMs / 1000}s): ${lastErr}`);
}

/**
 * v0.4: 检测 oc 进程是否在线（同步版，短阻塞）
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @returns {boolean}
 */
export function isOCRunning({ projectRoot: _projectRoot }) {
  return findPortsByProcess({ processName: "OpenCode.exe" }).length > 0;
}

/**
 * v0.4: 异步版
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @returns {Promise<boolean>}
 */
export async function isOCRunningAsync({ projectRoot }) {
  const ports = await findPortsByProcessAsync({ processName: "OpenCode.exe" });
  return ports.length > 0;
}

/**
 * v0.4: 拉起 oc 桌面版（watchdog 职责融入 korina）
 *
 * v0.9.26 (manual #51): spawn 后验证 + 重试
 *   - 修复前：spawn() 立即返回不等子进程启动，"oc 已拉起"日志只是 spawn 调用成功不是真起来
 *   - 修复后：spawn 后等 + 检查 oc port 是否真监听 + 重试（最多 3 次）
 *   - KOKO 报告："oc 根本没有拉起，是我手动双击开的"
 *
 * @param {object} [opts]
 * @param {function} [opts.log] - 日志函数
 * @param {number} [opts.maxRetries=3] - 最大重试次数
 * @returns {Promise<boolean>} 是否成功 spawn + 验证通过
 */
export async function spawnOC({ log = console.log, maxRetries = 3 } = {}) {
  const { LOCALAPPDATA } = process.env;
  const candidates = [
    join(LOCALAPPDATA || "", "Programs", "@opencode-ai", "desktop", "OpenCode.exe"),
    join(LOCALAPPDATA || "", "OpenCode", "OpenCode.exe"),
  ];
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) {
    log("[oc-discovery] 找不到 OpenCode.exe");
    return false;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const child = spawn(exe, [], {
        cwd: dirname(exe),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      log(`[oc-discovery] oc spawn 尝试 ${attempt}/${maxRetries}: ${exe} (pid=${child.pid || "?"})`);

      // 等几秒让 oc 启动 + 泄露密码 + 监听 port
      await _sleep(3000);

      // 验证 oc port 是否真监听
      const ports = await findPortsByProcessAsync({ processName: "OpenCode.exe" });
      if (ports.length > 0) {
        log(`[oc-discovery] oc 已拉起验证通过（port=${ports[0]}，attempt ${attempt}）`);
        return true;
      }
      log(`[oc-discovery] oc spawn 后 3s 仍无监听端口（attempt ${attempt}/${maxRetries}），重试...`);
    } catch (e) {
      log(`[oc-discovery] spawn 异常（attempt ${attempt}/${maxRetries}）: ${e.message}`);
    }
  }
  log(`[oc-discovery] oc 拉起失败（${maxRetries} 次尝试后）— 需 KOKO 手动双击 OpenCode.exe`);
  return false;
}

/**
 * v0.4: 确保 oc 在线 + 密码匹配（冷启动入口）
 * 如果 oc 不在 -> spawn -> 等密码
 *
 * v0.9.26 (manual #51): spawn 失败时早 throw，避免 korina 启动挂起 4 分钟
 *   - 修复前：spawnOC 失败（spawn 异步不等子进程）也 fire-and-forget，
 *            waitForPassword 等 120 秒密码泄露，永远等不到 → korina 启动挂
 *   - 修复后：spawnOC 返回 false（spawn 后验证 3 次失败）→ 立即 throw，
 *            korina 启动快速失败，KOKO 知道要手动双击 oc.exe
 * @param {object} opts
 * @param {string} opts.logsDir
 * @param {string} opts.projectRoot
 * @param {function} [opts.log]
 * @returns {Promise<{port, auth, base, headers}>}
 */
export async function ensureOCAndDiscover({ logsDir, projectRoot, log = console.log }) {
  if (!isOCRunning({ projectRoot })) {
    log("[oc-discovery] oc 不在线，拉起...");
    const spawned = await spawnOC({ log });
    if (!spawned) {
      throw new Error("oc spawn 失败（3 次重试后仍无监听端口）— 请手动双击 OpenCode.exe 后再启动 korina");
    }
  }
  return await waitForPassword({ logsDir, log });
}

/**
 * v0.4: 发现 oc server（顶层入口）
 * 如果有缓存的 serverConfig 直接返回（避免重复探测）
 * 否则 ensureOCAndDiscover 冷启动
 *
 * @param {object} opts
 * @param {string} opts.logsDir
 * @param {string} opts.projectRoot
 * @param {object} [opts.cachedServerConfig] - 已缓存的 serverConfig（如果有）
 * @param {function} [opts.log]
 * @returns {Promise<{port, auth, base, headers}>}
 */
export async function discover({ logsDir, projectRoot, cachedServerConfig, log = console.log }) {
  if (cachedServerConfig) return cachedServerConfig;
  return await ensureOCAndDiscover({ logsDir, projectRoot, log });
}