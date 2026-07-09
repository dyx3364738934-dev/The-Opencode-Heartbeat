# furina

> opencode 自治感知-注入-记忆循环框架
>
> 让 opencode 从"被动应答器"变成"事件驱动的自治智能体"

**版本**: v0.1.0-beta (v26.7.10-beta)
**代号**: furina / 芙宁娜
**发布名**: kolina（版权原因，发布时改名）

---

## 这是什么

furina 是一个让 opencode 实现 7x24 自主思考的框架。

传统 opencode 是请求-响应模型:用户问一句,AI 答一句,等用户说话时 AI 是"死"的。furina 打破了这个限制--它通过外部感知层捕获事件(文件变化/定时器/协议消息/截图),经过代谢率控制后注入到 opencode 当前 session,触发 AI 自主思考。AI 的回复又可以改变外部世界,形成**感知-思考-行动**的闭环。

```
外部世界变化
  -> 感知层捕获（file-watcher / 可扩展传感器）
    -> 核心区调度（令牌桶代谢率 + 优先级队列 + 去抖）
      -> 注入区投递（prompt_async -> opencode session）
        -> AI 自主思考（可调 onlyoc / shell / 任何 MCP 工具）
          -> 产生行动 -> 改变外部世界 -> 回到感知层
```

## 为什么这很厉害

这个架构打通后,以下场景的技术路径全部成立:

| 场景 | 感知层 | 行动层 |
|------|--------|--------|
| 文档协同助手 | chokidar 监听文件变化 | onlyoc 写回 |
| AI 桌宠 | 定时截图 + 视觉模型 | shell / onlyoc |
| 微信机器人 | openchat 微信协议 | openchat 回复 |
| 桌面感知器 | 截图 + UI 自动化 | shell 模拟输入 |
| 刷课助手 | 浏览器扩展 / 截图 | shell 控制浏览器 |

更激进的是--opencode 有 shell 和 Edit 工具,能读写任何文件,包括 furina 自身的代码。这意味着 **furina 可以被 oc 自我迭代**:oc 觉得需要监听剪贴板,就自己写个 clipboard sensor 加进去。感知边界不是人定的,是 AI 自己拓展的。

## 架构:四区一狗

```
┌─────────────────────────────────────────────────────────────┐
│  furina 主进程（Node.js，独立于 oc 运行）                      │
│                                                               │
│  ┌─────────────┐   事件   ┌──────────────┐   注入   ┌──────┐ │
│  │ 感知层       │────────►│ 核心区        │────────►│注入区 │ │
│  │ sensors/    │         │ event-queue   │         │      │ │
│  │ file-watcher│         │ + 令牌桶代谢  │         │ HTTP │ │
│  │ 可扩展...   │         │ + 优先级调度  │         │  API │ │
│  └─────────────┘         └──────┬───────┘         └──┬───┘ │
│                                 │                    │     │
│                          返回值 │                    │     │
│                                 ▼                    │     │
│                          ┌──────────────┐            │     │
│                          │ 记忆区        │            │     │
│                          │ 上下文检测    │            │     │
│                          │ -> summarize  │            │     │
│                          │ -> memory 落盘│            │     │
│                          └──────────────┘            │     │
│                                                      │     │
│  ┌─────────────────────────────────────────────────────┘    │
│  │  注入的消息到达 oc -> oc 思考 -> 返回值回流                  │
│  ▼                                                           │
│  ┌──────────────┐  心跳   ┌──────────────┐  重启   ┌──────┐ │
│  │ 看门狗        │◄───────│ furina 心跳   │────────►│ oc   │ │
│  │ watchdog     │  超时   │ heartbeat.json│         │ 进程 │ │
│  │ 独立进程      │         │              │         │      │ │
│  └──────────────┘         └──────────────┘         └──────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 感知层 (sensors/)

可插拔传感器,产出标准化事件 `{source, type, payload, priority}`。

- `base-sensor.mjs` - 基类,子类实现 start/stop,检测到变化时 `this.emit(event)`
- `file-watcher.mjs` - 首个感知器,chokidar 监听文件变化,单文件去抖

扩展新感知器只需继承 BaseSensor,实现 start(),在检测到变化时调 this.emit()。

### 核心区 (src/event-queue.mjs)

事件队列 + 令牌桶代谢率 + 优先级调度 + 去抖。

**令牌桶**:
- 桶容量 `maxBurst=10` 允许瞬时突发
- 每秒补充 `refillRate=5` 控制长期平均速率
- 取事件前检查令牌,不够就等
- 每小时硬上限 `hourlyLimit=200` 防止令牌桶补太快

**优先级**: CRITICAL(100) > HIGH(80) > NORMAL(50) > LOW(20),同优先级 FIFO。

**去抖**: 相同 source+type+path 的事件在 `debounceMs` 内合并为最后一个,防止编辑器多次保存触发风暴。

### 注入区 (src/injector.mjs)

对接 opencode HTTP API:
- `POST /session/:id/prompt_async` - 异步注入(立即 204,不阻塞)
- `GET /session/:id/message?limit=N` - 轮询取消息
- `POST /session/:id/summarize` - 触发上下文压缩
- `GET /session` - 列所有 session
- `GET /global/health` - 健康检查

端口发现:环境变量 `OPENCODE_SERVER_PORT` 优先,否则 netstat + tasklist 精确定位 `OpenCode.exe` 的监听端口。

密码:从环境变量 `OPENCODE_SERVER_PASSWORD` 继承(opencode 桌面版子进程自动注入)。

完成判断:`state=completed` 或文本连续稳定 3 轮。

### 记忆区 (src/memory.mjs)

监听注入返回值,估算上下文长度,超阈值触发压缩。

**触发条件**(满足任一):
- 消息数 >= `maxMessages` (默认 40)
- 估算 token >= `maxTokens` (默认 30000)

**压缩流程**:
1. 调 `POST /session/:id/summarize` 触发 oc 内置压缩
2. 调 `search_oc_memory.py --last 1h --stats` 验证记忆可读
3. 重置计数

`search_oc_memory.py` 读写 `opencode.db` (sqlite),压缩后的 compaction part 自动写入 db,下次新 session 启动时 AI 能 search 到历史。

### 看门狗 (watchdog/watchdog.mjs)

**独立进程**,监控 furina 主进程心跳。

**心跳机制**:furina 每 2s 写 `logs/heartbeat.json` (`{ts, pid, stats}`),看门狗每 5s 读一次,`ts` 距现在 > 30s 判死。

**重启逻辑**:
1. 心跳超时 / 进程消失 -> 进入重启
2. 检测 oc 进程是否在线 (`tasklist`)
3. oc 在线 -> 直接续唤醒 furina (注入区会重新发现 oc 端口)
4. oc 离线 -> 尝试启动 oc 桌面版,等 10s 后再启 furina
5. 重启冷却 60s,最大重启 10 次

**安全边界**:看门狗代码 furina 无写权限(文件系统层面保护)。这是最后一道防线--即使 furina 自迭代把自己改崩,看门狗也能拉起来。

## 三道安全闸

自迭代系统最大的风险是正反馈失控。furina 内置三道闸:

| 闸 | 防什么 | 实现 |
|----|--------|------|
| 代谢率 | 正反馈失控 | 令牌桶 + 每小时上限 + 去抖 |
| 能力边界 | 权限膨胀 | 感知层只读,新增 shell 命令需白名单(待实现) |
| 看门狗 | 死锁/崩溃 | 独立进程,oc 无写权限,心跳超时重启 |

## 快速开始

### 前提

1. opencode 桌面版运行中(提供 HTTP server + 密码)
2. Node.js >= 20
3. 在 opencode 桌面版的内置终端里运行(继承环境变量)

### 安装

```bash
cd furina
npm install
```

### 运行

```bash
# 启动 furina(监听指定目录)
node src/main.mjs --watch /path/to/watch

# 启动看门狗(独立终端)
node watchdog/watchdog.mjs
```

### 测试

```bash
# 事件队列单元测试
node tests/test-event-queue.mjs

# 端到端测试(需要 oc 运行)
node tests/test-e2e.mjs
```

## 项目结构

```
furina/
├── src/
│   ├── main.mjs           # 主入口,串联四区
│   ├── event-queue.mjs    # 核心区:队列+令牌桶+优先级+去抖
│   ├── injector.mjs       # 注入区:session发现+注入+轮询
│   └── memory.mjs         # 记忆区:压缩+记忆落盘
├── sensors/
│   ├── base-sensor.mjs    # 感知器基类
│   └── file-watcher.mjs   # 文件感知器(chokidar)
├── watchdog/
│   └── watchdog.mjs       # 看门狗(独立进程)
├── tests/
│   ├── test-event-queue.mjs  # 22项单元测试
│   └── test-e2e.mjs          # 11项端到端测试
├── logs/
│   ├── heartbeat.json     # 心跳文件(看门狗读)
│   ├── furina-main.log    # 主进程日志
│   └── watchdog.log       # 看门狗日志
├── config/                # 配置(待填充)
├── docs/                  # 文档
└── package.json
```

## 配置参数

### 事件队列 (event-queue.mjs)

| 参数 | 默认 | 说明 |
|------|------|------|
| maxBurst | 10 | 令牌桶容量(瞬时突发上限) |
| refillRate | 5 | 每秒补充令牌数(长期平均速率) |
| hourlyLimit | 200 | 每小时事件硬上限 |
| debounceMs | 500 | 去抖毫秒 |

### 注入区 (injector.mjs)

| 参数 | 默认 | 说明 |
|------|------|------|
| sessionId | null | 锁定 session(null=自动找最新) |
| pollIntervalMs | 2000 | 轮询间隔 |
| pollTimeoutMs | 180000 | 单次等待超时(3分钟) |
| stableThreshold | 3 | 文本稳定几轮判完成 |

### 记忆区 (memory.mjs)

| 参数 | 默认 | 说明 |
|------|------|------|
| maxMessages | 40 | 触发压缩的消息数 |
| maxTokens | 30000 | 触发压缩的 token 估算 |
| charsPerToken | 2.5 | 中文约 2.5 字/token |

### 看门狗 (watchdog.mjs)

| 参数 | 默认 | 说明 |
|------|------|------|
| --interval | 5000 | 检查间隔 |
| --timeout | 30000 | 心跳超时阈值 |
| --max-restart | 10 | 最大重启次数 |
| --cooldown | 60000 | 重启冷却 |

## 测试结果

### 事件队列单元测试: 22/22 通过

- 基本入队出队 ✓
- 优先级调度 ✓ (critical > high > normal > low)
- 令牌桶节流 ✓ (突发 5 个放行 3 个,补令牌后继续)
- 去抖合并 ✓ (同 key 3 个事件合并为 1)
- 每小时上限 ✓ (超限丢弃)
- 统计信息 ✓

### 端到端测试: 11/11 通过

- 注入区发现 oc server ✓
- session 解析 ✓
- 文件感知器触发 ✓
- 事件入队 ✓
- 调度取出 ✓
- 消息构造 ✓
- 代谢率统计 ✓

### 真实环境验证

在 opencode 桌面版 v1.17.13 上实测:
- furina 后台启动,监听 `watch-test/` 目录
- 创建 `trigger.txt` 文件
- 1 秒内感知 -> 去抖 -> 注入 -> 消息到达 oc 当前 session
- oc 读取文件内容并回复
- **完整链路跑通**

## 技术原理:opencode 为什么能被外部注入

opencode 本身是 client-server 架构:
- TUI 是 server 的一个 client
- server 暴露 OpenAPI 3.1 HTTP 接口
- 任何 HTTP client 都能调用

关键 API:
- `POST /session/:id/prompt_async` - 异步注入消息,立即返回 204
- `GET /session/:id/message?limit=N` - 轮询取消息列表
- `POST /session/:id/summarize` - 触发上下文压缩

端口发现:opencode 桌面版启动时随机分配端口,通过 netstat + tasklist 精确定位 `OpenCode.exe` 的监听端口。

密码:桌面版生成临时密码,注入子进程环境变量 `OPENCODE_SERVER_PASSWORD`。furina 作为子进程继承此变量。

## 已知限制

1. **Windows 专用**:端口发现用 `tasklist`/`netstat`,跨平台需适配(linux 改 `ps`/`ss`)
2. **单 session**:当前只对接一个 session,多 session 管理待实现
3. **能力白名单未实现**:感知层理论上可被 oc 自迭代添加任意 shell 命令,需要白名单约束
4. **SSE 未用**:轮询取消息有 2s 延迟,可升级为 SSE (`GET /global/event`) 实时推送
5. **fork 未实现**:长轮询时单 session 会膨胀,summarize 后应 fork 新 session

## 路线图

- [x] v0.1.0-beta:四区一狗核心架构 + 文件感知器 + 测试
- [ ] v0.2.0:能力白名单 + SSE 实时事件 + fork 长上下文管理
- [ ] v0.3.0:多感知器(剪贴板/定时器/截图)+ 多 session 路由
- [ ] v0.4.0:oc 自迭代感知层(受白名单约束的安全自我进化)

## 依赖

- `chokidar` ^4.0.0 - 跨平台文件监听
- Node.js >= 20 - 原生 fetch / AbortSignal.timeout

## License

MIT
