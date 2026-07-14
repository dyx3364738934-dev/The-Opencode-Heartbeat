/**
 * core/injector-http-ops.mjs
 *
 * v0.9.19 (J 第四刀 manual #44): HTTP 注入 + 轮询 + 健康监控 + 压缩/计数 抽模块
 *
 * 把 injector.mjs 里的 HTTP 操作簇抽到独立纯函数模块：
 *   - inject() / silentInject() / injectAndWait() — 注入链路核心
 *   - _poll() — 动态活动检测（替代固定超时）
 *   - startHealthMonitor() / stopHealthMonitor() — oc 健康监控
 *   - _refreshPasswordFromFile() — 密码文件状态
 *   - summarize() / getMessageCount() — oc 上下文压缩 + 消息计数
 *
 * 设计原则（与前三刀一致）：
 *   - 纯函数，接收 deps 对象（不依赖 this.xxx）
 *   - 实例状态更新通过回调（onKokoActive / onOCRestarted / onServerConfigChanged / onLastInjected）由调用方负责
 *   - 测试时可注入 mock deps 替代真网络
 *
 * 对外公共 API（injector.mjs 委托后外部零改动）：
 *   - inj.inject(text, opts)
 *   - inj.silentInject(text, opts)
 *   - inj.injectAndWait(text, onProgress, opts)
 *   - inj.startHealthMonitor(intervalMs)
 *   - inj.stopHealthMonitor()
 *   - inj.summarize()
 *   - inj.getMessageCount()
 *   - inj._refreshPasswordFromFile()（内部用，公开为测试方便）
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 注入一条消息到 oc session（异步，立即返回）
 *
 * @param {string} text - 要注入的正文
 * @param {object} opts - { intent?, source?, customPrefix?, customWrap?, skipLog?, sessionId? }
 * @param {object} ctx - { base, headers, sid, render, onKokoActive? }
 *   - base/headers/sid: 由调用方 discover() + resolveSession() 提供
 *   - render(text, opts) => string: 渲染消息（按 intent 包装 + agent-hint 前缀）
 *   - onKokoActive(ts): source=koko 时回调（持久化 lastKokoTime）
 * @returns {Promise<boolean>}
 */
export async function inject(text, opts, ctx) {
  const { base, headers, sid, render, onKokoActive } = ctx;

  // v0.5: 渲染消息（按 intent 包装 + agent-hint 前缀）
  const rendered = render(text, opts);
  const body = JSON.stringify({ parts: [{ type: "text", text: rendered }] });

  if (!opts.skipLog) {
    const intent = opts.intent || "user";
    const source = opts.source || "unknown";
    console.log(`[injector] inject intent=${intent} source=${source} textLen=${rendered.length}`);
  }

  // v0.2.1: oc backlog 时 prompt_async 响应可能超过 10s，延长到 30s
  const r = await fetch(`${base}/session/${sid}/prompt_async`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (r.status !== 204 && !r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`prompt_async HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  // v0.9.5: 追踪 Koko 真实活跃时间（区分于 assistant 上次 reply）
  // voice-input STT 转发时会标 source=koko，文本输入等其他源不更新
  if (opts.source === "koko" && onKokoActive) {
    onKokoActive(Date.now());
  }
  return true;
}

/**
 * 静默注入（不写记忆、不等回复）—— 重试 2 次（避免瞬时网络抖动）
 *
 * v0.5.2: 不重置 serverConfig（避免触发 health monitor 的 onOCRestarted 误判）
 *
 * @param {string} text
 * @param {object} opts
 * @param {object} ctx - 同 inject
 * @returns {Promise<boolean>}
 */
export async function silentInject(text, opts, ctx) {
  const MAX_RETRY = 2;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      // silentInject 强制 skipLog: false（始终打日志）—— 区别于 inject 的"opts.skipLog 默认 false 但 silentInject 不允许跳过"
      return await inject(text, { ...opts, skipLog: false }, ctx);
    } catch (e) {
      const isLast = attempt === MAX_RETRY;
      console.error(`[injector] silentInject 失败 (第 ${attempt + 1}/${MAX_RETRY + 1} 次): ${e.message?.slice(0, 100)}`);
      if (isLast) return false;
      // 只 sleep 重试，不重置 serverConfig（让 health monitor 自己处理）
      await sleep(1500);
    }
  }
  return false;
}

/**
 * 注入并等待回复（v0.2.1: inject 失败不阻塞，fire-and-forget 模式）
 *
 * 流程：
 *   1. fire-and-forget 调 prompt_async（不等返回，避免 oc backlog 阻塞）
 *   2. 立即进入 _poll 等 oc 处理
 *
 * 即使 inject 因为 oc backlog 30s+ 超时，消息可能已被 oc 内部接受
 * （oc prompt_async 在 backlog 时会排队），_poll 仍能找到对应回复
 *
 * @param {string} text
 * @param {function} onProgress - ({ state, textLen, elapsed }) => void
 * @param {object} opts
 * @param {object} ctx - { base, headers, sid, beforeTime, render, onKokoActive, onLastInjected, pollIntervalMs, pollTimeoutMs }
 *   - onLastInjected(sid, record): 记录 last injected（per-session）
 * @returns {Promise<{text, reasoning, state, created, parts}>}
 */
export async function injectAndWait(text, onProgress, opts, ctx) {
  const { base, headers, sid, beforeTime, render, onKokoActive, onLastInjected, pollIntervalMs, pollTimeoutMs } = ctx;
  const sidForRecord = opts.sessionId || sid;
  if (onLastInjected) onLastInjected(sidForRecord, { text, opts, ts: Date.now() });
  console.log(`[injector] injectAndWait 开始, intent=${opts.intent || "user"}, text len=${text.length}`);
  // v0.2.1: fire-and-forget inject，30s 后还没返回就放弃 await，但继续 _poll
  let injectSubmitted = false;
  try {
    await Promise.race([
      inject(text, opts, { base, headers, sid, render, onKokoActive }).then(() => { injectSubmitted = true; }),
      sleep(30000).then(() => { throw new Error("inject race timeout 30s"); }),
    ]);
    console.log(`[injector] inject OK, 进入 _poll`);
  } catch (e) {
    console.error(`[injector] inject 超时/失败但继续 _poll (submitted=${injectSubmitted}): ${e.message?.slice(0, 200)}`);
    // 不 throw，继续 _poll（消息可能已被 oc 接受或在内部排队）
  }

  try {
    const reply = await poll(beforeTime, onProgress, sid, { base, headers, pollIntervalMs, pollTimeoutMs, lastInjected: ctx.lastInjected, injectFn: ctx.injectFn });
    console.log(`[injector] _poll 返回 state=${reply.state} text_len=${reply.text?.length || 0}`);
    return reply;
  } catch (e) {
    console.error(`[injector] _poll 抛错: ${e.message?.slice(0, 200)}`);
    throw e;
  }
}

/**
 * v0.4: 动态活动检测 _poll（替代固定软超时）
 *
 * 核心逻辑：
 *   - 内容长度在涨 = oc 活着，继续等（无上限）
 *   - 8 分钟无内容变化 = 发 ping 戳一下（原 3 分钟太激进，oc 执行 tool 时误打断）
 *   - 2 次 ping 后仍无变化 = 判定卡死
 *   - fetch 连续失败 30s = 判定 oc 死了
 *   - 60s 无新消息 = 重新 inject（可能 inject 丢了）
 *
 * state 探测日志：每次 poll 打 state+textLen+reasoningLen+contentLen+created
 * Koko 压缩上下文时可以观察 state 字段变化
 *
 * @param {number} sinceCreated - inject 前的 lastAssistantTime（用于判断新消息）
 * @param {function} onProgress - ({ state, textLen, elapsed }) => void
 * @param {string} sessionId - 要 poll 的 session
 * @param {object} ctx - { base, headers, pollIntervalMs, pollTimeoutMs, lastInjected, injectFn, fetchFailThresholdMs? }
 *   - lastInjected: Map<sid, {text, opts}>（用于 re-inject 拿原文）
 *   - injectFn(text, opts): 重新注入（不传 sid，让 _poll 内部加）
 *   - fetchFailThresholdMs?: 默认 30000（生产值），测试时可注入更短值
 * @returns {Promise<{text, reasoning, state, created, parts}>}
 */
export async function poll(sinceCreated, onProgress, sessionId, ctx) {
  const { base, headers, pollIntervalMs, pollTimeoutMs, lastInjected, injectFn } = ctx;
  const sid = sessionId;
  const start = Date.now();

  // v0.8.7: 全局超时追踪变量（C1 修复：pollTimeoutMs 现在真正生效）
  let _lastSeenText = "";
  let _lastSeenParts = [];
  let _lastSeenCreated = 0;
  let _reinjectCooldown = 0; // v0.8.7: re-inject 冷却期（防止反复注入）

  // 动态活动检测参数
  const PING_THRESHOLD_MS = 8 * 60 * 1000;     // 8 分钟无活动 -> ping
  const MAX_PINGS = 2;                           // ping 2 次还不动 -> 判定卡死
  const FETCH_FAIL_THRESHOLD_MS = ctx.fetchFailThresholdMs ?? 30 * 1000;    // fetch 连续失败 -> oc 死
  const NO_MSG_REINJECT_MS = 60 * 1000;         // 60s 无新消息 -> 重新 inject
  const FETCH_TIMEOUT_MS = 15000;                // 单次 fetch 超时

  let lastContentLen = 0;
  let lastChangeTime = Date.now();
  let pingCount = 0;
  let fetchFailStart = 0;
  let noMsgStart = 0;
  let stableCount = 0;
  let lastCreated = 0;   // v0.7.10.3: 追踪 message created（新消息=活动）
  let lastPartsLen = 0;  // v0.7.10.3: 追踪 parts 数量（tool call 增长=活动）
  let lastContentLenLog = -1; // v0.8.6: 日志降频 -- 上次打日志的 contentLen
  let lastStateLog = "";      // v0.8.6: 日志降频 -- 上次打日志的 state
  const STABLE_THRESHOLD = 5; // 内容连续 5 次 poll（约 10s）不变 = 视为完成

  while (true) {
    await sleep(pollIntervalMs);
    const elapsed = Date.now() - start;

    // v0.8.7: C1 修复 -- 全局超时保护（防止 contentLen 微小增长导致无限 poll）
    if (elapsed > pollTimeoutMs) {
      console.warn(`[poll] 全局超时 ${Math.round(pollTimeoutMs / 1000)}s，强制结束 (lastText=${_lastSeenText.length}字)`);
      return { text: _lastSeenText, reasoning: "", state: "global_timeout", created: _lastSeenCreated, parts: _lastSeenParts };
    }

    // === fetch oc message ===
    let r;
    try {
      r = await fetch(`${base}/session/${sid}/message?limit=3`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      fetchFailStart = 0;
    } catch (e) {
      if (!fetchFailStart) fetchFailStart = Date.now();
      const failDur = Date.now() - fetchFailStart;
      console.warn(`[poll] fetch 失败 ${Math.round(failDur / 1000)}s: ${e.message?.slice(0, 80)}`);
      if (failDur > FETCH_FAIL_THRESHOLD_MS) {
        return { text: `[oc fetch 连续失败 ${Math.round(failDur / 1000)}s，判定死亡]`, reasoning: "", state: "fetch_dead", created: Date.now(), parts: [] };
      }
      continue;
    }

    if (!r.ok) {
      if (!fetchFailStart) fetchFailStart = Date.now();
      const failDur = Date.now() - fetchFailStart;
      if (failDur > FETCH_FAIL_THRESHOLD_MS) {
        return { text: `[oc HTTP ${r.status} 连续 ${Math.round(failDur / 1000)}s]`, reasoning: "", state: "http_error", created: Date.now(), parts: [] };
      }
      continue;
    }

    const msgs = await r.json().catch(() => []);
    if (!Array.isArray(msgs) || !msgs.length) continue;

    // 找最新 assistant message
    let latest = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info?.role === "assistant") { latest = msgs[i]; break; }
    }
    if (!latest) continue;

    const created = latest.info?.time?.created || 0;
    const state = latest.info?.state || "";
    const text = (latest.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
    const reasoning = (latest.parts || []).filter((p) => p.type === "reasoning" || p.type === "thinking").map((p) => p.text).join("");
    const contentLen = text.length + reasoning.length;

    // v0.8.7: 追踪最后见到的数据（全局超时返回用）
    _lastSeenText = text;
    _lastSeenParts = latest.parts || [];
    _lastSeenCreated = created;

    // v0.8.6: state 探测日志降频（避免 heartbeat 期间刷屏）
    // 每 10 秒打一次 + contentLen 变化时立即打 + 状态变化时打
    const elapsedSec = Math.round(elapsed / 1000);
    const shouldLog =
      elapsedSec % 10 === 0 ||                              // 每 10 秒
      contentLen !== lastContentLenLog ||                  // 内容长度变化
      state !== lastStateLog;                              // 状态变化
    if (shouldLog) {
      console.log(`[poll] elapsed=${elapsedSec}s state="${state}" textLen=${text.length} reasoningLen=${reasoning.length} contentLen=${contentLen} created=${created}`);
      lastContentLenLog = contentLen;
      lastStateLog = state;
    }

    // 无新消息？（created <= sinceCreated 说明 inject 的消息还没被 oc 处理成 assistant 回复）
    if (created <= sinceCreated) {
      if (!noMsgStart) noMsgStart = Date.now();
      const noMsgDur = Date.now() - noMsgStart;
      if (noMsgDur > NO_MSG_REINJECT_MS) {
        // v0.8.7: re-inject 冷却期（120s 内不重复 re-inject）
        if (Date.now() - _reinjectCooldown < 120000) {
          // 冷却期内，跳过 re-inject
        } else {
          console.warn(`[poll] ${Math.round(noMsgDur / 1000)}s 无新消息，重新 inject`);
          _reinjectCooldown = Date.now();
          try {
            // v0.8.7: 用 per-session 记录（修复 H11：跨 session 共享竞态）
            const record = lastInjected?.get(sid) || { text: "[korina] 确认状态", opts: {} };
            if (injectFn) {
              await injectFn(record.text, { ...record.opts, sessionId: sid, skipLog: true });
            }
          } catch (e) {
            console.warn(`[poll] 重新 inject 失败: ${e.message?.slice(0, 80)}`);
          }
        }
        noMsgStart = 0;
      }
      continue;
    }
    noMsgStart = 0;

    // v0.7.10.3: 活动检测 —— contentLen 增长 OR parts 增长 OR 新 message(created) 都算"活着"
    // 修复 Bug2: 原来只看 contentLen 增长，oc 执行 tool（onlyoc 等）时产生 tool-only message
    //           contentLen 不增长被误判卡住 -> 3分钟 ping 打断正常工作
    const partsLen = (latest.parts || []).length;
    const alive = created > lastCreated || partsLen > lastPartsLen || contentLen > lastContentLen;

    if (alive) {
      const why = created > lastCreated ? "新消息" : partsLen > lastPartsLen ? "parts增长" : "内容增长";
      console.log(`[poll] 活动（${why}）content=${contentLen} parts=${partsLen}，oc 活着`);
      lastCreated = created;
      lastPartsLen = partsLen;
      lastContentLen = contentLen;
      lastChangeTime = Date.now();
      pingCount = 0;
      stableCount = 0;
    } else if (contentLen > 0) {
      // 有 text/reasoning 但完全无活动 -> 累计稳定计数（判定完成）
      stableCount++;
      console.log(`[poll] 无活动 ${stableCount}/${STABLE_THRESHOLD} (content=${contentLen})`);
      if (stableCount >= STABLE_THRESHOLD) {
        console.log(`[poll] 连续 ${STABLE_THRESHOLD} 次无活动，视为完成`);
        return { text, reasoning, state: state || "stable", created, parts: latest.parts };
      }
    }
    // contentLen == 0 且无活动（纯 tool 执行中 parts 静止）：不累计 stableCount，继续等

    if (onProgress) onProgress({ state, textLen: text.length, elapsed });

    // state 完成 -> 返回
    const stateDone = state === "completed" || state === "error" || state === "aborted";
    if (stateDone) {
      return { text, reasoning, state, created, parts: latest.parts };
    }

    // 内容无变化超时 -> ping 戳一下
    const staleTime = Date.now() - lastChangeTime;
    if (staleTime > PING_THRESHOLD_MS) {
      if (pingCount < MAX_PINGS) {
        pingCount++;
        console.warn(`[poll] ${Math.round(staleTime / 1000)}s 无内容变化，第 ${pingCount} 次 ping`);
        const pingText = `[heartbeat] ${Math.round(staleTime / 1000)}s 没看到新输出。如果正在思考/执行请忽略这条；如果卡住了请回个话。`;
        const body = JSON.stringify({ parts: [{ type: "text", text: pingText }] });
        // fire-and-forget ping（不嵌套 poll）
        fetch(`${base}/session/${sid}/prompt_async`, { method: "POST", headers, body, signal: AbortSignal.timeout(30000) }).catch(() => {});
        lastChangeTime = Date.now(); // 重置，给 oc 时间响应 ping
      } else {
        return { text: `[oc ${MAX_PINGS} 次 ping 后仍无响应，判定卡死]`, reasoning: "", state: "stale_dead", created: Date.now(), parts: [] };
      }
    }
  }
}

/**
 * v0.4: health check loop
 * - oc 进程不在 -> spawnOC 主动拉起
 * - oc 在但 health 请求失败 -> 重置 serverConfig + 重读密码
 * - oc 在且 health OK -> 正常
 *
 * @param {number} intervalMs
 * @param {object} ctx - { isOCRunningAsync, waitForPassword, findPortsByProcess, spawnOC, refreshPassword, getServerConfig, setServerConfig, onOCRestarted, getLastKnownPort, setLastKnownPort, log? }
 * @returns {{ stop: () => void, timer: object }}
 */
export function startHealthMonitor(intervalMs, ctx) {
  if (ctx._healthTimer) return { stop: () => {}, timer: ctx._healthTimer }; // 已启动
  let _spawnCooldown = 0; // 防止反复 spawn
  let _rediscoverInProgress = false; // 防止并发 discover
  const tick = async () => {
    // v0.4: 先检测 oc 进程是否在线（异步，不阻塞事件循环）
    // 重试 2 次避免 execFile 偶尔失败导致误判
    let ocOnline = false;
    for (let i = 0; i < 2; i++) {
      if (await ctx.isOCRunningAsync()) { ocOnline = true; break; }
      if (i === 0) await sleep(500);
    }
    if (!ocOnline) {
      const now = Date.now();
      if (now - _spawnCooldown < 60000) return; // 1 分钟内不重复 spawn
      _spawnCooldown = now;
      console.warn("[injector] health: oc 进程不在线（2 次确认），主动拉起");
      ctx.setServerConfig(null);
      ctx.spawnOC();
      return;
    }
    // oc 进程在，检测 serverConfig 是否有效
    const serverConfig = ctx.getServerConfig();
    if (!serverConfig) {
      // serverConfig 被重置后，主动重新匹配密码+端口
      if (_rediscoverInProgress) return;
      _rediscoverInProgress = true;
      try {
        console.log("[injector] health: serverConfig 为空，主动重新匹配...");
        const newCfg = await ctx.waitForPassword(15000);
        console.log("[injector] health: 重新匹配成功");
        const newPort = newCfg?.port;
        // v0.8.1: 首次匹配（_lastKnownPort=null）不触发续命（正常启动，不是 oc 重启）
        // 只有"已知端口 -> 不同端口"才算 oc 重启
        const lastKnownPort = ctx.getLastKnownPort();
        if (newPort && lastKnownPort && newPort !== lastKnownPort) {
          console.log(`[injector] health: 端口变化 ${lastKnownPort} -> ${newPort}，触发 onOCRestarted`);
          if (ctx.onOCRestarted) ctx.onOCRestarted(newPort);
        }
        ctx.setLastKnownPort(newPort); // 同步更新
      } catch (e) {
        console.warn(`[injector] health: 重新匹配失败: ${e.message?.slice(0, 80)}`);
      } finally {
        _rediscoverInProgress = false;
      }
      return;
    }
    // serverConfig 存在，用端口探测检测 oc 是否还在（不 fetch，避免连接池耗尽）
    // 重试 2 次避免 execFile 偶尔失败
    let currentPorts = [];
    for (let i = 0; i < 2; i++) {
      currentPorts = await ctx.findPortsByProcess("OpenCode.exe");
      if (currentPorts.length > 0) break;
      if (i === 0) await sleep(500);
    }
    if (currentPorts.length === 0) {
      // 2 次都无端口，oc 确实没了
      console.warn("[injector] health: 端口探测 2 次无结果，oc 已退出，主动拉起");
      ctx.setServerConfig(null);
      const now = Date.now();
      if (now - _spawnCooldown < 60000) return;
      _spawnCooldown = now;
      ctx.spawnOC();
      return;
    }
    const currentPort = currentPorts[currentPorts.length - 1];
    if (currentPort !== serverConfig.port) {
      // 端口变了，重新匹配
      console.warn(`[injector] health: 端口变化 ${serverConfig.port} -> ${currentPort}，重新匹配`);
      ctx.setServerConfig(null);
      ctx.refreshPassword();
    }
    // 端口没变，serverConfig 仍然有效，不 fetch
  };
  const timer = setInterval(tick, intervalMs);
  console.log(`[injector] health check loop 已启动 (interval=${intervalMs}ms)`);
  return {
    stop: () => { if (timer) clearInterval(timer); },
    timer,
  };
}

/**
 * v0.3.1: 从 oc-password.txt 读最新密码，覆盖 process.env
 * 让后续 discover 用最新密码
 */
export function refreshPasswordFromFile({ logsDir }) {
  // v0.4: 此函数仅用于日志记录密码文件状态
  // discover/waitForPassword 直接读文件，不依赖 process.env
  try {
    const pwdFile = join(logsDir, "oc-password.txt");
    if (existsSync(pwdFile)) {
      const data = JSON.parse(readFileSync(pwdFile, "utf-8"));
      if (data.password) {
        console.log(`[injector] 密码文件可用 (age=${Math.round((Date.now() - (data.leakedAt || 0)) / 1000)}s)`);
      }
    }
  } catch (e) {
    console.warn(`[injector] 读密码文件失败: ${e.message?.slice(0, 100)}`);
  }
}

/**
 * 触发上下文压缩
 */
export async function summarize({ base, headers, sid }) {
  const r = await fetch(`${base}/session/${sid}/summarize`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30000),
  });
  return r.ok;
}

/**
 * 获取 session 消息数量（用于记忆区判断上下文长度）
 */
export async function getMessageCount({ base, headers, sid }) {
  try {
    const r = await fetch(`${base}/session/${sid}/message?limit=1`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return 0;
    const msgs = await r.json();
    return Array.isArray(msgs) ? msgs.length : 0;
  } catch {
    return 0;
  }
}
