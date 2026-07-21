"""P8 melody-generator.js 静态结构测试.

不执行 JS（无 Node 浏览器环境），只验证源码包含关键符号、模块导出和算法约束.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPOSITORY_ROOT / "prototype" / "web-workbench" / "melody-generator.js"


class MelodyGeneratorStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not MODULE_PATH.exists():
            raise unittest.SkipTest(f"melody-generator.js not found at {MODULE_PATH}")
        cls.source = MODULE_PATH.read_text(encoding="utf-8")

    def test_module_metadata(self) -> None:
        self.assertIn('MODULE_NAME = "melody-generator"', self.source)
        self.assertIn('MODULE_VERSION = "0.1.0"', self.source)

    def test_chord_tones_table_covers_eight_qualities(self) -> None:
        # 与 librosa_backend.py CHORD_QUALITIES 对齐：major / minor / dom7 / maj7 / m7 / sus / dim / add9
        for quality in (
            "major",
            "minor",
            "dominant-seventh",
            "major-seventh",
            "minor-seventh",
            "suspended",
            "diminished",
            "added-ninth",
        ):
            self.assertIn(quality, self.source, f"missing chord quality: {quality}")

    def test_three_profiles_defined(self) -> None:
        # PROFILES 对象必须包含 conservative / flowing / lively 三个 profile
        for profile in ("conservative", "flowing", "lively"):
            self.assertIn(profile, self.source)
        # 每个 profile 都有四种权重
        for weight in ("chord_weight", "passing_weight", "leap_weight", "rhythm_density"):
            self.assertIn(weight, self.source)

    def test_parse_chord_name_handles_common_shapes(self) -> None:
        # 源码中必须有正则解析逻辑，能识别 C / Am / G7 / F#m7 / Bbmaj7 等
        self.assertIn("function parseChordName", self.source)
        self.assertIn("pcMap", self.source)
        # 至少覆盖这些后缀
        for suffix in ('"m"', '"7"', '"maj7"', '"m7"', '"sus"', '"dim"', '"add9"'):
            self.assertIn(suffix, self.source)

    def test_seeded_rng_for_reproducibility(self) -> None:
        # Mulberry32 实现，必须接受 seed 参数
        self.assertIn("function makeRng", self.source)
        self.assertIn("seed", self.source)
        # 算法标识：Mulberry32 的特征常量 0x6D2B79F5
        self.assertIn("0x6D2B79F5", self.source)

    def test_generate_candidate_signature(self) -> None:
        self.assertIn("function generateCandidate", self.source)
        self.assertIn("function generateCandidates", self.source)
        # 3 套候选必须以 conservative / flowing / lively 顺序生成
        # generateCandidates 返回 [{profile, seed, notes}, ...]
        # 直接用字符串 find 验证相对顺序（assertRegex 默认不跨行）
        c_pos = self.source.find('profile: "conservative"')
        f_pos = self.source.find('profile: "flowing"')
        l_pos = self.source.find('profile: "lively"')
        self.assertGreater(c_pos, 0, "conservative profile must appear in generateCandidates")
        self.assertGreater(f_pos, c_pos, "flowing must come after conservative")
        self.assertGreater(l_pos, f_pos, "lively must come after flowing")

    def test_pitch_range_constraint(self) -> None:
        # pickPitchFromChord 必须接受 low_midi / high_midi 并在范围内选音
        self.assertIn("function pickPitchFromChord", self.source)
        self.assertIn("low_midi", self.source)
        self.assertIn("high_midi", self.source)
        # 必须有兜底逻辑：当没有候选时返回音域中点
        self.assertIn("Math.floor((low_midi + high_midi) / 2)", self.source)

    def test_render_panel_exported(self) -> None:
        # 模块必须通过 globalThis.MikuMelodyGenerator 暴露 renderPanel + 工具函数
        self.assertIn("globalThis.MikuMelodyGenerator", self.source)
        self.assertIn("renderPanel", self.source)
        self.assertIn("parseChordName", self.source)
        self.assertIn("generateCandidate", self.source)
        self.assertIn("generateCandidates", self.source)
        self.assertIn("PROFILES", self.source)

    def test_dispatches_accept_event(self) -> None:
        # 接受候选时必须 dispatch miku:melody-accepted 事件
        self.assertIn("miku:melody-accepted", self.source)
        self.assertIn("CustomEvent", self.source)

    def test_no_external_network_calls(self) -> None:
        # 纯前端规则生成，不允许 fetch / XMLHttpRequest / import 外部模块
        self.assertNotIn("fetch(", self.source)
        self.assertNotIn("XMLHttpRequest", self.source)
        self.assertNotRegex(self.source, r"https?://")
        self.assertNotIn("import ", self.source)


if __name__ == "__main__":
    unittest.main()
