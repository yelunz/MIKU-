# 2026-07-20 / 014 / P1.2 轮 4：非破坏混音参数 + A/B 试听切换

## 本轮目标

按 `docs/MULTITRACK_COMPOSITION_DESIGN.md` 的设计，落地 P1.2 阶段第四项能力：在 stem 混音器上新增非破坏混音参数（trim 裁切 + fade 淡入淡出），并提供 A/B 试听切换（edited / original），让用户在不修改原始音频的前提下对比"编辑后"与"原始"混音效果。这是多轨编曲工作台从"参数保存"走向"参数真实生效"的关键一步，也是后续接入 warp marker、效果器等更多非破坏参数的承载基础。

## 用户确认的要求

- 用户最新要求：全程自动迭代，直到获取可用的第一版软件后再进行测试；不影响电脑、无威胁性的沙盒命令全部自动放行，无需手动操作。
- AGENTS.md 已规定"本地优先"，所有非破坏混音参数随项目持久化到本地 JSON；占位 stem 的参数也保存，等接入分离后端时复用。
- MULTITRACK_COMPOSITION_DESIGN.md 已规定"第一版采用非破坏编辑：原始音频永不覆盖；裁切、音量、声像、静音、独奏、时间伸缩、warp marker 和效果只保存参数"。
- 同设计文档已规定 stem 与音符转录是不同过程；本轮只做 stem 轨的 trim/fade 参数与 A/B 试听，不混入 warp marker（等下一轮做时间伸缩）。

## 子 Agent 分工

本轮为单一耦合实现（trim/fade 数据模型、UI、事件、项目持久化、Web Audio API 包络、A/B 切换全部共享 state 与 renderAll），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主 Agent 完成。

## 执行内容

### 非破坏混音参数数据模型

- `defaultStemTracks()` 每个 stem 新增 4 个字段：
  - `trimStartSeconds`（裁切起始秒数，默认 0）
  - `trimEndSeconds`（裁切结束秒数，默认 0 = 到音频结尾）
  - `fadeInSeconds`（淡入秒数，默认 0）
  - `fadeOutSeconds`（淡出秒数，默认 0）
- `state.stemPreviewMode: "edited" | "original"`，默认 `"edited"`
- 所有字段都是非破坏参数：原始音频永不覆盖，只保存参数；播放时根据参数实时计算 gain 包络与 trim 边界。

### 非破坏参数生效函数

- `stemEffectiveTrimRange(track)`：
  - edited 模式：返回 `{ start: trimStart, end: trimEnd }`，clamp 到 0..duration
  - original 模式：返回 `{ start: 0, end: state.duration }`（忽略 trim）
  - trimEnd = 0 表示"不裁切，到音频结尾"
- `stemEffectiveFade(track)`：
  - edited 模式：返回 `{ fadeIn, fadeOut }`，clamp 到 ≥ 0
  - original 模式：返回 `{ fadeIn: 0, fadeOut: 0 }`（忽略 fade）
- `applyMasterFadeEnvelope()`：
  - 用 master stem 的 `effectiveGain` + `trimRange` + `fade` 构造 GainNode 包络
  - `linearRampToValueAtTime` 实现淡入（0 → effectiveGain）
  - `linearRampToValueAtTime` 实现淡出（effectiveGain → 0）
  - 播放头在 trim 范围外时直接静音（gain = 0）
  - 取消所有已调度值（`cancelScheduledValues`）后重新构造，避免叠加
- `enforceMasterTrimBoundary()`：
  - original 模式直接返回（无 trim）
  - 播放头 < trimStart 时跳到 trimStart
  - 播放头 > trimEnd 时暂停并定位到 trimEnd

### 播放集成

- `togglePlayback()` 在播放前读取 master stem 的 trimRange：
  - 从头播放时定位到 trimStart（edited 模式）
  - 播放头在 trim 范围外时重新定位到 trimStart
  - 选区起点在 trim 范围内时优先使用选区起点
- `timeupdate` 事件监听新增 `enforceMasterTrimBoundary()` 与 `applyMasterFadeEnvelope()`
- `seeked` 事件监听新增 `applyMasterFadeEnvelope()` 与 `enforceMasterTrimBoundary()`
- 这样用户在播放过程中拖动播放头或修改 trim/fade 参数都能实时听到效果

### UI 渲染

- `buildStemRow(track)` 新增 trim/fade 输入组：
  - `trimGroup`（div.stem-number-group）：裁切起（秒）+ 裁切止（秒）
  - `fadeGroup`（div.stem-number-group）：淡入（秒）+ 淡出（秒）
  - 每个 input 是 `<input type="number" min="0" step="0.01">`，通过 `dataset.stemControl` 标识字段
  - 使用 `createElement` + `textContent` 而非 `innerHTML`（与既有规则一致）
- `.stem-controls` grid 从 5 列扩展到 7 列（auto auto 1fr 1fr auto auto auto），容纳新增的 trim/fade 组

### 事件委托重构

- `numberFieldClamps` 对象统一处理所有 number 字段的 clamp：
  - `gain`: 0..1.5
  - `pan`: -1..1
  - `trimStartSeconds`: ≥ 0
  - `trimEndSeconds`: ≥ 0
  - `fadeInSeconds`: ≥ 0
  - `fadeOutSeconds`: ≥ 0
- `input` 事件：实时改值 + `applyStemMix` + `applyMasterFadeEnvelope`，不记 undo（拖动过程中不污染历史）
- `change` 事件：拖动结束才 `editGraph.begin` + 记 undo + `renderStemMixer`
- `formatStemFieldValue` 新增 trim/fade 字段格式化：`${value.toFixed(3)} 秒`

### A/B 试听切换控件

- HTML 在 stem-mixer-header 与 stem-mixer 之间新增 `.stem-preview-toolbar`：
  - `<select id="stem-preview-mode">` with two options:
    - `edited`（编辑后，应用裁切/淡入淡出）
    - `original`（原始，忽略非破坏参数）
  - `.stem-preview-hint` 说明两种模式差异
- `elements.stemPreviewMode` 引用
- `change` 事件绑定：切换时立即 `applyStemMix` + `applyMasterFadeEnvelope` + `enforceMasterTrimBoundary`，让用户听到差异；不记 undo（试听模式不属于编辑操作）

### 撤销/重做与项目持久化

- EditGraph `snapshot()` 包含 `stemPreviewMode: state.stemPreviewMode`
- EditGraph `restore(snapshot)` 恢复 stemPreviewMode，并对 trim/fade 字段做向前兼容（旧快照缺失时回退到 0）
- `resetEditingState()` 重置 stemPreviewMode = "edited" 并同步 UI
- `exportProject()` 的 `stem_tracks` 新增 `trim_start_seconds` / `trim_end_seconds` / `fade_in_seconds` / `fade_out_seconds`
- `exportProject()` 的 `preferences` 新增 `stem_preview_mode`
- `importAnchorsAndRegions()` 加载 stem_tracks 的 trim/fade 字段（clamp 到 0..duration）
- `importAnchorsAndRegions()` 新增偏好加载块（修复预存在 bug：0.2.0 项目此前不恢复 snap/dotted/swing/stem_preview_mode 偏好）
- `migrateLegacyProject()` 重置 stemPreviewMode = "edited"（0.1.0 项目无此字段）

### CSS 样式

- `.stem-number-group`：grid 2 列，容纳 trim/fade 各两个 input
- `.stem-number`：label 容器，含 caption + input
- `.stem-number input`：4.5rem 宽，等宽字体，focus 时 accent 描边
- `.stem-preview-toolbar`：flex 布局，虚线边（区别于 stem 行的实线边），淡色背景
- `.stem-preview-hint`：muted 文本，max-width 60ch

## 修改文件

- `prototype/web-workbench/app.js`：defaultStemTracks 扩展字段、state.stemPreviewMode、stemEffectiveTrimRange/stemEffectiveFade/applyMasterFadeEnvelope/enforceMasterTrimBoundary、togglePlayback 应用 trim、timeupdate/seeked 事件监听、buildStemRow 新增 trim/fade 输入、numberFieldClamps 重构、formatStemFieldValue 新字段、EditGraph snapshot/restore、elements.stemPreviewMode + 事件绑定、exportProject trim/fade + stem_preview_mode、importAnchorsAndRegions 加载 trim/fade + preferences、migrateLegacyProject 重置 stemPreviewMode、resetEditingState 重置 stemPreviewMode
- `prototype/web-workbench/index.html`：stem-preview-toolbar section（含 select + hint）、stem-mixer-card 副标题更新（提及 trim/fade）
- `prototype/web-workbench/styles.css`：.stem-controls grid 7 列、.stem-number-group / .stem-number / .stem-number input / .stem-number input:focus、.stem-preview-toolbar / .stem-preview-toolbar .compact-control / .stem-preview-hint
- `tests/test_web_workbench_static.py`：新增 `test_nondestructive_mix_and_preview_toggle_are_present`
- `CHANGELOG.md`、`docs/ROADMAP.md`、`project-state.json`、`prototype/web-workbench/README.md`、本轮日志

## 验证

- `node --check prototype/web-workbench/app.js` 与 `node --check prototype/web-workbench/desktop-bridge.js`：语法通过。
- `python -m unittest discover -s tests -v`：26 项通过（4 项音频分析 CLI + 22 项 Web 工作台静态测试，新增 1 项：`test_nondestructive_mix_and_preview_toggle_are_present`）。
- `project-state.json` JSON 解析通过。
- 真实浏览器回归测试本轮未执行；下一轮在桌面壳封装完成后一起做（覆盖 trim/fade 实际播放效果、A/B 切换、项目往返、撤销/重做）。

## 决定与理由

- **trim/fade 在所有 stem 上都呈现参数 UI**：占位 stem 也保存参数，等接入分离后端时复用。这与 011 轮 mute/solo/gain/pan 的设计一致——混音参数属于非破坏编辑层，不是"有音频才需要"。
- **master stem 的 trim/fade 真实生效，占位 stem 只保存参数**：第一版没有真实分离音频，但 master 通过 Web Audio API 真实生效让用户听到 trim/fade 效果。占位 stem 的参数会随项目持久化，等接入 Demucs 后端后自动复用——这比隐藏参数更诚实。
- **trimEndSeconds = 0 表示"不裁切，到音频结尾"**：避免用户必须手动填入 duration。clamp 到 0..duration 保证不会越界。
- **applyMasterFadeEnvelope 用 linearRampToValueAtTime 而非 setValueCurveAtTime**：linearRamp 更简单，且 Web Audio API 对 linearRamp 的支持更稳定。fade 时长通常较短（0.x 秒），线性变化已经足够自然。
- **A/B 切换不记 undo**：试听模式是"听感对比"工具，不是编辑操作。切换不会改变任何数据，只改变"是否应用非破坏参数"。如果记 undo 会让历史栈充满无意义的试听切换。
- **original 模式仍保留 gain/pan/mute/solo**：A/B 对比的目的是"听 trim/fade 的差异"，不是"听所有参数的差异"。gain/pan/mute/solo 属于基础混音，不是非破坏参数，所以在两种模式下都生效。
- **修复 0.2.0 项目偏好不恢复的预存在 bug**：importAnchorsAndRegions 此前完全不加载 preferences，导致 0.2.0 项目重新打开后 snap/dotted/swing 都回到默认。本轮一并补齐，并加入 stem_preview_mode。这是本轮意外发现的 bug，修复不影响既有项目（缺失字段时回退默认）。
- **numberFieldClamps 统一处理所有 number 字段**：避免每个字段单独写 clamp 逻辑。新增字段只需在 clamps 对象中加一行。input 事件实时改值不记 undo，change 事件才记 undo，与既有 stem 滑块行为一致。

## 未决问题 / 下一步

- 真实浏览器回归：trim/fade 实际播放效果、A/B 切换听感、项目往返、撤销/重做。
- 桌面壳封装：Electron 43.x 最小封装 + 三平台构建矩阵准备。
- 可用第一版软件打包（Windows x64 优先），交付测试。
- 后续：warp marker（时间伸缩）与效果器参数（EQ / 压缩 / 混响）作为下一轮非破坏参数扩展。
- 后续：trim/fade 在占位 stem 上真实生效（等接入 Demucs 后端后，每条 stem 独立 AudioBufferSourceNode + 自身 GainNode 包络）。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待最终测试、提交和推送。
