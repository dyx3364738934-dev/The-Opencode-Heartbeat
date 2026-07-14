/**
 * plugins/file-watcher/plugin.mjs
 *
 * v0.9.3: 文件变化感知插件（内联 FileWatcher，原 sensors/ 已删）
 */
import chokidar from "chokidar";

// v0.9.3: 暴露 FileWatcher 类供测试用（test-e2e.mjs）
export class FileWatcher {
  constructor(queue, options = {}) {
    this.queue = queue;
    this.paths = options.paths || [];
    this.debounceMs = options.debounceMs || 1000;
    this.watcher = null;
    this._timers = new Map();
  }

  start() {
    if (this.paths.length === 0) return Promise.resolve();
    this.watcher = chokidar.watch(this.paths, {
      ignored: [
        /[\\/]\./,
        /[\\/]node_modules[\\/]/,
        /[\\/]logs[\\/]/,
        /[\\/]korina[\\/](src|watchdog|config|docs|tests|memory)[\\/]/i,
      ],
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });
    this.watcher.on("all", (event, path) => {
      const key = `${event}:${path}`;
      if (this._timers.has(key)) clearTimeout(this._timers.get(key));
      this._timers.set(key, setTimeout(() => {
        this._timers.delete(key);
        this.queue.push("file-watcher", "file.changed", { event, path }, 10);
      }, this.debounceMs));
    });
    // v0.9.3: 返回 Promise 等 chokidar ready（修复 test-e2e 在 ready 前写入文件导致检测不到的 bug）
    return new Promise((resolve) => {
      this.watcher.on("ready", () => resolve());
      // 兜底：5 秒还没 ready 也算 ready（避免测试卡死）
      setTimeout(() => resolve(), 5000);
    });
  }

  stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
  }
}

export default {
  name: "file-watcher",
  dependencies: ["oc-injector"],

  async init(ctx) {
    // L5.4 shadow mode (manual #45): shadow 实例不启动 chokidar（不主动 fire file.changed）
    if (ctx.korina?.instanceRole === "shadow") {
      ctx.log("shadow 模式：跳过 file-watcher 主动 fire（保留 HTTP 端点）");
      return { stop() {}, watcher: null };
    }
    const { queue, bus, presets, korina } = ctx;

    const watchPaths = [];
    // 从 presets.json 读 watchPath
    const watchPath = presets.get("watchPath");
    if (watchPath) watchPaths.push(watchPath);

    if (watchPaths.length === 0) {
      ctx.log("未指定 watchPath，无文件感知器");
      return { watcher: null };
    }

    const watcher = new FileWatcher(queue, {
      paths: watchPaths,
      debounceMs: 1000,
    });
    watcher.start();
    ctx.log(`file-watcher 监听 ${watchPaths.length} 路径`);

    // 暴露
    korina.fileWatcher = watcher;

    return { watcher };
  },

  destroy() {
    this.watcher?.stop?.();
  },
};
