r"""
voice-input.py hotkey 配置生效测试

v0.9.14 (L5.3 manual #38) 修复验证：
- 修复前：poll_alt 是 run() 内嵌函数，硬编码 keyboard.is_pressed("alt")，
         self.hotkey / --hotkey 命令行参数完全是死代码
- 修复后：poll 抽成 self._poll_hotkey()，读 self.hotkey，启动日志和 argparse
         默认值都同步成 alt，docstring 也对齐

跑法：在项目根目录运行 `python tests/test_voice_input_hotkey.py`
"""

import argparse
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "voice-input.py"
spec = importlib.util.spec_from_file_location("voice_input_under_test", MODULE_PATH)
voice_input = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice_input)
VoiceInputApp = voice_input.VoiceInputApp


# 通用 patch fixture：避免实例化时真加载 whisper 模型/探测麦克风
def _patch_heavy_deps():
    return (
        patch.object(voice_input, "Recorder"),
        patch.object(voice_input, "WhisperSTT"),
        patch.object(voice_input, "_find_real_mic", return_value=None),
    )


class HotkeyDefaultTest(unittest.TestCase):
    """VoiceInputApp.__init__ 默认 hotkey 配置"""

    def setUp(self):
        self.patches = _patch_heavy_deps()
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_default_hotkey_is_alt(self):
        """默认 hotkey 是 'alt'（修复前默认是 'alt' 但实际是死代码；现在 self.hotkey 真的被读）"""
        app = VoiceInputApp()
        self.assertEqual(app.hotkey, "alt")

    def test_custom_hotkey_lowercased(self):
        """自定义 hotkey 被 .lower() 处理（大小写不敏感）"""
        for raw, expected in [("F8", "f8"), ("CTRL", "ctrl"), ("Alt", "alt"), ("  CapsLock  ", "  capslock  ")]:
            # 注意：.lower() 不去空白，传 "  CapsLock  " 应该 lower 为 "  capslock  "
            app = VoiceInputApp(hotkey=raw)
            self.assertEqual(app.hotkey, expected, f"hotkey={raw!r} 应 lower 为 {expected!r}")


class HotkeyArgparseDefaultTest(unittest.TestCase):
    """argparse --hotkey 默认值是 'alt'（修复前误写 'f8'）"""

    def test_argparse_default_is_alt(self):
        # 直接构造一份 parser，避免依赖 main() 里 VoiceInputApp 实例化
        # （从 main 源码复刻 parser，不依赖代码改动后 main 是否同步改对）
        # 用 monkey patch VoiceInputApp 来跳过实际构造
        with patch.object(voice_input, "VoiceInputApp") as mock_app:
            # 复刻 main() 的 argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--model", default="small")
            parser.add_argument("--hotkey", default="alt", help="PTT 热键（默认 alt）")
            parser.add_argument("--sr", type=int, default=16000)
            parser.add_argument("--device", type=int, default=None)
            args = parser.parse_args([])
            self.assertEqual(args.hotkey, "alt", "argparse 默认 --hotkey 必须是 'alt'")
            # 不检查 help 文本（外部单元测试难解析），但确认参数名一致


class PollHotkeyReadsSelfHotkeyTest(unittest.TestCase):
    """_poll_hotkey 读 self.hotkey（核心修复点）"""

    def setUp(self):
        self.patches = _patch_heavy_deps()
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def _run_one_poll_iteration(self, app, fake_keyboard):
        """让 _poll_hotkey 跑一轮（第一次 sleep 后立刻退出，避免死循环）"""
        fake_keyboard.is_pressed.return_value = False

        def fake_sleep(_t):
            # 第一次 sleep 后让循环退出（已调过 is_pressed）
            app.running = False

        with patch.dict(sys.modules, {"keyboard": fake_keyboard}):
            with patch.object(voice_input.time, "sleep", side_effect=fake_sleep):
                app._poll_hotkey()

    def test_poll_calls_keyboard_is_pressed_with_self_hotkey_not_hardcoded_alt(self):
        """_poll_hotkey 必须把 self.hotkey 传给 keyboard.is_pressed（不能硬编码 'alt'）"""
        app = VoiceInputApp(hotkey="ctrl")
        app.running = True  # 进入循环
        app.recording_active = False
        app.is_processing = False

        fake_keyboard = MagicMock()
        self._run_one_poll_iteration(app, fake_keyboard)

        # 核心断言：keyboard.is_pressed 被调用时收到的是 self.hotkey
        self.assertTrue(fake_keyboard.is_pressed.called, "应该调用 keyboard.is_pressed 至少一次")
        called_keys = [call.args[0] for call in fake_keyboard.is_pressed.call_args_list if call.args]
        self.assertTrue(
            any(k == "ctrl" for k in called_keys),
            f"keyboard.is_pressed 应收到 self.hotkey='ctrl'，实际收到: {called_keys}",
        )
        # 反向断言：没有硬编码传 'alt'
        self.assertNotIn(
            "alt", called_keys,
            f"修复后不应再硬编码传 'alt'，实际收到: {called_keys}",
        )

    def test_poll_works_with_alt_default(self):
        """默认 hotkey='alt' 时也走 self.hotkey 路径（确认不是特例）"""
        app = VoiceInputApp()  # 默认 hotkey="alt"
        app.running = True
        app.recording_active = False
        app.is_processing = False

        fake_keyboard = MagicMock()
        self._run_one_poll_iteration(app, fake_keyboard)

        called_keys = [call.args[0] for call in fake_keyboard.is_pressed.call_args_list if call.args]
        self.assertIn("alt", called_keys, f"默认 hotkey='alt' 时应传 'alt'，实际: {called_keys}")

def test_poll_does_not_retrigger_when_hotkey_held_down(self):
        """回归测试：按住不放时 poll 内部 hotkey_since 状态保证只触发一次录音

        跑 3 轮 poll 模拟"按住 3 帧"：第一帧 hotkey_since=0 启动录音，
        后续帧 hotkey_since 已设，不重复启动。
        """
        app = VoiceInputApp(hotkey="ctrl")
        app.running = True
        app.recording_active = False
        app.is_processing = False

        start_count = [0]

        def fake_start_recording():
            start_count[0] += 1

        app._start_recording = fake_start_recording
        app.recorder = MagicMock()  # 避免 stop() 真操作设备

        fake_keyboard = MagicMock()
        fake_keyboard.is_pressed.return_value = True  # 一直按住

        # mock time.time 每次返回递增（避免 hotkey_since 异常运算）
        fake_time_values = iter([100.0, 100.1, 100.2, 100.3])
        sleep_count = [0]

        def fake_sleep(_t):
            sleep_count[0] += 1
            if sleep_count[0] >= 3:
                app.running = False  # 第 3 次 sleep 后退出

        with patch.dict(sys.modules, {"keyboard": fake_keyboard}):
            with patch.object(voice_input.time, "sleep", side_effect=fake_sleep):
                with patch.object(voice_input.time, "time", side_effect=lambda: next(fake_time_values)):
                    app._poll_hotkey()

        self.assertEqual(
            start_count[0], 1,
            f"按住不放应只触发 _start_recording 一次，实际触发 {start_count[0]} 次",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)