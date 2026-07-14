import assert from "node:assert/strict";

import { SidecarRegistry } from "../src/core/sidecar-registry.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina SidecarRegistry test ===");

// 1. 基础 register / snapshot
const logs = [];
const reg = new SidecarRegistry({ log: (msg) => logs.push(msg) });
const entry = reg.register("voice-input", { scriptName: "voice-input.py", enabled: true });
assert.equal(entry.name, "voice-input");
assert.equal(entry.scriptName, "voice-input.py");
assert.equal(entry.enabled, true);
assert.equal(entry.pid, null);
assert.equal(entry.alive, false);
ok("register 创建 entry，初始 pid/alive 为空");

assert.equal(reg.get("voice-input"), entry);
assert.deepEqual(reg.list(), ["voice-input"]);
const snap1 = reg.snapshot();
assert.equal(snap1["voice-input"].scriptName, "voice-input.py");
assert.equal(snap1["voice-input"].pid, null);
ok("snapshot 暴露每个 entry 的 scriptName / pid / alive");

// 2. launch 失败（scriptName 不存在）— 路径不存在返回 { ok: false, entry, error }
const failed = reg.launch("voice-input", { projectRoot: "C:\\nonexistent", logsDir: "C:\\nonexistent" });
assert.equal(failed.ok, false);
assert.equal(failed.entry.name, "voice-input");
ok("scriptName 不存在时 launch 返回 ok=false 但 entry 保留");

// 3. ping 端到端
let pingedName = null;
const pingResult = reg.recordPing("voice-input");
assert.equal(pingResult.ok, true);
assert.equal(pingedName, null); // 没注册 ping 端点只是数据记录
assert.ok(reg.get("voice-input").lastPingAt > 0);
ok("recordPing 更新 lastPingAt");

// 4. unregister 清空 entry（handle 不存在时不会报错）
const unreg = reg.unregister("voice-input");
assert.equal(unreg.ok, true);
assert.equal(reg.get("voice-input"), null);
ok("unregister 删除 entry");

// 5. startHealthCheck / stopHealthCheck 幂等
const h1 = reg.startHealthCheck();
assert.equal(h1.started, true);
const h2 = reg.startHealthCheck();
assert.equal(h2.alreadyRunning, true);
const h3 = reg.stopHealthCheck();
assert.equal(h3.stopped, true);
const h4 = reg.stopHealthCheck();
assert.equal(h4.alreadyStopped, true);
ok("startHealthCheck / stopHealthCheck 幂等");

// 6. register name 校验
assert.throws(() => reg.register(""), /name 必填/);
assert.throws(() => reg.register(123), /name 必填/);
ok("register 拒绝空 / 非字符串 name");

const replaced = reg.register("dup", { replace: true, scriptName: "b.py" });
assert.equal(replaced.scriptName, "b.py");
ok("register replace=true 覆盖旧 entry");

// 7. unregister 未知 name
const missing = reg.unregister("nonexistent");
assert.equal(missing.ok, false);
ok("unregister 未知 name 返回 ok=false");

// 8. recordPing 未知 name
const pingMissing = reg.recordPing("nonexistent");
assert.equal(pingMissing.ok, false);
ok("recordPing 未知 name 返回 ok=false");

// 9. launch 显式 disabled
const disabledReg = new SidecarRegistry({ log: () => {} });
disabledReg.register("voice-input", { scriptName: "voice-input.py" });
const skip = disabledReg.launch("voice-input", { enabled: false });
assert.equal(skip.ok, true);
assert.equal(skip.skipped, true);
assert.equal(skip.entry.enabled, false);
ok("launch({ enabled: false }) 跳过拉起并标记 disabled");

// 10. stopAll 不抛错
const reg2 = new SidecarRegistry({ log: () => {} });
reg2.register("a", { scriptName: "a.py" });
reg2.register("b", { scriptName: "b.py" });
reg2.startHealthCheck();
const stop = await reg2.stopAll(500);
assert.equal(stop.ok, true);
assert.deepEqual(stop.stopped.sort(), ["a", "b"]);
ok("stopAll 异步关闭所有 entry，不抛错");

console.log(`\n=== result: ${passed} passed, 0 failed ===`);
