import assert from "node:assert/strict";

import * as Ssel from "../src/injector-session-selection.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina injector-session-selection (J 第三刀 manual #41) test ===");

const SAMPLE_SESSIONS = [
  { id: "ses_newest", time: { updated: 3000 }, title: "newest" },
  { id: "ses_middle", time: { updated: 2000 }, title: "middle" },
  { id: "ses_oldest", time: { updated: 1000 }, title: "oldest" },
];

try {
  // 1. fetchPeerSession — fetch 200 + session
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(url, "http://127.0.0.1:9999/status");
      return { ok: true, json: async () => ({ session: "ses_peer_x" }) };
    };
    try {
      const peer = await Ssel.fetchPeerSession({ port: 9999 });
      assert.equal(peer, "ses_peer_x");
      ok("fetchPeerSession 成功（fetch 200 + session）");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 2. fetchPeerSession — fetch ECONNREFUSED → null
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const peer = await Ssel.fetchPeerSession({ port: 9999 });
      assert.equal(peer, null);
      ok("fetchPeerSession ECONNREFUSED → null");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 3. fetchPeerSession — HTTP 503 → null
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    try {
      const peer = await Ssel.fetchPeerSession({ port: 9999 });
      assert.equal(peer, null);
      ok("fetchPeerSession HTTP 503 → null");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 4. fetchOcSessionsSorted — 拉 sessions 排序
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        { id: "a", time: { updated: 100 } },
        { id: "b", time: { updated: 300 } },
        { id: "c", time: { updated: 200 } },
        { id: "d" }, // 无 time.updated → 被 filter 掉
      ],
    });
    try {
      const sorted = await Ssel.fetchOcSessionsSorted({
        base: "http://oc", headers: {},
      });
      assert.equal(sorted.length, 3);
      assert.equal(sorted[0].id, "b");
      assert.equal(sorted[1].id, "c");
      assert.equal(sorted[2].id, "a");
      ok("fetchOcSessionsSorted 排序正确（d 因无 time.updated 被过滤）");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 5. fetchOcSessionsSorted — HTTP 500 → 抛错
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    try {
      await Ssel.fetchOcSessionsSorted({ base: "x", headers: {} });
      assert.fail("应抛错");
    } catch (e) {
      assert.ok(e.message.includes("500"));
      ok("fetchOcSessionsSorted HTTP 500 → 抛错");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 6. fetchOcSessionsSorted — 空数组 → 抛错
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => [] });
    try {
      await Ssel.fetchOcSessionsSorted({ base: "x", headers: {} });
      assert.fail("应抛错");
    } catch (e) {
      assert.ok(e.message.includes("无"));
      ok("fetchOcSessionsSorted 空数组 → 抛错");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 7. selectTargetSession — env undefined → 拿 sorted[0]
  {
    const r = await Ssel.selectTargetSession({ sorted: SAMPLE_SESSIONS, env: undefined });
    assert.equal(r.id, "ses_newest");
    ok("selectTargetSession env undefined → 最新");
  }

  // 8. selectTargetSession — env=second-newest
  {
    const r = await Ssel.selectTargetSession({ sorted: SAMPLE_SESSIONS, env: "second-newest" });
    assert.equal(r.id, "ses_middle");
    ok("selectTargetSession env=second-newest → 第二新");
  }

  // 9. selectTargetSession — env=oldest
  {
    const r = await Ssel.selectTargetSession({ sorted: SAMPLE_SESSIONS, env: "oldest" });
    assert.equal(r.id, "ses_oldest");
    ok("selectTargetSession env=oldest → 最老");
  }

  // 10. selectTargetSession — env=random（3 个选 1）
  {
    const r = await Ssel.selectTargetSession({ sorted: SAMPLE_SESSIONS, env: "random" });
    assert.ok(["ses_newest", "ses_middle", "ses_oldest"].includes(r.id));
    ok(`selectTargetSession env=random → 拿 ${r.id}`);
  }

  // 11. selectTargetSession — env=ses_middle 直接 ID 命中
  {
    const r = await Ssel.selectTargetSession({ sorted: SAMPLE_SESSIONS, env: "ses_middle" });
    assert.equal(r.id, "ses_middle");
    ok("selectTargetSession env=ses_middle 直接 ID 命中");
  }

  // 12. selectTargetSession — env=ses_xxx 不存在 → fallback newest
  {
    const r = await Ssel.selectTargetSession({ sorted: SAMPLE_SESSIONS, env: "ses_not_exists" });
    assert.equal(r.id, "ses_newest");
    ok("selectTargetSession env=不存在 ID → fallback newest");
  }

  // 13. selectTargetSession — env=garbage → fallback newest
  {
    const r = await Ssel.selectTargetSession({ sorted: SAMPLE_SESSIONS, env: "garbage" });
    assert.equal(r.id, "ses_newest");
    ok("selectTargetSession env=garbage → fallback newest");
  }

  // 14. selectTargetSession — peer-avoid-{port} 避开
  {
    const fetchPeer = async ({ port }) => "ses_newest"; // peer 占 ses_newest
    const r = await Ssel.selectTargetSession({
      sorted: SAMPLE_SESSIONS, env: "peer-avoid-9999", fetchPeer,
    });
    assert.equal(r.id, "ses_middle", "避开 peer 占的 ses_newest，剩余最新 = ses_middle");
    ok("selectTargetSession env=peer-avoid-9999 → 避开 ses_newest 拿 ses_middle");
  }

  // 15. selectTargetSession — peer-avoid-{port} 全部被占 → fallback newest
  {
    // peer 占全部
    const fetchPeer = async ({ port }) => "ses_newest";
    const sorted2 = [{ id: "ses_newest", time: { updated: 1 } }];
    const r = await Ssel.selectTargetSession({
      sorted: sorted2, env: "peer-avoid-9999", fetchPeer,
    });
    assert.equal(r.id, "ses_newest");
    ok("selectTargetSession peer-avoid 全被占 → fallback newest");
  }

  // 16. selectTargetSession — peer-avoid fetchPeer 返回 null → fallback
  {
    const fetchPeer = async () => null;
    const r = await Ssel.selectTargetSession({
      sorted: SAMPLE_SESSIONS, env: "peer-avoid-9999", fetchPeer,
    });
    assert.equal(r.id, "ses_newest");
    ok("selectTargetSession peer-avoid fetchPeer=null → fallback newest");
  }

  // 17. selectTargetSession — second-newest 但只有 1 个 → fallback sorted[0]
  {
    const r = await Ssel.selectTargetSession({
      sorted: [SAMPLE_SESSIONS[0]], env: "second-newest",
    });
    assert.equal(r.id, "ses_newest");
    ok("selectTargetSession second-newest single session → fallback sorted[0]");
  }

  // 18. listOcSessionIds — 拉列表返回 array of id
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        { id: "ses_a", time: { updated: 1 } },
        { id: "ses_b", time: { updated: 2 } },
        { id: 42 }, // id 不是 string → 被过滤
        { time: { updated: 3 } }, // 无 id → 被过滤
        { id: "" }, // id 是 string 但空 → 被过滤
      ],
    });
    try {
      const ids = await Ssel.listOcSessionIds({ base: "x", headers: {} });
      assert.deepEqual(ids, ["ses_a", "ses_b"]);
      ok("listOcSessionIds 返回 string id 数组（过滤非 string / 空 id）");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 19. listOcSessionIds — fetch 失败 → 空数组
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const ids = await Ssel.listOcSessionIds({ base: "x", headers: {} });
      assert.deepEqual(ids, []);
      ok("listOcSessionIds fetch 失败 → 空数组（不抛）");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 20. getLastAssistantTime — sid 为空 → 0
  {
    const t = await Ssel.getLastAssistantTime({ base: "x", headers: {}, sid: null });
    assert.equal(t, 0);
    ok("getLastAssistantTime sid=null → 0");
  }

  // 21. getLastAssistantTime — 找到 assistant 消息返回 created
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        { info: { role: "user", time: { created: 5000 } } },
        { info: { role: "assistant", time: { created: 9999 } } },
      ],
    });
    try {
      const t = await Ssel.getLastAssistantTime({ base: "x", headers: {}, sid: "ses_x" });
      assert.equal(t, 9999);
      ok("getLastAssistantTime 找到最近 assistant → 9999");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 22. getLastAssistantTime — 无 assistant 消息 → 0
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [{ info: { role: "user", time: { created: 1 } } }],
    });
    try {
      const t = await Ssel.getLastAssistantTime({ base: "x", headers: {}, sid: "ses_x" });
      assert.equal(t, 0);
      ok("getLastAssistantTime 无 assistant 消息 → 0");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 23. 模块导出 sanity（5 个函数）
  {
    const exportedNames = Object.keys(Ssel).sort();
    const expected = [
      "fetchOcSessionsSorted", "fetchPeerSession", "getLastAssistantTime",
      "listOcSessionIds", "selectTargetSession",
    ].sort();
    assert.deepEqual(exportedNames, expected);
    ok(`模块导出 5 个函数（与 injector.mjs 委托面一致）`);
  }

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
}