"""
furina MCP server - opencode 适配层
stdio MCP server，1 个元工具 furina_call 包多个子命令，转发到 furina HTTP API（9999）
让 oc（冬蕴雪）能调 furina 工具集，实现自我迭代 + agent 集群 + 对话管理

v0.5: 注入意图系统（furina_inject_intent 独立工具）
oc 自由控制注入：silent 模式（不进 dispatch/记忆），可指定 intent/source

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

FURINA_URL = "http://127.0.0.1:9999"
FURINA_TIMEOUT = 30

server = Server("furina")

# ============================================================
# 元工具 furina_call（22 子命令）
# ============================================================

FURINA_CALL_DOC = """
furina 框架控制桥。控制 furina 的注入、对话管理、记忆、配置、自我迭代、agent 集群、工作流预设。
furina = 外置元逻辑核心，oc = 核心单 agent。通过此工具 oc 可调度 furina 的全部能力。
调用：furina_call(tool=<命令名>, params={...})。

子工具列表：
- 状态与心跳：
  - status: furina 当前状态（PID/uptime/session/queue/memory）
  - heartbeat: furina 心跳检测
  - presets: 读所有配置预设
  - bind_status: 读 furina 当前锁定的 session 状态（activeSessionId/lockedAt/boundCount）
  - bind_current: 主动绑定当前 session params={sessionId?} 或 {titlePrefix?}（v0.7.10：oc 启动后自绑）
- 对话管理（agent 集群基础）：
  - sessions: 列所有 oc 对话（id/title/model/updated/tokens）
  - session_create: 新开对话 params={title}
  - session_messages: 读对话消息 params={sessionId?, limit?}
  - session_send: 发任务给指定对话 params={sessionId, text}
  - session_switch: 切换 furina 锁定的对话 params={sessionId}
- agent 集群：
  - cluster_create: 批量创建 agent + 发任务 params={tasks:[{title,text,model?}]}
  - cluster_collect: 收集集群所有对话的最新回复 params={sessionIds:[...]}
- 注入与记忆：
  - inject: 往锁定对话注入消息（进 dispatch 队列）params={text, intent?, source?}
  - recall: 触发记忆检索 params={query?, last?}
  - summarize: 触发上下文压缩
  - memory_set: 设置工作记忆 params={text}
- 工作流预设：
  - workflow_list: 列所有预设（default/desktop-pet/screenshot-tool/desktop-control/code-reviewer/researcher）
  - workflow_apply: 应用预设（切换 persona）params={preset}
  - workflow_current: 获取当前预设
  - workflow_add: 添加自定义预设 params={id, preset}
- 配置与迭代：
  - set_preset: 改配置 params={key, value}
  - restart_furina: 重启 furina（升级用）params={reason?}
  - restart_oc: 重启 oc params={reason?}
- 模型与 provider：
  - providers: 列所有可用 provider 和模型

注意：如果你想"自己给自己注入任务/对话"，请用独立的 furina_inject_intent 工具（不进 dispatch/记忆）。
"""

SUB_TOOLS = [
    # 状态
    "status", "heartbeat", "presets", "bind_status", "bind_current",
    # 对话管理
    "sessions", "session_create", "session_messages", "session_send", "session_switch",
    # agent 集群
    "cluster_create", "cluster_collect",
    # 注入与记忆
    "inject", "recall", "summarize", "memory_set",
    # 工作流预设
    "workflow_list", "workflow_apply", "workflow_current", "workflow_add",
    # 配置与迭代
    "set_preset", "restart_furina", "restart_oc",
    # 模型
    "providers",
]

# 子工具名 -> (HTTP method, path)
TOOL_ROUTES = {
    "status":            ("GET",  "/status"),
    "heartbeat":         ("GET",  "/heartbeat"),
    "presets":           ("GET",  "/presets"),
    "bind_status":       ("GET",  "/bind-status"),
    "bind_current":      ("POST", "/bind-current"),

    "sessions":          ("GET",  "/sessions"),
    "session_create":    ("POST", "/session/create"),
    "session_messages":  ("GET",  "/session/messages"),
    "session_send":      ("POST", "/session/send"),
    "session_switch":    ("POST", "/session/switch"),
    "cluster_create":    ("POST", "/cluster/create"),
    "cluster_collect":   ("POST", "/cluster/collect"),
    "inject":            ("POST", "/inject"),
    "recall":            ("POST", "/recall"),
    "summarize":         ("POST", "/summarize"),
    "memory_set":        ("POST", "/memory-set"),
    "workflow_list":     ("GET",  "/workflow/list"),
    "workflow_apply":    ("POST", "/workflow/apply"),
    "workflow_current":  ("GET",  "/workflow/current"),
    "workflow_add":      ("POST", "/workflow/add"),
    "set_preset":        ("POST", "/set-preset"),
    "restart_furina":    ("POST", "/restart-furina"),
    "restart_oc":        ("POST", "/restart-oc"),
    "providers":         ("GET",  "/providers"),
}

# ============================================================
# 独立工具 furina_inject_intent（v0.5）
# 自由控制注入：silent 模式，agent 内部通讯专用
# ============================================================

INJECT_INTENT_DOC = """
furina 注入意图工具 -- oc 自由控制注入到锁定对话。

与 furina_call(tool="inject") 的区别：
  - furina_call(inject) = 进 dispatch 队列，等 oc 回复，写记忆（Koko 视角）
  - 本工具 = silent 注入，不进队列，不等回复，不写记忆（agent 内部通讯）

用途：
  1. oc 派给自己的任务（self-direct）："检查 X 文件"、"复盘 Y"
  2. oc 派给 Koko 的纯消息（koko）：写到对话里，不触发回复
  3. 续命/唤醒消息（survival）：furina 拉起新 oc 后注入
  4. 系统通知（system）：port 变化、health 异常

调用：furina_inject_intent(text=<正文>, intent=<意图>, source=<来源>)

可用 intent：
  - survival: 续命消息，oc 启动时收到
  - auto-recall: 自动恢复上下文（带历史摘要）
  - self-direct: oc 派给自己的任务（默认）
  - koko: Koko 注入的纯消息（无标签）
  - user: 默认用户消息
  - system: 系统级通知
  - custom: 自定义（高级用法）

可用 source（仅标记用，不影响行为）：
  - koko / furina / oc / timer / file-watcher / control / cluster

返回：{ok, intent, source, msg}
"""

INJECT_INTENTS = ["survival", "auto-recall", "self-direct", "koko", "user", "system", "custom"]
INJECT_SOURCES = ["koko", "furina", "oc", "timer", "file-watcher", "control", "cluster", "http"]


def _get_password():
    """从 furina/logs/oc-password.txt 读密码，用于 Basic auth"""
    import pathlib
    pwd_file = pathlib.Path.home() / "Desktop" / "大宗" / "furina" / "logs" / "oc-password.txt"
    if pwd_file.exists():
        try:
            data = json.loads(pwd_file.read_text(encoding="utf-8"))
            return data.get("password", "")
        except:
            pass
    return ""


TOOLS = [
    # 元工具
    Tool(
        name="furina_call",
        description=FURINA_CALL_DOC,
        inputSchema={
            "type": "object",
            "properties": {
                "tool": {
                    "type": "string",
                    "enum": SUB_TOOLS,
                    "description": "要调用的子工具名（见 description 里的文档）"
                },
                "params": {
                    "type": "object",
                    "description": "子工具的参数对象。无参工具传 {}。具体参数见 description。",
                    "additionalProperties": True
                }
            },
            "required": ["tool"],
            "additionalProperties": False
        }
    ),
    # v0.5: 独立注入意图工具（agent 内部通讯）
    Tool(
        name="furina_inject_intent",
        description=INJECT_INTENT_DOC,
        inputSchema={
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "要注入到 oc 的正文（agent-hint 会自动加上）"
                },
                "intent": {
                    "type": "string",
                    "enum": INJECT_INTENTS,
                    "default": "self-direct",
                    "description": "注入意图（决定 agent-hint 和包装方式）"
                },
                "source": {
                    "type": "string",
                    "enum": INJECT_SOURCES,
                    "default": "oc",
                    "description": "注入来源（仅标记用，方便 oc 识别）"
                }
            },
            "required": ["text"],
            "additionalProperties": False
        }
    ),
]


@server.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


async def _furina_call_http(method: str, path: str, params: dict) -> str:
    """通用 furina HTTP 调用，返回 text 结果"""
    import base64
    password = _get_password()
    headers = {"Content-Type": "application/json"}
    if password:
        auth = base64.b64encode(f"opencode:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {auth}"

    url = f"{FURINA_URL}{path}"

    async with httpx.AsyncClient(timeout=FURINA_TIMEOUT) as client:
        if method == "GET":
            if params:
                response = await client.request("GET", url, json=params, headers=headers)
            else:
                response = await client.get(url, headers=headers)
        else:
            response = await client.post(url, json=params, headers=headers)

        if response.status_code == 401:
            return f"认证失败（密码可能过期）: {response.text}"
        if response.status_code == 404:
            return f"端点不存在: {method} {path}\nfurina 可能没用新代码启动"

        result_text = response.text
        try:
            result_json = response.json()
            result_text = json.dumps(result_json, indent=2, ensure_ascii=False)
        except:
            pass
        return result_text


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "furina_call":
        tool = arguments.get("tool")
        params = arguments.get("params", {})

        if tool not in TOOL_ROUTES:
            return [TextContent(type="text", text=f"未知子工具: {tool}\n可用: {', '.join(SUB_TOOLS)}")]

        method, path = TOOL_ROUTES[tool]
        try:
            result_text = await _furina_call_http(method, path, params)
            return [TextContent(type="text", text=f"[furina:{tool}] {method} {path}\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 furina HTTP server ({FURINA_URL})。\nfurina 可能没启动。检查: Get-Process node")]
        except httpx.TimeoutException:
            return [TextContent(type="text", text=f"furina HTTP 请求超时 ({FURINA_TIMEOUT}s)。\nfurina 可能卡住或 oc 不在线。")]
        except Exception as e:
            return [TextContent(type="text", text=f"furina 调用异常: {type(e).__name__}: {e}")]

    if name == "furina_inject_intent":
        text = arguments.get("text")
        if not text:
            return [TextContent(type="text", text="furina_inject_intent: text 必填")]
        intent = arguments.get("intent", "self-direct")
        source = arguments.get("source", "oc")
        try:
            result_text = await _furina_call_http("POST", "/inject/intent", {
                "text": text,
                "intent": intent,
                "source": source,
            })
            return [TextContent(type="text", text=f"[furina:inject_intent] intent={intent} source={source}\n{result_text}")]
        except httpx.ConnectError:
            return [TextContent(type="text", text=f"无法连接 furina HTTP server ({FURINA_URL})")]
        except Exception as e:
            return [TextContent(type="text", text=f"furina_inject_intent 异常: {type(e).__name__}: {e}")]

    return [TextContent(type="text", text=f"未知工具: {name}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
