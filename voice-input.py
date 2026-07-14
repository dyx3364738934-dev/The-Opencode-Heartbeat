#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
voice-input.py -- korina 语音输入 sidecar

v0.8.7: 本地 whisper.cpp STT + PTT 热键触发

工作流：
  1. 按 --hotkey 指定的键开始录音（PTT 模式，默认 alt）
  2. 松开热键 -> 停止录音 -> whisper 转写
  3. POST 转写文本到 korina /stt/text -> 推入 oc 对话队列
  4. oc 回复 -> SSE -> TTS -> 桌面歌词播放

回声抑制：
  录音前先查 /stt/status，如果 ttsActive=true（TTS 正在播放）-> 等 TTS 播完再录
  但 PTT 模式下用户主动按键，一般不会在 TTS 播放时按，这里加一层保险

模型选择：
  --model tiny   -> ~75MB, CPU 实时, 中文质量一般
  --model base   -> ~150MB, CPU 1-3s, 中文质量可接受（推荐）
  --model small  -> ~500MB, CPU 3-8s, 中文质量好

依赖：
  pip install faster-whisper sounddevice keyboard requests numpy

用法：
  python voice-input.py                    # 默认 base 模型
  python voice-input.py --model small      # 高质量
  python voice-input.py --model tiny       -- 快速
  python voice-input.py --hotkey alt       # 改热键（默认 alt）
"""

import sys
import os
import time
import json
import wave
import tempfile
import threading
import argparse
import logging

# 日志（走 stderr，korina sidecar-launcher 只捕获 stderr）
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [voice] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stderr,
)
log = logging.getLogger("voice-input")
# 强制 flush
for handler in log.handlers:
    handler.setLevel(logging.INFO)
    handler.flush()

import numpy as np
import sounddevice as sd
import requests

# korina HTTP 端点
KORINA_HOST = "http://127.0.0.1:9999"
# 密码文件
PASSWORD_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "oc-password.txt")
# v0.9.3: 录音暂存目录（POST 失败时暂存，等 korina 恢复后重发）
PENDING_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "stt-pending")
# v0.9.3: 语音目标 session 文件（korina 写，voice-input 读）
TARGET_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "voice-input-target.json")

def wait_for_korina(max_wait=60):
    """v0.9.3: 启动探测 — 轮询 korina /status 直到就绪
    返回 True 表示就绪，False 表示超时
    """
    pwd = load_password()
    auth = ("opencode", pwd) if pwd else None
    log.info(f"等待 korina 就绪 ({KORINA_HOST}/status)...")
    start = time.time()
    attempt = 0
    while time.time() - start < max_wait:
        attempt += 1
        try:
            r = requests.get(f"{KORINA_HOST}/status", auth=auth, timeout=3)
            if r.status_code == 200:
                log.info(f"korina 就绪 (尝试 {attempt} 次, {time.time()-start:.1f}s)")
                return True
        except Exception as e:
            if attempt == 1 or attempt % 10 == 0:
                log.info(f"  等待中 ({attempt}): {type(e).__name__}")
        time.sleep(1)
    log.error(f"korina 等待超时 ({max_wait}s)")
    return False

def save_pending(text, audio_path=None):
    """v0.9.3: 把转写结果暂存到本地，等 korina 恢复后重发"""
    os.makedirs(PENDING_DIR, exist_ok=True)
    fname = f"stt-{int(time.time()*1000)}.json"
    fpath = os.path.join(PENDING_DIR, fname)
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump({"text": text, "audio": audio_path, "ts": time.time()}, f, ensure_ascii=False)
    log.warning(f"录音暂存: {fpath}")

def ping_korina():
    """v0.9.3: 心跳 ping，让 korina 知道 voice-input 还活着"""
    try:
        requests.post(f"{KORINA_HOST}/sidecars/ping", json={"name": "voice-input"}, timeout=3)
    except Exception:
        pass

def load_target_session():
    """v0.9.3: 读语音目标 session 文件（korina POST /voice-input/bind 写）
    返回 {sessionId, title, setAt} 或 None（未绑定则跟随 korina 默认 session）
    """
    try:
        if not os.path.exists(TARGET_FILE):
            return None
        with open(TARGET_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        sid = data.get("sessionId")
        if not sid:
            return None
        return data
    except Exception as e:
        log.warning(f"读 target 文件失败: {e}")
        return None

_target_state = {"sessionId": None, "title": None, "setAt": 0}

def target_poll_loop():
    """v0.9.3: 后台线程 — 每 5 秒检查 target 文件变更并日志提示"""
    global _target_state
    log.info(f"启动 target 轮询线程（监听 {TARGET_FILE}）")
    while True:
        try:
            t = load_target_session()
            new_sid = t["sessionId"] if t else None
            new_title = t["title"] if t else None
            if new_sid != _target_state["sessionId"]:
                old_sid = _target_state["sessionId"]
                _target_state = {"sessionId": new_sid, "title": new_title, "setAt": t["setAt"] if t else 0}
                if new_sid:
                    log.info(f"✓ 语音端口已绑定 -> {new_title} ({new_sid[:14]})")
                else:
                    log.info(f"语音端口已解绑，恢复跟随 korina 默认 session" + (f" (之前: {old_sid[:14]})" if old_sid else ""))
        except Exception as e:
            log.warning(f"target 轮询异常: {e}")
        time.sleep(5)

def load_password():
    """读 oc-password.txt 拿密码做 Basic auth"""
    try:
        with open(PASSWORD_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("password", "")
    except Exception as e:
        log.warning(f"读密码文件失败: {e}")
        return ""

def korina_post(path, payload, timeout=10):
    """POST 到 korina HTTP 端点（带认证）"""
    pwd = load_password()
    if not pwd:
        return {"error": "无密码"}
    auth = ("opencode", pwd)
    url = f"{KORINA_HOST}{path}"
    try:
        r = requests.post(url, json=payload, auth=auth, timeout=timeout)
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def korina_get(path, timeout=5):
    """GET korina 端点"""
    pwd = load_password()
    if not pwd:
        return {"error": "无密码"}
    auth = ("opencode", pwd)
    url = f"{KORINA_HOST}{path}"
    try:
        r = requests.get(url, auth=auth, timeout=timeout)
        return r.json()
    except Exception as e:
        return {"error": str(e)}

# ============================================================
# 录音器
# ============================================================

class Recorder:
    """录音器：按 F8 开始/停止"""

    def __init__(self, sample_rate=16000, channels=1, device_id=None):
        self.sample_rate = sample_rate
        self.channels = channels
        self.device_id = device_id  # v0.9.3: 可指定输入设备
        self.audio_chunks = []
        self.recording = False
        self._stream = None
        self._lock = threading.Lock()

    def start(self):
        """开始录音"""
        with self._lock:
            if self.recording:
                return
            self.audio_chunks = []
            self.recording = True
            try:
                # v0.9.3: 检查音频是否真的有信号
                self._stream = sd.InputStream(
                    samplerate=self.sample_rate,
                    channels=self.channels,
                    dtype="float32",
                    callback=self._callback,
                    device=self.device_id,  # 指定输入设备
                )
                self._stream.start()
                log.info(f"录音开始 (sr={self.sample_rate})")
            except Exception as e:
                log.error(f"录音启动失败: {e}")
                self.recording = False

    def _callback(self, indata, frames, time_info, status):
        """录音回调"""
        if self.recording:
            self.audio_chunks.append(indata.copy())

    def stop(self):
        """停止录音，返回 numpy array"""
        with self._lock:
            if not self.recording:
                return None
            self.recording = False
            if self._stream:
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    pass
                self._stream = None
            if not self.audio_chunks:
                return None
            audio = np.concatenate(self.audio_chunks, axis=0)
            log.info(f"录音结束 ({len(audio)/self.sample_rate:.1f}s, {len(audio)} samples)")
            return audio

# ============================================================
# Whisper STT
# ============================================================

class WhisperSTT:
    """faster-whisper 封装"""

    def __init__(self, model_size="base", device="cpu", compute_type="int8"):
        self.model = None
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self._loaded = False
        # v0.9.2: HuggingFace 走 Clash 代理（GFW 阻断 huggingface.co）
        # 不用 hf-mirror（重定向后仍连 huggingface.co 超时），直接走 Clash 代理
        os.environ["HF_ENDPOINT"] = "https://huggingface.co"
        os.environ["HTTPS_PROXY"] = "http://127.0.0.1:7890"
        os.environ["HTTP_PROXY"] = "http://127.0.0.1:7890"

    def load(self):
        """加载模型（耗时几秒到几十秒）"""
        if self._loaded:
            return True
        log.info(f"加载 whisper 模型: {self.model_size} (device={self.device})...")
        try:
            from faster_whisper import WhisperModel
            self.model = WhisperModel(
                self.model_size,
                device=self.device,
                compute_type=self.compute_type,
            )
            self._loaded = True
            log.info(f"模型加载完成: {self.model_size}")
            return True
        except ImportError:
            log.error("faster-whisper 未安装。请运行: pip install faster-whisper")
            return False
        except Exception as e:
            log.error(f"模型加载失败: {e}")
            return False

    def transcribe(self, audio_np, language="zh"):
        """
        转写音频
        audio_np: numpy array, shape=(N, channels), dtype=float32
        返回: (text, elapsed_seconds)
        """
        if not self._loaded:
            if not self.load():
                return "", 0
        # faster-whisper 需要 1D array（mono）
        if audio_np.ndim > 1:
            audio_np = audio_np.flatten()
        start = time.time()
        try:
            segments, info = self.model.transcribe(
                audio_np,
                language=language,
                beam_size=5,
                vad_filter=False,  # v0.9.3: 关闭 VAD，过于激进导致漏判
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()
            elapsed = time.time() - start
            log.info(f"转写完成 ({elapsed:.1f}s): {text[:80]}")
            return text, elapsed
        except Exception as e:
            elapsed = time.time() - start
            log.error(f"转写失败: {e}")
            return "", elapsed

# ============================================================
# 热键监听
# ============================================================

def _find_real_mic():
    """v0.9.3: 自动找真实麦克风，跳过虚拟设备和立体声混音"""
    import sounddevice as sd
    devices = sd.query_devices()
    # 优先级：Realtek 麦克风 > 其他非虚拟麦克风 > 默认设备
    for i, d in enumerate(devices):
        if d["max_input_channels"] <= 0:
            continue
        name = d["name"].lower()
        # 跳过虚拟音频设备
        if any(x in name for x in ["虚拟", "virtual", "声音映射器", "sound mapper",
                                     "立体声混音", "stereo mix", "电脑扬声器"]):
            continue
        if "realtek" in name and "麦克风" in name:
            log.info(f"自动选择麦克风: [{i}] {d['name']}")
            return i
    # 回退：找任意非虚拟输入设备
    for i, d in enumerate(devices):
        if d["max_input_channels"] > 0:
            name = d["name"].lower()
            if not any(x in name for x in ["虚拟", "virtual", "声音映射器", "sound mapper"]):
                log.info(f"回退麦克风: [{i}] {d['name']}")
                return i
    return None  # 没有则用系统默认

class VoiceInputApp:
    """语音输入主应用"""

    def __init__(self, model_size="small", hotkey="alt", sample_rate=16000, device_id=None):
        self.hotkey = hotkey.lower()
        # v0.9.3: 自动检测真实麦克风，排除虚拟设备
        if device_id is None:
            device_id = _find_real_mic()
        self.recorder = Recorder(sample_rate=sample_rate, device_id=device_id)
        self.stt = WhisperSTT(model_size=model_size)
        self.is_processing = False  # 防止重复触发
        self.recording_active = False  # 当前是否在录音

    def run(self):
        """主循环"""
        import keyboard

        # v0.9.3: 启动探测 korina（防止 sidecar 比 korina 早起来）
        if not wait_for_korina(max_wait=60):
            log.error("korina 未就绪，退出")
            sys.exit(1)

        # v0.9.3: 后台心跳线程，每 10 秒 ping korina
        def ping_loop():
            while True:
                ping_korina()
                time.sleep(10)
        threading.Thread(target=ping_loop, daemon=True).start()

        # v0.9.3: target session 轮询线程
        init_target = load_target_session()
        if init_target:
            # v0.9.5: BUG-007 修复 -- 启动时验证 target.json 指向的 session 是否仍活跃
            # 之前：如果 Koko bind_voice_input 后把那个 session 关了，target.json 还指着死 session
            # voice-input 启动后会绑到死 session，POST /stt/text 必然失败
            init_sid = init_target.get("sessionId")
            if init_sid:
                sessions_resp = korina_get("/sessions", timeout=3)
                active_sessions = sessions_resp.get("sessions") if isinstance(sessions_resp, dict) else None
                if isinstance(active_sessions, list):
                    active_ids = [s.get("id") for s in active_sessions if isinstance(s, dict) and s.get("id")]
                    if init_sid not in active_ids:
                        log.warning(f"启动时 target.json 指向 session {init_sid[:14]} 但该 session 已不活跃（可能已关/已删），忽略 target，回退到 korina 默认 session")
                        init_target = None
                    else:
                        log.info(f"启动时验证 target session {init_sid[:14]} 仍活跃 ✓")
                else:
                    log.warning(f"启动时拿不到 /sessions 列表（{sessions_resp}），跳过 target 验证，沿用 target.json 内容")
            if init_target:
                global _target_state
                _target_state = {"sessionId": init_target["sessionId"], "title": init_target.get("title"), "setAt": init_target.get("setAt", 0)}
                log.info(f"启动即绑定: 语音端口 -> {_target_state['title']} ({_target_state['sessionId'][:14]})")
        threading.Thread(target=target_poll_loop, daemon=True).start()

        # 预加载模型
        if not self.stt.load():
            log.error("模型加载失败，退出")
            sys.exit(1)

        HOLD_THRESHOLD = 2.0  # 按住不足 2 秒忽略

        log.info("=" * 50)
        log.info("korina 语音输入已就绪")
        log.info(f"  录音: 按住 {self.hotkey.upper()} 说话，松开发送")
        log.info(f"  取消: 短于 {HOLD_THRESHOLD:.0f} 秒自动丢弃 | 录音中按 Backspace")
        log.info(f"  模型: {self.stt.model_size}")
        log.info(f"  端点: {KORINA_HOST}/stt/text")
        log.info("=" * 50)
        log.info(f"等待热键 ({self.hotkey.upper()})...")

        self._cancel_requested = False
        self.running = True

        # Backspace 取消（事件钩子，普通键可捕获）
        keyboard.on_press_key("backspace", lambda e: (
            setattr(self, '_cancel_requested', True) or log.info("取消录音")
        ) if self.recording_active and not self.is_processing else None)

        # 热键轮询：按下立即录音，松手时判断时长
        threading.Thread(target=self._poll_hotkey, daemon=True).start()

        # 保持运行
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            log.info("退出")

    def _poll_hotkey(self):
        """热键轮询：按下立即录音，松手时判断时长

        v0.9.14 (L5.3 manual #38 修复): 之前 poll_alt 是 run() 内嵌函数，
        硬编码 keyboard.is_pressed("alt")，导致 self.hotkey / --hotkey 命令行参数
        完全是死代码。改成 self 方法后读 self.hotkey，单测也能直接调用。
        """
        import keyboard  # 内嵌导入，方便单测 mock
        HOLD_THRESHOLD = 2.0  # 按住不足 2 秒忽略
        hotkey_since = 0
        while self.running:
            time.sleep(0.05)
            if self.is_processing:
                hotkey_since = 0
                continue
            if keyboard.is_pressed(self.hotkey):
                if hotkey_since == 0:
                    hotkey_since = time.time()
                    self._cancel_requested = False
                    self.recording_active = True
                    threading.Thread(target=self._start_recording, daemon=True).start()
            else:
                if hotkey_since > 0 and self.recording_active:
                    self.recording_active = False
                    held = time.time() - hotkey_since
                    if held >= HOLD_THRESHOLD:
                        threading.Thread(target=self._stop_and_transcribe, daemon=True).start()
                    else:
                        self._cancel_requested = True
                        self.recorder.stop()
                        log.info(f"录音取消（仅{held:.1f}秒，不足{HOLD_THRESHOLD:.0f}秒）")
                hotkey_since = 0

    def _start_recording(self):
        """开始录音"""
        # 回声抑制：检查 TTS 是否在播放
        status = korina_get("/stt/status")
        if status.get("ttsActive"):
            log.warning("TTS 正在播放，录音可能有回声（PTT 模式建议 TTS 播完再按）")
            # 不阻止录音，只警告
        self.recorder.start()

    def _stop_and_transcribe(self):
        """停止录音 + 转写 + 注入 korina"""
        self.is_processing = True
        try:
            audio = self.recorder.stop()
            # v0.9.3: 取消检查
            if self._cancel_requested:
                log.info("录音已取消（用户按了 Backspace）")
                return
            if audio is None or len(audio) < self.recorder.sample_rate * 0.3:
                # 录音太短（<0.3s），忽略
                log.info("录音太短，忽略")
                return

            text, elapsed = self.stt.transcribe(audio)
            if not text:
                log.warning("转写结果为空")
                return

            # v0.9.3: 如果用户通过 /voice-input/bind 锁定了目标 session，POST 带 sessionId
            payload = {"text": text}
            target_sid = _target_state.get("sessionId")
            if target_sid:
                payload["sessionId"] = target_sid

            # POST 到 korina
            result = korina_post("/stt/text", payload)
            if result.get("ok"):
                target_info = f" -> {_target_state['title']}" if _target_state.get("title") else f" -> {result.get('sessionId','?')}"
                log.info(f"已注入 oc 对话{target_info}: {text[:60]}")
            else:
                # v0.9.3: 失败时暂存到本地，korina 恢复后可人工重发
                save_pending(text)
                log.error(f"注入失败: {result.get('error', 'unknown')}（已暂存到 {PENDING_DIR}）")
        except Exception as e:
            log.error(f"处理异常: {e}")
        finally:
            self.is_processing = False

# ============================================================
# 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="korina 语音输入 sidecar")
    parser.add_argument("--model", default="small", choices=["tiny", "base", "small", "medium"],
                        help="whisper 模型大小（默认 small）")
    parser.add_argument("--hotkey", default="alt",
                        help="PTT 热键（默认 alt）")
    parser.add_argument("--sr", type=int, default=16000,
                        help="采样率（默认 16000）")
    parser.add_argument("--device", type=int, default=None,
                        help="输入设备 ID（不指定则自动检测真实麦克风）")
    args = parser.parse_args()

    app = VoiceInputApp(
        model_size=args.model,
        hotkey=args.hotkey,
        sample_rate=args.sr,
        device_id=args.device,
    )
    app.run()

if __name__ == "__main__":
    main()
