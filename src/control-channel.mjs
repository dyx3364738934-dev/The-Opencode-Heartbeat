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
  constructor({ injector, queue, memory, sensors, onStatus, onAddWatch }) {
    this.injector = injector;
    this.queue = queue;
    this.memory = memory;
    this.sensors = sensors;
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

      default:
        console.warn(`[control] 未知命令: ${cmd.cmd}`);
    }
  }
}
