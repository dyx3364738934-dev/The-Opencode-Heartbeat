/**
 * src/presets.mjs
 *
 * 预设系统：可对话编辑的行为配置
 *
 * AI 通过 control.json 的 set-preset 命令修改预设，furina 热加载。
 *
 * 三种工作模式：
 *   self-talk    自我对话（空闲时注入"继续思考"类消息，形成自循环）
 *   find-work    找事做（空闲时注入探索性任务）
 *   observe      窥探koko（只监测不注入，纯被动观察）
 *
 * 健康检测：
 *   注入后追踪 oc 的 state，state 不变超过阈值才戳醒
 *   戳醒 2 轮失败后触发看门狗重启 oc
 */

import { readFileSync, writeFileSync, existsSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_FILE = join(__dirname, "..", "config", "presets.json");

// 默认预设
const DEFAULT_PRESETS = {
  mode: "observe", // self-talk | find-work | observe

  // v0.2 新增：timer 感知器配置（周期性 dogfooding）
  timer: {
    enabled: true,
    intervalMs: 600000, // 10 分钟
    initialDelayMs: 30000, // 30s 后第一次
    message: "[furina 周期] 例行检查。请简短汇报当前状态或寻找新的改进点。",
    priority: 20, // LOW
  },

  // 空闲判定：oc 的 state=completed 且 N 秒没新消息 -> 触发模式逻辑
  idleThresholdMs: 300000, // 5 分钟空闲触发

  // 自我对话模式预设
  selfTalkPrompts: [
    "继续上一步的思考，看看有没有遗漏",
    "总结一下刚才做了什么，接下来做什么",
    "检查一下当前任务有没有边界情况没处理",
  ],

  // 找事做模式预设
  findWorkPrompts: [
    "检查 watch 目录有没有新文件变化",
    "看看 onlyoc 当前文档状态，有没有需要处理的",
    "回顾最近的工作，有没有可以优化的地方",
  ],

  // 健康检测
  healthCheck: {
    // 注入后追踪 state，state 不变超过此时间 -> 戳醒
    staleStateMs: 120000, // 2 分钟 state 无变化
    // 戳醒消息（逐级升级）
    pokeMessages: [
      "你还在吗？如果卡住了请回复 [furina] 卡住了",
      "尝试重新聚焦：请总结当前任务状态和下一步计划",
    ],
    // 戳醒间隔
    pokeIntervalMs: 60000, // 每轮戳醒间隔 60s
    // 戳醒 N 轮失败后重启 oc
    maxPokeRounds: 2,
    // 重启 oc 后等待恢复时间
    restartRecoveryMs: 30000, // 30s
  },

  // 观察模式配置
  observe: {
    // 只记录不注入，但检测到这些关键词时主动介入
    interveneKeywords: ["furina", "芙宁娜", "help", "救命"],
    // 介入消息
    interveneMessage: "[furina] 检测到呼叫，我在线，有什么需要？",
  },
};

export class Presets {
  constructor() {
    this.data = { ...DEFAULT_PRESETS };
    this._watcher = null;
    this._onReload = null;
    this._load();
    this._startWatch();
  }

  _load() {
    if (existsSync(PRESETS_FILE)) {
      try {
        const raw = readFileSync(PRESETS_FILE, "utf-8");
        const loaded = JSON.parse(raw);
        // 深合并：保留默认值，覆盖用户值
        this.data = {
          ...DEFAULT_PRESETS,
          ...loaded,
          healthCheck: { ...DEFAULT_PRESETS.healthCheck, ...(loaded.healthCheck || {}) },
          observe: { ...DEFAULT_PRESETS.observe, ...(loaded.observe || {}) },
        };
        console.log("[presets] 已加载", PRESETS_FILE);
      } catch (e) {
        console.warn(`[presets] 加载失败，用默认: ${e.message}`);
      }
    } else {
      this._save();
      console.log("[presets] 创建默认配置", PRESETS_FILE);
    }
  }

  _save() {
    try {
      writeFileSync(PRESETS_FILE, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error(`[presets] 保存失败: ${e.message}`);
    }
  }

  _startWatch() {
    // 监听文件变化，热加载（AI 编辑后自动生效）
    try {
      this._watcher = watch(PRESETS_FILE, (eventType) => {
        if (eventType === "change") {
          // 延迟避免写入不完整
          setTimeout(() => {
            const oldMode = this.data.mode;
            this._load();
            console.log(`[presets] 热加载完成，模式: ${this.data.mode}`);
            if (this._onReload) this._onReload(this.data, oldMode);
          }, 300);
        }
      });
    } catch {}
  }

  onReload(fn) {
    this._onReload = fn;
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  set(key, value) {
    if (key in this.data) {
      this.data[key] = value;
      this._save();
      console.log(`[presets] 已更新 ${key}`);
      return true;
    }
    // 支持嵌套 healthCheck.staleStateMs
    const parts = key.split(".");
    if (parts.length === 2 && parts[0] in this.data && typeof this.data[parts[0]] === "object") {
      this.data[parts[0]][parts[1]] = value;
      this._save();
      console.log(`[presets] 已更新 ${key}`);
      return true;
    }
    return false;
  }

  // 添加一条预设消息
  addPrompt(listName, text) {
    const list = this.data[listName];
    if (Array.isArray(list)) {
      list.push(text);
      this._save();
      return true;
    }
    return false;
  }

  // 删除一条预设消息
  removePrompt(listName, index) {
    const list = this.data[listName];
    if (Array.isArray(list) && index >= 0 && index < list.length) {
      list.splice(index, 1);
      this._save();
      return true;
    }
    return false;
  }

  // 轮转取下一条预设消息（自我对话/找事做用）
  nextPrompt(listName) {
    const list = this.data[listName];
    if (!Array.isArray(list) || list.length === 0) return null;
    // 简单轮转：用时间戳取模
    const idx = Math.floor(Date.now() / 1000) % list.length;
    return list[idx];
  }
}
