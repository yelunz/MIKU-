# 2026-07-20 / 017 / P3 首批引擎适配器：MIDI 基线 + USTX 0.6 + SynthV 1.9.0 配套脚本

## 本轮目标

按 `docs/ROADMAP.md` P3 阶段首批目标，落地三件事：

1. **MIDI 基线导出器**（`tools/export_midi.py`）：Type-1 SMF，含音符、速度、拍号、lyric meta event。
2. **OpenUtau USTX 0.6 导出器**（`tools/export_ustx.py`）：JSON 文本 USTX 0.6 工程，含音符、速度、拍号、歌词、phoneme 占位。
3. **Synthesizer V Studio Pro 1.9.0 配套脚本骨架**：
   - `tools/synthv_helper_script_es5.js`（ES5 风格 helper 脚本）
   - `tools/synthv_sidecar_schema.md`（sidecar JSON 字段规范）
   - `tools/export_synthv_sidecar.py`（sidecar JSON 导出器）
4. **测试套件**（`tests/test_engine_adapters.py`）：覆盖所有适配器（16 项测试）。
5. **使用文档**（`docs/ENGINE_ADAPTERS.md`）：操作指南与字段损失报告。

## 用户确认的要求

- 用户最新要求：实现 P3 首批引擎适配器的可运行原型；不执行 `git commit` / `git push`，由主 Agent 处理提交。
- AGENTS.md 已规定"第三方集成优先使用厂商公开的导入/导出格式、脚本 API 或插件 API；不要依赖脆弱的界面自动点击"——本轮所有适配器只生成公开格式的文件。
- AGENTS.md 已规定"OpenUtau 不得因新增 VOCALOID 目标而降级；首个端到端工程导出验收必须包含 USTX 0.6 和三平台打开验证"——本轮生成 USTX 0.6 文件作为首个端到端导出原型。
- AGENTS.md 已规定"首批适配目标为用户现有的 Synthesizer V Studio Pro 1.9.0 和验证时最新版稳定版 OpenUtau"——本轮 SynthV 适配器声明 `minEditorVersion: 0x010900`，OpenUtau 目标版本为 0.1.565。
- AGENTS.md 已规定"音源分离、音频转录和歌声旋律生成是三个独立过程，不得把 stem 当成 MIDI，也不得把伴奏转录当成已经存在的人声旋律"——本轮适配器只处理已存在的 NoteEvent / Syllable / RestEvent，不引入新的转录或生成逻辑。
- 任务规范明确："适配器只做'中立项目模型 → 外部格式'的字段转换；不得反向影响 web-workbench 的数据结构"——本轮所有适配器只读 `miku-workbench-project/0.3.0` JSON，不写回 web-workbench。
- 任务规范明确："不直接读写专有二进制格式"——`.svp` / `.vpr` / `.vsqx` 不直接读写；SynthV 通过 MIDI + 配套脚本 + sidecar JSON 实现；VOCALOID6 留待 P3.5。
- 任务规范明确："SynthV 配套脚本必须 ES5"——本轮 helper 脚本严格 ES5，无 `=>` / 模板字符串 / `const ` / `let `。

## 子 Agent 分工

本轮为单一耦合实现（MIDI / USTX / sidecar 三个导出器共享中立项目模型解析逻辑，配套脚本依赖 sidecar schema，测试套件需同时覆盖三个适配器），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主实现 Agent 完成。

## 执行内容

### 中立项目模型解析（共享模块）

三个 Python 导出器各自实现了一份 `load_project` / `derive_tempo_map` / `build_anchor_index` / `anchor_tick` 辅助函数。本轮未抽出公共模块（避免引入跨文件 import 复杂度）；后续 P3.5 引入 VOCALOID 适配器时可考虑重构为 `tools/_neutral_model.py` 共享模块。

### MIDI 基线导出器 `tools/export_midi.py`

- **纯 Python 标准库**：`json` / `struct` / `argparse` / `sys` / `pathlib`，无第三方依赖。
- **SMF Type-1 输出**：
  - MThd header（4 bytes "MThd" + 4 bytes length + 6 bytes data）
    - format = 1（Type-1）
    - num_tracks = 2（tempo track + main track）
    - division = 960（与项目 PPQ 一致）
  - Track 0（tempo track）：tempo meta event（FF 51 03 + 24-bit microseconds/quarter） + time signature meta event（FF 58 04 nn dd cc bb） + end of track（FF 2F 00）
  - Track 1（main track）：每个 NoteEvent → note on (0x90) + note off (0x80)；velocity = round(velocity * 127)；每个 syllable → lyric meta event（FF 05 len text，UTF-8 编码）
- **tick 计算**：优先用 anchors 表中的 tick 字段；缺失时从 sample + tempo_map 派生。
- **CLI**：`python tools/export_midi.py <project.json> <output.mid>`；`--loss-report` 选项输出字段损失报告到 stderr。
- **变量长度编码（VLQ）**：自实现 `encode_variable_length`，正确处理 0..0x0FFFFFFF 范围。

### USTX 0.6 导出器 `tools/export_ustx.py`

- **纯 Python 标准库**：`json` / `argparse` / `sys` / `pathlib`。
- **JSON 文本输出**：UTF-8，缩进 2 空格，末尾换行。
- **USTX 0.6 字段**：
  - `ustx_version: "0.6"`
  - `name` / `output` / `tracks` / `voicecolor` / `phonemizers` / `project` / `parts` / `notes` / `mix`
  - 每个 note 含 `pos`（tick） / `duration`（tick） / `tone`（MIDI pitch） / `lyric`（syllable.reading_override 或 default_reading 或 fallback） / `velocity`（0..200，由 0..1 线性映射） / `phoneme_override`（空字符串占位）
  - tempo 与 time signature 写入 project 部分
  - 默认拍号 4/4
- **CLI**：`python tools/export_ustx.py <project.json> <output.ustx>`；`--loss-report` 选项。

### SynthV 配套脚本骨架

**文件 1：`tools/synthv_helper_script_es5.js`**

- 顶部注释声明 `minEditorVersion: 0x010900` / `maxEditorVersion: 0x010AFF`。
- 严格 ES5：`var` / `function`，无箭头函数、无模板字符串、无 `const` / `let`。
- `checkHostVersion()` 运行时检查 `SV.getHostInfo().version`，1.9.0 以下或 1.11+ 拒绝执行。
- `readSidecar(path)` 读取 sidecar JSON。
- `buildNoteIndex(project)` 遍历工程所有 track/group/note，按 onset 排序。
- `matchSidecarToNotes(sidecarNotes, hostNotes)` 贪心 tick 对齐匹配。
- `applyLyrics(pairs, syllableIndex)` 把 `syllable.reading_override` 或 `default_reading` 或 `text` 写入音符 `lyric` 字段。
- try/catch 包裹，失败时 `SV.finish(error.message)` 退出。
- 不调用 1.11+ 才有的 API；不含 "ARA" / "VoiceToMidi" / "voice_to_midi" 子串。
- 文件末尾注释使用范例。

**文件 2：`tools/synthv_sidecar_schema.md`**

- sidecar JSON 字段规范文档。
- 顶层字段：`schema_version` / `source_project_schema` / `tempo` / `time_signature` / `stem_tracks` / `notes` / `syllables` / `rests` / `loss_report`。
- 每个数组字段的子字段都列了表。
- 描述了 helper 脚本的匹配算法。

**文件 3：`tools/export_synthv_sidecar.py`**

- 纯 Python 标准库。
- 从中立项目 JSON 导出 sidecar JSON。
- CLI：`python tools/export_synthv_sidecar.py <project.json> <output_sidecar.json>`。
- sidecar 中保留 `confidence` / `source` / `stem_tracks` 等无法在 MIDI / SynthV 中表达的元数据。

### 测试套件 `tests/test_engine_adapters.py`

16 项测试覆盖：

1. `test_midi_exporter_outputs_valid_mthd_mtrk`：MThd + 2 个 MTrk。
2. `test_midi_exporter_writes_tempo_meta_event`：FF 51 03 字节序列存在。
3. `test_midi_exporter_writes_time_signature`：FF 58 04 字节序列存在。
4. `test_midi_exporter_writes_note_on_off`：0x90 + 0x80 事件存在。
5. `test_midi_exporter_writes_lyric_meta_events`：FF 05 + 歌词文本存在。
6. `test_midi_exporter_ppq_is_960`：MThd division = 960。
7. `test_midi_exporter_loss_report_to_stderr`：stderr 含 confidence / language / syllable。
8. `test_ustx_exporter_outputs_valid_json`：json.loads 可解析。
9. `test_ustx_exporter_has_ustx_version_0_6`：JSON 含 `"ustx_version": "0.6"`。
10. `test_ustx_exporter_notes_mapped_from_project_notes`：notes 数组长度匹配，tone 正确。
11. `test_ustx_exporter_loss_report_to_stderr`：stderr 含 confidence / stem_tracks。
12. `test_synthv_sidecar_exporter_outputs_valid_json`：sidecar JSON 可解析，schema_version 正确。
13. `test_synthv_helper_script_declares_min_version_010900`：脚本含 `0x010900` 与 `minEditorVersion`。
14. `test_synthv_helper_script_is_es5_compliant`：脚本不含 `=>` / 反引号 / `const ` / `let `。
15. `test_synthv_helper_script_does_not_use_ara_or_voice_to_midi`：脚本不含 `ARA` / `VoiceToMidi` / `voice_to_midi`。
16. `test_all_exporters_handle_empty_project`：空项目（无 notes / lyrics / rests）三个导出器均不抛错。

测试夹具用 `tempfile` + `json` 在 `make_minimal_project()` 中构造，不依赖 `fixtures/` 目录的真实夹具。

### 文档 `docs/ENGINE_ADAPTERS.md`

- 适配器优先级顺序与目标编辑器版本表。
- 4 个 CLI 用法示例（MIDI / USTX / SynthV sidecar / SynthV helper 脚本）。
- 4 个字段损失报告表（MIDI / USTX / SynthV helper / SynthV sidecar）。
- 已知限制（VOCALOID6 留待 P3.5；SynthV 1.11+ 不支持；USTX 字段精确性待实机验证；PPQ 转换；多 stem 扁平化；变速段未引入）。
- 安全提示（不写专有二进制；helper 脚本只读 sidecar 不修改原工程；ES5 风格；运行时版本检查；sidecar 路径需手工指定）。

## 修改文件

- `tools/export_midi.py`（new）
- `tools/export_ustx.py`（new）
- `tools/export_synthv_sidecar.py`（new）
- `tools/synthv_helper_script_es5.js`（new）
- `tools/synthv_sidecar_schema.md`（new）
- `tests/test_engine_adapters.py`（new）
- `docs/ENGINE_ADAPTERS.md`（new）
- 本轮日志（new）

## 验证

- `python -m unittest tests.test_engine_adapters -v`：**16 项通过**。
- `python -m unittest tests.test_web_workbench_static -v`：**32 项通过**（未受本轮修改影响）。
- `python -m unittest tests.test_desktop_shell_static -v`：**15 项通过**（未受本轮修改影响）。
- `python -m unittest tests.test_audio_analysis -v`：**4 项通过**（未受本轮修改影响）。
- 总计 67 项测试全部通过。
- OpenUtau 0.1.565 实机打开 USTX 0.6 文件的验证本轮未执行（需要真实测试环境）；下一轮在 P3 验收时进行。
- Synthesizer V Studio Pro 1.9.0 实机运行 helper 脚本的验证本轮未执行（需要真实测试环境）；下一轮在 P3 验收时进行。

## 决定与理由

- **三个 Python 导出器各自实现一份共享辅助函数（不抽出公共模块）**：本轮三个导出器都很短（每个 < 300 行），抽出公共模块会引入跨文件 import 复杂度，且本轮没有迭代重构需求。后续 P3.5 引入 VOCALOID 适配器时可考虑重构为 `tools/_neutral_model.py` 共享模块。
- **MIDI Type-1 而非 Type-0**：Type-1 把 tempo 与 main 分到两个 track，更易调试与解析；任务规范明确"Type 0 / Type 1"二选一，Type-1 是更通用的选择。
- **MIDI velocity = round(v * 127)，且最小为 1**：MIDI Note On velocity = 0 在部分宿主中被解释为 Note Off；为避免歧义，velocity < 1 时强制为 1。
- **MIDI tick 来自 anchors 表优先**：与 AGENTS.md "sample 是权威基准" 一致——anchor.tick 在 web-workbench 中由 sample 派生，导出器优先用 anchor.tick 保证一致性；缺失时从 sample 重新派生。
- **MIDI 输出不含 negative tick**：anchor.sample < first_beat_sample 时 tick 会为负；导出器 clamp 到 0。已在字段损失报告中记录为"anchor 共享边界退化"。
- **USTX 0.6 用 JSON 文本而非 YAML**：任务规范明确"纯文本 JSON 格式 USTX 工程文件"；调研矩阵第 3.1 节中的 "YAML 风格" 描述与 OpenUtau 实际格式不一致；本轮按任务规范走 JSON。
- **USTX velocity 0..200 范围**：UTAU 传统 0..200；USTX 0.6 实际范围待实机验证；本轮按 UTAU 传统实现，后续验证后可调整。
- **USTX 单声部工程**：USTX 0.6 支持多 track，但本轮只有 master stem；多 stem 音频混音需用户手工在 OpenUtau 内重建 `mix[]` 引用。已在损失报告中记录。
- **SynthV helper 脚本严格 ES5**：与 AGENTS.md "脚本保持 ES5 风格" 一致。脚本不含 `=>` / 模板字符串 / `const ` / `let ` / "ARA" / "VoiceToMidi" / "voice_to_midi" 子串，确保通过测试且不引入 1.11+ 依赖。
- **SynthV helper 脚本运行时版本检查**：与任务规范"运行时检查宿主版本" 一致。1.9.0 以下拒绝执行，1.11+ 拒绝执行；保证只在 1.9.0 / 1.10.x 中运行。
- **SynthV sidecar 不修改原工程**：与任务规范"配套脚本只读 sidecar 不修改原工程" 一致。helper 脚本只调用 `note.setLyric(...)` 修改已导入音符的歌词字段，不调用任何修改工程结构 / 速度图 / 自动化参数的 API。
- **sidecar 中保留 confidence / source / stem_tracks 等元数据**：sidecar 是 SynthV 1.9.0 适配路径上唯一能完整保留中立项目元数据的格式。SynthV 无对应字段，但保留在 sidecar 中供用户人工审阅。
- **测试夹具不依赖 fixtures/ 目录**：与 `tests/test_audio_analysis.py` 既有风格一致——`make_minimal_project()` 用 Python 字典构造夹具，避免引入真实夹具依赖。
- **本轮不写 OpenUtau 实机验证脚本**：OpenUtau 0.1.565 实机打开 USTX 0.6 文件的验证需要真实测试环境，本轮在 Python 测试中只验证 JSON 结构正确性；实机验证留待 P3 验收阶段。
- **本轮不写 SynthV 实机验证脚本**：SynthV 1.9.0 实机运行 helper 脚本的验证需要真实测试环境，本轮在 Python 测试中只验证脚本静态属性（ES5 合规性 / 版本声明 / 不使用禁用 API）；实机验证留待 P3 验收阶段。

## 未决问题 / 下一步

- **OpenUtau 0.1.565 实机验证**：USTX 0.6 文件实际字段名、嵌套结构、PPQ 转换、velocity 范围、phonemizer 名称需在 0.1.565 实机导出后用真实文件比对并固定。
- **Synthesizer V Studio Pro 1.9.0 实机验证**：`SV.getHostInfo()` 返回值结构、`Project.importMidi` 是否支持、`TimeAxis` 重建速度图的精确 API、helper 脚本在三平台的运行一致性。
- **MIDI Lyric Meta Event 编码**：本轮用 UTF-8；不同编辑器（V6.2+ / OpenUtau / SynthV 1.9.0）对 UTF-8 / Shift-JIS / UTF-16 的识别差异需实机验证。
- **多 stem 音频混音**：USTX 0.6 多 stem 转多 `mix[]` 条目需要分离后的音频文件；本轮未引入音源分离后端。
- **变速段**：中立项目模型尚未引入变速段；USTX 0.6 支持 tempo 数组，MIDI 也支持多 tempo meta event，后续可扩展。
- **VOCALOID6 6.13.0 适配器**：留待 P3.5 阶段；本轮未生成 VOCALOID 专属适配器，但 MIDI 基线可作为 V6.2+ 的降级路径。
- **Phonemizer 依赖检查**：USTX 导出后是否能正确发音取决于目标机器上已安装的声库和 Phonemizer；本轮未实现依赖检查。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待主 Agent 提交和推送（任务规范明确要求不执行 git commit/push）。
- 修改文件清单：
  - `tools/export_midi.py`（new）
  - `tools/export_ustx.py`（new）
  - `tools/export_synthv_sidecar.py`（new）
  - `tools/synthv_helper_script_es5.js`（new）
  - `tools/synthv_sidecar_schema.md`（new）
  - `tests/test_engine_adapters.py`（new）
  - `docs/ENGINE_ADAPTERS.md`（new）
  - `logs/2026-07-20_017-p3-engine-adapters-midi-ustx-synthv.md`（new）
