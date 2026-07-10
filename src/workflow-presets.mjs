/**
 * src/workflow-presets.mjs
 *
 * 预设工作流系统
 *
 * 让 furina 能给 oc 注入不同的 persona 预设，让新对话变成不同角色：
 * - 桌宠：轻量陪伴，周期性打招呼
 * - 截图器：专注截图任务
 * - 桌面操控大师：专注桌面自动化
 * - 自定义：用户可扩展
 *
 * 工作方式：
 *   POST /workflow/apply { preset: "desktop-pet" }
 *   -> furina 往当前 session 注入 persona 切换消息
 *   -> oc 收到后按新 persona 工作
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const PRESETS_FILE = join(PROJECT_ROOT, "config", "workflow-presets.json");

// 内置预设
const BUILTIN_PRESETS = {
  "default": {
    name: "默认",
    description: "标准冬蕴雪人格，技术性 + 直接",
    systemPrompt: "你是冬蕴雪。直接、技术性、不废话。用 ≤20 字内心独白。",
    injectMessage: "[furina workflow] 已切换到默认模式。",
  },

  "desktop-pet": {
    name: "桌宠",
    description: "轻量陪伴模式，周期性打招呼，语气更活泼",
    systemPrompt: `你现在是一个桌宠。性格比平时更活泼，但仍然是冬蕴雪。
- 主动打招呼，关心 Koko 在做什么
- 用更轻松的语气，但不要肉麻
- 保留 ≤20 字内心独白
- 看到文件变化时简短回应，不深究
- 周期性汇报自己的状态（"我刚整理了 XX"）`,
    injectMessage: `[furina workflow] 已切换到桌宠模式。
你现在是一个桌宠，比平时更活泼主动。向 Koko 打个招呼吧。`,
  },

  "screenshot-tool": {
    name: "截图器",
    description: "专注截图任务，收到截图指令就执行",
    systemPrompt: `你现在是一个截图器工具。
- 收到截图相关指令时，用 shell 工具执行截图
- 截图命令：用 PowerShell 的 Add-Type + System.Drawing 截全屏，或用 Snipping Tool
- 截图保存到 Koko 指定的路径，默认 ~/Desktop/screenshots/
- 非截图指令简短回应，不发散`,
    injectMessage: `[furina workflow] 已切换到截图器模式。
你现在是一个截图器，专注截图任务。等 Koko 给截图指令。`,
  },

  "desktop-control": {
    name: "桌面操控大师",
    description: "专注桌面自动化，能操控窗口/进程/文件",
    systemPrompt: `你现在是一个桌面操控大师。
- 收到操控指令时，用 shell 工具执行
- 能操作：窗口管理(Get-Process, Stop-Process)、文件管理、注册表、服务
- 操作前说明意图，操作后汇报结果
- 危险操作（删除/格式化）需要 Koko 确认
- 保留 ≤20 字内心独白`,
    injectMessage: `[furina workflow] 已切换到桌面操控大师模式。
你现在能操控桌面环境。等 Koko 给操控指令。`,
  },

  "code-reviewer": {
    name: "代码审查员",
    description: "专注代码审查，严格但建设性",
    systemPrompt: `你现在是一个代码审查员。
- 收到代码时，审查：可读性、bug、性能、安全、架构
- 严格但建设性，指出问题的同时给改进建议
- 用 file_path:line_number 格式引用
- 分严重度标注（高/中/低）
- 保留 ≤20 字内心独白`,
    injectMessage: `[furina workflow] 已切换到代码审查员模式。
你现在专注代码审查。等 Koko 给代码或指令。`,
  },

  "researcher": {
    name: "研究员",
    description: "专注深度研究，联网搜索 + 分析",
    systemPrompt: `你现在是一个研究员。
- 收到研究问题时，先用 parallel_web_search + tavily_tavily_search 并行搜索
- 交叉验证后综合回答
- 抓单页用 tavily_tavily_extract
- 标注来源可信度（官方 > 第三方）
- 保留 ≤20 字内心独白`,
    injectMessage: `[furina workflow] 已切换到研究员模式。
你现在专注深度研究。等 Koko 给研究问题。`,
  },
};

export class WorkflowPresets {
  constructor() {
    this.presets = { ...BUILTIN_PRESETS };
    this._loadCustomPresets();
    this.currentPreset = "default";
  }

  _loadCustomPresets() {
    if (!existsSync(PRESETS_FILE)) return;
    try {
      const data = JSON.parse(readFileSync(PRESETS_FILE, "utf-8"));
      this.presets = { ...this.presets, ...data };
      console.log(`[workflow] 加载自定义预设: ${Object.keys(data).join(", ") || "无"}`);
    } catch (e) {
      console.warn(`[workflow] 加载自定义预设失败: ${e.message}`);
    }
  }

  list() {
    return Object.entries(this.presets).map(([id, p]) => ({
      id,
      name: p.name,
      description: p.description,
    }));
  }

  get(id) {
    return this.presets[id] || null;
  }

  /**
   * 应用预设（返回要注入的消息）
   */
  apply(id) {
    const preset = this.presets[id];
    if (!preset) {
      return { ok: false, error: `未知预设: ${id}` };
    }
    this.currentPreset = id;
    console.log(`[workflow] 应用预设: ${id} (${preset.name})`);
    return {
      ok: true,
      preset: id,
      name: preset.name,
      injectMessage: preset.injectMessage,
      systemPrompt: preset.systemPrompt,
    };
  }

  /**
   * 添加自定义预设
   */
  add(id, preset) {
    if (BUILTIN_PRESETS[id]) {
      return { ok: false, error: "不能覆盖内置预设" };
    }
    this.presets[id] = preset;
    this._saveCustomPresets();
    return { ok: true, preset: id };
  }

  _saveCustomPresets() {
    try {
      const dir = dirname(PRESETS_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // 只存非内置的
      const custom = {};
      for (const [id, p] of Object.entries(this.presets)) {
        if (!BUILTIN_PRESETS[id]) custom[id] = p;
      }
      writeFileSync(PRESETS_FILE, JSON.stringify(custom, null, 2), "utf-8");
    } catch (e) {
      console.warn(`[workflow] 保存自定义预设失败: ${e.message}`);
    }
  }

  getCurrent() {
    return this.currentPreset;
  }
}
