"""P7 transcriber 静态结构与导入测试."""

from __future__ import annotations

import importlib
import inspect
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPOSITORY_ROOT / "tools" / "miku_analysis" / "transcriber.py"


class TranscriberStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not MODULE_PATH.exists():
            raise unittest.SkipTest(f"transcriber.py not found at {MODULE_PATH}")
        cls.module = importlib.import_module("tools.miku_analysis.transcriber")

    def test_module_constants(self) -> None:
        self.assertEqual(cls_name := self.module.ANALYZER_NAME, "miku-transcriber")
        self.assertEqual(self.module.ANALYZER_VERSION, "0.1.0")
        self.assertEqual(self.module.SCHEMA_VERSION, "0.1.0")
        self.assertEqual(self.module.METHOD, "pyin+onset")
        # fmin/fmax 必须覆盖人声主旋律范围：C2 (65.41) 到 C6 (1046.5)
        self.assertLess(self.module.DEFAULT_FMIN_HZ, 100.0)
        self.assertGreater(self.module.DEFAULT_FMAX_HZ, 1000.0)
        self.assertLess(self.module.MIN_NOTE_DURATION_S, 1.0)
        # needs_review 阈值必须在 (0, 1) 区间
        self.assertGreater(self.module.NEEDS_REVIEW_THRESHOLD, 0.0)
        self.assertLess(self.module.NEEDS_REVIEW_THRESHOLD, 1.0)

    def test_hz_to_midi_helper(self) -> None:
        # A4 = 440 Hz → MIDI 69
        self.assertEqual(self.module._hz_to_midi(440.0), 69)
        # C4 ≈ 261.63 Hz → MIDI 60
        self.assertEqual(self.module._hz_to_midi(261.63), 60)
        # 0 或负值 → 0（哑值）
        self.assertEqual(self.module._hz_to_midi(0.0), 0)
        self.assertEqual(self.module._hz_to_midi(-1.0), 0)

    def test_transcribe_audio_signature(self) -> None:
        sig = inspect.signature(self.module.transcribe_audio)
        params = list(sig.parameters.keys())
        self.assertEqual(params[:1], ["input_path"])
        # fmin_hz 和 fmax_hz 必须是可选参数（有默认值）
        self.assertIn("fmin_hz", sig.parameters)
        self.assertIn("fmax_hz", sig.parameters)
        fmin_default = sig.parameters["fmin_hz"].default
        fmax_default = sig.parameters["fmax_hz"].default
        self.assertEqual(fmin_default, self.module.DEFAULT_FMIN_HZ)
        self.assertEqual(fmax_default, self.module.DEFAULT_FMAX_HZ)

    def test_manifest_schema_documented_in_docstring(self) -> None:
        doc = self.module.__doc__ or ""
        self.assertIn("schema_version", doc)
        self.assertIn("analyzer", doc)
        self.assertIn("notes", doc)
        self.assertIn("parameters", doc)
        self.assertIn("needs_review", doc)
        self.assertIn("confidence", doc)

    def test_main_cli_entrypoint(self) -> None:
        self.assertTrue(callable(self.module.main))
        src = inspect.getsource(self.module.main)
        self.assertIn("argparse", src)
        self.assertIn("input", src)
        self.assertIn("--fmin", src)
        self.assertIn("--fmax", src)


class TranscriberLauncherIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        launcher_path = REPOSITORY_ROOT / "tools" / "miku_analysis" / "launcher.py"
        if not launcher_path.exists():
            raise unittest.SkipTest("launcher.py not found")
        cls.launcher_source = launcher_path.read_text(encoding="utf-8")

    def test_launcher_imports_transcribe_audio(self) -> None:
        self.assertIn(
            "from tools.miku_analysis.transcriber import transcribe_audio",
            self.launcher_source,
        )

    def test_launcher_handles_transcribe_method(self) -> None:
        self.assertIn('"transcribe"', self.launcher_source)


if __name__ == "__main__":
    unittest.main()
