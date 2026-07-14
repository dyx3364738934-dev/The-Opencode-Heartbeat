# korina Glossary

> 本文是 korina 换底重构的词汇表。以后代码、文档、MCP 工具、HTTP 端点都按这里命名，避免“plugin / heartbeat / session”继续混用。

## Core terms

### korina
整个本地调度系统的产品名。不要把 korina 等同于 MCP、HTTP、插件或心跳。

### kernel
korina 的总控内核。负责启动、关闭、加载 module、管理 lifeline、汇总状态和暴露 capabilities。

### lifeline
绑定到一个 OpenCode conversation session 的运行单元。它是“korina 接到某个对话上的生命线”。

初期只有一个 lifeline：`main`。多 lifeline 是后续目标，不是当前已实现事实。

### module
挂在 kernel 或 lifeline 上的功能单元，例如 heartbeat、tts、voice-input、desktop-lyrics、mode-router、file-watcher。

以后尽量用 module，不再把 korina 内部功能叫 plugin。

### adapter
外部世界访问 korina 的协议适配层。adapter 只做协议转换，不拥有核心业务状态。

常见 adapter：

- MCP adapter：OpenCode 里的 AI 调工具时经过这里。
- HTTP adapter：本地 `127.0.0.1:9999` 控制端口。
- ~~control-file adapter：`control.json` 文件控制入口。~~（v0.9.22 manual #48 删，KOKO 拍板 A 治画饼）
- oc hook：OpenCode 启动时拉起 korina 的启动钩子。

### oc hook
运行在 OpenCode 进程里的启动钩子，当前对应 `~/.config/opencode/plugins/korina-bootstrap.mjs`。它只负责泄露 OpenCode 凭证并拉起 korina，不负责心跳、注入或 sidecar 逻辑。

### sidecar
由 korina 管理生命周期的辅助进程。当前主要是：

- `voice-input.py`
- `desktop-lyrics.py`

sidecar 不应自己拥有核心 session 策略，只应接收 lifeline / state 层给它的目标。

### watchdog
独立于 korina daemon 的监督者。它只负责判断 korina 是否还活着，必要时重启，并清理孤儿 sidecar。watchdog 不应理解 mode、心跳模板或业务任务。

## Heartbeat terms

### process heartbeat
进程存活心跳。当前是 `logs/heartbeat.json`，给 watchdog 判断 korina 是否还活着。

### session heartbeat
注入到 OpenCode 对话里的定时消息。当前由 timer module 管理。

### heartbeat template
生成 session heartbeat 文本的模板。它不是进程存活心跳。

## Session terms

### ocSessionId
OpenCode 原生对话 ID，例如 `ses_xxx`。

### primarySessionId
当前 lifeline 默认绑定的 OpenCode session。

### boundSessionIds
korina 额外绑定的 session 集合。用于多 session 注入或 per-session task。

### voiceTargetSessionId
语音输入当前锁定的目标 session。它可以跟 primarySessionId 相同，也可以显式绑定到另一个 session。

## State terms

### source of truth
某个状态的唯一真相源。换底重构的核心目标之一是让每个状态只有一个主人。

例：

- primarySessionId → 应由 session binding store 统一管理。
- heartbeat interval → 应由 heartbeat module / config store 统一管理。
- HTTP capabilities → 应由 capabilities endpoint / registry 统一暴露。

### capability
korina 当前真实支持的能力。MCP adapter 和 README 不应声明 capabilities 里不存在的能力。
