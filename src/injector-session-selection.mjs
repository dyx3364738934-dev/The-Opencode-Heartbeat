/**
 * src/injector-session-selection.mjs
 *
 * v0.9.17 (manual #41 J 第三刀): 抽出 Session 选择策略 + oc session 列表 + lastAssistantTime
 *
 * 包含原 injector.mjs 的 5 个方法：
 *   - _selectTargetSession (manual #35 引入 — KORINA_BIND_SESSION 策略)
 *   - _fetchPeerSession (manual #35 引入 — peer-avoid-{port} 协调)
 *   - resolveSession (核心：拉 oc /session 列表 + 选 + 保存)
 *   - listOcSessionIds (校验 voice target / secondary 绑定)
 *   - _getLastAssistantTime (resolveSession 后置调用)
 *
 * 设计：纯函数模块（不依赖 Injector 实例 this.xxx）
 *   - 网络操作接受 base + headers 参数
 *   - session 选择策略纯逻辑（只依赖 sorted 数组）
 *   - 返回值由调用方更新 Injector 实例状态
 *
 * 公共 API 保持兼容：injector.mjs 委托这些函数，对外接口零变化。
 */

/**
 * 拉 peer korina 实例的 /status 拿占用 session ID（peer-avoid-{port} 策略用）
 * @param {object} opts
 * @param {number} opts.port
 * @param {number} [opts.timeoutMs=3000]
 * @returns {Promise<string|null>} peer 绑的 session ID，或 null（peer 不在跑 / 失败）
 */
export async function fetchPeerSession({ port, timeoutMs = 3000 }) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.session || null;
  } catch {
    return null;
  }
}

/**
 * v0.9.11 (manual #35): session 选择策略
 *
 * 通过环境变量 KORINA_BIND_SESSION 控制（按优先级匹配）：
 *   1. 直接指定 session ID（"ses_xxx"）—— 找到就绑那个
 *   2. 策略关键字：
 *      - "second-newest" → 拿 sorted[1]（避开最新）
 *      - "oldest" → 拿 sorted[N-1]（最老）
 *      - "random" → 随机一个
 *   3. peer-avoid-{port}：fetch 该 port 的 korina /status，避开它绑的 session
 *   4. 不设 env / 无法识别 → 拿 sorted[0]（最新，向后兼容）
 *
 * @param {object} opts
 * @param {object[]} opts.sorted - 按 time.updated 倒序的 session 数组
 * @param {string} [opts.env=KORINA_BIND_SESSION] - 环境变量（默认读 process.env）
 * @param {function} [opts.fetchPeer] - peer session 拉取函数（默认 fetchPeerSession）
 * @returns {Promise<object>} 选中的 session 对象（sorted 中的一项）
 */
export async function selectTargetSession({ sorted, env = process.env.KORINA_BIND_SESSION, fetchPeer = fetchPeerSession }) {
  if (!env) return sorted[0];

  // 1. 直接 session ID
  const direct = sorted.find((s) => s.id === env);
  if (direct) {
    console.log(`[injector] KORINA_BIND_SESSION=${env} 命中直接 ID: ${env}`);
    return direct;
  }

  // 2. 策略关键字
  if (env === "second-newest") {
    return sorted[1] || sorted[0];
  }
  if (env === "oldest") {
    return sorted[sorted.length - 1];
  }
  if (env === "random") {
    return sorted[Math.floor(Math.random() * sorted.length)];
  }

  // 3. peer-avoid-{port}
  const peerMatch = env.match(/^peer-avoid-(\d+)$/);
  if (peerMatch) {
    const peerPort = parseInt(peerMatch[1], 10);
    const peerSession = await fetchPeer({ port: peerPort });
    if (peerSession) {
      const filtered = sorted.filter((s) => s.id !== peerSession);
      if (filtered.length > 0) {
        console.log(`[injector] peer-avoid-${peerPort} 避开 ${peerSession}，剩余 ${filtered.length} 个 session，绑 ${filtered[0].id}`);
        return filtered[0];
      }
      console.warn(`[injector] peer-avoid-${peerPort} 所有 session 都被占（peer=${peerSession}），回落拿最新`);
    } else {
      console.log(`[injector] peer-avoid-${peerPort} 拿不到 peer /status（peer 不在跑？），回落拿最新`);
    }
  }

  console.warn(`[injector] KORINA_BIND_SESSION=${env} 无法识别，回落拿最新`);
  return sorted[0];
}

/**
 * 列出 oc 当前所有 session id（用于校验 voice target / secondary 绑定）
 * @param {object} opts
 * @param {string} opts.base - oc base URL
 * @param {object} opts.headers - oc auth headers
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<string[]>} sessionId 列表（任意错误返回空数组）
 */
export async function listOcSessionIds({ base, headers, timeoutMs = 5000 }) {
  try {
    const r = await fetch(`${base}/session`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return [];
    const list = await r.json();
    if (!Array.isArray(list)) return [];
    return list.map((s) => s.id).filter((id) => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * 拉 oc 当前所有 session 并按 time.updated 倒序
 * @param {object} opts
 * @param {string} opts.base
 * @param {object} opts.headers
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<object[]>} sorted session 数组
 */
export async function fetchOcSessionsSorted({ base, headers, timeoutMs = 8000 }) {
  const r = await fetch(`${base}/session`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`GET /session HTTP ${r.status}`);
  const sessions = await r.json();
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error("oc 无可用 session");
  }
  const sorted = sessions
    .filter((s) => s.time?.updated)
    .sort((a, b) => (b.time.updated || 0) - (a.time.updated || 0));
  if (sorted.length === 0) {
    throw new Error("所有 session 无 updated 时间戳");
  }
  return sorted;
}

/**
 * 拿指定 session 的最近 assistant 消息 created 时间戳
 * @param {object} opts
 * @param {string} opts.base
 * @param {object} opts.headers
 * @param {string} opts.sid - session ID
 * @param {number} [opts.limit=5]
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<number>} created ms timestamp（0 = 失败/无消息）
 */
export async function getLastAssistantTime({ base, headers, sid, limit = 5, timeoutMs = 5000 }) {
  if (!sid) return 0;
  try {
    const r = await fetch(`${base}/session/${sid}/message?limit=${limit}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return 0;
    const msgs = await r.json();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info?.role === "assistant") {
        return msgs[i].info?.time?.created || 0;
      }
    }
  } catch {}
  return 0;
}