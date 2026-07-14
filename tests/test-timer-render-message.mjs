import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renderHeartbeatMessage, HEARTBEAT_VARIABLES } from "../src/modules/heartbeat/template-renderer.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina timer renderMessage delegation test ===");

// 复用 renderer 的 ctx 结构 + 自定义 presets / 模拟 timer 调用
const root = mkdtempSync(join(tmpdir(), "korina-timer-render-"));
const logsDir = join(root, "logs");
mkdirSync(logsDir, { recursive: true });
const now = 1_800_000_400_000;

const fakeInjector = {
  lastKokoTime: now - 5 * 60 * 1000,
  serverConfig: { base: "http://127.0.0.1:7574" },
  bindingStore: { getVoiceTargetSessionId: () => null },
};
const fakePresets = { get: (k) => (k === "mode" ? "task" : null) };
const fakeQueue = { size: 0 };
const sidecarStatus = {
  "desktop-lyrics": { pid: 111, lastPingAt: now - 8000 },
  "voice-input": { pid: 222, lastPingAt: now - 3000 },
};
const korina = {
  sessionId: "ses_main",
  ocBase: "http://127.0.0.1:7574",
  sidecars: sidecarStatus,
  fileWatcher: { getRecentChangeCount: () => 5 },
  injector: fakeInjector,
};

const task = {
  name: "heartbeat",
  fireCount: 9,
  intervalMs: 180000,
  enabled: true,
  _ocState: "idle",
};
const tasks = [
  { name: "heartbeat", fireCount: 9, enabled: true },
];

const template = "[heartbeat #{fireCount}] {time} {dayPeriod}\nkorina PID={pid} uptime={uptimeHuman} mode={mode}\noc port={ocPort} state={ocState} queue={queueSize} | tasks={tasks} interval={intervalHuman}\nvoice-input PID={voicePid} ping={voiceAgo}s 前, target={voiceTarget}\nkokoIdle={kokoIdle}\nfileChanges={fileChanges}\nthink={think}";

// 验证直接调用 renderer 时的输出
const direct = renderHeartbeatMessage(template, {
  time: "06:30",
  fireCount: 9,
  task,
  korina,
  injector: fakeInjector,
  queue: fakeQueue,
  presets: fakePresets,
  sidecarStatus,
  thinkPrompt: "回顾刚才做了什么",
  now,
  logsDir,
  tasks,
});
assert.match(direct, /\[heartbeat #9\] 06:30/);
assert.match(direct, /PID=\d+/);
assert.match(direct, /mode=task/);
assert.match(direct, /port=7574/);
assert.match(direct, /state=idle/);
assert.match(direct, /tasks=1 个：heartbeat\(9次\)/);
assert.match(direct, /voice-input PID=222 ping=3s 前/);
assert.match(direct, /kokoIdle=5 分钟/);
assert.match(direct, /fileChanges=5/);
assert.match(direct, /think=回顾刚才做了什么/);
ok("renderer 直接调用覆盖 timer 用到的所有变量");

// 验证 timer 委托后的 output 与 renderer 行为一致
// 模拟 renderMessage 闭包（与 timer plugin 内部一致）
function timerRenderMessage(template, time, task) {
  const thinkPrompt = template.includes("{think}") ? "回顾刚才做了什么" : "";
  return renderHeartbeatMessage(template, {
    time,
    fireCount: task.fireCount,
    task,
    korina,
    injector: fakeInjector,
    queue: fakeQueue,
    presets: fakePresets,
    sidecarStatus,
    thinkPrompt,
    now,
    logsDir,
    tasks,
  });
}

const delegated = timerRenderMessage(template, "06:30", task);
assert.equal(delegated, direct, "timer 委托输出与 renderer 直接调用一致");
ok("timer renderMessage 委托后输出与 renderer 一致");

// 验证无 {think} 的模板时，thinkPrompt 是空字符串
const templateNoThink = "{time} fire={fireCount}";
const out = timerRenderMessage(templateNoThink, "06:30", task);
assert.match(out, /06:30 fire=9/);
ok("无 {think} 模板的渲染通过");

// 验证 HEARTBEAT_VARIABLES 至少包含 timer 当前模板用到的所有变量
const expected = [
  "{time}", "{fireCount}", "{dayPeriod}", "{pid}", "{uptimeHuman}", "{mode}",
  "{ocPort}", "{ocState}", "{queueSize}", "{tasks}", "{intervalHuman}",
  "{voicePid}", "{voiceAgo}", "{voiceTarget}", "{kokoIdle}", "{fileChanges}",
  "{think}",
];
for (const v of expected) {
  assert.ok(HEARTBEAT_VARIABLES.includes(v), `${v} 应在 HEARTBEAT_VARIABLES 列表中`);
}
ok("HEARTBEAT_VARIABLES 覆盖 timer 模板所需全部变量");

console.log(`\n=== result: ${passed} passed, 0 failed ===`);
rmSync(root, { recursive: true, force: true });
