# P3 引擎适配器操作指南

本文件描述 P3 首批引擎适配器的优先级、CLI 用法、字段损失报告与已知限制。
适配器调研背景见 `docs/ADAPTER_CAPABILITY_MATRIX.md`；架构层定位见
`docs/ARCHITECTURE.md` 第 G 节"外部适配器层"。

## 1. 适配器优先级顺序与目标编辑器版本

| 顺序 | 适配器 | 目标编辑器版本 | 文件类型 | 依赖项 |
|---|---|---|---|---|
| 1 | MIDI 基线 | 任意支持 SMF 1 的编辑器 | `.mid` (二进制) | 无（Python 标准库） |
| 2 | OpenUtau USTX 0.7 | OpenUtau 0.1.565 稳定版 | `.ustx` (YAML 文本) | 无（Python 标准库，手写最小 YAML 序列化器） |
| 3 | Synthesizer V Studio Pro 1.9.0 Layer 2 | Synthesizer V Studio Pro 1.9.0 | `.mid` + `.js` 配套脚本 + `.json` sidecar | 无（Python 标准库 + SynthV 1.9.0 实机） |

所有适配器只做"中立项目模型 → 外部格式"的字段转换；不反向修改
web-workbench 的数据结构；不依赖 GUI 自动化；不直接读写专有二进制格式
(`.svp` / `.vpr` / `.vsqx`)。

## 2. CLI 用法示例

```bash
# 1. MIDI 基线导出（适用于所有目标编辑器）
python tools/export_midi.py <project.json> <output.mid>

# 2. USTX 0.7 导出（OpenUtau 原生工程）
python tools/export_ustx.py <project.json> <output.ustx>

# 3a. Synthesizer V 1.9.0 sidecar JSON 导出
python tools/export_synthv_sidecar.py <project.json> <output_sidecar.json>

# 3b. 在 Synthesizer V 1.9.0 Script Console 中运行配套脚本：
#     修改 tools/synthv_helper_script_es5.js 顶部 SIDECAR_PATH 为
#     sidecar.json 实际路径，paste 整个脚本到 Script Console，执行。
```

任意适配器均可用 `--loss-report` 选项把字段损失报告写到 stderr：

```bash
python tools/export_midi.py --loss-report
python tools/export_ustx.py --loss-report
```

## 3. 字段损失报告

### 3.1 MIDI 基线

| 中立字段 | 损失情况 | 缓解策略 |
|---|---|---|
| `LyricRegion.text` | 部分丢失 | 通过 `FF 05` lyric meta event 写入；不同编辑器识别能力差异大 |
| `LyricRegion.language` (zh/ja) | 完全丢失 | MIDI 无语言字段；Phonemizer 选择由编辑器决定 |
| `LyricRegion` 字/音节切分 | 完全丢失 | 中立模型已切分到 syllable；MIDI 只写 `syllable.text` |
| `syllable.default_reading` | 完全丢失 | MIDI 不区分读音；用户需在编辑器内重新指定 |
| `syllable.reading_override` | 完全丢失 | 同上 |
| `RestEvent.kind` | 完全丢失 | 表达为相邻音符之间的 tick 间隙 |
| `stem_tracks` 非 master | 完全丢失 | MIDI 单文件多轨仅支持多通道；混音参数无处保存 |
| `Anchor` 共享边界 | 退化 | 共享边变成"相邻 Note Off 与 Note On 同 tick" |
| `NoteEvent.confidence` | 完全丢失 | — |
| `NoteEvent.source` | 完全丢失 | — |
| `chord_overrides` | 完全丢失 | — |
| `analysis` (tempo 之外) | 完全丢失 | — |
| `source_audio` (哈希、文件名) | 完全丢失 | MIDI 无音频引用 |
| `preferences` | 完全丢失 | — |

### 3.2 OpenUtau USTX 0.7

USTX 0.7 是用户电脑上 OpenUtau 0.1.565 实测的原生格式：UTF-8 YAML 文本，
`ustx_version: "0.7"`，`resolution: 480`（与项目内部 PPQ 960 不同，导出时 tick 按
`ustx_tick = project_tick * 480 / 960` 换算，即项目 tick / 2）。导出器手写最小 YAML
序列化器，不引入 PyYAML 等第三方依赖；只覆盖 USTX schema 用到的子集（dict / list /
str / int / float / bool / null + 流式 inline 表达式 `{x: -40, y: 0, shape: io}` 与
`vibrato: {length: 0, ...}`）。

| 中立字段 | 损失情况 | 缓解策略 |
|---|---|---|
| `NoteEvent.velocity` | 完全丢失 | USTX 0.7 音符无 velocity 字段；力度通过 expressions（dyn 等）表达，本轮不映射 |
| `NoteEvent.confidence` | 完全丢失 | — |
| `NoteEvent.source` | 完全丢失 | — |
| `NoteEvent.stem_id` | 完全丢失 | USTX 导出扁平化为单声部工程（`track_no: 0`），所有 stem 合并到一条 voice part |
| `stem_tracks.trim/fade` | 完全丢失 | USTX `wave_parts` / `mix` 不在导出范围；需手工在编辑器内设置 |
| `syllable.default_reading` | 部分保留 | `reading_override` 优先；为空时回退到 `default_reading`，再回退到 `syllable.text` |
| `RestEvent` | 隐式 | USTX 用相邻音符之间的 tick 间隙表达休止，无显式 rest 字段 |
| `Anchor` 共享边界 | 退化 | 共享边变成连续 note `position` |
| `NoteEvent` 浮点 pitch 小数部分 | 丢失 | USTX `tone` 是整数 MIDI pitch；微调用 `pitch.data` 表达，本轮写默认 pitch 点 |
| `LyricRegion` 容器 | 完全丢失 | 只把音节级 lyric 写到 `note.lyric`，歌词区域边界与语言信息不保留 |
| `chord_overrides` | 完全丢失 | USTX 不承载和声分析 |
| `source_audio` 哈希 / 文件名 | 完全丢失 | USTX 仅在 `wave_parts` 中引用音频文件路径，本轮不写伴奏引用 |
| `analysis` (tempo 之外) | 完全丢失 | — |
| `tempo_map.key` 候选标签 | 不映射 | USTX `key` 是 0..11 整数；本轮默认 `key: 0`（C 大调），不解析候选标签 |

### 3.3 Synthesizer V 1.9.0 配套脚本（Layer 2）

配套脚本不修改 `.svp` 二进制工程文件，只在用户已导入 MIDI 后，按
sidecar 中的 `syllable_id` 把读音写到工程音符的 `lyric` 字段。

| 中立字段 | 损失情况 | 缓解策略 |
|---|---|---|
| `NoteEvent.confidence` | 完全丢失 | sidecar 中保留以供人工参考；SynthV 无对应字段 |
| `NoteEvent.source` | 完全丢失 | 同上 |
| `stem_tracks` mix 参数 | 部分保留 | sidecar 保留；SynthV 1.9.0 脚本 API 不能写 trim/fade |
| `Anchor` 共享边界 | 退化 | 经 MIDI 导入后变成 tick 对齐的 Note Off/Note On |
| `lyric.language` | 完全丢失 | 通过 Phonemizer 选择隐式表达 |
| `chord_overrides` | 完全丢失 | sidecar 保留以供人工参考 |
| `NoteEvent` tick 精度 | 退化 | MIDI PPQ 960 与 SynthV 内部 blick 互转可能有舍入 |

### 3.4 SynthV sidecar JSON

sidecar JSON 是 SynthV 1.9.0 适配路径上唯一能完整保留中立项目元数据
的格式。完整字段规范见 `tools/synthv_sidecar_schema.md`。

sidecar 的损失报告字段（`loss_report`）保留人类可读的字段映射说明，
helper 脚本不消费 `loss_report`，仅用于用户审阅。

## 4. 已知限制

- **VOCALOID6 6.13.0 适配**：留待 P3.5 阶段。本轮未生成 VOCALOID
  专属适配器；用户若需在 6.13.0 完整版中打开项目，可使用 MIDI 基线
  导出（V6.2+ 支持 MIDI Lyric Meta Event 识别）。旧版 V3/V4/V5 不保
  证识别 MIDI 歌词；详见 `docs/ADAPTER_CAPABILITY_MATRIX.md` 第 5 节。
- **Synthesizer V 1.11+ 能力**：本轮适配器**不**支持 1.11+ 才有的
  ARA 与 Voice-to-MIDI API。helper 脚本声明
  `maxEditorVersion: 0x010AFF`，运行时检查宿主版本，1.11+ 会拒绝执行。
  1.10+ 工程必须由新版显式另存为 1.9.0 兼容副本才能由 1.9.0 打开。
- **USTX 字段精确性**：USTX 0.7 的字段结构已在用户电脑 OpenUtau 0.1.565
  实测备份文件（`Untitled-autosave.ustx`）上核对并固定：YAML 文本格式、
  `ustx_version: "0.7"`、`resolution: 480`、顶层字段 `name` / `comment` /
  `output_dir` / `cache_dir` / `bpm` / `beat_per_bar` / `beat_unit` /
  `expressions` / `exp_selectors` / `exp_primary` / `exp_secondary` / `key` /
  `time_signatures` / `tempos` / `tracks` / `voice_parts` / `wave_parts`，
  音符字段 `position` / `duration` / `tone` / `lyric` / `pitch.data` /
  `vibrato` / `phoneme_expressions` / `phoneme_overrides`。`expressions` 写
  空对象 `{}` 让 OpenUtau 用内置默认表达式定义。
- **PPQ 转换**：USTX `resolution: 480` 已确认。项目内部 PPQ 960 → USTX 480
  按 `ustx_tick = project_tick / 2` 换算（取整），导出器在 `project_tick_to_ustx`
  中实现；note `position` 与 `duration` 都按此换算。
- **多 stem 轨**：USTX 0.7 适配器当前扁平化为单声部工程；多 stem
  音频混音需要用户手工在 OpenUtau 内重建 `wave_parts` 引用。
- **变速段**：本轮适配器只写单个 tempo；中立项目模型尚未引入变速段。

## 5. 安全提示

- **不写专有二进制**：所有导出器只生成 MIDI 二进制（公开标准）、
  USTX YAML 文本（OpenUtau 公开 schema）或 JSON 文本（公开 schema）。
  不直接读写 `.svp` / `.vpr` / `.vsqx` 内部结构。
- **USTX YAML 序列化零依赖**：导出器手写最小 YAML 序列化器，只覆盖
  USTX schema 子集；不引入 PyYAML 等第三方依赖，降低供应链风险。
- **配套脚本只读 sidecar 不修改原工程**：helper 脚本仅调用
  `note.setLyric(...)` 修改已导入音符的歌词字段，不调用任何会修改
  工程结构、速度图或自动化参数的 API。
- **ES5 风格**：helper 脚本不使用 `const` / `let` / 箭头函数 / 模板字
  符串，确保在 Synthesizer V 1.9.0 的 Script Console 中可执行。
- **运行时版本检查**：helper 脚本在执行前调用 `SV.getHostInfo()` 检
  查宿主版本，1.9.0 以下或 1.11+ 都会拒绝执行。
- **sidecar 文件路径**：用户需在运行 helper 脚本前修改
  `SIDECAR_PATH` 常量为 sidecar JSON 实际路径；脚本不自动查找。
