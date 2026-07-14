/**
 * tests/test-injector-http-ops.mjs
 *
 * v0.9.19 (J 第四刀 manual #44): 测 injector-http-ops 模块的 9 个纯函数
 *
 * 设计：mock globalThis.fetch + 构造 ctx，测纯函数行为不依赖 injector 实例
 */

import * as Hop from "../src/injector-http-ops.mjs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function mockFetch(responses) {
  // responses: [{ match: (url, init) => bool, status, body, delayMs? }]
  let i = 0;
  globalThis.fetch = async (url, init) => {
    const r = responses[i] || responses[responses.length - 1];
    i++;
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    if (r.throw) throw r.throw;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body || "",
      json: async () => r.jsonValue !== undefined ? r.jsonValue : (r.body ? JSON.parse(r.body) : {}),
    };
  };
}

function defaultCtx(extra = {}) {
  return {
    base: "http://127.0.0.1:7574",
    headers: { Authorization: "Basic xxx" },
    sid: "ses_test_001",
    render: (text, opts) => `[${opts.intent || "user"}] ${text}`,
    onKokoActive: null,
    pollIntervalMs: 100,
    pollTimeoutMs: 5000,
    ...extra,
  };
}

// =============================
// inject tests
// =============================

test("inject: 成功 (204) 返回 true", async () => {
  mockFetch([{ status: 204 }]);
  let kokoCalled = null;
  const ctx = defaultCtx({ onKokoActive: (ts) => { kokoCalled = ts; } });
  const r = await Hop.inject("hello", { intent: "user" }, ctx);
  if (r !== true) throw new Error(`expected true, got ${r}`);
  if (kokoCalled !== null) throw new Error("koko callback should not fire on source!=koko");
});

test("inject: source=koko 触发 onKokoActive 回调", async () => {
  mockFetch([{ status: 204 }]);
  let kokoTs = null;
  const ctx = defaultCtx({ onKokoActive: (ts) => { kokoTs = ts; } });
  await Hop.inject("voice input text", { source: "koko" }, ctx);
  if (typeof kokoTs !== "number") throw new Error("koko callback not called");
});

test("inject: HTTP 500 抛错", async () => {
  mockFetch([{ status: 500, body: "internal error" }]);
  try {
    await Hop.inject("text", {}, defaultCtx());
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("HTTP 500")) throw new Error(`unexpected: ${e.message}`);
  }
});

test("inject: HTTP 404 抛错带响应体前 200 字", async () => {
  mockFetch([{ status: 404, body: "x".repeat(300) }]);
  try {
    await Hop.inject("text", {}, defaultCtx());
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("HTTP 404")) throw new Error(`unexpected: ${e.message}`);
    if (e.message.length > 250) throw new Error("body truncation failed");
  }
});

test("inject: render 回调被调用（包装 intent 前缀）", async () => {
  mockFetch([{ status: 204 }]);
  let rendered = null;
  const ctx = defaultCtx({ render: (text, opts) => { rendered = `[${opts.intent}] ${text}`; return rendered; } });
  await Hop.inject("raw", { intent: "agent-hint" }, ctx);
  if (rendered !== "[agent-hint] raw") throw new Error(`render failed: ${rendered}`);
});

// =============================
// silentInject tests
// =============================

test("silentInject: 第 1 次成功 → 立即返回 true", async () => {
  mockFetch([{ status: 204 }]);
  const r = await Hop.silentInject("text", {}, defaultCtx());
  if (r !== true) throw new Error(`expected true, got ${r}`);
});

test("silentInject: 失败 2 次后第 3 次成功 → true", async () => {
  mockFetch([
    { status: 500, body: "fail" },
    { status: 500, body: "fail" },
    { status: 204 },
  ]);
  const start = Date.now();
  const r = await Hop.silentInject("text", {}, defaultCtx());
  const dur = Date.now() - start;
  if (r !== true) throw new Error(`expected true, got ${r}`);
  // 2 次重试 sleep 1500ms = ~3000ms
  if (dur < 2800) throw new Error(`expected ~3000ms wait, got ${dur}ms`);
});

test("silentInject: 3 次全失败 → 返回 false（不抛异常）", async () => {
  mockFetch([
    { status: 500, body: "fail" },
    { status: 500, body: "fail" },
    { status: 500, body: "fail" },
  ]);
  const r = await Hop.silentInject("text", {}, defaultCtx());
  if (r !== false) throw new Error(`expected false, got ${r}`);
});

// =============================
// summarize tests
// =============================

test("summarize: 成功返回 true", async () => {
  mockFetch([{ status: 200 }]);
  const r = await Hop.summarize(defaultCtx());
  if (r !== true) throw new Error(`expected true, got ${r}`);
});

test("summarize: 失败返回 false（不抛）", async () => {
  mockFetch([{ status: 500 }]);
  const r = await Hop.summarize(defaultCtx());
  if (r !== false) throw new Error(`expected false, got ${r}`);
});

// =============================
// getMessageCount tests
// =============================

test("getMessageCount: 返回数组长度", async () => {
  mockFetch([{ status: 200, jsonValue: [{ info: { role: "user" } }, { info: { role: "assistant" } }, { info: { role: "user" } }] }]);
  const r = await Hop.getMessageCount(defaultCtx());
  if (r !== 3) throw new Error(`expected 3, got ${r}`);
});

test("getMessageCount: HTTP 失败返回 0", async () => {
  mockFetch([{ status: 500 }]);
  const r = await Hop.getMessageCount(defaultCtx());
  if (r !== 0) throw new Error(`expected 0, got ${r}`);
});

test("getMessageCount: fetch 抛错返回 0", async () => {
  mockFetch([{ throw: new Error("ECONNREFUSED") }]);
  const r = await Hop.getMessageCount(defaultCtx());
  if (r !== 0) throw new Error(`expected 0, got ${r}`);
});

// =============================
// refreshPasswordFromFile tests
// =============================

test("refreshPasswordFromFile: 文件不存在不抛", () => {
  Hop.refreshPasswordFromFile({ logsDir: "C:\\nonexistent\\path" });
  // 通过 = 不抛
});

test("refreshPasswordFromFile: 存在文件不抛（写日志）", () => {
  const tmpDir = `${require("node:os").tmpdir()}${require("node:path").sep}hop-test-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(`${tmpDir}${require("node:path").sep}oc-password.txt`, JSON.stringify({ password: "x", leakedAt: Date.now() }));
  Hop.refreshPasswordFromFile({ logsDir: tmpDir });
  rmSync(tmpDir, { recursive: true, force: true });
});

// =============================
// poll tests（短 pollIntervalMs + 短 pollTimeoutMs）
// =============================

test("poll: 无新消息（created <= sinceCreated）持续 → 超时返回 global_timeout", async () => {
  // 模拟连续 3 次 poll 都返回空数组，触发 global timeout
  mockFetch([
    { status: 200, jsonValue: [] },
    { status: 200, jsonValue: [] },
    { status: 200, jsonValue: [] },
    { status: 200, jsonValue: [] },
    { status: 200, jsonValue: [] },
  ]);
  const ctx = {
    base: "http://127.0.0.1:7574",
    headers: {},
    pollIntervalMs: 50,
    pollTimeoutMs: 300, // 短超时
    lastInjected: new Map(),
    injectFn: null,
  };
  const r = await Hop.poll(0, null, "ses_001", ctx);
  if (r.state !== "global_timeout") throw new Error(`expected global_timeout, got ${r.state}`);
});

test("poll: fetch 持续抛错 → 返回 fetch_dead（注入 fetchFailThresholdMs=200 测快速失败）", async () => {
  mockFetch([{ throw: new Error("ECONNREFUSED") }]);
  const ctx = {
    base: "http://127.0.0.1:7574",
    headers: {},
    pollIntervalMs: 50,
    pollTimeoutMs: 5000, // > 200 给 fetch_fail 机会先到
    fetchFailThresholdMs: 200, // 测快速失败
    lastInjected: new Map(),
    injectFn: null,
  };
  const r = await Hop.poll(0, null, "ses_001", ctx);
  if (r.state !== "fetch_dead") throw new Error(`expected fetch_dead, got ${r.state}`);
});

test("poll: state=completed 立即返回", async () => {
  const sinceCreated = 1000;
  mockFetch([{
    status: 200,
    jsonValue: [{
      info: { role: "assistant", state: "completed", time: { created: 2000 } },
      parts: [{ type: "text", text: "done" }],
    }],
  }]);
  const ctx = {
    base: "http://127.0.0.1:7574",
    headers: {},
    pollIntervalMs: 50,
    pollTimeoutMs: 5000,
    lastInjected: new Map(),
    injectFn: null,
  };
  const r = await Hop.poll(sinceCreated, null, "ses_001", ctx);
  if (r.state !== "completed") throw new Error(`expected completed, got ${r.state}`);
  if (r.text !== "done") throw new Error(`expected "done", got ${r.text}`);
  if (r.created !== 2000) throw new Error(`expected created 2000, got ${r.created}`);
});

test("poll: onProgress 回调被调用", async () => {
  const sinceCreated = 1000;
  mockFetch([{
    status: 200,
    jsonValue: [{
      info: { role: "assistant", state: "completed", time: { created: 2000 } },
      parts: [{ type: "text", text: "x" }],
    }],
  }]);
  let progressCalled = false;
  const ctx = {
    base: "http://127.0.0.1:7574",
    headers: {},
    pollIntervalMs: 50,
    pollTimeoutMs: 5000,
    lastInjected: new Map(),
    injectFn: null,
  };
  await Hop.poll(sinceCreated, (p) => { progressCalled = true; }, "ses_001", ctx);
  // completed 直接返回可能不调 onProgress（看代码：onProgress 在 stateDone 之前调）
  // 实际代码：先 onProgress 再 stateDone 检查 → 会调一次
  if (!progressCalled) throw new Error("onProgress not called");
});

// =============================
// injectAndWait tests（短超时）
// =============================

test("injectAndWait: inject 成功 + poll state=completed → 返回 reply", async () => {
  mockFetch([
    { status: 204 }, // inject
    {
      status: 200,
      jsonValue: [{
        info: { role: "assistant", state: "completed", time: { created: 2000 } },
        parts: [{ type: "text", text: "reply" }],
      }],
    },
  ]);
  let lastInjectedRecord = null;
  const ctx = {
    base: "http://127.0.0.1:7574",
    headers: {},
    sid: "ses_001",
    beforeTime: 0,
    render: (t) => t,
    onKokoActive: null,
    onLastInjected: (sid, rec) => { lastInjectedRecord = { sid, rec }; },
    pollIntervalMs: 50,
    pollTimeoutMs: 5000,
  };
  const r = await Hop.injectAndWait("text", null, {}, ctx);
  if (r.state !== "completed") throw new Error(`expected completed, got ${r.state}`);
  if (r.text !== "reply") throw new Error(`expected reply, got ${r.text}`);
  if (!lastInjectedRecord) throw new Error("onLastInjected not called");
  if (lastInjectedRecord.sid !== "ses_001") throw new Error("wrong sid in record");
});

test("injectAndWait: inject 超时但继续 _poll → 仍返回 reply", async () => {
  // 第一次 inject timeout (30s 但 sleep race 让它 throw)，但消息可能在 oc 内部
  // 简化模拟：inject fetch throw + poll 返回 completed
  mockFetch([
    { throw: new Error("inject network error") },
    {
      status: 200,
      jsonValue: [{
        info: { role: "assistant", state: "completed", time: { created: 2000 } },
        parts: [{ type: "text", text: "still got it" }],
      }],
    },
  ]);
  const ctx = {
    base: "http://127.0.0.1:7574",
    headers: {},
    sid: "ses_001",
    beforeTime: 0,
    render: (t) => t,
    onKokoActive: null,
    pollIntervalMs: 50,
    pollTimeoutMs: 5000,
  };
  const r = await Hop.injectAndWait("text", null, {}, ctx);
  if (r.text !== "still got it") throw new Error(`expected still got it, got ${r.text}`);
});

// =============================
// startHealthMonitor tests
// =============================

test("startHealthMonitor: 返回 stop 函数和 timer", () => {
  let timerCalled = null;
  const ctx = {
    _healthTimer: null,
    isOCRunningAsync: async () => true,
    waitForPassword: async () => ({ port: 7574 }),
    findPortsByProcess: async () => [7574],
    spawnOC: () => {},
    refreshPassword: () => {},
    getServerConfig: () => null,
    setServerConfig: () => {},
    onOCRestarted: null,
    getLastKnownPort: () => null,
    setLastKnownPort: (p) => { timerCalled = p; },
  };
  const handle = Hop.startHealthMonitor(100, ctx);
  if (typeof handle.stop !== "function") throw new Error("stop not function");
  handle.stop();
});

test("startHealthMonitor: 重复启动返回已有 handle 不创建新 timer", () => {
  const ctx = {
    _healthTimer: { dummy: true },
    isOCRunningAsync: async () => true,
  };
  const handle = Hop.startHealthMonitor(100, ctx);
  if (handle.timer.dummy !== true) throw new Error("should reuse existing timer");
});

// =============================
// 跑测试
// =============================
console.log(`=== korina injector-http-ops (J 第四刀 manual #44) test ===`);
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  PASS: ${t.name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL: ${t.name} -- ${e.message}`);
    fail++;
  }
}
console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
