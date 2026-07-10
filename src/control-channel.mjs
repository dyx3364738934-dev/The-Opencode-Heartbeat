/**
 * src/control-channel.mjs
 *
 * 控制通道：监听 control.json 文件，支持运行时热控制
 *
 * 用法：外部写一个 JSON 命令到 control.json，furina 检测到后执行
 *
 * 支持的命令：
 *   { "cmd": "switch-session", "sessionId": "ses_xxx" }   切换目标 session
 *   { "cmd": "inject", "text": "...", "intent": "...", "silent": true }  手动注入（v0.5 支持意图+silent）
 *   { "cmd": "silent-inject", "text": "...", "intent": "..." }           silent 注入（专用）
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
      if (filename === "control.json") {
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
        // 持久化 session 锁定，重启 furina 后自动恢复
        this.injector.saveSession(cmd.sessionId);
        console.log(`[control] 已切换到 session: ${cmd.sessionId}（已持久化）`);
        break;
      }

      case "inject": {
        if (!cmd.text) {
          console.warn("[control] inject 需要 text");
          return;
        }
        // v0.5: 支持 intent/source 透传（默认 user / control）
        // silent=true 走 silentInject（不进 dispatch、不等回复、不写记忆）
        if (cmd.silent) {
          const ok = await this.injector.silentInject(cmd.text, {
            intent: cmd.intent || "user",
            source: cmd.source || "control",
          });
          console.log(`[control] silent 注入 (intent=${cmd.intent || "user"}): ${cmd.text.slice(0, 50)}... ok=${ok}`);
          break;
        }
        // 默认：进 dispatch 队列
        this.queue.push(
          "control",
          "manual.inject",
          { text: cmd.text, intent: cmd.intent, source: cmd.source },
          80 // HIGH 优先级
        );
        console.log(`[control] 已注入消息 (intent=${cmd.intent || "user"}): ${cmd.text.slice(0, 50)}...`);
        break;
      }

      case "silent-inject": {
        // v0.5: silent 注入专用命令（不依赖 inject.silent 标志）
        if (!cmd.text) {
          console.warn("[control] silent-inject 需要 text");
          return;
        }
        const ok = await this.injector.silentInject(cmd.text, {
          intent: cmd.intent || "self-direct",
          source: cmd.source || "control",
        });
        console.log(`[control] silent 注入 (intent=${cmd.intent || "self-direct"}): ${cmd.text.slice(0, 50)}... ok=${ok}`);
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

      case "recall": {
        // 手动调一次记忆检索并把结果作为工作记忆存下来
        const query = cmd.query || "";
        console.log(`[control] 调 recall: query="${query}"`);
        const result = await this.memory.recall(query || null, { last: cmd.last || "7d" });
        if (result) {
          this.memory.setRecentRecall(result);
          console.log(`[control] recall 完成，结果已存入工作记忆`);
        } else {
          console.log(`[control] recall 无结果`);
        }
        break;
      }

      case "set-watch": {
        if (!cmd.paths || !Array.isArray(cmd.paths)) {
          console.warn("[control] set-watch 需要 paths 数组");
          return;
        }
        // 去重：已有监听路径不再添加
        const existing = new Set(
          this.sensors
            .filter((s) => s.name === "file-watcher")
            .flatMap((s) => s.paths || [])
        );
        const fresh = cmd.paths.filter((p) => !existing.has(p));
        if (fresh.length === 0) {
          console.log(`[control] set-watch: 所有路径已在监听中，跳过`);
          return;
        }
        this.onAddWatch(fresh);
        console.log(`[control] 添加监听路径: ${fresh.join(", ")}（已跳过 ${cmd.paths.length - fresh.length} 个重复）`);
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
