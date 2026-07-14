import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";

import { Injector } from "../src/injector.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina injector public API (I-α manual #38) test ===");

// v0.9.22 (manual #50): 防回归 — silentInject 测试必须 mock globalThis.fetch 才不污染 oc。
// 此前 mock 拦在 inj.inject（错层），silentInject 走 Hop.silentInject → Hop.inject → 真 fetch，
// 导致测试套跑时 "test1"~"test4" 真注入到 oc（Koko 在对话框看到的"test1"消息）。
// 治根因 = 测试启动时检测 oc 是否在跑，警告而非自动 fail（mock 正确时 fetch 被拦截，不会污染）。
function isOcListening(port = 7574) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
    socket.connect(port, "127.0.0.1");
  });
}
const OC_LISTENING = await isOcListening();
if (OC_LISTENING) {
  console.warn("[WARN] 检测到 oc 在 127.0.0.1:7574 监听。本测试套通过 mock globalThis.fetch 隔离 HTTP；");
  console.warn("[WARN] 任何 silentInject 测试块漏 mock → 会真注入字符串到 oc 当前 session。");
  console.warn("[WARN] 每个 silentInject 测试必须在 try/finally 里 mock fetch，否则视为回归。");
}

// 用 tmp 目录防止污染真实 session.lock
const root = mkdtempSync(join(tmpdir(), "korina-inj-"));
const logsDir = join(root, "logs");

// v0.9.22 (manual #50): helper —— 给 Injector 预填 mock 网络层 + 提供 fetch mock 计数器
// mock discover / sessionId 让 silentInject 不走真发现路径；fetch mock 拦 Hop.inject 真发请求
function setupMockNetwork(inj) {
  inj.serverConfig = { base: "http://mock.test", headers: {}, port: 9999 };
  inj.sessionId = "ses_mock";
  inj.discover = async () => inj.serverConfig;
}
function withFetchMock(behavior, fn) {
  const orig = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url, init) => {
    callCount++;
    return await behavior(url, init, callCount);
  };
  return fn().then(
    (r) => { globalThis.fetch = orig; return { result: r, callCount }; },
    (e) => { globalThis.fetch = orig; throw e; }
  );
}

try {
  // 1. silentInject 第一次成功（注入 1 次就 return true）
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    setupMockNetwork(inj);
    const { result: ok1, callCount } = await withFetchMock(
      async () => ({ status: 204, ok: true, text: async () => "" }),
      async () => await inj.silentInject("test1")
    );
    assert.equal(ok1, true);
    assert.equal(callCount, 1);
    ok("silentInject 一次成功 → 返回 true，不重试");
  }

  // 2. silentInject 重试 2 次失败，第 3 次成功
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    setupMockNetwork(inj);
    const { result: ok2, callCount } = await withFetchMock(
      async (url, init, n) => {
        if (n < 3) throw new Error(`HTTP ${500 + n}`);
        return { status: 204, ok: true, text: async () => "" };
      },
      async () => await inj.silentInject("test2")
    );
    assert.equal(ok2, true);
    assert.equal(callCount, 3, "应调用 inject 3 次（前 2 次失败，第 3 次成功）");
    ok("silentInject 第 3 次成功 → 返回 true，调用 3 次");
  }

  // 3. silentInject 重试 3 次全失败 → 返回 false
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    setupMockNetwork(inj);
    const { result: ok3, callCount } = await withFetchMock(
      async () => { throw new Error("HTTP 500"); },
      async () => await inj.silentInject("test3")
    );
    assert.equal(ok3, false);
    assert.equal(callCount, 3, "MAX_RETRY=2 → 总共 3 次尝试");
    ok("silentInject 3 次全失败 → 返回 false（不抛异常）");
  }

  // 4. silentInject 不重置 serverConfig（治 oc 重启误判）
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    inj.serverConfig = { base: "http://test", headers: {}, port: 9999 };
    setupMockNetwork(inj);  // 设 sessionId 短路 resolveSession
    const origCfg = inj.serverConfig;
    const { callCount } = await withFetchMock(
      async () => { throw new Error("HTTP 500"); },
      async () => await inj.silentInject("test4")
    );
    assert.equal(callCount, 3, "应重试 3 次");
    assert.equal(inj.serverConfig, origCfg, "serverConfig 引用应保持");
    ok("silentInject 失败时 serverConfig 不重置（让 health monitor 自己处理）");
  }

  // 5. _fetchPeerSession 成功（peer 端点 200 + session）
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(url, "http://127.0.0.1:9999/status");
      return { ok: true, json: async () => ({ session: "ses_peer_alpha" }) };
    };
    try {
      const peerSession = await inj._fetchPeerSession(9999);
      assert.equal(peerSession, "ses_peer_alpha");
      ok("_fetchPeerSession 成功（fetch 200 + session）");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 6. _fetchPeerSession 失败（peer 不在跑）→ null
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const peerSession = await inj._fetchPeerSession(9999);
      assert.equal(peerSession, null);
      ok("_fetchPeerSession 失败 → null（peer 不在跑）");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 7. _fetchPeerSession HTTP 非 200 → null
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    try {
      const peerSession = await inj._fetchPeerSession(9999);
      assert.equal(peerSession, null);
      ok("_fetchPeerSession HTTP 503 → null");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 8. _selectTargetSession peer-avoid 路径（用真实 sorted 测，不 mock fetch）
  {
    const inj = new Injector({
      persistSession: false,
      port: 10001,
      sessionLockFile: join(logsDir, "session.10001.lock"),
    });
    const origFetch = globalThis.fetch;
    const origEnv = process.env.KORINA_BIND_SESSION;
    process.env.KORINA_BIND_SESSION = "peer-avoid-9999";
    globalThis.fetch = async (url) => {
      if (url === "http://127.0.0.1:9999/status") {
        return { ok: true, json: async () => ({ session: "ses_avoid_me" }) };
      }
      return { ok: false };
    };
    try {
      const sorted = [
        { id: "ses_avoid_me", time: { updated: 3000 } },
        { id: "ses_pick_me",   time: { updated: 2000 } },
        { id: "ses_oldest",    time: { updated: 1000 } },
      ];
      const picked = await inj._selectTargetSession(sorted);
      assert.equal(picked.id, "ses_pick_me", "避开 ses_avoid_me，拿 sorted[0] 剩下的最新");
      ok("_selectTargetSession peer-avoid 路径避开 peer session");
    } finally {
      globalThis.fetch = origFetch;
      process.env.KORINA_BIND_SESSION = origEnv;
    }
  }

  // 9. isOCIdleAsync busy（contentLen 变化 → false）
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    setupMockNetwork(inj);
    inj.sessionId = "ses_test";
    inj.serverConfig = { base: "http://test", headers: {} };
    const origFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount++;
      const msgs = url.includes("/message")
        ? [{
            info: { role: "assistant", time: { created: 1000000 } },
            parts: [
              { type: "text", text: "x".repeat(fetchCount === 1 ? 100 : 200) },
            ],
          }]
        : [];
      return {
        ok: true,
        json: async () => url.includes("/message") ? msgs : [],
      };
    };
    try {
      const idle = await inj.isOCIdleAsync("ses_test", 30000);
      assert.equal(idle, false, "contentLen 变化 → busy");
      assert.equal(fetchCount, 2, "两次采样");
      ok("isOCIdleAsync busy（contentLen 变化）→ false");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 10. isOCIdleAsync idle（无变化 + 消息够老 → true）
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    setupMockNetwork(inj);
    inj.sessionId = "ses_test";
    inj.serverConfig = { base: "http://test", headers: {} };
    const origFetch = globalThis.fetch;
    const oldCreated = Date.now() - 60000; // 60s 前
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [{
        info: { role: "assistant", time: { created: oldCreated } },
        parts: [{ type: "text", text: "stable" }],
      }],
    });
    try {
      const idle = await inj.isOCIdleAsync("ses_test", 30000);
      assert.equal(idle, true, "无变化 + 60s > 30s threshold → idle");
      ok("isOCIdleAsync idle（无变化 + 消息老）→ true");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 11. isOCIdleAsync fetch 失败 → true（保守算闲置）
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    setupMockNetwork(inj);
    inj.sessionId = "ses_test";
    inj.serverConfig = { base: "http://test", headers: {} };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const idle = await inj.isOCIdleAsync("ses_test", 30000);
      assert.equal(idle, true, "fetch 失败 → 保守算闲置");
      ok("isOCIdleAsync fetch 失败 → true（保守）");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 12. discover() 缓存 serverConfig（第二次不重新调密码文件）
  {
    const inj = new Injector({
      persistSession: false,
      port: 9999,
      sessionLockFile: join(logsDir, "session.9999.lock"),
    });
    // 不写密码文件 + session.lock → discover 应该 reject
    // 我们测的是 serverConfig 缓存：第一次 reject 后再次调不会改 this.serverConfig
    inj.serverConfig = { base: "http://cached", headers: { x: "1" } };
    const cfg = await inj.discover();
    assert.equal(cfg.base, "http://cached");
    assert.equal(cfg.headers.x, "1");
    ok("discover() 返回缓存的 serverConfig（不动 this.serverConfig）");
  }

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}