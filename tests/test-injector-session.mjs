import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Smgr from "../src/injector-session.mjs";
import { SessionBindingStore } from "../src/state/session-binding-store.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina injector-session (J 第二刀 manual #40) test ===");

const root = mkdtempSync(join(tmpdir(), "korina-smgr-"));
const logsDir = join(root, "logs");
import { mkdirSync } from "node:fs";
mkdirSync(logsDir, { recursive: true });

try {
  // 用真实 SessionBindingStore（mock 太复杂，绑定逻辑已有 10/10 测试覆盖）

  // 1. saveSession — persistSession=false → 不写
  {
    const store = new SessionBindingStore({ logsDir, port: 9999 });
    const ok1 = Smgr.saveSession({ bindingStore: store, persistSession: false, sid: "ses_a" });
    assert.equal(ok1, false);
    assert.equal(store.getPrimarySessionId(), null, "未写文件");
    ok("saveSession persistSession=false → 不写");
  }

  // 2. saveSession — persistSession=true → 写并返回 true
  {
    const store = new SessionBindingStore({ logsDir, port: 9999 });
    const ok2 = Smgr.saveSession({ bindingStore: store, persistSession: true, sid: "ses_b" });
    assert.equal(ok2, true);
    assert.equal(store.getPrimarySessionId(), "ses_b");
    ok("saveSession persistSession=true → 写文件 + 返回 true");
  }

  // 3. loadSession — persistSession=false → null
  {
    const store = new SessionBindingStore({ logsDir, port: 9999, persist: true });
    store.setPrimarySessionId("ses_c", { reason: "test" });
    const sid = Smgr.loadSession({ bindingStore: store, persistSession: false });
    assert.equal(sid, null, "persistSession=false 时不读");
    ok("loadSession persistSession=false → null（即使文件存在）");
  }

  // 4. loadSession — 文件存在 → 返回 sid 并自动 bind
  {
    const store = new SessionBindingStore({ logsDir, port: 9999, persist: true });
    store.setPrimarySessionId("ses_d", { reason: "test" });
    const sid = Smgr.loadSession({ bindingStore: store, persistSession: true });
    assert.equal(sid, "ses_d");
    assert.ok(store.listBoundSessionIds().includes("ses_d"), "自动 bind 到 bound set");
    ok("loadSession 文件存在 → 返回 sid + 自动 bind");
  }

  // 5. loadSession — 文件不存在 → null
  // 用独立 logsDir（避免测试 4 写入的 session.9999.lock 污染）
  {
    const freshLogsDir = join(root, "logs-empty");
    mkdirSync(freshLogsDir, { recursive: true });
    const store = new SessionBindingStore({ logsDir: freshLogsDir, port: 9999, persist: true });
    const sid = Smgr.loadSession({ bindingStore: store, persistSession: true });
    assert.equal(sid, null);
    ok("loadSession 文件不存在 → null");
  }

  // 6. bindSession — 新 session → 返回 ok + isNew
  {
    const store = new SessionBindingStore({ logsDir, port: 9999 });
    const result = Smgr.bindSession({ bindingStore: store, sid: "ses_e" });
    assert.equal(result.ok, true);
    assert.equal(result.isNew, true);
    ok("bindSession 新增 → ok + isNew=true");
  }

  // 7. bindSession — 已存在 session → ok + isNew=false
  {
    const store = new SessionBindingStore({ logsDir, port: 9999 });
    Smgr.bindSession({ bindingStore: store, sid: "ses_f" });
    const result = Smgr.bindSession({ bindingStore: store, sid: "ses_f" });
    assert.equal(result.ok, true);
    assert.equal(result.isNew, false);
    ok("bindSession 已存在 → ok + isNew=false");
  }

  // 8. unbindSession — 存在 → ok
  {
    const store = new SessionBindingStore({ logsDir, port: 9999 });
    store.bindSession("ses_g");
    const result = Smgr.unbindSession({ bindingStore: store, sid: "ses_g" });
    assert.equal(result.ok, true);
    ok("unbindSession 存在 → ok");
  }

  // 9. unbindSession — 不存在 → ok=false
  {
    const store = new SessionBindingStore({ logsDir, port: 9999 });
    const result = Smgr.unbindSession({ bindingStore: store, sid: "ses_not_exists" });
    assert.equal(result.ok, false);
    ok("unbindSession 不存在 → ok=false");
  }

  // 10. listBoundSessions — 返回绑定列表
  {
    const store = new SessionBindingStore({ logsDir, port: 9999 });
    store.bindSession("ses_h1");
    store.bindSession("ses_h2");
    const list = Smgr.listBoundSessions({ bindingStore: store });
    assert.ok(Array.isArray(list));
    assert.ok(list.includes("ses_h1"));
    assert.ok(list.includes("ses_h2"));
    ok(`listBoundSessions 返回 array（含绑定 sid）`);
  }

  // 11. 模块导出 sanity（防止 export 意外丢失）
  {
    const exportedNames = Object.keys(Smgr).sort();
    const expected = [
      "bindSession", "listBoundSessions", "loadSession", "saveSession", "unbindSession",
    ].sort();
    assert.deepEqual(exportedNames, expected);
    ok(`模块导出 5 个函数（与 injector.mjs 委托面一致）`);
  }

  // 12. saveSession 失败 → 返回 false（不抛异常）
  {
    // 模拟失败场景：构造一个返回 ok=false 的 fake store
    const fakeStore = {
      setPrimarySessionId: () => ({ ok: false, error: "fake error" }),
    };
    const ok12 = Smgr.saveSession({ bindingStore: fakeStore, persistSession: true, sid: "ses_x" });
    assert.equal(ok12, false);
    ok("saveSession 写入失败 → 返回 false（不抛异常）");
  }

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}