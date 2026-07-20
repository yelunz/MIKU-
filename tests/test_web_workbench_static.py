from html.parser import HTMLParser
from pathlib import Path
import re
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WORKBENCH = REPOSITORY_ROOT / "prototype" / "web-workbench"


class WorkbenchHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []
        self.scripts: list[str] = []
        self.stylesheets: list[str] = []
        self.english_lyric_option = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if values.get("id"):
            self.ids.append(values["id"] or "")
        if tag == "script" and values.get("src"):
            self.scripts.append(values["src"] or "")
        if tag == "link" and values.get("rel") == "stylesheet" and values.get("href"):
            self.stylesheets.append(values["href"] or "")
        if tag == "option" and values.get("value") == "en":
            self.english_lyric_option = True


class WebWorkbenchStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = (WORKBENCH / "index.html").read_text(encoding="utf-8")
        cls.javascript = (WORKBENCH / "app.js").read_text(encoding="utf-8")
        cls.styles = (WORKBENCH / "styles.css").read_text(encoding="utf-8")
        cls.parser = WorkbenchHtmlParser()
        cls.parser.feed(cls.html)

    def test_entrypoint_has_unique_ids_and_local_assets(self) -> None:
        self.assertEqual(len(self.parser.ids), len(set(self.parser.ids)))
        self.assertEqual(self.parser.scripts, ["desktop-bridge.js", "app.js"])
        self.assertEqual(self.parser.stylesheets, ["styles.css"])
        self.assertNotRegex(self.html, r"https?://")
        self.assertNotRegex(self.styles, r"https?://")

    def test_lyrics_are_limited_to_chinese_and_japanese(self) -> None:
        self.assertFalse(self.parser.english_lyric_option)
        self.assertIn('<option value="zh">中文</option>', self.html)
        self.assertIn('<option value="ja">日文</option>', self.html)
        self.assertIn('new Set(["zh", "ja"])', self.javascript)

    def test_user_content_is_not_inserted_with_inner_html(self) -> None:
        self.assertNotIn("innerHTML", self.javascript)
        self.assertIn("textContent", self.javascript)

    def test_project_and_analysis_versions_are_explicit(self) -> None:
        # 0.2.0 引入 sample + PPQ 960 + Anchor 模型；旧版 0.1.0 必须仍能导入。
        self.assertIn('PROJECT_SCHEMA = "miku-workbench-project/0.2.0"', self.javascript)
        self.assertIn('PROJECT_SCHEMA_LEGACY = "miku-workbench-project/0.1.0"', self.javascript)
        self.assertIn('ANALYSIS_SCHEMA = "0.1.0"', self.javascript)
        self.assertIn("validateAnalysis", self.javascript)

    def test_analysis_validation_covers_every_rendered_inference_layer(self) -> None:
        for layer, field in (
            ("waveform", "bins"),
            ("short_time_energy", "bins"),
            ("tempo", "candidates"),
            ("key", "candidates"),
            ("chords", "windows"),
            ("sections", "boundaries"),
            ("sections", "regions"),
        ):
            self.assertIn(f'["{layer}", "{field}"]', self.javascript)
        self.assertIn("validateInterval", self.javascript)

    def test_project_import_rejects_duplicate_ids_and_unsupported_languages(self) -> None:
        self.assertIn("seenLyricIds.has(id)", self.javascript)
        self.assertIn("maximumLyricNumber + 1", self.javascript)
        self.assertIn('new Set(["zh", "ja"]).has(region.language)', self.javascript)

    def test_audio_association_checks_duration_and_sha256(self) -> None:
        self.assertIn("checkAudioAssociation", self.javascript)
        self.assertIn("state.audioSha256", self.javascript)
        self.assertIn("expectedHash !== state.audioSha256", self.javascript)

    def test_tempo_validation_and_rendering_have_iteration_guards(self) -> None:
        self.assertIn("candidateItem.bpm > 1000", self.javascript)
        self.assertIn("candidateItem.first_beat_seconds < 0", self.javascript)
        self.assertIn("maximumLines", self.javascript)
        self.assertIn("estimatedLineCount", self.javascript)

    def test_local_audio_urls_are_created_and_released(self) -> None:
        bridge = (WORKBENCH / "desktop-bridge.js").read_text(encoding="utf-8")
        self.assertIn("URL.createObjectURL(blob)", bridge)
        self.assertIn("URL.revokeObjectURL(url)", bridge)
        self.assertIn("bridge.revokeObjectUrl(state.audioUrl)", self.javascript)
        self.assertIn('addEventListener("pagehide"', self.javascript)

    def test_required_controls_are_wired(self) -> None:
        required_ids = {
            "analysis-file", "audio-file", "play-button", "timeline-canvas",
            "selection-start", "selection-end", "lyric-language", "lyric-text",
            "save-lyric-button", "chord-label", "save-chord-button",
            "restore-chord-button", "import-project-button", "export-project-button",
            "snap-grid", "continuous-lyrics", "selection-start-handle", "selection-end-handle",
            # 0.2.0 新增：休止检查器与显式休止按钮
            "rest-inspector", "rest-detail", "convert-rest-button", "delete-rest-button",
        }
        self.assertTrue(required_ids.issubset(set(self.parser.ids)))
        for identifier in required_ids:
            self.assertRegex(self.javascript, re.escape(identifier))

    def test_editor_shortcuts_snapping_and_shared_edges_are_wired(self) -> None:
        self.assertIn('event.code !== "Space"', self.javascript)
        self.assertIn("event.repeat", self.javascript)
        self.assertIn("event.isComposing", self.javascript)
        self.assertIn("snapIntervalSeconds", self.javascript)
        self.assertIn('addEventListener("pointercancel"', self.javascript)
        self.assertIn("event.altKey ? 0.001", self.javascript)
        self.assertNotIn("target instanceof HTMLButtonElement", self.javascript)
        # 0.2.0：歌词区域改用共享 anchor 边界（数据层共享，不再用秒数硬链接）。
        self.assertIn("startAnchorId", self.javascript)
        self.assertIn("endAnchorId", self.javascript)
        self.assertIn("previous.endAnchorId", self.javascript)
        self.assertIn("next.startAnchorId", self.javascript)
        # 共享边手柄渲染与拖动路由
        self.assertIn("renderSharedEdges", self.javascript)
        self.assertIn("shared-edge-handle", self.javascript)
        self.assertIn("beginEdgeDrag", self.javascript)
        self.assertIn("state.edgeDragging", self.javascript)
        # 未分配空段仍渲染（保留显式留白提示）
        self.assertIn('gap.textContent = "未分配"', self.javascript)
        self.assertIn('block.style.right = percentAt(state.duration - endSeconds)', self.javascript)

    def test_tempo_map_and_anchor_model_are_present(self) -> None:
        # TempoMap：sample 为权威基准，PPQ 960，tick 由 sample 派生
        self.assertIn("const PPQ = 960", self.javascript)
        self.assertIn("buildTempoMap", self.javascript)
        self.assertIn("sampleToTick", self.javascript)
        self.assertIn("tickToSample", self.javascript)
        self.assertIn("firstBeatSample", self.javascript)
        self.assertIn("firstBeatTick", self.javascript)
        # Anchor 表
        self.assertIn("state.anchors", self.javascript)
        self.assertIn("createAnchorAtSample", self.javascript)
        self.assertIn("moveAnchor", self.javascript)
        self.assertIn("findAnchorBySample", self.javascript)
        self.assertIn("pruneAnchors", self.javascript)
        self.assertIn("ANCHOR_TOLERANCE_SECONDS", self.javascript)
        # 项目 schema 0.2.0 字段
        self.assertIn("tempo_map:", self.javascript)
        self.assertIn("first_beat_sample:", self.javascript)
        self.assertIn("anchors: serializeAnchors()", self.javascript)
        self.assertIn("start_anchor_id:", self.javascript)
        self.assertIn("end_anchor_id:", self.javascript)

    def test_rest_events_are_first_class_data(self) -> None:
        # RestEvent 是显式数据，区别于"未分配空段"的渲染占位
        self.assertIn("state.rests", self.javascript)
        self.assertIn("convertSelectionToRest", self.javascript)
        self.assertIn("deleteRest", self.javascript)
        self.assertIn("editRest", self.javascript)
        self.assertIn('"rest"', self.javascript)
        self.assertIn("explicit-rest", self.javascript)
        self.assertIn("unassigned-block", self.javascript)

    def test_legacy_project_migration_is_present(self) -> None:
        # 0.1.0 项目必须能迁移到 0.2.0 共享 anchor 模型
        self.assertIn("migrateLegacyProject", self.javascript)
        self.assertIn("PROJECT_SCHEMA_LEGACY", self.javascript)
        self.assertIn("已导入 0.1.0 项目并迁移到 0.2.0", self.javascript)

    def test_edit_graph_undo_redo_is_present(self) -> None:
        # EditGraph 第一版：撤销/重做栈、按钮、Ctrl+Z/Ctrl+Shift+Z 快捷键
        self.assertIn("const editGraph = {", self.javascript)
        self.assertIn("editGraph.undoStack", self.javascript)
        self.assertIn("editGraph.redoStack", self.javascript)
        self.assertIn("editGraph.begin(", self.javascript)
        self.assertIn("editGraph.undo()", self.javascript)
        self.assertIn("editGraph.redo()", self.javascript)
        self.assertIn("canUndo()", self.javascript)
        self.assertIn("canRedo()", self.javascript)
        # 撤销/重做按钮必须存在于 HTML 与 JS 引用中
        self.assertIn('id="undo-button"', self.html)
        self.assertIn('id="redo-button"', self.html)
        self.assertIn("undoButton", self.javascript)
        self.assertIn("redoButton", self.javascript)
        self.assertIn("updateUndoRedoButtons", self.javascript)
        # Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 快捷键
        self.assertIn('event.key === "z"', self.javascript)
        self.assertIn('event.key === "y"', self.javascript)
        # 在用户操作（新建歌词、删除歌词、新建休止、删除休止、和弦修正、共享边拖动）处记录撤销点
        self.assertIn('editGraph.begin("新建歌词")', self.javascript)
        self.assertIn('editGraph.begin("新建休止")', self.javascript)
        self.assertIn("editGraph.begin(`删除歌词", self.javascript)
        self.assertIn("editGraph.begin(`删除休止", self.javascript)
        self.assertIn("editGraph.begin(`修正和弦", self.javascript)
        self.assertIn('editGraph.begin("拖动共享边界")', self.javascript)
        # 导入新项目时清空 undo/redo 栈
        self.assertIn("editGraph.undoStack = []", self.javascript)
        self.assertIn("editGraph.redoStack = []", self.javascript)

    def test_lyric_block_drag_and_stretch_are_present(self) -> None:
        # 歌词块整体拖动与边缘拉伸：用 pointerdown 区分点击编辑与拖动
        self.assertIn("state.lyricDrag", self.javascript)
        self.assertIn("beginLyricBlockDrag", self.javascript)
        self.assertIn("moveLyricBlock", self.javascript)
        self.assertIn("endLyricBlockDrag", self.javascript)
        self.assertIn("cancelLyricBlockDrag", self.javascript)
        # 三种模式：整体移动、拉伸起始、拉伸结束
        self.assertIn('"stretch-start"', self.javascript)
        self.assertIn('"stretch-end"', self.javascript)
        self.assertIn('"move"', self.javascript)
        # 共享 anchor 在拖动/拉伸前会被克隆，避免影响邻居
        self.assertIn("detachAnchorIfShared", self.javascript)
        # 拖动阈值：4 像素以内视为点击
        self.assertIn("state.lyricDrag.startClientX", self.javascript)
        # Esc 取消歌词块拖动
        self.assertIn("state.lyricDrag", self.javascript)
        self.assertIn("cancelLyricBlockDrag()", self.javascript)


if __name__ == "__main__":
    unittest.main()
