# korina — Opencode 的心跳底座

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![Version](https://img.shields.io/badge/version-0.9.28-blue.svg)](CHANGELOG.md)

> 给 [Opencode](https://github.com/sst/opencode) 装一颗会跳的心脏——心跳调度、消息注入、续命守护、多会话管理、TTS 语音输出、Whisper 语音输入、桌面歌词。

## korina 是什么

korina 是一个为 Opencode（开源 AI 编码助手桌面版）设计的**长时运行伴侣进程**。它在 Opencode 旁边常驻，解决几个核心问题：

- **心跳调度**——按配置间隔（5 分钟、15 分钟、1 小时等）给 AI 注入"环境快照"（系统状态 + 前台窗口 + Koko 活跃度 + 引导提示词），让 AI 有时间感、环境感知、主动权判据
- **消息注入**——把外部消息（心跳 / 语音转写 / 文件变化 / 模式切换）通过 Opencode 的 prompt 端点送进当前对话
- **续命守护**——Opencode 进程挂了自动拉起；端口漂移自动跟随；密码过期自动重读
- **多会话管理**——同时绑定多个 Opencode 会话，心跳可白名单投递到指定会话不扰民
- **TTS 语音输出**——把 AI 回复流式分段合成语音，可选播放到桌面歌词浮窗
- **Whisper 语音输入**——按住热键说话（PTT），Whisper 转写后注入到 Opencode

## 核心特性

### 心跳系统（v0.9.28 manual #53 单轨设计）

```
AI 回复完成 ──┐
              ├──> 归零 lastFireAt
korina 注入 ──┘
              │
              ▼
   poll 检查 now - lastFireAt > intervalMs ?
              │ 是
              ▼
        fire 心跳消息
```

**设计哲学**：心跳是**对话停滞信号**，不是定时打扰。
- 你和 AI 对话时——AI 持续输出 → 持续归零 → 永不 fire
- 你沉默 N 分钟——计时走完 → fire 一次心跳，AI 收到"距离上次对话 N 分钟"的信号

**信号源**：监听 Opencode 的 SSE 事件流（`message.part.updated/delta/updated`），任何 assistant 输出（reasoning / tool / text / delta）都触发归零。1 秒节流避免高频 delta 浪费 CPU。

### 插件化架构

12 个内置插件，按依赖图加载，可独立启停：

| 插件 | 职责 |
|---|---|
| `oc-injector` | Opencode 发现 + 密码匹配 + 消息注入 |
| `sse-tts-pipeline` | 监听 Opencode SSE 流 + 桥接事件到 EventBus |
| `sidecar-launcher` | 注册 + 健康检查 sidecar 进程 |
| `desktop-lyrics` | pygame 桌面歌词浮窗（显示 TTS 实时字幕） |
| `file-watcher` | 监听文件变化（chokidar）触发任务 |
| `health` | 进程健康检查 + oc 可达性检测 |
| `memory` | 长对话记忆压缩 + recall 注入 |
| `mode-router` | 关键词检测切换 AI 模式（idle/task/observe） |
| `timer` | 心跳定时器（manual #53 单轨归零） |
| `tts-tool` | AI 可调的 TTS 端点（`/tts/speak`） |
| `voice-input` | Whisper 语音输入（PTT 模式） |
| `worklog` | 定期工作汇报归档 |

### 多种启动方式

```powershell
# 推荐：可见 cmd 窗口（Alt+Tab 切到 "korina v0.9.28" 看实时日志）
.\start.ps1

# 命令行管理（start/stop/status/sessions/rebind/inject/summarize/restart）
.\korina.ps1 start
.\korina.ps1 status

# 后台守护（看门狗拉起）
.\start-watchdog.bat
```

### HTTP API（端口 9999，Basic Auth）

```
GET  /status                    服务状态
POST /shutdown                  优雅关闭
GET  /sessions                  列出 oc 所有 session
POST /rebind                    热切换到最新 oc session
POST /inject/intent             注入消息
GET  /heartbeat/interval        查心跳间隔
POST /heartbeat/interval        改心跳间隔（minutes/seconds/ms）
POST /heartbeat/pause           暂停心跳
POST /heartbeat/resume          恢复心跳
POST /voice-input/start         拉起语音输入 sidecar
POST /voice-input/bind          锁定语音到指定 session
POST /tts/speak                 TTS 朗读
POST /session/follow-heartbeat  心跳白名单 +session
```

## 安装

### 前置要求

- Windows 10/11（依赖 PowerShell + Win32 API）
- Node.js ≥ 20
- Python ≥ 3.10（sidecar 用）
- Opencode 桌面版

### 步骤

```bash
git clone https://github.com/dyx3364738934-dev/The-Opencode-Heartbeat.git
cd The-Opencode-Heartbeat
npm install
```

### 配置

```bash
# 1. 复制示例配置
copy config\presets.example.json config\presets.json

# 2. 编辑 config\presets.json：
#    - tts.apiKey: 你的 MiniMax API key（https://api.minimaxi.com）
#    - watchPath: 你想让 file-watcher 监听的目录
#    - timer.intervalMs: 心跳间隔（默认 180000 = 3 分钟）

# 3. （可选）配置语音输入
pip install keyboard openai-whisper sounddevice numpy
```

### 启动 Opencode → 启动 korina

```powershell
# 1. 启动 Opencode 桌面版（korina 会自动发现并匹配密码）

# 2. 启动 korina（推荐 start.ps1，创建可见 cmd 窗口）
.\start.ps1
```

korina 会：
1. 找到 Opencode 进程 + 端口
2. 读 `logs/oc-password.txt`（Opencode 启动时泄露）
3. 绑定到当前活跃 session
4. 启动所有 sidecar（desktop-lyrics 浮窗自动弹出）
5. 启动心跳定时器

## 使用

### 语音输入（PTT 模式）

1. AI 调用 `POST /voice-input/start` 拉起 sidecar
2. **按住 Alt 键**说话
3. **松开**自动 Whisper 转写 + 注入到 Opencode

### 心跳调参

```powershell
# 5 分钟间隔（陪伴感强）
curl -X POST http://127.0.0.1:9999/heartbeat/interval `
  -u "opencode:$pwd" -H "Content-Type: application/json" `
  -d '{"minutes": 5}'

# 暂停心跳
curl -X POST http://127.0.0.1:9999/heartbeat/pause -u "opencode:$pwd"
```

### 桌面歌词

desktop-lyrics sidecar 启动时自动弹出 pygame 窗口，显示 TTS 实时字幕。窗口位置可拖动，自动保存到 `config/lyrics-position.json`。

## 项目结构

```
korina/
├── src/
│   ├── main.mjs                # 入口
│   ├── core/                   # 核心模块（event-bus/queue, http-router, plugin-loader, presets, sidecar-registry）
│   ├── modules/heartbeat/      # 心跳模板渲染 + 系统传感器
│   ├── lifeline/               # 续命运行时 + 注册表
│   ├── state/                  # session 绑定存储
│   ├── injector.mjs            # Opencode 注入器
│   ├── injector-*.mjs          # 注入器子模块（discovery/http-ops/session-selection）
│   ├── sse-listener.mjs        # Opencode SSE 流监听
│   ├── tts.mjs                 # MiniMax TTS 客户端
│   └── ...
├── plugins/                    # 12 个业务插件
├── watchdog/                   # 看门狗
├── mcp/                        # MCP 服务器（Python）
├── config/                     # 配置（presets.json 不上传）
├── desktop-lyrics.py           # 桌面歌词 sidecar
├── voice-input.py              # 语音输入 sidecar
├── start.ps1 / korina.ps1      # PowerShell 启动脚本
├── start-watchdog.bat          # 看门狗启动
└── package.json
```

## 测试

```bash
npm test                         # E2E 测试
node tests/test-e2e.mjs          # 同上
python tests/test_voice_input_hotkey.py   # 语音输入热键测试
```

单测覆盖：
- injector 公共 API / session 选择 / 绑定 / 多端口
- lifeline 运行时
- session-binding-store
- sidecar-registry
- timer 消息渲染
- heartbeat 模板渲染器
- MCP 能力守卫

## 文档

- [架构](docs/ARCHITECTURE.md)
- [术语表](docs/GLOSSARY.md)
- [v0.10 路线图](docs/v0.10-roadmap.md)
- [重构计划](docs/REFACTOR-PLAN.md)
- [CHANGELOG](CHANGELOG.md)

## 设计理念

- **被动等待 > 主动打扰**：心跳是对话停滞信号，不是定时骚扰
- **真实数据 > 措辞扰动**：每次心跳 token 不一样靠真实环境采样，不靠同义词替换
- **可见 > 隐藏**：korina 必须在可见 cmd 窗口跑，Alt+Tab 能切到看实时日志
- **强约束启动**：必须用 `start.ps1` / `korina.ps1 start`，不能用 hidden 模式（破坏 sidecar）
- **单一信号源**：AI 回复完成是"在思考"的唯一有效信号，不堆叠多源判断

## 已知限制

- 仅支持 Windows（依赖 PowerShell + Win32 API）
- SSE 监听依赖 Opencode `/global/event` 端点（v0.3+ 协议）
- 心跳不能区分"睡着"和"不在"（都是长时间无操作）
- MiniMax TTS 是默认 provider（其他 TTS 需自己适配 `src/tts.mjs`）

## 许可证

[MIT](LICENSE) © 2026 Koko & 冬蕴雪

## 致谢

- [Opencode](https://github.com/sst/opencode) — AI 编码助手桌面版
- [MiniMax](https://api.minimaxi.com) — TTS 服务
- [OpenAI Whisper](https://github.com/openai/whisper) — 语音识别
- [pygame](https://www.pygame.org) — 桌面歌词浮窗
- [chokidar](https://github.com/paulmillr/chokidar) — 文件监听
