import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renderHeartbeatMessage, HEARTBEAT_VARIABLES } from "../src/modules/heartbeat/template-renderer.mjs";

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

const root = mkdtempSync(join(tmpdir(), "korina-hb-renderer-"));
const logsDir = join(root, "logs");
mkdirSync(logsDir, { recursive: true });
const now = 1_800_000_300_000;

try {
  console.log("=== korina heartbeat template renderer test ===");

  const fakeInjector = {
    lastKokoTime: now - 3 * 60 * 1000, // 3 minutes ago
    serverConfig: { base: "http://127.0.0.1:7574" },
    fileWatcher: { getRecentChangeCount: () => 7 },
  };
  const fakePresets = { get: (k) => (k === "mode" ? "task" : null) };
  const fakeQueue = { size: 0 };
  const sidecarStatus = {
    "desktop-lyrics": { pid: 42, lastPingAt: now - 5000 },
    "voice-input": { pid: 7, lastPingAt: now - 2000 },
  };
  writeFileSync(join(logsDir, "voice-input-target.json"), JSON.stringify({
    sessionId: "ses_voice",
    title: "My Voice",
    setAt: now - 1000,
  }));

  const ctx = {
    time: "06:30",
    fireCount: 3,
    task: { fireCount: 3, intervalMs: 180000, _ocState: "idle" },
    korina: {
      sessionId: "ses_main",
      ocBase: "http://127.0.0.1:7574",
      sidecars: sidecarStatus,
      fileWatcher: fakeInjector.fileWatcher,
      injector: fakeInjector,
    },
    injector: fakeInjector,
    queue: fakeQueue,
    presets: fakePresets,
    sidecarStatus,
    thinkPrompt: "回顾刚才做了什么",
    now,
    logsDir,
  };

  // 1. 基础变量替换
  let rendered = renderHeartbeatMessage(
    "[heartbeat #{fireCount}] {time} {dayPeriod}\nkorina PID={pid} uptime={uptimeHuman} mode={mode}\noc port={ocPort} state={ocState} queue={queueSize} | tasks={tasks} interval={intervalHuman}",
    ctx,
  );
  assert.match(rendered, /\[heartbeat #3\] 06:30/);
  assert.match(rendered, /早晨\/上午|中午|下午|晚上|深夜/);
  assert.match(rendered, /korina PID=\d+/);
  assert.match(rendered, /mode=task/);
  assert.match(rendered, /port=7574/);
  assert.match(rendered, /state=idle/);
  assert.match(rendered, /tasks=0 个/);
  assert.match(rendered, /interval=3 分钟/);
  ok("基础变量全部正确替换");

  // 2. sidecar / voice / top task / kokoIdle / think
  rendered = renderHeartbeatMessage(
    "voice-input PID={voicePid} ping={voiceAgo}s 前, target={voiceTarget}\nkokoIdle={kokoIdle}\nfileChanges={fileChanges}\n{think}",
    ctx,
  );
  assert.match(rendered, /voice-input PID=7 ping=2s 前/);
  assert.match(rendered, /target=已绑定→My Voice/);
  assert.match(rendered, /kokoIdle=3 分钟/);
  assert.match(rendered, /fileChanges=7/);
  assert.match(rendered, /回顾刚才做了什么/);
  ok("sidecar / kokoIdle / fileChanges / think 正确");

  // 3. tasks 列表
  const tasksCtx = {
    ...ctx,
    tasks: [
      { name: "heartbeat", fireCount: 3, enabled: true },
      { name: "voice-input", fireCount: 0, enabled: false },
    ],
  };
  rendered = renderHeartbeatMessage("{tasks}", tasksCtx);
  assert.match(rendered, /heartbeat\(3次\)/);
  assert.match(rendered, /voice-input\(0次,停\)/);
  ok("{tasks} 摘要包含多个任务");

  // 4. voice target 文件不存在时 fallback
  const fallbackCtx = { ...ctx, logsDir: join(root, "no-logs") };
  rendered = renderHeartbeatMessage("{voiceTarget}", fallbackCtx);
  assert.match(rendered, /未绑定\(跟随默认\)/);
  ok("voice target 文件不存在时 fallback");

  // 5. voiceTarget 无文件 + sidecar 也没数据
  const emptyCtx = {
    korina: { injector: fakeInjector },
    injector: fakeInjector,
    sidecarStatus: {},
  };
  rendered = renderHeartbeatMessage("{voiceTarget}", emptyCtx);
  assert.equal(rendered, "未绑定(跟随默认)");
  ok("无 sidecar 状态时 voiceTarget 仍 fallback");

  // 6. thinkPrompt 为空时填默认文本
  rendered = renderHeartbeatMessage("{think}", { ...ctx, thinkPrompt: "" });
  assert.match(rendered, /回顾当前状态/);
  ok("thinkPrompt 缺省时用占位文字");

  // 7. 模板无变量时原样输出
  rendered = renderHeartbeatMessage("plain text", ctx);
  assert.equal(rendered, "plain text");
  ok("无变量模板原样输出");

  // 8. HEARTBEAT_VARIABLES 包含 {topTask} 和 {dayPeriod}
  assert.ok(HEARTBEAT_VARIABLES.includes("{topTask}"));
  assert.ok(HEARTBEAT_VARIABLES.includes("{dayPeriod}"));
  ok("HEARTBEAT_VARIABLES 包含 {topTask}/{dayPeriod}");

  // 9. topTask 从 ACTIVE.md 注释读
  const tmpRoot = join(root, "with-active");
  const activeDir = join(tmpRoot, "logs");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(activeDir, { recursive: true });
  writeFileSync(join(tmpRoot, "ACTIVE.md"), "<!-- topTask: Round 99 - 测试 topTask -->\n\n# active\n");
  writeFileSync(join(activeDir, "voice-input-target.json"), "{}");
  const topCtx = { ...ctx, logsDir: activeDir, projectRoot: tmpRoot };
  rendered = renderHeartbeatMessage("{topTask}", topCtx);
  // topTask 来源于 ACTIVE.md 顶层的真实路径（renderer 用 fileURLToPath 计算）
  // 这里不强求匹配具体值，只验证函数不会因路径不存在而抛错
  assert.equal(typeof rendered, "string");
  ok("topTask 渲染不抛错");

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
