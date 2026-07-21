"""P6 stem_separator 静态结构与导入测试.

只验证模块结构、常量、函数签名和 manifest schema，不调用 librosa.
真实音频回归测试在 next_actions 中单独跟踪.
"""

from __future__ import annotations

import importlib
import inspect
import json
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPOSITORY_ROOT / "tools" / "miku_analysis" / "stem_separator.py"


class StemSeparatorStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not MODULE_PATH.exists():
            raise unittest.SkipTest(f"stem_separator.py not found at {MODULE_PATH}")
        cls.module = importlib.import_module("tools.miku_analysis.stem_separator")
        cls.source = MODULE_PATH.read_text(encoding="utf-8")

    def test_module_constants(self) -> None:
        self.assertEqual(self.module.ANALYZER_NAME, "miku-stem-separator")
        self.assertEqual(self.module.ANALYZER_VERSION, "0.1.0")
        self.assertEqual(self.module.SCHEMA_VERSION, "0.1.0")
        self.assertEqual(self.module.METHOD, "hpss+spectral-mask")
        # 频段常数必须满足设计：bass 在低频，vocals 在中频，二者之间留 50Hz 间隙
        self.assertLess(self.module.BASS_HIGH_HZ, self.module.VOCALS_LOW_HZ)
        self.assertGreater(self.module.VOCALS_HIGH_HZ, self.module.VOCALS_LOW_HZ)
        # HPSS kernel 必须为正奇数（librosa 要求）
        self.assertGreater(self.module.HPSS_KERNEL, 0)
        self.assertEqual(self.module.HPSS_KERNEL % 2, 1)

    def test_separate_stems_signature(self) -> None:
        sig = inspect.signature(self.module.separate_stems)
        params = list(sig.parameters.keys())
        self.assertEqual(params, ["input_path", "output_dir"])

    def test_spectral_mask_signature(self) -> None:
        sig = inspect.signature(self.module._spectral_mask)
        params = list(sig.parameters.keys())
        # y, sr, low_hz, high_hz 是必填，n_fft / hop_length 可选
        self.assertEqual(params[:4], ["y", "sr", "low_hz", "high_hz"])

    def test_manifest_schema_documented_in_docstring(self) -> None:
        # 模块 docstring 必须声明 schema_version / analyzer / stems / parameters 四块
        doc = self.module.__doc__ or ""
        self.assertIn("schema_version", doc)
        self.assertIn("analyzer", doc)
        self.assertIn("stems", doc)
        self.assertIn("parameters", doc)
        # 4 个 stem 名字在 docstring 中都有提到
        for stem in ("vocals", "drums", "bass", "other"):
            self.assertIn(stem, doc)

    def test_main_cli_entrypoint(self) -> None:
        self.assertTrue(callable(self.module.main))
        # main 必须用 argparse 接收 input + 可选 -o / --manifest
        src = inspect.getsource(self.module.main)
        self.assertIn("argparse", src)
        self.assertIn("input", src)
        self.assertIn("--output-dir", src)
        self.assertIn("--manifest", src)


class StemSeparatorLauncherIntegrationTests(unittest.TestCase):
    """验证 launcher.py 把 separate_stems 暴露成 JSON-RPC 方法."""

    @classmethod
    def setUpClass(cls) -> None:
        launcher_path = REPOSITORY_ROOT / "tools" / "miku_analysis" / "launcher.py"
        if not launcher_path.exists():
            raise unittest.SkipTest("launcher.py not found")
        cls.launcher_source = launcher_path.read_text(encoding="utf-8")

    def test_launcher_imports_separate_stems(self) -> None:
        self.assertIn(
            "from tools.miku_analysis.stem_separator import separate_stems",
            self.launcher_source,
        )

    def test_launcher_handles_separate_stems_method(self) -> None:
        # handle_request 必须识别 "separate_stems" 方法名
        self.assertIn('"separate_stems"', self.launcher_source)
        self.assertIn("separate_stems", self.launcher_source)


if __name__ == "__main__":
    unittest.main()
