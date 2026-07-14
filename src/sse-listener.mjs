/**
 * src/sse-listener.mjs
 *
 * SSE 监听器 -- 订阅 opencode /global/event 事件流
 *
 * v0.8.5: 用 node:http 替代 fetch（避免 Node 20.11 undici 长跑污染导致 TTS hang）
 *
 * 事件：
 *   - message.part.updated  -> 文本增量（流式输出的核心）
 *   - message.updated       -> 消息创建（assistant role 时加入 whitelist）
 *   - session.status        -> busy/idle/retry 状态
 *
 * 用法：
 *   const listener = new SSEListener(injector);
 *   listener.on("textDelta", (delta, fullText) => { ... });
 *   listener.on("messageComplete", (fullText) => { ... });
 *   listener.start();
 *   listener.stop();
 */

import { EventEmitter } from "node:events";
import http from "node:http";

export class SSEListener extends EventEmitter {
  constructor(injector, options = {}) {
    super();
    this.injector = injector;
    this.sessionId = options.sessionId || injector.sessionId;
    this.targetMessageId = null;
    this.buffer = "";
    this.lastPartText = "";
    this.assistantActive = false; // v0.8.6: V4F 是否已开始处理（看到 step-start 后置 true）
    this.lastDeltaTime = 0;
    this.running = false;
    this.currentReq = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    // v0.8.7: C3 修复 -- generation ID 防止并发 _streamingInject 互相干扰
    this._generation = 0;
    this._lastUserMsgId = null; // v0.9.3: userTextSeen 去重
  }

  setTarget(sessionId = null, messageId = null) {
    if (sessionId) this.sessionId = sessionId;
    this.targetMessageId = messageId;
    this.buffer = "";
    this.lastPartText = "";
    this.assistantActive = false;
    this.lastDeltaTime = 0;
    this._lastUserMsgId = null; // v0.9.3: 重置用户消息去重
    // v0.8.7: C3 修复 -- 每次 setTarget 递增 generation，旧的 SSE 事件因 generation 不匹配被丢弃
    this._generation++;
    return this._generation;
  }

  /**
   * v0.8.7: C3 修复 -- 检查当前事件是否属于活跃 generation
   * 防止并发 _streamingInject 的 SSE 事件互相串扰
   */
  isCurrentGeneration(gen) {
    return gen === undefined || gen === this._generation;
  }

  /**
   * v0.8.7: 获取当前 generation（供调用方在 setTarget 后保存，后续校验用）
   */
  getGeneration() {
    return this._generation;
  }

  async setBaselineFromSession() {
    // v0.8.6: 不再依赖 baseline（不能区分 user/assistant）
    // 用 assistantActive 标志（step-start 触发）判断 V4F 是否开始处理
    return;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    if (this.currentReq) {
      this.currentReq.destroy();
      this.currentReq = null;
    }
  }

  async _connect() {
    while (this.running) {
      try {
        const { base, headers } = await this.injector.discover();
        const u = new URL(`${base}/global/event`);

        await new Promise((resolve, reject) => {
          let settled = false; // v0.8.7: M8 修复 -- 防止 end+close+error 多次 resolve/reject
          const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
          const safeReject = (e) => { if (!settled) { settled = true; reject(e); } };

          const req = http.request(
            {
              hostname: u.hostname,
              port: u.port || 80,
              path: u.pathname + u.search,
              method: "GET",
              headers: { ...headers, Accept: "text/event-stream" },
              agent: false,
            },
            (res) => {
              if (res.statusCode !== 200) {
                res.resume();
                return safeReject(new Error(`SSE HTTP ${res.statusCode}`));
              }
              console.log(`[sse] 已连接 /global/event (sid=${this.sessionId?.slice(0, 16)}...)`);
              this.reconnectDelay = 1000;

              const decoder = new TextDecoder();
              let buf = "";
              let eventBuf = ""; // v0.8.7: M9 修复 -- 完整事件缓冲（支持多行 data:）

              res.on("data", (chunk) => {
                buf += decoder.decode(chunk, { stream: true });
                // v0.8.7: M9 修复 -- 按 \n\n 分割完整事件，事件内多行 data: 用 \n 连接
                const parts = buf.split("\n\n");
                buf = parts.pop(); // 最后一段可能不完整，保留
                for (const part of parts) {
                  const lines = part.split("\n");
                  let dataStr = "";
                  for (const line of lines) {
                    if (line.startsWith("data: ")) {
                      dataStr += (dataStr ? "\n" : "") + line.slice(6);
                    } else if (line.startsWith("data:")) {
                      dataStr += (dataStr ? "\n" : "") + line.slice(5);
                    }
                  }
                  if (dataStr) {
                    try {
                      const evt = JSON.parse(dataStr);
                      this._handleEvent(evt);
                    } catch (e) {
                      // v0.8.7: 不再静默吞掉解析错误
                      console.warn(`[sse] parse error: ${dataStr.slice(0, 80)}`);
                    }
                  }
                }
              });

              res.on("end", safeResolve);
              res.on("close", safeResolve);
              res.on("error", safeReject);
            }
          );
          req.on("error", safeReject);
          // v0.8.7: 加请求超时（防止服务端不断开也不发数据时永久挂起）
          req.setTimeout(120000, () => {
            req.destroy(new Error("SSE 120s 无数据"));
          });
          this.currentReq = req;
          req.end();
        });

        if (!this.running) break;
        console.log("[sse] 连接结束，准备重连...");
      } catch (e) {
        if (!this.running) break;
        console.warn(`[sse] 连接失败: ${e.message?.slice(0, 80)}`);
      }

      if (this.running) {
        await this._sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    }
    console.log("[sse] 监听已停止");
  }

  _handleEvent(evt) {
    const payload = evt.payload;
    if (!payload) return;

    const evtSessionId = payload.sessionID || payload.properties?.sessionID;
    const type = payload.type;

    // v0.9.28 manual #53: 任何 assistant 输出事件都 emit "assistantActive"
    //   - 根因：oc 不发 session.status idle，原 messageComplete 永远不触发
    //   - 修复：message.part.updated/delta/message.updated 都算"AI 在思考"
    //   - 配合 sse-tts-pipeline 桥接到 bus.emit("sse.assistantReply") 让 timer 归零
    //   - 节流放在 timer 侧（避免高频 delta 浪费 CPU）
    if (type === "message.part.updated" || type === "message.part.delta" || type === "message.updated") {
      this.emit("assistantActive", { type, partType: payload.part?.type || payload.properties?.part?.type || "" });
    }

    // v0.9.3: 全局用户消息检测 — 在 session 过滤之前，监听所有 session
    // 只检测用户消息（assistantActive=false），避免 assistant reasoning 误触发
    if (type === "message.part.updated" && !this.assistantActive) {
      const part = payload.part || payload.properties?.part;
      if (part && part.type === "text" && part.text && part.messageID) {
        if (!this._lastUserMsgId || this._lastUserMsgId !== part.messageID) {
          this._lastUserMsgId = part.messageID;
          this.emit("userTextSeen", { text: part.text, messageID: part.messageID, sessionID: evtSessionId });
        }
      }
    }

    // 过滤：只关心当前 session 的 assistant 事件（TTS / streaming）
    if (evtSessionId && this.sessionId && evtSessionId !== this.sessionId) {
      return;
    }

    switch (type) {
      case "message.part.updated":
      case "message.part.delta": {
        const part = payload.part || payload.properties?.part;
        if (!part) return;
        if (this.targetMessageId && part.messageID !== this.targetMessageId) return;

        // v0.8.6: 用 part.type 推断 assistant vs user
        // - step-start / step-finish / reasoning / tool → assistant 消息专属
        // - text → user 或 assistant 都有
        // 判定：看到 step-start 后才进入 assistant 模式；之前的 text part 视为 user
        if (part.type === "step-start") {
          this.assistantActive = true;
          this.emit("partSeen", part); // 通知 main.mjs assistant 已开始
        }
        if (!this.assistantActive) return; // V4F 还没开始 → 所有 part 都是 user，跳过

        if (part.type === "text" && part.text) {
          let delta = "";
          if (part.text.length > this.lastPartText.length && part.text.startsWith(this.lastPartText)) {
            delta = part.text.slice(this.lastPartText.length);
          } else if (type === "message.part.delta" && !part.text.startsWith(this.lastPartText)) {
            delta = part.text;
            this.buffer += delta;
            this.lastPartText = this.buffer;
            this.lastDeltaTime = Date.now();
            this.emit("textDelta", delta, this.buffer);
            return;
          } else {
            delta = part.text;
          }
          this.lastPartText = part.text;
          this.buffer = part.text;
          if (delta) {
            this.lastDeltaTime = Date.now();
            this.emit("textDelta", delta, part.text);
          }
        }
        break;
      }

case "message.updated": {
        const info = payload.info;
        if (!info) return;
        if (this.targetMessageId && info.id !== this.targetMessageId) return;
        // v0.8.6: 用 part.type 判定，不依赖 message.updated
        if (info.role === "assistant") {
          this.emit("messageUpdated", info);
        }
        break;
      }

      case "session.status": {
        const status = payload.status;
        if (!status) return;
        if (status.type === "idle") {
          // v0.8.7: H9 修复 -- idle 后重置 assistantActive（防止用户消息被误送 TTS）
          // v0.8.7: M7 修复 -- 清空 buffer（防止无限累积）
          this.emit("messageComplete", this.buffer, "idle");
          this.assistantActive = false;
          this.buffer = "";
          this.lastPartText = "";
        }
        break;
      }

      default:
        break;
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}