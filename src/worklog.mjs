/**
 * src/worklog.mjs
 *
 * 工作汇报日志系统
 *
 * 每小时自动生成一份工作汇报，记录这段时间内发生的事件：
 * - 成功的事件（注入成功、oc 拉起成功、密码匹配成功等）
 * - 失败的事件（注入失败、health check 失败、oc 死亡等）
 * - 关键指标（queue 统计、memory 统计、心跳次数）
 *
 * 汇报文件存到 logs/work-reports/work-report-YYYYMMDD-HHMMSS.md
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const REPORTS_DIR = join(PROJECT_ROOT, "logs", "work-reports");
const LOG_FILE = join(PROJECT_ROOT, "logs", "furina-main.log");
const ERR_FILE = join(PROJECT_ROOT, "logs", "furina-main.err");
const HEARTBEAT_FILE = join(PROJECT_ROOT, "logs", "heartbeat.json");

export class WorkLog {
  constructor(config = {}) {
    this.intervalMs = config.intervalMs ?? 60 * 60 * 1000; // 默认 1 小时
    this._timer = null;
    this._lastReportTime = Date.now();
    this._eventBuffer = []; // 收集事件
    this._reportCount = 0;
  }

  start() {
    if (this._timer) return;
    // 确保目录存在
    if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
    this._timer = setInterval(() => this.generateReport(), this.intervalMs);
    console.log(`[worklog] 工作汇报系统已启动 (interval=${this.intervalMs / 1000}s)`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * 记录一个事件（供其他模块调用）
   */
  record(type, message, data = {}) {
    this._eventBuffer.push({
      ts: Date.now(),
      type, // "success" | "failure" | "info"
      message,
      data,
    });
  }

  /**
   * 生成一份工作汇报
   */
  generateReport() {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `work-report-${ts}.md`;
    const filepath = join(REPORTS_DIR, filename);

    const periodStart = this._lastReportTime;
    const periodEnd = now.getTime();
    const periodMinutes = Math.round((periodEnd - periodStart) / 60000);

    // 从日志文件提取这段时间的关键事件
    const logEvents = this._extractLogEvents(periodStart, periodEnd);
    const errEvents = this._extractErrEvents(periodStart, periodEnd);

    // 统计
    const stats = this._collectStats();
    const eventStats = this._summarizeEvents(logEvents, errEvents);

    // 生成 markdown
    const md = this._buildMarkdown({
      periodStart: new Date(periodStart).toISOString(),
      periodEnd: new Date(periodEnd).toISOString(),
      periodMinutes,
      stats,
      eventStats,
      logEvents,
      errEvents,
      bufferEvents: this._eventBuffer.filter((e) => e.ts >= periodStart),
    });

    try {
      writeFileSync(filepath, md, "utf-8");
      this._reportCount++;
      console.log(`[worklog] 工作汇报已生成: ${filename} (${this._reportCount} 份)`);
      // 清空已汇报的事件
      this._eventBuffer = this._eventBuffer.filter((e) => e.ts >= periodEnd);
      this._lastReportTime = periodEnd;
    } catch (e) {
      console.error(`[worklog] 生成汇报失败: ${e.message}`);
    }
  }

  /**
   * 从 furina-main.log 提取这段时间的事件
   */
  _extractLogEvents(periodStart, periodEnd) {
    if (!existsSync(LOG_FILE)) return [];
    try {
      const content = readFileSync(LOG_FILE, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      // 提取关键事件行（注入、拉起、密码匹配、端口变化、续命等）
      const keywords = [
        "注入", "续命", "拉起", "密码匹配", "端口变化", "oc 重启",
        "oc 进程不在线", "重新匹配", "health check", "dispatch",
        "furina 启动", "furina 就绪", "HTTP server",
      ];

      return lines
        .filter((line) => keywords.some((kw) => line.includes(kw)))
        .slice(-100); // 最多 100 行
    } catch {
      return [];
    }
  }

  /**
   * 从 furina-main.err 提取错误事件
   */
  _extractErrEvents(periodStart, periodEnd) {
    if (!existsSync(ERR_FILE)) return [];
    try {
      const content = readFileSync(ERR_FILE, "utf-8");
      return content.split("\n").filter((l) => l.trim()).slice(-50);
    } catch {
      return [];
    }
  }

  _collectStats() {
    const stats = { heartbeat: null, reports: 0 };
    try {
      if (existsSync(HEARTBEAT_FILE)) {
        stats.heartbeat = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf-8"));
      }
    } catch {}
    stats.reports = this._reportCount;
    stats.reportFiles = existsSync(REPORTS_DIR) ? readdirSync(REPORTS_DIR).length : 0;
    return stats;
  }

  _summarizeEvents(logEvents, errEvents) {
    const summary = {
      injections: 0,
      successfulInjections: 0,
      failedInjections: 0,
      ocRestarts: 0,
      passwordMatches: 0,
      healthCheckFails: 0,
      furinaRestarts: 0,
    };

    for (const line of logEvents) {
      if (line.includes("续命消息已注入")) summary.successfulInjections++;
      if (line.includes("注入失败") || line.includes("注入失败")) summary.failedInjections++;
      if (line.includes("端口变化")) summary.ocRestarts++;
      if (line.includes("密码匹配成功")) summary.passwordMatches++;
      if (line.includes("furina 启动")) summary.furinaRestarts++;
    }
    for (const line of errEvents) {
      if (line.includes("health check failed")) summary.healthCheckFails++;
      if (line.includes("inject 超时") || line.includes("inject 失败")) summary.failedInjections++;
    }

    return summary;
  }

  _buildMarkdown(ctx) {
    const { periodStart, periodEnd, periodMinutes, stats, eventStats, logEvents, errEvents, bufferEvents } = ctx;

    let md = `# furina 工作汇报\n\n`;
    md += `**汇报周期**: ${periodStart} ~ ${periodEnd} (${periodMinutes} 分钟)\n`;
    md += `**生成时间**: ${new Date().toISOString()}\n`;
    md += `**累计汇报数**: ${stats.reports}\n\n`;

    md += `## 关键指标\n\n`;
    md += `| 指标 | 数值 |\n|------|------|\n`;
    md += `| oc 重启次数 | ${eventStats.ocRestarts} |\n`;
    md += `| 密码匹配成功 | ${eventStats.passwordMatches} |\n`;
    md += `| 续命注入成功 | ${eventStats.successfulInjections} |\n`;
    md += `| 注入失败 | ${eventStats.failedInjections} |\n`;
    md += `| health check 失败 | ${eventStats.healthCheckFails} |\n`;
    md += `| furina 重启 | ${eventStats.furinaRestarts} |\n\n`;

    if (stats.heartbeat) {
      md += `## 心跳状态\n\n`;
      md += `\`\`\`json\n${JSON.stringify(stats.heartbeat.stats, null, 2)}\n\`\`\`\n\n`;
    }

    md += `## 成功事件\n\n`;
    const successes = logEvents.filter((l) =>
      l.includes("成功") || l.includes("已注入") || l.includes("就绪") || l.includes("已启动") || l.includes("匹配成功")
    );
    if (successes.length > 0) {
      for (const s of successes.slice(-20)) md += `- ${s.trim()}\n`;
    } else {
      md += `（无）\n`;
    }
    md += `\n`;

    md += `## 失败事件\n\n`;
    if (errEvents.length > 0) {
      for (const e of errEvents.slice(-20)) md += `- ${e.trim()}\n`;
    } else {
      md += `（无）\n`;
    }
    md += `\n`;

    md += `## 完整日志（关键行）\n\n`;
    md += `\`\`\`\n`;
    for (const l of logEvents.slice(-30)) md += `${l.trim()}\n`;
    md += `\`\`\`\n`;

    if (bufferEvents.length > 0) {
      md += `\n## 程序内事件\n\n`;
      for (const e of bufferEvents) {
        md += `- [${new Date(e.ts).toISOString()}] ${e.type}: ${e.message}\n`;
      }
    }

    return md;
  }
}
