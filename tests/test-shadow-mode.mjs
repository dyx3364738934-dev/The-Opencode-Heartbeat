/**
 * tests/test-shadow-mode.mjs
 *
 * v0.9.20 (L5.4 shadow mode manual #45): 测 shadow mode 逻辑
 *
 * 验证：
 *   - main.mjs 的 instanceRole 计算（9999 → "main"，10001 → "shadow"）
 *   - 各 plugin init guard（shadow 时早 return）
 *   - shadow 模式下主动 fire plugin 不挂 setInterval
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function readSrc(rel) {
  return readFileSync(join(ROOT, rel), "utf-8");
}

// =============================
// main.mjs instanceRole 计算
// =============================

test("main.mjs 包含 instanceRole 计算（KORINA_PORT===9999→main，否则 shadow）", () => {
  const src = readSrc("src/main.mjs");
  if (!/loader\.korina\.instanceRole\s*=\s*KORINA_PORT\s*===\s*9999/.test(src)) {
    throw new Error("main.mjs 缺少 instanceRole 计算");
  }
});

test("main.mjs instanceRole 旁有日志输出（让运维能看清）", () => {
  const src = readSrc("src/main.mjs");
  if (!/\[main\]\s*instanceRole/.test(src)) {
    throw new Error("main.mjs 缺 instanceRole 日志");
  }
});

// =============================
// 6 plugins 加 init guard
// =============================

const SHADOW_GUARD_PLUGINS = [
  "plugins/timer/plugin.mjs",
  "plugins/worklog/plugin.mjs",
  "plugins/file-watcher/plugin.mjs",
  "plugins/sse-tts-pipeline/plugin.mjs",
  "plugins/memory/plugin.mjs",
  "plugins/sidecar-launcher/plugin.mjs",
];

for (const pluginRel of SHADOW_GUARD_PLUGINS) {
  const name = pluginRel.split("/")[1];
  test(`${name} 包含 shadow guard（ctx.korina?.instanceRole === "shadow" 检查）`, () => {
    const src = readSrc(pluginRel);
    if (!/ctx\.korina\?\.instanceRole\s*===\s*["']shadow["']/.test(src)) {
      throw new Error(`${pluginRel} 缺 shadow guard`);
    }
  });
}

// =============================
// guard 模式：早 return vs 注释
// =============================

const EARLY_RETURN_PLUGINS = [
  "plugins/timer/plugin.mjs",
  "plugins/worklog/plugin.mjs",
  "plugins/file-watcher/plugin.mjs",
  "plugins/sse-tts-pipeline/plugin.mjs",
  "plugins/memory/plugin.mjs",
];

for (const pluginRel of EARLY_RETURN_PLUGINS) {
  const name = pluginRel.split("/")[1];
  test(`${name} shadow guard 后 return 占位 stop()（不挂 setInterval）`, () => {
    const src = readSrc(pluginRel);
    // 找 init 函数体里 shadow guard 后第一个 return
    const guardIdx = src.indexOf('instanceRole === "shadow"');
    if (guardIdx < 0) throw new Error("缺 guard");
    const tail = src.slice(guardIdx, guardIdx + 500);
    // 接受 return { stop() {} } 或 return { stop() {}, watcher: null } 等任意字段
    if (!/return\s*\{\s*stop\s*\(\s*\)\s*\{\s*\}\s*[},]/.test(tail)) {
      throw new Error(`${pluginRel} shadow guard 后没 return stop placeholder`);
    }
  });
}

// sidecar-launcher 是特殊的：不 return（registry 仍创建给 gracefulShutdown stopAll 用）
test("sidecar-launcher shadow guard 不 return（registry 仍创建）", () => {
  const src = readSrc("plugins/sidecar-launcher/plugin.mjs");
  const guardIdx = src.indexOf('instanceRole === "shadow"');
  if (guardIdx < 0) throw new Error("缺 guard");
  // guard 后 200 字符内不应该有 return { stop() {} }
  const tail = src.slice(guardIdx, guardIdx + 200);
  if (/return\s*\{\s*stop\s*\(\s*\)\s*\{\s*\}\s*\}/.test(tail)) {
    throw new Error("sidecar-launcher 不应 return（registry 必须创建）");
  }
});

// =============================
// guard 注释版本号（manual #45）
// =============================

test("main.mjs 注释含 manual #45 引用（避免后人疑惑）", () => {
  const src = readSrc("src/main.mjs");
  if (!/manual #45/.test(src)) throw new Error("缺 manual #45 引用");
});

const ANNOTATED_PLUGINS = [
  "plugins/timer/plugin.mjs",
  "plugins/worklog/plugin.mjs",
  "plugins/file-watcher/plugin.mjs",
  "plugins/sse-tts-pipeline/plugin.mjs",
  "plugins/memory/plugin.mjs",
  "plugins/sidecar-launcher/plugin.mjs",
];
for (const pluginRel of ANNOTATED_PLUGINS) {
  const name = pluginRel.split("/")[1];
  test(`${name} shadow guard 注释含 manual #45 引用`, () => {
    const src = readSrc(pluginRel);
    if (!/manual #45/.test(src)) throw new Error("缺 manual #45 注释");
  });
}

// =============================
// 关键设计：插件仍加载（init 早 return 不影响 load）
// =============================

test("shadow mode 不会让 plugin 完全 skip load（应 init 仍调、只 return 占位）", () => {
  // 这是设计要求：plugin 在 shadow 模式下仍 init 调用，但 guard 后早 return 占位 stop
  // 验证：每个 guard 后没 throw / 没 process.exit
  for (const pluginRel of SHADOW_GUARD_PLUGINS) {
    const src = readSrc(pluginRel);
    const guardIdx = src.indexOf('instanceRole === "shadow"');
    if (guardIdx < 0) continue;
    const tail = src.slice(guardIdx, guardIdx + 300);
    if (/process\.exit/.test(tail)) {
      throw new Error(`${pluginRel} shadow guard 调 process.exit（应只 return）`);
    }
  }
});

// =============================
// 跑测试
// =============================
console.log(`=== korina shadow-mode (L5.4 manual #45) test ===`);
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  PASS: ${t.name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL: ${t.name} -- ${e.message}`);
    fail++;
  }
}
console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
