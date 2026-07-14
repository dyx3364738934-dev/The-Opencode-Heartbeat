import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SessionBindingStore } from "../src/state/session-binding-store.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina SessionBindingStore multi-port (L5.1 manual #34) test ===");

const root = mkdtempSync(join(tmpdir(), "korina-mp-sess-"));
const logsDir = join(root, "logs");
let now = 1_800_000_000_000;
const tick = (ms) => { now += ms; };

try {
  // 1. 默认 port=9999：sessionLockFile = session.9999.lock
  const store9999 = new SessionBindingStore({
    logsDir,
    port: 9999,
    now: () => now,
  });
  assert.equal(store9999.port, 9999);
  assert.equal(store9999.sessionLockFile, join(logsDir, "session.9999.lock"));
  assert.equal(store9999.voiceTargetFile, join(logsDir, "voice-input-target.9999.json"));
  ok("默认 port=9999 → sessionLockFile=session.9999.lock + voiceTarget=voice-input-target.9999.json");

  // 2. 显式 port=10001：sessionLockFile = session.10001.lock
  const store10001 = new SessionBindingStore({
    logsDir,
    port: 10001,
    now: () => now,
  });
  assert.equal(store10001.port, 10001);
  assert.equal(store10001.sessionLockFile, join(logsDir, "session.10001.lock"));
  ok("显式 port=10001 → sessionLockFile=session.10001.lock");

  // 3. 向后兼容：显式 sessionLockFile 优先
  const customFile = join(logsDir, "legacy-session.lock");
  const storeCustom = new SessionBindingStore({
    logsDir,
    port: 9999,
    sessionLockFile: customFile,
    now: () => now,
  });
  assert.equal(storeCustom.sessionLockFile, customFile);
  ok("显式 sessionLockFile 优先于按 port 命名（向后兼容）");

  // 4. 两个实例写各自己的 session.lock，互不覆盖
  tick(1000);
  store9999.setPrimarySessionId("ses_alpha", { reason: "test9999" });
  store10001.setPrimarySessionId("ses_beta", { reason: "test10001" });

  // 文件系统应该有两个独立 session.{port}.lock
  assert.ok(existsSync(store9999.sessionLockFile), "session.9999.lock 存在");
  assert.ok(existsSync(store10001.sessionLockFile), "session.10001.lock 存在");

  const p9999 = JSON.parse(readFileSync(store9999.sessionLockFile, "utf-8"));
  const p10001 = JSON.parse(readFileSync(store10001.sessionLockFile, "utf-8"));
  assert.equal(p9999.sessionId, "ses_alpha");
  assert.equal(p10001.sessionId, "ses_beta");
  ok("两个实例写不同 session.lock 文件（ses_alpha vs ses_beta 互不覆盖）");

  // 5. load() 各自读回自己的 sessionId（隔离生效）
  const reload9999 = new SessionBindingStore({
    logsDir, port: 9999, now: () => now,
  });
  reload9999.load();
  assert.equal(reload9999.primarySessionId, "ses_alpha");

  const reload10001 = new SessionBindingStore({
    logsDir, port: 10001, now: () => now,
  });
  reload10001.load();
  assert.equal(reload10001.primarySessionId, "ses_beta");
  ok("load() 各自读回正确 sessionId（文件隔离验证）");

  // 6. logsDir 文件列表确认只有 2 个独立文件
  const files = readdirSync(logsDir).filter(f => f.startsWith("session.") && f.endsWith(".lock"));
  assert.equal(files.length, 2, "应该有 2 个 session.{port}.lock 文件");
  assert.ok(files.includes("session.9999.lock"));
  assert.ok(files.includes("session.10001.lock"));
  ok("logsDir 下两个 session lock 文件独立");

  // 7. voice target 同样按 port 隔离
  const voice9999 = join(logsDir, "voice-input-target.9999.json");
  const voice10001 = join(logsDir, "voice-input-target.10001.json");
  assert.equal(store9999.voiceTargetFile, voice9999);
  assert.equal(store10001.voiceTargetFile, voice10001);
  ok("voice target 文件也按 port 命名（多实例独立）");

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}