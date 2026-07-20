# 轮 001 · P4 完整编排能力（呼吸标记 / 参数曲线 / 候选比较 / 和声轨）

**日期**：2026-07-21
**序号**：001（今日首条）
**主题**：实现 P4 四项完整编排能力——呼吸标记（breath marks）、参数曲线（pitch/dynamics/vibrato）、候选比较（candidate snapshots）、和声轨（harmony tracks），并把项目 schema 从 0.3.0 升级到 0.4.0 含自动迁移。本轮补齐 12 项 P4 静态测试，修复 P4 实施引入的 3 处既有测试回归。

## 目标

按 P4 任务规范，实现四项独立可撤销的完整编排能力：

1. **呼吸标记**：在选中音符末尾添加 breath mark（复用音符 endAnchor 作为位置基准），可调整 intensity（0..1）、删除、锁定；时间轴新增 breath-lane 渲染轨道。
2. **参数曲线**：每个音符可挂载三种参数曲线（pitch -1..1 / dynamics 0..1 / vibrato 0..1），曲线由 (tick, value) 控制点数组定义；canvas 预览 + 控制点列表 + 添加/删除/拖动控制点。
3. **候选比较**：把当前 notes/syllables/breathMarks 深拷贝保存为候选快照（含 label + createdAt），可加载候选替换当前编排、与当前对比（音符数 / 音高范围 / 呼吸数差异摘要）、删除候选。
4. **和声轨**：创建/删除/选择和声轨，每条轨有 mute/solo/gain；和声轨音符用 `source="harmony"` 标记，钢琴卷帘中以紫色区分；删除和声轨时一并删除其上的音符。

四项能力均要求：独立运行、独立撤销（每次操作前 `editGraph.begin`）、在局部锁定下重新生成、随项目持久化、向前兼容（0.3.0/0.2.0/0.1.0 项目自动迁移到 0.4.0，P4 字段为空数组）。

## 关键约束遵循

- **不破坏既有测试**：本轮 P4 实施期间发现并修复了 3 处既有测试回归（详见"修复既有测试回归"小节）。
- **不使用 innerHTML**：所有 DOM 操作用 `textContent` / `appendChild`（与既有规则一致）。修复了 P4 注释中误用 "innerHTML" 字面量导致 2 处既有断言失败的问题。
- **中文注释**：所有新增代码注释为中文。
- **向前兼容**：`editGraph.restore()` 中 P4 字段缺失时回退到空数组（`Array.isArray(snapshot.xxx) ? ... : []`），保证旧版快照可恢复。
- **锁定机制一致**：breath 与 param-curve 加入既有 `lockedFields` Set，lockKey 格式 `"breath:id"` / `"param-curve:id"`，与 lyric/rest/chord/syllable 锁定机制一致。
- **渐进式呈现**：P4 面板默认 hidden，仅在选中相关对象（音符 / 呼吸标记）时显示，不干扰新手。

## 执行内容

### 1. `prototype/web-workbench/app.js`（修改）

**Schema 升级**：
- `PROJECT_SCHEMA` 从 `"miku-workbench-project/0.3.0"` 升级到 `"miku-workbench-project/0.4.0"`
- 新增 `PROJECT_SCHEMA_LEGACY_030 = "miku-workbench-project/0.3.0"` 常量
- `importProject()` 接受 0.3.0 schema 并迁移到 0.4.0

**State 扩展**（P4 四组字段）：
```javascript
breathMarks: [], nextBreathId: 1, selectedBreathId: null,
paramCurves: [], nextParamCurveId: 1, selectedParamCurveId: null, activeParamKind: "pitch",
candidates: [], nextCandidateId: 1, selectedCandidateId: null, compareCandidateId: null,
harmonyTracks: [], nextHarmonyTrackId: 1, selectedHarmonyTrackId: null,
```

**editGraph.snapshot() / restore() 扩展**：
- snapshot 深拷贝 `breathMarks`、`paramCurves`（含 points 数组深拷贝）、`candidates`（含 notes/syllables/breathMarks 深拷贝）、`harmonyTracks`
- restore 向前兼容：缺失字段回退到空数组，`nextXxxId` 缺失时回退到 1

**pruneAnchors() 扩展**：把 `breathMarks` 引用的 anchor 视为"被引用"，避免清理呼吸标记位置基准。

**exportProject() 扩展**：`editing` 对象新增 `breath_marks` / `param_curves` / `candidates` / `harmony_tracks` 四个字段。

**importAnchorsAndRegions() 扩展**：
- 加载 `breath_marks`（校验 ID 唯一 + anchor 引用存在）
- 加载 `param_curves`（校验 ID 唯一 + noteId 引用存在 + kind 枚举 pitch/dynamics/vibrato）
- 加载 `candidates`（校验 ID 唯一）
- 加载 `harmony_tracks`（校验 ID 唯一）
- 加载后补全 breath / param-curve 锁定验证（`validBreathIds` / `validCurveIds`）

**migrateLegacyProject() 扩展**：0.1.0 项目迁移时清空 P4 四组字段（注释说明 "0.1.0 项目没有 breath_marks / param_curves / candidates / harmony_tracks 字段"）。

**buildNoteBlock() 扩展**：`note.source === "harmony"` 时添加 `source-harmony` CSS class。

**renderAll() 扩展**：调用 `renderBreathLane()` / `renderBreathInspector()` / `renderParamCurvePanel()` / `renderCandidateList()` / `renderCandidateCompareSummary()` / `renderHarmonyTrackSelector()`。

**新增 P4 函数**（约 680 行）：
- 呼吸标记：`addBreathMarkAtSelectedNote` / `selectBreathMark` / `deleteBreathMark` / `updateBreathIntensity` / `renderBreathLane` / `renderBreathInspector`
- 参数曲线：`setActiveParamKind` / `ensureParamCurve` / `addParamPointToSelectedCurve` / `updateParamPoint` / `deleteParamCurve` / `selectParamCurve` / `renderParamCurvePanel` / `drawParamCurveCanvas`
- 候选比较：`saveCurrentAsCandidate` / `loadCandidate` / `compareWithCandidate` / `deleteCandidate` / `renderCandidateList` / `renderCandidateCompareSummary`
- 和声轨：`createHarmonyTrack` / `deleteHarmonyTrack` / `selectHarmonyTrack` / `updateHarmonyTrack` / `renderHarmonyTrackSelector`

**新增 elements 引用**：breathLane / breathInspector / breathDetail / breathIntensity / deleteBreathButton / lockBreathWrapper / lockBreathCheckbox / addBreathButton / paramCurvePanel / paramCurveKindPitch / paramCurveKindDynamics / paramCurveKindVibrato / paramCurveCanvas / paramCurvePointList / addParamPointButton / deleteParamCurveButton / lockParamCurveWrapper / lockParamCurveCheckbox / candidateCard / candidateLabelInput / saveCandidateButton / candidateList / candidateCompareSummary / harmonyTrackSelect / addHarmonyTrackButton / deleteHarmonyTrackButton / harmonyTrackMute / harmonyTrackSolo / harmonyTrackGain。

**新增事件绑定**：所有 P4 元素的 click / change / input 事件，均通过 `editGraph.begin()` 记录 undo 点。

**resetEditingState() 扩展**：重置 P4 四组字段为初始值，隐藏 breath inspector / param curve panel / lock wrapper。

### 2. `prototype/web-workbench/index.html`（修改）

- 钢琴卷帘工具条新增：和声轨选择器 / 新增和声轨按钮 / 删除和声轨按钮 / 静音/独奏按钮 / 音量滑块 / 添加呼吸标记按钮
- 新增 `#param-curve-panel` section：三种曲线类型 radio（pitch/dynamics/vibrato）+ canvas + 控制点列表 + 添加控制点按钮 + 删除曲线按钮 + 锁定 checkbox
- 新增 `#candidate-card` section：标签输入 + 保存按钮 + 候选列表 + 比较摘要
- 时间轴新增 breath-lane track-row
- 侧栏新增 `#breath-inspector` section：强度滑块 + 删除按钮 + 锁定 checkbox

### 3. `prototype/web-workbench/styles.css`（修改）

新增 P4 样式（约 40 行）：
- `.breath-lane` / `.breath-mark` / `.breath-mark.selected` / `.breath-mark.locked`：呼吸标记轨道与标记样式
- `.param-curve-panel` / `.param-curve-header` / `.param-curve-tools` / `.param-curve-body` / `.param-curve-point-list` / `.param-curve-point`：参数曲线面板与控制点列表样式
- `.candidate-card` / `.candidate-header` / `.candidate-list` / `.candidate-row` / `.candidate-label` / `.candidate-meta` / `.candidate-actions` / `.candidate-compare-summary`：候选比较卡片样式
- `.piano-roll-note.source-harmony`：和声轨音符紫色区分

### 4. `tests/test_web_workbench_static.py`（修改）

**更新既有 schema 测试**（3 处）：
- `test_project_and_analysis_versions_are_explicit`：断言 0.4.0 schema + `PROJECT_SCHEMA_LEGACY_030`
- `test_legacy_project_migration_is_present`：断言 0.3.0→0.4.0 迁移消息
- `test_project_schema_upgraded_to_0_3_0` → 重命名为 `test_project_schema_upgraded_to_0_4_0`：断言 0.4.0 / `PROJECT_SCHEMA_LEGACY_030` / 迁移注释

**新增 12 项 P4 测试**（每功能 3 项：数据模型 / UI / 撤销重做）：
1. `test_p4_breath_marks_data_model_present`：state 字段 / CRUD 函数 / id 生成器 / 锁定机制 / pruneAnchors 引用 / 导入校验
2. `test_p4_breath_marks_ui_present`：HTML 元素 ID / elements 引用 / 渲染函数 / renderAll 调用 / 事件绑定 / CSS 样式
3. `test_p4_breath_marks_undo_redo_snapshot_included`：snapshot/restore 字段 / editGraph.begin undo 点 / resetEditingState / 项目导出导入 / 0.1.0 迁移清空 / restore 后隐藏 inspector
4. `test_p4_param_curves_data_model_present`：state 字段 / 三种 kind / point 字段 / CRUD 函数 / id 生成器 / 锁定机制 / 导入校验
5. `test_p4_param_curves_ui_present`：HTML 元素 ID / elements 引用 / 渲染函数 / 事件绑定 / CSS 样式
6. `test_p4_param_curves_undo_redo_snapshot_included`：snapshot/restore（含 points 深拷贝）/ editGraph.begin undo 点 / 项目导出导入 / restore 后隐藏 panel
7. `test_p4_candidates_data_model_present`：state 字段 / candidate 字段 / CRUD 函数 / id 生成器 / 导入校验
8. `test_p4_candidates_ui_present`：HTML 元素 ID / elements 引用 / 渲染函数 / 事件绑定 / dataset 委托 / CSS 样式
9. `test_p4_candidates_undo_redo_snapshot_included`：snapshot/restore（深拷贝 notes/syllables/breathMarks）/ editGraph.begin undo 点 / 项目导出导入
10. `test_p4_harmony_tracks_data_model_present`：state 字段 / track 字段 / CRUD 函数 / id 生成器 / source="harmony" 标记 / 删除时连带删音符 / 导入校验
11. `test_p4_harmony_tracks_ui_present`：HTML 元素 ID / elements 引用 / 渲染函数 / 事件绑定 / CSS 样式
12. `test_p4_harmony_tracks_undo_redo_snapshot_included`：snapshot/restore / editGraph.begin undo 点（新增/删除/调整）/ 项目导出导入

## 修复既有测试回归（3 处）

P4 实施期间发现并修复了 3 处既有测试失败：

1. **`test_user_content_is_not_inserted_with_inner_html` 失败**：app.js 第 5046 行注释 `- 不使用 innerHTML：所有 DOM 操作用 textContent / appendChild。` 含字面量 "innerHTML"，触发 `self.assertNotIn("innerHTML", self.javascript)` 断言失败。**修复**：注释改为 `- 不直接注入 HTML：所有 DOM 操作用 textContent / appendChild。`（移除字面量 "innerHTML"，语义不变）。

2. **`test_nondestructive_mix_and_preview_toggle_are_present` 失败**：同上，该测试末尾也有 `self.assertNotIn("innerHTML", self.javascript)` 断言。**修复**：同上，修改注释后通过。

3. **`test_project_schema_upgraded_to_0_4_0` 失败**：测试断言 `"0.3.0 项目导入时自动迁移到 0.4.0"`，但 app.js 实际注释是 `"0.3.0 / 0.2.0 / 0.1.0 项目导入时自动迁移到 0.4.0"`，子字符串不匹配（"0.3.0" 与 "项目" 之间有 " / 0.2.0 / 0.1.0 "）。**修复**：app.js 注释改为 `"0.3.0 项目导入时自动迁移到 0.4.0；0.2.0 / 0.1.0 项目沿用既有迁移路径最终也落到 0.4.0（P4 字段为空数组）。"`（确保断言子字符串存在）。

## 修改文件清单（绝对路径）

1. `c:\Users\yEluN\Documents\miku歌姬放计划\prototype\web-workbench\app.js`（修改：schema 升级 + state 扩展 + editGraph 扩展 + pruneAnchors 扩展 + export/import 扩展 + migrate 扩展 + buildNoteBlock 扩展 + renderAll 扩展 + P4 函数 + elements 引用 + 事件绑定 + resetEditingState 扩展 + 注释修复 ×2）
2. `c:\Users\yEluN\Documents\miku歌姬放计划\prototype\web-workbench\index.html`（修改：和声轨工具条 + 参数曲线面板 + 候选卡片 + breath-lane + breath-inspector）
3. `c:\Users\yEluN\Documents\miku歌姬放计划\prototype\web-workbench\styles.css`（修改：P4 样式块）
4. `c:\Users\yEluN\Documents\miku歌姬放计划\tests\test_web_workbench_static.py`（修改：3 处既有测试更新 + 12 项新增 P4 测试）
5. `c:\Users\yEluN\Documents\miku歌姬放计划\project-state.json`（更新 phase / last_updated / project_schema / status / editor_interactions / next_actions）
6. `c:\Users\yEluN\Documents\miku歌姬放计划\CHANGELOG.md`（新增 P4 Added 条目）
7. `c:\Users\yEluN\Documents\miku歌姬放计划\logs\2026-07-21_001-p4-breath-param-candidate-harmony.md`（新建，本文件）

## 关键函数名

**呼吸标记**：
- `addBreathMarkAtSelectedNote()`：在选中音符末尾添加 breath mark（复用 endAnchor）
- `selectBreathMark(id)` / `deleteBreathMark(id)` / `updateBreathIntensity(id, value)`
- `renderBreathLane()` / `renderBreathInspector()`

**参数曲线**：
- `setActiveParamKind(kind)`：切换 pitch / dynamics / vibrato
- `ensureParamCurve(noteId, kind)`：懒创建曲线（不存在时新建 `curve-${nextParamCurveId++}`）
- `addParamPointToSelectedCurve()` / `updateParamPoint(curveId, pointIndex, value)` / `deleteParamCurve(id)` / `selectParamCurve(id)`
- `renderParamCurvePanel()` / `drawParamCurveCanvas(curve)`

**候选比较**：
- `saveCurrentAsCandidate(label)`：深拷贝当前 notes/syllables/breathMarks 为候选快照
- `loadCandidate(id)`：用候选替换当前编排（进入 undo 栈，可撤销）
- `compareWithCandidate(id)`：设置 compareCandidateId，渲染差异摘要
- `deleteCandidate(id)`
- `renderCandidateList()` / `renderCandidateCompareSummary()`

**和声轨**：
- `createHarmonyTrack(name)` / `deleteHarmonyTrack(id)`（连带删除 source="harmony" 或 stemId===id 的音符）/ `selectHarmonyTrack(id)` / `updateHarmonyTrack(id, field, value)`
- `renderHarmonyTrackSelector()`：同步 mute/solo/gain 控件到选中轨

## 验证结果

运行任务规范要求的完整测试套件：

```
python -m unittest tests.test_web_workbench_static tests.test_desktop_shell_static tests.test_engine_adapters tests.test_audio_analysis
Ran 117 tests in 2.335s
OK
```

**新增测试数量**：12 项 P4 测试（test_p4_breath_marks_* ×3 + test_p4_param_curves_* ×3 + test_p4_candidates_* ×3 + test_p4_harmony_tracks_* ×3）

**测试总数**：117 项（web-workbench 59 = 47 既有 + 12 新增；desktop-shell 26；engine-adapters 28；audio-analysis 4）

**既有测试无回归**：修复 3 处回归后全部通过。

## 决定与理由

1. **breath mark 复用音符 endAnchor 作为位置基准**：呼吸标记的位置语义是"音符末尾"，复用 endAnchor 避免新建 anchor；音符边界变化时呼吸标记位置自动跟随。理由：与共享 anchor 模型一致，不引入孤立 anchor。
2. **param curve 懒创建（ensureParamCurve）**：只有用户点击"添加控制点"时才创建曲线对象，避免空曲线堆积。理由：与 syllable 懒创建模式一致。
3. **candidate 是深拷贝快照而非引用**：保存候选时深拷贝 notes/syllables/breathMarks，加载候选时用候选数据替换当前 state。理由：候选是"历史快照"，后续编辑不应影响已保存的候选；加载候选进入 undo 栈，可用 Ctrl+Z 恢复。
4. **harmony track 音符用 source="harmony" 标记**：和声轨音符与 stem 音符共用 `state.notes` 数组，通过 `source` 字段区分；`buildNoteBlock` 添加 `source-harmony` CSS class 紫色区分。理由：复用既有 NoteEvent 模型与钢琴卷帘交互，不引入第二套音符表。
5. **删除和声轨连带删除其音符**：`source === "harmony"` 或 `stemId === id` 的音符一并删除。理由：避免和声轨删除后留下孤立音符；删除进入 undo 栈，可撤销恢复。
6. **P4 字段向前兼容**：`editGraph.restore()` 中 P4 字段缺失时回退到空数组；`migrateLegacyProject()` 中 0.1.0 项目清空 P4 字段。理由：旧版快照与旧版项目必须仍能加载，P4 字段为空等同于"未使用 P4 能力"。
7. **breath / param-curve 加入 lockedFields 但 candidate / harmony 不加入**：breath 与 param-curve 是"重生成可能覆盖"的对象（未来接入歌声引擎后可能自动重生成），需要锁定防止覆盖；candidate 是用户主动保存的快照（不会被重生成覆盖）；harmony track 是容器对象（其上的音符已有 source 标记，重生成不会误删）。理由：锁定机制只在"可能被自动重生成覆盖"的对象上启用，避免锁定膨胀。

## 未决问题

1. **真机回归未执行**：本轮仅通过静态测试验证 HTML/CSS/JS 结构与函数存在性，未在真实浏览器或 Electron 中验证 P4 交互。需在下一轮或用户手动验证：
   - 选中音符后点击"添加呼吸标记"是否在 breath-lane 显示标记
   - 选中音符后切换 pitch/dynamics/vibrato radio 是否正确显示对应曲线
   - 保存候选后点击"加载此候选"是否替换当前编排并可 Ctrl+Z 撤销
   - 新增和声轨后在钢琴卷帘中创建音符是否显示为紫色
   - 0.3.0 项目导入是否自动迁移到 0.4.0（P4 字段为空）
2. **P4 字段未接入导出适配器**：本轮 P4 字段（breath_marks / param_curves / candidates / harmony_tracks）仅随项目 JSON 持久化，尚未接入 MIDI / USTX / SynthV sidecar / VOCALOID6 导出适配器。呼吸标记与参数曲线在目标编辑器中的映射需要在后续轮次中逐适配器设计。
3. **候选比较差异摘要较粗**：当前 `renderCandidateCompareSummary()` 只比较音符数 / 音高范围 / 呼吸数三个维度，未比较具体音符位置/音高差异。如果需要更细粒度对比（如逐音符 diff），需要扩展差异算法。
4. **参数曲线 canvas 未支持直接拖动控制点**：当前只能通过控制点列表的 range 滑块修改 value，canvas 上不支持直接拖动控制点位置。这是后续 UX 增强，不在本轮范围。
5. **和声轨未接入 Web Audio 播放**：当前和声轨的 mute/solo/gain 只保存参数，未通过 Web Audio API 真实生效（因为和声轨音符是候选数据，不是真实音频）。未来接入歌声合成后端后才会真实播放。

## Git 状态

按任务要求，**未执行 git commit / git push**。主 Agent 将统一提交。

修改文件清单：
- `prototype/web-workbench/app.js`（修改）
- `prototype/web-workbench/index.html`（修改）
- `prototype/web-workbench/styles.css`（修改）
- `tests/test_web_workbench_static.py`（修改）
- `project-state.json`（修改）
- `CHANGELOG.md`（修改）
- `logs/2026-07-21_001-p4-breath-param-candidate-harmony.md`（新建，本文件）
