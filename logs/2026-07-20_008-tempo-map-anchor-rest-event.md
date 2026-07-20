# 2026-07-20 / 008 / 引入 sample + PPQ 960 + Anchor 双时间模型与显式 RestEvent

## 本轮目标

推进 P1.1 编辑器手感收尾的最后一项：用 sample + PPQ 960 + 共享 `Anchor` 替换独立的浮点秒边界，把休止从"渲染时根据空隙推算"升级为显式 `RestEvent` 数据，并保证旧版 0.1.0 项目能无破坏迁移到 0.2.0。

## 用户确认的要求

- 用户最新确认的下一步仍是 `finish-p1.1-editor-interactions-with-shared-anchor-and-explicit-rest-model`（来自 `project-state.json` 的 `next_actions`）。
- AGENTS.md 已规定"连续歌词/音符区域必须共享边界或明确显示休止，不得用互不关联的浮点起止制造无意义小缝"，本轮是该规则在数据层的落实。
- 设计文档 `docs/MULTITRACK_COMPOSITION_DESIGN.md` 早已规定 sample + PPQ 960 + Anchor 三件套，本轮把规格变成可运行实现。

## 子 Agent 分工

本轮为单一耦合重构（同一份 app.js 的时间模型替换），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主 Agent 完成。

## 执行内容

### TempoMap

- 从 `analysis.source_audio.sample_rate_hz` 与 `analysis.tempo.candidates[0]` 派生 `state.tempoMap`。
- 字段：`sampleRateHz`、`ppq = 960`、`bpm`、`firstBeatSeconds`、`firstBeatSample = round(firstBeatSeconds * sampleRateHz)`、`firstBeatTick = 0`、`ticksPerSecond = bpm / 60 * ppq`、`samplesPerTick = sampleRateHz / ticksPerSecond`。
- `sampleToTick(sample)` 与 `tickToSample(tick)` 以 `(firstBeatSample, firstBeatTick)` 为锚点线性映射；sample 是音频定位权威基准，tick 派生自 sample。

### Anchor 表

- `state.anchors: Map<id, { id, sample, tick }>`。
- 创建：`createAnchorAtSample(sample)` 自动生成 `anchor-N` 不重复 ID。
- 查找：`findAnchorBySample(sample, toleranceSeconds)` 在 5 ms 容差内寻找最近 anchor，用于避免在共享边界附近创建重复 anchor。
- 移动：`moveAnchor(anchorId, sample)` 同步更新 sample 与 tick。
- 清理：`pruneAnchors()` 删除未被任何 lyric/rest 引用的 anchor，避免表无限增长。

### LyricRegion 改造

- 旧字段 `{ id, start, end, language, text }`（秒）替换为 `{ id, startAnchorId, endAnchorId, language, text }`。
- 连续模式下相邻歌词共享 anchor：`previous.endAnchorId === next.startAnchorId`。这是数据层共享，不是渲染时拼合。
- 移动共享 anchor 是一次操作，自动同时改变两侧 region，从根上消除漏缝。
- `saveLyricRegion` 在新建或编辑时优先复用相邻 anchor；只有当用户主动留出大于吸附单位的空隙时才创建独立 anchor。

### 显式 RestEvent

- 新增 `state.rests: [{ id, startAnchorId, endAnchorId, kind: "rest" }]`。
- 渲染时区分三类块：
  - `lyric-block`：歌词区
  - `explicit-rest`：显式休止（橙色斜纹，可点击编辑/删除）
  - `unassigned-block`：未分配空段（灰色斜纹，可点击转为休止）
- 用户在未分配空段上点击 → 检查器显示"转为显式休止"按钮；在显式休止上点击 → 显示"删除休止"按钮。删除后恢复为未分配空段，不改变其他 region。
- 休止与歌词同样遵守不重叠规则；导入时校验所有 region 之间不存在 sample 重叠。

### 共享边手柄

- 在相邻 region 共享 anchor 的位置渲染一个 `shared-edge-handle` 按钮。
- 拖动通过 `setPointerCapture` 锁定到该 anchor；`pointermove` 时按当前吸附档位吸附到时间网格，并限制不能跨越两侧 region 的另一端 anchor。
- `pointercancel` 与 Esc 取消时回退到原 sample。
- 方向键支持 1 个吸附单位微调。
- 拖动同步刷新选区到当前正在编辑的 region（如果有）。

### 项目 schema 0.2.0

- 新增字段：`tempo_map`、`anchors`、`editing.lyrics[]` 用 anchor_id 引用、`editing.rests[]`。
- 导出时 `serializeAnchors()` 输出当前所有 anchor；导入时 `importAnchorsAndRegions()` 重建 anchors/lyrics/rests，并校验：
  - anchor ID 唯一
  - lyric/rest 引用的 anchor 存在
  - 起止 anchor 不能相同
  - 所有 region 之间不存在 sample 重叠

### 0.1.0 → 0.2.0 兼容迁移

- `migrateLegacyProject` 读取旧版 `editing.lyrics[]`（含 `start/end` 秒），按时间排序。
- 收集每条歌词的 start/end 秒，对相邻歌词（previous.end ≈ next.start within 5 ms）复用同一 anchor，从而保留旧项目里隐含的连续关系。
- 0.1.0 项目中不存在显式 RestEvent，迁移后所有空段都是未分配空段（与旧版渲染一致）。
- 导入后状态栏显示"已导入 0.1.0 项目并迁移到 0.2.0 共享 anchor 模型"。

### 其他修复

- 修复 `validateAnalysis` 在 `short_time_energy.bins` 校验里引用未定义变量 `field` 的潜在 ReferenceError bug（继承自 007 轮，本轮顺手修掉）。
- 删除未使用的 `sortedLyricRegions` / `sortedRestRegions` 函数。

## 修改文件

- `prototype/web-workbench/app.js`
- `prototype/web-workbench/index.html`
- `prototype/web-workbench/styles.css`
- `prototype/web-workbench/README.md`
- `tests/test_web_workbench_static.py`
- `docs/ROADMAP.md`（仅更新 P1.1 已实现/未实现清单）
- `CHANGELOG.md`
- `project-state.json`
- `logs/2026-07-20_008-tempo-map-anchor-rest-event.md`

注：`docs/ARCHITECTURE.md` 与 `docs/MULTITRACK_COMPOSITION_DESIGN.md` 早已在设计层描述 sample + PPQ + Anchor 与显式 RestEvent，本轮实现正好对齐，无需修改。

## 验证

- `python -m unittest discover -s tests -v`：18 项通过（4 项音频分析 CLI + 14 项 Web 工作台静态测试，新增 3 项：`test_tempo_map_and_anchor_model_are_present`、`test_rest_events_are_first_class_data`、`test_legacy_project_migration_is_present`）。
- `node --check prototype/web-workbench/app.js` 与 `node --check prototype/web-workbench/desktop-bridge.js`：语法通过。
- `project-state.json` JSON 解析通过。
- 真实浏览器交互测试本轮未执行，因为本轮修改集中在数据模型和静态结构；下一轮应在 Windows Edge 上验证：建立连续歌词 → 拖动共享边手柄 → 验证两侧同时变化；建立未分配空段 → 转为休止 → 删除休止；导出 0.2.0 项目 → 重新导入；导入 0.1.0 旧项目验证迁移。

## 决定与理由

- **sample 为权威基准**：浮点 tick 在跨平台/跨语言互转时容易漂移；sample 是整数，且对应真实音频帧位置。所有 anchor 都先存 sample 再算 tick。
- **PPQ 固定 960**：与 DAW 通用值一致，便于后续 MIDI 导出和与 Synthesizer V / OpenUtau 互转。
- **0.1.0 兼容迁移**：项目早期已有 0.1.0 导出文件在用户机器上；任何破坏性 schema 升级都必须能从旧版无破坏迁移，避免用户丢失工作。
- **不引入撤销/重做栈**：本轮范围已经较大；撤销/重做需要单独一轮设计（要考虑 anchor 移动、region 增删、和弦修正等多种操作的差异表示）。`next_actions` 中明确列为后续项。
- **未实现歌词块整体拖动**：共享边手柄已经覆盖了最关键的"边界共享"诉求；歌词块整体拖动需要在拖动时同时移动起止 anchor 并保持长度，是独立交互，留待下一轮。

## 未决问题 / 下一步

- 撤销/重做栈（EditGraph 的第一版）。
- 歌词块整体拖动与拉伸。
- 缩放锚点（鼠标位置或播放头锚定）。
- 自动滚动跟随播放头。
- 字段级锁定（防重生成覆盖）。
- 真实浏览器回归：连续歌词共享边拖动、显式休止创建/删除、0.2.0 项目往返、0.1.0 项目迁移。
- 进入 P1.2 多轨与音符工作台：钢琴卷帘、量化、反拍、三连音、Swing。
- P1.3 分析后端对比：librosa / Basic Pitch / Demucs 许可与三平台 spike。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待最终测试、提交和推送。
