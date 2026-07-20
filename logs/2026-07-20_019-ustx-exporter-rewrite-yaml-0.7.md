# 轮 019 · USTX 导出器从 JSON 0.6 重写为 YAML 0.7

**日期**：2026-07-20
**序号**：019
**主题**：critical bug fix — `tools/export_ustx.py` 实测发现 OpenUtau 0.1.565 原生 USTX 文件是 YAML 0.7 而非 JSON 0.6，原导出器无法被 OpenUtau 打开

## 目标

用户在 OpenUtau 0.1.565 实机比对中发现：项目当前实现的 `tools/export_ustx.py` 输出 JSON 文本，但 OpenUtau 0.1.565 的真实 `.ustx` 文件是 UTF-8 YAML 文本，schema 为 `ustx_version: "0.7"`、`resolution: 480`。JSON 导出器无法被 OpenUtau 打开，是 critical bug。本轮按 TDD 流程重写导出器并同步更新测试与文档：

1. 重写 `tools/export_ustx.py`：JSON → 手写最小 YAML 序列化器；USTX 0.6 → 0.7；resolution 960 → 480；零第三方依赖
2. 重写 `tests/test_engine_adapters.py` 中 USTX 相关测试：8 项新 YAML 测试替代旧 JSON 测试
3. 更新 `docs/ENGINE_ADAPTERS.md` USTX 字段损失报告
4. 更新 `docs/ADAPTER_CAPABILITY_MATRIX.md` USTX 0.6 → 0.7
5. 不修改 MIDI / SynthV 导出器与配套脚本
6. 运行全部 4 个测试套件验证无回归
7. 用最小中立项目夹具生成 USTX 样例，附前 100 行到报告末尾

## 执行内容

### 1. 测试先行（RED 阶段）

`tests/test_engine_adapters.py` 中 `UstxExporterTests` 类整体替换为 8 项新测试：

1. `test_ustx_exporter_outputs_valid_yaml` — 输出必须是 YAML 文本，不能以 `{` 或 `[` 开头；顶层必须含 `name` / `ustx_version` / `resolution` / `tracks` / `voice_parts` / `tempos` / `time_signatures`
2. `test_ustx_exporter_has_ustx_version_0_7` — YAML 文本必须含 `ustx_version: "0.7"`，PyYAML 解析后字符串值为 `"0.7"`
3. `test_ustx_exporter_has_resolution_480` — 文本含 `resolution: 480`，解析后整数 `480`
4. `test_ustx_exporter_notes_mapped_from_project_notes` — 项目 tick 0/960 → USTX tick 0/480；duration = (end-start)/2
5. `test_ustx_exporter_writes_track_and_voice_part` — `phonemizer: OpenUtau.Core.DefaultPhonemizer`、`track_color: Blue`
6. `test_ustx_exporter_writes_tempos_and_time_signatures` — `tempos[0].bpm == 120.0`、`time_signatures[0]` 4/4
7. `test_ustx_exporter_lyric_uses_syllable_reading` — `reading_override="ni3"` 优先于 `default_reading="ni"`；override 为空时回退到 `default_reading="hao"`
8. `test_ustx_exporter_loss_report_to_stderr` — `--loss-report` 输出含 `confidence` / `source` / `velocity` / `stem_id` / `rests` / `source_audio`

测试文件顶部新增 PyYAML 可选导入：

```python
try:
    import yaml
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False
```

`test_all_exporters_handle_empty_project` 同步改用 YAML 解析路径。

夹具 `make_minimal_project` 中 `syllable-1` 加上 `reading_override: "ni3"` 以覆盖优先级链路。

RED 阶段验证：8 项新测试 + 1 项 empty project 测试全部失败（旧 JSON 导出器输出无法满足 YAML 断言），确认测试确实测了缺失的功能。

### 2. 导出器实现（GREEN 阶段）

`tools/export_ustx.py` 完整重写。关键模块：

**手写最小 YAML 序列化器**（零第三方依赖，只覆盖 USTX schema 子集）：

- `_FlowDict(dict)`：标记需要渲染为 inline flow mapping `{k: v, ...}` 的 dict，用于 `pitch.data` 点和 `vibrato` 块
- `_emit_float(value)`：处理 NaN / inf
- `_needs_quotes(text)`：检测需要引号的字符串（YAML 保留字、数字字符串如 `"0.7"`、特殊起始字符、含 `: ` 或 `#` 的串）
- `_quote_string(text)`：双引号 + 转义
- `_emit_scalar(value)`：None / bool / int / float / str 派发
- `_emit_flow_mapping(d)`：渲染 `{k: v, ...}`
- `_emit_pair(key, value, indent, lines)`：键值对发射（dict / list / 空容器 / 标量分流）
- `_emit_mapping(d, indent, lines)`：dict 序列化
- `_emit_sequence(items, indent, lines)`：list 序列化
- `_emit_sequence_item(item, indent, lines)`：list item，含 dict 时用 `- key: value` + 缩进续行
- `_emit_sequence_item_first_pair(...)`：处理 `- key: value` 与后续 continuation pairs
- `dump_yaml(data)`：顶层入口，返回完整 YAML 字符串

**USTX 0.7 结构构造**：

- 常量 `USTX_VERSION = "0.7"`、`USTX_RESOLUTION = 480`、`DEFAULT_PROJECT_PPQ = 960`
- `project_tick_to_ustx(tick, project_ppq)` → `int(round(tick * 480 / project_ppq))`（即项目 tick / 2）
- `build_pitch_block()` → `{"data": [_FlowDict({x:-40,y:0,shape:io}), _FlowDict({x:40,y:0,shape:io})], "snap_first": True}`
- `build_vibrato_block()` → `_FlowDict` 含 8 个字段（length/period/depth/in/out/shift/drift/vol_link）
- `build_note(note, syllables_by_anchor, anchor_index, project_ppq)` — NoteEvent → USTX note（含 tick /2 换算、tone clamp 0..127、lyric 优先级）
- `build_lyric_for_note(note, syllables_by_anchor)` — 优先级：`reading_override` > `default_reading` > `text` > `id` > `"R"`
- `build_notes_array(project, anchor_index, project_ppq)` — 收集 master stem notes，按 position 排序
- `build_track(track_name)` — `phonemizer: OpenUtau.Core.DefaultPhonemizer`、`track_color: Blue`、`voice_color_names: [""]`
- `build_voice_part(notes)` — `name: New Part`、`position: 0`、duration 取 max(480, max_end)
- `build_ustx_project(project, tempo_map, notes_array)` — 顶层 dict，含 `expressions: {}`、`exp_selectors: []`、`exp_primary: -1`、`exp_secondary: -1`、`key: 0`、`wave_parts: []`
- `export_ustx(project, output_path)` — 写入文件
- `emit_loss_report()` — 11 行损失报告

CLI 保留：

```bash
python tools/export_ustx.py <project.json> <output.ustx>
python tools/export_ustx.py <project.json> <output.ustx> --loss-report
```

GREEN 阶段验证：8 项新 USTX 测试 + empty project 测试全部通过。

### 3. 文档同步

`docs/ENGINE_ADAPTERS.md`：

- 第 1 节优先级表：`OpenUtau USTX 0.6` → `OpenUtau USTX 0.7`；文件类型 `(JSON 文本)` → `(YAML 文本)`；依赖项标注"手写最小 YAML 序列化器"
- 第 2 节 CLI 用法：`USTX 0.6 导出` → `USTX 0.7 导出`
- 第 3.2 节 USTX 0.7 损失报告：完整重写，含 YAML 序列化说明、tick /2 转换说明、14 行损失表（velocity / confidence / source / stem_id / trim/fade / default_reading / RestEvent / Anchor / 浮点 pitch / LyricRegion 容器 / chord_overrides / source_audio / analysis / key 标签）
- 第 4 节已知限制：USTX 字段精确性、PPQ 转换、多 stem 轨三条更新到 0.7 实测口径
- 第 5 节安全提示：新增"USTX YAML 序列化零依赖"条目

`docs/ADAPTER_CAPABILITY_MATRIX.md`：

- 第 0 节：`OpenUtau USTX 0.6` → `OpenUtau USTX 0.7（首个端到端工程导出验收，0.1.565 实测 YAML 格式）`
- 第 3 节完整重写：
  - 3.1 格式概述：确认 YAML、resolution 480、version 0.7、0.1.565 实测口径
  - 3.2 字段结构：完整 USTX 0.7 YAML schema 模板，含 flow-style `pitch.data` 和 `vibrato` 示例
  - 3.3 字段映射表（19 行）含 tick /2 转换
  - 3.4 损失报告（11 行）
  - 3.5 风险与依赖：手写 YAML 序列化器、无 PyYAML、需实机打开验证
- 第 6.1 节：USTX 适配器顺序项依赖更新为"手写最小 YAML 序列化器（零第三方依赖）；0.1.565 实测备份文件已核对"
- 第 7.1 节：5 项验证项标记 `[x]` 已解决，2 项保持 `[ ]`（wave_parts trim/fade、三平台一致性）
- 第 9 节：调研边界更新，USTX 0.7 不再是推断值

## 修改文件

绝对路径清单：

- `c:\Users\yEluN\Documents\miku歌姬放计划\tools\export_ustx.py`（完整重写，485 行）
- `c:\Users\yEluN\Documents\miku歌姬放计划\tests\test_engine_adapters.py`（USTX 测试类整体替换，新增 PyYAML 可选导入，syllable-1 加 reading_override，empty project 测试改 YAML 路径）
- `c:\Users\yEluN\Documents\miku歌姬放计划\docs\ENGINE_ADAPTERS.md`（USTX 章节同步到 0.7 YAML）
- `c:\Users\yEluN\Documents\miku歌姬放计划\docs\ADAPTER_CAPABILITY_MATRIX.md`（USTX 章节从 0.6 重写为 0.7）
- `c:\Users\yEluN\Documents\miku歌姬放计划\logs\2026-07-20_019-ustx-exporter-rewrite-yaml-0.7.md`（本日志）

未修改（按要求保持不动）：

- `c:\Users\yEluN\Documents\miku歌姬放计划\tools\export_midi.py`
- `c:\Users\yEluN\Documents\miku歌姬放计划\tools\export_synthv_sidecar.py`
- `c:\Users\yEluN\Documents\miku歌姬放计划\tools\synthv_helper_script_es5.js`
- `c:\Users\yEluN\Documents\miku歌姬放计划\prototype\web-workbench\` 下任何文件

## 验证结果

### 测试套件全量运行

```
python -m unittest tests.test_engine_adapters -v
python -m unittest tests.test_web_workbench_static tests.test_desktop_shell_static tests.test_audio_analysis
```

| 测试套件 | 通过数 | 备注 |
|---|---|---|
| `tests.test_engine_adapters` | 20 项 | 8 项 USTX YAML 新测试 + 7 项 MIDI + 1 项 SynthV sidecar + 3 项 SynthV helper + 1 项 empty project |
| `tests.test_web_workbench_static` | 32 项 | 未受影响 |
| `tests.test_desktop_shell_static` | 15 项 | 未受影响 |
| `tests.test_audio_analysis` | 4 项 | 未受影响 |
| **总计** | **71/71** | **全部通过，无回归** |

### USTX 样例生成验证

用 4 音符 + 2 歌词区域 + 4 音节的最小中立项目夹具运行导出器，生成 USTX 共 90 行。验证要点：

- 顶层 17 个字段顺序与 0.1.565 实测备份文件一致（`name` / `comment` / `output_dir` / `cache_dir` / `ustx_version` / `resolution` / `bpm` / `beat_per_bar` / `beat_unit` / `expressions` / `exp_selectors` / `exp_primary` / `exp_secondary` / `key` / `time_signatures` / `tempos` / `tracks` / `voice_parts` / `wave_parts`）
- `ustx_version: "0.7"` 带双引号（YAML 字符串保留）
- `resolution: 480` 整数
- 4 个 note 的 position 分别为 0 / 480 / 960 / 1440（项目 tick 0 / 960 / 1920 / 2880 各除以 2）
- duration 全部 480（项目 960 / 2）
- tone 60 / 62 / 64 / 65（整数 MIDI pitch）
- lyric 分别为 `ni3` / `hao` / `shi` / `jie`：第一个验证 override 优先级，后三个验证 default_reading 回退路径
- 每个 note 的 `pitch.data` 用 flow style `- {x: -40, y: 0, shape: io}` 输出
- 每个 note 的 `vibrato` 用 flow style `vibrato: {length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0}` 输出
- `expressions: {}` / `exp_selectors: []` / `wave_parts: []` / `phoneme_expressions: []` / `phoneme_overrides: []` / `curves: []` 空容器正确渲染

生成 USTX 的前 100 行（实际共 90 行，全部列出）见本日志末尾附录。

## 决定与理由

1. **手写最小 YAML 序列化器，不引入 PyYAML**：导出器是 production code，按 AGENTS.md "第三方集成优先使用厂商公开格式" + "引入依赖前核对许可证"原则，手写覆盖 USTX schema 子集（dict / list / str / int / float / bool / null + flow mapping）的序列化器只需 ~150 行，零依赖降低供应链风险。测试侧允许 `pip install pyyaml` 用于解析断言，失败时降级为字符串匹配。
2. **`_FlowDict` 标记类区分 flow 与 block mapping**：USTX 真实文件中 `pitch.data` 点和 `vibrato` 块用 inline `{k: v}` 表达，其余 dict 用 block mapping。用 `dict` 子类标记避免在每个 emit 函数里加 flag 参数，保持调用点简洁。
3. **tick 换算 `int(round(tick * 480 / 960))`**：等价于 `tick / 2`，但用通用的 `tick * USTX_RESOLUTION / project_ppq` 形式以便未来 PPQ 变化时只改常量。
4. **lyric 优先级 `reading_override` > `default_reading` > `text`**：与 `docs/ENGINE_ADAPTERS.md` 字段映射表一致；override 为空字符串时回退，符合 web-workbench inspector UI 行为。
5. **`expressions: {}` 写空对象**：0.1.565 实测备份文件中 expressions 顶层是空对象（OpenUtau 用内置默认表达式定义），不复制一大段内置键值对，避免 schema 漂移。
6. **不修改 MIDI / SynthV 导出器**：本轮范围严格限定为 USTX critical bug fix；MIDI 和 SynthV 测试全通过，不动它们避免无关回归。
7. **不执行 git commit / git push**：按用户明确指令，本轮交付物由主 Agent 统一提交。

## 未决问题

1. **OpenUtau 0.1.565 三平台实机打开验证未执行**：YAML 字段结构已对齐真实备份文件，但仍需在 Windows / macOS / Linux 三平台实机打开导出的 `.ustx` 完成端到端验收。这是 P3 首个端到端工程导出验收的最后一环。
2. **`wave_parts` trim/fade 未写**：本轮 `wave_parts: []`，多 stem 音频混音需用户手工在 OpenUtau 内重建引用。
3. **变速段未支持**：中立项目模型尚未引入变速段；USTX 0.7 `tempos` 数组支持多 tempo，未来可扩展。
4. **YAML 序列化器只覆盖 USTX schema 子集**：不适用于通用 YAML 场景；如果未来 USTX schema 扩展引入 alias / anchor / 多行字符串，需要扩展序列化器。
5. **PyYAML 在测试环境中可用（6.0.3），生产环境无依赖**：测试用 PyYAML 仅做断言解析；生产导出器无 PyYAML 依赖，但若用户运行测试套件需 `pip install pyyaml`（失败时测试自动 skip）。
6. **Phonemizer 统一用 `OpenUtau.Core.DefaultPhonemizer`**：不按歌词语言切换；如需 zh/ja 专用 phonemizer，需后续扩展。
7. **tempo_map.key 候选标签未映射**：USTX `key` 是 0..11 整数，本轮默认 `key: 0`（C 大调），不解析候选标签。

## Git 状态

- 分支：`main`
- 本轮**未执行** `git add` / `git commit` / `git push`（按用户明确指令由主 Agent 统一处理）
- 工作树预期变更：4 项 modified（`tools/export_ustx.py`、`tests/test_engine_adapters.py`、`docs/ENGINE_ADAPTERS.md`、`docs/ADAPTER_CAPABILITY_MATRIX.md`）+ 1 项 untracked（本日志）
- 待主 Agent 检查 `git diff` / `git status` 后统一提交

## 附录：4 音符最小夹具生成的 USTX（前 100 行，文件共 90 行）

夹具：4 个 NoteEvent（项目 tick 0 / 960 / 1920 / 2880，pitch 60 / 62 / 64 / 65），2 个 LyricRegion（"你好" + "世界"），4 个 syllable（`ni3` override + `hao` / `shi` / `jie` default_reading）。

```yaml
name: Sample
comment: ""
output_dir: Vocal
cache_dir: UCache
ustx_version: "0.7"
resolution: 480
bpm: 120.0
beat_per_bar: 4
beat_unit: 4
expressions: {}
exp_selectors: []
exp_primary: -1
exp_secondary: -1
key: 0
time_signatures:
- bar_position: 0
  beat_per_bar: 4
  beat_unit: 4
tempos:
- position: 0
  bpm: 120.0
tracks:
- phonemizer: OpenUtau.Core.DefaultPhonemizer
  renderer_settings: {}
  track_name: Main vocal
  track_color: Blue
  mute: false
  solo: false
  volume: 0
  pan: 0
  track_expressions: []
  voice_color_names:
  - ""
voice_parts:
- duration: 1920
  name: New Part
  comment: ""
  track_no: 0
  position: 0
  notes:
  - position: 0
    duration: 480
    tone: 60
    lyric: ni3
    pitch:
      data:
      - {x: -40, y: 0, shape: io}
      - {x: 40, y: 0, shape: io}
      snap_first: true
    vibrato: {length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0}
    phoneme_expressions: []
    phoneme_overrides: []
  - position: 480
    duration: 480
    tone: 62
    lyric: hao
    pitch:
      data:
      - {x: -40, y: 0, shape: io}
      - {x: 40, y: 0, shape: io}
      snap_first: true
    vibrato: {length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0}
    phoneme_expressions: []
    phoneme_overrides: []
  - position: 960
    duration: 480
    tone: 64
    lyric: shi
    pitch:
      data:
      - {x: -40, y: 0, shape: io}
      - {x: 40, y: 0, shape: io}
      snap_first: true
    vibrato: {length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0}
    phoneme_expressions: []
    phoneme_overrides: []
  - position: 1440
    duration: 480
    tone: 65
    lyric: jie
    pitch:
      data:
      - {x: -40, y: 0, shape: io}
      - {x: 40, y: 0, shape: io}
      snap_first: true
    vibrato: {length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0}
    phoneme_expressions: []
    phoneme_overrides: []
  curves: []
wave_parts: []
```
