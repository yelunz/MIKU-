# 021 P3.5 VOCALOID6 6.13.0 MIDI 降级适配器

- 日期：2026-07-20（任务指定文件名序号 021；实际执行日 2026-07-21）
- 阶段：P3.5 VOCALOID 适配
- 执行者：主实现子 Agent（GLM-5.2）
- 上游日志：2026-07-20_020-pinyin-kana-table-expansion.md

## 目标

按 `docs/ROADMAP.md` P3.5 阶段与 AGENTS.md "VOCALOID 后续适配目标已选定
为 VOCALOID6 Editor 完整版 6.13.0（Standalone）；旧版本只走明确标注损失
的 MIDI 降级路径" 的要求，落地 5 件事：

1. **新建 `tools/export_vocaloid6.py`**：基于 MIDI 基线导出器，输出
   VOCALOID6 友好的 MIDI 文件 + sidecar 字段损失报告 JSON。
2. **新建 `docs/VOCALOID6_ADAPTER.md`**：字段损失报告 + 编码建议 +
   实机验证清单。
3. **更新 `tests/test_engine_adapters.py`**：新增 VOCALOID6 适配器测试。
4. **更新 `docs/ENGINE_ADAPTERS.md`**：添加 VOCALOID6 章节。
5. **不动其他文件**（特别是 `tools/export_midi.py` /
   `tools/export_ustx.py` / `tools/export_synthv_sidecar.py` /
   `tools/synthv_helper_script_es5.js` / `prototype/web-workbench/`）。

## 用户确认的要求

- AGENTS.md 规定"VOCALOID 后续适配目标已选定为 VOCALOID6 Editor 完整版
  6.13.0（Standalone）；旧版本只走明确标注损失的 MIDI 降级路径"——本轮
  适配器只走 MIDI 降级路径，每个丢失字段都显式标注原因。
- AGENTS.md 规定"第三方集成优先使用厂商公开的导入/导出格式、脚本 API 或
  插件 API；不要依赖脆弱的界面自动点击"——VOCALOID6 没有公开稳定脚本
  API，本轮只生成公开标准的 MIDI + sidecar JSON。
- AGENTS.md 规定"引入依赖或外部格式前，核对其官方文档、维护状态和许可证"
  ——本轮纯 Python 标准库，无新依赖。
- 任务规范明确"VOCALOID6 只走 MIDI 降级路径：不直接读写 `.vpr` / `.vsqx`
  专有二进制格式"——本轮适配器不读写专有二进制。
- 任务规范明确"复用 MIDI 基线导出器的字节生成逻辑"——本轮适配器直接
  import `tools/export_midi.py` 的函数，不重新实现 MIDI 字节生成。
- 任务规范明确"字段损失报告必须显式标注"——sidecar JSON 的 `lost_fields`
  数组中每个条目都含 `field` + `reason`。
- 任务规范明确"纯 Python 标准库"——本轮只用 `argparse` / `json` / `sys` /
  `pathlib` / `typing` + 从 `export_midi` import 的函数。
- 任务规范明确"不要执行 git commit / git push"——本轮不提交，由主 Agent
  统一处理。

## 子 Agent 分工

本轮为单一耦合实现（VOCALOID6 适配器复用 MIDI 基线导出器逻辑，测试与文档
都依赖适配器接口），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建
Agent" 原则未启用子 Agent。所有修改由主实现 Agent 完成。

## 执行内容

### 1. VOCALOID6 适配器 `tools/export_vocaloid6.py`（新建）

- **纯 Python 标准库**：`argparse` / `json` / `sys` / `pathlib` /
  `typing`，无第三方依赖。
- **复用 MIDI 基线导出器**：通过 `sys.path.insert` 把 `tools/` 加入模块
  搜索路径，直接 import `export_midi` 模块的 `load_project` /
  `derive_tempo_map` / `build_anchor_index` / `build_main_track` /
  `build_tempo_track` / `build_smf` / `build_meta_event` 函数。不重新实现
  MIDI 字节生成逻辑。
- **VOCALOID6 特定处理**：
  1. Track 0（tempo track）头部注入 track name meta event
     `FF 03 08 VOCALOID`（`build_vocaloid6_tempo_track`）。
  2. Track 1（main track）头部注入 track name meta event
     `FF 03 0A Main Vocal`（`build_vocaloid6_main_track`）。
  3. 歌词编码 UTF-8（复用 MIDI 基线的 `FF 05` UTF-8 写入，不改变编码）。
  4. 生成 sidecar 字段损失报告 JSON `<output>.vocaloid6-loss.json`
     （`build_loss_report` + `sidecar_path_for` + `export_vocaloid6`）。
- **track name 注入原理**：`build_tempo_track` / `build_main_track` 返回
  delta 编码的字节流，首事件 delta 从 tick 0 开始计算。在头部 prepend 一
  条 delta 0 的 track name meta event 后，后续所有事件的 delta 保持不变
  （delta 是相对前一个事件的绝对 tick），因此注入不会破坏时序。
- **sidecar 损失报告 JSON 结构**：`schema_version` /
  `source_project_schema` / `target_editor` / `export_path` / `encoding` /
  `track_naming` / `lost_fields`（10 项，每项含 `field` + `reason`）/
  `preserved_fields`（6 项）/ `user_workflow`（7 步）。
- **CLI**：`python tools/export_vocaloid6.py <project.json> <output.mid>`；
  `--loss-report` 选项输出人类可读的损失报告到 stderr（与 MIDI 基线一致）。
- **sidecar 文件名**：`<output>.vocaloid6-loss.json`（追加到完整输出文件名
  之后，如 `out.mid` → `out.mid.vocaloid6-loss.json`）。

### 2. 测试 `tests/test_engine_adapters.py`（更新）

新增 `Vocaloid6ExporterTests` 类，共 8 项测试：

1. `test_vocaloid6_exporter_outputs_valid_midi`：MIDI 文件以 MThd 开头，
   MThd length = 6，含 2 个 MTrk chunk（tempo + main）。
2. `test_vocaloid6_exporter_writes_track_name_meta_event`：MIDI 字节中含
   至少 2 个 `\xFF\x03` 序列（Track 0 + Track 1）。
3. `test_vocaloid6_exporter_track_name_is_vocal`：MIDI 字节中含
   `b"VOCALOID"` 和 `b"Main Vocal"` ASCII 文本。
4. `test_vocaloid6_exporter_outputs_loss_report_sidecar`：生成
   `<output>.vocaloid6-loss.json` 文件且可被 `json.loads` 解析。
5. `test_vocaloid6_loss_report_contains_required_fields`：sidecar JSON 含
   `schema_version` / `source_project_schema` / `target_editor` /
   `export_path` / `encoding` / `track_naming` / `lost_fields` /
   `preserved_fields` / `user_workflow` 9 个必需键；`schema_version` =
   `miku-vocaloid6-loss-report/0.1.0`，`source_project_schema` =
   `miku-workbench-project/0.3.0`。
6. `test_vocaloid6_loss_report_lists_all_lost_fields`：`lost_fields` 含
   `syllable.default_reading` / `syllable.reading_override` /
   `note.confidence` / `note.source` / `note.stem_id` / `rests` /
   `source_audio` / `tempo_map.first_beat_seconds` 8 个关键字段；每项含
   非空 `reason`。
7. `test_vocaloid6_loss_report_target_is_6_13_0`：`target_editor` 含
   `"6.13.0"`。
8. `test_vocaloid6_exporter_loss_report_to_stderr`：`--loss-report` 选项
   输出到 stderr，含 `confidence` / `VOCALOID6` / `6.13.0`。

测试夹具复用现有 `make_minimal_project()`（2 个 master NoteEvent + 2 个
syllable 含 reading_override + 1 个 rest + 1 个 LyricRegion "你好世界"），
不依赖 `fixtures/` 目录。

### 3. 文档 `docs/VOCALOID6_ADAPTER.md`（新建）

9 个章节：
1. 适配器目标（VOCALOID6 Editor 6.13.0 Standalone，Windows/macOS）
2. 适配路径：MIDI 降级（不读写 `.vpr`/`.vsqx`，复用 MIDI 基线，注入
   track name，生成 sidecar）
3. CLI 用法
4. 字段损失报告（10 项 lost_fields 表格 + 6 项 preserved_fields 表格）
5. 编码建议（UTF-8 + 导入时手动选择）
6. 用户工作流（7 步）
7. 已知限制（无脚本 API / phoneme 不兼容 / 不生成 `.vpr` / Linux 无编辑器
   / V6.2 前不保证歌词 / 单声部导入 / tempo 假设）
8. 实机验证清单（导入与显示 / 歌词与发音 / 损失字段确认 / 平台验证 /
   旧版降级验证）
9. sidecar 损失报告 JSON 结构（完整示例）

### 4. 文档 `docs/ENGINE_ADAPTERS.md`（更新）

- 第 1 节优先级表新增第 4 行 VOCALOID6 6.13.0 MIDI 降级。
- 第 2 节 CLI 用法新增第 4 条 VOCALOID6 导出命令 + `--loss-report` 示例。
- 第 3 节新增 3.5 子节 VOCALOID6 6.13.0 MIDI 降级（含 10 项字段损失表
  + 保留字段列表）。
- 第 4 节已知限制更新 VOCALOID6 条目：从"留待 P3.5 阶段"改为"已实现
  MIDI 降级适配器，实机验证待完成"。
- 第 5 节安全提示新增 VOCALOID6 复用 MIDI 基线条目。

## 修改文件

| 文件 | 变更 |
| --- | --- |
| `tools/export_vocaloid6.py` | 新建（280 行，纯 Python 标准库 + import export_midi） |
| `tests/test_engine_adapters.py` | +118（新增 Vocaloid6ExporterTests 类 8 项测试 + VOCALOID6_EXPORTER 常量 + docstring 更新） |
| `docs/VOCALOID6_ADAPTER.md` | 新建（9 章节，含字段损失报告表 + 编码建议 + 7 步用户工作流 + 实机验证清单 + sidecar JSON 结构示例） |
| `docs/ENGINE_ADAPTERS.md` | +30（第 1 节表 +1 行；第 2 节 +2 行 CLI；第 3 节 +3.5 子节；第 4 节 VOCALOID6 条目更新；第 5 节 +1 条安全提示） |
| `logs/2026-07-20_021-vocaloid6-midi-degradation-adapter.md` | 新建（本日志） |

未修改其他文件。特别是 `tools/export_midi.py` / `tools/export_ustx.py` /
`tools/export_synthv_sidecar.py` / `tools/synthv_helper_script_es5.js` /
`prototype/web-workbench/` 均未触碰。

## 验证结果

四套测试套件全部通过：

```
python -m unittest tests.test_engine_adapters tests.test_web_workbench_static tests.test_desktop_shell_static tests.test_audio_analysis -v
Ran 86 tests in 2.344s
OK
```

明细：
- `tests.test_engine_adapters`：**28 项通过**（原 20 + 新增 8 VOCALOID6）
- `tests.test_web_workbench_static`：**39 项通过**（未受本轮修改影响）
- `tests.test_desktop_shell_static`：**15 项通过**（未受本轮修改影响）
- `tests.test_audio_analysis`：**4 项通过**（未受本轮修改影响）
- 合计 86 项全部通过。

VOCALOID6 6.13.0 实机打开导出 MIDI 文件的验证本轮未执行（需要真实测试
环境，用户尚未提供 VOCALOID6 安装）；留作未决项。

## 决定与理由

1. **直接 import `export_midi` 模块而非复制代码**：任务规范明确"复用 MIDI
   基线导出器的字节生成逻辑"。`tools/` 没有 `__init__.py`，因此用
   `sys.path.insert(0, str(_TOOLS_DIR))` 把 `tools/` 加入模块搜索路径，
   然后 `from export_midi import ...`。这样 VOCALOID6 适配器只有约 280
   行，且 MIDI 字节生成逻辑的任何修复都会自动传递到 VOCALOID6 适配器。
2. **track name 注入用 prepend 而非重写**：`build_tempo_track` /
   `build_main_track` 返回 delta 编码的字节流。在头部 prepend 一条 delta 0
   的 track name meta event 后，后续事件的 delta 不变（delta 是相对前一
   事件的绝对 tick）。这比重新实现 track 构建更简单且不易出错。已通过测试
   验证：FF 03 出现 2 次，"VOCALOID" 与 "Main Vocal" 文本可被字节搜索找到。
3. **sidecar 文件名用追加而非替换扩展名**：`out.mid` →
   `out.mid.vocaloid6-loss.json`（追加 `.vocaloid6-loss.json` 到完整文件名
   之后）。这样即使多个适配器导出到同一基名（如 `out.mid`），sidecar 也能
   通过扩展名区分（`.vocaloid6-loss.json` vs `.synthv-sidecar.json`）。
4. **sidecar JSON 静态生成而非动态扫描项目**：`build_loss_report()` 返回
   静态字段损失列表，不根据项目内容动态计算。这与 AGENTS.md "旧版本只走
   明确标注损失的 MIDI 降级路径" 一致——损失是 MIDI 降级路径固有的，与具体
   项目内容无关。
5. **`--loss-report` 选项输出人类可读文本而非 JSON**：与 MIDI 基线
   `emit_loss_report()` 风格一致，输出多行文本到 stderr，包含 target_editor
   / encoding / track_naming / lost_fields / preserved_fields / user_workflow
   的可读摘要。sidecar JSON 在实际导出时才生成。
6. **测试夹具复用 `make_minimal_project()`**：与现有 MIDI / USTX / SynthV
   测试一致，不引入新夹具。VOCALOID6 测试关注适配器特有行为（track name
   meta event + sidecar JSON 结构），中立项目模型解析已由 MIDI 基线测试覆盖。
7. **不修改 `AllExportersEmptyProjectTests`**：任务规范明确"至少 6 项
   VOCALOID6 测试"，本轮实际提供 8 项。空项目测试由现有
   `AllExportersEmptyProjectTests` 覆盖 MIDI/USTX/SynthV 三家；VOCALOID6
   适配器复用 MIDI 基线逻辑，空项目行为已被 MIDI 基线空项目测试隐式覆盖，
   不需重复。
8. **不更新 `project-state.json` 与 `CHANGELOG.md`**：任务规范未要求更新
   这两个文件，且任务"不动其他文件"约束严格。`project-state.json` 的
   `last_updated` / `current_deliverables` / `next_actions` 同步与
   `CHANGELOG.md` 追加留给主 Agent 统一处理（见未决问题）。

## 未决问题

1. **`project-state.json` 与 `CHANGELOG.md` 未同步**：本轮受任务约束未修改。
   主 Agent 提交前应更新 `project-state.json` 的 `last_updated`、
   `current_deliverables`（新增 `tools/export_vocaloid6.py` 与
   `docs/VOCALOID6_ADAPTER.md`）、`next_actions`（标记
   `define-vocaloid6-6.13.0-and-legacy-midi-capability-matrix` 为已完成，
   `vocaloid6-6.13.0-real-machine-verification` 保持 pending）。
   `CHANGELOG.md` 应追加"P3.5 VOCALOID6 6.13.0 MIDI 降级适配器"条目。
2. **VOCALOID6 6.13.0 实机验证**：用户尚未提供 VOCALOID6 6.13.0 完整版
   测试环境。本轮在 Python 测试中验证 MIDI 字节结构与 sidecar JSON 结构；
   实机导入、UTF-8 歌词显示、track name 识别、phoneme 调整等需在
   Windows/macOS 实机中验证（见 `docs/VOCALOID6_ADAPTER.md` 第 8 节清单）。
3. **MIDI Lyric Meta Event 编码实机验证**：本轮用 UTF-8；VOCALOID6 V6.2+
   官方支持 UTF-8 与 Shift-JIS，但用户在导入对话框中需手动选择 UTF-8
   （默认 Shift-JIS）。中文歌词若不选 UTF-8 会显示为乱码。此行为需实机确认。
4. **`tempo_map.first_beat_seconds` 非零时的偏移**：VOCALOID6 假设第一个
   tempo 在 position 0；当中立项目 `first_beat_seconds` 非零（如测试夹具
   0.97 秒）时，导出的 MIDI 把 tempo 写在 tick 0，导入后首拍偏移丢失。
   本轮在 sidecar 损失报告中标注此字段丢失，但不修正（符合 MIDI 降级语义）。
5. **Linux 平台**：VOCALOID6 官方编辑器没有 Linux 版本。Linux 上只准备和
   检查交换文件（MIDI + sidecar JSON），实际打开验收在 Windows/macOS 进行。

## Git 状态

- 分支：`main`
- 未提交（任务要求不由本 Agent 提交，主 Agent 统一提交）。
- 本日志创建时，本轮修改均为未跟踪或未暂存状态：
  - `tools/export_vocaloid6.py`（new）
  - `tests/test_engine_adapters.py`（modified）
  - `docs/VOCALOID6_ADAPTER.md`（new）
  - `docs/ENGINE_ADAPTERS.md`（modified）
  - `logs/2026-07-20_021-vocaloid6-midi-degradation-adapter.md`（new）
