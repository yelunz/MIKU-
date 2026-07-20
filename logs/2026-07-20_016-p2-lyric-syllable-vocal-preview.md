# 2026-07-20 / 016 / P2 轮 1：读音纠正层 + 歌词切分到音符 + 基础试听合成

## 本轮目标

按 `docs/ROADMAP.md` 中 P2 阶段"歌词与歌声垂直切片"的第一项能力切片，落地三件事：

1. **读音纠正层**：中文常用字拼音表（首批 80 字，去声调）+ 日文假名罗马音表（46 清音 + 浊音/半浊音/拗音/促音/拨音/片假名同表）；用户可在 inspector 中覆盖每个音节的默认读音。
2. **歌词切分到音符**：中文按字切分（一汉字 = 一 syllable），日文按假名音节切分（拗音合并、促音单独、拨音单独、长音延续前一个）；每个 syllable 引用 LyricRegion 的 start/end anchor 并在区间内等分。
3. **基础试听合成**：用 Web Audio API `OscillatorNode` + `GainNode` 包络（attack 0.02s / sustain / release 0.08s / gain 0.15），按用户选中的 LyricRegion 时间范围内重叠的 NoteEvent 调度临时音符；非破坏——不修改任何持久化数据，停止试听时全部 OscillatorNode 自动 stop + disconnect。

本轮同时把项目 schema 从 0.2.0 升级到 0.3.0，并为 0.2.0 与 0.1.0 项目保留自动迁移路径（导入时派生默认 syllables）。

## 用户确认的要求

- 用户最新要求：实现 P2 阶段代码；不执行 `git commit` / `git push`，由主 Agent 处理提交。
- AGENTS.md 已规定"首版歌词支持中文和日文，英文明确不在当前范围内"——本轮 PINYIN_TABLE / KANA_ROMAJI_TABLE 严格遵循 zh/ja 两种语言。
- AGENTS.md 已规定"不得把'面向小白'理解为隐藏或删除专业数据"——读音纠正层既给默认读音也允许覆盖，未识别字会显式提示。
- 用户规范：禁止 `innerHTML`，所有 UI 用 `createElement` + `textContent` + `dataset`。
- 用户规范：读音编辑、重新切分、锁定 toggle 必须进入 `editGraph` 撤销/重做栈。
- 用户规范：syllable 锁定 lockKey 格式 `syllable:syllable-1`，与 lyric/rest/chord 锁定同构。
- 用户规范：0.2.0 项目必须能自动迁移到 0.3.0（为已有歌词区域派生默认 syllables）。
- 用户规范：第一版试听只支持 OscillatorNode 四种基础波形（sine / triangle / square / sawtooth）。

## 子 Agent 分工

本轮为单一耦合实现（syllable 数据模型、读音表、切分函数、anchor 分配、UI 渲染、试听合成、事件绑定、EditGraph 快照、项目持久化、schema 迁移全部共享 state 与 renderAll），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主实现 Agent 完成。

## 执行内容

### 项目 schema 升级 0.2.0 → 0.3.0

- `PROJECT_SCHEMA = "miku-workbench-project/0.3.0"`
- `PROJECT_SCHEMA_LEGACY_020 = "miku-workbench-project/0.2.0"`（与既有 `PROJECT_SCHEMA_LEGACY = "miku-workbench-project/0.1.0"` 并列）
- `importProject(candidate)` 显式接受三个版本：0.3.0（直接加载）、0.2.0（加载后派生 syllables）、0.1.0（深度迁移 + 派生 syllables）；其他版本抛错"不支持的项目版本"。
- 迁移提示文案：
  - 0.1.0：`已导入 0.1.0 项目并迁移到 0.3.0 共享 anchor + syllable 模型；请重新选择本地 WAV 才能播放。`
  - 0.2.0：`已导入 0.2.0 项目并迁移到 0.3.0；已为歌词区域派生默认音节切分，请重新选择本地 WAV 才能播放。`

### Syllable 数据模型

`state` 新增字段：

- `syllables: []` — 当前项目的全部音节
- `nextSyllableId: 1` — 音节 ID 自增计数器
- `selectedSyllableId: null` — inspector 中选中的音节
- `vocalPreview: { active: false, oscillators: [], startAt: 0, scheduleIds: [], activeSyllableId: null }` — 试听状态
- `vocalPreviewTimbre: { waveform: "sine", gain: 0.15, attack: 0.02, release: 0.08 }` — 试听音色（不持久化）

单个 syllable 字段（持久化 + 内存同构）：

- `id`（`syllable-<n>`）
- `lyricId`（所属 LyricRegion）
- `index`（在该 LyricRegion 内的序号，从 0 起）
- `text`（单字 / 单假名 / 拗音合并后的两字符）
- `defaultReading`（查表结果，未识别时为 `""`）
- `readingOverride`（用户覆盖；空字符串 = 用默认读音）
- `startAnchorId` / `endAnchorId`（与 LyricRegion 共享 anchor 表）

### 读音表

- `PINYIN_TABLE`：80 个常用汉字 → 拼音（去声调）。覆盖示例歌词常用字（你/好/我/是/在/...）；查不到的字 `defaultReading = ""`，UI 在读音纠正行显示"未识别"。
- `KANA_ROMAJI_TABLE`：完整覆盖
  - 平假名清音 46 字
  - 浊音 / 半浊音 25 字
  - 拗音 36 字（きゃ..ぴょ）
  - 促音「っ」`"cl"`（USTX 惯例）
  - 拨音「ん」`"n"`
  - 片假名同表（ア..ッ）
- `KANA_YOON_SUFFIXES = new Set(["ゃ", "ゅ", "ょ", "ャ", "ュ", "ョ"])` — 拗音末尾集合，`splitJapaneseLyric` 用它判断"当前假名 + 下一假名"能否合并为拗音。

### 切分函数

- `isLyricTextChar(char)` — 过滤空白控制字符 / CJK 标点 / 中点 / 全角逗号 / 、。 / ！？ / ：；
- `splitLyricToSyllables(region)` — 语言分支入口
- `splitChineseLyric(region)` — 每个汉字 = 一个 syllable，`defaultReading` 查 `PINYIN_TABLE`
- `splitJapaneseLyric(region)` — 按假名音节切分：
  - 拗音（き+ゃ → きゃ）合并为一个 syllable
  - 促音「っ」单独成 syllable，`defaultReading = "cl"`
  - 拨音「ん」单独成 syllable，`defaultReading = "n"`
  - 长音「ー」不单独成 syllable（前一个 syllable 的时长通过 anchor 分配自然延续）
- `allocateSyllableAnchors(region, rawSyllables)` — 在 `[startAnchorId, endAnchorId]` 区间内等分（`startFrac = i / count`，`endFrac = (i+1) / count`）；首尾复用 region 的 anchor，中间分点用 `findAnchorBySample` 或 `createAnchorAtSample`。
- `resplitSyllablesForRegion(region)` — 重新切分单个 region；锁定的旧 syllable 按 `index` 保留 `readingOverride`，新切分后按 index 恢复并恢复锁定状态。
- `deriveDefaultSyllablesForAllLyrics()` — 0.2.0 → 0.3.0 迁移与 0.1.0 → 0.3.0 迁移共用：清空 syllables + nextSyllableId 后为所有 LyricRegion 派生默认 syllables。

### Inspector UI

`index.html` 在"选区与歌词"section 后新增 `<section id="syllable-inspector">`：

- `<h3>读音与切分</h3>`
- `<p id="syllable-detail">` — 显示 region id / 语言 / 起止秒数 / 音节数
- `<div id="syllable-list" role="list">` — 容器，JS 渲染 `.syllable-row`
- `.vocal-preview-toolbar`（div.button-row）：
  - `<button id="resplit-syllables-button">重新切分</button>`
  - `<button id="vocal-preview-button">试听歌声草案</button>`
  - `<button id="stop-vocal-preview-button" hidden>停止试听</button>`
  - `<label class="compact-control">音色 <select id="vocal-timbre-waveform">`（sine/triangle/square/sawtooth 四种波形）
- `<label id="lock-syllable-wrapper" hidden class="inline-check lock-toggle"><input id="lock-syllable-checkbox" type="checkbox"> 锁定读音（防止重生成覆盖）</label>`

`renderSyllableInspector(region)` 为每个 syllable 创建 `.syllable-row`：

- `.syllable-index`（序号）
- `.syllable-text`（字 / 假名）
- `<input class="syllable-reading" data-syllable-field="readingOverride" data-syllable-id="...">`（读音输入）
- `.syllable-warn`（未识别字提示）
- 试听激活时，当前发声的 syllable 行加 `preview-active` 高亮 class。

### 试听合成（OscillatorNode）

- `ensureAudioContextForPreview()` — 复用 `audioGraph.context`（不依赖 audio 元素；不调用 `createMediaElementSource`）。
- `midiToFrequency(midi)` — A4 (69) = 440 Hz；`440 * Math.pow(2, (midi - 69) / 12)`。
- `startVocalPreview()`：
  1. 确定目标 LyricRegion（优先选中，否则第一个）。
  2. 若该 region 没有 syllable，先 `resplitSyllablesForRegion` 派生。
  3. 收集与 LyricRegion 时间范围重叠的 NoteEvent（按 `pianoRollStemId` 过滤；master stem 包含所有）。
  4. 为每个 NoteEvent 调度 `setTimeout`，在 `offset * 1000` ms 后创建 `OscillatorNode` + `GainNode`：
     - `osc.type = timbre.waveform`
     - `osc.frequency.value = midiToFrequency(note.pitch)`
     - `gain.gain` 包络：`setValueAtTime(0, startCtxTime)` → `linearRampToValueAtTime(timbre.gain, startCtxTime + attack)` → `setValueAtTime(timbre.gain, sustainEnd)` → `linearRampToValueAtTime(0, releaseEnd)`
     - `osc.start(startCtxTime)` + `osc.stop(releaseEnd + 0.01)`
     - `osc.onended` 自动从 `oscillators` 数组移除；全部播放完毕后调用 `stopVocalPreview` 复位 UI。
  5. 高亮当前发声的 syllable 行（`state.vocalPreview.activeSyllableId`）。
- `stopVocalPreview()`：
  - 清除所有未触发的 `setTimeout` 句柄（`scheduleIds.forEach(id => clearTimeout(id))`）
  - 停止所有正在发声的 OscillatorNode（`osc.stop()` + `osc.disconnect()`，try/catch 容错）
  - `state.vocalPreview.active = false`、`activeSyllableId = null`
  - 切换按钮可见性 + 清除高亮

### 事件绑定

- `vocalPreviewButton` click：激活/停止试听（已激活时点击 = 停止）
- `stopVocalPreviewButton` click：停止试听
- `vocalTimbreWaveform` change：实时更新 `vocalPreviewTimbre.waveform`（不进 undo，临时参数）
- `resplitSyllablesButton` click：`editGraph.begin("重新切分 ${region.id}")` + `resplitSyllablesForRegion` + 重渲染
- `syllableList` change（事件委托）：识别 `input[data-syllable-field="readingOverride"]` → `editGraph.begin("修改读音 ${syllableId}")` + 写入 `readingOverride`
- `syllableList` click（事件委托）：识别 `[data-syllable-id]` 行 → 选中 syllable
- `lockSyllableCheckbox` change：`editGraph.begin("锁定读音 ${id}")` + `setLocked("syllable", id, checked)`

### EditGraph 撤销/重做与字段级锁定

- `editGraph.snapshot()` 新增：
  - `syllables: state.syllables.map(syllable => ({ ...syllable }))`
  - `nextSyllableId: state.nextSyllableId`
- `editGraph.restore(snapshot)` 新增：
  - `state.syllables = Array.isArray(snapshot.syllables) ? snapshot.syllables.map(syllable => ({ ...syllable })) : []`
  - `state.nextSyllableId = Number.isFinite(snapshot.nextSyllableId) ? snapshot.nextSyllableId : 1`
- `pruneAnchors()` 把 syllable 引用的 anchor 视为"被引用"，避免被裁剪。
- `setLocked("syllable", id, bool)` 与既有 lyric/rest/chord 锁定同构；lockKey 格式 `syllable:syllable-1`。
- `refreshLockToggle(elements.lockSyllableWrapper, elements.lockSyllableCheckbox, "syllable", id)` 复用既有 lock toggle 工具函数。
- 导入项目时：`rawLocked` 中 `syllable:` 前缀项在 syllables 加载完毕后补全校验（指向已删除 syllable 的锁定项静默丢弃）。
- `resplitSyllablesForRegion` 在切分前收集锁定的 `readingOverride`（按 index），切分后按 index 恢复并恢复锁定状态——锁定的读音不会被重新切分覆盖。

### 项目持久化

`exportProject()` 的 `editing.syllables` 数组：

```javascript
syllables: state.syllables.map(syllable => ({
  id: syllable.id,
  lyric_id: syllable.lyricId,
  index: syllable.index,
  text: syllable.text,
  default_reading: syllable.defaultReading,
  reading_override: syllable.readingOverride || "",
  start_anchor_id: syllable.startAnchorId,
  end_anchor_id: syllable.endAnchorId,
}))
```

`importAnchorsAndRegions(project, analysis)` 加载 syllables：

- 校验 ID 唯一（`音节 ID 重复：${id}`）
- 校验 `lyric_id` 指向当前项目中存在的歌词区域（`音节 ${id} 引用了不存在的歌词区域`）
- 校验 `start_anchor_id` / `end_anchor_id` 指向当前项目中存在的 anchor（`音节 ${id} 引用了不存在的 anchor`）
- `index` clamp 到 0..1024；`reading_override` 必须是字符串
- 加载完成后补全 syllable 锁定项校验（基于 `validSyllableIds`）
- **0.2.0 项目自动迁移**：`!rawSyllables.length && state.lyrics.length` 时调用 `deriveDefaultSyllablesForAllLyrics()`（不记 undo，是导入的一部分）

`migrateLegacyProject(project, analysis)`：

- 重置 `state.syllables = []` / `state.nextSyllableId = 1` / `state.selectedSyllableId = null`（0.1.0 项目没有 syllables 字段；迁移时清空，待歌词区域建立后再派生）
- 在歌词区域迁移完成后，`if (state.lyrics.length) deriveDefaultSyllablesForAllLyrics()`（0.1.0 → 0.3.0 迁移时为已建立的歌词区域派生默认 syllables）

### resetEditingState 复位

`resetEditingState()` 新增：

- `state.syllables = []`
- `state.nextSyllableId = 1`
- `state.selectedSyllableId = null`
- `state.vocalPreview = { active: false, oscillators: [], startAt: 0, scheduleIds: [], activeSyllableId: null }`
- 隐藏 `syllableInspector` / `lockSyllableWrapper` / `stopVocalPreviewButton`

### CSS 样式

新增最小集合（不破坏既有样式）：

- `.syllable-list` — grid 容器
- `.syllable-row` — flex 行（`display: flex; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border)`）
- `.syllable-row:last-child` — 去掉最后一条 border-bottom
- `.syllable-index` — 序号（min-width 1.6rem，muted，等宽字体）
- `.syllable-text` — 字/假名（min-width 2.4rem，surface-soft 背景，加粗）
- `.syllable-reading` — 读音输入框（width 80px，等宽字体）
- `.syllable-warn` — 未识别字提示（warning-text 色）
- `.syllable-row.preview-active` — 试听高亮（`background: rgba(255, 200, 100, 0.2)`）
- `.vocal-preview-toolbar` — 试听工具栏（虚线边 + 淡色背景，区别于 stem 行的实线边）
- `.vocal-preview-toolbar .compact-control select` — min-width 5rem

## 修改文件

- `prototype/web-workbench/app.js`：
  - schema 常量（PROJECT_SCHEMA / PROJECT_SCHEMA_LEGACY_020）
  - state 新增 syllables / nextSyllableId / selectedSyllableId / vocalPreview / vocalPreviewTimbre
  - PINYIN_TABLE / KANA_ROMAJI_TABLE / KANA_YOON_SUFFIXES
  - editGraph.snapshot/restore 包含 syllables
  - pruneAnchors 把 syllable 引用的 anchor 视为被引用
  - 函数：isLyricTextChar / splitLyricToSyllables / splitChineseLyric / splitJapaneseLyric / allocateSyllableAnchors / resplitSyllablesForRegion / deriveDefaultSyllablesForAllLyrics / selectLyricForSyllableEdit / renderSyllableInspector / updateSyllableReading / selectSyllable / ensureAudioContextForPreview / midiToFrequency / startVocalPreview / stopVocalPreview
  - exportProject 新增 syllables 数组
  - importAnchorsAndRegions 加载 syllables + 0.2.0 自动迁移
  - migrateLegacyProject 重置 syllables + 派生默认 syllables
  - importProject 显式接受 0.3.0 / 0.2.0 / 0.1.0 三版本
  - resetEditingState 重置 syllables / vocalPreview / UI 可见性
  - saveLyricRegion / deleteLyric / editLyric / endLyricEdit / hideLyricEditor 集成 syllable inspector 显示/隐藏
  - 事件绑定：vocalPreviewButton / stopVocalPreviewButton / vocalTimbreWaveform / resplitSyllablesButton / syllableList(change+click) / lockSyllableCheckbox
  - elements 引用：syllableInspector / syllableDetail / syllableList / resplitSyllablesButton / vocalPreviewButton / stopVocalPreviewButton / vocalTimbreWaveform / lockSyllableWrapper / lockSyllableCheckbox
- `prototype/web-workbench/index.html`：在"选区与歌词"section 后新增 `<section id="syllable-inspector">`（含 syllable-detail / syllable-list / vocal-preview-toolbar / lock-syllable-wrapper）
- `prototype/web-workbench/styles.css`：新增 .syllable-list / .syllable-row / .syllable-row:last-child / .syllable-index / .syllable-text / .syllable-reading / .syllable-warn / .syllable-row.preview-active / .vocal-preview-toolbar / .vocal-preview-toolbar .compact-control / .vocal-preview-toolbar .compact-control select
- `tests/test_web_workbench_static.py`：
  - 更新 `test_project_and_analysis_versions_are_explicit`：检查 0.3.0 schema + 0.2.0 LEGACY 标记
  - 更新 `test_legacy_project_migration_is_present`：检查 0.1.0/0.2.0 → 0.3.0 迁移文案
  - 新增 10 项 P2 测试：
    1. `test_project_schema_upgraded_to_0_3_0`
    2. `test_syllable_data_model_present`
    3. `test_pinyin_table_covers_common_chars`
    4. `test_kana_romaji_table_covers_basic_syllables`
    5. `test_syllable_split_functions_present`
    6. `test_syllable_import_export_roundtrip`
    7. `test_vocal_preview_uses_oscillator_node`
    8. `test_syllable_ui_elements_present`
    9. `test_syllable_lock_toggle_present`
    10. `test_syllable_undo_redo_snapshot_included`
- `project-state.json`：更新 last_updated / phase / interaction_prototypes 项目 schema / editor_interactions / next_actions / open_decisions
- `CHANGELOG.md`：新增 P2 轮 1 条目
- 本轮日志

## 验证

- `node --check prototype/web-workbench/app.js`：语法通过。
- `node --check prototype/web-workbench/desktop-bridge.js`：语法通过。
- `python -m unittest tests.test_web_workbench_static -v`：**32 项通过**（22 项既有 + 10 项新增 P2 测试）。
- `python -m unittest tests.test_desktop_shell_static -v`：**15 项通过**（未受本轮修改影响）。
- `python -m unittest tests.test_audio_analysis -v`：**4 项通过**（未受本轮修改影响）。
- 总计 51 项测试全部通过。
- 真实浏览器回归测试本轮未执行；下一轮在桌面壳中一起做（覆盖 syllable 切分实际效果、读音覆盖、试听合成听感、0.2.0 项目迁移、0.1.0 项目迁移、撤销/重做、字段级锁定保留）。

## 决定与理由

- **schema 一次性升到 0.3.0**：本轮引入的 syllables + vocalPreview 是数据模型层面的扩展（新增持久化字段），符合 schema 升级条件。0.2.0 项目自动迁移派生默认 syllables，0.1.0 项目深度迁移后也派生默认 syllables——保证旧项目导入即可用。
- **不引入独立的"P2 schema"中间版本**：syllables 与 0.2.0 的 anchor/lyric/rest 模型正交，没有破坏性变化；没有必要再增加一个 0.2.x 中间版本。
- **syllable 与 LyricRegion / NoteEvent 共享 anchor 表**：与 AGENTS.md "连续歌词/音符区域必须共享边界或明确显示休止" 一致——syllable 的 start/end anchor 与 LyricRegion 的 start/end anchor 在数据层共享，移动一次同时改变两侧。
- **中文按字切分、日文按假名切分**：与 AGENTS.md "首版歌词支持中文和日文" 一致。中文一字一音节是普通话的最小可唱单位；日文按假名音节切分符合假名发音规则。拗音合并为单 syllable 是因为唱法上是一个音节；促音单独成 syllable 是因为 USTX 用 `cl` 表示，与 OpenUtau 适配路径一致。
- **defaultReading 去声调**：拼音声调在不同声库中表达方式不同（数字 / 符号 / 重音），第一版只给基础拼音字母；用户可在 readingOverride 中输入带声调的完整读音。
- **未识别字显式提示**：与 AGENTS.md "不得把'面向小白'理解为隐藏或删除专业数据" 一致——查不到的字 defaultReading 为空，UI 显示"未识别"提示，让用户知道需要手工补读音。
- **试听只支持 OscillatorNode 四种基础波形**：第一版目的是让用户听到音高与节奏的对位关系，不是真实歌声合成。OscillatorNode 是 Web Audio API 内置的零依赖方案，足够给"歌声草案"提供反馈。
- **试听非破坏**：所有 OscillatorNode + GainNode 都是临时对象，`osc.onended` 自动清理；`stopVocalPreview` 显式 stop + disconnect；不修改 state.notes / state.syllables / 任何持久化数据。
- **试听音色不进 undo**：`vocalPreviewTimbre` 是临时参数（与 stem gain 滑块拖动过程类似），切换不记 undo。读音编辑、重新切分、锁定 toggle 才记 undo。
- **重新切分时保留锁定**：与 AGENTS.md "支持锁定局部结果后重生成" 一致——锁定的 syllable 的 readingOverride 按 index 在重新切分后恢复，避免被覆盖。锁定状态本身也按 index 恢复。
- **0.2.0 项目自动派生 syllables 而不是要求用户手工切分**：0.2.0 项目已经保存了歌词文本，派生默认 syllables 是无损的（用户随时可以重新切分或覆盖读音）；强制用户手工切分会破坏 0.2.0 项目的可用性。
- **0.1.0 项目迁移在歌词区域建立后派生 syllables**：0.1.0 项目没有 anchor 模型，先迁移到 anchor + LyricRegion，再为已建立的歌词区域派生 syllables——两步迁移逻辑清晰。
- **syllable 锁定项在 syllables 加载后补全校验**：`rawLocked` 中 `syllable:` 前缀项需要基于已加载的 syllables 验证；在 syllables 加载前先做了 lyric/rest/chord 验证，再补上 syllable 验证，保证顺序正确。

## 未决问题 / 下一步

- **真实浏览器回归**：syllable 切分实际效果（中文/日文混合歌词）、读音覆盖输入、试听合成听感（不同波形/音区）、0.2.0 项目自动迁移、0.1.0 项目深度迁移、撤销/重做（读音修改 + 重新切分 + 锁定 toggle）、字段级锁定在重新切分时保留 readingOverride。
- **拼音表扩展**：首批 80 字覆盖示例歌词；后续可从 unihan 字典扩展到全量拼音。
- **假名罗马音表扩展**：当前覆盖 46 清音 + 浊音/半浊音 + 拗音 + 促音/拨音 + 片假名同表；后续可补充复合词中的特殊读法。
- **试听合成增强**：第一版只有 OscillatorNode 四种基础波形；后续可接入 Basic Pitch 转录结果 + 简单 formant 合成，让试听更接近人声。
- **OpenUtau / Synthesizer V 适配**：syllable 数据模型已为 USTX phoneme 数据结构预留接口；下一轮可开始 OpenUtau 适配（USTX 0.6）。
- **真实音源分离 + 转录后端接入**：本轮试听只针对 NoteEvent（用户手工创建或后续从 Basic Pitch 导入）；接入 Demucs 后可分离出真实人声 stem 并在试听中混合。
- **多语言扩展（英文等）**：当前 zh/ja 已覆盖；英文等语言不在 P2 范围内，留待后续。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待主 Agent 提交和推送（任务规范明确要求不执行 git commit/push）。
- 修改文件清单：
  - `prototype/web-workbench/app.js`（modified）
  - `prototype/web-workbench/index.html`（modified）
  - `prototype/web-workbench/styles.css`（modified）
  - `tests/test_web_workbench_static.py`（modified）
  - `project-state.json`（modified）
  - `CHANGELOG.md`（modified）
  - `logs/2026-07-20_016-p2-lyric-syllable-vocal-preview.md`（new）
