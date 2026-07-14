import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProcessHeartbeat } from "../src/core/process-heartbeat.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina ProcessHeartbeat multi-port (L5.0 manual #30) test ===");

const root = mkdtempSync(join(tmpdir(), "korina-mp-hb-"));
const logsDir = join(root, "logs");
let now = 1_800_000_000_000;
const tick = (ms) => { now += ms; };

try {
  // 1. 默认 port=9999：文件名 = heartbeat.9999.json
  const hb9999 = new ProcessHeartbeat({
    logsDir,
    version: "0.9.8",
    mode: "worker",
    intervalMs: 50,
    now: () => now,
  });
  assert.equal(hb9999.port, 9999);
  assert.equal(hb9999.file, join(logsDir, "heartbeat.9999.json"));
  ok("默认 port=9999 → 文件名 heartbeat.9999.json");

  // 2. 显式 port=10001：文件名 = heartbeat.10001.json
  const hb10001 = new ProcessHeartbeat({
    logsDir,
    port: 10001,
    version: "0.9.8",
    mode: "worker",
    intervalMs: 50,
    now: () => now,
  });
  assert.equal(hb10001.port, 10001);
  assert.equal(hb10001.file, join(logsDir, "heartbeat.10001.json"));
  ok("显式 port=10001 → 文件名 heartbeat.10001.json");

  // 3. 两个实例写心跳不冲突：写不同文件
  tick(1000);
  const r1 = hb9999.writeOnce();
  const r2 = hb10001.writeOnce();
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.ok(existsSync(hb9999.file), "hb9999 文件存在");
  assert.ok(existsSync(hb10001.file), "hb10001 文件存在");

  // 4. 两个文件内容各自独立（PID、port 等）
  const p1 = JSON.parse(readFileSync(hb9999.file, "utf-8"));
  const p2 = JSON.parse(readFileSync(hb10001.file, "utf-8"));
  assert.equal(p1.pid, process.pid);
  assert.equal(p2.pid, process.pid);
  // 两个 payload 都是同一进程（测试进程），但文件名隔离说明 port 维度是隔离的
  assert.ok(p1.ts && p2.ts);
  assert.equal(p1.version, "0.9.8");
  assert.equal(p2.version, "0.9.8");
  ok("两个实例写不同文件，互不覆盖");

  // 5. 显式传 file 时优先用 file（向后兼容测试）
  const customFile = join(logsDir, "custom-heartbeat.json");
  const hbCustom = new ProcessHeartbeat({
    logsDir,
    port: 9999,
    file: customFile,
    intervalMs: 50,
    now: () => now,
  });
  assert.equal(hbCustom.file, customFile);
  ok("显式传 file 时优先用 file（向后兼容）");

  // 6. logsDir 下文件列表确认只有 2 个实例文件
  const files = readdirSync(logsDir).filter(f => f.startsWith("heartbeat.") && f.endsWith(".json"));
  assert.equal(files.length, 2, "应该有 2 个 heartbeat.*.json 文件");
  assert.ok(files.includes("heartbeat.9999.json"));
  assert.ok(files.includes("heartbeat.10001.json"));
  ok("logsDir 下两个文件独立（heartbeat.9999.json + heartbeat.10001.json）");

  // 7. start + stop：两个实例并行运行不冲突
  tick(1000);
  hb9999.start();
  hb10001.start();
  await new Promise((r) => setTimeout(r, 150));
  const s1 = JSON.parse(readFileSync(hb9999.file, "utf-8"));
  const s2 = JSON.parse(readFileSync(hb10001.file, "utf-8"));
  assert.ok(s1.ts >= now, "hb9999 心跳更新");
  assert.ok(s2.ts >= now, "hb10001 心跳更新");
  assert.equal(hb9999.status().running, true);
  assert.equal(hb10001.status().running, true);
  hb9999.stop();
  hb10001.stop();
  assert.equal(hb9999.status().running, false);
  assert.equal(hb10001.status().running, false);
  ok("两实例并行 start/stop 不冲突");

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}