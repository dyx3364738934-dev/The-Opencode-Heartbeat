"""
korina MCP server - opencode 适配层
stdio MCP server，1 个元工具 korina_call 包多个子命令，转发到 korina HTTP API（9999）
让 oc 能调 korina 工具集：多会话绑定 + 定时任务 + 注入 + 续命

v0.8 改动：
  - 项目从 furina 更名为 korina（目录名也改了）
  - 砍 recall / memory_set（记忆交给 oc 自己 search_oc_memory）
  - 加多会话绑定（bind_session / unbind_session / list_bound_sessions）
  - 加定时任务管理（add/remove/toggle/update/list timer_task）
  - intent 精简 5 种（砍 koko/auto-recall，system→sensor）

依赖: pip install mcp httpx
启动: 由 opencode 以 local MCP 方式拉起（stdio）
"""
import asyncio
import json
import sys
import os

import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

KORINA_PORT = os.environ.get("KORINA_PORT", "9999")
KORINA_URL = os.environ.get("KORINA_URL", f"http://127.0.0.1:{KORINA_PORT}")
KORINA_TIMEOUT = 30

server = Server("korina")

# ============================================================
# 元工具 korina_call
# ============================================================

KORINA_CALL_DOC = """
korina 框架控制桥。控制 korina 的注入、对话管理、多会话绑定、定时任务、配置。
korina = oc 的心跳底座（定时任务调度 + 注入 + 续命 + 多会话），可构建 agent 工作流生态。
调用：korina_call(tool=<命令名>, params={...})。

子工具列表（v0.9.5 清理后）：
- 状态与心跳：
  - status: korina 当前状态（PID/uptime/session/queue）
  - presets: 读所有配置预设
  - get_heartbeat_interval: 查心跳间隔 + 下次心跳预计（人话格式）
- 对话管理：
  - sessions: 列所有 oc 对话（id/title/model/updated/tokens）
  - session_create: 新开对话 params={title}
  - session_messages: 读对话消息 params={sessionId?, limit?}
  - session_send: 发任务给指定对话 params={sessionId, text, model?}
  - session_model: 切换会话模型 params={sessionId, provider, model}
  - binding: 读绑定状态
- 多会话绑定（per-session 心跳/任务）：
  - bind_session: 绑定一个 session params={sessionId, intervalMs?, message?}
  - unbind_session: 解绑 params={sessionId}
  - list_bound_sessions: 列所有绑定的 session
- 定时任务：
  - set_heartbeat_interval: 改主心跳间隔 params={minutes}
  - add_timer_task: 加定时任务 params={name, intervalMs, message}
  - remove_timer_task: 删任务 params={name}
  - list_timer_tasks: 列所有任务
  - 注意：toggle_timer_task / update_timer_task 已移除，timer 插件无对应端点
- agent 集群：
  - cluster_create: 批量创建 agent params={tasks:[{title,text,model?}]}
  - cluster_collect: 收集集群回复 params={sessionIds:[...]}
- 注入：
  - inject: 往对话注入消息 params={text, intent?, source?, sessionId?}
- 记忆：
  - summarize: 触发上下文压缩
- 配置与迭代：
  - set_preset: 改配置 params={key, value}
  - shutdown: 关闭 korina（写停止标志）params={reason?}

v0.9.5 清理掉的旧声明（实现缺失或路径错）：
  - bind_status / bind_current: 拆解到独立工具（korina_binding, get_heartbeat_interval）
  - heartbeat: 同上
  - session_switch: 由 session_send 替代
  - workflow_*: 无数据模型，整个功能移除
  - startup / restart_*: 留作 v0.9.6 重构
  - providers: 模型列表查 opencode.jsonc，不再走 korina
  - toggle_timer_task / update_timer_task: timer 插件无对应端点

注意：
  1. 记忆检索请用 oc 自己的 search_oc_memory（语义搜索更强），korina 不管记忆
  2. silent 注入（不进队列/不等回复，agent 内部通讯）请用独立的 korina_inject_intent 工具
  3. 5 种 intent：survival / sensor / self-direct / user / custom
"""

SUB_TOOLS = [
    # 状态
    "status", "presets", "get_heartbeat_interval",
    # TTS 工具 -- 唯一输出链路
    "tts_capabilities", "tts_speak", "tts_quick", "tts_preview", "tts_speak_and_inject",
    # 心跳控制（v0.9.2 新增）
    "heartbeat_prompt", "heartbeat_pause", "heartbeat_resume",
    # 对话管理
    "sessions", "session_create", "session_messages", "session_send", "session_model",
    # 端口绑定查询（v0.9.2 新增）
    "binding",
    # 多会话绑定
    "bind_session", "unbind_session", "list_bound_sessions",
    # 定时任务
    "set_heartbeat_interval", "add_timer_task", "remove_timer_task", "list_timer_tasks",
    # agent 集群
    "cluster_create", "cluster_collect",
    # 注入
    "inject",
    # 记忆（砍 recall/memory_set，只留 summarize）
    "summarize",
    # 配置与迭代
    "set_preset", "shutdown",
]

# 子工具名 -> (HTTP method, path)
# v0.9.5 清理：移除不存在的端点声明
TOOL_ROUTES = {
    # 状态
    "status":                    ("GET",  "/status"),
    "presets":                   ("GET",  "/presets"),
    "get_heartbeat_interval":    ("GET",  "/heartbeat/interval"),

    # TTS 工具（v0.9.2 新增）
    "tts_capabilities":          ("GET",  "/tts/capabilities"),
    "tts_speak":                 ("POST", "/tts/speak"),
    "tts_quick":                 ("POST", "/tts/quick"),
    "tts_preview":               ("POST", "/tts/preview"),
    "tts_speak_and_inject":      ("POST", "/tts/speak-and-inject"),

    # 心跳控制（v0.9.2 新增）
    "heartbeat_prompt":          ("POST", "/heartbeat/prompt"),
    "heartbeat_pause":           ("POST", "/heartbeat/pause"),
    "heartbeat_resume":          ("POST", "/heartbeat/resume"),

    # 对话管理
    "sessions":                  ("GET",  "/sessions"),
    "session_create":            ("POST", "/session/create"),
    "session_messages":          ("GET",  "/session/messages"),
    "session_send":              ("POST", "/session/send"),
    "session_model":             ("POST", "/session/model"),
    "binding":                   ("GET",  "/binding"),

    # 多会话绑定
    "bind_session":              ("POST", "/bind-session"),
    "unbind_session":            ("POST", "/unbind-session"),
    "list_bound_sessions":       ("GET",  "/sessions/bound"),

    # 定时任务
    "set_heartbeat_interval":    ("POST", "/heartbeat/interval"),
    "add_timer_task":            ("POST", "/timer/tasks"),
    "remove_timer_task":         ("POST", "/timer/tasks/delete"),
    "list_timer_tasks":          ("GET",  "/timer/tasks"),

    # agent 集群
    "cluster_create":            ("POST", "/cluster/create"),
    "cluster_collect":           ("POST", "/cluster/collect"),

    # 注入
    "inject":                    ("POST", "/inject"),

    # 记忆
    "summarize":                 ("POST", "/summarize"),

    # 配置与迭代
    "set_preset":                ("POST", "/preset"),
    "shutdown":                  ("POST", "/shutdown"),
}

# ============================================================
# 独立工具 korina_inject_intent（silent 注入，agent 内部通讯）
# ============================================================

INJECT_INTENT_DOC = """
korina 注入意图工具 -- oc 自由控制 silent 注入（不进 dispatch 队列，不等回复）。

与 korina_call(inject) 的区别：
  - korina_call(inject) = 进 dispatch 队列，等 oc 回复
  - 本工具 = silent 注入，不进队列，不等回复（agent 内部通讯专用）

用途：
  1. oc 派给自己的任务（self-direct）："检查 X 文件"、"复盘 Y"
  2. 续命/唤醒消息（survival）：korina 拉起新 oc 后注入
  3. sensor 事件通知（sensor）：文件变化、端口变化

调用：korina_inject_intent(text=<正文>, intent=<意图>, source=<来源>)

可用 intent（5 种）：
  - survival: 续命消息（oc 重启后唤醒）
  - sensor: korina sensor 自动事件
  - self-direct: oc 派给自己的任务（默认）
  - user: 默认用户消息
  - custom: 自定义（高级）

可用 source（仅标记用）：koko / korina / oc / timer / file-watcher / control / cluster / http

返回：{ok, intent, source, msg}
"""

INJECT_INTENTS = ["survival", "sensor", "self-direct", "user", "custom"]
INJECT_SOURCES = ["koko", "korina", "oc", "timer", "file-watcher", "control", "cluster", "http"]


def _get_password():
    """从 korina/logs/oc-password.txt 读密码，用于 Basic auth"""
    import pathlib
    import os
    # 优先用 KORINA_ROOT 环境变量；其次相对脚本位置（mcp/ 的父目录）；最后 ~/Desktop/korina 兜底
    root = os.environ.get("KORINA_ROOT")
    if not root:
        mcp_dir = pathlib.Path(__file__).resolve().parent
        root = mcp_dir.parent
    pwd_file = pathlib.Path(root) / "logs" / "oc-password.txt"
    if pwd_file.exists():
        try:
            data = json.loads(pwd_file.read_text(encoding="utf-8"))
            return data.get("password", "")
        except Exception:
            pass
    return ""


TOOLS = [
    Tool(
        name="korina_call",
        description=KORINA_CALL_DOC,
        inputSchema={
            "type": "object",
            "properties": {
                "tool": {
                    "type": "string",
                    "enum": SUB_TOOLS,
                    "description": "要调用的子工具名（见 description 里的文档）",
                },
                "params": {
                    "type": "object",
                    "description": "子工具的参数对象。无参工具传 {}。具体参数见 description。",
                    "additionalProperties": True,
                },
            },
            "required": ["tool"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_inject_intent",
        description=INJECT_INTENT_DOC,
        inputSchema={
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "要注入的正文（agent-hint 会自动加上）",
                },
                "intent": {
                    "type": "string",
                    "enum": INJECT_INTENTS,
                    "default": "self-direct",
                    "description": "注入意图（决定 agent-hint 和包装方式）",
                },
                "source": {
                    "type": "string",
                    "enum": INJECT_SOURCES,
                    "default": "oc",
                    "description": "注入来源（仅标记用，方便 oc 识别）",
                },
            },
            "required": ["text"],
            "additionalProperties": False,
        },
    ),
    # ===== v0.9.3: 独立工具（拍平 korina_call 子工具） =====
    Tool(
        name="korina_status",
        description="查 korina 运行状态：PID、运行时间、绑定的 session、队列积压、日限用量。无参数。",
        inputSchema={
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_sessions",
        description="列出 oc 中所有 session（对话）。返回 id/title/model/updated/cost。",
        inputSchema={
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_session_send",
        description="向指定 oc session 发送消息并等待回复。支持指定 model 切换模型。",
        inputSchema={
            "type": "object",
            "properties": {
                "sessionId": {"type": "string", "description": "目标 session ID（必填）"},
                "text": {"type": "string", "description": "要发送的消息正文"},
                "model": {"type": "object", "description": "可选。切换模型，如 {providerID:'opencode', modelID:'deepseek-v4-flash-free'}"},
                "waitForReply": {"type": "boolean", "description": "是否等回复（默认 true）", "default": True},
            },
            "required": ["sessionId", "text"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_tts_speak",
        description="让 Koko 听到语音。TTS 是 korina 唯一能让 Koko 听到声音的输出链路。不调这个 = Koko 听不到你。",
        inputSchema={
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "要说的话（≤500字，会自动去 markdown）"},
                "emotion": {"type": "string", "enum": ["happy","sad","angry","fearful","disgusted","surprised","neutral","calm"], "description": "情绪（默认 neutral）"},
                "speed": {"type": "number", "description": "语速 [0.5-2]，默认 1.0"},
                "pitch": {"type": "integer", "description": "音调 [-12,12]，默认 0"},
                "vol": {"type": "number", "description": "音量 (0,10]，默认 1.0"},
            },
            "required": ["text"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_set_heartbeat_interval",
        description="修改心跳间隔。",
        inputSchema={
            "type": "object",
            "properties": {
                "minutes": {"type": "number", "description": "心跳间隔（分钟）"},
                "seconds": {"type": "number", "description": "心跳间隔（秒），优先级低于 minutes"},
            },
            "required": [],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_add_timer_task",
        description="添加一个定时任务（除了默认心跳之外的额外任务）。",
        inputSchema={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "任务名（唯一标识）"},
                "message": {"type": "string", "description": "触发时注入的消息模板"},
                "intervalMs": {"type": "integer", "description": "间隔毫秒（默认 180000 = 3分钟）"},
                "sessionId": {"type": "string", "description": "注入到哪个 session（默认 korina 绑定 session）"},
                "intent": {"type": "string", "enum": INJECT_INTENTS, "description": "注入意图（默认 sensor）"},
            },
            "required": ["name", "message"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_set_preset",
        description="热修改 korina 配置项（无需重启）。可改 mode/timer/heartbeat/tts 等。",
        inputSchema={
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "配置键，如 'mode' 或 'timer.intervalMs'"},
                "value": {"description": "配置值。mode 可选: silent/idle/task/observe"},
            },
            "required": ["key", "value"],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_heartbeat_pause",
        description="暂停心跳注入。暂停后 korina 不再定时唤醒 oc。",
        inputSchema={
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_heartbeat_resume",
        description="恢复心跳注入。",
        inputSchema={
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
    ),
    Tool(
        name="korina_binding",
        description="查看 korina 当前绑定的 oc 端口和 session ID。",
        inputSchema={
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
    ),
    Tool(
        # v0.9.3: AI 调用的入口 —— "绑定语音输入到指定/当前会话"
        name="korina_bind_voice_input",
        description=(
            "把语音输入端口锁定到指定 oc 对话（或 korina 当前主 session）。"
            "传 sessionId 则绑定到该对话；不传则绑定到 korina 当前主 session。"
            "后续所有通过 Alt+语音录入的转写文本都会注入到此 session。"
            "AI 在用户说『绑定语音输入到当前对话』『语音锁到这里』『/绑定当前会话语音输入』"
            "或『绑定语音输入到 <sessionId>』时调用。可选参数 sessionId。"
            "返回：{ ok: true, target: { sessionId, title, setAt } }"
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "sessionId": {"type": "string", "description": "目标 session id；省略则绑定 korina 主 session"},
            },
            "required": [],
            "additionalProperties": False,
        },
    ),
    Tool(
        # v0.9.3: 解绑 — 让语音端口恢复跟随 korina 默认 session
        name="korina_unbind_voice_input",
        description=(
            "解绑语音端口。之前通过 korina_bind_voice_input 锁定的目标 session 会失效，"
            "后续语音输入恢复跟随 korina 当前绑定的 session。无参数。"
        ),
        inputSchema={
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
    ),
]  


@server.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


async def _korina_call_http(method: str, path: str, params: dict) -> str:
    """通用 korina HTTP 调用，返回 text 结果"""
    import base64
    password = _get_password()
    headers = {"Content-Type": "application/json"}
    if password:
        auth = base64.b64encode(f"opencode:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {auth}"

    url = f"{KORINA_URL}{path}"

    async with httpx.AsyncClient(timeout=KORINA_TIMEOUT) as client:
        if method == "GET":
            if params:
                # GET 参数走 query string（korina http-server 对 GET 不读 json body）
                from urllib.parse import urlencode
                sep = "?" if "?" not in url else "&"
                response = await client.get(f"{url}{sep}{urlencode(params)}", headers=headers)
            else:
                response = await client.get(url, headers=headers)
        elif method == "DELETE":
            response = await client.delete(url, headers=headers)
        elif method == "PUT":
            response = await client.put(url, json=params, headers=headers)
        else:
            response = await client.post(url, json=params, headers=headers)

        if response.status_code == 401:
            return f"认证失败（密码可能过期）: {response.text}"
        if response.status_code == 404:
            return f"端点不存在: {method} {path}\nkorina 可能没用新代码启动"

        result_text = response.text
        try:
            result_json = response.json()
            result_text = json.dumps(result_json, indent=2, ensure_ascii=False)
        except Exception:
            pass
        return result_text


def _route_allowed_by_capabilities(routes: list, method: str, path: str) -> bool:
    """Return whether method/path is advertised by /capabilities."""
    target_method = method.upper()
    target_path = path.rstrip("/") or "/"
    for route in routes or []:
        if not isinstance(route, dict):
            continue
        route_method = str(route.get("method", "")).upper()
        route_path = str(route.get("path", "")).rstrip("/") or "/"
        if route_method == target_method and route_path == target_path:
            return True
    return False


async def _capability_guard(method: str, path: str) -> str | None:
    """Block calls to routes that the daemon does not advertise.

    Migration rule: if the running daemon has no /capabilities endpoint yet
    (404), allow legacy calls so old korina can still be controlled long enough
    to restart into the new code.
    """
    if os.environ.get("KORINA_SKIP_CAPABILITIES_GUARD") == "1":
        return None
    if path in ("/capabilities", "/status"):
        return None

    import base64
    password = _get_password()
    headers = {"Content-Type": "application/json"}
    if password:
        auth = base64.b64encode(f"opencode:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {auth}"

    async with httpx.AsyncClient(timeout=KORINA_TIMEOUT) as client:
        response = await client.get(f"{KORINA_URL}/capabilities", headers=headers)

    if response.status_code == 404:
        return None
    if response.status_code == 401:
        return f"capabilities guard: 认证失败，拒绝调用 {method} {path}: {response.text}"
    if not response.is_success:
        return f"capabilities guard: /capabilities 返回 HTTP {response.status_code}，拒绝调用 {method} {path}"

    try:
        data = response.json()
    except Exception as e:
        return f"capabilities guard: /capabilities JSON 解析失败，拒绝调用 {method} {path}: {e}"

    routes = data.get("httpRoutes", []) if isinstance(data, dict) else []
    if _route_allowed_by_capabilities(routes, method, path):
        return None

    return (
        f"capabilities guard: 当前 korina 未声明端点 {method} {path}，已阻止调用。\n"
        f"请先 GET /capabilities 确认真实能力，或更新 MCP route。"
    )


async def _guarded_korina_call_http(method: str, path: str, params: dict) -> str:
    guard_error = await _capability_guard(method, path)
    if guard_error:
        return guard_error
    return await _korina_call_http(method, path, params)


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "korina_call":
        tool = arguments.get("tool")
        params = arguments.get("params", {})

        if tool not in TOOL_ROUTES:
            return [TextContent(type="text", text=f"未知子工具: {tool}\n可用: {', '.join(SUB_TOOLS)}")]

        method, path = TOOL_ROUTES[tool]

        try:
            result_text = await _guarded_korina_call_http(method, path, params)
            return [TextContent(type="text", text=f"[korina:{tool}] {method} {path}\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 korina HTTP server ({KORINA_URL})。\nkorina 可能没启动。检查: Get-Process node")]
        except httpx.TimeoutException:
            return [TextContent(type="text", text=f"korina HTTP 请求超时 ({KORINA_TIMEOUT}s)。\nkorina 可能卡住或 oc 不在线。")]
        except Exception as e:
            return [TextContent(type="text", text=f"korina 调用异常: {type(e).__name__}: {e}")]

    if name == "korina_inject_intent":
        text = arguments.get("text")
        if not text:
            return [TextContent(type="text", text="korina_inject_intent: text 必填")]
        intent = arguments.get("intent", "self-direct")
        source = arguments.get("source", "oc")
        try:
            result_text = await _guarded_korina_call_http("POST", "/inject/intent", {
                "text": text,
                "intent": intent,
                "source": source,
            })
            return [TextContent(type="text", text=f"[korina:inject_intent] intent={intent} source={source}\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 korina HTTP server ({KORINA_URL})")]
        except Exception as e:
            return [TextContent(type="text", text=f"korina_inject_intent 异常: {type(e).__name__}: {e}")]

    # ===== v0.9.3: 独立工具处理 =====
    if name in ("korina_status", "korina_sessions", "korina_binding",
                 "korina_heartbeat_pause", "korina_heartbeat_resume",
                 "korina_bind_voice_input"):
        # 无参或简单 GET/POST
        route_map = {
            "korina_status": ("GET", "/status"),
            "korina_sessions": ("GET", "/sessions"),
            "korina_binding": ("GET", "/binding"),
            "korina_heartbeat_pause": ("POST", "/heartbeat/pause"),
            "korina_heartbeat_resume": ("POST", "/heartbeat/resume"),
            "korina_bind_voice_input": ("POST", "/voice-input/bind"),
        }
        method, path = route_map[name]
        # korina_bind_voice_input 支持可选 sessionId，透传给 /voice-input/bind
        params = {}
        if name == "korina_bind_voice_input" and arguments.get("sessionId"):
            params["sessionId"] = arguments["sessionId"]
        try:
            result_text = await _guarded_korina_call_http(method, path, params)
            return [TextContent(type="text", text=f"[{name}]\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 korina ({KORINA_URL})")]
        except Exception as e:
            return [TextContent(type="text", text=f"{name} 异常: {type(e).__name__}: {e}")]

    if name == "korina_unbind_voice_input":
        # v0.9.3: 解绑语音端口（恢复跟随 korina 默认 session）
        try:
            result_text = await _guarded_korina_call_http("DELETE", "/voice-input/bind", {})
            return [TextContent(type="text", text=f"[korina_unbind_voice_input]\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 korina ({KORINA_URL})")]
        except Exception as e:
            return [TextContent(type="text", text=f"{name} 异常: {type(e).__name__}: {e}")]  

    if name == "korina_session_send":
        sid = arguments.get("sessionId")
        text = arguments.get("text")
        if not sid or not text:
            return [TextContent(type="text", text="korina_session_send: sessionId + text 必填")]
        params = {"sessionId": sid, "text": text}
        if arguments.get("model"):
            params["model"] = arguments["model"]
        if "waitForReply" in arguments:
            params["waitForReply"] = arguments["waitForReply"]
        try:
            result_text = await _guarded_korina_call_http("POST", "/session/send", params)
            return [TextContent(type="text", text=f"[korina_session_send] -> {sid[:16]}...\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 korina ({KORINA_URL})")]
        except Exception as e:
            return [TextContent(type="text", text=f"korina_session_send 异常: {type(e).__name__}: {e}")]

    if name == "korina_tts_speak":
        text = arguments.get("text")
        if not text:
            return [TextContent(type="text", text="korina_tts_speak: text 必填")]
        params = {"text": text}
        for k in ("emotion", "speed", "pitch", "vol"):
            if k in arguments:
                params[k] = arguments[k]
        try:
            result_text = await _guarded_korina_call_http("POST", "/tts/speak", params)
            return [TextContent(type="text", text=f"[korina_tts_speak]\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 korina ({KORINA_URL})")]
        except Exception as e:
            return [TextContent(type="text", text=f"korina_tts_speak 异常: {type(e).__name__}: {e}")]

    if name == "korina_set_heartbeat_interval":
        params = {}
        if "minutes" in arguments:
            params["minutes"] = arguments["minutes"]
        if "seconds" in arguments:
            params["seconds"] = arguments["seconds"]
        if not params:
            return [TextContent(type="text", text="korina_set_heartbeat_interval: 需要 minutes 或 seconds")]
        try:
            result_text = await _guarded_korina_call_http("POST", "/heartbeat/interval", params)
            return [TextContent(type="text", text=f"[korina_set_heartbeat_interval]\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 korina ({KORINA_URL})")]
        except Exception as e:
            return [TextContent(type="text", text=f"korina_set_heartbeat_interval 异常: {type(e).__name__}: {e}")]

    if name == "korina_add_timer_task":
        nm = arguments.get("name")
        msg = arguments.get("message")
        if not nm or not msg:
            return [TextContent(type="text", text="korina_add_timer_task: name + message 必填")]
        params = {"name": nm, "message": msg}
        for k in ("intervalMs", "sessionId", "intent"):
            if k in arguments:
                params[k] = arguments[k]
        try:
            result_text = await _guarded_korina_call_http("POST", "/timer/tasks", params)
            return [TextContent(type="text", text=f"[korina_add_timer_task] {nm}\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 korina ({KORINA_URL})")]
        except Exception as e:
            return [TextContent(type="text", text=f"korina_add_timer_task 异常: {type(e).__name__}: {e}")]

    if name == "korina_set_preset":
        key = arguments.get("key")
        value = arguments.get("value")
        if not key or value is None:
            return [TextContent(type="text", text="korina_set_preset: key + value 必填")]
        try:
            result_text = await _guarded_korina_call_http("POST", "/preset", {"key": key, "value": value})
            return [TextContent(type="text", text=f"[korina_set_preset] {key}={value}\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 korina ({KORINA_URL})")]
        except Exception as e:
            return [TextContent(type="text", text=f"korina_set_preset 异常: {type(e).__name__}: {e}")]

    return [TextContent(type="text", text=f"未知工具: {name}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
