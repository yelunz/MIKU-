# 2026-07-20 / 011 / P1.2 轮 1：多轨 stem 轨数据模型与 UI 骨架

## 本轮目标

按 `docs/MULTITRACK_COMPOSITION_DESIGN.md` 的设计，落地 P1.2 阶段第一项能力：多轨 stem 轨数据模型与混音器 UI 骨架（mute / solo / gain / pan）。这是从"波形分析查看器"向"多轨编曲工作台"过渡的第一步，也是后续钢琴卷帘、音符转录和音源分离后端的承载基础。

## 用户确认的要求

- 用户最新要求：全程自动迭代，直到获取可用的第一版软件后再进行测试；不影响电脑、无威胁性的沙盒命令全部自动放行，无需手动操作。
- AGENTS.md 已规定"软件不替用户规定审美、风格、唱法或创作目的"，本轮不预设任何混音预设或审美默认。
- AGENTS.md 已规定"本地优先"，所有混音参数随项目持久化到本地 JSON；占位 stem 的参数也保存，等接入分离后端时复用。
- MULTITRACK_COMPOSITION_DESIGN.md 已规定"第一版采用非破坏编辑：原始音频永不覆盖；裁切、音量、声像、静音、独奏、时间伸缩、warp marker 和效果只保存参数"。
- 同设计文档已规定 stem 与音符转录是不同过程；本轮只做 stem 轨与混音器，不混入音符转录（下一轮做钢琴卷帘）。

## 子 Agent 分工

本轮为单一耦合实现（数据模型 + UI + 事件 + 项目持久化共享 state 与 renderAll），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主 Agent 完成。

## 执行内容

### Stem 轨数据模型

- `state.stemTracks = defaultStemTracks()`：默认 4 个 stem 轨：
  - `master`（伴奏总览，source: "main"，关联主 audio 元素）
  - `drums`（鼓组，source: "placeholder"）
  - `bass`（贝斯，source: "placeholder"）
  - `other`（其他乐器，source: "placeholder"）
- 每个 stem 字段：`id` / `name` / `role` / `mute` / `solo` / `gain` (0..1.5，默认 1.0) / `pan` (-1..1，默认 0) / `source` ("main" | "placeholder")
- `defaultStemTracks()` 是函数（不是常量），每次返回新数组，避免多项目之间共享引用。

### Web Audio API 节点图

- `audioGraph` 对象：`context` / `source` / `masterGain` / `masterPanner` / `ready`。
- `setupAudioGraph()`：首次播放时调用一次。创建 AudioContext、`createMediaElementSource(audio)`、`createGain()`、`createStereoPanner()`，连接 source → masterGain → masterPanner → destination。失败时降级到 `audio.volume`（只能控制 master gain，pan 不生效）。
- `resumeAudioContext()`：AudioContext 处于 suspended 状态时调用 resume（autoplay 政策要求用户手势后才能播放）。
- `createMediaElementSource` 一旦调用就不能撤销，所以 setup 只执行一次；后续所有混音都通过 graph。
- 只为 master stem 真实生效 gain/pan/mute/solo；占位 stem 没有 audio 节点（接入 Demucs 后端后才会真实播放）。

### 混音逻辑

- `stemEffectiveState(track)`：计算每个 stem 的实际播放状态。
  - 若有任意 stem solo：只 solo 的 stem 发声，其他静音。
  - 否则：所有未 mute 的 stem 发声。
  - 返回 `{ muted, effectiveGain, effectivePan }`。
- `applyStemMix()`：根据 master stem 的 effective state 更新 audio graph（或降级到 audio.volume）。
- `formatStemFieldValue(field, value)`：格式化字段值用于状态提示。

### UI 渲染

- HTML 在 layer-toolbar 与 timeline-layout 之间新增 `stem-mixer-card` section，包含 `#stem-mixer` 容器。
- `renderStemMixer()`：根据 `state.stemTracks` 渲染 4 行 stem-row。
  - 渲染只更新数值与按钮状态，控件本身不重建（避免拖动时丢失焦点）。
  - 当 `container.children.length !== state.stemTracks.length` 时才重建（导入项目后 stem 数变化）。
- `buildStemRow(track)`：构建单行 stem-row：
  - stem-header：名字 + 角色
  - stem-controls：mute 按钮 + solo 按钮 + gain 滑块 + pan 滑块 + 状态徽章
  - master 行加 `stem-master` 类（左侧实线 4px 边）
  - 占位行加 `stem-placeholder` 类（左侧虚线 4px 边）
  - 静音行加 `muted` 类（opacity 0.62 + 虚线边）
  - 独奏行加 `soloed` 类（强调边框）

### 事件绑定

- `elements.stemMixer.addEventListener("click", ...)`：mute/solo 按钮点击，委托到 `updateStemField`。
- `elements.stemMixer.addEventListener("input", ...)`：gain/pan 滑块拖动时实时更新音频与数值显示，但不记 undo（避免每个像素一条 undo）。
- `elements.stemMixer.addEventListener("change", ...)`：拖动结束（change 事件）才记 undo，调用 `editGraph.begin` 并保留当前值。
- `updateStemField(trackId, field, value)`：统一入口，先 `editGraph.begin`，再改值，再 `applyStemMix` + `renderStemMixer`。

### 撤销/重做与项目持久化

- EditGraph `snapshot()` 包含 `stemTracks: state.stemTracks.map(track => ({ ...track }))`。
- EditGraph `restore(snapshot)` 恢复 stemTracks；旧版快照可能没有 stemTracks 字段，缺失时回退到 `defaultStemTracks()`。
- `resetEditingState()` 重置 stemTracks 为默认（新项目里旧混音参数无意义）。
- `exportProject()` 包含 `editing.stem_tracks` 字段，导出每个 stem 的完整参数。
- `importAnchorsAndRegions()` 加载 stem_tracks：
  - 只接受 id 在 `{master, drums, bass, other}` 集合内的 stem。
  - 字段类型校验与 clamp（gain 0..1.5，pan -1..1）。
  - 必须存在 master 轨；缺失时整套回退到默认 stem。
- `migrateLegacyProject()`：0.1.0 项目没有 stem_tracks 字段；迁移时回退到默认 stem 集。

### 播放集成

- `togglePlayback()` 在播放前调用 `setupAudioGraph()` 和 `resumeAudioContext()`。
- AudioContext 必须在用户手势中创建/恢复，所以放在 togglePlayback 而不是模块加载时。
- `renderAll()` 末尾调用 `renderStemMixer()` 和 `applyStemMix()`，保证任何状态变化后 UI 与混音同步。

### CSS 样式

- `.stem-mixer-card`：白色卡片容器，与 timeline-card 同级。
- `.stem-row`：grid 布局，左侧 header（9-11rem），右侧 controls。
- `.stem-master`：左侧 4px 实线 accent 边。
- `.stem-placeholder`：左侧 4px 虚线 muted 边。
- `.stem-row.muted`：opacity 0.62，虚线边。
- `.stem-row.soloed`：accent 强调边框与背景。
- `.stem-controls`：5 列 grid（mute / solo / gain / pan / status）。
- `.stem-slider`：3 列 grid（caption / input / value）。
- `.stem-status`：徽章样式，静音时变红色。

## 修改文件

- `prototype/web-workbench/app.js`：stemTracks 数据模型、audioGraph、setupAudioGraph/resumeAudioContext、stemEffectiveState/applyStemMix、renderStemMixer/buildStemRow、updateStemField/formatStemFieldValue、事件委托、EditGraph 快照/恢复、exportProject/importAnchorsAndRegions/migrateLegacyProject/resetEditingState、togglePlayback 集成
- `prototype/web-workbench/index.html`：stem-mixer-card section 与 #stem-mixer 容器
- `prototype/web-workbench/styles.css`：stem-mixer 全套样式
- `prototype/web-workbench/README.md`：已实现与当前边界章节同步
- `tests/test_web_workbench_static.py`：新增 `test_stem_mixer_data_model_and_ui_are_present`
- `CHANGELOG.md`、`docs/ROADMAP.md`、`project-state.json`、本轮日志

## 验证

- `python -m unittest discover -s tests -v`：23 项通过（4 项音频分析 CLI + 19 项 Web 工作台静态测试，新增 1 项：`test_stem_mixer_data_model_and_ui_are_present`）。
- `node --check prototype/web-workbench/app.js` 与 `node --check prototype/web-workbench/desktop-bridge.js`：语法通过。
- `project-state.json` JSON 解析通过。
- 真实浏览器回归测试本轮未执行；下一轮在 P1.2 轮 2 完成后一起做（覆盖 stem mute/solo/gain/pan 实际播放效果、项目往返、撤销/重做）。

## 决定与理由

- **master + 3 个占位 stem**：第一版没有真实音源分离，但 UI 必须呈现多轨编曲工作台的样子，让用户能立即理解能力边界。master 真实生效让用户听到混音效果，占位 stem 提示用户"等接入分离后端才会实际播放"——这比隐藏 stem 轨更诚实。
- **Web Audio API 而非 audio.volume**：audio.volume 只能控制音量（0..1），无法实现 pan、无法实现 gain > 1.0。Web Audio API 的 GainNode + StereoPannerNode 能完整支持 stem 字段范围（gain 0..1.5，pan -1..1）。
- **createMediaElementSource 不可撤销**：一旦调用，audio 元素的输出就只能通过 graph 走。这是 Web Audio API 的设计约束，不是 bug。setup 只执行一次，失败时降级到 audio.volume。
- **占位 stem 不实际播放**：占位 stem 没有 audio 节点，参数只保存与展示。这样避免误导用户以为"调整 drums gain 已经改变了鼓组音量"。
- **solo 优先于 mute**：与所有 DAW 一致。如果有任意 stem solo，只 solo 的 stem 发声；否则所有未 mute 的 stem 发声。
- **input 不记 undo，change 才记 undo**：拖动 gain 滑块会产生大量中间值，每个值都记 undo 会污染历史。input 事件实时改值与播放，change 事件（拖动结束）才记 undo。
- **stem 字段不能锁定**：stem 来自分离后端，不是用户手工编辑结果，所以不适用字段级锁定。用户调整 stem 参数本身已经是非破坏编辑，没有"重生成覆盖"的风险。
- **导入时严格校验 stem id**：只接受 `{master, drums, bass, other}` 集合内的 id，避免恶意/损坏项目文件注入未知 stem。必须存在 master 轨；缺失时整套回退到默认。

## 未决问题 / 下一步

- 真实浏览器回归：stem mute/solo/gain/pan 实际播放效果、项目往返、撤销/重做。
- P1.2 轮 2：钢琴卷帘 + NoteEvent 数据模型（创建/移动/拉伸/拆分/合并）。
- P1.2 轮 3：量化、反拍、三连音、附点、Swing 网格。
- P1.2 轮 4：非破坏混音参数（cut/warp/effect）+ 原始/重合成试听切换。
- 接入 Demucs / Basic Pitch 后端后，把占位 stem 替换为真实分离 stem，并把转录音符挂到对应 stem 轨。
- 桌面壳验证：Electron 43.x 最小封装 + 三平台构建矩阵。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待最终测试、提交和推送。
