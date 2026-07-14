import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SessionBindingStore } from "../src/state/session-binding-store.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

const root = mkdtempSync(join(tmpdir(), "korina-session-store-"));
const logsDir = join(root, "logs");
const now = 1_800_000_000_000;

try {
  console.log("=== korina SessionBindingStore test ===");

  const store = new SessionBindingStore({ logsDir, now: () => now });
  let result = store.setPrimarySessionId(" ses_main ", { reason: "test" });
  assert.equal(result.ok, true);
  assert.equal(store.getPrimarySessionId(), "ses_main");
  assert.deepEqual(store.listBoundSessionIds(), ["ses_main"]);
  const lock = JSON.parse(readFileSync(join(logsDir, "session.9999.lock"), "utf-8"));
  assert.equal(lock.sessionId, "ses_main");
  assert.equal(lock.reason, "test");
  ok("setPrimarySessionId persists session.9999.lock and binds primary");

  result = store.bindSession("ses_extra");
  assert.equal(result.ok, true);
  assert.equal(result.isNew, true);
  assert.deepEqual(store.listBoundSessionIds(), ["ses_main", "ses_extra"]);
  ok("bindSession adds secondary session without changing primary");

  result = store.unbindSession("ses_main", { reason: "promote" });
  assert.equal(result.ok, true);
  assert.equal(store.getPrimarySessionId(), "ses_extra");
  const promoted = JSON.parse(readFileSync(join(logsDir, "session.9999.lock"), "utf-8"));
  assert.equal(promoted.sessionId, "ses_extra");
  assert.equal(promoted.reason, "promote");
  ok("unbindSession promotes next bound session and persists it");

  result = store.setVoiceTargetSessionId("ses_voice", { title: "Voice Target", setAt: now + 1 });
  assert.equal(result.ok, true);
  assert.equal(store.getVoiceTargetSessionId(), "ses_voice");
  assert.deepEqual(store.getVoiceTarget(), { sessionId: "ses_voice", title: "Voice Target", setAt: now + 1 });
  ok("voice target persists and reads existing voice-input-target format");

  result = store.clearVoiceTargetSessionId();
  assert.equal(result.ok, true);
  assert.equal(store.getVoiceTargetSessionId(), null);
  assert.equal(existsSync(join(logsDir, "voice-input-target.9999.json")), false);
  ok("clearVoiceTargetSessionId removes voice target file");

  const oldStore = new SessionBindingStore({ logsDir, now: () => now, maxLockAgeMs: 1000 });
  writeFileSync(join(logsDir, "session.9999.lock"), JSON.stringify({ sessionId: "ses_old", savedAt: now - 2000 }));
  assert.equal(oldStore.loadPrimarySessionId(), null);
  ok("expired session.9999.lock is ignored");

  // 重新写一份干净文件，避免前面测试留下的 voice-input-target.json 影响
  // 这次用 persist=true，validateAndCleanVoiceTarget 从文件读 target 才能命中
  const memoryOnly = new SessionBindingStore({ logsDir, persist: true, now: () => now });
  result = memoryOnly.setPrimarySessionId("ses_main");
  assert.equal(result.ok, true);
  assert.equal(memoryOnly.getPrimarySessionId(), "ses_main");
  ok("persist=false still updates in-memory binding");

  result = memoryOnly.setVoiceTargetSessionId("ses_voice_stale", { title: "Stale" });
  assert.equal(result.ok, true);
  const cleaned = memoryOnly.validateAndCleanVoiceTarget((sid) => sid === "ses_main");
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.cleared, true);
  assert.equal(cleaned.target, null);
  assert.equal(memoryOnly.getVoiceTargetSessionId(), null);
  ok("validateAndCleanVoiceTarget clears stale target not in session list");

  // 再次清理，再测一次保留场景
  rmSync(join(logsDir, "voice-input-target.9999.json"), { force: true });
  memoryOnly.setVoiceTargetSessionId("ses_main", { title: "Main" });
  const kept = memoryOnly.validateAndCleanVoiceTarget((sid) => sid === "ses_main");
  assert.equal(kept.cleared, false);
  assert.equal(kept.target?.sessionId, "ses_main");
  assert.equal(memoryOnly.getVoiceTargetSessionId(), "ses_main");
  ok("validateAndCleanVoiceTarget keeps valid target");

  rmSync(join(logsDir, "voice-input-target.9999.json"), { force: true });
  const noCheck = memoryOnly.validateAndCleanVoiceTarget();
  assert.equal(noCheck.cleared, false);
  assert.equal(noCheck.target, null);
  ok("validateAndCleanVoiceTarget with no target is a no-op");

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
