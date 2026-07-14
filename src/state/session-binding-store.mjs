import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_LOCK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function normalizeSessionId(sessionId) {
  if (typeof sessionId !== "string") return null;
  const trimmed = sessionId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Single source of truth for lifeline/session binding state.
 *
 * Milestone 2 starts as a pure store: it mirrors the existing session.lock and
 * voice-input-target.json formats without taking over runtime ownership yet.
 * Later, Injector and voice-input will delegate to this store instead of
 * writing those files directly.
 *
 * v0.9.10 (L5.1 manual #34): session lock 文件按 port 命名（session.{port}.lock），
 * 多实例不互相覆盖。voice target 同样按 port 命名。
 * 向后兼容：显式传 options.sessionLockFile / options.voiceTargetFile 优先。
 */
export class SessionBindingStore {
  constructor(options = {}) {
    const projectRoot = options.projectRoot || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const logsDir = options.logsDir || join(projectRoot, "logs");
    this.port = options.port || 9999;

    // 向后兼容：显式传 file 优先（测试和老协议）
    this.sessionLockFile = options.sessionLockFile || join(logsDir, `session.${this.port}.lock`);
    this.voiceTargetFile = options.voiceTargetFile || join(logsDir, `voice-input-target.${this.port}.json`);
    this.maxLockAgeMs = options.maxLockAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;
    this.persist = options.persist !== false;
    this.now = options.now || (() => Date.now());

    this.primarySessionId = null;
    this.boundSessionIds = new Set();
  }

  load() {
    const primary = this.loadPrimarySessionId();
    if (primary) {
      this.primarySessionId = primary;
      this.boundSessionIds.add(primary);
    }
    return this.snapshot();
  }

  loadPrimarySessionId() {
    const data = readJson(this.sessionLockFile);
    const sessionId = normalizeSessionId(data?.sessionId);
    if (!sessionId) return null;

    const savedAt = Number(data.savedAt || 0);
    if (savedAt > 0 && this.now() - savedAt > this.maxLockAgeMs) {
      return null;
    }
    return sessionId;
  }

  getPrimarySessionId() {
    return this.primarySessionId;
  }

  setPrimarySessionId(sessionId, options = {}) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return { ok: false, error: "需要 sessionId" };

    this.primarySessionId = normalized;
    this.boundSessionIds.add(normalized);

    const savedAt = this.now();
    if (this.persist && options.persist !== false) {
      writeJson(this.sessionLockFile, {
        sessionId: normalized,
        savedAt,
        reason: options.reason || "setPrimarySessionId",
      });
    }

    return { ok: true, sessionId: normalized, savedAt };
  }

  bindSession(sessionId, options = {}) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return { ok: false, error: "需要 sessionId" };

    const wasNew = !this.boundSessionIds.has(normalized);
    this.boundSessionIds.add(normalized);
    if (options.makePrimary || !this.primarySessionId) {
      this.setPrimarySessionId(normalized, {
        persist: options.persist,
        reason: options.reason || "bindSession",
      });
    }

    return {
      ok: true,
      sessionId: normalized,
      isNew: wasNew,
      total: this.boundSessionIds.size,
      primarySessionId: this.primarySessionId,
    };
  }

  unbindSession(sessionId, options = {}) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return { ok: false, error: "需要 sessionId" };
    if (!this.boundSessionIds.has(normalized)) return { ok: false, error: `未绑定 ${normalized}` };

    this.boundSessionIds.delete(normalized);
    let newPrimary = this.primarySessionId;
    if (this.primarySessionId === normalized) {
      newPrimary = this.boundSessionIds.size ? Array.from(this.boundSessionIds)[0] : null;
      this.primarySessionId = newPrimary;
      if (this.persist && options.persist !== false) {
        if (newPrimary) {
          writeJson(this.sessionLockFile, {
            sessionId: newPrimary,
            savedAt: this.now(),
            reason: options.reason || "unbindSession.promoteNext",
          });
        } else if (existsSync(this.sessionLockFile)) {
          try { unlinkSync(this.sessionLockFile); } catch {}
        }
      }
    }

    return {
      ok: true,
      sessionId: normalized,
      total: this.boundSessionIds.size,
      primarySessionId: newPrimary,
    };
  }

  listBoundSessionIds() {
    return Array.from(this.boundSessionIds);
  }

  getVoiceTarget() {
    const data = readJson(this.voiceTargetFile);
    const sessionId = normalizeSessionId(data?.sessionId);
    if (!sessionId) return null;
    return {
      sessionId,
      title: data.title || sessionId.slice(0, 16),
      setAt: Number(data.setAt || 0),
    };
  }

  getVoiceTargetSessionId() {
    return this.getVoiceTarget()?.sessionId || null;
  }

  setVoiceTargetSessionId(sessionId, options = {}) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return { ok: false, error: "需要 sessionId" };

    const target = {
      sessionId: normalized,
      title: options.title || normalized.slice(0, 16),
      setAt: options.setAt || this.now(),
    };
    if (this.persist && options.persist !== false) {
      writeJson(this.voiceTargetFile, target);
    }
    return { ok: true, target };
  }

  clearVoiceTargetSessionId() {
    try {
      if (existsSync(this.voiceTargetFile)) unlinkSync(this.voiceTargetFile);
    } catch {}
    return { ok: true };
  }

  /**
   * Validate the persisted voice target against an external check (e.g. oc
   * session list). If the target is missing or no longer valid, clear it.
   * @param {(sessionId: string) => boolean} isValidSession
   * @returns {{ok: true, cleared: boolean, target: object | null}}
   */
  validateAndCleanVoiceTarget(isValidSession) {
    const target = this.getVoiceTarget();
    if (!target) return { ok: true, cleared: false, target: null };
    if (typeof isValidSession === "function" && !isValidSession(target.sessionId)) {
      this.clearVoiceTargetSessionId();
      console.log(`[session-store] 语音目标 ${target.sessionId} 在 oc 会话中不存在，已清除`);
      return { ok: true, cleared: true, target: null };
    }
    return { ok: true, cleared: false, target };
  }

  snapshot() {
    return {
      primarySessionId: this.primarySessionId,
      boundSessionIds: this.listBoundSessionIds(),
      voiceTarget: this.getVoiceTarget(),
    };
  }
}
