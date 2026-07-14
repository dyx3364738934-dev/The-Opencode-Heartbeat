/**
 * src/modules/heartbeat/koko-activity-templates.mjs
 *
 * v0.9.23: Koko 活跃状态描述池
 *
 * 设计：
 *   - 按时间档（刚活跃 / 最近 / 半天 / 离开 / 未知）分桶
 *   - 每档 10+ 条预设，随机匹配
 *   - 真实数据（idle 分钟数 + 前台窗口）填进模板
 *   - 避免单调"Koko X 分钟前活跃"反复出现（抗 DSA 衰减）
 *
 * 用法：
 *   import { pickActivityLine } from "./koko-activity-templates.mjs";
 *   const line = pickActivityLine({ idleMin, foreground, lastTemplateIdx });
 */

// 时间档 + 模板池
const BUCKETS = {
  justNow: [
    "Koko 刚刚发过消息",
    "Koko 此刻活跃",
    "Koko 还在 oc",
    "Koko 在线",
    "Koko 刚说话",
    "Koko 正在打字（maybe）",
    "Koko 没走",
    "Koko 这会儿在",
    "Koko 刚回过",
    "Koko 在线状态: 活跃",
    "Koko 还没离开",
    "Koko 几秒前刚动过",
  ],
  recent: [
    "Koko {min} 分钟前说过话",
    "Koko {min} 分钟前活跃过",
    "Koko 在线（{min} 分钟前刚动）",
    "Koko {min} 分钟没新消息了",
    "Koko 大约 {min} 分钟前还在线",
    "Koko {min} 分钟前刚离开 oc",
    "Koko {min} 分钟没回 oc 了",
    "Koko {min} 分钟前活跃，应该还在",
    "Koko 刚走开 {min} 分钟",
    "Koko {min} 分钟没说话了",
    "Koko 最近一次活跃: {min} 分钟前",
    "Koko {min} 分钟没发声",
  ],
  idle: [
    "Koko {min} 分钟没说话了",
    "Koko {min} 分钟没动静",
    "Koko 可能切去忙别的（{min} 分钟）",
    "Koko {min} 分钟前活跃过",
    "Koko 应该还在，{min} 分钟没回",
    "Koko {min} 分钟没动 oc",
    "Koko 离开 {min} 分钟了",
    "Koko {min} 分钟没发声",
    "Koko 上次说话: {min} 分钟前",
    "Koko 沉默 {min} 分钟",
    "Koko {min} 分钟没新输入",
    "Koko 暂时不在 oc（{min} 分钟）",
  ],
  away: [
    "Koko {hr} 小时没动了",
    "Koko 离开 {hr} 小时",
    "Koko {hr} 小时没回 oc",
    "Koko 应该去忙别的了（{hr} 小时）",
    "Koko {hr} 小时不在",
    "Koko 上次活跃: {hr} 小时前",
    "Koko 已经 {hr} 小时没说话",
    "Koko {hr} 小时没接触 oc",
    "Koko 沉寂 {hr} 小时",
    "Koko {hr} 小时没出现",
    "Koko 离开 oc 已经 {hr} 小时",
    "Koko {hr} 小时没输入消息",
  ],
  long: [
    "Koko {hr} 小时没动，应该不在",
    "Koko 离开 {hr} 小时了",
    "Koko 很久没来 oc（{hr} 小时）",
    "Koko {hr} 小时没回，多半不在",
    "Koko 已经离开 {hr} 小时",
    "Koko {hr} 小时没活跃",
    "Koko 沉寂 {hr} 小时（应该真的走了）",
    "Koko {hr} 小时没消息",
    "Koko {hr} 小时没接触 oc",
    "Koko {hr} 小时没出现，应该睡了/忙",
    "Koko 离开 {hr} 小时，下次回来再叫",
    "Koko {hr} 小时不在 oc",
  ],
  unknown: [
    "Koko 状态未知",
    "Koko 活跃时间没记录",
    "Koko 状态: 未知（korina 刚启动？）",
    "Koko 暂时无法判断在不在",
    "Koko 活跃时间未初始化",
    "（Koko 状态读不到）",
  ],
};

// 前台窗口推断补充（基于真实数据，叠加在时间档之后）
function foregroundHint(foreground) {
  if (!foreground) return "";
  if (/OpenCode|opencode/i.test(foreground)) return "，正在 oc 窗口";
  if (/chrome|edge|firefox|brave|browser/i.test(foreground)) return `,在看浏览器（${foreground.slice(0, 24)}）`;
  if (/code|vscode|visual studio/i.test(foreground)) return ",在写代码";
  if (/game|steam|epic|gog/i.test(foreground)) return `,在玩游戏（${foreground.slice(0, 20)}）`;
  if (/qq|wechat|微信|discord|telegram/i.test(foreground)) return ",在聊天";
  if (/bilibili|youtube|netflix|video|mpv|vlc/i.test(foreground)) return ",在看视频";
  if (/word|excel|powerpoint|pdf|onlyoc|wps/i.test(foreground)) return ",在看文档";
  if (foreground.trim()) return `,前台: ${foreground.slice(0, 24)}`;
  return "";
}

/**
 * 根据真实数据选一条描述
 * @param {object} opts - { idleMin: number (-1=未知), foreground?: string, avoidIdx?: number }
 * @returns {{ text: string, idx: number, bucket: string }}
 */
export function pickActivityLine({ idleMin, foreground = "", avoidIdx = -1 } = {}) {
  let bucket;
  let vars = {};
  if (idleMin < 0 || !isFinite(idleMin)) {
    bucket = "unknown";
  } else if (idleMin < 1) {
    bucket = "justNow";
  } else if (idleMin < 15) {
    bucket = "recent";
    vars = { min: idleMin };
  } else if (idleMin < 60) {
    bucket = "idle";
    vars = { min: idleMin };
  } else if (idleMin < 360) {
    bucket = "away";
    vars = { hr: Math.round(idleMin / 60 * 10) / 10 };
  } else {
    bucket = "long";
    vars = { hr: Math.round(idleMin / 60 * 10) / 10 };
  }

  const pool = BUCKETS[bucket];
  let idx = Math.floor(Math.random() * pool.length);
  // 避免重复（同桶内）
  if (pool.length > 1 && idx === avoidIdx) {
    idx = (idx + 1) % pool.length;
  }

  let text = pool[idx];
  // 填充变量
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }

  // 叠加前台窗口推断
  if (bucket !== "unknown" && bucket !== "long") {
    text += foregroundHint(foreground);
  }

  return { text, idx, bucket };
}
