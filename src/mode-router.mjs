/**
 * src/mode-router.mjs
 *
 * v0.8.7: 模式路由 -- 检测用户消息中的模式关键词
 *
 * 多种叫法（领航员/自动驾驶/挂机/代理人/巡航/梦游/凛...）统一触发一个"自主模式"。
 * 检测到后返回模式提示词，korina 在注入用户消息前先 silentInject 提示词。
 *
 * 模式定义见 config/mode-prompts.json
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODE_FILE = join(__dirname, "..", "config", "mode-prompts.json");

let _mode = null;
let _loadedAt = 0;

/**
 * 加载模式配置（带缓存，60s 刷新一次支持热修改）
 */
function loadMode() {
  if (_mode && Date.now() - _loadedAt < 60000) return _mode;
  if (!existsSync(MODE_FILE)) {
    _mode = null;
    return _mode;
  }
  try {
    const data = JSON.parse(readFileSync(MODE_FILE, "utf-8"));
    _mode = data.mode || null;
    _loadedAt = Date.now();
    return _mode;
  } catch (e) {
    console.warn(`[mode-router] 加载模式配置失败: ${e.message}`);
    return _mode || null;
  }
}

/**
 * 检测文本中是否包含模式关键词
 *
 * 设计原则（v0.9.5 Koko 校正后）：
 *   关键词表是单一真相源。所有关键词都是同一个模式（自主模式）的别名，
 *   用户视角下没有"长短/中英文/歧义性"之分——"afk"、"代理"、"navigator"、
 *   "梦游少女凛"意思完全一样（"我要进自主模式"）。
 *   substring 统一处理。不按字符类型/长度分堆。
 *
 *   如果某个关键词在日常对话里频繁误触，**从列表里删**（curation），
 *   不要加 per-keyword heuristic 去绕过——那是背离设计原则的。
 *
 * @param {string} text - 用户消息文本
 * @returns {{ name, keywords, prompt, korinaMode?, timerIntervalMs? } | null}
 */
export function detectMode(text) {
  if (!text || typeof text !== "string") return null;
  const mode = loadMode();
  if (!mode || !mode.keywords || !mode.prompt) return null;
  const lower = text.toLowerCase();
  for (const kw of mode.keywords) {
    if (lower.includes(kw.toLowerCase())) return mode;
  }
  return null;
}

/**
 * 获取模式信息（供 HTTP 端点查询）
 */
export function getModeInfo() {
  const mode = loadMode();
  if (!mode) return null;
  return {
    name: mode.name,
    keywords: mode.keywords,
    korinaMode: mode.korinaMode,
    timerIntervalMs: mode.timerIntervalMs,
  };
}
