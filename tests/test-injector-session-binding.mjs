import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Injector } from "../src/injector.mjs";
import { SessionBindingStore } from "../src/state/session-binding-store.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

const root = mkdtempSync(join(tmpdir(), "korina-injector-binding-"));
const logsDir = join(root, "logs");
const now = 1_800_000_100_000;

try {
  console.log("=== korina Injector session binding integration test ===");

  const bindingStore = new SessionBindingStore({ logsDir, now: () => now });
  const injector = new Injector({ bindingStore });

  injector.saveSession("ses_main");
  assert.equal(injector.sessionId, "ses_main");
  assert.deepEqual(injector.listBoundSessions(), ["ses_main"]);
  const lock = JSON.parse(readFileSync(join(logsDir, "session.9999.lock"), "utf-8"));
  assert.equal(lock.sessionId, "ses_main");
  assert.equal(lock.reason, "injector.saveSession");
  ok("saveSession delegates to SessionBindingStore and syncs injector state");

  let result = injector.bindSession("ses_extra");
  assert.equal(result.ok, true);
  assert.equal(injector.sessionId, "ses_main");
  assert.deepEqual(injector.listBoundSessions(), ["ses_main", "ses_extra"]);
  ok("bindSession adds secondary session without changing primary");

  result = injector.unbindSession("ses_main");
  assert.equal(result.ok, true);
  assert.equal(injector.sessionId, "ses_extra");
  assert.deepEqual(injector.listBoundSessions(), ["ses_extra"]);
  ok("unbindSession promotes next session through SessionBindingStore");

  const reloadedStore = new SessionBindingStore({ logsDir, now: () => now });
  const reloadedInjector = new Injector({ bindingStore: reloadedStore });
  assert.equal(reloadedInjector.loadSession(), "ses_extra");
  assert.equal(reloadedInjector.sessionId, "ses_extra");
  assert.deepEqual(reloadedInjector.listBoundSessions(), ["ses_extra"]);
  ok("loadSession restores primary into injector state");

  const noPersistStore = new SessionBindingStore({ logsDir, persist: false, now: () => now });
  const noPersistInjector = new Injector({ bindingStore: noPersistStore, persistSession: false });
  noPersistInjector.saveSession("ses_memory");
  assert.equal(noPersistInjector.sessionId, null);
  assert.equal(noPersistInjector.loadSession(), null);
  ok("persistSession=false keeps old no-op save/load behavior");

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
