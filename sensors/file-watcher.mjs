/**
 * sensors/file-watcher.mjs
 *
 * 文件感知器：监听指定目录的文件变化
 *
 * 配置：
 *   paths: [string]       监听路径列表
 *   ignore: [string]      忽略的 glob 模式
 *   debounceMs: number    单文件去抖（默认 1000ms，防止编辑器多次保存触发）
 *
 * 事件：
 *   { type: "file.changed", payload: { path, event, size, mtime } }
 *   event: "add" | "change" | "unlink" | "addDir" | "unlinkDir"
 */

import chokidar from "chokidar";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { BaseSensor } from "./base-sensor.mjs";
import { PRIORITY } from "../src/event-queue.mjs";

// 绝对路径硬黑名单（即使 chokidar ignore 失效也兜底过滤）
// 防止 .git、furina 自身状态文件、控制通道文件、furina 自身代码目录被错误感知
const HARD_IGNORE_DIRS = [
  /[\\/]\.git[\\/]/i,
  /[\\/]node_modules[\\/]/i,
  /[\\/]logs[\\/]/i,
  // v0.2: 排除 furina 自身代码目录（防止开发时自我循环感知）
  // v0.4: 加 memory/（冬蕴雪手动记忆写入不触发 furina 感知）
  // 注意：watch-test/ 故意不排除，允许开发者监控测试目录
  /[\\/]furina[\\/](src|sensors|watchdog|config|docs|tests|memory)[\\/]/i,
];
const HARD_IGNORE_FILES = [
  /[\\/]control\.json$/i,
  /[\\/]heartbeat\.json$/i,
  /[\\/]session\.lock$/i,
  /[\\/]oc-password\.txt$/i,
  /[\\/]oc-dead\.flag$/i,
  /[\\/]package-lock\.json$/i,
];

function isHardIgnored(filePath) {
  for (const re of HARD_IGNORE_DIRS) {
    if (re.test(filePath)) return true;
  }
  for (const re of HARD_IGNORE_FILES) {
    if (re.test(filePath)) return true;
  }
  return false;
}

export class FileWatcher extends BaseSensor {
  constructor(eventQueue, config = {}) {
    super("file-watcher", eventQueue, config);
    this.paths = config.paths || ["."];
    this.ignore = config.ignore || [
      "**/node_modules/**",
      "**/.git/**",
      "**/logs/**",
      "**/*.log",
    ];
    this.debounceMs = config.debounceMs ?? 1000;
    this.watcher = null;
    this.pendingEvents = new Map(); // path -> timer
  }

  async start() {
    if (this.running) return;
    this.running = true;

    this.watcher = chokidar.watch(this.paths, {
      ignored: this.ignore,
      persistent: true,
      ignoreInitial: true, // 启动时不把已有文件当变化
      // 去抖在 _handleEvent 里自己做（更可控），不用 chokidar 的 awaitWriteFinish
    });

    const handleChange = (filePath, stats) => this._handleEvent(filePath, "change", stats);
    const handleAdd = (filePath, stats) => this._handleEvent(filePath, "add", stats);
    const handleUnlink = (filePath) => this._handleEvent(filePath, "unlink");

    this.watcher
      .on("add", handleAdd)
      .on("change", handleChange)
      .on("unlink", handleUnlink)
      .on("ready", () => {
        this.ready = true;
        console.log(`[file-watcher] 监听 ${this.paths.length} 个路径（ready）`);
        for (const p of this.paths) console.log(`  - ${p}`);
      })
      .on("error", (err) => console.error(`[file-watcher] 错误:`, err.message));

    // 不等待 ready 事件（Desktop 等大目录扫描可能很久）
    // chokidar 在扫描期间也能收到文件变化事件
    console.log(`[file-watcher] 启动中，监听 ${this.paths.length} 个路径...`);
  }

  _handleEvent(filePath, event, stats) {
    // 绝对路径硬过滤（兜底，chokidar ignore 失效时仍生效）
    if (isHardIgnored(filePath)) {
      return;
    }

    // 手动排除 furina 自身目录（防止心跳/配置自循环）
    const normalized = filePath.replace(/\\/g, "/");
    if (/[\/]logs[\/]/.test(normalized) || /[\/]config[\/]/.test(normalized)) {
      return;
    }

    // 去抖：同一文件在 debounceMs 内的多次事件合并
    if (this.pendingEvents.has(filePath)) {
      clearTimeout(this.pendingEvents.get(filePath));
    }

    const timer = setTimeout(() => {
      this.pendingEvents.delete(filePath);

      let size = 0;
      let mtime = 0;
      try {
        const s = stats || statSync(filePath);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {}

      // 判断优先级：日志/临时文件 LOW，代码/文档 NORMAL
      let priority = PRIORITY.NORMAL;
      if (/\.(log|tmp|cache)$/i.test(filePath)) priority = PRIORITY.LOW;
      if (/\.(md|txt|docx|xlsx|pptx|pdf|json|js|mjs|ts|py)$/i.test(filePath)) {
        priority = PRIORITY.NORMAL;
      }

      this.emit({
        type: "file.changed",
        payload: {
          path: filePath,
          event, // add | change | unlink
          size,
          mtime,
        },
        priority,
      });
    }, this.debounceMs);

    this.pendingEvents.set(filePath, timer);
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.pendingEvents.values()) clearTimeout(timer);
    this.pendingEvents.clear();
    this.running = false;
  }
}
