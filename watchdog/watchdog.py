#!/usr/bin/env python3
"""
furina 看门狗（独立 Python 进程）

职责：
  1. 定时检测 oc 桌面版进程是否在线
  2. oc 不在线 -> 启动 oc 桌面版
  3. 等 oc server 就绪 -> 读密码文件（由 furina-bootstrap plugin 泄露）
  4. 验证 server 连通性
  5. 检测 furina 是否在跑 -> 没跑则启动
  6. 循环

部署：
  - Windows 任务计划程序，开机自启
  - 或手动 python watchdog.py

注意：
  看门狗独立于 oc 运行，oc 关了看门狗还活着。
  密码通过 furina-bootstrap plugin 泄露到文件，看门狗读文件。
"""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

# ============================================================
# 配置
# ============================================================

FURINA_ROOT = Path.home() / "Desktop" / "大宗" / "furina"
PASSWORD_FILE = FURINA_ROOT / "logs" / "oc-password.txt"
HEARTBEAT_FILE = FURINA_ROOT / "logs" / "heartbeat.json"
WATCHDOG_LOG = FURINA_ROOT / "logs" / "watchdog.log"

OC_EXE_PATHS = [
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "@opencode-aidesktop" / "OpenCode.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "@opencode-ai" / "desktop" / "OpenCode.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "OpenCode" / "OpenCode.exe",
]

CHECK_INTERVAL = 10  # 秒
OC_STARTUP_WAIT = 30  # oc 启动后等多久检查 server
PASSWORD_FILE_TIMEOUT = 60  # 等密码文件出现的超时
FURINA_STARTUP_WAIT = 10  # furina 启动后等多久检查 heartbeat


# ============================================================
# 日志
# ============================================================

def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        WATCHDOG_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(WATCHDOG_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ============================================================
# oc 进程检测
# ============================================================

def is_oc_running():
    """检测 oc 桌面版进程是否在线 AND 有监听端口（防 WER 残留误判）"""
    try:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq OpenCode.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5, creationflags=0x08000000
        )
        if "OpenCode.exe" not in result.stdout:
            return False
        # 进程在，但还要检测有没有监听端口
        # 0xc0000005 崩溃的进程会残留 in tasklist 但没有监听端口
        port = find_oc_port()
        if port:
            return True
        return False
    except Exception as e:
        log(f"tasklist 失败: {e}")
        return False


def alert_start_oc():
    """弹消息框提醒用户手动启动 oc"""
    def show():
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            0,
            "oc 自动启动失败。\n请手动启动 opencode 桌面版。\n\n看门狗会在 oc 在线后自动继续。",
            "furina 看门狗",
            0x40 | 0x10  # MB_ICONINFORMATION | MB_TOPMOST
        )
    threading.Thread(target=show, daemon=True).start()


def start_oc():
    """启动 oc 桌面版"""
    for path in OC_EXE_PATHS:
        if path.exists():
            log(f"启动 oc: {path} ({path.stat().st_size // 1024 // 1024}MB)")
            try:
                subprocess.Popen(
                    [str(path)],
                    cwd=str(path.parent),
                )
                log("oc 启动命令已发送")
                return True
            except Exception as e:
                log(f"oc 启动失败: {e}")
                return False
    log("未找到 oc 可执行文件")
    return False


def find_oc_port():
    """用 netstat 找 oc 的监听端口"""
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True, text=True, timeout=8, creationflags=0x08000000
        )
        ns = result.stdout

        # 找 oc 的 PID
        tl = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq OpenCode.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5, creationflags=0x08000000
        ).stdout

        import re
        oc_pids = set()
        for m in re.finditer(r'"OpenCode\.exe","(\d+)"', tl):
            oc_pids.add(int(m.group(1)))

        for line in ns.split("\n"):
            m = re.match(r"\s*TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)", line)
            if m:
                port = int(m.group(1))
                pid = int(m.group(2))
                if pid in oc_pids:
                    return port
    except Exception as e:
        log(f"netstat 失败: {e}")
    return None


def read_password_file():
    """读 furina-bootstrap plugin 泄露的密码"""
    if not PASSWORD_FILE.exists():
        return None
    try:
        data = json.loads(PASSWORD_FILE.read_text(encoding="utf-8"))
        # 检查密码文件新鲜度（10 分钟内）
        age = time.time() * 1000 - data.get("leakedAt", 0)
        if age > 600000:
            log(f"密码文件过期 ({age/1000:.0f}s 前)")
            return None
        return data
    except Exception as e:
        log(f"读密码文件失败: {e}")
        return None


def verify_server(port, password, username="opencode"):
    """验证 oc server 是否可用"""
    try:
        import base64
        auth = base64.b64encode(f"{username}:{password}".encode()).decode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/global/health",
            headers={"Authorization": f"Basic {auth}"}
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


# ============================================================
# furina 进程检测
# ============================================================

def is_furina_running():
    """检测 furina 是否在跑（读 heartbeat，10 秒内有效）"""
    if not HEARTBEAT_FILE.exists():
        return False
    try:
        hb = json.loads(HEARTBEAT_FILE.read_text(encoding="utf-8"))
        age = (time.time() * 1000) - hb.get("ts", 0)
        return age < 10000
    except Exception:
        return False


def start_furina(password, username="opencode", port=None):
    """启动 furina，注入密码环境变量"""
    entry = FURINA_ROOT / "src" / "main.mjs"
    if not entry.exists():
        log(f"furina 入口不存在: {entry}")
        return False

    log("启动 furina...")
    env = os.environ.copy()
    env["OPENCODE_SERVER_PASSWORD"] = password
    env["OPENCODE_SERVER_USERNAME"] = username
    if port:
        env["OPENCODE_SERVER_PORT"] = str(port)

    watch_path = str(Path.home() / "Desktop")
    try:
        subprocess.Popen(
            ["node", str(entry), "--watch", watch_path],
            cwd=str(FURINA_ROOT),
            env=env,
            creationflags=0x00000200,  # CREATE_NEW_PROCESS_GROUP
            close_fds=True
        )
        log("furina 启动命令已发送")
        return True
    except Exception as e:
        log(f"furina 启动失败: {e}")
        return False


# ============================================================
# 主循环
# ============================================================

def main():
    log("=" * 50)
    log("furina 看门狗启动（独立 Python 进程）")
    log(f"  检查间隔: {CHECK_INTERVAL}s")
    log(f"  furina 根: {FURINA_ROOT}")
    log("=" * 50)

    while True:
        try:
            # 1. 检测 oc 进程
            if not is_oc_running():
                log("oc 不在线，启动...")
                start_oc()
                # 轮询等待 oc 在线（最多 30s）
                oc_started = False
                for i in range(6):
                    time.sleep(5)
                    if is_oc_running():
                        log(f"oc 已在线（{i*5+5}s 后检测到）")
                        oc_started = True
                        break
                if not oc_started:
                    # 30s 后 oc 仍不在线，弹消息框提醒用户
                    log("oc 30s 后仍不在线，弹消息框提醒用户手动启动")
                    alert_start_oc()
                    # 继续轮询等待用户手动启动（每 10s 检测一次）
                continue

            # 2. oc 在线，检测 furina 心跳
            if is_furina_running():
                # 一切正常，静默等待
                time.sleep(CHECK_INTERVAL)
                continue

            # 3. furina 没跑，先等插件启动它（插件在 oc 加载时会启动 furina）
            log("furina 未检测到心跳，等插件启动（10s）...")
            time.sleep(10)
            if is_furina_running():
                log("furina 已被插件启动")
                time.sleep(CHECK_INTERVAL)
                continue

            # 4. 插件没启动 furina，兜底：读密码文件启动
            log("插件未启动 furina，兜底启动...")
            pwd_data = read_password_file()
            if not pwd_data:
                log("密码文件不可用，等 10s")
                time.sleep(CHECK_INTERVAL)
                continue

            password = pwd_data["password"]
            username = pwd_data.get("username", "opencode")
            port = find_oc_port()
            start_furina(password, username, port)
            time.sleep(FURINA_STARTUP_WAIT)

        except KeyboardInterrupt:
            log("收到 Ctrl+C，退出")
            break
        except Exception as e:
            log(f"主循环异常: {e}")
            time.sleep(CHECK_INTERVAL)

    log("看门狗退出")


if __name__ == "__main__":
    main()
