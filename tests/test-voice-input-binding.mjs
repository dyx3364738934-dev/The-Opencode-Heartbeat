import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import voiceInputPlugin from "../plugins/voice-input/plugin.mjs";
import { SessionBindingStore } from "../src/state/session-binding-store.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

class FakeHttp {
  constructor() {
    this.routes = new Map();
  }
  post(path, handler) { this.routes.set(`POST ${path}`, handler); }
  get(path, handler) { this.routes.set(`GET ${path}`, handler); }
  delete(path, handler) { this.routes.set(`DELETE ${path}`, handler); }
  route(method, path) { return this.routes.get(`${method} ${path}`); }
}

const root = mkdtempSync(join(tmpdir(), "korina-voice-input-"));
const logsDir = join(root, "logs");
const now = 1_800_000_200_000;

try {
  console.log("=== korina voice-input binding store integration test ===");

  const http = new FakeHttp();
  const pushed = [];
  const bindingStore = new SessionBindingStore({ logsDir, now: () => now });
  bindingStore.setPrimarySessionId("ses_primary");

  let listCalls = 0;
  const fakeInjector = {
    serverConfig: null,
    async listOcSessionIds() {
      listCalls++;
      return ["ses_primary", "ses_voice"];
    },
  };

  await voiceInputPlugin.init({
    queue: { push: (...args) => pushed.push(args) },
    http,
    korina: {
      sessionId: "ses_primary",
      bindingStore,
      injector: fakeInjector,
      ttsQueue: [],
    },
    log: () => {},
  });
  assert.equal(listCalls, 1);
  ok("voice-input init validates voice target against oc session list");

  const bind = http.route("POST", "/voice-input/bind");
  const getBind = http.route("GET", "/voice-input/bind");
  const unbind = http.route("DELETE", "/voice-input/bind");
  const stt = http.route("POST", "/stt/text");

  let result = await bind({ sessionId: "ses_voice" });
  assert.equal(result.ok, true);
  assert.equal(bindingStore.getVoiceTargetSessionId(), "ses_voice");
  assert.equal(getBind().bound, true);
  assert.equal(getBind().sessionId, "ses_voice");
  ok("POST/GET /voice-input/bind use SessionBindingStore voice target");

  result = stt({ text: "hello" });
  assert.equal(result.ok, true);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0][2].sessionId, "ses_voice");
  assert.equal(pushed[0][2].source, "koko");
  ok("/stt/text targets explicit voice target before primary session");

  result = unbind();
  assert.equal(result.ok, true);
  assert.equal(bindingStore.getVoiceTargetSessionId(), null);
  assert.equal(getBind().bound, false);
  ok("DELETE /voice-input/bind clears SessionBindingStore voice target");

  stt({ text: "fallback" });
  assert.equal(pushed[1][2].sessionId, "ses_primary");
  ok("/stt/text falls back to korina primary session after unbind");

  // 第二次 init：写入 stale voice target（已不在 oc list），验证会被清除
  bindingStore.setVoiceTargetSessionId("ses_voice_stale", { title: "Stale", persist: true });
  assert.equal(bindingStore.getVoiceTargetSessionId(), "ses_voice_stale");
  const http2 = new FakeHttp();
  const http2Logged = [];
  await voiceInputPlugin.init({
    queue: { push: () => {} },
    http: http2,
    korina: {
      sessionId: "ses_primary",
      bindingStore,
      injector: {
        serverConfig: null,
        async listOcSessionIds() { return ["ses_primary"]; },
      },
      ttsQueue: [],
    },
    log: (msg) => http2Logged.push(msg),
  });
  assert.equal(bindingStore.getVoiceTargetSessionId(), null);
  assert.ok(http2Logged.some((m) => m.includes("旧 voice target 已清除")), "stale target cleanup is logged");
  ok("voice-input init clears stale voice target not in oc session list");

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
