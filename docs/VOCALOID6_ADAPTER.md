# VOCALOID6 6.13.0 适配器

本文件描述 VOCALOID6 Editor 完整版 6.13.0（Standalone）的适配器目标、
适配路径、CLI 用法、字段损失报告、编码建议、用户工作流、已知限制与实机
验证清单。适配调研背景见 `docs/ADAPTER_CAPABILITY_MATRIX.md` 第 5 节；
架构层定位见 `docs/ARCHITECTURE.md` 第 G 节"外部适配器层"。

## 1. 适配器目标

- **目标编辑器**：VOCALOID6 Editor 完整版 6.13.0（Standalone）
- **目标形态**：Standalone（独立编辑器，非 VST/AU/ARA 插件）
- **平台**：Windows、macOS（官方编辑器没有 Linux 版本；Linux 上只准备和
  检查交换文件）
- **阶段**：P3.5（后续适配目标，优先级低于 P3 的 MIDI / USTX / SynthV）
- **版本固定**：AGENTS.md 明确"VOCALOID 后续适配目标已选定为 VOCALOID6
  Editor 完整版 6.13.0（Standalone）；旧版本只走明确标注损失的 MIDI 降级
  路径。"

## 2. 适配路径：MIDI 降级

VOCALOID6 的原生格式 `.vpr`（V5/V6）和 `.vsqx`（V3/V4）都是专有二进制，
没有公开稳定规范；VOCALOID6 也没有公开稳定的脚本 API（V3/V4 的 Job
Plugin 已在 V5/V6 取消，VST/AU/ARA 不等于第三方自动化 API）。因此本适配
器**只走 MIDI 降级路径**：

- **不直接读写** `.vpr` / `.vsqx` 专有二进制格式
- **不依赖** GUI 自动化或界面自动点击
- **复用** `tools/export_midi.py` 的字节级 MIDI 生成逻辑（Type-1 SMF，
  PPQ 960，含 tempo / time signature / note on-off / lyric meta event）
- **新增** VOCALOID6 特定处理：
  1. Track 0（tempo track）添加 track name meta event `FF 03 08 VOCALOID`
  2. Track 1（main track）添加 track name meta event
     `FF 03 0A Main Vocal`
  3. 歌词编码强制 UTF-8（MIDI 基线已是 UTF-8，VOCALOID6 V6.2+ 支持
     识别；用户需在导入时手动选择 UTF-8）
  4. 生成 sidecar 字段损失报告 JSON `<output>.vocaloid6-loss.json`

### 2.1 为什么 MIDI 降级是唯一可行首版路径

依据 `docs/ADAPTER_CAPABILITY_MATRIX.md` 第 5 节调研：

- **MIDI 歌词支持**：V6.2 起官方明确支持识别 MIDI 内嵌歌词及字符编码
  选择；6.13.0 ≥ 6.2，因此 MIDI 内嵌歌词可作为通道
- **V6 可读格式**：VPR、VSQX、MIDI
- **V6 可写格式**：VPR、MIDI
- **无脚本 API**：不能用脚本自动化导入、设置声库或调整音素

### 2.2 旧版 MIDI 降级矩阵

| 目标版本 | 原生格式 | MIDI 歌词识别 | 损失增量 |
|---|---|---|---|
| V6 6.13.0（完整版） | VPR | 6.2+ 支持 | 基线 |
| V6 Lite | VPR | 6.2+ 支持 | 两轨限制 |
| V5 | VPR | **不保证** | 歌词可能丢失 |
| V4 | VSQX | **不保证** | 歌词丢失；VSQX 不能由本项目直接生成 |
| V3 | VSQX | **不保证** | 同 V4；仅 Windows |

## 3. CLI 用法

```bash
# 导出 VOCALOID6 友好的 MIDI + sidecar 损失报告
python tools/export_vocaloid6.py <project.json> <output.mid>

# 只打印字段损失报告到 stderr（不导出文件）
python tools/export_vocaloid6.py <project.json> <output.mid> --loss-report
```

导出后会在 `<output.mid>` 旁边生成 sidecar 文件
`<output.mid>.vocaloid6-loss.json`，包含所有丢失字段的显式标注。

## 4. 字段损失报告

下表对应 sidecar JSON 中 `lost_fields` 数组的每一项。AGENTS.md 要求"旧
版本只走明确标注损失的 MIDI 降级路径"，因此每个丢失字段都附带原因说明。

| 中立字段 | 损失情况 | 原因 |
|---|---|---|
| `syllable.default_reading` | 完全丢失 | VOCALOID6 用自己的 phoneme 系统；只有歌词文本通过 MIDI lyric meta event 保留 |
| `syllable.reading_override` | 完全丢失 | 同上 |
| `note.confidence` | 完全丢失 | MIDI 基线不承载置信度 |
| `note.source` | 完全丢失 | MIDI 基线不区分 manual/transcription/generation |
| `note.stem_id` | 完全丢失 | VOCALOID6 导入单条人声轨；多 stem 信息丢失 |
| `rests` | 隐式退化 | VOCALOID6 把休止表达为音符之间的间隙，无显式休止事件 |
| `lyrics (LyricRegion container)` | 完全丢失 | 只有音节级歌词写入 MIDI；LyricRegion 容器分组与语言信息丢失 |
| `source_audio` | 完全丢失 | MIDI 不承载音频引用 |
| `tempo_map.first_beat_seconds` | 完全丢失 | VOCALOID6 假设第一个 tempo 在 position 0 |
| `stem_tracks non-destructive params` | 完全丢失 | VOCALOID6 不支持 stem mixer |

### 4.1 保留字段

| 中立字段 | MIDI 表达 |
|---|---|
| `note.pitch` | MIDI tone（Note On/Off 的 note 字节） |
| `note.velocity` | MIDI Note On velocity（0-127） |
| `note` 起止时序 | 通过 anchor tick 派生的 Note On/Off tick |
| `syllable.text` | MIDI lyric meta event `FF 05`（UTF-8） |
| `tempo_map.bpm` | tempo meta event `FF 51` |
| 拍号 | time signature meta event `FF 58` |

## 5. 编码建议

- **MIDI 内嵌歌词编码**：UTF-8。MIDI 基线导出器已用 UTF-8 写入
  `FF 05` lyric meta event；VOCALOID6 适配器复用同一逻辑，不改变编码。
- **VOCALOID6 V6.2+ 编码支持**：UTF-8 与 Shift-JIS。中文歌词用 UTF-8；
  日文歌词用 UTF-8 或 Shift-JIS。
- **VOCALOID6 默认编码**：Shift-JIS。用户在 File > Import > MIDI 对话框
  中**必须手动选择 UTF-8**，否则中文歌词会显示为乱码。
- **Track 命名**：VOCALOID6 导入 MIDI 时读取 track name meta event
  （`FF 03`）。Track 0 设为 `VOCALOID`，Track 1 设为 `Main Vocal`，方便
  用户在导入对话框中识别并选择人声轨。

## 6. 用户工作流

sidecar JSON 中 `user_workflow` 数组记录了用户在 VOCALOID6 中完成导入
所需的 7 个步骤：

1. 打开 VOCALOID6 Editor 6.13.0 Standalone
2. File > Import > MIDI
3. 选择导出的 `.mid` 文件
4. 在编码对话框中选择 UTF-8
5. 确认 track name "Main Vocal" 被选为人声轨
6. 在钢琴卷帘中目视检查音符与歌词
7. 用 VOCALOID6 phoneme 面板为每个音符手动调整发音

## 7. 已知限制

- **无脚本 API**：VOCALOID6 没有公开稳定的脚本 API，不能自动设置声库、
  自动调整音素或自动应用读音覆盖。所有 phoneme 调整必须由用户手动完成。
- **phoneme 系统不兼容**：VOCALOID6 用自己的 phoneme 系统（基于声库的
  音素字典），与中立项目的 `syllable.default_reading` /
  `reading_override`（拼音 / 罗马音）不兼容。导出只保留歌词文本，发音
  由 VOCALOID6 在导入后根据声库自动推断，用户需手动修正。
- **`.vpr` / `.vsqx` 不直接生成**：专有二进制格式没有公开稳定规范；本
  适配器只生成公开标准的 MIDI。
- **Linux 无官方编辑器**：VOCALOID6 官方编辑器没有 Linux 版本。Linux 上
  只准备和检查交换文件（MIDI + sidecar JSON），实际打开验收在
  Windows/macOS 进行。
- **V6.2 之前不保证歌词识别**：V5/V4/V3 不保证识别 MIDI 内嵌歌词；旧版
  本只走 MIDI 降级且歌词可能丢失，已在损失报告中标注。
- **单声部导入**：VOCALOID6 导入 MIDI 时把选中的轨作为单条人声轨；多
  stem 信息（drums/bass/other）丢失，需用户手工重建。
- **tempo 假设**：VOCALOID6 假设第一个 tempo 在 position 0；
  `tempo_map.first_beat_seconds` 非零时会有首拍偏移，导出时不修正（在
  损失报告中标注）。

## 8. 实机验证清单

以下项目需在 VOCALOID6 6.13.0 完整版 Standalone 实机中验证。本轮
（P3.5 实现）只完成代码与测试，实机验证待用户提供的测试环境。

### 8.1 导入与显示

- [ ] File > Import > MIDI 能成功打开导出的 `.mid` 文件
- [ ] 编码对话框中选择 UTF-8 后，中文歌词正确显示（无乱码）
- [ ] 编码对话框中选择 UTF-8 后，日文歌词正确显示（无乱码）
- [ ] Track name "Main Vocal" 在轨道列表中正确显示
- [ ] Track name "VOCALOID" 在 tempo 轨中正确显示
- [ ] 钢琴卷帘中音符的 pitch 与中立项目 `note.pitch` 一致
- [ ] 钢琴卷帘中音符的时序与中立项目 anchor tick 一致
- [ ] 钢琴卷帘中音符的 velocity 与中立项目 `note.velocity` 一致
- [ ] tempo（BPM）与中立项目 `tempo_map.bpm` 一致
- [ ] 拍号与中立项目一致（默认 4/4）

### 8.2 歌词与发音

- [ ] 每个音符的歌词文本正确显示在钢琴卷帘中
- [ ] 中文歌词（如"你好世界"）逐字显示在对应音符上
- [ ] 日文歌词（如假名）逐音节显示在对应音符上
- [ ] VOCALOID6 能根据声库自动推断发音（可能不准确，需手动修正）
- [ ] 用户能在 phoneme 面板中手动修正每个音符的发音

### 8.3 损失字段确认

- [ ] `syllable.default_reading` 不在 VOCALOID6 中显示（确认丢失）
- [ ] `syllable.reading_override` 不在 VOCALOID6 中显示（确认丢失）
- [ ] `note.confidence` 不在 VOCALOID6 中显示（确认丢失）
- [ ] `note.source` 不在 VOCALOID6 中显示（确认丢失）
- [ ] `note.stem_id` 不在 VOCALOID6 中显示（确认丢失）
- [ ] 休止表达为音符间隙，无显式休止事件（确认退化）
- [ ] LyricRegion 容器分组信息丢失（确认丢失）
- [ ] `source_audio` 引用丢失（确认丢失）

### 8.4 平台验证

- [ ] Windows：VOCALOID6 6.13.0 完整版 Standalone 导入与显示验证
- [ ] macOS：VOCALOID6 6.13.0 完整版 Standalone 导入与显示验证
- [ ] Linux：交换文件（MIDI + sidecar JSON）生成与检查（无实机打开）

### 8.5 旧版降级验证（可选）

- [ ] V6 Lite：两轨限制验证
- [ ] V5：MIDI 歌词识别不保证验证
- [ ] V4：MIDI 歌词丢失验证
- [ ] V3：仅 Windows + MIDI 歌词丢失验证

## 9. sidecar 损失报告 JSON 结构

sidecar 文件 `<output.mid>.vocaloid6-loss.json` 的结构如下：

```json
{
  "schema_version": "miku-vocaloid6-loss-report/0.1.0",
  "source_project_schema": "miku-workbench-project/0.3.0",
  "target_editor": "vocaloid6-editor-6.13.0-standalone",
  "export_path": "MIDI baseline degradation",
  "encoding": "UTF-8 (VOCALOID6 V6.2+ supports UTF-8 lyrics; user must select UTF-8 in Import dialog)",
  "track_naming": "Track 0: VOCALOID, Track 1: Main Vocal (via FF 03 meta event)",
  "lost_fields": [
    {"field": "syllable.default_reading", "reason": "..."},
    {"field": "syllable.reading_override", "reason": "..."},
    {"field": "note.confidence", "reason": "..."},
    {"field": "note.source", "reason": "..."},
    {"field": "note.stem_id", "reason": "..."},
    {"field": "rests", "reason": "..."},
    {"field": "lyrics (LyricRegion container)", "reason": "..."},
    {"field": "source_audio", "reason": "..."},
    {"field": "tempo_map.first_beat_seconds", "reason": "..."},
    {"field": "stem_tracks non-destructive params", "reason": "..."}
  ],
  "preserved_fields": [
    "note.pitch (as MIDI tone)",
    "note.velocity (as MIDI note on velocity 0-127)",
    "note timing (via anchors tick)",
    "syllable.text (as MIDI lyric meta event FF 05)",
    "tempo_map.bpm (as tempo meta event FF 51)",
    "time signature (as FF 58)"
  ],
  "user_workflow": [
    "1. Open VOCALOID6 Editor 6.13.0 Standalone",
    "2. File > Import > MIDI",
    "3. Select the exported .mid file",
    "4. In encoding dialog, choose UTF-8",
    "5. Confirm track name 'Main Vocal' is selected as vocal track",
    "6. Visually verify notes and lyrics in piano roll",
    "7. Manually adjust phonemes for each note using VOCALOID6 phoneme panel"
  ]
}
```

sidecar JSON 是机器可读的损失契约，满足 AGENTS.md"旧版本只走明确标注损失
的 MIDI 降级路径"的要求。用户可在导出后直接阅读 sidecar 了解所有丢失字
段，无需查阅文档。
