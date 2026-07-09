/**
 * src/control-channel.mjs
 *
 * 控制通道：监听 control.json 文件，支持运行时热控制
 *
 * 用法：外部写一个 JSON 命令到 control.json，furina 检测到后执行
 *
 * 支持的命令：
 *   { "cmd": "switch-session", "sessionId": "ses_xxx" }   切换目标 session
 *   { "cmd": "inject", "text": "消息内容" }                手动注入一条消息
 *   { "cmd": "status" }                                    请求打印状态
 *   { "cmd": "summarize" }                                 强制触发上下文压缩
 *   { "cmd": "set-watch", "paths": ["..."] }               运行时添加监听路径
 *
 * control.json 处理后会被删除（防止重复执行）
 */

import { watch, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ControlChannel {
  constructor({ injector, queue, memory, sensors, presets, modeManager, healthChecker, onStatus, onAddWatch }) {
    this.injector = injector;
    this.queue = queue;
    this.memory = memory;
    this.sensors = sensors;
    this.presets = presets;
    this.modeManager = modeManager;
    this.healthChecker = healthChecker;
    this.onStatus = onStatus || (() => {});
    this.onAddWatch = onAddWatch || (() => {});
    this.controlFile = join(__dirname, "..", "control.json");
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    // 先处理可能已存在的控制文件
    this._processIfExists();

    // 监听 control.json 的创建
    const dir = join(this.controlFile, "..");
    watch(dir, (eventType, filename) => {
      if (filename === "control.json" || filename === "control.json") {
        // 延迟一点避免写入不完整
        setTimeout(() => this._processIfExists(), 200);
      }
    });

    console.log(`[control] 控制通道就绪，监听: ${this.controlFile}`);
    console.log(`[control] 写入 JSON 命令到此文件即可热控制 furina`);
  }

  _processIfExists() {
    if (!existsSync(this.controlFile)) return;
    let cmd;
    try {
      const raw = readFileSync(this.controlFile, "utf-8");
      cmd = JSON.parse(raw);
    } catch (e) {
      console.warn(`[control] 命令解析失败: ${e.message}`);
      return;
    }

    // 处理完立刻删除，防止重复执行
    try {
      unlinkSync(this.controlFile);
    } catch {}

    this._execute(cmd).catch((e) => {
      console.error(`[control] 命令执行失败:`, e.message);
    });
  }

  async _execute(cmd) {
    console.log(`[control] 收到命令: ${cmd.cmd}`);

    switch (cmd.cmd) {
      case "switch-session": {
        if (!cmd.sessionId) {
          console.warn("[control] switch-session 需要 sessionId");
          return;
        }
        this.injector.sessionId = cmd.sessionId;
        // 重置基准时间，避免下次注入轮询到旧消息
        this.injector.lastAssistantTime = 0;
        console.log(`[control] 已切换到 session: ${cmd.sessionId}`);
        break;
      }

      case "inject": {
        if (!cmd.text) {
          console.warn("[control] inject 需要 text");
          return;
        }
        // 直接推一个高优先级事件到队列
        this.queue.push(
          "control",
          "manual.inject",
          { text: cmd.text },
          80 // HIGH 优先级
        );
        console.log(`[control] 已注入消息: ${cmd.text.slice(0, 50)}...`);
        break;
      }

      case "status": {
        const status = {
          pid: process.pid,
          session: this.injector.sessionId,
          queue: this.queue.getStats(),
          memory: this.memory.getStats(),
          sensors: this.sensors.map((s) => ({ name: s.name, running: s.running })),
          timestamp: new Date().toISOString(),
        };
        console.log("[control] 当前状态:");
        console.log(JSON.stringify(status, null, 2));
        this.onStatus(status);
        break;
      }

      case "summarize": {
        console.log("[control] 强制触发上下文压缩...");
        const ok = await this.memory.checkpoint();
        console.log(`[control] 压缩: ${ok ? "成功" : "失败"}`);
        break;
      }

      case "set-watch": {
        if (!cmd.paths || !Array.isArray(cmd.paths)) {
          console.warn("[control] set-watch 需要 paths 数组");
          return;
        }
        this.onAddWatch(cmd.paths);
        console.log(`[control] 添加监听路径: ${cmd.paths.join(", ")}`);
        break;
      }

      case "set-mode": {
        // set-mode: self-talk | find-work | observe
        if (!cmd.mode) {
          console.warn("[control] set-mode 需要 mode (self-talk/find-work/observe)");
          return;
        }
        const ok = this.modeManager.setMode(cmd.mode);
        console.log(`[control] set-mode ${cmd.mode}: ${ok ? "成功" : "失败"}`);
        break;
      }

      case "set-preset": {
        // set-preset: 修改任意预设值
        // { cmd: "set-preset", key: "idleThresholdMs", value: 600000 }
        // { cmd: "set-preset", key: "healthCheck.staleStateMs", value: 180000 }
        if (!cmd.key) {
          console.warn("[control] set-preset 需要 key");
          return;
        }
        const ok = this.presets.set(cmd.key, cmd.value);
        console.log(`[control] set-preset ${cmd.key}=${cmd.value}: ${ok ? "成功" : "失败（key不存在）"}`);
        break;
      }

      case "add-prompt": {
        // add-prompt: 往预设列表加一条
        // { cmd: "add-prompt", list: "selfTalkPrompts", text: "检查一下日志" }
        if (!cmd.list || !cmd.text) {
          console.warn("[control] add-prompt 需要 list 和 text");
          return;
        }
        const ok = this.presets.addPrompt(cmd.list, cmd.text);
        console.log(`[control] add-prompt to ${cmd.list}: ${ok ? "成功" : "失败（list不存在）"}`);
        break;
      }

      case "remove-prompt": {
        // remove-prompt: 删除指定索引的预设
        if (cmd.index === undefined || !cmd.list) {
          console.warn("[control] remove-prompt 需要 list 和 index");
          return;
        }
        const ok = this.presets.removePrompt(cmd.list, cmd.index);
        console.log(`[control] remove-prompt ${cmd.list}[${cmd.index}]: ${ok ? "成功" : "失败"}`);
        break;
      }

      case "get-presets": {
        // 返回当前完整预设
        const all = this.presets.get();
        console.log("[control] 当前预设:");
        console.log(JSON.stringify(all, null, 2));
        break;
      }

      case "poke-test": {
        // 手动触发一次戳醒测试
        console.log("[control] 手动触发戳醒测试...");
        await this.healthChecker._poke();
        break;
      }

      default:
        console.warn(`[control] 未知命令: ${cmd.cmd}`);
    }
  }
}
