/**
 * src/inject-intent.mjs
 *
 * 注入意图系统 -- 替代硬编码的 [furina] 标签
 *
 * 设计目标：
 * 1. furina 注入内容时，附带结构化元数据（intent + source）
 * 2. oc 收到消息时，能从 agent-hint 中识别这是 furina 注入的、什么意图
 * 3. oc 自身能用 mcp 工具自由控制注入（不限于 furina 触发的场景）
 * 4. silent 模式：纯通知，不进 dispatch 队列，不写记忆
 *
 * 注入到 oc 的消息格式：
 *   [agent-hint: <intent> / <source>] <正文>
 * agent-hint 短小稳定，oc 容易解析；正文按 intent 决定是否包装
 */

export const INTENTS = {
  // 续命：oc 刚启动，furina 主动告知"你醒了"
  survival: {
    label: "survival",
    description: "oc 重启/续命场景：furina 拉起新 oc 后注入'你醒了'",
    renderPrefix: (source) => `[agent-hint: survival / ${source}] `,
    renderWrap: (text) => `你醒了。\n\n[furina 续命提示] 这条消息由 furina 在检测到 oc 重启后自动注入，不是 Koko 发的。回复简短状态即可。\n\n${text}`,
    defaultSource: "furina",
  },

  // 自动恢复上下文：oc 调用 recall 后，furina 把历史摘要回灌
  autoRecall: {
    label: "auto-recall",
    description: "oc 请求 recall 后，furina 把记忆回灌到当前对话",
    renderPrefix: (source) => `[agent-hint: auto-recall / ${source}] `,
    renderWrap: (text) => `[furina 自动上下文恢复]\n${text}\n[/furina]`,
    defaultSource: "furina",
  },

  // oc 派给自己的任务：oc 用 mcp 工具主动发给自己
  selfDirect: {
    label: "self-direct",
    description: "oc 主动派给自己的任务（用 mcp furina_inject 发起）",
    renderPrefix: (source) => `[agent-hint: self-direct / ${source}] `,
    renderWrap: (text) => `(来自你自己的指令)\n${text}`,
    defaultSource: "oc",
  },

  // Koko 注入的消息（furina 透传，无标签）
  koko: {
    label: "koko",
    description: "Koko 通过控制通道或 mcp 注入的纯消息",
    renderPrefix: () => "",
    renderWrap: (text) => text,
    defaultSource: "koko",
  },

  // 用户消息（默认：纯正文，无 furina 标签）
  user: {
    label: "user",
    description: "默认用户消息，无特殊意图标记",
    renderPrefix: () => "",
    renderWrap: (text) => text,
    defaultSource: "koko",
  },

  // 系统通知：port 变化、health 异常等
  system: {
    label: "system",
    description: "系统级通知（oc 异常、port 变化、health alert）",
    renderPrefix: (source) => `[agent-hint: system / ${source}] `,
    renderWrap: (text) => `[furina 系统通知] ${text}`,
    defaultSource: "furina",
  },

  // 自定义意图（用户/插件自己注册）
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
  const intent = INTENTS[opts.intent] || INTENTS.user;
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
