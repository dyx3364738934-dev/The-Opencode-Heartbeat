# Changelog

All notable changes to Opencode Heartbeat are documented here.

## [0.7.10-beta] - 2026-07-10

### Initial Public Release

**Note**: Project was originally named "furina" (internal v0.4 / v0.5). Renamed to "Opencode Heartbeat" for public release.

### Features

- **Heartbeat timer**: Default 30s pulse injection into current OC session
- **Auto-resurrection**: OC crash detection (15s tick) → spawnOC + 25s "you awake" inject
- **Cross-conversation memory**: Session lock + memory checkpoint + recall
- **MCP integration**: 23 tools (2 standalone + 21 sub-commands)
  - `heartbeat_call` — meta tool with 21 sub-commands
  - `heartbeat_inject_intent` — silent inject (no dispatch, no memory)
- **Intent system**: 7 intents (survival/auto-recall/self-direct/koko/user/system/custom) replace hardcoded `[furina]` tags
- **Plugin auto-bootstrap**: `opencode-bootstrap.mjs` leaks password + starts heartbeat on OC launch
- **Health monitor**: Async port detection (no event loop blocking)
- **HTTP API**: 26 endpoints (status, sessions, inject, recall, workflow, etc.)
- **Workflow presets**: 6 personas (default/desktop-pet/screenshot-tool/desktop-control/code-reviewer/researcher)
- **heartbeat-tail CLI**: Chinese-friendly log viewer with filter/follow modes
- **Control channel**: Hot reload via `control.json` (switch-session, inject, status, etc.)

### Architecture

```
[file-watcher + timer] → EventQueue (token bucket) → dispatchHandler
                                                         ↓
                              [memory.record + injector.injectAndWait]
                                                         ↓
                                              [oc session/<sid>/prompt_async]
                                                         ↓
                                                  [oc _poll (long-poll)]
```

### Endpoints (HTTP :9999)

- `GET  /status` / `/heartbeat` / `/presets` / `/workflow/list` / `/workflow/current` / `/sessions` / `/providers`
- `POST /inject` / `/inject/intent` / `/switch-session` / `/set-preset` / `/restart-furina` / `/restart-oc`
- `POST /recall` / `/summarize` / `/memory-set` / `/session/create` / `/session/send` / `/session/switch`
- `POST /cluster/create` / `/cluster/collect` / `/workflow/apply` / `/workflow/add`
- `GET  /session/messages`

### Components

- `src/main.mjs` — Main entry point
- `src/injector.mjs` — OC injection (port discovery, password, inject, poll, health monitor)
- `src/inject-intent.mjs` — Intent registry + renderer
- `src/memory.mjs` — Memory (checkpoint, recall, recentRecall)
- `src/event-queue.mjs` — Event queue + token bucket
- `src/control-channel.mjs` — control.json hot-reload
- `src/presets.mjs` — Config system
- `src/health-checker.mjs` — OC health tracking
- `src/mode-manager.mjs` — self-talk/find-work/observe modes
- `src/http-server.mjs` — 26 HTTP endpoints
- `src/worklog.mjs` — Hourly work report generator
- `src/workflow-presets.mjs` — Persona presets
- `sensors/file-watcher.mjs` — File change sensor
- `sensors/timer-sensor.mjs` — Periodic sensor
- `watchdog/heartbeat-tail.mjs` — Log viewer CLI
- `watchdog/watchdog.mjs` / `watchdog.py` — Legacy external watchdog (replaced by plugin bootstrap)
- `mcp/heartbeat_mcp_server.py` — MCP server (stdio → HTTP :9999)
- `plugins/opencode-bootstrap.mjs` — OC plugin (password leak + heartbeat auto-start)
- `memory/` — Persona + cross-conversation memory files

### Known Limitations

1. Heartbeat self-revive requires OC restart (plugin bootstrap is the only fallback)
2. Silent inject still adds to OC conversation history (only skips heartbeat memory)
3. Agent cluster is "parallel sessions" not "collaborative agents"
