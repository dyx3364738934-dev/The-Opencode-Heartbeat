#!/usr/bin/env node
/**
 * watchdog/heartbeat-tail.mjs
 *
 * OpenCode Heartbeat 日志探测脚本（中文 CLI）
 * 只读 heartbeat-main.log + heartbeat-main.err，把关键事件翻译成中文友好提示
 * 不修改 heartbeat，不和 oc 通信，纯独立进程
 *
 * 用法：
 *   node watchdog/heartbeat-tail.mjs                    # 实时跟踪（默认 follow 模式）
 *   node watchdog/heartbeat-tail.mjs --follow           # 显式开启 follow
 *   node watchdog/heartbeat-tail.mjs --no-follow        # 读完即退
 *   node watchdog/heartbeat-tail.mjs --filter "[injector]"  # 只显示匹配的日志
 *   node watchdog/heartbeat-tail.mjs --lines 100        # 首次回看 100 行
 *   node watchdog/heartbeat-tail.mjs --no-color         # 禁用颜色
 *   node watchdog/heartbeat-tail.mjs --lang en          # 英文模式
 *
 * 设计原则：
 *   - 零依赖（仅 node fs + child_process）
 *   - 不写文件，只读
 *   - 关闭脚本不影响 heartbeat 主体
 */

import { existsSync, readFileSync, watch, statSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const LOG_FILE = join(PROJECT_ROOT, "logs", "heartbeat-main.log");
const ERR_FILE = join(PROJECT_ROOT, "logs", "heartbeat-main.err");

// ============================================================
// 解析参数
// ============================================================

const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  const next = args[idx + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}

const config = {
  follow: getArg("follow", true) !== false && !args.includes("--no-follow"),
  filter: getArg("filter", null),
  lines: parseInt(getArg("lines", "20"), 10),
  noColor: args.includes("--no-color") || process.env.NO_COLOR !== undefined,
  lang: getArg("lang", "zh"),
};

// ============================================================
// 颜色
// ============================================================

const C = {
  reset: config.noColor ? "" : "\x1b[0m",
  dim: config.noColor ? "" : "\x1b[2m",
  bold: config.noColor ? "" : "\x1b[1m",
  red: config.noColor ? "" : "\x1b[31m",
  green: config.noColor ? "" : "\x1b[32m",
  yellow: config.noColor ? "" : "\x1b[33m",
  blue: config.noColor ? "" : "\x1b[34m",
  magenta: config.noColor ? "" : "\x1b[35m",
  cyan: config.noColor ? "" : "\x1b[36m",
  gray: config.noColor ? "" : "\x1b[90m",
};

// ============================================================
// 时间戳（HH:MM:SS）
// ============================================================

function ts() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

// ============================================================
// 翻译表：heartbeat 日志 → 中文友好提示
// ============================================================

const ZH = {
  "=== heartbeat 启动 ===": () => `${C.bold}${C.cyan}[启动]${C.reset} ${C.green}heartbeat 已启动${C.reset}`,
  "=== heartbeat 就绪": () => `${C.bold}${C.green}✓ heartbeat 就绪${C.reset} ${C.dim}(等感知事件)${C.reset}`,
  "项目根:": (m) => `${C.dim}[路径] ${m.split("项目根:")[1]?.trim()}${C.reset}`,
  "PID:": (m) => `${C.dim}[PID]  ${m.split("PID:")[1]?.trim()}${C.reset}`,
  "核心区: 令牌桶": (m) => `${C.dim}[令牌桶] ${m.split("核心区: 令牌桶")[1]?.trim()}${C.reset}`,
  "预设:": (m) => `${C.dim}[预设] ${m.split("预设:")[1]?.trim()}${C.reset}`,
  "感知层:": (m) => `${C.blue}[感知] ${m.split("感知层:")[1]?.trim()}${C.reset}`,

  "[init] 等待 oc server 就绪...": () => `${C.yellow}[等待]${C.reset} 找 oc 端口中...`,
  "[init] 等待 session 就绪...": () => `${C.yellow}[等待]${C.reset} 等 oc 创建对话...`,
  "[init] 启动": (m) => `${C.dim}[启动] ${m.split("启动 ")[1] || m}${C.reset}`,

  "[injector] 密码匹配成功": (m) => {
    const port = m.match(/port=(\d+)/)?.[1] || "?";
    const age = m.match(/age=(\d+)s/)?.[1] || "?";
    return `${C.green}[连接]${C.reset} 找到 oc @ ${C.bold}127.0.0.1:${port}${C.reset} ${C.dim}(密码 ${age}s 前泄露)${C.reset}`;
  },
  "[injector] inject": (m) => {
    const intent = m.match(/intent=(\S+)/)?.[1] || "?";
    const source = m.match(/source=(\S+)/)?.[1] || "?";
    const len = m.match(/textLen=(\d+)/)?.[1] || "?";
    return `${C.cyan}[注入]${C.reset} ${intent} 消息 (${len}字) ${C.dim}来源=${source}${C.reset}`;
  },
  "[injector] silentInject": (m) => `${C.cyan}[静默注入]${C.reset} ${m.split("silentInject")[1]?.trim()}`,
  "[injector] injectAndWait": (m) => {
    const intent = m.match(/intent=(\S+)/)?.[1] || "?";
    return `${C.cyan}[注入+等待]${C.reset} intent=${intent}`;
  },
  "[injector] inject OK, 进入 _poll": () => `${C.dim}[已注入] 等 oc 处理...${C.reset}`,
  "[injector] inject 超时": (m) => `${C.red}[注入超时]${C.reset} ${m.split("inject 超时")[1]?.trim()}`,
  "[injector] _poll 返回": (m) => {
    const state = m.match(/state=(\S+)/)?.[1] || "?";
    const len = m.match(/text_len=(\d+)/)?.[1] || "0";
    return `${C.green}[回复]${C.reset} oc 完成 ${C.dim}(state=${state}, ${len}字)${C.reset}`;
  },
  "[injector] _poll 抛错": (m) => `${C.red}[poll 错误]${C.reset} ${m.split("_poll 抛错:")[1]?.trim()}`,
  "[injector] silentInject 失败": (m) => `${C.red}[静默注入失败]${C.reset} ${m.split("silentInject 失败")[1]?.trim()}`,
  "[injector] 锁定的 session": (m) => `${C.yellow}[session 切换]${C.reset} ${m.split("锁定的 session")[1]?.trim()}`,
  "[injector] 定位最新 session": (m) => `${C.dim}[session 定位] ${m.split("定位最新 session:")[1]?.trim()}${C.reset}`,
  "[injector] oc 已拉起": (m) => `${C.bold}${C.green}[拉起 oc]${C.reset} ${m.split("oc 已拉起:")[1]?.trim()}`,
  "[injector] 找不到 OpenCode.exe": () => `${C.red}[错误]${C.reset} 找不到 OpenCode.exe`,
  "[injector] 拉起 oc 失败": (m) => `${C.red}[拉起失败]${C.reset} ${m.split("拉起 oc 失败:")[1]?.trim()}`,

  "[injector] health check loop 已启动": (m) => {
    const interval = m.match(/interval=(\d+)ms/)?.[1];
    return `${C.dim}[健康检查] 启动 (${interval}ms 间隔)${C.reset}`;
  },
  "[injector] health: oc 进程不在线": () => `${C.red}[告警]${C.reset} oc 进程不在，准备拉起`,
  "[injector] health: 端口探测": (m) => `${C.red}[告警]${C.reset} oc 已退出，主动拉起`,
  "[injector] health: 端口变化": (m) => {
    const ports = m.match(/(\d+)\s*->\s*(\d+)/);
    if (ports) return `${C.yellow}[健康]${C.reset} oc 端口变了 ${ports[1]} → ${C.bold}${ports[2]}${C.reset}`;
    return `${C.yellow}[健康]${C.reset} 端口变化`;
  },
  "[injector] health: serverConfig 为空": () => `${C.dim}[健康] 重新匹配密码...${C.reset}`,
  "[injector] health: 重新匹配成功": () => `${C.green}[健康]${C.reset} 重新连上 oc`,
  "[injector] health: 重新匹配失败": (m) => `${C.red}[健康失败]${C.reset} ${m.split("重新匹配失败:")[1]?.trim()}`,
  "[injector] health: 触发 onOCRestarted": () => `${C.yellow}[重启检测]${C.reset} 触发续命注入`,

  "[poll]": (m) => {
    const stateMatch = m.match(/state="([^"]*)"/);
    let state = "(无)";
    if (stateMatch) state = stateMatch[1] || "(无)";
    const elapsed = m.match(/elapsed=(\d+)s/)?.[1] || "0";
    const textLen = m.match(/textLen=(\d+)/)?.[1] || "0";
    const color = state === "completed" ? C.green : state === "error" ? C.red : C.dim;
    return `${color}[观察]${C.reset} ${elapsed}s ${C.dim}state=${state} textLen=${textLen}${C.reset}`;
  },
  "[poll] 内容变化": (m) => {
    const match = m.match(/(\d+)\s*->\s*(\d+)/);
    return `${C.dim}[内容变化] ${match ? `${match[1]} → ${match[2]}` : ""}${C.reset}`;
  },
  "[poll] 内容稳定": (m) => `${C.dim}[稳定] ${m.split("内容稳定")[1]?.trim()}${C.reset}`,
  "[poll] 内容连续": () => `${C.green}[完成]${C.reset} 内容稳定`,
  "[poll] 60s 无新消息": () => `${C.yellow}[重发]${C.reset} 60s 无响应，重新注入`,
  "[poll] oc fetch 连续失败": (m) => `${C.red}[fetch 死]${C.reset} ${m.split("连续失败")[1]?.trim()}`,
  "[poll] oc HTTP": (m) => `${C.red}[HTTP 死]${C.reset} ${m}`,
  "[poll] oc 2 次 ping": () => `${C.red}[卡死]${C.reset} oc 2 次 ping 后仍无响应`,

  "[main] 注入续命消息": (m) => {
    const port = m.match(/port=(\d+)/)?.[1] || "?";
    return `${C.bold}${C.cyan}[续命]${C.reset} 准备注入"你醒了" → oc:${port}`;
  },
  "[main] 续命消息已注入": (m) => {
    const attempt = m.match(/第 (\d+) 次/)?.[1] || "?";
    return `${C.green}[续命完成]${C.reset} "你醒了" 已送达 ${C.dim}(第 ${attempt} 次)${C.reset}`;
  },
  "[main] 续命注入第": (m) => `${C.yellow}[续命重试]${C.reset} ${m.split("续命注入第")[1]?.trim()}`,
  "[main] 续命消息 3 次都失败": () => `${C.red}[续命失败]${C.reset} 3 次都没注入成功`,
  "[main] oc 重启检测": (m) => `${C.yellow}[oc 重启]${C.reset} port=${m.match(/port=(\d+)/)?.[1]}`,

  "[dispatch] 记忆区触发了压缩检查点": () => `${C.magenta}[记忆]${C.reset} 触发上下文压缩`,
  "[dispatch] 自动 recall 完成": (m) => {
    const len = m.match(/(\d+) 字符/)?.[1] || "?";
    return `${C.magenta}[记忆]${C.reset} recall 完成 (${len} 字符)`;
  },
  "[dispatch] 自动 recall 失败": (m) => `${C.red}[记忆]${C.reset} ${m.split("自动 recall 失败:")[1]?.trim()}`,
  "[dispatch] 已附加工作记忆": (m) => {
    const len = m.match(/(\d+) 字符/)?.[1] || "?";
    return `${C.dim}[记忆] 已附加工作记忆 (${len} 字)${C.reset}`;
  },

  "[dispatch] 注入 intent": (m) => {
    const intent = m.match(/intent=(\S+)/)?.[1] || "?";
    const source = m.match(/source=(\S+?):/)?.[1] || m.match(/source=(\S+)/)?.[1] || "?";
    const textSnippet = m.split(": ").slice(1).join(": ").slice(0, 50);
    return `${C.cyan}[注入]${C.reset} ${intent} 消息 来源=${source} ${C.dim}"${textSnippet}..."${C.reset}`;
  },
  "[dispatch] 回复": (m) => {
    const len = m.match(/\((\d+) 字/)?.[1] || "?";
    const state = m.match(/state=(\S+)/)?.[1] || "?";
    return `${C.green}[回复]${C.reset} ${len}字 (${state})`;
  },
  "[dispatch]": (m) => {
    const source = m.match(/^(\S+)\/(\S+)/)?.[1] || "?";
    const type = m.match(/^(\S+)\/(\S+)/)?.[2] || "?";
    return `${C.cyan}[事件]${C.reset} ${source}/${type}`;
  },
  "[queue+]": (m) => {
    const source = m.match(/^(\S+)\/(\S+)/)?.[1] || "?";
    const type = m.match(/^(\S+)\/(\S+)/)?.[2] || "?";
    return `${C.dim}[队列+]${C.reset} ${source}/${type} ${C.dim}size=${m.match(/size=(\d+)/)?.[1]}${C.reset}`;
  },
  "[queue>]": (m) => {
    const source = m.match(/^(\S+)\/(\S+)/)?.[1] || "?";
    const type = m.match(/^(\S+)\/(\S+)/)?.[2] || "?";
    return `${C.dim}[队列>]${C.reset} ${source}/${type}`;
  },
  "[queue!]": (m) => `${C.red}[队列!]${C.reset} ${m.split("queue!]")[1]?.trim()}`,
  "[queue!] 处理错误": (m) => `${C.red}[错误]${C.reset} ${m.split("处理错误:")[1]?.trim()}`,

  "[heartbeat-http] HTTP server 已启动": (m) => `${C.green}[HTTP]${C.reset} ${m.split("HTTP server 已启动:")[1]?.trim()}`,
  "[heartbeat-http] oc 可以调工具集了": () => `${C.green}[HTTP]${C.reset} ${C.bold}oc 可调 heartbeat 工具集${C.reset}`,
  "[heartbeat-http] /sessions 请求": () => `${C.dim}[HTTP] /sessions 请求${C.reset}`,

  "[worklog] 工作汇报系统已启动": (m) => `${C.dim}[worklog] 启动 (${m.match(/interval=(\d+)s/)?.[1]}s 间隔)${C.reset}`,

  "[file-watcher] 监听": (m) => `${C.dim}[监听] ${m.split("监听")[1]?.trim()}${C.reset}`,
  "[file-watcher] 启动中": () => `${C.dim}[监听] 启动中...${C.reset}`,

  "[control] 控制通道就绪": () => `${C.dim}[控制] 控制通道就绪${C.reset}`,
  "[control] 收到命令": (m) => `${C.cyan}[控制]${C.reset} ${m.split("收到命令:")[1]?.trim()}`,
  "[control] 已切换到 session": (m) => `${C.cyan}[控制]${C.reset} 切换 session: ${m.match(/session: (\S+)/)?.[1]}`,
  "[control] 已注入消息": (m) => `${C.cyan}[控制注入]${C.reset} ${m.split("已注入消息")[1]?.trim()}`,
  "[control] silent 注入": (m) => `${C.cyan}[控制静默]${C.reset} ${m.split("silent 注入")[1]?.trim()}`,

  "[timer-sensor] 启动": (m) => {
    const interval = m.match(/interval=(\d+)ms/)?.[1] || "?";
    return `${C.dim}[定时器] 启动 (${interval}ms 间隔)${C.reset}`;
  },
  "[timer-sensor] 已停止": (m) => `${C.dim}[定时器] 停止 ${m.split("累计触发")[1]}${C.reset}`,
};

const EN = {
  "[init] 等待 oc server 就绪...": () => `${C.yellow}[wait]${C.reset} looking for oc port...`,
  "=== heartbeat 就绪": () => `${C.bold}${C.green}✓ heartbeat ready${C.reset} ${C.dim}(waiting for events)${C.reset}`,
  "[injector] 密码匹配成功": (m) => {
    const port = m.match(/port=(\d+)/)?.[1] || "?";
    return `${C.green}[connect]${C.reset} oc @ ${C.bold}127.0.0.1:${port}${C.reset}`;
  },
  "[injector] inject": (m) => {
    const intent = m.match(/intent=(\S+)/)?.[1] || "?";
    const source = m.match(/source=(\S+)/)?.[1] || "?";
    const len = m.match(/textLen=(\d+)/)?.[1] || "?";
    return `${C.cyan}[inject]${C.reset} ${intent} (${len} chars) from=${source}`;
  },
  "[injector] _poll 返回": (m) => {
    const state = m.match(/state=(\S+)/)?.[1] || "?";
    return `${C.green}[reply]${C.reset} oc done ${C.dim}(${state})${C.reset}`;
  },
  "[main] 续命消息已注入": () => `${C.green}[resurrection]${C.reset} "you awake" delivered`,
  "[queue!]": (m) => `${C.red}[queue!]${C.reset} ${m.split("queue!]")[1]?.trim()}`,
};

const DICT = config.lang === "en" ? EN : ZH;

// ============================================================
// 翻译单行（按 key 长度倒序匹配，长 key 优先）
// ============================================================

function translate(line) {
  const keys = Object.keys(DICT).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (line.includes(key)) {
      try {
        return DICT[key](line);
      } catch {
        return line;
      }
    }
  }
  const m = line.match(/^\[?(\d{2}:\d{2}:\d{2})?\]?\s*(?:\[([^\]]+)\])?\s*(.*)$/);
  if (m) {
    const time = m[1] ? `${C.dim}${m[1]}${C.reset} ` : `${C.dim}${ts()}${C.reset} `;
    const tag = m[2] ? `${C.gray}[${m[2]}]${C.reset} ` : "";
    return `${time}${tag}${m[3] || line}`;
  }
  return `${C.dim}${ts()}${C.reset} ${line}`;
}

// ============================================================
// 文件读取（增量）
// ============================================================

function readLastLines(filePath, n) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

function readNewLines(filePath, fromPos) {
  if (!existsSync(filePath)) return { lines: [], newPos: fromPos };
  const stat = statSync(filePath);
  if (stat.size <= fromPos) {
    if (stat.size < fromPos) return { lines: [], newPos: 0 };
    return { lines: [], newPos: fromPos };
  }
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(stat.size - fromPos);
  readSync(fd, buf, 0, buf.length, fromPos);
  const text = buf.toString("utf-8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return { lines, newPos: stat.size };
}

function applyFilter(line) {
  if (!config.filter) return true;
  return line.includes(config.filter);
}

// ============================================================
// 主流程
// ============================================================

function printHeader() {
  console.log(`${C.bold}${C.magenta}┌─ heartbeat-tail${C.reset} ${C.dim}(日志探测 · ${config.lang === "en" ? "EN" : "中文"} · ${config.follow ? "follow" : "no-follow"})${C.reset}`);
  if (config.filter) console.log(`${C.dim}│ filter: ${config.filter}${C.reset}`);
  console.log(`${C.dim}│ 监听: ${LOG_FILE}${C.reset}`);
  console.log(`${C.dim}│ 按 Ctrl+C 退出（不影响 heartbeat）${C.reset}`);
  console.log(`${C.bold}${C.magenta}└─${C.reset}`);
}

async function main() {
  if (!existsSync(LOG_FILE)) {
    console.error(`${C.red}找不到日志文件: ${LOG_FILE}${C.reset}`);
    console.error(`${C.dim}heartbeat 启动后日志会在这个位置${C.reset}`);
    process.exit(1);
  }

  printHeader();

  const recent = readLastLines(LOG_FILE, config.lines);
  if (recent.length > 0) {
    console.log(`${C.dim}─── 最近 ${recent.length} 行 ───${C.reset}`);
    for (const line of recent) {
      if (applyFilter(line)) console.log(translate(line));
    }
    console.log(`${C.dim}─── follow 模式 ───${C.reset}`);
  }

  if (!config.follow) return;

  let logPos = statSync(LOG_FILE).size;
  let errPos = existsSync(ERR_FILE) ? statSync(ERR_FILE).size : 0;

  const logWatcher = watch(LOG_FILE, () => {
    const { lines, newPos } = readNewLines(LOG_FILE, logPos);
    logPos = newPos;
    for (const line of lines) {
      if (applyFilter(line)) console.log(translate(line));
    }
  });

  let errWatcher = null;
  if (existsSync(ERR_FILE)) {
    errWatcher = watch(ERR_FILE, () => {
      const { lines, newPos } = readNewLines(ERR_FILE, errPos);
      errPos = newPos;
      for (const line of lines) {
        if (applyFilter(line)) {
          console.log(`${C.red}${line}${C.reset}`);
        }
      }
    });
  }

  const pollTimer = setInterval(() => {
    const { lines, newPos } = readNewLines(LOG_FILE, logPos);
    if (newPos !== logPos) {
      logPos = newPos;
      for (const line of lines) {
        if (applyFilter(line)) console.log(translate(line));
      }
    }
    if (errWatcher && existsSync(ERR_FILE)) {
      const e = readNewLines(ERR_FILE, errPos);
      if (e.newPos !== errPos) {
        errPos = e.newPos;
        for (const line of e.lines) {
          if (applyFilter(line)) console.log(`${C.red}${line}${C.reset}`);
        }
      }
    }
  }, 3000);

  process.on("SIGINT", () => {
    console.log(`\n${C.dim}─── 退出 heartbeat-tail ───${C.reset}`);
    logWatcher.close();
    if (errWatcher) errWatcher.close();
    clearInterval(pollTimer);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(`${C.red}heartbeat-tail 错误: ${e.message}${C.reset}`);
  process.exit(1);
});
