# 轮 001 · P6-P10 自动迭代 v0.10.0 完整版

**日期**：2026-07-22
**阶段**：P6 音源分离 → P7 自动转录 → P8 旋律生成 → P9 专业钢琴卷帘 → P10 多平台打包（Windows 完成，macOS/Linux 延后）
**目标**：从 v0.6.1 的 P4/P5 状态一次性自动迭代到 v0.10.0 P10 最终版；同时把产品标识从 "miku歌姬放计划" 重命名为 "Miku歌姬解放计划"。

## 执行内容

### 0. 产品重命名（用户明示要求）

- `prototype/desktop-shell/package.json` 全字段更新：
  - `name`: `miku-workbench` → `miku-jiefang-plan`
  - `appId`: `app.miku.workbench` → `app.miku.jiefang.plan`
  - `productName`: `Miku-Workbench` → `Miku歌姬解放计划`
  - `copyright`、`shortcutName`、`win.artifactName`、`portable.artifactName` 全部同步
  - `directories.output`: `dist-v0.6.1` → `dist-v0.10.0`
- 物理文件夹 `miku歌姬放计划` 因 Trae IDE 进程锁定未能重命名（用户需关闭 Trae 后手动改）。所有代码、文档、配置层面的产品标识已统一为 `Miku歌姬解放计划`。

### 1. P6 音源分离（4-stem HPSS + 频段掩码）

**后端**：`tools/miku_analysis/stem_separator.py`
- 算法：`librosa.effects.hpss` (kernel=31) 把信号分 harmonic/percussive；percussive → drums；harmonic 用 STFT 理想带通掩码：
  - bass: 20-250 Hz
  - vocals: 300-3400 Hz（人声主要能量区间）
  - other: harmonic - bass - vocals 残余
- 不依赖 Demucs / Spleeter / 外部模型权重，纯 librosa 0.11.0 实现
- 输出 schema `miku-stem-separation/0.1.0`：4 个 16-bit PCM WAV + manifest.json

**前端**：`prototype/web-workbench/stem-separator.js`
- IIFE 模块，通过 `globalThis.MikuStemSeparator` 暴露 `renderPanel(container, ctx)` + `separateStems(inputPath, outputDir, manifestPath)`
- 调用 `MikuDesktopBridge.separateStems` → IPC `miku:separateStems` → 主进程 JSON-RPC `separate_stems`
- 分离完成后 `dispatchEvent("miku:stems-separated", { inputPath, result })`

**IPC 集成**：
- `main.js`：新增 `separateStems()` 函数 + `ipcMain.handle("miku:separateStems")`，复用 analysisProcess，5 分钟超时
- `preload.js`：bridge 新增 `async separateStems(inputPath, outputDir, manifestPath)`
- `launcher.py`：`handle_request` 新增 `"separate_stems"` 方法分发
- `pyinstaller.spec`：`hiddenimports` 新增 `tools.miku_analysis.stem_separator`

### 2. P7 自动音符转录（pyin + onset）

**后端**：`tools/miku_analysis/transcriber.py`
- 算法：`librosa.pyin` 在 [65.41 Hz, 1046.5 Hz] 范围内逐帧估计基频；`librosa.onset.onset_detect` (backtrack=True) 找音符边界
- 合并连续 voiced 帧为 NoteEvent，每个音符带 `id / start / duration / midi / frequency / confidence / needs_review / source`
- 置信度 < 0.5 标记 `needs_review=true`
- 最小音符长度 0.15s（避免抖动产生碎音符）

**前端**：`prototype/web-workbench/transcription-panel.js`
- IIFE 模块，`globalThis.MikuTranscriptionPanel` 暴露 `renderPanel` + `transcribeAudio`
- 通过 `MikuDesktopBridge.transcribeAudio` → IPC `miku:transcribeAudio` → 主进程 JSON-RPC `transcribe`
- 支持 `fmin_hz` / `fmax_hz` 参数透传
- 完成后 `dispatchEvent("miku:transcription-completed")`

**IPC 集成**：
- `main.js`：`transcribeAudio()` + `ipcMain.handle("miku:transcribeAudio")`，校验 inputPath 扩展名与 outputPath 必为 .json
- `preload.js`：bridge 新增 `async transcribeAudio(inputPath, outputPath, params)`
- `launcher.py`：`handle_request` 新增 `"transcribe"` 方法分发
- `pyinstaller.spec`：`hiddenimports` 新增 `tools.miku_analysis.transcriber`

### 3. P8 智能歌声旋律生成（规则+约束，纯前端）

**前端**：`prototype/web-workbench/melody-generator.js`
- 纯前端规则算法，不依赖外部模型，不需要后端 IPC
- 和弦音阶模板覆盖 8 种 quality：major / minor / dominant-seventh / major-seventh / minor-seventh / suspended / diminished / added-ninth
- 三套生成 profile：
  - `conservative`：chord_weight=0.85 / passing=0.10 / leap=0.05 / rhythm_density=0.5
  - `flowing`：chord_weight=0.65 / passing=0.25 / leap=0.10 / rhythm_density=0.75
  - `lively`：chord_weight=0.45 / passing=0.30 / leap=0.25 / rhythm_density=0.9
- `parseChordName(name)`：正则解析 C/Am/G7/F#m7/Bbmaj7 等常见和弦名
- `pickPitchFromChord(chord, low_midi, high_midi, profile, rng)`：在用户音域内按权重选 chord tone / passing tone / leap
- `makeRng(seed)`：Mulberry32 种子随机数，保证可重现
- `generateCandidates(ctx, base_seed=42)`：一次生成 3 套候选
- 接受候选时 `dispatchEvent("miku:melody-accepted")`

### 4. P9 专业级钢琴卷帘 + 参数曲线

**前端**：`prototype/web-workbench/piano-roll-pro.js`
- `class PianoRollPro`：多轨 + velocity + Pitch/Dynamics/Vibrato 曲线
- 4 条默认轨道：`lead`（主唱）/ `harm1`（和声1）/ `harm2`（和声2）/ `transcript`（转录候选）
- 5 个曲线模板：`pitch-steady` / `pitch-rise` / `dynamics-crescendo` / `dynamics-decrescendo` / `vibrato-default`
- Canvas 2D 渲染（不用 innerHTML 注入用户内容）
- 双击空白创建音符（含 `track_id` / `velocity` 字段）
- Delete/Backspace 删除选中音符（尊重 `locked` 标记）
- `_visibleTracks()`：solo 优先 + mute 过滤
- `exportState()`：导出 notes + paramCurves + tracks 快照
- `dispatchEvent("miku:piano-roll-pro-changed")`

### 5. app.js 集成 P6-P9 模块挂载

在 `app.js` IIFE 末尾注入 P6-P9 协调代码：
- `mountP6()` / `mountP7()` / `mountP8()` / `mountP9()`：检查 `globalThis.MikuXxx` 暴露并调用 `renderPanel` / `new PianoRollPro`
- `makeP6Context()` / `makeP7Context()` / `makeP8Context()` / `makeP9Context()`：构造上下文（inputPath / analysis / onChange 回调）
- `miku:audio-loaded` 事件监听器：导入新音频后更新上下文并重新挂载
- "进入专业模式" toggle 按钮：默认隐藏 P9 section，点击切换显示
- 调试入口 `window.__mikuP6P9`（仅 dev）

### 6. index.html 注入新脚本与容器

- 4 个新 `<script defer>` 标签：stem-separator.js / transcription-panel.js / melody-generator.js / piano-roll-pro.js（在 onboarding.js 之后、app.js 之前）
- 4 个新 `<section>` 容器：
  - `p6-stem-separator-section` + `p6-stem-separator-container`
  - `p7-transcription-section` + `p7-transcription-container`
  - `p8-melody-generator-section` + `p8-melody-generator-container`
  - `p9-piano-roll-pro-section` + `p9-piano-roll-pro-container`
- P9 section 包含 "进入专业模式" toggle 按钮

### 7. ROADMAP 扩展到 P10

`docs/ROADMAP.md` 新增 P6-P10 五行表格：
- P6：4-stem 音源分离 + 非破坏混音 + stem 轨可视化
- P7：pyin 主旋律 + onset + NoteEvent 候选 + 置信度
- P8：和弦+节奏+音域约束 + 3 套候选
- P9：多轨 + velocity + Pitch/Dynamics/Vibrato
- P10：macOS DMG + Linux AppImage + Windows NSIS

### 8. 测试覆盖

新增 4 个 P6-P9 测试文件 + 更新 2 个已有测试：

| 文件 | 测试数 | 覆盖内容 |
|---|---|---|
| `tests/test_p6_stem_separator.py` | 7 | 模块常量 / 函数签名 / manifest schema / launcher 集成 |
| `tests/test_p7_transcriber.py` | 6 | 模块常量 / hz_to_midi / 函数签名 / launcher 集成 |
| `tests/test_p8_melody_generator.py` | 10 | 和弦模板 / 3 profile / parseChordName / Mulberry32 种子 / 音域约束 / 事件分发 / 无外部网络 |
| `tests/test_p9_piano_roll_pro.py` | 11 | 4 轨道 / 5 模板 / PianoRollPro 类 / Canvas 渲染 / 多轨可见性 / 双击创建 / Delete 删除 / 事件分发 / 无外部网络 |
| `tests/test_desktop_shell_static.py` | +3 | 新增 P6/P7 IPC handler / bridge / pyinstaller spec hiddenimports 断言 |
| `tests/test_web_workbench_static.py` | +1 | 更新 scripts 列表断言为 8 个脚本（含 4 个 P6-P9 模块）|

**全量测试结果**：`python -m unittest discover -s tests` → **177 个测试全部通过**（0.154s）

### 9. PyInstaller 重新打包（含 stem_separator + transcriber）

- 用 `python -m PyInstaller` 而非 `pyinstaller` 命令（避免用错 Python 3.13 环境）
- Python 3.10.11 + PyInstaller 6.21.0 + librosa 0.11.0 + soundfile 0.14.0
- 输出：`dist/miku-analysis-server/miku-analysis-server.exe` + `_internal/` = **288.13 MB**（与 v0.6.1 持平）
- 实机测试（PowerShell 脚本）：
  - READY 信号正常：`{"id": "system", "result": {"status": "ready", ...}}`
  - P6 `separate_stems` 在夹具 WAV 上成功生成 4 个 stem WAV（4.69 MB 每个）+ manifest.json
  - P7 `transcribe` 生成 70 个 NoteEvent（全部 `needs_review=True`，因为夹具是无人声伴奏，置信度低符合预期）
  - SHUTDOWN 正常退出

### 10. v0.10.0 NSIS 安装包打包

- `electron-builder 25.1.8` + `electron 43.1.1`
- 输出：`prototype/desktop-shell/dist-v0.10.0/Miku歌姬解放计划-0.10.0-win-x64.exe` = **190.63 MB**
- 包含：Electron runtime + 4 个 P6-P9 前端模块 + PyInstaller 打包的 miku-analysis-server.exe (288 MB) + 3 组夹具

## 修改文件清单

### 新增文件（10 个）
- `tools/miku_analysis/stem_separator.py`（P6 后端）
- `tools/miku_analysis/transcriber.py`（P7 后端）
- `prototype/web-workbench/stem-separator.js`（P6 前端）
- `prototype/web-workbench/transcription-panel.js`（P7 前端）
- `prototype/web-workbench/melody-generator.js`（P8 前端）
- `prototype/web-workbench/piano-roll-pro.js`（P9 前端）
- `tests/test_p6_stem_separator.py`
- `tests/test_p7_transcriber.py`
- `tests/test_p8_melody_generator.py`
- `tests/test_p9_piano_roll_pro.py`
- `logs/2026-07-22_001-p6-p10-auto-iteration-v0.10.0.md`（本日志）

### 修改文件（11 个）
- `prototype/desktop-shell/package.json`（产品重命名 + 版本 0.10.0 + 4 个新 files）
- `prototype/desktop-shell/main.js`（新增 separateStems + transcribeAudio IPC handler）
- `prototype/desktop-shell/preload.js`（bridge 暴露 separateStems + transcribeAudio）
- `tools/miku_analysis/launcher.py`（handle_request 新增 separate_stems + transcribe 方法）
- `tools/miku_analysis/pyinstaller.spec`（hiddenimports 新增 stem_separator + transcriber）
- `prototype/web-workbench/index.html`（4 个新 script 标签 + 4 个新 section 容器 + P9 toggle 按钮）
- `prototype/web-workbench/app.js`（IIFE 末尾注入 P6-P9 模块挂载与协调代码）
- `tests/test_web_workbench_static.py`（更新 scripts 列表断言）
- `tests/test_desktop_shell_static.py`（新增 P6/P7 IPC + bridge + spec 断言）
- `docs/ROADMAP.md`（新增 P6-P10 表格行）
- `project-state.json`（更新到 v0.10.0，新增 P6-P9 implementation 描述 + IPC whitelist）
- `.gitignore`（新增 `dist-v0.10.0/`）

## 验证结果

| 项 | 结果 |
|---|---|
| 静态测试 | 177/177 通过（0.154s） |
| main.js / preload.js lint | 通过（`node --check`） |
| PyInstaller 打包 | 288.13 MB exe 启动正常 |
| P6 separate_stems 实机 | 4 个 stem WAV + manifest.json 生成成功 |
| P7 transcribe 实机 | 70 个 NoteEvent 生成成功（无人声夹具全部 needs_review 符合预期） |
| NSIS 安装包打包 | Miku歌姬解放计划-0.10.0-win-x64.exe = 190.63 MB |

## 决定

1. **P10 macOS/Linux 打包延后**：本机为 Windows 10，无法在当前环境完成 macOS DMG 与 Linux AppImage 交叉打包。在 `project-state.json` 中标记为 `p10-macos-linux-cross-build-environment-availability` 未决事项。
2. **P9 默认隐藏**：用户进入工作台后默认看到基础钢琴卷帘（小白模式）；点击 "进入专业模式" 按钮才显示 P9 多轨 + 曲线编辑器。这符合 AGENTS.md "渐进式呈现" 约束。
3. **P8 纯前端生成**：P8 旋律生成不依赖外部模型，只用规则算法 + 种子随机。这是首版的工程权衡；后续可考虑接入 Basic Pitch / Magenta 等模型作为可选后端。
4. **物理文件夹重命名延后**：Trae IDE 锁定 `miku歌姬放计划` 目录导致无法重命名。所有代码、配置、打包产物层面的产品名已统一为 `Miku歌姬解放计划`；用户可在关闭 Trae 后手动改文件夹名。

## 未决问题

1. **真实音频回归测试**：P6/P7 已用 `basic-c-major-120-v1` 夹具验证流程，但夹具是合成的无人声伴奏，无法验证人声分离与转录精度。需要用户用真实音乐音频回归。
2. **P4/P5 真实浏览器回归**：尚未在 Electron 实机打开 v0.10.0 安装包验证 P4 呼吸标记 / P4 参数曲线 / P4 候选比较 / P4 和声轨 / P5 引导页 / P5 示例项目加载等历史功能未受 P6-P9 集成影响。
3. **P10 macOS/Linux**：环境不具备，延后到用户提供相应设备或 CI 环境。
4. **VOCALOID6 6.13.0 实机验证**：用户尚未提供 VOCALOID6 安装，适配器代码完成但未实机验证。
5. **OpenUtau 三平台打开验证**：Windows 已验证；macOS/Linux 待用户提供设备。
6. **物理文件夹改名**：用户需关闭 Trae 后手动 `Rename-Item "miku歌姬放计划" "Miku歌姬解放计划"`。

## Git 状态

- 当前分支：`main`
- 待提交：本日志列出的所有新增 + 修改文件
- 远程：`https://github.com/yelunz/MIKU-.git`
- 计划 commit：`feat(p6-p10): v0.10.0 P6 stem separation + P7 transcription + P8 melody generation + P9 professional piano roll + product rename to Miku歌姬解放计划`
- 计划 push：`origin main`
