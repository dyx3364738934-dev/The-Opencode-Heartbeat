/**
 * tests/test-e2e.mjs
 *
 * 端到端测试：感知 -> 队列 -> 注入 -> （dry-run 不等待回复）
 *
 * 这个测试验证整条链路除了"等待 oc 回复"以外的所有环节：
 *   1. 创建临时文件触发 file-watcher
 *   2. 事件入队（令牌桶放行）
 *   3. 调度器取出事件
 *   4. injector.discover() 找到 oc server
 *   5. injector.resolveSession() 找到 session
 *   6. 构造注入消息（dry-run 模式只打印不实际 POST）
 *
 * 用法：node tests/test-e2e.mjs
 */

import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

import { EventQueue, PRIORITY } from "../src/core/event-queue.mjs";
import { Injector } from "../src/injector.mjs";
import { FileWatcher } from "../plugins/file-watcher/plugin.mjs";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

async function main() {
  console.log("=== korina 端到端测试 ===\n");

  // --- 阶段 1: 注入区发现 oc ---
  console.log("--- 阶段 1: 注入区发现 oc server ---");
  const injector = new Injector();
  try {
    const server = await injector.discover();
    console.log(`  server: ${server.base}`);
    assert(true, "discover() 成功");

    const sid = await injector.resolveSession();
    console.log(`  session: ${sid}`);
    assert(!!sid, "resolveSession() 返回 session id");
  } catch (e) {
    console.log(`  ERR: ${e.message}`);
    assert(false, "discover() 成功");
    console.log("\n（oc 未运行或环境变量缺失，跳过后续测试）");
    return finish();
  }

  // --- 阶段 2: 感知层触发 ---
  console.log("\n--- 阶段 2: 文件感知器触发 ---");
  const testDir = join(tmpdir(), "korina-e2e-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const testFile = join(testDir, "trigger.txt");

  const queue = new EventQueue({
    maxBurst: 100,
    refillRate: 100,
    hourlyLimit: 1000,
    debounceMs: 300,
  });

  const watcher = new FileWatcher(queue, {
    paths: [testDir],
    debounceMs: 200,
  });

  // start() 内部会等 chokidar ready
  await watcher.start();
  console.log(`  watcher ready, 监听: ${testDir}`);

  // 创建文件触发事件
  console.log("  写入测试文件...");
  writeFileSync(testFile, "hello korina\n");

  // v0.9.3: Windows 上 chokidar + awaitWriteFinish(500ms) 检测较慢
  // 原 1000ms 不够，等 3000ms
  await sleep(3000);

  assert(queue.size > 0, `队列收到事件 (size=${queue.size})`);

  // --- 阶段 3: 调度 + 构造消息 ---
  console.log("\n--- 阶段 3: 调度取出 + 消息构造 ---");
  const event = queue.pop();
  assert(event !== null, "pop 返回事件");
  if (event) {
    console.log(`  event: ${event.source}/${event.type} payload=${JSON.stringify(event.payload).slice(0, 100)}`);
    assert(event.source === "file-watcher", `source=file-watcher (实际 ${event.source})`);
    assert(event.type === "file.changed", `type=file.changed (实际 ${event.type})`);
    assert(event.payload.path.includes("trigger.txt"), `path 包含 trigger.txt`);

    // 构造注入消息（不实际发送）
    const message = formatEventMessage(event);
    console.log(`  构造消息: ${message.slice(0, 120)}...`);
    assert(message.includes("korina 感知"), "消息包含 korina 标识");
    assert(message.includes("trigger.txt"), "消息包含文件名");
  }

  // --- 阶段 4: 令牌桶统计 ---
  console.log("\n--- 阶段 4: 代谢率统计 ---");
  const stats = queue.getStats();
  console.log(`  stats: ${JSON.stringify(stats)}`);
  assert(stats.enqueued >= 1, `enqueued>=1 (实际 ${stats.enqueued})`);
  assert(stats.dispatched >= 1, `dispatched>=1 (实际 ${stats.dispatched})`);

  // 清理
  watcher.stop();
  try {
    unlinkSync(testFile);
  } catch {}

  return finish();
}

function formatEventMessage(event) {
  switch (event.type) {
    case "file.changed":
      return `[korina 感知] 文件变化：${event.payload.event} ${event.payload.path} (size=${event.payload.size})。\n请判断这个变化是否需要处理。如果需要，用可用工具分析或操作；如果不需要，回复：[korina] 忽略。`;
    default:
      return `[korina] 事件 ${event.type}: ${JSON.stringify(event.payload).slice(0, 200)}`;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function finish() {
  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("致命错误:", e);
  process.exit(1);
});
