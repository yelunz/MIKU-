# 2026-07-20 / 013 / P1.2 轮 3：量化网格 + 附点 + 三连音 + Swing

## 本轮目标

按 `docs/MULTITRACK_COMPOSITION_DESIGN.md` 的设计，落地 P1.2 阶段第三项能力：扩展 snap 网格到 1/8 拍、1/3 拍（三连音）、1/6 拍（三连音），加附点（×1.5）和 Swing（0..0.7），并提供独立的"量化"按钮把选中音符对齐到当前网格。这是钢琴卷帘成为专业音符工作台的关键一步，让用户能在不同节奏型下手工编辑与对齐音符。

## 用户确认的要求

- 用户最新要求：全程自动迭代，直到获取可用的第一版软件后再进行测试；不影响电脑、无威胁性的沙盒命令全部自动放行，无需手动操作。
- AGENTS.md 已规定"软件不替用户规定审美、风格、唱法或创作目的"，本轮只提供网格工具，不预设任何节奏型或风格默认；所有网格选项默认关闭，由用户主动选择。
- AGENTS.md 已规定"面向音乐小白采用渐进呈现：先用高低、疏密、强弱、留白和声部形状操作，同一数据可展开到音符、tick、钢琴卷帘和参数曲线"——本轮网格扩展是专业层的展开，不强制小白使用。
- MULTITRACK_COMPOSITION_DESIGN.md 已规定"钢琴卷帘 + 量化、反拍、三连音、Swing"是 P1.2 必备能力。

## 子 Agent 分工

本轮为单一耦合实现（snap 函数、HTML 控件、事件绑定、项目持久化、canvas 渲染全部共享 state 与 renderAll），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主 Agent 完成。

## 执行内容

### 扩展 snap 网格

- `state.snapMode` 新增三个值：
  - `"eighth-beat"`：1/8 拍（直十六分音符）
  - `"triplet-half"`：1/3 拍（半拍三连音，每拍 3 个音符）
  - `"triplet-quarter"`：1/6 拍（四分拍三连音，每拍 6 个音符）
- HTML `<select id="snap-grid">` 添加对应 `<option>`：
  - `1/8 拍`
  - `1/3 拍（三连音）`
  - `1/6 拍（三连音）`
- `snapIntervalSeconds()` 改为 switch 结构：
  - `beat` → `60 / bpm`
  - `half-beat` → `beat / 2`
  - `quarter-beat` → `beat / 4`
  - `eighth-beat` → `beat / 8`
  - `triplet-half` → `beat / 3`
  - `triplet-quarter` → `beat / 6`

### 附点（dotted）

- `state.dottedSnap: boolean`，默认 false
- HTML `<input id="dotted-snap" type="checkbox">`，label "附点"
- 在 `snapIntervalSeconds()` 中：若 dottedSnap 为 true 且当前不是三连音网格，则 `interval = interval * 1.5`
- 三连音 + 附点在乐理上不常见（三连音本身已是奇分），所以叠加时不生效，避免产生奇怪的网格

### Swing（0..0.7）

- `state.swingAmount: number`，默认 0
- HTML `<input id="swing-amount" type="range" min="0" max="0.7" step="0.05">`，label "Swing"
- `swingOffsetForIndex(gridIndex, interval)`：
  - swingAmount = 0 或 interval = 0：无偏移
  - 三连音网格：无偏移（swing 概念不适用）
  - 整拍网格：无偏移（无可推点位）
  - 偶数段（gridIndex % 2 == 0）：无偏移
  - 奇数段：偏移 = `swingAmount * (interval / 2)`，即把后半段起点向后推
- `snapTime(seconds)` 在 swing 启用时比较两个候选点：
  - 常规网格点 `origin + rawIndex * interval`
  - 奇数段 swing 偏移点 `origin + oddIndex * interval + swingOffset`
  - 取距离 seconds 最近者

### 量化函数

- `quantizeSample(sample)`：把任意 sample 对齐到当前 snap 网格
  - 内部调用 `snapTime(seconds)` 并转回 sample
  - 用于 `quantizeSelectedNote`
- `quantizeSelectedNote()`：
  - 网格关闭时给出错误提示并返回
  - 计算当前音符的 startSample / endSample
  - 调用 `quantizeSample` 对齐到网格
  - 若起止都已在网格上则无操作
  - 否则 `editGraph.begin("量化音符 <id>")`，先 detach 共享 anchor，再 `moveAnchor` 到量化位置
  - `pruneAnchors()` 清理孤立 anchor
  - 渲染并提示

### 量化按钮

- HTML 在 piano-roll-tools 新增 `<button id="quantize-note-button">`
- `updatePianoRollToolButtons()` 中根据 selectedNoteId 启用/禁用
- 事件绑定 `elements.quantizeNoteButton.addEventListener("click", quantizeSelectedNote)`

### 钢琴卷帘 canvas 按 snap 网格绘制

- `drawPianoRollCanvas` 垂直网格部分重写：
  - 有 snap 时按 `origin + i * interval + swingOffsetForIndex(i, interval)` 绘制网格线
    - 偶数段（i % 2 == 0）= 强线（border 色）
    - 奇数段 + 无 swing = 中等线（rgba 0.28）
    - 奇数段 + swing = 浅线（rgba 0.18）
  - 无 snap 时回退到原有按秒数等距绘制
- 这样用户在钢琴卷帘上能直接看到当前 snap 网格与 swing 偏移，量化结果可预测

### 项目导出/导入

- `exportProject()` 的 `preferences` 新增 `dotted_snap` 与 `swing_amount`
- `importAnchorsAndRegions()` 加载偏好：
  - snap_mode 集合扩展到 `["beat", "half-beat", "quarter-beat", "eighth-beat", "triplet-half", "triplet-quarter", "none"]`
  - `state.dottedSnap = preferences.dotted_snap === true`（默认 false）
  - `state.swingAmount` clamp 到 0..0.7（默认 0）
  - 同步到 UI：`elements.dottedSnap.checked` / `elements.swingAmount.value`
- 删除 importProject 中重复的偏好加载逻辑（统一在 importAnchorsAndRegions 处理）

### 事件绑定

- `elements.dottedSnap.addEventListener("change", ...)`：更新 state.dottedSnap，提示
- `elements.swingAmount.addEventListener("input", ...)`：实时更新 state.swingAmount（不提示）
- `elements.swingAmount.addEventListener("change", ...)`：拖动结束时提示百分比

## 修改文件

- `prototype/web-workbench/app.js`：state.dottedSnap / state.swingAmount、snapIntervalSeconds switch、swingOffsetForIndex、snapTime swing 候选、quantizeSample、quantizeSelectedNote、updatePianoRollToolButtons 加 quantize、drawPianoRollCanvas 网格重绘、exportProject preferences、importAnchorsAndRegions preferences、importProject 去重、事件绑定
- `prototype/web-workbench/index.html`：snap-grid 新增 3 个 option、dotted-snap checkbox、swing-amount range、quantize-note-button
- `tests/test_web_workbench_static.py`：新增 `test_quantize_grid_dotted_and_swing_are_present`
- `CHANGELOG.md`、`docs/ROADMAP.md`、`project-state.json`、本轮日志

## 验证

- `node --check prototype/web-workbench/app.js`：语法通过。
- `python -m unittest tests.test_web_workbench_static -v`：21 项通过（新增 1 项 `test_quantize_grid_dotted_and_swing_are_present`）。
- `python -m unittest tests.test_audio_analysis -v`：4 项通过（未回归）。
- 共 25 项测试通过。
- 真实浏览器回归测试本轮未执行；下一轮在 P1.2 轮 4 完成后一起做。

## 决定与理由

- **三连音用 1/3 拍与 1/6 拍命名**：1/3 拍 = 半拍三连音（每拍 3 个），1/6 拍 = 四分拍三连音（每拍 6 个）。这与 1/2 拍 / 1/4 拍 / 1/8 拍的"偶数细分"形成对照，用户能在同一 select 中理解节奏型谱系。
- **附点 ×1.5 而非单独网格**：附点是网格修饰，不是独立网格。1/4 拍 + 附点 = 1.5/4 拍 = 3/8 拍，这是 DAW 的标准行为。三连音 + 附点在乐理上不常见，所以叠加时不生效。
- **Swing 范围 0..0.7**：超过 0.7 会让后半段几乎消失，没有音乐意义。0.5 是中等 swing（爵士常用），0.7 是强 swing（shuffle）。
- **Swing 不在三连音和整拍上生效**：三连音本身已是奇分，swing 概念不适用；整拍网格上无可推点位。这与所有 DAW 的行为一致。
- **量化是独立按钮而非自动应用**：拖动时已经实时 snap 到网格（含 swing），量化按钮用于把"已经存在但未对齐"的音符一次性对齐——例如导入转录结果后批量对齐。自动量化会破坏用户故意制造的偏移，所以必须由用户主动触发。
- **canvas 按 snap 网格绘制**：让用户在钢琴卷帘上直接看到当前网格与 swing 偏移，量化结果可预测。swing 偏移的奇数点用浅色，与强线区分。
- **Swing input 不提示，change 才提示**：与 stem 滑块一致，避免每个像素一条状态消息。input 实时改值（影响 snap 与 canvas），change（拖动结束）才弹提示。
- **删除 importProject 中的重复偏好加载**：importAnchorsAndRegions 已经处理 preferences，importProject 里的重复代码会导致状态被覆盖两次，且第二次不包含新字段。统一在一处处理更安全。

## 未决问题 / 下一步

- 真实浏览器回归：1/8 / 三连音 / 附点 / Swing 在拖动与量化上的真实表现，钢琴卷帘 canvas 网格线视觉。
- P1.2 轮 4：非破坏混音参数（cut/warp/effect）+ 原始/重合成试听切换。
- 后续：Swing 应用到 MIDI 导出（导出时把 swing 写入 MIDI tick 位置，让目标编辑器也能感受到 swing）。
- 后续：附点 + 三连音组合（罕见，等用户反馈再决定是否支持）。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待最终测试、提交和推送。
- 上一轮（012）的提交 17b4349 已固化本地，因 GitHub 网络连接重置暂未推送，本轮一并推送。
