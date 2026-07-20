# P3 首批引擎适配器能力矩阵调研

## 0. 调研范围与边界

本报告为 P3 首批引擎适配的调研草稿，覆盖 4 个目标：

1. MIDI 1.0 基线（保守交换基线）
2. OpenUtau USTX 0.6（首个端到端工程导出验收）
3. Synthesizer V Studio Pro 1.9.0（用户现有版本）
4. VOCALOID6 Editor 6.13.0 完整版（后续适配目标，本轮仅草稿）

数据来源（按可信度递减）：

- 项目内已核对的官方资料：`docs/RESEARCH_NOTES.md`（截至 2026-07-20）
- 项目内中立模型实现：`prototype/web-workbench/app.js`（PROJECT_SCHEMA `miku-workbench-project/0.2.0`）
- 架构与决策：`docs/ARCHITECTURE.md`、`docs/MULTITRACK_COMPOSITION_DESIGN.md`、`docs/ROADMAP.md`
- 通用 MIDI 1.0 标准知识

本调研未实时访问外部网络，所有外部 URL 引用均来自项目内 `docs/RESEARCH_NOTES.md` 中已记录的链接。涉及具体格式字段名、版本细节的字段均显式标注"需实际测试环境验证"。

---

## 1. 中立项目模型字段清单

字段来源：`prototype/web-workbench/app.js` 中 `exportProject`（2664–2741 行）、`importAnchorsAndRegions`（2743–2933 行）、`buildTempoMap`（464–488 行）、`defaultStemTracks`（100–113 行）、`createNote`（1646–1669 行）、`createAnchorAtSample`（510–519 行）。常量 `PPQ = 960`（第 9 行）、`ANCHOR_TOLERANCE_SECONDS = 0.005`（第 11 行）、`PIANO_ROLL_MIN_PITCH = 36` (C2)、`PIANO_ROLL_MAX_PITCH = 96` (C7)。

### 1.1 顶层 Project 结构

```text
{
  schema_version: "miku-workbench-project/0.2.0",
  title: "Miku 歌姬解放计划 · 工作台原型项目",
  source_audio: { ...analysis.source_audio, local_file_name, relink_required_after_import: true },
  analysis: AnalysisRun,
  tempo_map: TempoMap,
  anchors: Anchor[],
  editing: {
    selection: { start: number, end: number },
    lyrics: LyricRegion[],
    rests: RestEvent[],
    chord_overrides: { [chordKey]: { label, start_seconds, end_seconds, status: "user-confirmed" } },
    locked_fields: string[],
    stem_tracks: StemTrack[],
    notes: NoteEvent[],
    preferences: { snap_mode, continuous_lyrics, dotted_snap, swing_amount, stem_preview_mode }
  }
}
```

### 1.2 Anchor

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 形如 `anchor-<N>`；导入时保留原 ID |
| `sample` | int | 音频采样位置（0..duration*sampleRate），权威基准 |
| `tick` | int | 由 sample 通过 TempoMap 派生 |

### 1.3 TempoMap

```text
{
  sample_rate_hz: int,        // 默认 48000
  ppq: 960,
  bpm: number,
  first_beat_seconds: number,
  first_beat_sample: int,
  first_beat_tick: 0,
  ticks_per_second: (bpm/60)*ppq,
  samples_per_tick: sample_rate_hz / ticks_per_second
}
```

### 1.4 NoteEvent

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 形如 `note-<N>` |
| `stem_id` | string | 默认 `master`；可为 `drums` / `bass` / `other` |
| `start_anchor_id` | string | 引用 Anchor.id |
| `end_anchor_id` | string | 引用 Anchor.id；与 start 不同 |
| `pitch` | int | 浮点 MIDI pitch，clamp 到 36..96（C2..C7）|
| `velocity` | number | 0..1 |
| `confidence` | number | 0..1；source 为 manual 时为 1 |
| `source` | enum | `manual` / `transcription` / `generation` |

### 1.5 LyricRegion

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 形如 `lyric-<N>` |
| `start_anchor_id` | string | 引用 Anchor.id |
| `end_anchor_id` | string | 引用 Anchor.id；与 start 不同 |
| `language` | enum | `zh` 或 `ja` |
| `text` | string | 原文文本，trim 后非空 |

注：当前原型只保存整段歌词文本，未保存音节/字/假名切分、读音、音素和拍边界（P2 工作）。

### 1.6 RestEvent

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 形如 `rest-<N>` |
| `start_anchor_id` | string | 引用 Anchor.id |
| `end_anchor_id` | string | 引用 Anchor.id |
| `kind` | enum | 当前只接受 `"rest"` |

### 1.7 StemTrack

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | enum | `master` / `drums` / `bass` / `other` |
| `name` | string | 显示名 |
| `role` | string | `master` / `drums` / `bass` / `other` |
| `mute` | boolean | 静音 |
| `solo` | boolean | 独奏 |
| `gain` | number | 0..1.5 |
| `pan` | number | -1..1 |
| `source` | enum | `main` / `placeholder` |
| `trim_start_seconds` | number | ≥0，≤duration |
| `trim_end_seconds` | number | ≥0，≤duration；0 表示"到音频结尾" |
| `fade_in_seconds` | number | ≥0 |
| `fade_out_seconds` | number | ≥0 |

---

## 2. MIDI 1.0 基线能力矩阵

### 2.1 可无损导出的中立字段

| 中立字段 | MIDI 表达 | 说明 |
|---|---|---|
| NoteEvent.pitch (36..96) | Note On/Off 的 `note` 字节（0..127） | 直接整数映射 |
| NoteEvent.start_anchor → tick | Note On 的 tick 位置 | 通过 TempoMap.sample→tick 转换 |
| NoteEvent.end_anchor → tick | Note Off 的 tick 位置 | 同上 |
| NoteEvent.velocity (0..1) | Note On 的 `velocity` 字节（0..127） | 线性映射 `round(v*127)` |
| TempoMap.bpm | Meta Event `Set Tempo`（微秒/四分音符，24-bit） | `60000000 / bpm` |
| TempoMap.ppq (960) | MIDI Header Chunk 的 `division` 字段 | 直接；SMF 自带 PPQ |
| 拍号 | Meta Event `Time Signature` | 原型未保存拍号，需从 analysis 推导或显式输入 |
| RestEvent | tick 轴上无 Note On 区段 | 隐式；RestEvent 语义丢失，仅保留"此处无声" |

### 2.2 会丢失或退化的字段

| 中立字段 | 损失情况 | 说明 |
|---|---|---|
| LyricRegion.text | **部分丢失** | MIDI 有 `Lyric` Meta Event（0x05），但不同编辑器读取行为差异极大；V6.2+ 才明确支持 |
| LyricRegion.language (zh/ja) | **完全丢失** | MIDI 无语言字段 |
| LyricRegion 的字/音节切分 | **完全丢失** | 原型当前只有整段 text |
| LyricRegion → NoteEvent 的对齐 | **依赖实现** | 需要把 LyricRegion 切分到音符级 |
| RestEvent.kind | **完全丢失** | MIDI 只能隐式表达"无音" |
| StemTrack（非 master） | **完全丢失** | stem 的混音参数无处保存 |
| Anchor 共享边界 | **退化** | 共享边界变成"相邻 Note Off 与 Note On 同 tick"；anchor ID 丢失 |
| NoteEvent.confidence | **完全丢失** | — |
| NoteEvent.source | **完全丢失** | — |
| chord_overrides | **完全丢失** | — |
| analysis（tempo 之外） | **完全丢失** | — |
| source_audio（哈希、文件名） | **完全丢失** | MIDI 无音频引用 |
| preferences | **完全丢失** | — |

### 2.3 推荐的 MIDI 导出库

| 库 | 语言 | 许可证 | 适配性 |
|---|---|---|---|
| `mido` | Python | MIT | 推荐。活跃维护，纯 Python，支持 SMF 0/1/2、Meta Event、变速、PPQ |
| Python 标准库 + 自实现 SMF 写入 | Python | PSF | 可行但工作量大；适合零依赖发行 |

建议：P3 适配器使用 `mido`（MIT 许可）。引入前需按 AGENTS.md 规则写入调研或决策记录。

---

## 3. OpenUtau USTX 0.6 格式调研

### 3.1 格式概述

依据项目内 `docs/RESEARCH_NOTES.md` 已核对的官方资料：

- **当前稳定基线**：OpenUtau 0.1.565
- **格式版本**：USTX 0.6，官方公开于 [OpenUtau Wiki: USTX file format](https://github.com/openutau/OpenUtau/wiki/USTX-file-format)
- **文件性质**：UTF-8 文本，YAML 风格；扩展名 `.ustx`
- **可表达内容**：速度、拍号、轨道、歌词、音符、音高点、颤音、音素覆盖、参数曲线、伴奏引用
- **OpenUtau 导入能力**：USTX、UST、VSQX、MIDI、UFDATA、MusicXML
- **OpenUtau 导出/保存能力**：USTX（原生）、UST/MIDI/WAV
- **Phonemizer API**：实验性且可能变化；首版不依赖插件
- **三平台**：Windows、macOS、Linux

### 3.2 USTX 字段结构（草稿，需实际测试环境验证）

> 本节字段结构基于项目内已核对的"可表达内容"清单和 USTX 0.6 在 OpenUtau 代码库的已知模型推断。**字段名、嵌套层级、单位（tick 还是秒）需在 0.1.565 实机导出后用真实文件比对并固定到测试记录。**

```text
project:
  name: string
  voice_db_path: string
  resampler: string
  wavtool: string
  version: "0.6"

tracks:
  - name: string
    phonemizer: string       # 如 "ja CVVC" / "zh presamp"
    synthesizer: string

voice_parts:
  - name: string
    track_no: int
    position: int            # part 起始 tick
    notes:
      - pos: int             # 相对 part 的起始 tick
        duration: int
        lyric: string        # 单音节歌词
        pitch: int
        vibrato: { length, period, depth, in, out, shift, drift }
        pitch_points: [{ x, y, shape }]
        phoneme_overrides: [{ phoneme, offset }]

tempo:
  - position: int
    bpm: number

time_signature:
  - beat_per_bar: int
    note_per_beat: int
    bar_position: int

mix:                         # 伴奏轨
  - name: string
    file: string
    gain: number
    pan: number
    muted: boolean
    solo: boolean
```

### 3.3 中立项目 → USTX 0.6 字段映射

| 中立字段 | USTX 0.6 字段 | 转换说明 |
|---|---|---|
| TempoMap.bpm | `tempo[0].bpm` | 直接 |
| TempoMap.ppq (960) | USTX 内部 PPQ | **需验证**：USTX 历史上常用 PPQ 480；若不一致需 ×480/960 缩放 |
| 拍号 | `time_signature[0]` | 原型未保存拍号；需从 analysis 推导（默认 4/4） |
| NoteEvent.start_anchor → tick | `note.pos`（相对 part） | 全局 tick - part.position |
| NoteEvent.end_anchor - start_anchor → tick | `note.duration` | 差值 |
| NoteEvent.pitch (60=C4) | `note.pitch` | 直接整数 |
| NoteEvent.velocity (0..1) | USTX velocity 范围 | **需验证**：UTAU 传统 0..200；USTX 可能 0..127 或 0..200 |
| LyricRegion.text（整段） | `note.lyric`（逐音节） | **需要 P2 完成切分后才能逐音符导出** |
| LyricRegion.language (zh/ja) | `track.phonemizer` | 通过选择对应语言 Phonemizer 表达 |
| RestEvent | USTX 中相邻音符之间的空隙 | 隐式；或插入空音符（lyric "R"）|
| StemTrack（master） | `mix[].file` + gain/pan/mute/solo | trim/fade 不在 mix 字段内 |
| StemTrack（drums/bass/other） | 多个 `mix[]` 条目 | **需实际分离音频文件存在** |
| NoteEvent.confidence | 不支持 | 丢失 |
| NoteEvent.source | 不支持 | 丢失 |
| chord_overrides | 不支持 | 丢失 |

### 3.4 USTX 0.6 字段损失报告

USTX 0.6 是首批目标中**保真度最高**的格式，但仍会丢失：

| 损失字段 | 严重程度 | 缓解策略 |
|---|---|---|
| NoteEvent.confidence / source | 低 | USTX 无此概念；保留在项目内部 |
| StemTrack.trim/fade | 中 | 用 part envelope 近似；需实机验证 |
| Anchor.id（共享边界语义） | 低 | tick 位置自然成为边界 |
| chord_overrides / analysis | 低 | USTX 不承载和声分析 |
| NoteEvent 浮点 pitch 小数部分 | 中 | USTX pitch 通常是整数；浮点部分需 pitch_points |
| 变速段（原型暂无） | 低 | USTX 支持 tempo 数组；未来可扩展 |

### 3.5 风险与依赖

- **Phonemizer 依赖**：导出 USTX 后是否能正确发音取决于目标机器上已安装的声库和 Phonemizer。
- **PPQ 转换**：USTX 内部 PPQ 与 960 的差异需要显式处理。
- **YAML 库依赖**：写 USTX 需要 YAML 序列化；Python 标准库无 YAML，需要引入 `PyYAML`（MIT）或自实现简化 YAML 写入。
- **字段名核对**：USTX 0.6 的精确字段名必须在 0.1.565 实机导出后用真实文件比对并固定。

---

## 4. Synthesizer V Studio Pro 1.9.0 适配调研

### 4.1 脚本 API 能力

依据项目内 `docs/RESEARCH_NOTES.md` 已核对的 Dreamtonics 官方资料：

- **脚本语言**：JavaScript（ES5 风格）
- **宿主检测**：`SV.getHostInfo()` 检查版本和系统；必须验证 `version` 包含 1.9.0
- **minEditorVersion**：配套脚本必须声明 `minEditorVersion: 0x010900`
- **已确认基础对象**：Project、Track、NoteGroup、Note、Automation、TimeAxis、Selection、Playback
- **TimeAxis**：用于把物理秒、音乐拍/blick 和完整速度图互转；不能简化为单一 BPM

**关键限制**：
- ARA 与 Voice-to-MIDI 是 1.11 才加入，**不能**列入 1.9.0 能力矩阵
- 第一代插件手册说明插件只支持 Windows/macOS（Linux 无插件）
- 1.10+ 普通工程必须显式另存为 1.9.0 兼容副本才能由 1.9.0 打开
- "Import as Tracks" **不会导入速度数据**

### 4.2 .svp 工程文件结构

- 第一代工程文件为 `.svp`，但**官方没有公开稳定内部格式**
- 本项目**不直接生成或修改** `.svp`；高保真路径通过配套脚本由 Synthesizer V 自己创建工程

### 4.3 推荐的适配路径：三层路线（已确认决策）

依据 `docs/ARCHITECTURE.md` 和 `docs/RESEARCH_NOTES.md`：

```text
Layer 1: midi-baseline            — 标准 MIDI + 损失报告
Layer 2: midi-plus-helper-script  — MIDI + ES5 配套脚本 + 中立 sidecar JSON
Layer 3: ust-group-fallback       — UST 降级
```

#### Layer 1: midi-baseline

- **输出**：标准 MIDI 文件（SMF 1，PPQ 960）
- **能力**：音符、tick、velocity、tempo、拍号；歌词通过 MIDI Lyric Meta Event 写入
- **工作量**：小
- **依赖**：`mido`（MIT）

#### Layer 2: midi-plus-helper-script

- **输出**：MIDI + ES5 配套脚本（`.js`）+ 中立 sidecar JSON
- **配套脚本职责**：
  1. `SV.getHostInfo()` 检查 `version` ≥ 1.9.0；否则报错退出
  2. 通过 `Project.importMidi` 导入 MIDI
  3. 用 `TimeAxis` 重建速度图（Import as Tracks 不导入速度）
  4. 读取 sidecar JSON，应用 stem_tracks 的 gain/pan/mute/solo
  5. 应用 chord_overrides 和 preferences
- **工作量**：中
- **依赖**：`mido` + Synthesizer V 1.9.0 实机验证

#### Layer 3: ust-group-fallback

- **场景**：1.9.0 无法正常加载 MIDI 或脚本时，导出 UST 单音符序列
- **能力**：极简，仅音符+歌词+tempo
- **工作量**：小

### 4.4 三平台差异

| 平台 | 独立应用 | 插件 | 备注 |
|---|---|---|---|
| Windows | 支持 | 支持 | Layer 1/2/3 均可验证 |
| macOS | 支持 | 支持 | Layer 1/2/3 均可验证 |
| Linux | 支持 | **不支持** | 只承诺独立应用路径 |

---

## 5. VOCALOID6 6.13.0 适配调研

### 5.1 导入/导出格式

依据项目内 `docs/RESEARCH_NOTES.md`：

- **原生格式**：V5/V6 使用 `.vpr`；V3/V4 使用 `.vsqx`
- **V6 可读格式**：VPR、VSQX、MIDI
- **V6 可写格式**：VPR、MIDI
- **MIDI 歌词支持**：V6.2 起官方明确支持识别 MIDI 内嵌歌词及字符编码选择；**V6.2 之前不保证**。6.13.0 ≥ 6.2，因此 MIDI 内嵌歌词可作为通道

### 5.2 脚本 API 状况

- V3/V4 有 Job Plugin（C#/.NET），但 **V5/V6 已取消**
- VST/AU/ARA 插件是音频宿主接口，**不等于**第三方自动化 API
- VOCALOID6 **没有公开稳定的脚本 API**

### 5.3 推荐的适配路径

唯一可行的首版路径：**MIDI + 字段损失报告**。

- **输出**：标准 MIDI（SMF 1，PPQ 960），内嵌 Lyric Meta Event（UTF-8 或 Shift-JIS，需实机验证）
- **能力**：音符、tick、velocity、tempo、拍号、MIDI 歌词事件（6.2+ 识别）
- **无法表达**：stem、trim/fade、anchor 共享边界、置信度、source、chord_overrides

### 5.4 旧版 MIDI 降级路径损失报告

| 目标版本 | 原生格式 | MIDI 歌词识别 | 损失增量 |
|---|---|---|---|
| V6 6.13.0（完整版） | VPR | 6.2+ 支持 | 基线 |
| V6 Lite | VPR | 6.2+ 支持 | 两轨限制 |
| V5 | VPR | **不保证** | 歌词可能丢失 |
| V4 | VSQX | **不保证** | 歌词丢失；VSQX 不能由本项目直接生成 |
| V3 | VSQX | **不保证** | 同 V4；仅 Windows |

### 5.5 平台边界

- V3/V4 独立编辑器仅 Windows
- V5/V6 支持 Windows、macOS
- **官方编辑器没有 Linux 版本**。Linux 上只准备和检查交换文件（MIDI）
- 6.13.0 完整版（Standalone）是固定验收版本

---

## 6. 建议的适配器实现顺序

### 6.1 推荐顺序

| 顺序 | 适配器 | 工作量 | 依赖项 | 验收价值 |
|---|---|---|---|---|
| 1 | **MIDI 基线适配器** | 小 | `mido`（MIT） | 高（所有目标的基线） |
| 2 | **OpenUtau USTX 0.6 适配器** | 中 | `PyYAML`（MIT）或自实现；0.1.565 实机核对 | 高（P3 首个端到端验收） |
| 3 | **Synthesizer V Layer 1 (midi-baseline)** | 小 | 复用 1 | 中 |
| 4 | **Synthesizer V Layer 2 (midi-plus-helper-script)** | 中 | 1.9.0 实机验证 | 高（用户现有版本） |
| 5 | **Synthesizer V Layer 3 (ust-group-fallback)** | 小 | 无 | 低 |
| 6 | **VOCALOID6 6.13.0 适配器** | 小 | 复用 1；6.13.0 实机验证 | 中（P3.5 后续目标） |

### 6.2 工作量评估依据

- **小**：可在一个工作轮次内完成；代码量 < 300 行；无外部依赖或仅复用已有库
- **中**：需要 2–3 个工作轮次；代码量 300–800 行；需要实机验证或引入新库
- **大**：需要 3+ 工作轮次；代码量 > 800 行（本轮无大工作量项）

### 6.3 适配器接口建议

```python
class Adapter:
    target: str                 # "midi-baseline" / "openutau-ustx-0.6" / ...
    target_version: str
    min_editor_version: str

    def export(project: dict, output_path: str) -> ExportResult: ...
    def loss_report(project: dict) -> LossReport: ...
    def dependencies() -> list[str]: ...
```

`ExportResult` 包含：`output_files`、`loss_report`、`warnings`、`target_version_verified`。

---

## 7. 待实际测试环境验证项

### 7.1 OpenUtau USTX 0.6

- [ ] USTX 0.6 的精确字段名、嵌套结构、单位（tick vs 秒）
- [ ] USTX 内部 PPQ 是否为 480；若是，960→480 的 tick 缩放策略
- [ ] USTX velocity 范围（0..127 / 0..200 / 其他）
- [ ] 0.1.565 默认 phonemizer 名称（zh / ja）
- [ ] USTX mix 字段是否能表达 trim/fade
- [ ] YAML 子集是否足够（避免引入 PyYAML）
- [ ] 三平台打开同一 USTX 的一致性

### 7.2 Synthesizer V Studio Pro 1.9.0

- [ ] 1.9.0 实机 `SV.getHostInfo()` 返回值结构
- [ ] 1.9.0 是否支持 `Project.importMidi`；若不支持，替代 API
- [ ] 1.9.0 `TimeAxis` 重建速度图的精确 API
- [ ] 1.9.0 是否识别 MIDI Lyric Meta Event
- [ ] sidecar JSON 的存放路径约定
- [ ] ES5 脚本在三平台的运行一致性

### 7.3 VOCALOID6 6.13.0

- [ ] 6.13.0 完整版测试环境可获得性
- [ ] MIDI Lyric Meta Event 的编码选择（UTF-8 / Shift-JIS / UTF-16）
- [ ] 中文歌词在 6.13.0 中的显示与发音正确性
- [ ] VPR 是否能通过任何工具由外部生成

### 7.4 MIDI 基线

- [ ] `mido` 在三平台的安装体积与依赖
- [ ] SMF 1 多 Track 与 SMF 0 单 Track 的兼容性差异
- [ ] PPQ 960 是否需要根据目标编辑器调整

### 7.5 通用

- [ ] LyricRegion → 音符级歌词切分的 P2 实现进度
- [ ] BreathEvent 的引入时间
- [ ] 变速段的引入时间

---

## 8. 参考

### 项目内文档

- `docs/RESEARCH_NOTES.md` — 外部能力调研（截至 2026-07-20）
- `docs/ARCHITECTURE.md` — 技术方案
- `docs/MULTITRACK_COMPOSITION_DESIGN.md` — 多轨伴奏与歌声编曲重构
- `docs/ROADMAP.md` — 阶段计划
- `prototype/web-workbench/app.js` — 中立项目模型实现
- `project-state.json` — 当前研究基线

### 外部官方资料（已在 docs/RESEARCH_NOTES.md 中核对）

- OpenUtau 仓库：https://github.com/stakira/openutau
- OpenUtau USTX 文件格式：https://github.com/openutau/OpenUtau/wiki/USTX-file-format
- Synthesizer V 1.9.0 发布记录：https://dreamtonics.com/synthesizer-v-studio-1-9-0-final-update/
- Synthesizer V 宿主检测 API：https://resource.dreamtonics.com/scripting/SV.html
- Synthesizer V TimeAxis API：https://resource.dreamtonics.com/scripting/TimeAxis.html
- VOCALOID6 官方规格：https://www.vocaloid.com/en/vocaloid6/specs/
- VOCALOID6 MIDI 导出 FAQ：https://www.vocaloid.com/en/support/faq/636
- VOCALOID6 V6.2 更新说明：https://www.vocaloid.com/en/news/support_14/

---

## 9. 调研边界声明

1. 本报告未使用 WebFetch 实时访问外部网络
2. USTX 0.6 的精确字段结构基于项目内已核对的"可表达内容"清单和 OpenUtau 已知模型推断
3. Synthesizer V Studio Pro 1.9.0 脚本 API 字段细节需在实机验证后补充
4. VOCALOID6 6.13.0 完整版测试环境未获得，相关条目均为基于官方资料的推断
5. 本报告为草稿，不构成最终选型
