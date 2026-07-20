# P3 引擎适配器操作指南

本文件描述 P3 首批引擎适配器的优先级、CLI 用法、字段损失报告与已知限制。
适配器调研背景见 `docs/ADAPTER_CAPABILITY_MATRIX.md`；架构层定位见
`docs/ARCHITECTURE.md` 第 G 节"外部适配器层"。

## 1. 适配器优先级顺序与目标编辑器版本

| 顺序 | 适配器 | 目标编辑器版本 | 文件类型 | 依赖项 |
|---|---|---|---|---|
| 1 | MIDI 基线 | 任意支持 SMF 1 的编辑器 | `.mid` (二进制) | 无（Python 标准库） |
| 2 | OpenUtau USTX 0.6 | OpenUtau 0.1.565 稳定版 | `.ustx` (JSON 文本) | 无（Python 标准库） |
| 3 | Synthesizer V Studio Pro 1.9.0 Layer 2 | Synthesizer V Studio Pro 1.9.0 | `.mid` + `.js` 配套脚本 + `.json` sidecar | 无（Python 标准库 + SynthV 1.9.0 实机） |

所有适配器只做"中立项目模型 → 外部格式"的字段转换；不反向修改
web-workbench 的数据结构；不依赖 GUI 自动化；不直接读写专有二进制格式
(`.svp` / `.vpr` / `.vsqx`)。

## 2. CLI 用法示例

```bash
# 1. MIDI 基线导出（适用于所有目标编辑器）
python tools/export_midi.py <project.json> <output.mid>

# 2. USTX 0.6 导出（OpenUtau 原生工程）
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

### 3.2 OpenUtau USTX 0.6

| 中立字段 | 损失情况 | 缓解策略 |
|---|---|---|
| `NoteEvent.velocity` | 换算 | 0..1 → USTX 0..200，线性映射 |
| `NoteEvent.confidence` | 完全丢失 | — |
| `NoteEvent.source` | 完全丢失 | — |
| `stem_tracks` 多 stem | 扁平化 | USTX 0.6 单声部工程；多 stem 转多 `mix[]` 条目需音频文件 |
| `stem_tracks.trim/fade` | 完全丢失 | USTX `mix` 字段无 trim/fade；需手工在编辑器内设置 |
| `syllable.default_reading` | 完全丢失 | 只保留 `reading_override` 或 fallback |
| `RestEvent` | 隐式 | 表达为相邻音符之间的空隙 |
| `Anchor` 共享边界 | 退化 | 共享边变成连续 note `pos` |
| `NoteEvent` 浮点 pitch 小数部分 | 丢失 | USTX pitch 为整数；需 `pitch_points` 表达微调 |
| `chord_overrides` | 完全丢失 | USTX 不承载和声分析 |
| `source_audio` 哈希 | 完全丢失 | USTX 仅存音频文件路径 |
| `analysis` (tempo 之外) | 完全丢失 | — |

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
- **USTX 字段精确性**：USTX 0.6 的精确字段名、嵌套层级和单位需在
  OpenUtau 0.1.565 实机导出后用真实文件比对并固定。当前导出器依据
  项目内已核对的"可表达内容"清单和 OpenUtau 已知模型推断。
- **PPQ 转换**：USTX 内部 PPQ 与 960 的差异需要实机验证；当前导出器
  保留 960 tick，OpenUtau 在导入时会按其内部 PPQ 重新换算。
- **多 stem 轨**：USTX 0.6 适配器当前扁平化为单声部工程；多 stem
  音频混音需要用户手工在 OpenUtau 内重建 `mix[]` 引用。
- **变速段**：本轮适配器只写单个 tempo；中立项目模型尚未引入变速段。

## 5. 安全提示

- **不写专有二进制**：所有导出器只生成 MIDI 二进制（公开标准）或
  JSON 文本（公开 schema）。不直接读写 `.svp` / `.vpr` / `.vsqx`
  内部结构。
- **配套脚本只读 sidecar 不修改原工程**：helper 脚本仅调用
  `note.setLyric(...)` 修改已导入音符的歌词字段，不调用任何会修改
  工程结构、速度图或自动化参数的 API。
- **ES5 风格**：helper 脚本不使用 `const` / `let` / 箭头函数 / 模板字
  符串，确保在 Synthesizer V 1.9.0 的 Script Console 中可执行。
- **运行时版本检查**：helper 脚本在执行前调用 `SV.getHostInfo()` 检
  查宿主版本，1.9.0 以下或 1.11+ 都会拒绝执行。
- **sidecar 文件路径**：用户需在运行 helper 脚本前修改
  `SIDECAR_PATH` 常量为 sidecar JSON 实际路径；脚本不自动查找。
