import assert from "node:assert/strict";

import { LifelineRuntime } from "../src/lifeline/lifeline-runtime.mjs";
import { LifelineRegistry } from "../src/lifeline/lifeline-registry.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina LifelineRuntime/Registry test ===");

const calls = [];
const bindingStore = {
  primary: "ses_main",
  bound: ["ses_main"],
  getPrimarySessionId() { return this.primary; },
  listBoundSessionIds() { return [...this.bound]; },
};
const injector = {
  sessionId: "ses_main",
  serverConfig: { base: "http://127.0.0.1:7574" },
  bindingStore,
  bindSession(sessionId) {
    if (!bindingStore.bound.includes(sessionId)) bindingStore.bound.push(sessionId);
    return { ok: true, sessionId, total: bindingStore.bound.length };
  },
  unbindSession(sessionId) {
    bindingStore.bound = bindingStore.bound.filter((sid) => sid !== sessionId);
    if (bindingStore.primary === sessionId) bindingStore.primary = bindingStore.bound[0] || null;
    return { ok: true, sessionId, total: bindingStore.bound.length };
  },
  async inject(text, opts) { calls.push(["inject", text, opts]); return { ok: true }; },
  async silentInject(text, opts) { calls.push(["silentInject", text, opts]); return true; },
  async injectAndWait(text, onProgress, opts) { calls.push(["injectAndWait", text, opts]); return { text: "reply" }; },
};

const lifeline = new LifelineRuntime({ id: "main", injector, metadata: { role: "primary" } });
assert.equal(lifeline.primarySessionId, "ses_main");
assert.equal(lifeline.ocBase, "http://127.0.0.1:7574");
assert.deepEqual(lifeline.listBoundSessionIds(), ["ses_main"]);
ok("LifelineRuntime exposes primary session, bound sessions and ocBase");

lifeline.registerModule("heartbeat", { enabled: true });
lifeline.registerModule("voice-input", { enabled: true });
assert.deepEqual(lifeline.listModules(), ["heartbeat", "voice-input"]);
ok("LifelineRuntime registers and lists modules");

let result = lifeline.bindSession("ses_extra");
assert.equal(result.ok, true);
assert.deepEqual(lifeline.listBoundSessionIds(), ["ses_main", "ses_extra"]);
result = lifeline.unbindSession("ses_main");
assert.equal(result.ok, true);
assert.equal(lifeline.primarySessionId, "ses_extra");
ok("LifelineRuntime delegates session changes to injector/store");

await lifeline.inject("hello", { sessionId: "ses_extra" });
await lifeline.silentInject("quiet", { intent: "self-direct" });
const reply = await lifeline.injectAndWait("wait", null, {});
assert.equal(reply.text, "reply");
assert.equal(calls.length, 3);
ok("LifelineRuntime delegates inject paths to existing injector");

const status = lifeline.status();
assert.equal(status.id, "main");
assert.equal(status.primarySessionId, "ses_extra");
assert.deepEqual(status.modules, ["heartbeat", "voice-input"]);
ok("LifelineRuntime status is serializable and uses current state");

const registry = new LifelineRegistry();
result = registry.register(lifeline, { primary: true });
assert.equal(result.ok, true);
assert.equal(registry.getPrimary(), lifeline);
assert.deepEqual(registry.ids(), ["main"]);
ok("LifelineRegistry registers primary lifeline");

const secondary = new LifelineRuntime({ id: "secondary", injector });
registry.register(secondary);
assert.equal(registry.get("secondary"), secondary);
assert.equal(registry.getPrimary(), lifeline);
registry.setPrimary("secondary");
assert.equal(registry.getPrimary(), secondary);
assert.equal(registry.list().length, 2);
ok("LifelineRegistry supports multiple lifelines and primary switch");

result = registry.unregister("secondary");
assert.equal(result.ok, true);
assert.equal(registry.getPrimary(), lifeline);
ok("LifelineRegistry unregister promotes remaining lifeline");

console.log(`\n=== result: ${passed} passed, 0 failed ===`);
