/**
 * src/utils.mjs
 *
 * 共享工具函数（消除 6 处重复定义）
 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 解析命令行参数
 */
export function getArg(args, name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
}

export function getArgMulti(args, name) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) {
      result.push(args[i + 1]);
      i++;
    }
  }
  return result;
}

/**
 * OC 可执行文件路径列表（统一维护，消除 3 处不一致）
 */
import { join } from "node:path";
import { homedir } from "node:os";

export const OC_EXE_PATHS = [
  join(homedir(), "AppData", "Local", "Programs", "@opencode-aidesktop", "OpenCode.exe"),
  join(homedir(), "AppData", "Local", "Programs", "@opencode-ai", "desktop", "OpenCode.exe"),
  join(homedir(), "AppData", "Local", "OpenCode", "OpenCode.exe"),
];
