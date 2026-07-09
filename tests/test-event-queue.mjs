/**
 * tests/test-event-queue.mjs
 *
 * 测试事件队列的令牌桶 + 去抖 + 优先级调度
 */

import { EventQueue, PRIORITY } from "../src/event-queue.mjs";

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

async function testBasicPushPop() {
  console.log("\n--- 测试 1: 基本入队出队 ---");
  const q = new EventQueue({ debounceMs: 0 }); // 关闭去抖方便测试
  const id = q.push("test", "ping", { msg: "hello" }, PRIORITY.NORMAL);
  assert(id !== null, "push 返回 id");
  assert(q.size === 1, `size=1 (实际 ${q.size})`);

  const event = q.pop();
  assert(event !== null, "pop 返回事件");
  assert(event.source === "test", `source=test (实际 ${event.source})`);
  assert(event.type === "ping", `type=ping (实际 ${event.type})`);
  assert(q.size === 0, `pop 后 size=0 (实际 ${q.size})`);
}

async function testPriority() {
  console.log("\n--- 测试 2: 优先级调度 ---");
  const q = new EventQueue({ debounceMs: 0 });
  q.push("a", "low", {}, PRIORITY.LOW);
  q.push("b", "high", {}, PRIORITY.HIGH);
  q.push("c", "normal", {}, PRIORITY.NORMAL);
  q.push("d", "critical", {}, PRIORITY.CRITICAL);

  const order = [];
  while (q.size > 0) order.push(q.pop().type);

  console.log(`  出队顺序: ${order.join(" -> ")}`);
  assert(order[0] === "critical", "第一个 critical");
  assert(order[1] === "high", "第二个 high");
  assert(order[2] === "normal", "第三个 normal");
  assert(order[3] === "low", "第四个 low");
}

async function testTokenBucket() {
  console.log("\n--- 测试 3: 令牌桶节流 ---");
  const q = new EventQueue({
    maxBurst: 3, // 桶容量 3
    refillRate: 1, // 每秒补 1
    debounceMs: 0,
  });

  // 突发 5 个，应该只能出 3 个（令牌耗尽）
  for (let i = 0; i < 5; i++) q.push("t", `e${i}`, {}, PRIORITY.NORMAL);

  let popped = 0;
  while (q.pop()) popped++;
  assert(popped === 3, `突发 5 个，令牌耗尽出 3 个 (实际 ${popped})`);
  assert(q.size === 2, `队列剩 2 个 (实际 ${q.size})`);

  // 等 1.5 秒，补 1 个令牌
  console.log("  等待 1.5s 补令牌...");
  await sleep(1500);

  popped = 0;
  while (q.pop()) popped++;
  assert(popped === 1, `补 1 令牌出 1 个 (实际 ${popped})`);
  assert(q.size === 1, `队列剩 1 个 (实际 ${q.size})`);
}

async function testDebounce() {
  console.log("\n--- 测试 4: 去抖合并 ---");
  const q = new EventQueue({ debounceMs: 200 });
  let pushCount = 0;
  q.on("push", () => pushCount++);

  // 快速连推 3 个同 key 事件
  q.push("file", "changed", { path: "/test/a.txt" }, PRIORITY.NORMAL);
  q.push("file", "changed", { path: "/test/a.txt" }, PRIORITY.NORMAL);
  q.push("file", "changed", { path: "/test/a.txt" }, PRIORITY.NORMAL);

  // 去抖 timer 还没触发，不应该入队
  assert(q.size === 0, `去抖期内 size=0 (实际 ${q.size})`);

  // 等去抖结束
  await sleep(300);

  assert(q.size === 1, `去抖后只入队 1 个 (实际 ${q.size})`);
  assert(q.stats.debounced === 2, `去抖丢弃 2 个 (实际 ${q.stats.debounced})`);
}

async function testHourlyLimit() {
  console.log("\n--- 测试 5: 每小时上限 ---");
  const q = new EventQueue({
    debounceMs: 0,
    hourlyLimit: 5,
    maxBurst: 100, // 不让令牌桶干扰
    refillRate: 100,
  });

  for (let i = 0; i < 10; i++) {
    q.push("t", `e${i}`, { path: `/unique/${i}` }, PRIORITY.NORMAL);
  }

  assert(q.size === 5, `达到上限后只入队 5 个 (实际 ${q.size})`);
  assert(q.stats.dropped === 5, `丢弃 5 个 (实际 ${q.stats.dropped})`);
}

async function testStats() {
  console.log("\n--- 测试 6: 统计信息 ---");
  const q = new EventQueue({ debounceMs: 0, maxBurst: 100, refillRate: 100 });
  q.push("a", "x", { path: "/1" }, PRIORITY.NORMAL);
  q.push("a", "x", { path: "/2" }, PRIORITY.HIGH);
  q.pop(); // 出一个

  const stats = q.getStats();
  console.log("  stats:", JSON.stringify(stats));
  assert(stats.enqueued === 2, `enqueued=2 (实际 ${stats.enqueued})`);
  assert(stats.dispatched === 1, `dispatched=1 (实际 ${stats.dispatched})`);
  assert(stats.size === 1, `size=1 (实际 ${stats.size})`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runAll() {
  console.log("=== furina 事件队列测试 ===");
  await testBasicPushPop();
  await testPriority();
  await testTokenBucket();
  await testDebounce();
  await testHourlyLimit();
  await testStats();

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll();
