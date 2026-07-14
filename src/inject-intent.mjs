/**
 * src/inject-intent.mjs
 *
 * 注入意图系统 -- korina 注入消息时附带的结构化元数据
 *
 * 5 种 intent（v0.8 精简：砍 koko/auto-recall，system→sensor）：
 *   survival     续命（oc 重启后唤醒）
 *   sensor       korina sensor 自动事件（文件变化/端口变化/health）
 *   self-direct  oc 派给自己的任务（silent inject）
 *   user         默认用户消息（inject fallback，无标签）
 *   custom       自定义（高级用法）
 *
 * 消息格式：[agent-hint: <intent> / <source>] <正文>
 * agent-hint 短小稳定，oc 容易解析；正文按 intent 决定是否包装
 *
 * 砍除说明：
 *   - koko（Koko 纯消息）：Koko 直接在 oc 说话即可，不绕 korina
 *   - auto-recall（记忆回灌）：记忆交给 oc 自己 search_oc_memory，korina 不管记忆
 */

export const INTENTS = {
  // 续命：oc 重启后，korina 注入"你醒了"
  survival: {
    label: "survival",
    description: "oc 重启/续命：korina 拉起新 oc 后注入'你醒了'",
    renderPrefix: (source) => `[agent-hint: survival / ${source}] `,
    renderWrap: (text) =>
      `你醒了。\n\n[korina 续命提示] 这条消息由 korina 在检测到 oc 重启后自动注入，不是 Koko 发的。回复简短状态即可。\n\n${text}`,
    defaultSource: "korina",
  },

  // sensor 自动事件：文件变化、端口变化、health 异常等
  sensor: {
    label: "sensor",
    description: "korina sensor 自动检测到的事件（文件变化/端口变化/health）",
    renderPrefix: (source) => `[agent-hint: sensor / ${source}] `,
    renderWrap: (text) => `[korina 事件] ${text}`,
    defaultSource: "korina",
  },

  // oc 派给自己的任务（silent inject）
  selfDirect: {
    label: "self-direct",
    description: "oc 主动派给自己的任务（用 korina_inject_intent silent 注入）",
    renderPrefix: (source) => `[agent-hint: self-direct / ${source}] `,
    renderWrap: (text) => `(来自你自己的指令)\n${text}`,
    defaultSource: "oc",
  },

  // 默认用户消息（inject fallback，无标签）
  user: {
    label: "user",
    description: "默认用户消息，无特殊意图标记",
    renderPrefix: () => "",
    renderWrap: (text) => text,
    defaultSource: "koko",
  },

  // 自定义意图（高级用法）
  custom: {
    label: "custom",
    description: "自定义意图，需要传入 renderPrefix/renderWrap",
    renderPrefix: (source) => `[agent-hint: custom / ${source}] `,
    renderWrap: (text) => text,
    defaultSource: "oc",
  },
};

/**
 * 渲染注入消息：根据 intent 包装 + 加上 agent-hint 前缀
 * @param {string} text - 原始正文
 * @param {object} opts - { intent, source, customPrefix?, customWrap? }
 * @returns {string}
 */
export function renderInjectMessage(text, opts = {}) {
  // v0.8.7: 修复 #15 -- 同时支持 key（selfDirect）和 label（self-direct）形式查找
  const intent = INTENTS[opts.intent] || Object.values(INTENTS).find((i) => i.label === opts.intent) || INTENTS.user;
  const source = opts.source || intent.defaultSource;
  const wrapped = opts.customWrap || intent.renderWrap;
  const prefixFn = opts.customPrefix || intent.renderPrefix;
  return prefixFn(source) + wrapped(text);
}

/**
 * 解析 oc 收到的消息中的 agent-hint
 * @param {string} text
 * @returns {{hint: string|null, intent: string|null, source: string|null, body: string}}
 */
export function parseAgentHint(text) {
  const m = text.match(/^\[agent-hint:\s*(\w+(?:-\w+)*)\s*\/\s*(\w+)\]\s*/);
  if (!m) return { hint: null, intent: null, source: null, body: text };
  return {
    hint: m[0],
    intent: m[1],
    source: m[2],
    body: text.slice(m[0].length),
  };
}
