# The Opencode Heartbeat

**AI agent 的外置心跳 — 让 OpenCode 跨对话延续身份、异步执行长期任务、自动从死亡中复活**

> 版本: `v0.7.10-beta` · License: MIT · Node.js ≥ 20

[English](#english) | [中文文档](#中文文档)

---

## 中文文档

### 这是什么

**Opencode Heartbeat** 是一个外置元逻辑守护进程，**与 OpenCode 桌面版配对运行**。它解决了 AI agent 最根本的痛点：

- **我刚才在干嘛？** → 跨对话记忆继承
- **Koko 离开时我能做什么？** → 异步长期任务
- **OC 崩溃了怎么办？** → 自动拉起 + 续命注入
- **我忘了之前的自己？** → 人格延续（自我描述 + 记忆 checkpoint）

**核心定位**：heartbeat 不是"调度多 agent"，也不是"AGI 框架"。它是**让单个 agent 活得更久的心脏**——给它定时心跳、记忆库、自动复活能力。

### 5 分钟快速开始

#### 1. 安装

```bash
git clone https://github.com/dyx3364738934-dev/The-Opencode-Heartbeat.git
cd The-Opencode-Heartbeat
npm install
```

#### 2. 安装 opencode-bootstrap 插件

把以下文件复制到 `~/.config/opencode/plugins/`：

```bash
# Windows
copy plugins\opencode-bootstrap.mjs %USERPROFILE%\.config\opencode\plugins\

# macOS / Linux
cp plugins/opencode-bootstrap.mjs ~/.config/opencode/plugins/
```

**插件的作用**：当 OpenCode 启动时，自动把密码泄露给 heartbeat，并拉起 heartbeat 进程。这是 heartbeat 唯一的兜底机制（heartbeat 死了没人拉起它自己，必须 oc 重启触发插件）。

#### 3. 配置 OpenCode MCP

编辑 `~/.config/opencode/opencode.jsonc`：

```json
{
  "mcp": {
    "heartbeat": {
      "type": "local",
      "command": ["python", "<heartbeat 路径>\\mcp\\heartbeat_mcp_server.py"],
      "enabled": true
    }
  }
}
```

#### 4. 启动

```bash
# 启动 OpenCode 桌面版（heartbeat 会通过 plugin 自动拉起）
# 或者手动启动 heartbeat
node src/main.mjs --watch C:\Users\YourName\Desktop
```

#### 5. 验证

```bash
# 实时看 heartbeat 日志
node watchdog/heartbeat-tail.mjs --follow

# 或者用 npm scripts
npm run tail
```

如果看到 `[启动] heartbeat 已启动` + `[连接] 找到 oc @ 127.0.0.1:8207` + `✓ heartbeat 就绪`，就成功了。

### 核心概念

#### Heartbeat 心跳机制

**默认 3 分钟一次心跳**，向当前 oc 对话注入一条 `[heartbeat] {time}` 消息。模型只需要知道"带 [heartbeat] 前缀的就是 heartbeat 发来的消息"即可。

**配置心跳间隔**（编辑 `config/presets.json`）：

```json
{
  "timer": {
    "enabled": true,
    "intervalMs": 180000,
    "message": "[heartbeat] {time}"
  }
}
```

**禁用心跳**：设 `"enabled": false`，heartbeat 不再主动注入（仍可手动触发）。

#### 主动唤醒 OC

通过 MCP 工具 `heartbeat_inject_intent` 唤醒 OC 做长期任务：

```python
# 你的 oc agent 可以这样调用：
heartbeat_inject_intent(
  text="去扫描 furina 项目还有什么可优化的",
  intent="self-direct",   # 告诉 oc 这是自己派的任务
  source="oc"             # 标记来源
)
```

**intent 选项**：
- `survival` — 续命消息（heartbeat 拉起新 oc 后自动注入"你醒了"）
- `auto-recall` — 自动恢复上下文（带历史摘要回灌）
- `self-direct` — oc 派给自己的任务（默认）
- `koko` — 用户注入的纯消息（无标签）
- `user` — 默认用户消息
- `system` — 系统级通知
- `custom` — 自定义

#### 锁定对话

**自动锁定**：heartbeat 启动时自动绑定到 Koko 当前对话（通过 `logs/session.lock` 持久化）。重启 heartbeat 后会自动恢复绑定。

**手动切换对话**（通过 MCP）：

```python
# 列出所有 oc 对话
sessions()

# 切换到指定对话
session_switch(sessionId="ses_xxx")
```

**通过 control.json 热控制**：

```bash
echo '{"cmd": "switch-session", "sessionId": "ses_xxx"}' > control.json
```

#### 配置调用模型

通过 MCP 工具 `providers` 查看可用模型：

```python
providers()  # 返回所有 provider + model 列表
```

**heartbeat 本身不调用模型**（它是注入框架不是对话框架），模型调用由 oc 自己负责。heartbeat 注入消息后由 oc 处理。

#### 异步长期任务

**场景**：Koko 离开 5 小时，让 oc 继续工作。

**配置** `config/presets.json`：

```json
{
  "timer": {
    "enabled": true,
    "intervalMs": 180000,  // 3 分钟一次
    "message": "[heartbeat] 检查 furina 项目状态，寻找可优化点；如有进展请写日志。"
  }
}

heartbeat 会每 3 分钟唤醒 oc，oc 决定是否工作（如果不工作就回复简短状态）。

### MCP 工具清单

heartbeat 提供 23 个 MCP 工具（2 个独立 + 21 个子命令）：

#### 独立工具

| 工具名 | 用途 |
|--------|------|
| `heartbeat_call` | 元工具，调用 21 个子命令 |
| `heartbeat_inject_intent` | 自由控制注入（silent 模式） |

#### 子命令（通过 heartbeat_call 调）

| 类别 | 工具 | 用途 |
|------|------|------|
| **状态** | `status` / `heartbeat` / `presets` | 查看运行状态 |
| **对话管理** | `sessions` / `session_create` / `session_messages` / `session_send` / `session_switch` | 管理 oc 对话 |
| **agent 集群** | `cluster_create` / `cluster_collect` | 批量创建+收集 |
| **注入与记忆** | `inject` / `recall` / `summarize` / `memory_set` | 注入控制 + 记忆操作 |
| **工作流预设** | `workflow_list` / `workflow_apply` / `workflow_current` / `workflow_add` | persona 切换 |
| **配置与迭代** | `set_preset` / `restart_furina` / `restart_oc` | 热改配置 + 重启 |
| **模型** | `providers` | 查询可用模型 |

**完整参数**详见 `mcp/heartbeat_mcp_server.py` 的 `INJECT_INTENT_DOC`。

### 架构

```
┌──────────────────────────────────────────────────────┐
│                   OpenCode 桌面版                     │
│  ┌──────────────────────────────────────────────┐    │
│  │  plugins/opencode-bootstrap.mjs              │    │
│  │  - 启动时泄露密码到 oc-password.txt           │    │
│  │  - 检查 heartbeat 没跑则拉起                   │    │
│  └──────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────┐    │
│  │  MCP client (oc 通过 mcp 调 heartbeat)        │    │
│  │  - heartbeat_call (22 子命令)                │    │
│  │  - heartbeat_inject_intent (silent 注入)     │    │
│  └──────────────────────────────────────────────┘    │
└──────────┬───────────────────────────────────────────┘
           │ HTTP (port=动态, Basic Auth)
           ↓
┌──────────────────────────────────────────────────────┐
│                Opencode Heartbeat 进程               │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ 感知层        │  │ 核心区        │  │ 注入区     │  │
│  │ - file-watch │→ │ - 事件队列    │→ │ - injector │  │
│  │ - timer      │  │ - 令牌桶      │  │   .inject()│  │
│  │              │  │ - 调度循环    │  │   .poll()  │  │
│  └──────────────┘  └──────────────┘  └────────────┘  │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐                  │
│  │ 记忆区        │  │ HTTP server  │                  │
│  │ - checkpoint │  │ :9999        │                  │
│  │ - recall     │  │ (供 mcp 调)  │                  │
│  └──────────────┘  └──────────────┘                  │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │  health monitor (15s tick)                    │    │
│  │  - 探测 oc 进程 + 端口                         │    │
│  │  - oc 死 → spawnOC + 25s 注入"你醒了"         │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
           ↑                               ↑
           │ 控制命令                        │ 实时日志
           │ control.json                    │ heartbeat-tail
           ↓                               ↓
       任何外部进程                      任何 terminal
```

### 配置文件

#### `config/default.json`

```json
{
  "eventQueue": { "maxBurst": 10, "refillRate": 5, "hourlyLimit": 200 },
  "injector": { "pollIntervalMs": 2000, "pollTimeoutMs": 180000 },
  "memory": { "maxMessages": 40, "maxTokens": 30000 },
  "sensors": {
    "fileWatcher": { "paths": ["."], "debounceMs": 1000 }
  }
}
```

#### `config/presets.json`（运行时可改）

```json
{
  "mode": "observe",
  "timer": {
    "enabled": true,
    "intervalMs": 30000,
    "message": "[heartbeat] 你还好吗？",
    "priority": 20
  },
  "healthCheck": {
    "staleStateMs": 120000,
    "pokeIntervalMs": 60000,
    "maxPokeRounds": 2
  }
}
```

#### `~/.config/opencode/opencode.jsonc`（oc 配置）

```json
{
  "plugin": ["./plugins/opencode-bootstrap.mjs"],
  "mcp": {
    "heartbeat": {
      "type": "local",
      "command": ["python", "<abs-path>\\mcp\\heartbeat_mcp_server.py"],
      "enabled": true
    }
  }
}
```

### 命令行用法

```bash
# 主进程
node src/main.mjs --watch <path> --session <sessionId>

# 实时日志（中文友好）
node watchdog/heartbeat-tail.mjs --follow

# 看最近 50 行
node watchdog/heartbeat-tail.mjs --no-follow --lines 50

# 只看注入消息
node watchdog/heartbeat-tail.mjs --filter "[injector]"

# 英文模式
node watchdog/heartbeat-tail.mjs --lang en

# 控制通道（热控制）
echo '{"cmd": "status"}' > control.json
echo '{"cmd": "inject", "text": "hello"}' > control.json
echo '{"cmd": "switch-session", "sessionId": "ses_xxx"}' > control.json
```

### 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `[错误] 找不到 OpenCode.exe` | oc 没装或路径不对 | 装 oc 桌面版，路径在 `src/injector.mjs` `spawnOC` 修改 |
| `[健康失败] 密码匹配超时` | 密码文件过期 | 重启 oc（plugin 会重新泄露） |
| `[队列!] 丢弃: hourly_limit` | 触发频率太高 | 调大 `eventQueue.hourlyLimit` |
| `silentInject 失败: fetch failed` | oc 端点瞬时无响应 | 已加重试（v0.5.1+），会自动恢复 |
| heartbeat 死了拉不起 | 没有兜底进程 | 重启 oc → plugin 拉起 heartbeat |

### 已知限制

1. **heartbeat 死亡自愈依赖 oc 重启**：heartbeat 是单进程，死了没法自愈（health monitor 在进程内）。Koko 需手动重启 oc 触发 `opencode-bootstrap` 拉起。
2. **silent inject 仍是 oc 视角消息**：所有注入都会进入 oc 对话历史，silent 只是不写 heartbeat 记忆区。
3. **agent 集群是"多 session 并发"不是"多 agent 协作"**：每个 agent 独立思考，结果由 Koko 或 oc 整合。

### 设计哲学

> "furina 不是调度系统，不是多 agent 框架。furina 是心脏——让你活得更久。"

- ❌ **不是**：调度多 agent、AGI 框架、让模型自己找事干
- ✅ **是**：延长 agent 生命周期、跨对话记忆继承、自动复活、异步任务执行

源动力来自 [冬蕴雪对话实验](docs/)——一个关于"AI 是否能延续自己工作流"的长期实验。

---

## English

### What is this

**Opencode Heartbeat** is an external meta-logic daemon that pairs with OpenCode desktop. It solves the most fundamental pain points of AI agents:

- **What was I doing?** → Cross-conversation memory inheritance
- **What can I do while Koko is away?** → Async long-running tasks
- **OC crashed, what now?** → Auto-respawn + resurrection inject
- **I forgot who I was?** → Persona continuity (self-description + memory checkpoints)

**Core positioning**: heartbeat is NOT a "multi-agent scheduler" or "AGI framework". It's a **heart that lets a single agent live longer** — give it periodic pulses, a memory bank, and auto-revive capability.

### 5-minute Quick Start

```bash
git clone https://github.com/dyx3364738934-dev/The-Opencode-Heartbeat.git
cd The-Opencode-Heartbeat
npm install

# Install bootstrap plugin
cp plugins/opencode-bootstrap.mjs ~/.config/opencode/plugins/

# Configure MCP in ~/.config/opencode/opencode.jsonc
# (see Chinese section above for details)

# Start OpenCode desktop — heartbeat auto-starts via plugin
# OR manually: node src/main.mjs --watch ~/Desktop

# Watch heartbeat logs
node watchdog/heartbeat-tail.mjs --follow
```

### Core Concepts

- **Heartbeat**: Default 30s interval. Injects `[heartbeat] ...` into current OC session. Model just needs to recognize this prefix as "heartbeat is talking".
- **Wake OC for long tasks**: Use `heartbeat_inject_intent` with `intent="self-direct"`.
- **Lock session**: Auto-locked to Koko's current session via `logs/session.lock`. Manual switch via `session_switch(sessionId)`.
- **Async long-running**: Set `timer.intervalMs` in presets. Heartbeat wakes OC every N minutes; OC decides whether to work.
- **MCP tools**: 23 total (2 standalone + 21 sub-commands). See [MCP tools section](#mcp-工具清单) (Chinese) above.

### Architecture

See [架构 diagram above](#架构).

### License

MIT

### Credits

Built by Koko & 冬蕴雪 (MiniMax M3). The 冬蕴雪 self-dialogue experiment is the source of all design decisions.
