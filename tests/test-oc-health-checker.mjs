import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { OcHealthChecker } from "../src/core/oc-health-checker.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina OcHealthChecker test ===");

// 通用：起一个本地 HTTP server，按 mode 返回状态
async function withServer(handler, fn) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
  }
}

let now = 1_800_000_000_000;
const tick = (ms) => { now += ms; };

try {
  // 1. oc 活：200 OK → alive=true
  await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  }, async (baseUrl) => {
    const checker = new OcHealthChecker({
      baseUrl, intervalMs: 60_000, timeoutMs: 1000, now: () => now,
    });
    const snap = await checker.probeOnce();
    assert.equal(snap.alive, true);
    assert.equal(snap.lastCheckedAt, now);
    assert.ok(snap.latencyMs >= 0);
    assert.equal(snap.consecutiveFailures, 0);
    assert.equal(snap.lastError, null);
    ok("oc 活：probeOnce 返回 alive=true，consecutiveFailures=0");
  });

  // 2. oc 死：500 → alive=false
  tick(1000);
  await withServer((req, res) => {
    res.writeHead(500);
    res.end("boom");
  }, async (baseUrl) => {
    const checker = new OcHealthChecker({
      baseUrl, intervalMs: 60_000, timeoutMs: 1000, now: () => now,
    });
    const snap = await checker.probeOnce();
    assert.equal(snap.alive, false);
    assert.equal(snap.consecutiveFailures, 1);
    assert.ok(snap.lastError && snap.lastError.includes("500"), `lastError=${snap.lastError}`);
    ok("oc 返回 500：alive=false，lastError 含状态码");
  });

  // 3. 超时：server sleep 5s，client timeout=200ms → AbortError
  tick(1000);
  await withServer((req, res) => {
    setTimeout(() => { try { res.end(); } catch {} }, 5000);
  }, async (baseUrl) => {
    const checker = new OcHealthChecker({
      baseUrl, intervalMs: 60_000, timeoutMs: 200, now: () => now,
    });
    const snap = await checker.probeOnce();
    assert.equal(snap.alive, false);
    assert.equal(snap.consecutiveFailures, 1);
    assert.ok(snap.lastError && /timeout/.test(snap.lastError), `lastError=${snap.lastError}`);
    ok("oc 超时：probeOnce 触发 AbortController，alive=false，lastError 含 timeout");
  });

  // 4. 连续失败：consecutiveFailures 累加
  tick(1000);
  await withServer((req, res) => {
    res.writeHead(503);
    res.end("down");
  }, async (baseUrl) => {
    const checker = new OcHealthChecker({
      baseUrl, intervalMs: 60_000, timeoutMs: 500, now: () => now,
    });
    await checker.probeOnce();
    tick(500);
    await checker.probeOnce();
    tick(500);
    await checker.probeOnce();
    const snap = checker.snapshot();
    assert.equal(snap.alive, false);
    assert.equal(snap.consecutiveFailures, 3);
    ok("连续 3 次失败：consecutiveFailures=3 累加正确");
  });

  // 5. 失败后恢复：alive=true 时 consecutiveFailures 归零
  tick(1000);
  let mode = "fail";
  await withServer((req, res) => {
    if (mode === "fail") {
      res.writeHead(500);
      res.end("down");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    }
  }, async (baseUrl) => {
    const checker = new OcHealthChecker({
      baseUrl, intervalMs: 60_000, timeoutMs: 1000, now: () => now,
    });
    await checker.probeOnce();
    tick(500);
    await checker.probeOnce();
    assert.equal(checker.snapshot().consecutiveFailures, 2);
    mode = "ok";
    tick(500);
    await checker.probeOnce();
    const snap = checker.snapshot();
    assert.equal(snap.alive, true);
    assert.equal(snap.consecutiveFailures, 0);
    assert.equal(snap.lastError, null);
    ok("失败 → 恢复：alive=true 时 consecutiveFailures 归零，lastError 清空");
  });

  // 6. start + stop：定时器正确启停
  tick(1000);
  let probeCount = 0;
  await withServer((req, res) => {
    probeCount++;
    res.writeHead(200);
    res.end("ok");
  }, async (baseUrl) => {
    const checker = new OcHealthChecker({
      baseUrl,
      intervalMs: 100, // 100ms 间隔，350ms 等待应 ≥3 次
      timeoutMs: 500,
      now: () => now,
    });
    const startResult = checker.start();
    assert.equal(startResult.ok, true);
    assert.equal(startResult.started, true);
    // start 后立即 fire 一次，之后 100ms 一次
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(checker.status().running, true);
    assert.ok(probeCount >= 3, `probeCount=${probeCount}，期望 ≥3`);
    checker.stop();
    // 二次 stop 应是 alreadyStopped
    const stopResult = checker.stop();
    assert.equal(stopResult.alreadyStopped, true);
    assert.equal(checker.status().running, false);
    const countAfterStop = probeCount;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(probeCount, countAfterStop, "stop 后定时器应停止 fire");
    ok("start 启动定时器并 fire，stop 后不再 probe");
  });

  // 7. status() 暴露完整字段
  tick(1000);
  const checker2 = new OcHealthChecker({
    baseUrl: "http://127.0.0.1:12345",
    intervalMs: 5000,
    timeoutMs: 1000,
    now: () => now,
  });
  const status2 = checker2.status();
  assert.equal(status2.baseUrl, "http://127.0.0.1:12345");
  assert.equal(status2.intervalMs, 5000);
  assert.equal(status2.timeoutMs, 1000);
  assert.equal(status2.running, false);
  assert.equal(status2.alive, false);
  assert.equal(status2.consecutiveFailures, 0);
  assert.equal(status2.lastError, "not_yet_probed");
  ok("status() 暴露 baseUrl/intervalMs/timeoutMs/running/alive/consecutiveFailures/lastError");

  // 8. interval / timeout 非法值回落
  tick(1000);
  const fallback = new OcHealthChecker({
    baseUrl: "http://127.0.0.1:1",
    intervalMs: -1,
    timeoutMs: 0,
    now: () => now,
  });
  assert.equal(fallback.intervalMs, 10_000);
  assert.equal(fallback.timeoutMs, 3_000);
  ok("非法 interval/timeout 回落到默认值（10000ms / 3000ms）");

  // 9. interval 太小被夹紧到最小 100ms（防止误用压垮 oc）
  tick(1000);
  const clamped = new OcHealthChecker({
    baseUrl: "http://127.0.0.1:1",
    intervalMs: 5,
    timeoutMs: 200,
    now: () => now,
  });
  assert.equal(clamped.intervalMs, 100);
  ok("intervalMs=5 被夹紧到最小 100ms");

  // 10. auth 字段：探测时携带 Authorization header
  tick(1000);
  let receivedAuth = null;
  await withServer((req, res) => {
    receivedAuth = req.headers.authorization || null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  }, async (baseUrl) => {
    const checker = new OcHealthChecker({
      baseUrl,
      intervalMs: 60_000,
      timeoutMs: 1000,
      now: () => now,
      auth: "Basic dGVzdDp0ZXN0", // "test:test"
    });
    const snap = await checker.probeOnce();
    assert.equal(snap.alive, true);
    assert.equal(receivedAuth, "Basic dGVzdDp0ZXN0", "Authorization header 应透传到 server");
    ok("auth 字段透传到 fetch header，server 能收到 Basic auth");
  });

  // 11. 无 auth 时：探测行为（server 是否要求 auth 不在 OcHealthChecker 职责）
  // 这个测试是"文档化"——auth 缺失不代表 OcHealthChecker 错，是 server 端决定
  tick(1000);
  await withServer((req, res) => {
    // 模拟 OpenCode 的 401 行为
    res.writeHead(401);
    res.end("Unauthorized");
  }, async (baseUrl) => {
    const checkerNoAuth = new OcHealthChecker({
      baseUrl,
      intervalMs: 60_000,
      timeoutMs: 1000,
      now: () => now,
      auth: null, // 显式无 auth
    });
    const snap = await checkerNoAuth.probeOnce();
    assert.equal(snap.alive, false);
    assert.ok(snap.lastError && snap.lastError.includes("401"), `lastError=${snap.lastError}`);
    ok("无 auth 探测受保护端点：alive=false，lastError 含 401（不抛异常）");
  });

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
}