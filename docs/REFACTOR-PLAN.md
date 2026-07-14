# korina Refactor Plan

> 换底重构目标：在不砸掉现有 OpenCode / MCP / HTTP / sidecar 运行链路的前提下，把 korina 推到 L4：可解释、可安全扩展、可抗常见故障。

## Level target

当前判断：L2 ~ L3 之间。

- L2：能解释。当前靠探索能解释，但文档和代码不完全一致。
- L3：能安全扩展。部分做到，module 插件化已有，但状态所有权和协议能力不稳。
- L4：能抗故障。watchdog / sidecar / health 已有雏形，但 lifecycle 和 state source of truth 还没统一。

目标：先到 L4，不追求一步到 L5 多 lifeline。

## Quality assessment

### Strengths

- 代码规模小，约 8.7k 行，适合换底。
- 核心运行链路已验证：启动、绑定、心跳、TTS、voice-input、desktop-lyrics、MCP → HTTP。
- 插件化方向已经存在，说明不是单体泥球。
- watchdog 和 sidecar 的 Windows 经验已经沉淀，不能轻易全删。

### Weak spots

1. 术语混乱：plugin / heartbeat / session 多义。
2. 状态分散：session、voice target、timer、capabilities 分散在多个对象/文件。
3. adapter 越权：MCP adapter 曾经声明服务端没有的工具。
4. 大模块偏重：`src/injector.mjs`、`plugins/oc-injector/plugin.mjs`、`plugins/timer/plugin.mjs`。
5. 文档漂移：README / CHANGELOG / old docs 有 furina 残留和旧端点。
6. 测试不足：底层 seam 缺少轻量 unit test，E2E 依赖运行环境。

## Milestone 1 — Freeze language and capabilities

Goal: 先让系统“说真话”。

Tasks:

- [x] Add `docs/GLOSSARY.md`.
- [x] Add `docs/ARCHITECTURE.md`.
- [x] Add `HTTPRouter.listRoutes()`.
- [x] Add `GET /capabilities`.
- [x] Add `tests/test-capabilities.mjs`.
- [x] Make MCP adapter verify static routes against `/capabilities`.
- [x] Add `tests/test_mcp_capabilities_guard.py`.
- [x] Fix `start.ps1` graceful shutdown auth so restart gates do not force-kill by default.
- [ ] Update README to point to current architecture docs.

Verification:

```powershell
node --check src/main.mjs
node --check src/core/http-router.mjs
node tests/test-capabilities.mjs
```

## Milestone 2 — SessionBindingStore

Goal: session 状态只有一个主人。

Introduce:

```text
src/state/session-binding-store.mjs
```

Initial interface:

```js
getPrimarySessionId()
setPrimarySessionId(sessionId, reason)
listBoundSessionIds()
bindSession(sessionId)
unbindSession(sessionId)
getVoiceTargetSessionId()
setVoiceTargetSessionId(sessionId)
```

Migration targets:

- `src/injector.mjs`
- `plugins/oc-injector/plugin.mjs`
- `plugins/voice-input/plugin.mjs`
- `logs/session.lock`
- `logs/voice-input-target.json`

Verification:

- `GET /binding` consistent.
- `POST /rebind` updates one source of truth.
- voice-input bind/unbind does not drift from primary session.

## Milestone 3 — LifelineRuntime main

Goal: 把“绑定一个 OpenCode 对话并维持它”的概念独立出来。

Introduce:

```text
src/lifeline/lifeline-runtime.mjs
src/lifeline/lifeline-registry.mjs
```

Initial scope:

- Only `main` lifeline.
- Wrap existing injector instead of replacing it immediately.
- Expose `inject`, `silentInject`, `status`, `heartbeat` hooks.

Do not implement multi lifeline yet.

## Milestone 4 — Heartbeat split

Goal: 拆开三种 heartbeat。

Names:

- process heartbeat → `logs/heartbeat.json`
- session heartbeat → timer module event injected to OpenCode
- heartbeat template → render text

Tasks:

- Extract template rendering from `plugins/timer/plugin.mjs`.
- Keep `/heartbeat/*` compatibility endpoints.
- Add tests for interval clamp, pause/resume, template variables.

## Milestone 5 — SidecarRegistry

Goal: voice-input 和 desktop-lyrics 生命周期统一。

Introduce:

```text
src/sidecars/sidecar-registry.mjs
```

Responsibilities:

- register
- ping
- status
- stop
- orphan cleanup marker

## Non-goals for now

- 不全删重写。
- 不立刻做多端口多 lifeline。
- 不重写 Python sidecar。
- 不改 OpenCode API。
- 不自动 commit / push。

## Operating rule

每一刀都必须满足：

1. `node --check` 通过。
2. 相关 unit test 通过。
3. 当前运行中 korina 的 `/status` 不被破坏。
4. 文档说的是已实现事实，不把愿景写成现实。
