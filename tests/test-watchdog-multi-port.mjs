import assert from "node:assert/strict";

// v0.9.12 (L5.2 manual #36): import parsePortsArg from watchdog
// 因为 watchdog.mjs 顶层立即执行 main()，import 会触发——所以不能用顶层 import。
// 解决方案：动态 import + 用 child_process 隔离。
// 但 parsePortsArg 是纯函数，可以直接 re-import 字符串源码提取。
// 更稳：把 parsePortsArg 单独移到 ports-parser.mjs（但 watchdog 文件已 commit，refactor 留给下一刀）。
// 当前 workaround：从 watchdog 文本里用 regex 提取 parsePortsArg 函数体执行。

// 实际测法：直接 import，但需要让 watchdog 不执行 main。
// 我们用 createRequire 加载，或 fs.readFileSync + Function 构造器。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watchdogSrc = readFileSync(
  join(__dirname, "..", "watchdog", "watchdog.mjs"),
  "utf-8",
);

// 提取 parsePortsArg 函数（regex：从 export function 开始到下一个 export 或顶层 const）
const match = watchdogSrc.match(/export function parsePortsArg[\s\S]*?\n\}/);
if (!match) {
  console.error("!! 找不到 parsePortsArg 函数，watchdog.mjs 结构变了？");
  process.exit(2);
}

// 用 Function 构造器隔离 evaluate（不污染全局）
const parsePortsArg = new Function(
  "argv", "env",
  match[0].replace(/^export\s+/, "") + "\nreturn parsePortsArg(argv, env);"
);

let passed = 0;
function ok(msg) {
  passed++;
  console.log(`  PASS: ${msg}`);
}

console.log("=== korina watchdog multi-port (L5.2 manual #36) test ===");

try {
  // 1. --ports "9999,10001" → [9999, 10001]
  const r1 = parsePortsArg(["--ports", "9999,10001"], {});
  assert.deepEqual(r1, [9999, 10001]);
  ok("--ports '9999,10001' → [9999, 10001]");

  // 2. --ports 三端口
  const r2 = parsePortsArg(["--ports", "8080,9090,10000"], {});
  assert.deepEqual(r2, [8080, 9090, 10000]);
  ok("--ports '8080,9090,10000' → 三端口");

  // 3. 兼容 --port 单值（向后兼容）
  const r3 = parsePortsArg(["--port", "7777"], {});
  assert.deepEqual(r3, [7777]);
  ok("--port 7777 → [7777]（向后兼容）");

  // 4. 不设任何参数 → 默认 9999
  const r4 = parsePortsArg([], {});
  assert.deepEqual(r4, [9999]);
  ok("不设参数 → 默认 [9999]");

  // 5. env KORINA_PORT 生效
  const r5 = parsePortsArg([], { KORINA_PORT: "8888" });
  assert.deepEqual(r5, [8888]);
  ok("env KORINA_PORT=8888 → [8888]（env 优先默认 9999）");

  // 6. 无效 port 过滤（0, -1, 99999, "abc"）
  const r6 = parsePortsArg(["--ports", "9999,0,-1,99999,abc,10001"], {});
  assert.deepEqual(r6, [9999, 10001]);
  ok("无效 port 过滤（0/-1/99999/abc 移除）");

  // 7. 空字符串 ports → fallback 到 --port
  const r7 = parsePortsArg(["--ports", "", "--port", "5555"], {});
  assert.deepEqual(r7, [5555]);
  ok("--ports 空 → fallback --port");

  // 8. 全无效 → fallback [9999]
  const r8 = parsePortsArg(["--ports", "abc,def"], {});
  assert.deepEqual(r8, [9999]);
  ok("--ports 全无效 → fallback [9999]");

  // 9. --ports 优先 --port（即使两个都设）
  const r9 = parsePortsArg(["--ports", "9999,10001", "--port", "5555"], {});
  assert.deepEqual(r9, [9999, 10001]);
  ok("--ports 优先 --port");

  // 10. 带空格 ports（"9999, 10001"）
  const r10 = parsePortsArg(["--ports", "9999, 10001"], {});
  assert.deepEqual(r10, [9999, 10001]);
  ok("--ports '9999, 10001'（带空格）正确 trim");

  console.log(`\n=== result: ${passed} passed, 0 failed ===`);
} catch (e) {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
}