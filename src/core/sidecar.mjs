/**
 * src/core/sidecar.mjs
 *
 * v0.9.4: 通用 Python sidecar 拉起器
 *
 * 从 plugins/sidecar-launcher 抽出的公共能力，供各业务插件复用
 * （desktop-lyrics / voice-input 各自成独立插件，调用本模块拉起自己的 sidecar）。
 *
 * 设计（v0.9.20 L5.4 治根因）：
 *   - 不再 detached / 不再 CREATE_NEW_PROCESS_GROUP / 不再 unref()
 *   - Python 是 korina 的真子进程，korina 死 → Python 死（进程树关系真实）
 *   - gracefulShutdown 时 SidecarRegistry.stopAll() 主动 kill Python（1s 内退）
 *   - PID 文件追踪                       重启时先杀旧 sidecar，防止僵尸累积
 *
 * 历史包袱说明（v0.9.3 时代为什么用 detached）：
 *   Windows 关 console 时广播 CTRL_CLOSE_EVENT 给子进程，Python + MKL
 *   收到会 forrtl: error 200 崩溃。当时的解法 = detached + CREATE_NEW_PROCESS_GROUP
 *   隔离 console 事件，副作用 = korina 死 ≠ Python 死（orphan 累积）。
 *   v0.9.20 治根因：要求部署环境不用 MKL（Anaconda → Miniconda / 纯 Python）。
 *   测试覆盖：manual #50 端到端验证 X 关窗口不再 MKL 崩溃。
 *
 * 返回 { child, stop } —— 调用方负责在插件 destroy() 时调 stop() 优雅关闭。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export function launchSidecar({ scriptName, label, projectRoot, logsDir, log }) {
  const scriptPath = join(projectRoot, scriptName);
  if (!existsSync(scriptPath)) {
    log(`${label}: 脚本不存在 ${scriptPath}，跳过`);
    return null;
  }

  const errLog = join(logsDir, `${scriptName.replace(".py", "")}-stderr.log`);
  // v0.9.22 (manual #50): 加 stdout 日志文件，让 Python logging / print 可见（治 debug 黑洞）
  const outLog = join(logsDir, `${scriptName.replace(".py", "")}-stdout.log`);

  try {
    // 先杀旧 sidecar（如果有 PID 文件）
    const pidFile = join(logsDir, `${label}.pid`);
    if (existsSync(pidFile)) {
      try {
        const oldPid = parseInt(readFileSync(pidFile, "utf-8"));
        process.kill(oldPid, 0); // 检测是否存在
        process.kill(oldPid);    // 杀掉
        log(`${label} 旧进程 ${oldPid} 已终止`);
      } catch {}
    }

    // v0.9.20 L5.4 (manual #50): 删 detached + CREATE_NEW_PROCESS_GROUP + unref()
    // 治根因：让 Python 进程树关系真实（korina 死 → Python 死）
    // 强杀场景的孤儿清理交由 gracefulShutdown 主动 stopAll() 完成
    //
    // v0.9.22 (manual #50): stdio 改 stdout pipe（不再是 ignore）。
    // 此前 stdout 被 ignore → Python logging.StreamHandler(stdout) 输出进黑洞，
    // desktop-lyrics.stdout.log 文件根本不存在（korina-1测 对话发现），debug 信息全无。
    // 现在 stdout 也 pipe，让 Python 的 logging / print 可见。
    //
    // windowsHide 保持 true：CREATE_NO_WINDOW flag 在 Windows 上是给 console 应用程序用的，
    // 不影响 PySide6 等 GUI 应用程序（Qt 是独立 top-level window）。
    // KMP_DUPLICATE_LIB_OK 仍是 MKL 兼容兜底。
    const child = spawn("python", [scriptPath], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, KMP_DUPLICATE_LIB_OK: "TRUE" },
    });

    // 写 PID 文件
    try { writeFileSync(pidFile, String(child.pid)); } catch {}

    // 捕获 stderr 写到文件 + 控制台
    let stderrBuf = "";
    child.stderr?.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          log(`${label} stderr: ${line.trim()}`);
          try { appendFileSync(errLog, line + "\n"); } catch {}
        }
      }
    });

    // v0.9.22 (manual #50): 加 stdout handler，跟 stderr 同模式写到文件 + log
    let stdoutBuf = "";
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          log(`${label} stdout: ${line.trim()}`);
          try { appendFileSync(outLog, line + "\n"); } catch {}
        }
      }
    });

    child.on("error", (e) => {
      log(`${label} 启动失败: ${e.message}`);
    });

    child.on("exit", (code) => {
      // flush 残留 stderr
      if (stderrBuf.trim()) {
        log(`${label} stderr: ${stderrBuf.trim()}`);
        try { appendFileSync(errLog, stderrBuf + "\n"); } catch {}
      }
      // flush 残留 stdout
      if (stdoutBuf.trim()) {
        log(`${label} stdout: ${stdoutBuf.trim()}`);
        try { appendFileSync(outLog, stdoutBuf + "\n"); } catch {}
      }
      log(`${label} 退出 (code=${code})`);
    });

    log(`${label} 已拉起 (PID=${child.pid})`);

    return {
      child,
      stop() {
        try {
          // 优雅关闭——先发 SIGTERM，等 1 秒，不行再强杀
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }, 1000);
          log(`${label} 已发送关闭信号`);
        } catch {}
      },
    };
  } catch (e) {
    log(`${label} 拉起异常: ${e.message}`);
    return null;
  }
}
