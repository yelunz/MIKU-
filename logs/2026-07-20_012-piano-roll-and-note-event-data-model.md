# 2026-07-20 / 012 / P1.2 轮 2：钢琴卷帘 + NoteEvent 数据模型

## 本轮目标

按 `docs/MULTITRACK_COMPOSITION_DESIGN.md` 的设计，落地 P1.2 阶段第二项能力：钢琴卷帘与可编辑 NoteEvent 数据模型。这是从"多轨混音器骨架"过渡到"专业音符工作台"的关键一步，让用户能在 sample + anchor 双时间模型上手工创建、移动、拉伸、拆分和合并音符候选，与歌词/休止共享同一 anchor 表。

第一版没有真实转录后端，所有音符都是用户手工创建；接入 Basic Pitch / Demucs 后，转录结果会作为 source="transcription" 的 NoteEvent 挂到对应 stem 轨。

## 用户确认的要求

- 用户最新要求：全程自动迭代，直到获取可用的第一版软件后再进行测试；不影响电脑、无威胁性的沙盒命令全部自动放行，无需手动操作。
- AGENTS.md 已规定"软件不替用户规定审美、风格、唱法或创作目的"，本轮不预设任何音符内容、调性约束或音高范围偏好（仅按钢琴卷帘可显示范围 clamp）。
- AGENTS.md 已规定"连续歌词/音符区域必须共享边界或明确显示休止，不得用互不相关的浮点起止制造无意义小缝"——音符与歌词/休止共享同一 anchor 表，相邻音符若边界对齐会自动复用 anchor。
- AGENTS.md 已规定"音源分离、音频转录和歌声旋律生成是三个独立过程"——本轮只做手工音符编辑，不混入转录（P1.3 后端对比阶段才接入）。
- MULTITRACK_COMPOSITION_DESIGN.md 已规定 stem 与音符转录是不同过程；本轮音符是用户手工创建的候选数据，不自动从伴奏转录。

## 子 Agent 分工

本轮为单一耦合实现（NoteEvent 数据模型 + 钢琴卷帘 UI + 拖动/拉伸/创建交互 + 撤销/重做 + 项目持久化全部共享 state 与 renderAll），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主 Agent 完成。

## 执行内容

### NoteEvent 数据模型

- `state.notes: NoteEvent[]`：每个 NoteEvent 字段：
  - `id`：`note-<n>`，由 `state.nextNoteId` 生成，唯一
  - `stemId`：归属 stem（master / drums / bass / other），默认 master
  - `startAnchorId` / `endAnchorId`：引用 `state.anchors` 表，与歌词/休止共享
  - `pitch`：整数 MIDI 音高（60 = C4），范围 clamp 到 `PIANO_ROLL_MIN_PITCH`..`PIANO_ROLL_MAX_PITCH`（C2..C7，36..96）
  - `velocity`：0..1，默认 0.8
  - `confidence`：0..1，手工创建为 1.0，转录/生成为后端填写值
  - `source`："manual" | "transcription" | "generation"
- `state.nextNoteId`：单调递增，避免 ID 重复
- `state.selectedNoteId`：当前选中的音符（单选）
- `state.pianoRollMergeCandidateId`：Shift + 点击第二个音符时设为合并候选
- `state.pianoRollStemId`：钢琴卷帘当前目标 stem（默认 master）
- `state.noteDrag`：拖动状态机（mode / startClientX / startClientY / originalStartSample / originalEndSample / ...）

### 常量

- `PIANO_ROLL_MIN_PITCH = 36`（C2）
- `PIANO_ROLL_MAX_PITCH = 96`（C7）
- `PIANO_ROLL_ROW_HEIGHT = 14`（px，每半音一行）
- `PIANO_ROLL_CREATE_MIN_SECONDS = 0.02`（拖出新音符的最小长度，小于此值不创建）

### 工具函数

- `midiToNoteName(pitch)`：MIDI 音高 → 音名（如 60 → "C4"），支持升降号
- `noteNameToMidi(name)`：音名 → MIDI 音高（用于将来批量输入）
- `anchorStartSample(note)` / `anchorEndSample(note)`：从 anchor 表读取音符起止 sample
- `anchorStartSeconds(note)` / `anchorEndSeconds(note)`：从 anchor 表读取音符起止秒数
- `clamp(value, min, max)`：通用 clamp
- `findAnchorBySample(sample)`：在 `ANCHOR_TOLERANCE_SECONDS` 容差内查找已有 anchor（与歌词/休止共用）
- `createAnchorAtSample(sample)`：创建新 anchor 并加入 state.anchors
- `detachNoteAnchorIfShared(note, which)`：若起/止 anchor 被其他对象引用，克隆一份给当前音符，保持邻居不动

### CRUD 函数

- `createNote(stemId, startSample, endSample, pitch, velocity, source)`：
  - clamp 起止 sample、pitch、velocity
  - 复用或创建 start/end anchor（与歌词/休止共用同一表）
  - 生成唯一 ID `note-<nextNoteId>`
  - 推入 `state.notes`，返回新 note
- `deleteNote(id)`：从 state.notes 过滤掉；清空 selectedNoteId / pianoRollMergeCandidateId（如指向当前）；`editGraph.begin("删除音符 <id>")`；`pruneAnchors()` 清理孤立 anchor
- `selectNote(id, additive=false)`：
  - 普通 click：设为 selectedNoteId，清空 mergeCandidate
  - Shift + click：若已有 selectedNoteId，把当前设为 mergeCandidate
  - 同步选区到时间轴 `setSelection(startSeconds, endSeconds, false)`
- `splitSelectedNote()`：从中点拆分；原音符 end 缩到中点（复用或创建 mid anchor），新音符从中点到原 end；selectedNoteId 切到新音符
- `mergeSelectedNotes()`：
  - 只允许音高相同且时间相邻（起止 sample 差 ≤ `ANCHOR_TOLERANCE_SECONDS * sampleRate`）的音符合并
  - 合并后 first.endAnchorId = second.endAnchorId，从 state.notes 删除 second
  - selectedNoteId 切到 first

### 钢琴卷帘渲染

- `renderPianoRoll()`：
  - 设置 `#piano-roll-content` 的 width（与时间轴对齐）和 height（60 半音 × 14px = 840px）
  - 调用 `drawPianoRollCanvas(width, height)` 画背景网格
  - 清空 `#piano-roll-grid`，遍历 state.notes 调用 `buildNoteBlock(note)` 创建 div
  - 若有音频+分析，附加 `piano-roll-playhead` div
- `drawPianoRollCanvas(width, height)`：
  - 在 `<canvas>` 上绘制水平半音线（黑键加深、白键浅）、垂直小节线（按 tempo_map 计算）、垂直拍线（更浅）
  - C 音行标音名（C2 / C3 / C4 / C5 / C6 / C7）
- `buildNoteBlock(note)`：
  - 创建 div.piano-roll-note，定位 left/width/top/height
  - 加 source 类（source-transcription / source-generation 用不同颜色）
  - 加 selected / merge-candidate 类
  - 文本显示音名 + ID（如 "C4 · note-3"）
  - `::before` / `::after` 伪元素提供左右 6px 拉伸手柄

### 拖动/拉伸/创建交互

- `beginNoteDrag(event, note, mode)`：
  - mode ∈ "move" / "stretch-start" / "stretch-end"
  - 记录 startClientX/Y、originalStartSample、originalEndSample
  - 设置 `state.noteDrag` 状态
  - 调用 `detachNoteAnchorIfShared` 克隆共享 anchor
  - `document.addEventListener("pointermove", moveNote)` + `pointerup/cancel`
- `moveNote(event)`：
  - move：dx_sample = (dx_px / timeline_width) × duration_samples；起止 anchor 同时移动 dx_sample
  - stretch-start：只移动 start anchor，end 不动
  - stretch-end：只移动 end anchor，start 不动
  - 全部应用 snap（若开启）
  - 实时 renderPianoRoll
- `endNoteDrag(event)`：
  - 若移动距离 < 4px，视为点击，调用 `selectNote(id, event.shiftKey)` 不记 undo
  - 否则 `editGraph.begin("移动/拉伸音符 <id>")` 记 undo
  - `pruneAnchors()`
- `cancelNoteDrag()`：恢复原 sample 位置，清空 noteDrag
- `beginNoteCreate(event)`：在空白区域 pointerdown 触发；记录起点 sample/pitch；进入 "create" 模式
- `moveNoteCreate(event)`：实时更新 preview div 的 width/left
- `endNoteCreate(event)`：
  - 计算最终 sample 范围，clamp pitch
  - 若长度 < `PIANO_ROLL_CREATE_MIN_SECONDS` 不创建
  - 调用 `createNote` + `editGraph.begin("新建音符 <id>")`
  - 选中新音符
- `cancelNoteCreate()`：清空 noteDrag

### 工具栏

- `#piano-roll-stem-select`：切换钢琴卷帘目标 stem
- `#split-note-button`：拆分选中音符（中点一分为二）
- `#merge-note-button`：合并 selectedNoteId 与 mergeCandidateId
- `#delete-note-button`：删除选中音符
- `updatePianoRollToolButtons()`：根据 selectedNoteId / mergeCandidateId 启用/禁用按钮

### 键盘快捷键

- Esc：若有 noteDrag，根据 mode 调用 `cancelNoteCreate()` 或 `cancelNoteDrag()`
- Delete / Backspace：若有 selectedNoteId 且不在文本输入区域，调用 `deleteNote(selectedNoteId)`

### 缩放

- `#piano-roll-scroll` 上 Ctrl/Cmd + 滚轮：与时间轴相同的 zoom 范围，调用 `renderAll()` 同步两个视图

### 撤销/重做与项目持久化

- EditGraph `snapshot()` 新增 `notes: state.notes.map(note => ({ ...note }))` 与 `nextNoteId`
- EditGraph `restore(snapshot)`：
  - 旧版快照没有 notes 字段时回退到空数组（向前兼容）
  - 恢复 selectedNoteId / noteDrag / pianoRollMergeCandidateId 为空（避免悬空引用）
- `resetEditingState()`：清空 notes、nextNoteId 重置为 1、selectedNoteId 为空、pianoRollStemId 重置为 master、调用 updatePianoRollToolButtons
- `exportProject()` 新增 `editing.notes` 字段，导出每个音符的完整参数（id / stem_id / start_anchor_id / end_anchor_id / pitch / velocity / confidence / source）
- `importAnchorsAndRegions()` 加载 notes：
  - ID 唯一性校验
  - anchor 存在性校验（start/end anchor 必须存在于 state.anchors）
  - start/end 不能相同
  - stem_id 必须在 `{master, drums, bass, other}` 集合内，否则回退到 master
  - pitch / velocity / confidence 范围 clamp
  - source 枚举校验（"manual" / "transcription" / "generation"）
  - 从 ID 提取最大编号，更新 nextNoteId
- `migrateLegacyProject()`：0.1.0 项目没有 notes 字段；迁移时清空 notes、nextNoteId = 1、selectedNoteId = null

### HTML / CSS

- HTML 在 stem-mixer-card 之后新增 `piano-roll-card` section：
  - 标题 + 说明（明确"第一版没有真实转录后端，所有音符都是用户手工创建"）
  - 工具栏：目标 stem 选择 + 拆分/合并/删除按钮
  - `#piano-roll-scroll` > `#piano-roll-content` > `<canvas>` + `#piano-roll-grid`
  - footnote 说明操作方式
- CSS 添加 `.piano-roll-*` 全套样式：
  - 卡片容器、header、tools、scroll、content、canvas、grid
  - `.piano-roll-note`：紫色块，左右 6px 拉伸手柄（`::before` / `::after`）
  - `.piano-roll-note.selected`：accent 强调边框 + 阴影
  - `.piano-roll-note.merge-candidate`：accent 虚线边框
  - `.piano-roll-note.preview`：创建拖动时的半透明预览
  - `.piano-roll-note.source-transcription` / `.source-generation`：不同颜色区分来源
  - `.piano-roll-playhead`：与时间轴 playhead 同色（danger 红）
  - footnote 样式

## 修改文件

- `prototype/web-workbench/app.js`：NoteEvent 数据模型、常量、工具函数、CRUD（createNote/deleteNote/selectNote/splitSelectedNote/mergeSelectedNotes）、钢琴卷帘渲染（renderPianoRoll/drawPianoRollCanvas/buildNoteBlock）、拖动/拉伸/创建交互（beginNoteDrag/moveNote/endNoteDrag/cancelNoteDrag/beginNoteCreate/moveNoteCreate/endNoteCreate/cancelNoteCreate/detachNoteAnchorIfShared）、updatePianoRollToolButtons、事件绑定、Esc/Delete 快捷键、Ctrl+滚轮缩放、EditGraph 快照/恢复、exportProject/importAnchorsAndRegions/migrateLegacyProject/resetEditingState、renderAll 调用、updateTransport 同步播放头
- `prototype/web-workbench/index.html`：piano-roll-card section 与所有控件
- `prototype/web-workbench/styles.css`：.piano-roll-* 全套样式
- `prototype/web-workbench/README.md`：已实现与当前边界章节同步
- `tests/test_web_workbench_static.py`：新增 `test_piano_roll_and_note_events_are_present`
- `CHANGELOG.md`、`docs/ROADMAP.md`、`project-state.json`、本轮日志

## 验证

- `node --check prototype/web-workbench/app.js`：语法通过。
- `python -m unittest tests.test_web_workbench_static -v`：20 项通过（新增 1 项 `test_piano_roll_and_note_events_are_present`，验证 NoteEvent 字段、钢琴卷帘常量/工具函数、CRUD、渲染、交互、HTML/CSS、撤销/重做、项目导入/导出、0.1.0 迁移、Esc/Delete 快捷键、事件绑定）。
- `python -m unittest tests.test_audio_analysis -v`：4 项通过（音频分析 CLI 未回归）。
- 共 24 项测试通过。
- `project-state.json` JSON 解析通过。
- 真实浏览器回归测试本轮未执行；下一轮在 P1.2 轮 3 完成后一起做（覆盖钢琴卷帘创建/移动/拉伸/拆分/合并、播放头同步、与歌词/休止共享 anchor 的真实表现）。

## 决定与理由

- **音符引用 anchor 而非秒数**：与歌词/休止共享同一 anchor 表是 AGENTS.md "连续歌词/音符区域必须共享边界"的硬要求。引用 anchor 让相邻音符若边界对齐会自动复用，从根上消除小缝；拖动音符前 detach 共享 anchor 保证邻居不动。
- **C2..C7 音高范围（60 半音）**：覆盖人声主旋律 + 钢琴伴奏 + 鼓组打击的常见音域。低于 C2 或高于 C7 的音符用例极少，clamp 不会丢失用户意图。后续若需要扩展只需调整两个常量。
- **14px 行高**：60 半音 × 14px = 840px 总高度，配合 max-height: 22rem 的滚动容器，既能在屏幕上看到 2-3 个八度，又能滚动到全部音域。
- **四种交互模式统一在 noteDrag 状态机**：move / stretch-start / stretch-end / create 共用同一状态对象，pointermove/pointerup 监听在 document 上统一分发，避免事件泄漏。
- **点击 vs 拖动 4px 阈值**：与歌词块拖动一致（沿用 011 轮约定），小于 4px 视为点击进入选中模式，避免误触发拖动。
- **拆分从中点**：第一版不提供"在点击位置拆分"，简化交互。中点拆分是 DAW 的常见默认行为，符合用户预期。后续可加"在播放头位置拆分"。
- **合并只允许同音高 + 时间相邻**：避免用户误合并出"跨音高滑音"或"中间有间隙"的非法音符。同音高 + 相邻是合并的最小安全条件。
- **占位 stem 也可挂音符**：用户可以在 drums/bass/other 占位 stem 上创建音符，等接入分离后端后这些音符直接挂到真实 stem 轨。这样过渡不需要数据迁移。
- **source 区分颜色**：source=manual 是紫色（默认），source=transcription 是 accent 色（绿），source=generation 是 warning 色（黄），让用户一眼看出音符来源。
- **导入时严格校验 anchor 引用**：音符引用的 start/end anchor 必须存在于 state.anchors，否则抛错。避免恶意/损坏项目文件注入悬空引用。
- **0.1.0 项目没有 notes**：迁移时清空 notes，nextNoteId = 1。0.1.0 项目里没有音符概念，硬塞会破坏数据一致性。

## 未决问题 / 下一步

- 真实浏览器回归：钢琴卷帘创建/移动/拉伸/拆分/合并、播放头同步、与歌词/休止共享 anchor 的真实表现。
- P1.2 轮 3：量化、反拍、三连音、附点、Swing 网格（在 snap-grid 上扩展更多选项，并在钢琴卷帘与时间轴上同步生效）。
- P1.2 轮 4：非破坏混音参数（cut/warp/effect）+ 原始/重合成试听切换。
- 接入 Basic Pitch / Demucs 后端后，转录结果作为 source="transcription" 的 NoteEvent 自动挂到对应 stem 轨。
- 后续：音符 velocity 在钢琴卷帘上以颜色深浅或下方力度条显示（当前只保存不展示）。
- 后续：钢琴卷帘 MIDI 键盘侧栏（当前只在 canvas 上画音名）。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待最终测试、提交和推送。
