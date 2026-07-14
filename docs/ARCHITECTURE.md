# korina Architecture

> 目标：把 korina 从“能跑但走线混乱的原型”换底成“kernel + lifeline + modules + adapters”的可维护底座，同时保留当前已经跑通的 OpenCode / MCP / HTTP / sidecar 协议入口。

## 0. Current quality assessment

已验代码规模：约 8.7k 行，48 个源码/脚本文件（排除 `node_modules`、`logs`、`__pycache__`）。代码还没过万行，适合换底重构。

当前有效资产：

- OpenCode bootstrap hook 能拉起 korina。
- korina Node daemon 能监听 `127.0.0.1:9999`。
- MCP adapter 能转发工具调用到 HTTP。
- oc-injector 能发现 OpenCode、绑定 session、注入消息。
- timer 能做 session heartbeat，且可 pause/resume/set interval。
- TTS / desktop lyrics / voice input sidecar 已跑通。
- watchdog 有进程复活和孤儿 sidecar 清理思路。

主要质量风险：

- `plugin`、`heartbeat`、`session` 三组词混用，认知成本高。
- `oc-injector` 和 `timer` 偏大，承担过多职责。
- MCP adapter 曾经声明不存在的 endpoint，协议层会“撒谎”。
- `src/` 根目录和 `src/core/` 有重复历史文件，source of truth 不清。
- session 状态散在内存、`session.lock`、`voice-input-target.json` 等位置。
- 文档存在 furina 残留和愿景/现实混写。

结论：不是“推倒全删重写”，而是“保协议、换内核；保活性、换骨架”。

## 1. Target mental model

```text
外部入口 adapters
  ↓
korina kernel
  ↓
lifeline main 绑定一个 OpenCode session
  ↓
modules 提供心跳、注入、TTS、语音、字幕、文件监听等能力
  ↓
state 层保存唯一事实
  ↓
watchdog 只负责进程保活
```

小白类比：

- adapters = 机箱外部接口 / 前面板按钮
- kernel = 主板
- lifeline = 接到某个 OpenCode 对话上的生命线
- modules = 显卡、声卡、网卡等功能卡
- sidecars = 外挂小设备
- state = 档案柜 / BIOS 配置
- watchdog = 保安 / 自动重启器

## 2. Layers

### 2.1 adapters

外部系统访问 korina 的入口。adapter 只做协议转换，不拥有业务状态。

当前 adapter：

- MCP adapter：`mcp/korina_mcp_server.py`
- HTTP adapter：`src/core/http-router.mjs`
- oc hook：`~/.config/opencode/plugins/korina-bootstrap.mjs`

> v0.9.22 (manual #48): 删 control file adapter（`src/control-channel.mjs` 276 行 + `plugins/control/plugin.mjs` 40 行 = 316 行画饼代码）。13 个 cmd 0 次用过（`logs/control.json` 从未存在），90% 跟 HTTP 端点重复。KOKO 拍板 A 全删 = 治根因。

规则：

- MCP 不再凭空声明功能，后续应从 `/capabilities` 校验。
- HTTP endpoint 是 compatibility API，内部可以逐步换成新 kernel command。
- oc hook 只负责启动和凭证泄露，不负责心跳或注入。

### 2.2 kernel

kernel 是 korina daemon 的总控。目标职责：

- 启动/关闭 korina。
- 加载配置。
- 加载 module。
- 管理 lifeline。
- 暴露 capabilities。
- 汇总 status。

当前对应：

- `src/main.mjs`
- `src/core/plugin-loader.mjs`
- `src/core/event-bus.mjs`
- `src/core/event-queue.mjs`
- `src/core/http-router.mjs`
- `src/core/presets.mjs`

### 2.3 lifeline

lifeline 是“绑定到某个 OpenCode session 的运行单元”。

目标职责：

- 持有 `primarySessionId`。
- 通过 oc-client 注入消息。
- 挂载 heartbeat / task / TTS 等 modules。
- 报告 lifeline status。

当前还没有独立 lifeline module；相关职责散在：

- `plugins/oc-injector/plugin.mjs`
- `src/injector.mjs`
- `plugins/timer/plugin.mjs`
- `logs/session.lock`

第一阶段先只支持 `main` lifeline。多 lifeline 等单 lifeline 稳定后再做。

### 2.4 modules

module 是 korina 的功能卡。当前插件目录未来语义上应视为 modules：

- `heartbeat` / timer
- `oc-injector`
- `mode-router`
- `tts-tool`
- `sse-tts-pipeline`
- `voice-input`
- `desktop-lyrics`
- `file-watcher`
- `memory`
- `health`
- `worklog`

规则：

- module 只负责一个功能。
- module 不直接声明外部协议能力，应通过 kernel / capability registry 暴露。
- module 不随意拥有全局状态。

### 2.5 sidecars

sidecar 是由 korina 管理的小进程。

当前：

- `voice-input.py`
- `desktop-lyrics.py`

目标：统一由 sidecar registry 管理：

- launch
- ping
- status
- stop
- orphan cleanup

### 2.6 state

state 层保存唯一事实。目标拆分：

- config store：配置。
- session binding store：session 绑定。
- task store：定时任务状态。
- sidecar status store：sidecar 存活状态。
- capability registry：真实能力清单。
- process heartbeat：进程存活心跳。

## 3. Refactor strategy

### Principle

```text
保协议，换内核；保活性，换骨架。
```

不先移动：

- MCP 工具入口
- HTTP endpoint 兼容路径
- oc bootstrap hook
- sidecar Python 脚本
- watchdog 基本机制

优先替换：

- 状态所有权
- capability source of truth
- lifeline interface
- module runtime interface
- sidecar lifecycle registry

### Phases

1. 文档和术语冻结：`GLOSSARY.md`、`ARCHITECTURE.md`、`REFACTOR-PLAN.md`。
2. capabilities seam：新增 `/capabilities`，让协议层有真实能力清单。
3. session binding store：让 session 状态有唯一主人。
4. lifeline runtime：把注入、绑定、heartbeat target 收进 `main` lifeline。
5. heartbeat module：拆出 session heartbeat / process heartbeat / template。
6. sidecar registry：统一 voice-input 和 desktop-lyrics 生命周期。
7. MCP adapter 校验 capabilities，去掉硬编码假能力。
8. 多 lifeline / 多端口：最后再做。

## 4. Current first seam

已开始的第一刀：

- `HTTPRouter.listRoutes()`：HTTP 层能列出真实 routes，不暴露 handler implementation。
- `GET /capabilities`：返回 version、mode、真实 HTTP routes、plugin 列表。
- `tests/test-capabilities.mjs`：锁住 route introspection 行为。

这个 seam 是未来 MCP adapter 不再“声明不存在工具”的基础。
