"""
desktop-lyrics.py

桌面歌词组件 -- 类似网易云桌面歌词
- 悬浮置顶窗口，半透明背景
- 显示当前播放的文字（字幕）
- QMediaPlayer 播放音频
- 轮询 korina /tts/queue 获取待播放项
- 播放时高亮当前句

用法：
  python desktop-lyrics.py [--korina-url http://127.0.0.1:9999] [--password xxx]

通信协议：
  GET /tts/queue -> { items: [{id, text, audioBase64, duration}], current: {...} }
  POST /tts/ack -> { id } （通知 korina 已播放完）
"""

import sys
import os
import json
import base64
import tempfile
import threading
import time
import ctypes
import urllib.request
import urllib.error
from pathlib import Path

from PySide6.QtCore import Qt, QTimer, QUrl, QRect, QObject, Signal
from PySide6.QtGui import QFont, QColor, QPainter, QPen, QBrush, QAction, QFontDatabase
from PySide6.QtWidgets import (
    QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout,
    QSystemTrayIcon, QMenu, QMainWindow
)
from PySide6.QtMultimedia import QMediaPlayer, QAudioOutput


# ============================================================
# 配置
# ============================================================

KORINA_URL = os.environ.get("KORINA_URL", "http://127.0.0.1:9999")
# 密码从 oc-password.txt 读
PASSWORD_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "logs", "oc-password.txt"
)


# ============================================================
# v0.9.3: korina 健康检测 + 心跳
# ============================================================

def wait_for_korina(max_wait=60):
    """v0.9.3: 启动探测 — 轮询 korina /status 直到就绪"""
    print(f"[lyrics] 等待 korina 就绪 ({KORINA_URL}/status)...", flush=True)
    start = time.time()
    attempt = 0
    while time.time() - start < max_wait:
        attempt += 1
        try:
            req = urllib.request.Request(f"{KORINA_URL}/status")
            with urllib.request.urlopen(req, timeout=3) as resp:
                if resp.status == 200:
                    print(f"[lyrics] korina 就绪 (尝试 {attempt} 次, {time.time()-start:.1f}s)", flush=True)
                    return True
        except Exception as e:
            if attempt == 1 or attempt % 10 == 0:
                print(f"[lyrics]   等待中 ({attempt}): {type(e).__name__}", flush=True)
        time.sleep(1)
    print(f"[lyrics] korina 等待超时 ({max_wait}s)", flush=True)
    return False


def ping_korina():
    """v0.9.3: 心跳 ping"""
    try:
        body = json.dumps({"name": "desktop-lyrics"}).encode("utf-8")
        req = urllib.request.Request(
            f"{KORINA_URL}/sidecars/ping",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass


# 歌词窗口配置
LYRICS_CONFIG_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "config", "lyrics.json"
)
# 拖动后保存的位置（记住上次位置）
LYRICS_POSITION_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "config", "lyrics-position.json"
)


def load_lyrics_config():
    """读 config/lyrics.json，失败返回默认配置"""
    default = {
        "font": {
            "family": "Microsoft YaHei",
            "file": None,  # 自定义字体文件路径（ttf/otf），相对项目根目录。设了就覆盖 family
            "currentSize": 20,
            "currentBold": True,
            "nextSize": 11,
            "nextBold": False,
        },
        "color": {
            "current": "#00E5FF",
            "next": "rgba(255, 255, 255, 150)",
            "background": "rgba(0, 0, 0, 140)",
        },
        "window": {
            "width": 800,
            "height": 120,
            "marginX": 20,
            "marginY": 10,
            "radius": 15,
            "position": "bottom-center",
        },
        "audio": {"volume": 0.8},
        "poll": {"intervalMs": 500},
        "text": {"waiting": "少女祈祷中...", "idle": "（空闲）"},
    }
    try:
        with open(LYRICS_CONFIG_FILE, "r", encoding="utf-8") as f:
            user = json.load(f)
        # 合并（用户配置覆盖默认）
        for k in default:
            if k in user:
                if isinstance(default[k], dict):
                    default[k].update(user[k])
                else:
                    default[k] = user[k]
    except Exception as e:
        print(f"[lyrics] 读配置失败，用默认: {e}")
    return default


def get_auth():
    """读 oc-password.txt 拿密码做 Basic auth"""
    try:
        with open(PASSWORD_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            cred = f"opencode:{data['password']}"
            b64 = base64.b64encode(cred.encode()).decode()
            return f"Basic {b64}"
    except Exception as e:
        print(f"[lyrics] 读密码失败: {e}")
        return ""


# ============================================================
# 桌面歌词窗口
# ============================================================

class LyricsWindow(QWidget):
    """悬浮置顶半透明歌词窗口"""

    def __init__(self, config):
        super().__init__()
        self.config = config
        self.current_text = ""
        self.next_text = ""
        self.dragging = False
        self.drag_offset = None

        self.init_ui()

    def init_ui(self):
        cfg = self.config
        font_cfg = cfg["font"]
        color_cfg = cfg["color"]
        win_cfg = cfg["window"]

        # 窗口属性：置顶 + 无边框 + 半透明 + 工具窗口（不显示在任务栏）
        self.setWindowFlags(
            Qt.WindowType.WindowStaysOnTopHint |
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)

        # 初始大小和位置
        screen = QApplication.primaryScreen().geometry()
        w = win_cfg["width"]
        h = win_cfg["height"]
        self.resize(w, h)

        # v0.8.6: 优先读上次拖动保存的位置（但要校验是否在当前屏幕范围内）
        screen = QApplication.primaryScreen().geometry()
        # v0.8.6: 检测任务栏区域（避免被任务栏遮挡）
        available = QApplication.primaryScreen().availableGeometry()
        taskbar_h = screen.height() - available.height()
        saved_pos = self._load_saved_position()
        if saved_pos and self._is_position_visible(saved_pos, screen):
            self.move(saved_pos["x"], saved_pos["y"])
            if saved_pos.get("w") and saved_pos.get("h"):
                self.resize(saved_pos["w"], saved_pos["h"])
            print(f"[lyrics] 恢复上次位置: ({saved_pos['x']}, {saved_pos['y']})")
        else:
            if saved_pos:
                print(f"[lyrics] 保存的位置 ({saved_pos['x']}, {saved_pos['y']}) 超出当前屏幕 {screen.width()}x{screen.height()}，重置到默认")
            # 用当前屏幕尺寸 + 任务栏高度计算默认位置（避免被任务栏挡）
            pos = win_cfg.get("position", "bottom-center")
            margin = win_cfg.get("positionMargin", 30)
            usable_h = available.height()
            if pos == "bottom-center":
                self.move((screen.width() - w) // 2, usable_h - 180)
            elif pos == "top-center":
                self.move((screen.width() - w) // 2, margin)
            elif pos == "center":
                self.move((screen.width() - w) // 2, (usable_h - h) // 2)
            elif pos == "bottom-right":
                self.move(screen.width() - w - margin, usable_h - h - margin)
            elif pos == "bottom-left":
                self.move(margin, usable_h - h - margin)
            elif pos == "top-right":
                self.move(screen.width() - w - margin, margin)
            elif pos == "top-left":
                self.move(margin, margin)
            else:
                self.move((screen.width() - w) // 2, usable_h - 180)

        # 布局
        layout = QVBoxLayout(self)
        layout.setContentsMargins(win_cfg["marginX"], win_cfg["marginY"], win_cfg["marginX"], win_cfg["marginY"])
        layout.setSpacing(4)

        # 当前歌词（大字）
        self.current_label = QLabel(cfg["text"]["waiting"])
        self.current_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.current_label.setWordWrap(True)  # v0.9.3: 长文本自动换行
        font_current = QFont(
            font_cfg["family"],
            font_cfg["currentSize"],
            QFont.Weight.Bold if font_cfg["currentBold"] else QFont.Weight.Normal,
        )
        self.current_label.setFont(font_current)
        # v0.8.6: 文字阴影（替代矩形背景，在透明窗口上清晰可读）
        text_shadow = color_cfg.get("textShadow", "0 0 4px rgba(0, 0, 0, 200)")
        self.current_label.setStyleSheet(f"""
            QLabel {{
                color: {color_cfg["current"]};
                background: transparent;
                text-shadow: {text_shadow};
            }}
        """)
        layout.addWidget(self.current_label)

        # 下一句歌词（小字，预览）
        self.next_label = QLabel("")
        self.next_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        font_next = QFont(
            font_cfg["family"],
            font_cfg["nextSize"],
            QFont.Weight.Bold if font_cfg["nextBold"] else QFont.Weight.Normal,
        )
        self.next_label.setFont(font_next)
        self.next_label.setStyleSheet(f"""
            QLabel {{
                color: {color_cfg["next"]};
                background: transparent;
                text-shadow: {text_shadow};
            }}
        """)
        layout.addWidget(self.next_label)

        # 点击穿透（Windows：WS_EX_TRANSPARENT | WS_EX_LAYERED）
        if win_cfg.get("clickThrough", False):
            self._set_click_through()

    def _set_click_through(self):
        """Windows 点击穿透：鼠标事件透传到下层窗口"""
        try:
            hwnd = int(self.winId())
            GWL_EXSTYLE = -20
            WS_EX_LAYERED = 0x00080000
            WS_EX_TRANSPARENT = 0x00000020
            user32 = ctypes.windll.user32
            ex_style = user32.GetWindowLongA(hwnd, GWL_EXSTYLE)
            user32.SetWindowLongA(
                hwnd, GWL_EXSTYLE,
                ex_style | WS_EX_LAYERED | WS_EX_TRANSPARENT
            )
            print("[lyrics] 点击穿透已启用")
        except Exception as e:
            print(f"[lyrics] 点击穿透设置失败: {e}")

    def set_current(self, text):
        """设置当前歌词（长文本自动换行显示）"""
        text = text or ""
        self.current_text = text
        self.current_label.setText(text)

    def set_next(self, text):
        """设置下一句预览"""
        text = text or ""
        max_chars = self.config.get("text", {}).get("maxChars", 60)
        if len(text) > max_chars:
            text = text[:max_chars] + "..."
        self.next_text = text
        self.next_label.setText(text)

    def clear(self):
        self.current_label.setText(self.config["text"]["idle"])
        self.next_label.setText("")

    # 拖动窗口
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.dragging = True
            self.drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event):
        if self.dragging and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self.drag_offset)
            event.accept()

    def mouseReleaseEvent(self, event):
        if self.dragging:
            self.dragging = False
            # 保存当前位置（记住上次位置）
            self._save_position()

    def _save_position(self):
        """把当前位置保存到 lyrics-position.json"""
        try:
            pos = self.pos()
            size = self.size()
            data = {"x": pos.x(), "y": pos.y(), "w": size.width(), "h": size.height()}
            with open(LYRICS_POSITION_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            print(f"[lyrics] 保存位置失败: {e}")

    @staticmethod
    def _load_saved_position():
        """读 lyrics-position.json，返回 {x,y,w,h} 或 None"""
        try:
            if not os.path.exists(LYRICS_POSITION_FILE):
                return None
            with open(LYRICS_POSITION_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if "x" in data and "y" in data:
                return data
        except Exception:
            pass
        return None

    @staticmethod
    def _is_position_visible(pos, screen):
        """v0.8.6: 校验保存的位置是否在当前屏幕 + 任务栏上方范围内（至少 50% 可见）"""
        from PySide6.QtWidgets import QApplication
        available = QApplication.primaryScreen().availableGeometry()
        x, y = pos["x"], pos["y"]
        w = pos.get("w", 800)
        h = pos.get("h", 120)
        # 用 available geometry（排除任务栏）做校验
        avail_x = available.x()
        avail_y = available.y()
        avail_w = available.width()
        avail_h = available.height()
        visible_x = max(0, min(x + w, avail_x + avail_w) - max(x, avail_x))
        visible_y = max(0, min(y + h, avail_y + avail_h) - max(y, avail_y))
        return visible_x > w * 0.5 and visible_y > h * 0.5

    def paintEvent(self, event):
        """绘制半透明背景（alpha=0 时不画背景，纯净模式）"""
        cfg = self.config
        bg_str = cfg["color"]["background"]
        radius = cfg["window"]["radius"]
        # v0.8.6: 解析 alpha -- 0 表示完全透明（不画背景）
        bg_color = self._parse_color(bg_str)
        if bg_color.alpha() == 0:
            return  # 纯净模式：无背景
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect = self.rect()
        painter.setBrush(QBrush(bg_color))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawRoundedRect(rect, radius, radius)
        painter.end()

    def _parse_color(self, color_str):
        """解析颜色字符串（#RRGGBB 或 rgba(r,g,b,a)）"""
        if color_str.startswith("#"):
            return QColor(color_str)
        if color_str.startswith("rgba"):
            # rgba(0, 0, 0, 140) -> QColor(0, 0, 0, 140)
            nums = color_str.replace("rgba(", "").replace(")", "").split(",")
            r, g, b = int(nums[0]), int(nums[1]), int(nums[2])
            a = int(nums[3]) if len(nums) > 3 else 255
            return QColor(r, g, b, a)
        return QColor(0, 0, 0, 140)


# ============================================================
# 播放控制器
# ============================================================

class PlayerController(QObject):
    """管理音频播放 + 轮询 korina 队列"""

    text_changed = Signal(str)  # 当前歌词变化
    next_changed = Signal(str)  # 下一句变化
    status_changed = Signal(str)  # 状态变化

    def __init__(self, lyrics_window, config):
        super().__init__()
        self.window = lyrics_window
        self.config = config
        self.player = QMediaPlayer()
        self.audio_output = QAudioOutput()
        self.player.setAudioOutput(self.audio_output)
        self.audio_output.setVolume(config["audio"]["volume"])

        self.player.playbackStateChanged.connect(self.on_state_changed)
        self.player.mediaStatusChanged.connect(self.on_media_status_changed)
        self.player.positionChanged.connect(self.on_position_changed)

        self.queue = []  # 待播放列表 [{id, text, audioPath, duration}]
        self.current = None
        self.temp_dir = tempfile.mkdtemp(prefix="korina_tts_")

        # 轮询定时器
        self.poll_timer = QTimer()
        self.poll_timer.timeout.connect(self.poll)
        self.poll_timer.start(config["poll"]["intervalMs"])

        self.text_changed.connect(self.window.set_current)
        self.next_changed.connect(self.window.set_next)

    def on_state_changed(self, state):
        # v0.8.6: 用 mediaStatusChanged(EndOfMedia) 触发播放完成，避免 stateChanged 误触发
        pass  # 改在 on_media_status_changed 处理

    def on_media_status_changed(self, status):
        """v0.8.6: 用 EndOfMedia 精确判定音频播放完成"""
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            if self.current:
                # 通知 korina 已播放完
                self.ack(self.current["id"])
                self.current = None
            # 播放下一首
            QTimer.singleShot(300, self.play_next)

    def on_position_changed(self, pos):
        pass  # 可以在这里做高亮进度，暂时不需要
    def add_item(self, item):
        """添加播放项"""
        # 解码音频 base64 -> 临时文件
        try:
            audio_bytes = base64.b64decode(item.get("audioBase64", ""))
            if not audio_bytes:
                return
            ext = item.get("format", "mp3")
            filepath = os.path.join(self.temp_dir, f"{item['id']}.{ext}")
            with open(filepath, "wb") as f:
                f.write(audio_bytes)
            item["audioPath"] = filepath
            self.queue.append(item)
        except Exception as e:
            print(f"[lyrics] add_item 失败: {e}")

    def play_next(self):
        """播放队列下一首"""
        if not self.queue:
            self.current = None
            self.text_changed.emit(self.config["text"]["idle"])
            self.next_changed.emit("")
            return

        self.current = self.queue.pop(0)
        self.text_changed.emit(self.current.get("text", ""))

        # 下一句预览
        if self.queue:
            self.next_changed.emit(self.queue[0].get("text", ""))
        else:
            self.next_changed.emit("")

        # 播放
        self.player.setSource(QUrl.fromLocalFile(self.current["audioPath"]))
        self.player.play()
        self.status_changed.emit(f"播放: {self.current.get('text', '')[:30]}")

    def poll(self):
        """轮询 korina /tts/queue 获取待播放项"""
        auth = get_auth()
        if not auth:
            return
        # v0.9.3: 失败退避——连续失败计数，恢复后重置
        if not hasattr(self, "_poll_fail_count"):
            self._poll_fail_count = 0
        try:
            req = urllib.request.Request(
                f"{KORINA_URL}/tts/queue",
                headers={"Authorization": auth}
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                new_count = 0
                for item in data.get("items", []):
                    self.add_item(item)
                    new_count += 1
                # v0.8.6: 只在 idle 状态启动播放（避免 playing 时重复触发）
                state = self.player.playbackState()
                if state == QMediaPlayer.PlaybackState.StoppedState and self.queue:
                    self.play_next()
                # v0.9.3: 成功后重置失败计数
                if self._poll_fail_count > 0:
                    log.info(f"korina 恢复 (失败 {self._poll_fail_count} 次后)")
                    self._poll_fail_count = 0
        except urllib.error.HTTPError as e:
            self._poll_fail_count += 1
            if self._poll_fail_count == 1 or self._poll_fail_count % 10 == 0:
                log.warning(f"/tts/queue HTTP {e.code} ({self._poll_fail_count} 次连续失败)")
        except Exception as e:
            self._poll_fail_count += 1
            if self._poll_fail_count == 1 or self._poll_fail_count % 10 == 0:
                log.warning(f"/tts/queue 失败: {type(e).__name__} ({self._poll_fail_count} 次连续)")

    def ack(self, item_id):
        """通知 korina 已播放完"""
        auth = get_auth()
        if not auth:
            return
        try:
            body = json.dumps({"id": item_id}).encode("utf-8")
            req = urllib.request.Request(
                f"{KORINA_URL}/tts/ack",
                data=body,
                headers={"Authorization": auth, "Content-Type": "application/json"},
                method="POST"
            )
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass


# ============================================================
# 系统托盘
# ============================================================

class TrayIcon(QSystemTrayIcon):
    def __init__(self, window, app):
        super().__init__()
        self.window = window
        self.app = app
        self.setIcon(self.app.style().standardIcon(
            self.app.style().StandardPixmap.SP_MediaVolume
        ))
        self.setToolTip("korina 桌面歌词")
        self.setVisible(True)

        menu = QMenu()
        action_show = QAction("显示/隐藏歌词", menu)
        action_show.triggered.connect(self.toggle_window)
        menu.addAction(action_show)

        action_quit = QAction("退出", menu)
        action_quit.triggered.connect(app.quit)
        menu.addAction(action_quit)

        self.setContextMenu(menu)
        self.activated.connect(self.on_activated)

    def toggle_window(self):
        if self.window.isVisible():
            self.window.hide()
        else:
            self.window.show()

    def on_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.toggle_window()


# ============================================================
# 主入口
# ============================================================

def load_custom_font(font_cfg):
    """加载自定义字体文件（ttf/otf），返回字体 family 名（成功）或 None（失败）"""
    font_file = font_cfg.get("file")
    if not font_file:
        return None
    # 相对路径基于项目根目录
    if not os.path.isabs(font_file):
        font_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), font_file)
    if not os.path.exists(font_file):
        print(f"[lyrics] 字体文件不存在: {font_file}")
        return None
    font_id = QFontDatabase.addApplicationFont(font_file)
    if font_id < 0:
        print(f"[lyrics] 字体加载失败: {font_file}")
        return None
    families = QFontDatabase.applicationFontFamilies(font_id)
    if families:
        family = families[0]
        print(f"[lyrics] 自定义字体已加载: {family} (from {font_file})")
        return family
    return None


def main():
    # v0.8.6: 用 logging 替代 print（强制 flush，Qt event loop 不会吞）
    import logging
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s][%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
        force=True,
    )
    log = logging.getLogger("lyrics")

    config = load_lyrics_config()
    app = QApplication(sys.argv)
    app.setApplicationName("korina 桌面歌词")

    # 加载自定义字体文件（如果有）
    custom_family = load_custom_font(config["font"])
    if custom_family:
        config["font"]["family"] = custom_family

    window = LyricsWindow(config)
    window.show()

    # v0.8.6: 打印窗口实际位置/屏幕尺寸（调试用）
    screen = QApplication.primaryScreen().geometry()
    log.info(f"屏幕尺寸: {screen.width()}x{screen.height()}")
    log.info(f"窗口位置: ({window.x()}, {window.y()}) 大小: {window.width()}x{window.height()}")
    log.info(f"窗口可见: {window.isVisible()}")

    controller = PlayerController(window, config)

    # v0.9.3: 启动探测 korina（防止 sidecar 比 korina 早起来）
    if not wait_for_korina(max_wait=60):
        log.error("korina 未就绪，退出")
        sys.exit(1)

    # v0.9.3: 启动后台 ping（每 10 秒）
    ping_timer = QTimer()
    ping_timer.timeout.connect(ping_korina)
    ping_timer.start(10000)
    controller.ping_timer = ping_timer  # 防止 GC

    tray = TrayIcon(window, app)

    log.info(f"桌面歌词已启动")
    log.info(f"korina URL: {KORINA_URL}")
    log.info(f"配置: {LYRICS_CONFIG_FILE}")
    log.info(f"字体: {config['font']['family']} {config['font']['currentSize']}pt")

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
