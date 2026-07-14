/**
 * src/injector-session.mjs
 *
 * v0.9.16 (manual #40 J 第二刀): 抽出 Session 绑定管理 逻辑
 *
 * 包含原 injector.mjs 的 5 个方法：
 *   - saveSession
 *   - loadSession
 *   - bindSession
 *   - unbindSession
 *   - listBoundSessions
 *
 * 设计：纯函数模块（不依赖 Injector 实例 this.xxx）
 *   - 每个函数接收 bindingStore + 必要参数
 *   - 返回值由调用方更新 Injector 实例状态（sessionId / sessions）
 *   - 没有 this.xxx 依赖 → 易测、易维护
 *
 * 公共 API 保持兼容：injector.mjs 委托这些函数，对外接口零变化。
 */

/**
 * 持久化 session 锁定到 logs/session.{port}.lock
 * @param {object} opts
 * @param {object} opts.bindingStore - SessionBindingStore 实例
 * @param {boolean} opts.persistSession - 是否持久化（false 时不写文件）
 * @param {string} opts.sid - session ID
 * @returns {boolean} true 写成功，false 未启用持久化或写入失败
 */
export function saveSession({ bindingStore, persistSession, sid }) {
  if (!persistSession) return false;
  const result = bindingStore.setPrimarySessionId(sid, { reason: "injector.saveSession" });
  if (!result.ok) {
    console.warn(`[session-mgr] 保存 session.lock 失败: ${result.error}`);
    return false;
  }
  return true;
}

/**
 * 从 logs/session.{port}.lock 恢复 session 锁定
 * @param {object} opts
 * @param {object} opts.bindingStore
 * @param {boolean} opts.persistSession
 * @returns {string|null} sessionId 或 null（lock 不存在/无效/未启用持久化）
 */
export function loadSession({ bindingStore, persistSession }) {
  if (!persistSession) return null;
  const sid = bindingStore.loadPrimarySessionId();
  if (!sid) return null;
  bindingStore.bindSession(sid, { makePrimary: true, persist: false, reason: "injector.loadSession" });
  return sid;
}

/**
 * 绑定一个 session（v0.8: 可多个并行）
 * @param {object} opts
 * @param {object} opts.bindingStore
 * @param {string} opts.sid
 * @returns {{ok: boolean, isNew?: boolean, error?: string}}
 */
export function bindSession({ bindingStore, sid }) {
  return bindingStore.bindSession(sid, { reason: "injector.bindSession" });
}

/**
 * 解绑一个 session
 * @param {object} opts
 * @param {object} opts.bindingStore
 * @param {string} opts.sid
 * @returns {{ok: boolean, error?: string, promotedSessionId?: string}}
 */
export function unbindSession({ bindingStore, sid }) {
  return bindingStore.unbindSession(sid, { reason: "injector.unbindSession" });
}

/**
 * 列所有绑定的 session ID
 * @param {object} opts
 * @param {object} opts.bindingStore
 * @returns {string[]}
 */
export function listBoundSessions({ bindingStore }) {
  return bindingStore.listBoundSessionIds();
}