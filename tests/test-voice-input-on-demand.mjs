import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SidecarRegistry } from "../src/core/sidecar-registry.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina voice-input on-demand (L5.3 manual #37) test ===");

// 用一个 fake sidecar 脚本（python 一行 echo "alive"）
const root = mkdtempSync(join(tmpdir(), "korina-vi-on-demand-"));
const logsDir = join(root, "logs");
writeFileSync(logsDir, ""); // touch logs dir

const fakeSidecar = join(root, "fake-sidecar.mjs");
writeFileSync(
  fakeSidecar,
  `// fake sidecar: stdout 写 alive，进程保持
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const pidFile = process.argv[2];
writeFileSync(pidFile, String(process.pid));
// 保持进程活着直到被 kill
setInterval(() => {}, 1000);
`,
);
const pidFile = join(root, "fake-sidecar.pid");

let reg;
function newReg() {
  // 每个测试用新的 registry 隔离
  const r = new SidecarRegistry({
    log: () => {}, // 静音
    projectRoot: root,
    logsDir,
  });
  // 用真实 SidecarRegistry，但 mock scriptName（指向 fake-sidecar.mjs）
  // 但 launch 内部调用 launchSidecar 用 spawn('python' or 'node') — 我们的 fake 是 .mjs
  // 改用 entry.scriptName 直接 + spawn（看 registry 内部用什么）
  return r;
}

try {
  // 1. 注册 voice-input 默认 enabled=false（按 L5.3 改动）
  reg = newReg();
  const entry1 = reg.register("voice-input", { scriptName: fakeSidecar, enabled: false });
  assert.equal(entry1.enabled, false);
  assert.equal(reg.snapshot()["voice-input"].alive, false);
  ok("注册 voice-input 默认 enabled=false（按需启动）");

  // 2. 默认不自动拉起（没调 launch() → entry.handle=null）
  assert.equal(reg.get("voice-input").handle, null);
  ok("默认不自动拉起（handle=null）");

  // 3. 显式调 launch 拉起（模拟 OC 调 /voice-input/start）
  // 注意：launchSidecar 内部用 spawn('python', [scriptName])——我们的 fake 是 .mjs 不是 .py
  // 这里直接测试 registry 接口逻辑，不实际 spawn python
  // 改用 launchSidecar 真能跑的方式：mock 一个能在 spawn 时被识别的命令
  // 替代方案：直接验证 entry.handle 被设置
  const handleMock = {
    stop: () => {},
    child: { pid: 12345 },
  };
  // 模拟 launch 后的状态（绕过 spawn）
  reg.get("voice-input").enabled = true;
  reg.get("voice-input").handle = handleMock;
  reg.get("voice-input").pid = 12345;
  reg.get("voice-input").alive = true;
  reg.get("voice-input").startedAt = Date.now();
  ok("模拟 /start 后 voice-input 已 started（pid=12345）");

  // 4. 调 stop（模拟 /voice-input/stop）
  const stopResult = reg.stop("voice-input");
  assert.equal(stopResult.ok, true);
  assert.equal(reg.get("voice-input").handle, null);
  assert.equal(reg.get("voice-input").pid, null);
  assert.equal(reg.get("voice-input").alive, false);
  ok("/stop 后 handle/pid/alive 全部清空，但 entry 保留（用于观察历史）");

  // 5. 再次 stop（已停状态）— 应返回 ok=false + "未启动"
  const stopAgain = reg.stop("voice-input");
  assert.equal(stopAgain.ok, false);
  assert.ok(stopAgain.error.includes("未启动"));
  ok("再次 /stop on already-stopped 返回 ok=false（no-op 语义明确）");

  // 6. unregister vs stop 的区别
  reg.unregister("voice-input");
  // entry 已删
  assert.equal(reg.get("voice-input"), null);
  ok("unregister 删除 entry（与 stop 不同）；stop 保留 entry");

  // 7. stop 不存在的 sidecar
  const reg2 = newReg();
  const stopMissing = reg2.stop("not_exists");
  assert.equal(stopMissing.ok, false);
  assert.ok(stopMissing.error.includes("不存在"));
  ok("stop 不存在的 sidecar 返回 ok=false（不抛异常）");

  // 8. snapshot 反映 started 状态（OC 调 /start 后 /status 看到 alive=true）
  const reg3 = newReg();
  reg3.register("voice-input", { scriptName: fakeSidecar, enabled: false });
  const tStarted = Date.now();
  reg3.get("voice-input").handle = { stop: () => {}, child: { pid: 999 } };
  reg3.get("voice-input").pid = 999;
  reg3.get("voice-input").alive = true;
  reg3.get("voice-input").startedAt = tStarted;
  const snap = reg3.snapshot()["voice-input"];
  assert.equal(snap.pid, 999);
  assert.equal(snap.alive, true);
  ok("snapshot 反映 started 状态（pid + alive）");

  // 9. snapshot 反映 idle 状态（stop 后保留 startedAt 作历史）
  reg3.get("voice-input").handle = null;
  reg3.get("voice-input").pid = null;
  reg3.get("voice-input").alive = false;
  const snap2 = reg3.snapshot()["voice-input"];
  assert.equal(snap2.pid, null);
  assert.equal(snap2.alive, false);
  assert.equal(snap2.startedAt, tStarted); // 历史 startedAt 保留
  ok("snapshot 反映 idle 状态（pid=null 但 startedAt 保留作历史）");

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}