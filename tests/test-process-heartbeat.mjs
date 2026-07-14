import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProcessHeartbeat } from "../src/core/process-heartbeat.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina ProcessHeartbeat test ===");

const root = mkdtempSync(join(tmpdir(), "korina-proc-hb-"));
const logsDir = join(root, "logs");
let now = 1_800_000_500_000;

try {
  // 1. writeOnce 写文件并保持 schema 兼容
  const hb = new ProcessHeartbeat({
    logsDir,
    version: "0.9.6",
    mode: "worker",
    intervalMs: 100,
    now: () => now,
    getLoader: () => ({ list: () => [{ name: "oc-injector", loaded: true }] }),
    getQueue: () => ({ getStats: () => ({ size: 0, hourlyCount: 0 }) }),
  });

  const result = hb.writeOnce();
  assert.equal(result.ok, true);
  assert.ok(existsSync(hb.file));
  const payload = JSON.parse(readFileSync(hb.file, "utf-8"));
  assert.equal(payload.version, "0.9.6");
  assert.equal(payload.mode, "worker");
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.ts, now);
  assert.ok(Array.isArray(payload.plugins));
  assert.equal(payload.plugins.length, 1);
  assert.equal(payload.plugins[0].name, "oc-injector");
  assert.ok(payload.queue && typeof payload.queue === "object");
  ok("writeOnce 写出 watchdog 兼容字段（ts/pid/version/mode/plugins/queue）");

  // 2. start + 多次 write 仍然合法
  now += 2000;
  hb.start();
  await new Promise((r) => setTimeout(r, 350));
  hb.stop();
  assert.ok(existsSync(hb.file));
  const payload2 = JSON.parse(readFileSync(hb.file, "utf-8"));
  assert.ok(payload2.ts >= now - 2000);
  ok("start 后定时写，再次 stop 不抛错");

  // 3. queue 抛错时 writeOnce 仍能写文件，queue=null
  now += 1000;
  const flaky = new ProcessHeartbeat({
    logsDir: join(root, "flaky"),
    version: "0.9.6",
    intervalMs: 50,
    now: () => now,
    getLoader: () => ({ list: () => [] }),
    getQueue: () => { throw new Error("queue boom"); },
  });
  const safe = flaky.writeOnce();
  assert.equal(safe.ok, true);
  const safePayload = JSON.parse(readFileSync(flaky.file, "utf-8"));
  assert.equal(safePayload.plugins.length, 0);
  assert.equal(safePayload.queue, null);
  ok("queue 抛错时 writeOnce 仍写出空 plugins / null queue（不破坏 watchdog 协议）");

  // 4. loader 抛错时 writeOnce 返回 ok=false，状态记录 error
  now += 1000;
  const broken = new ProcessHeartbeat({
    file: "Z:\\definitely\\missing\\path\\heartbeat.json",
    version: "0.9.6",
    intervalMs: 50,
    now: () => now,
  });
  const failed = broken.writeOnce();
  assert.equal(failed.ok, false);
  assert.ok(failed.error && failed.error.length > 0);
  const status = broken.status();
  assert.equal(status.exists, false);
  assert.equal(status.running, false);
  assert.ok(status.lastError && status.lastError.length > 0);
  ok("路径无效时 writeOnce 记录 lastError 但不抛异常");

  // 5. status 字段完整
  now += 100;
  const status2 = hb.status();
  assert.ok(typeof status2.file === "string");
  assert.ok(status2.exists);
  assert.equal(status2.running, false);
  assert.ok(status2.lastWrite >= now - 5000);
  ok("status() 暴露 file/exists/running/lastWrite/lastError");

  // 6. interval 非法值回落到默认 2000ms
  const fallback = new ProcessHeartbeat({ logsDir, intervalMs: -1 });
  assert.equal(fallback.intervalMs, 2000);
  ok("非法 interval 回落到 2000ms");

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
