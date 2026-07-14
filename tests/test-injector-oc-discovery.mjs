import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Ocd from "../src/injector-oc-discovery.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina injector-oc-discovery (J 第一刀 manual #39) test ===");

const root = mkdtempSync(join(tmpdir(), "korina-ocd-"));
const logsDir = join(root, "logs");
import { mkdirSync } from "node:fs";
mkdirSync(logsDir, { recursive: true });

try {
  // 1. readPasswordFile — 文件不存在 → null
  const r1 = Ocd.readPasswordFile({ logsDir });
  assert.equal(r1, null);
  ok("readPasswordFile 文件不存在 → null");

  // 2. readPasswordFile — 内容无效 JSON → null
  writeFileSync(join(logsDir, "oc-password.txt"), "not-json{");
  const r2 = Ocd.readPasswordFile({ logsDir });
  assert.equal(r2, null);
  ok("readPasswordFile 无效 JSON → null");

  // 3. readPasswordFile — 内容有效 → 返回解析结果
  const validPwd = {
    password: "b4640ec4-5b94-41f6-a51e-b1f420e791cd",
    username: "opencode",
    port: "",
    leakedAt: 1783782833994,
  };
  writeFileSync(join(logsDir, "oc-password.txt"), JSON.stringify(validPwd));
  const r3 = Ocd.readPasswordFile({ logsDir });
  assert.equal(r3.password, validPwd.password);
  assert.equal(r3.username, validPwd.username);
  ok("readPasswordFile 有效 JSON → 返回 password + username");

  // 4. tryPort — fetch 200 → true
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assert.ok(url.includes("/global/health"));
      assert.ok(init.headers.Authorization.startsWith("Basic "));
      return { ok: true, status: 200 };
    };
    try {
      const r = await Ocd.tryPort({ port: 9999, auth: "Basic dGVzdA==" });
      assert.equal(r, true);
      ok("tryPort fetch 200 → true");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 5. tryPort — fetch 503 → false
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    try {
      const r = await Ocd.tryPort({ port: 9999, auth: "Basic xxx" });
      assert.equal(r, false);
      ok("tryPort fetch 503 → false");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 6. tryPort — fetch 抛错（ECONNREFUSED）→ false
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const r = await Ocd.tryPort({ port: 9999, auth: "Basic xxx" });
      assert.equal(r, false);
      ok("tryPort fetch 抛错 → false");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 7. discover — 有 cachedServerConfig 直接返回（不调 waitForPassword）
  {
    const cached = { port: 9999, auth: "Basic xxx", base: "http://127.0.0.1:9999", headers: {} };
    const r = await Ocd.discover({ logsDir, projectRoot: root, cachedServerConfig: cached });
    assert.equal(r, cached);
    ok("discover cachedServerConfig 直接返回（不重新探测）");
  }

  // 8. discover — 无 cached → 走 ensureOCAndDiscover（真实环境有 oc 跑，所以会成功）
  // 这个测试在真实环境会成功（找到真 oc）；在 CI/无 oc 环境会抛错
  // 我们断言"返回 serverConfig 或抛错"都算合理
  {
    let result;
    let err;
    try {
      result = await Ocd.discover({ logsDir, projectRoot: root });
    } catch (e) {
      err = e;
    }
    if (err) {
      assert.ok(err.message.includes("找不到 OpenCode.exe") || err.message.includes("密码") || err.message.includes("超时"),
        `unexpected error: ${err.message}`);
      ok("discover 无 cached + 无 oc 环境 → 抛合理错（找不到 exe 或密码超时）");
    } else {
      assert.ok(result.port > 0, `应返回有效 serverConfig: port=${result.port}`);
      assert.ok(result.base.startsWith("http://"), `base 应是 http url: ${result.base}`);
      ok(`discover 无 cached → 走 ensureOCAndDiscover 找到 oc (port=${result.port})`);
    }
  }

  // 9. findPortsByProcess — execSync netstat + tasklist 真调用（环境验证）
  // 不假设有 oc 跑，只测函数返回 array（可能是空）
  {
    const ports = Ocd.findPortsByProcess({ processName: "OpenCode.exe" });
    assert.ok(Array.isArray(ports), "返回数组");
    ok(`findPortsByProcess 真调用返回 array（length=${ports.length}）`);
  }

  // 10. 模块导出数量（防止意外 export 被改）
  {
    const exportedNames = Object.keys(Ocd).sort();
    const expected = [
      "discover", "ensureOCAndDiscover", "findPortsByProcess",
      "findPortsByProcessAsync", "isOCRunning", "isOCRunningAsync",
      "readPasswordFile", "spawnOC", "tryPort", "waitForPassword",
    ].sort();
    assert.deepEqual(exportedNames, expected);
    ok(`模块导出 10 个函数（与 injector.mjs 委托面一致）`);
  }

  // 11. discover 签名接受 timeoutMs（间接通过 waitForPassword）
  {
    // 验证 Ocd.discover 不接受 timeoutMs（设计：只透传 maxWaitMs）
    // 通过调用确保不抛 schema 错
    const cached = { port: 1, auth: "a", base: "b", headers: {} };
    const r = await Ocd.discover({ logsDir, projectRoot: root, cachedServerConfig: cached });
    assert.equal(r.port, 1);
    ok("discover 签名稳定（cached 路径无 maxWaitMs 参数）");
  }

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}