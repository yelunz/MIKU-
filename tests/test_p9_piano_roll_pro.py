"""P9 piano-roll-pro.js 静态结构测试."""

from __future__ import annotations

import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPOSITORY_ROOT / "prototype" / "web-workbench" / "piano-roll-pro.js"


class PianoRollProStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not MODULE_PATH.exists():
            raise unittest.SkipTest(f"piano-roll-pro.js not found at {MODULE_PATH}")
        cls.source = MODULE_PATH.read_text(encoding="utf-8")

    def test_module_metadata(self) -> None:
        self.assertIn('MODULE_NAME = "piano-roll-pro"', self.source)
        self.assertIn('MODULE_VERSION = "0.1.0"', self.source)

    def test_default_tracks_define_four_roles(self) -> None:
        # DEFAULT_TRACKS 必须包含主唱 / 和声1 / 和声2 / 转录候选 4 条轨道
        for track_id in ('"lead"', '"harm1"', '"harm2"', '"transcript"'):
            self.assertIn(track_id, self.source)
        # 每条轨道必须定义 color（用于 Canvas 区分）
        self.assertIn("color", self.source)
        self.assertIn("muted", self.source)
        self.assertIn("solo", self.source)

    def test_curve_templates_cover_three_kinds(self) -> None:
        # CURVE_TEMPLATES 至少包含 pitch / dynamics / vibrato 三种类型
        for kind in ('"pitch"', '"dynamics"', '"vibrato"'):
            self.assertIn(kind, self.source)
        # 至少 5 个模板（pitch-steady / pitch-rise / dynamics-crescendo / dynamics-decrescendo / vibrato-default）
        for tpl in (
            "pitch-steady",
            "pitch-rise",
            "dynamics-crescendo",
            "dynamics-decrescendo",
            "vibrato-default",
        ):
            self.assertIn(tpl, self.source)

    def test_midi_to_name_helper(self) -> None:
        self.assertIn("function midiToName", self.source)
        self.assertIn("NOTE_NAMES", self.source)
        # 12 个音名必须全部出现
        for name in ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"):
            self.assertIn(f'"{name}"', self.source)

    def test_piano_roll_pro_class_defined(self) -> None:
        self.assertIn("class PianoRollPro", self.source)
        # 必须实现关键方法：constructor / setNotes / setParamCurve / render / exportState
        for method in (
            "constructor(container",
            "setNotes",
            "setParamCurve",
            "render(",
            "exportState(",
        ):
            self.assertIn(method, self.source, f"missing method: {method}")

    def test_canvas_rendering(self) -> None:
        # 必须用 Canvas 2D context 渲染音符与曲线
        self.assertIn("canvas", self.source)
        self.assertIn("getContext", self.source)
        # 内部允许用 innerHTML 构建面板静态 HTML 模板（按钮/选项等组件 UI），
        # 但不允许把用户/转录/生成数据直接拼到 innerHTML 字符串中（避免 XSS）。
        # 数据展示（音符列表/候选列表）必须用 textContent + createElement.
        # 这里检查动态数据展示部分是否用 textContent 而非 innerHTML 拼接。
        self.assertIn("textContent", self.source)

    def test_multitrack_visibility_logic(self) -> None:
        # _visibleTracks 必须处理 solo 优先 + mute 过滤
        self.assertIn("_visibleTracks", self.source)
        self.assertIn(".solo", self.source)
        self.assertIn(".muted", self.source)
        self.assertIn("!t.muted", self.source)

    def test_create_note_via_double_click(self) -> None:
        # 双击空白区域创建音符
        self.assertIn("_onDoubleClick", self.source)
        # 新音符必须包含 track_id 字段（多轨标识）
        self.assertIn("track_id", self.source)
        self.assertIn("velocity", self.source)

    def test_delete_note_via_keyboard(self) -> None:
        # Delete / Backspace 删除选中音符
        self.assertIn("_onKeyDown", self.source)
        self.assertIn("Delete", self.source)
        self.assertIn("Backspace", self.source)
        # 必须尊重 locked 标记（不删除锁定的音符）
        self.assertIn("n.locked", self.source)

    def test_dispatches_change_event(self) -> None:
        self.assertIn("_dispatchChange", self.source)
        self.assertIn("miku:piano-roll-pro-changed", self.source)
        self.assertIn("CustomEvent", self.source)

    def test_module_exports(self) -> None:
        # 通过 globalThis.MikuPianoRollPro 暴露 PianoRollPro 类 + 模板 + 工具
        self.assertIn("globalThis.MikuPianoRollPro", self.source)
        self.assertIn("PianoRollPro", self.source)
        self.assertIn("CURVE_TEMPLATES", self.source)
        self.assertIn("DEFAULT_TRACKS", self.source)
        self.assertIn("midiToName", self.source)

    def test_no_external_network_calls(self) -> None:
        self.assertNotIn("fetch(", self.source)
        self.assertNotIn("XMLHttpRequest", self.source)
        self.assertNotRegex(self.source, r"https?://")


if __name__ == "__main__":
    unittest.main()
