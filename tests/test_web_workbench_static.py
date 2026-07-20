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
        # 0.3.0 在 0.2.0 基础上新增 syllables + vocalPreview；0.2.0 与 0.1.0 项目都必须仍能迁移导入。
        self.assertIn('PROJECT_SCHEMA = "miku-workbench-project/0.3.0"', self.javascript)
        self.assertIn('PROJECT_SCHEMA_LEGACY = "miku-workbench-project/0.1.0"', self.javascript)
        self.assertIn('PROJECT_SCHEMA_LEGACY_020 = "miku-workbench-project/0.2.0"', self.javascript)
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
        # 0.1.0 项目必须能迁移到 0.3.0 共享 anchor + syllable 模型
        # 0.2.0 项目必须能迁移到 0.3.0（派生默认 syllables）
        self.assertIn("migrateLegacyProject", self.javascript)
        self.assertIn("PROJECT_SCHEMA_LEGACY", self.javascript)
        self.assertIn("PROJECT_SCHEMA_LEGACY_020", self.javascript)
        self.assertIn("已导入 0.1.0 项目并迁移到 0.3.0", self.javascript)
        self.assertIn("已导入 0.2.0 项目并迁移到 0.3.0", self.javascript)
        self.assertIn("已为歌词区域派生默认音节切分", self.javascript)

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

    def test_zoom_anchor_and_playhead_auto_scroll_are_present(self) -> None:
        # 缩放锚点：zoomRange input 事件中以"视口中心时间点"为锚保持位置
        self.assertIn("centerTime", self.javascript)
        self.assertIn("newCenterPx", self.javascript)
        # Ctrl/Cmd + 滚轮在时间轴上缩放，以鼠标位置为锚点
        self.assertIn('event.ctrlKey || event.metaKey', self.javascript)
        self.assertIn("pointerTime", self.javascript)
        self.assertIn("newPointerAbsolutePx", self.javascript)
        # 自动滚动：播放头进入视口右 18% 时滚动跟随
        self.assertIn("autoScrollToPlayhead", self.javascript)
        self.assertIn("viewportWidth * 0.82", self.javascript)
        self.assertIn("viewportWidth * 0.18", self.javascript)
        # 用户主动滚动后 1.5 秒内暂停自动跟随
        self.assertIn("state.manualScrollAt", self.javascript)
        self.assertIn("state.programmaticScroll", self.javascript)
        self.assertIn("performance.now() - state.manualScrollAt < 1500", self.javascript)
        # wheel 监听必须显式 non-passive 才能 preventDefault
        self.assertIn("{ passive: false }", self.javascript)

    def test_field_level_locking_is_present(self) -> None:
        # 字段级锁定数据模型与工具函数
        self.assertIn("state.lockedFields", self.javascript)
        self.assertIn("function lockKey", self.javascript)
        self.assertIn("function isLocked", self.javascript)
        self.assertIn("function setLocked", self.javascript)
        self.assertIn("function serializeLockedFields", self.javascript)
        self.assertIn("function refreshLockToggle", self.javascript)
        # 三种锁定对象类型
        self.assertIn('"lyric", id', self.javascript)
        self.assertIn('"rest", id', self.javascript)
        self.assertIn('"chord", key', self.javascript)
        # 锁定状态在撤销/重做快照中保存
        self.assertIn("lockedFields: Array.from(state.lockedFields)", self.javascript)
        self.assertIn("state.lockedFields = new Set(Array.isArray(snapshot.lockedFields)", self.javascript)
        # 锁定 UI：HTML 中的 checkbox 与 JS 引用
        self.assertIn('id="lock-lyric-checkbox"', self.html)
        self.assertIn('id="lock-rest-checkbox"', self.html)
        self.assertIn('id="lock-chord-checkbox"', self.html)
        self.assertIn("lockLyricCheckbox", self.javascript)
        self.assertIn("lockRestCheckbox", self.javascript)
        self.assertIn("lockChordCheckbox", self.javascript)
        # 锁定 toggle 事件绑定
        self.assertIn('editGraph.begin(`锁定歌词', self.javascript)
        self.assertIn('editGraph.begin(`锁定休止', self.javascript)
        self.assertIn('editGraph.begin(`锁定和弦', self.javascript)
        # 锁定状态在删除时同步清除
        self.assertIn('setLocked("lyric", state.selectedLyricId, false)', self.javascript)
        self.assertIn('setLocked("rest", id, false)', self.javascript)
        # 锁定阻止删除/恢复原值
        self.assertIn("此歌词已锁定", self.javascript)
        self.assertIn("此休止已锁定", self.javascript)
        self.assertIn("此和弦修正已锁定", self.javascript)
        # 项目导出/导入包含 locked_fields
        self.assertIn("locked_fields: serializeLockedFields()", self.javascript)
        self.assertIn("editing.locked_fields", self.javascript)
        # 渲染时显示锁定状态
        self.assertIn('block.classList.add("locked")', self.javascript)
        # 0.1.0 迁移时清空锁定
        self.assertIn("0.1.0 项目没有锁定字段概念", self.javascript)

    def test_stem_mixer_data_model_and_ui_are_present(self) -> None:
        # stem 轨数据模型：默认 stem 集（master/drums/bass/other）
        self.assertIn("state.stemTracks", self.javascript)
        self.assertIn("defaultStemTracks", self.javascript)
        self.assertIn('"master"', self.javascript)
        self.assertIn('"drums"', self.javascript)
        self.assertIn('"bass"', self.javascript)
        self.assertIn('"other"', self.javascript)
        # 每个 stem 字段：mute / solo / gain / pan / source
        self.assertIn("track.mute", self.javascript)
        self.assertIn("track.solo", self.javascript)
        self.assertIn("track.gain", self.javascript)
        self.assertIn("track.pan", self.javascript)
        self.assertIn('source: "main"', self.javascript)
        self.assertIn('source: "placeholder"', self.javascript)
        # Web Audio API 节点图：master stem 真实生效 gain/pan/mute/solo
        self.assertIn("audioGraph", self.javascript)
        self.assertIn("setupAudioGraph", self.javascript)
        self.assertIn("createMediaElementSource", self.javascript)
        self.assertIn("createGain", self.javascript)
        self.assertIn("createStereoPanner", self.javascript)
        self.assertIn("resumeAudioContext", self.javascript)
        # 混音逻辑：solo 优先、mute 屏蔽、effective gain/pan 计算
        self.assertIn("applyStemMix", self.javascript)
        self.assertIn("stemEffectiveState", self.javascript)
        self.assertIn("anySolo", self.javascript)
        # 渲染：HTML 容器 + JS 渲染函数 + 行构建函数
        self.assertIn('id="stem-mixer"', self.html)
        self.assertIn("stemMixer", self.javascript)
        self.assertIn("renderStemMixer", self.javascript)
        self.assertIn("buildStemRow", self.javascript)
        self.assertIn('data-stem-control="mute"', self.javascript)
        self.assertIn('data-stem-control="solo"', self.javascript)
        self.assertIn('data-stem-control="gain"', self.javascript)
        self.assertIn('data-stem-control="pan"', self.javascript)
        # 撤销/重做快照包含 stem 轨
        self.assertIn("stemTracks: state.stemTracks.map(track", self.javascript)
        self.assertIn("snapshot.stemTracks", self.javascript)
        # 项目导入/导出包含 stem_tracks
        self.assertIn("stem_tracks: state.stemTracks.map", self.javascript)
        self.assertIn("editing.stem_tracks", self.javascript)
        # 0.1.0 项目迁移时回退到默认 stem
        self.assertIn("0.1.0 项目没有 stem_tracks 字段", self.javascript)
        # 事件绑定：mute/solo 点击、gain/pan input/change
        self.assertIn("elements.stemMixer.addEventListener", self.javascript)
        # 第一次播放时初始化 audio graph（autoplay 政策）
        self.assertIn("setupAudioGraph()", self.javascript)
        self.assertIn("resumeAudioContext()", self.javascript)
        # CSS 样式
        self.assertIn(".stem-mixer-card", self.styles)
        self.assertIn(".stem-row", self.styles)
        self.assertIn(".stem-controls", self.styles)
        self.assertIn(".stem-master", self.styles)
        self.assertIn(".stem-placeholder", self.styles)

    def test_piano_roll_and_note_events_are_present(self) -> None:
        # NoteEvent 数据模型字段
        self.assertIn("state.notes", self.javascript)
        self.assertIn("state.nextNoteId", self.javascript)
        self.assertIn("state.selectedNoteId", self.javascript)
        self.assertIn("state.noteDrag", self.javascript)
        self.assertIn("state.pianoRollStemId", self.javascript)
        self.assertIn("state.pianoRollMergeCandidateId", self.javascript)
        # 钢琴卷帘常量与工具函数
        self.assertIn("PIANO_ROLL_MIN_PITCH = 36", self.javascript)
        self.assertIn("PIANO_ROLL_MAX_PITCH = 96", self.javascript)
        self.assertIn("PIANO_ROLL_ROW_HEIGHT", self.javascript)
        self.assertIn("function midiToNoteName", self.javascript)
        self.assertIn("function isBlackKey", self.javascript)
        # NoteEvent CRUD 函数
        self.assertIn("function createNote", self.javascript)
        self.assertIn("function deleteNote", self.javascript)
        self.assertIn("function selectNote", self.javascript)
        self.assertIn("function splitSelectedNote", self.javascript)
        self.assertIn("function mergeSelectedNotes", self.javascript)
        # 钢琴卷帘渲染与交互
        self.assertIn("function renderPianoRoll", self.javascript)
        self.assertIn("function drawPianoRollCanvas", self.javascript)
        self.assertIn("function buildNoteBlock", self.javascript)
        self.assertIn("function beginNoteDrag", self.javascript)
        self.assertIn("function moveNote", self.javascript)
        self.assertIn("function endNoteDrag", self.javascript)
        self.assertIn("function cancelNoteDrag", self.javascript)
        self.assertIn("function beginNoteCreate", self.javascript)
        self.assertIn("function moveNoteCreate", self.javascript)
        self.assertIn("function endNoteCreate", self.javascript)
        self.assertIn("function cancelNoteCreate", self.javascript)
        self.assertIn("function detachNoteAnchorIfShared", self.javascript)
        self.assertIn("function timeFromPianoPointer", self.javascript)
        self.assertIn("function pitchFromPianoPointer", self.javascript)
        self.assertIn("function updatePianoRollToolButtons", self.javascript)
        # 三种拖动模式 + create 模式
        self.assertIn('"stretch-start"', self.javascript)
        self.assertIn('"stretch-end"', self.javascript)
        self.assertIn('"move"', self.javascript)
        self.assertIn('mode: "create"', self.javascript)
        # 撤销/重做快照包含 notes
        self.assertIn("notes: state.notes.map(note => ({ ...note }))", self.javascript)
        self.assertIn("state.notes = Array.isArray(snapshot.notes)", self.javascript)
        self.assertIn("nextNoteId: state.nextNoteId", self.javascript)
        # 项目导出包含 notes
        self.assertIn("notes: state.notes.map(note => ({", self.javascript)
        self.assertIn("stem_id: note.stemId", self.javascript)
        self.assertIn("start_anchor_id: note.startAnchorId", self.javascript)
        self.assertIn("end_anchor_id: note.endAnchorId", self.javascript)
        self.assertIn("pitch: note.pitch", self.javascript)
        self.assertIn("velocity: note.velocity", self.javascript)
        self.assertIn("confidence: note.confidence", self.javascript)
        self.assertIn("source: note.source", self.javascript)
        # 项目导入包含 notes 加载与校验
        self.assertIn("const rawNotes = Array.isArray(editing.notes)", self.javascript)
        self.assertIn("音符 ID 重复", self.javascript)
        self.assertIn("引用了不存在的 anchor", self.javascript)
        # 0.1.0 项目迁移时清空 notes
        self.assertIn("0.1.0 项目没有 notes 字段", self.javascript)
        # HTML 中的钢琴卷帘容器与控件
        self.assertIn('id="piano-roll-scroll"', self.html)
        self.assertIn('id="piano-roll-content"', self.html)
        self.assertIn('id="piano-roll-canvas"', self.html)
        self.assertIn('id="piano-roll-grid"', self.html)
        self.assertIn('id="piano-roll-stem-select"', self.html)
        self.assertIn('id="split-note-button"', self.html)
        self.assertIn('id="merge-note-button"', self.html)
        self.assertIn('id="delete-note-button"', self.html)
        # HTML 中的目标 stem 选项
        self.assertIn('<option value="master">伴奏总览</option>', self.html)
        self.assertIn('<option value="drums">鼓组</option>', self.html)
        self.assertIn('<option value="bass">贝斯</option>', self.html)
        self.assertIn('<option value="other">其他乐器</option>', self.html)
        # CSS 中的钢琴卷帘样式
        self.assertIn(".piano-roll-card", self.styles)
        self.assertIn(".piano-roll-header", self.styles)
        self.assertIn(".piano-roll-tools", self.styles)
        self.assertIn(".piano-roll-scroll", self.styles)
        self.assertIn(".piano-roll-content", self.styles)
        self.assertIn("#piano-roll-canvas", self.styles)
        self.assertIn(".piano-roll-grid", self.styles)
        self.assertIn(".piano-roll-note", self.styles)
        self.assertIn(".piano-roll-note.selected", self.styles)
        self.assertIn(".piano-roll-note.merge-candidate", self.styles)
        self.assertIn(".piano-roll-note.preview", self.styles)
        self.assertIn(".piano-roll-note.source-transcription", self.styles)
        self.assertIn(".piano-roll-note.source-generation", self.styles)
        self.assertIn(".piano-roll-playhead", self.styles)
        self.assertIn(".piano-roll-footnote", self.styles)
        # Esc 取消钢琴卷帘拖动/创建；Delete 删除选中音符
        self.assertIn("state.noteDrag.mode === \"create\"", self.javascript)
        self.assertIn("cancelNoteCreate()", self.javascript)
        self.assertIn("cancelNoteDrag()", self.javascript)
        self.assertIn('event.key === "Delete"', self.javascript)
        # 钢琴卷帘事件绑定
        self.assertIn("elements.pianoRollStemSelect.addEventListener", self.javascript)
        self.assertIn("elements.splitNoteButton.addEventListener", self.javascript)
        self.assertIn("elements.mergeNoteButton.addEventListener", self.javascript)
        self.assertIn("elements.quantizeNoteButton.addEventListener", self.javascript)
        self.assertIn("elements.deleteNoteButton.addEventListener", self.javascript)
        self.assertIn("elements.pianoRollGrid.addEventListener", self.javascript)
        # renderAll 调用 renderPianoRoll
        self.assertIn("renderPianoRoll()", self.javascript)
        self.assertIn("updatePianoRollToolButtons()", self.javascript)

    def test_quantize_grid_dotted_and_swing_are_present(self) -> None:
        # P1.2 轮 3：扩展 snap 网格到 1/8 拍 + 三连音
        self.assertIn('value="eighth-beat"', self.html)
        self.assertIn('value="triplet-half"', self.html)
        self.assertIn('value="triplet-quarter"', self.html)
        self.assertIn("1/3 拍（三连音）", self.html)
        self.assertIn("1/6 拍（三连音）", self.html)
        # 附点 checkbox + Swing 滑块
        self.assertIn('id="dotted-snap"', self.html)
        self.assertIn('id="swing-amount"', self.html)
        self.assertIn("dottedSnap", self.javascript)
        self.assertIn("swingAmount", self.javascript)
        self.assertIn("elements.dottedSnap", self.javascript)
        self.assertIn("elements.swingAmount", self.javascript)
        # snap 网格函数支持所有网格
        self.assertIn('case "eighth-beat"', self.javascript)
        self.assertIn('case "triplet-half"', self.javascript)
        self.assertIn('case "triplet-quarter"', self.javascript)
        # 附点 ×1.5
        self.assertIn("interval = interval * 1.5", self.javascript)
        # Swing 偏移函数
        self.assertIn("function swingOffsetForIndex", self.javascript)
        self.assertIn("state.swingAmount * (interval / 2)", self.javascript)
        # snapTime 考虑 swing 候选点
        self.assertIn("swingOffsetForIndex(oddIndex, interval)", self.javascript)
        # 量化函数与按钮
        self.assertIn("function quantizeSample", self.javascript)
        self.assertIn("function quantizeSelectedNote", self.javascript)
        self.assertIn('id="quantize-note-button"', self.html)
        # 项目导出/导入包含 dotted_snap / swing_amount
        self.assertIn("dotted_snap: state.dottedSnap", self.javascript)
        self.assertIn("swing_amount: state.swingAmount", self.javascript)
        self.assertIn("state.dottedSnap = preferences.dotted_snap === true", self.javascript)
        self.assertIn("state.swingAmount = Number.isFinite(swingValue)", self.javascript)
        # 偏好集合包含新网格
        self.assertIn('"eighth-beat", "triplet-half", "triplet-quarter"', self.javascript)
        # 钢琴卷帘 canvas 按 snap 网格绘制（含 swing 浅色）
        self.assertIn("swingOffsetForIndex(i, interval)", self.javascript)
        self.assertIn("isSwung", self.javascript)
        # 量化按钮在工具按钮可用性中
        self.assertIn("elements.quantizeNoteButton.disabled", self.javascript)

    def test_nondestructive_mix_and_preview_toggle_are_present(self) -> None:
        # P1.2 轮 4：非破坏混音参数（trim/fade）+ A/B 试听切换（edited / original）
        # defaultStemTracks 包含 trim/fade 字段
        self.assertIn("trimStartSeconds: 0", self.javascript)
        self.assertIn("trimEndSeconds: 0", self.javascript)
        self.assertIn("fadeInSeconds: 0", self.javascript)
        self.assertIn("fadeOutSeconds: 0", self.javascript)
        # state.stemPreviewMode 默认 edited
        self.assertIn('stemPreviewMode: "edited"', self.javascript)
        # 非破坏参数生效函数
        self.assertIn("function stemEffectiveTrimRange", self.javascript)
        self.assertIn("function stemEffectiveFade", self.javascript)
        self.assertIn("function applyMasterFadeEnvelope", self.javascript)
        self.assertIn("function enforceMasterTrimBoundary", self.javascript)
        # original 模式忽略非破坏参数
        self.assertIn('state.stemPreviewMode === "original"', self.javascript)
        # buildStemRow 渲染 trim/fade 输入控件
        self.assertIn('dataset.stemControl = "trimStartSeconds"', self.javascript)
        self.assertIn('dataset.stemControl = "trimEndSeconds"', self.javascript)
        self.assertIn('dataset.stemControl = "fadeInSeconds"', self.javascript)
        self.assertIn('dataset.stemControl = "fadeOutSeconds"', self.javascript)
        self.assertIn("stem-number-group", self.javascript)
        self.assertIn("stem-number", self.javascript)
        # numberFieldClamps 统一处理所有 number 字段
        self.assertIn("trimStartSeconds: v => Math.max(0, v)", self.javascript)
        self.assertIn("trimEndSeconds: v => Math.max(0, v)", self.javascript)
        self.assertIn("fadeInSeconds: v => Math.max(0, v)", self.javascript)
        self.assertIn("fadeOutSeconds: v => Math.max(0, v)", self.javascript)
        # formatStemFieldValue 处理新字段
        self.assertIn("field === \"trimStartSeconds\"", self.javascript)
        # EditGraph snapshot/restore 包含 stemPreviewMode 与 trim/fade 向前兼容
        self.assertIn("stemPreviewMode: state.stemPreviewMode", self.javascript)
        self.assertIn("state.stemPreviewMode = snapshot.stemPreviewMode", self.javascript)
        self.assertIn("track.trimStartSeconds", self.javascript)
        # HTML 中有 A/B 试听切换控件
        self.assertIn('id="stem-preview-mode"', self.html)
        self.assertIn('<option value="edited" selected>', self.html)
        self.assertIn('<option value="original">', self.html)
        # elements 引用 + 事件绑定
        self.assertIn("stemPreviewMode: byId", self.javascript)
        self.assertIn("elements.stemPreviewMode.addEventListener", self.javascript)
        # 导出包含 trim/fade + stem_preview_mode
        self.assertIn("trim_start_seconds: finiteNumber(track.trimStartSeconds", self.javascript)
        self.assertIn("trim_end_seconds: finiteNumber(track.trimEndSeconds", self.javascript)
        self.assertIn("fade_in_seconds: finiteNumber(track.fadeInSeconds", self.javascript)
        self.assertIn("fade_out_seconds: finiteNumber(track.fadeOutSeconds", self.javascript)
        self.assertIn("stem_preview_mode: state.stemPreviewMode", self.javascript)
        # 导入加载 trim/fade + stem_preview_mode（0.2.0 项目偏好恢复）
        self.assertIn("track.trim_start_seconds", self.javascript)
        self.assertIn("track.trim_end_seconds", self.javascript)
        self.assertIn("track.fade_in_seconds", self.javascript)
        self.assertIn("track.fade_out_seconds", self.javascript)
        self.assertIn("importedPreferences.stem_preview_mode", self.javascript)
        # resetEditingState 重置 stemPreviewMode
        self.assertIn('state.stemPreviewMode = "edited"', self.javascript)
        # 0.1.0 项目迁移时回退到 edited
        self.assertIn("0.1.0 项目没有 stem_preview_mode 字段", self.javascript)
        # togglePlayback 应用 trim start
        self.assertIn("stemEffectiveTrimRange(master)", self.javascript)
        # timeupdate / seeked 事件监听 trim 边界与 fade 包络
        self.assertIn("enforceMasterTrimBoundary()", self.javascript)
        self.assertIn("applyMasterFadeEnvelope()", self.javascript)
        # CSS 样式
        self.assertIn(".stem-number-group", self.styles)
        self.assertIn(".stem-number", self.styles)
        self.assertIn(".stem-preview-toolbar", self.styles)
        self.assertIn(".stem-preview-hint", self.styles)
        # 不使用 innerHTML（与既有规则一致）
        self.assertNotIn("innerHTML", self.javascript)

    # ---- P2：读音纠正 / 歌词切分 / 试听合成（10 项）--------------------------

    def test_project_schema_upgraded_to_0_3_0(self) -> None:
        # P2：0.3.0 在 0.2.0 基础上引入 syllables + vocalPreview。
        # 0.2.0 与 0.1.0 项目都必须仍能迁移导入。
        self.assertIn('PROJECT_SCHEMA = "miku-workbench-project/0.3.0"', self.javascript)
        self.assertIn('PROJECT_SCHEMA_LEGACY = "miku-workbench-project/0.1.0"', self.javascript)
        self.assertIn('PROJECT_SCHEMA_LEGACY_020 = "miku-workbench-project/0.2.0"', self.javascript)
        # importProject 必须显式接受三个版本，否则拒绝。
        self.assertIn("candidate.schema_version !== PROJECT_SCHEMA_LEGACY_020", self.javascript)
        # 状态注释中必须说明 0.2.0 与 0.1.0 的迁移策略
        self.assertIn("0.2.0 项目导入时为已有歌词区域派生默认 syllables", self.javascript)
        self.assertIn("0.1.0 项目仍可通过 migrateLegacyProject 迁移到 0.3.0", self.javascript)

    def test_syllable_data_model_present(self) -> None:
        # state.syllables / nextSyllableId / selectedSyllableId 数据字段
        self.assertIn("syllables: []", self.javascript)
        self.assertIn("nextSyllableId: 1", self.javascript)
        self.assertIn("selectedSyllableId: null", self.javascript)
        # vocalPreview 状态：active / oscillators / scheduleIds / startAt
        self.assertIn("vocalPreview: { active: false", self.javascript)
        self.assertIn("oscillators: []", self.javascript)
        self.assertIn("scheduleIds: []", self.javascript)
        # vocalPreviewTimbre 默认参数（waveform/gain/attack/release）
        self.assertIn("vocalPreviewTimbre: { waveform: \"sine\"", self.javascript)
        self.assertIn("gain: 0.15", self.javascript)
        self.assertIn("attack: 0.02", self.javascript)
        self.assertIn("release: 0.08", self.javascript)
        # 0.1.0 项目迁移时清空 syllables（派生留到歌词区域建立后）
        self.assertIn("0.1.0 项目没有 syllables 字段", self.javascript)
        # resetEditingState 重置 syllables / nextSyllableId / selectedSyllableId / vocalPreview
        self.assertIn("state.syllables = []", self.javascript)
        self.assertIn("state.nextSyllableId = 1", self.javascript)

    def test_pinyin_table_covers_common_chars(self) -> None:
        # PINYIN_TABLE 必须存在并覆盖常用汉字
        self.assertIn("const PINYIN_TABLE = {", self.javascript)
        # 任务规范要求的 5 个对照
        self.assertIn('"你": "ni"', self.javascript)
        self.assertIn('"好": "hao"', self.javascript)
        self.assertIn('"我": "wo"', self.javascript)
        self.assertIn('"是": "shi"', self.javascript)
        self.assertIn('"在": "zai"', self.javascript)
        # 读音查表失败时回退到空字符串（UI 提示"未识别"）
        self.assertIn('Object.prototype.hasOwnProperty.call(PINYIN_TABLE, char)', self.javascript)

    def test_kana_romaji_table_covers_basic_syllables(self) -> None:
        # KANA_ROMAJI_TABLE 必须存在并覆盖清音/浊音/拗音/促音/拨音/片假名
        self.assertIn("const KANA_ROMAJI_TABLE = {", self.javascript)
        # 任务规范要求的 5 个对照
        self.assertIn('"あ": "a"', self.javascript)
        self.assertIn('"か": "ka"', self.javascript)
        self.assertIn('"き": "ki"', self.javascript)
        self.assertIn('"きゃ": "kya"', self.javascript)
        self.assertIn('"ん": "n"', self.javascript)
        # 促音「っ」单独成 syllable（defaultReading = "cl"）
        self.assertIn('"っ": "cl"', self.javascript)
        # 拗音末尾集合：用于 splitJapaneseLyric 判断合并
        self.assertIn('KANA_YOON_SUFFIXES = new Set(["ゃ", "ゅ", "ょ", "ャ", "ュ", "ョ"])', self.javascript)
        # 片假名同表
        self.assertIn('"ア": "a"', self.javascript)
        self.assertIn('"ッ": "cl"', self.javascript)

    def test_pinyin_table_expanded_to_500_plus(self) -> None:
        # PINYIN_TABLE 必须扩展到 500+ 字（覆盖现代汉语一级常用字中歌词高频字）
        match = re.search(r"const PINYIN_TABLE = \{(.*?)\};", self.javascript, re.DOTALL)
        self.assertIsNotNone(match, "PINYIN_TABLE 块未找到")
        block = match.group(1)
        pairs = re.findall(r'"([^"]+)":\s*"([^"]+)"', block)
        self.assertGreaterEqual(len(pairs), 500,
                                f"PINYIN_TABLE 仅 {len(pairs)} 字，要求 >= 500")

    def test_pinyin_table_covers_extended_emotion_chars(self) -> None:
        # 抒情与意境组扩展字（愁/苦/痛/悲/喜/乐/欢/美/丽/真）
        for char, pinyin in [
            ("愁", "chou"), ("苦", "ku"), ("痛", "tong"), ("悲", "bei"),
            ("喜", "xi"), ("乐", "le"), ("欢", "huan"),
            ("美", "mei"), ("丽", "li"), ("真", "zhen"),
        ]:
            self.assertIn(f'"{char}": "{pinyin}"', self.javascript,
                          f"缺失扩展情感字 {char} -> {pinyin}")

    def test_pinyin_table_covers_extended_nature_chars(self) -> None:
        # 自然与景物组扩展字（山/河/海/湖/云/雾/雷/电）
        for char, pinyin in [
            ("山", "shan"), ("河", "he"), ("海", "hai"), ("湖", "hu"),
            ("云", "yun"), ("雾", "wu"), ("雷", "lei"), ("电", "dian"),
        ]:
            self.assertIn(f'"{char}": "{pinyin}"', self.javascript,
                          f"缺失扩展自然字 {char} -> {pinyin}")

    def test_pinyin_table_covers_extended_action_chars(self) -> None:
        # 动作与状态组扩展字（说/唱/哭/笑/飞/舞/抱/牵）
        for char, pinyin in [
            ("说", "shuo"), ("唱", "chang"), ("哭", "ku"), ("笑", "xiao"),
            ("飞", "fei"), ("舞", "wu"), ("抱", "bao"), ("牵", "qian"),
        ]:
            self.assertIn(f'"{char}": "{pinyin}"', self.javascript,
                          f"缺失扩展动作字 {char} -> {pinyin}")

    def test_kana_romaji_table_covers_voiced_syllables(self) -> None:
        # 浊音 / 半浊音行首（が/ざ/だ/ば/ぱ）
        for kana, romaji in [
            ("が", "ga"), ("ざ", "za"), ("だ", "da"), ("ば", "ba"), ("ぱ", "pa"),
        ]:
            self.assertIn(f'"{kana}": "{romaji}"', self.javascript,
                          f"缺失浊音/半浊音 {kana} -> {romaji}")

    def test_kana_romaji_table_covers_small_kana(self) -> None:
        # 小写假名（ぁぃぅぇぉ）单独映射为单元音
        for kana, romaji in [
            ("ぁ", "a"), ("ぃ", "i"), ("ぅ", "u"), ("ぇ", "e"), ("ぉ", "o"),
        ]:
            self.assertIn(f'"{kana}": "{romaji}"', self.javascript,
                          f"缺失小写假名 {kana} -> {romaji}")

    def test_pinyin_table_no_tone_numbers(self) -> None:
        # 所有拼音 value 不得包含数字 0-9（去声调，只保留拼音字母）
        match = re.search(r"const PINYIN_TABLE = \{(.*?)\};", self.javascript, re.DOTALL)
        self.assertIsNotNone(match, "PINYIN_TABLE 块未找到")
        block = match.group(1)
        pairs = re.findall(r'"([^"]+)":\s*"([^"]+)"', block)
        self.assertGreaterEqual(len(pairs), 500)
        for char, pinyin in pairs:
            self.assertNotRegex(pinyin, r"[0-9]",
                                f"拼音含声调数字: {char} -> {pinyin}")

    def test_syllable_split_functions_present(self) -> None:
        # 三个核心切分函数
        self.assertIn("function splitLyricToSyllables", self.javascript)
        self.assertIn("function splitChineseLyric", self.javascript)
        self.assertIn("function splitJapaneseLyric", self.javascript)
        # isLyricTextChar 过滤标点/空白/CJK 标点
        self.assertIn("function isLyricTextChar", self.javascript)
        # allocateSyllableAnchors：在 LyricRegion 区间内等分 anchor
        self.assertIn("function allocateSyllableAnchors", self.javascript)
        # resplitSyllablesForRegion：重新切分单个 region
        self.assertIn("function resplitSyllablesForRegion", self.javascript)
        # deriveDefaultSyllablesForAllLyrics：0.2.0 → 0.3.0 迁移用
        self.assertIn("function deriveDefaultSyllablesForAllLyrics", self.javascript)
        # 中文按字切分；日文按假名音节切分（语言分支）
        self.assertIn('region.language === "zh"', self.javascript)
        self.assertIn('region.language === "ja"', self.javascript)
        # 拗音合并：当前假名 + 下一假名（ゃ/ゅ/ょ）合并
        self.assertIn("KANA_YOON_SUFFIXES.has(next)", self.javascript)
        # 长音「ー」不单独成 syllable
        self.assertIn('char === "ー"', self.javascript)
        # syllable id 生成器
        self.assertIn("`syllable-${state.nextSyllableId++}`", self.javascript)

    def test_syllable_import_export_roundtrip(self) -> None:
        # 导出 JSON 字段：id / lyric_id / index / text / default_reading / reading_override /
        #               start_anchor_id / end_anchor_id
        self.assertIn("syllables: state.syllables.map(syllable => ({", self.javascript)
        self.assertIn("lyric_id: syllable.lyricId", self.javascript)
        self.assertIn("index: syllable.index", self.javascript)
        self.assertIn("text: syllable.text", self.javascript)
        self.assertIn("default_reading: syllable.defaultReading", self.javascript)
        self.assertIn("reading_override: syllable.readingOverride || \"\"", self.javascript)
        self.assertIn("start_anchor_id: syllable.startAnchorId", self.javascript)
        self.assertIn("end_anchor_id: syllable.endAnchorId", self.javascript)
        # 导入校验：ID 重复 / 引用不存在的歌词区域 / 引用不存在的 anchor
        self.assertIn("音节 ID 重复", self.javascript)
        self.assertIn("引用了不存在的歌词区域", self.javascript)
        self.assertIn("引用了不存在的 anchor", self.javascript)
        # 导入字段加载
        self.assertIn("lyricId,", self.javascript)
        self.assertIn("defaultReading:", self.javascript)
        self.assertIn("readingOverride:", self.javascript)
        # 0.2.0 项目自动迁移：rawSyllables 为空但 lyrics 存在时派生默认 syllables
        self.assertIn("!rawSyllables.length && state.lyrics.length", self.javascript)
        self.assertIn("deriveDefaultSyllablesForAllLyrics()", self.javascript)
        # 0.1.0 项目迁移：migrateLegacyProject 内为已建立的歌词区域派生默认 syllables
        self.assertIn("0.1.0 → 0.3.0 迁移时为已建立的歌词区域派生默认 syllables", self.javascript)
        # pruneAnchors 必须把 syllable 引用的 anchor 视为"被引用"
        self.assertIn("syllable.startAnchorId", self.javascript)
        self.assertIn("syllable.endAnchorId", self.javascript)

    def test_vocal_preview_uses_oscillator_node(self) -> None:
        # Web Audio API：createOscillator + createGain + connect + start + stop
        self.assertIn("ctx.createOscillator()", self.javascript)
        self.assertIn("ctx.createGain()", self.javascript)
        self.assertIn("osc.connect(gain)", self.javascript)
        self.assertIn("gain.connect(ctx.destination)", self.javascript)
        self.assertIn("osc.start(startCtxTime)", self.javascript)
        self.assertIn("osc.stop(releaseEnd + 0.01)", self.javascript)
        # 包络：linearRampToValueAtTime 构造 attack + release
        self.assertIn("gain.gain.setValueAtTime(0, startCtxTime)", self.javascript)
        self.assertIn("gain.gain.linearRampToValueAtTime(timbre.gain, startCtxTime + attack)", self.javascript)
        self.assertIn("gain.gain.linearRampToValueAtTime(0, releaseEnd)", self.javascript)
        # osc.onended 自动清理（非破坏：试听结束自动复位）
        self.assertIn("osc.onended =", self.javascript)
        # 音高 → 频率（A4=440Hz）
        self.assertIn("function midiToFrequency", self.javascript)
        self.assertIn("440 * Math.pow(2, (midi - 69) / 12)", self.javascript)
        # 试听函数
        self.assertIn("function ensureAudioContextForPreview", self.javascript)
        self.assertIn("function startVocalPreview", self.javascript)
        self.assertIn("function stopVocalPreview", self.javascript)
        # 试听状态在 stopVocalPreview 中清空
        self.assertIn("state.vocalPreview.active = false", self.javascript)
        # 四种基础波形必须在 <select> 中可选
        self.assertIn('<option value="sine">正弦</option>', self.html)
        self.assertIn('<option value="triangle">三角</option>', self.html)
        self.assertIn('<option value="square">方波</option>', self.html)
        self.assertIn('<option value="sawtooth">锯齿</option>', self.html)
        # waveform 切换实时更新 vocalPreviewTimbre
        self.assertIn('state.vocalPreviewTimbre.waveform = value', self.javascript)
        # 试听开始/停止按钮在 HTML 中
        self.assertIn('id="vocal-preview-button"', self.html)
        self.assertIn('id="stop-vocal-preview-button"', self.html)
        # 事件绑定
        self.assertIn("elements.vocalPreviewButton.addEventListener", self.javascript)
        self.assertIn("elements.stopVocalPreviewButton.addEventListener", self.javascript)
        self.assertIn("elements.vocalTimbreWaveform.addEventListener", self.javascript)

    def test_syllable_ui_elements_present(self) -> None:
        # syllable-inspector section + 子元素 ID
        self.assertIn('id="syllable-inspector"', self.html)
        self.assertIn('id="syllable-detail"', self.html)
        self.assertIn('id="syllable-list"', self.html)
        self.assertIn('id="resplit-syllables-button"', self.html)
        self.assertIn('id="vocal-timbre-waveform"', self.html)
        # 重新切分按钮
        self.assertIn("elements.resplitSyllablesButton.addEventListener", self.javascript)
        self.assertIn("editGraph.begin(`重新切分 ${region.id}`)", self.javascript)
        # elements 引用
        self.assertIn('syllableInspector: byId("syllable-inspector")', self.javascript)
        self.assertIn('syllableList: byId("syllable-list")', self.javascript)
        self.assertIn('syllableDetail: byId("syllable-detail")', self.javascript)
        # 渲染函数
        self.assertIn("function renderSyllableInspector", self.javascript)
        self.assertIn("function selectLyricForSyllableEdit", self.javascript)
        self.assertIn("function selectSyllable", self.javascript)
        self.assertIn("function updateSyllableReading", self.javascript)
        # syllable 行用 dataset.syllableId 标识（无 innerHTML）
        self.assertIn('row.dataset.syllableId = syllable.id', self.javascript)
        self.assertIn('data-syllable-field="readingOverride"', self.javascript)
        # 读音输入 change 事件 + 行点击选中事件
        self.assertIn("elements.syllableList.addEventListener", self.javascript)
        self.assertIn('input[data-syllable-field="readingOverride"]', self.javascript)
        # 试听高亮 CSS class
        self.assertIn(".syllable-row.preview-active", self.styles)
        self.assertIn(".syllable-list", self.styles)
        self.assertIn(".syllable-row", self.styles)
        self.assertIn(".syllable-reading", self.styles)
        self.assertIn(".vocal-preview-toolbar", self.styles)
        # 选中歌词区域时显示 syllable inspector
        self.assertIn("elements.syllableInspector.hidden = false", self.javascript)

    def test_syllable_lock_toggle_present(self) -> None:
        # HTML：lock-syllable-checkbox + lock-syllable-wrapper
        self.assertIn('id="lock-syllable-checkbox"', self.html)
        self.assertIn('id="lock-syllable-wrapper"', self.html)
        # elements 引用
        self.assertIn('lockSyllableWrapper: byId("lock-syllable-wrapper")', self.javascript)
        self.assertIn('lockSyllableCheckbox: byId("lock-syllable-checkbox")', self.javascript)
        # 锁定 toggle 事件：进入 editGraph undo/redo 栈
        self.assertIn("elements.lockSyllableCheckbox.addEventListener", self.javascript)
        self.assertIn('editGraph.begin(`锁定读音 ${id}`)', self.javascript)
        self.assertIn('setLocked("syllable", id, elements.lockSyllableCheckbox.checked)', self.javascript)
        # 重新切分时保留锁定的 readingOverride（按 index 匹配）
        self.assertIn("isLocked(\"syllable\", s.id)", self.javascript)
        self.assertIn("lockedOverrides.set(s.index", self.javascript)
        # 0.2.0 项目没有 syllables 字段的注释（用于迁移）
        self.assertIn("0.2.0 项目没有 syllables 字段", self.javascript)
        # 导入时 syllable 锁定项在 syllables 加载后补全
        self.assertIn("type === \"syllable\" && validSyllableIds.has(id)", self.javascript)
        # refreshLockToggle 复用于 syllable
        self.assertIn('refreshLockToggle(elements.lockSyllableWrapper, elements.lockSyllableCheckbox, "syllable"', self.javascript)
        # resetEditingState 隐藏 lock wrapper
        self.assertIn("elements.lockSyllableWrapper.hidden = true", self.javascript)

    def test_syllable_undo_redo_snapshot_included(self) -> None:
        # EditGraph snapshot 必须包含 syllables + nextSyllableId
        self.assertIn("syllables: state.syllables.map(syllable => ({ ...syllable }))", self.javascript)
        self.assertIn("nextSyllableId: state.nextSyllableId", self.javascript)
        # restore 恢复 syllables + nextSyllableId（向前兼容：缺失时回退到空数组）
        self.assertIn("state.syllables = Array.isArray(snapshot.syllables) ? snapshot.syllables.map(syllable => ({ ...syllable })) : []", self.javascript)
        self.assertIn("state.nextSyllableId = Number.isFinite(snapshot.nextSyllableId) ? snapshot.nextSyllableId : 1", self.javascript)
        # 读音修改、重新切分、锁定 toggle 三种操作必须记录 undo 点
        self.assertIn('editGraph.begin(`修改读音 ${syllableId}`)', self.javascript)
        self.assertIn("editGraph.begin(`重新切分 ${region.id}`)", self.javascript)
        self.assertIn("editGraph.begin(`锁定读音 ${id}`)", self.javascript)
        # 删除歌词时一并删除其 syllable（撤销时一并恢复）
        self.assertIn("state.syllables.filter(s => s.lyricId !== state.selectedLyricId)", self.javascript)
        # 删除歌词时同步清除 syllable 锁定
        # （实现中通过 setLocked("syllable", id, false) 在 resplitSyllablesForRegion 内完成）



if __name__ == "__main__":
    unittest.main()
