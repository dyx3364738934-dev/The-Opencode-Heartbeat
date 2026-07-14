import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { Injector } from "../src/injector.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina session selection strategy (L5.1 manual #35) test ===");

// 真实 sorted 数据：3 个 session，按 updated 倒序
const SESSIONS = [
  { id: "ses_newest",  time: { updated: 3000 }, title: "newest" },
  { id: "ses_middle",  time: { updated: 2000 }, title: "middle" },
  { id: "ses_oldest",  time: { updated: 1000 }, title: "oldest" },
];

// 临时 oc server：返回固定 sessions 列表
async function withOc(handler, fn) {
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

async function withFakePeer(peerPort, peerSession, fn) {
  const server = createServer((req, res) => {
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ session: peerSession }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(peerPort, "127.0.0.1");
  await once(server, "listening");
  const actualPort = server.address().port; // peerPort=0 → OS picks free port
  try {
    await fn(actualPort);
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
  }
}

// 公共：构造 Injector mock
function makeInjector({ port = 9999, sessionLockFile } = {}) {
  const inj = new Injector({
    persistSession: false,
    port,
    sessionLockFile,
  });
  // 模拟 serverConfig.discover() 返回的 baseUrl
  inj.serverConfig = { base: "http://127.0.0.1:0", headers: {} };
  // 直接替换 _selectTargetSession 内的 fetch 行为通过 serverConfig
  return inj;
}

// 用真实 sorted sessions（绕过 oc fetch）测 _selectTargetSession 纯逻辑
async function testSelect(inj, sorted) {
  return await inj._selectTargetSession(sorted);
}

try {
  // 1. env 未设 → sorted[0]（最新，向后兼容）
  delete process.env.KORINA_BIND_SESSION;
  const inj1 = makeInjector();
  const r1 = await testSelect(inj1, SESSIONS);
  assert.equal(r1.id, "ses_newest");
  ok("env 未设 → 拿最新（向后兼容）");

  // 2. env=second-newest → sorted[1]
  process.env.KORINA_BIND_SESSION = "second-newest";
  const inj2 = makeInjector();
  const r2 = await testSelect(inj2, SESSIONS);
  assert.equal(r2.id, "ses_middle");
  ok("env=second-newest → 拿第二新");

  // 3. env=oldest → sorted[N-1]
  process.env.KORINA_BIND_SESSION = "oldest";
  const inj3 = makeInjector();
  const r3 = await testSelect(inj3, SESSIONS);
  assert.equal(r3.id, "ses_oldest");
  ok("env=oldest → 拿最老");

  // 4. env=random → 拿一个（不是 sorted[0]）
  process.env.KORINA_BIND_SESSION = "random";
  const inj4 = makeInjector();
  const r4 = await testSelect(inj4, SESSIONS);
  assert.ok(["ses_newest", "ses_middle", "ses_oldest"].includes(r4.id));
  ok(`env=random → 拿 ${r4.id}（3 选 1）`);

  // 5. env=ses_middle（直接 ID） → 命中
  process.env.KORINA_BIND_SESSION = "ses_middle";
  const inj5 = makeInjector();
  const r5 = await testSelect(inj5, SESSIONS);
  assert.equal(r5.id, "ses_middle");
  ok("env=ses_middle（直接 ID） → 命中");

  // 6. env=ses_xxx（不存在的 ID） → 回落拿最新
  process.env.KORINA_BIND_SESSION = "ses_not_exists";
  const inj6 = makeInjector();
  const r6 = await testSelect(inj6, SESSIONS);
  assert.equal(r6.id, "ses_newest");
  ok("env=不存在的 ID → 回落拿最新");

  // 7. env=garbage（无法识别） → 回落拿最新
  process.env.KORINA_BIND_SESSION = "garbage_value";
  const inj7 = makeInjector();
  const r7 = await testSelect(inj7, SESSIONS);
  assert.equal(r7.id, "ses_newest");
  ok("env=无法识别的值 → 回落拿最新");

  // 8. env=peer-avoid-{port}，peer 不在跑 → 回落拿最新
  process.env.KORINA_BIND_SESSION = "peer-avoid-1";
  const inj8 = makeInjector();
  const r8 = await testSelect(inj8, SESSIONS);
  assert.equal(r8.id, "ses_newest");
  ok("env=peer-avoid-1（peer 不在跑） → 回落拿最新");

  // 9. env=second-newest 但只有 1 个 session → fallback sorted[0]
  process.env.KORINA_BIND_SESSION = "second-newest";
  const inj9 = makeInjector();
  const r9 = await testSelect(inj9, [SESSIONS[0]]);
  assert.equal(r9.id, "ses_newest");
  ok("second-newest 但只有 1 个 session → fallback sorted[0]");

  // 10. env=peer-avoid-{port}，peer 在跑且有 session → 避开它（happy path）
  // 这是 peer-avoid 真正的成功路径 —— 之前只有 peer 不在跑的回落分支
  await withFakePeer(0, "ses_newest", async (actualPort) => {
    process.env.KORINA_BIND_SESSION = `peer-avoid-${actualPort}`;
    const inj10 = makeInjector();
    const r10 = await testSelect(inj10, SESSIONS);
    assert.equal(r10.id, "ses_middle", `peer-avoid-${actualPort} 应避开 ses_newest，绑 ses_middle`);
    ok(`env=peer-avoid-${actualPort}（peer 占 ses_newest）→ 避开它，绑 ses_middle`);
  });

  // 11. env=peer-avoid-{port}，peer 占中间 session → 避开它，绑剩余最新
  await withFakePeer(0, "ses_middle", async (actualPort) => {
    process.env.KORINA_BIND_SESSION = `peer-avoid-${actualPort}`;
    const inj11 = makeInjector();
    const r11 = await testSelect(inj11, SESSIONS);
    assert.equal(r11.id, "ses_newest", `peer-avoid-${actualPort} 应避开 ses_middle，绑 ses_newest`);
    ok(`env=peer-avoid-${actualPort}（peer 占 ses_middle）→ 避开它，绑 ses_newest`);
  });

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
} finally {
  delete process.env.KORINA_BIND_SESSION;
}