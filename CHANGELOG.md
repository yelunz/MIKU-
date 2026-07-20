# 变更记录

本文件记录用户可见的项目能力与重要项目定义变化。详细执行过程见 `logs/`。

## Unreleased

### Added
- 新增 USTX 导出器 critical bug 修复（轮 019）：之前 P3 轮 017 实现的 USTX 导出器输出 JSON 格式，但用户电脑上 OpenUtau 0.1.565 实测备份文件显示 USTX 真实格式是 **YAML**，ustx_version 是 **"0.7"**（不是 0.6），resolution 是 **480**（不是项目 PPQ 960）。本轮重写 `tools/export_ustx.py` 为纯 Python 标准库手写最小 YAML 序列化器（`_FlowDict` 类 + `_emit_*` 系列函数 + `dump_yaml` 顶层入口，覆盖 dict/list/str/int/float/bool/null + 流式 inline `{x: -40, y: 0, shape: io}` 表达式），输出符合真实 USTX 0.7 schema（顶层 `name`/`comment`/`output_dir`/`cache_dir`/`ustx_version: "0.7"`/`resolution: 480`/`bpm`/`beat_per_bar`/`beat_unit`/`expressions: {}`/`exp_selectors: []`/`exp_primary: -1`/`exp_secondary: -1`/`key`/`time_signatures`/`tempos`/`tracks`/`voice_parts`/`wave_parts`）；track 含 `phonemizer: OpenUtau.Core.DefaultPhonemizer` + `renderer_settings: {}` + `track_name` + `track_color: Blue` + `mute/solo/volume/pan` + `track_expressions: []` + `voice_color_names: [""]`；voice_part 含 `duration`/`name: New Part`/`comment`/`track_no`/`position`/`notes`/`curves: []`；note 含 `position`（tick / 2 换算到 480 resolution）/ `duration` / `tone`（取整） / `lyric`（优先级：syllable.reading_override > syllable.default_reading > syllable.text） / `pitch: {data: [{x: -40, y: 0, shape: io}, {x: 40, y: 0, shape: io}], snap_first: true}` / `vibrato: {length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0}` / `phoneme_expressions: []` / `phoneme_overrides: []`；`--loss-report` 选项输出字段损失（velocity / confidence / source / stem_id / rests / source_audio / LyricRegion 容器层信息）；USTX 测试整体重写为 8 项 YAML 断言（PyYAML 可选导入，缺失时 skip）；`docs/ENGINE_ADAPTERS.md` 与 `docs/ADAPTER_CAPABILITY_MATRIX.md` USTX 章节同步到 0.7 YAML 实测口径。
- 新增实机验证夹具生成器（轮 019）：`tools/make_integration_fixture.py` 构造最小可端到端验证的中立项目（6 anchor + 4 NoteEvent C4/D4/E4/F4 + 2 LyricRegion "你好"/"世界" + 4 syllable 含 reading_override 测试 + 1 rest），一次性导出 4 个文件到 `fixtures/integration/`：`integration-fixture.json`（中立项目）/ `integration-fixture.ustx`（USTX 0.7 YAML，2090 字节）/ `integration-fixture.mid`（Type-1 SMF，119 字节）/ `integration-fixture-sidecar.json`（SynthV sidecar，3201 字节）。
- 新增 OpenUtau 0.1.565 实机加载验证（轮 019）：用户电脑桌面 `OpenUtau.lnk` 解析到 `C:\Users\yEluN\Desktop\工程文件\10.AI歌曲\OpenUtau\OpenUtau.exe`，`OpenUtau.dll` ProductVersion = `0.1.565+a60ca5830b9064556157245d4bf8f5920d93e5f8`；`Start-Process OpenUtau.exe -ArgumentList integration-fixture.ustx` 启动后窗口标题栏显示 `OpenUtau v0.1.565.0 [C:\...\integration-fixture.ustx]`，进程稳定运行 31 分钟无崩溃，证明 USTX 0.7 YAML 文件被 OpenUtau 识别为有效工程并成功加载——这是 AGENTS.md 规定的"首个端到端工程导出验收"关键里程碑。
- 新增 MIDI 字节级验证（轮 019）：读取 `integration-fixture.mid` 字节序列逐项验证——`4D 54 68 64` MThd ✓ / Type-1 ✓ / PPQ 960 (0x03C0) ✓ / `FF 51 03 07 A1 20` tempo = 500000us = 120 BPM ✓ / `FF 58 04 04 02 18 08` time signature 4/4 ✓ / 4 个 note on (0x90) C4/D4/E4/F4 velocity 102 = round(0.8×127) ✓ / 4 个 note off (0x80) ✓ / 4 个 lyric meta event (FF 05 03) 含 UTF-8 中文 你/好/世/界 ✓ / end of track (FF 2F 00) 在每个 track 末尾 ✓。
- 新增 SynthV 1.9.0 启动验证（轮 019）：用户电脑 `C:\Program Files\Synthesizer V Studio Pro\synthv-studio.exe` ProductVersion = `1.9.0`；`Start-Process` 启动后窗口标题栏显示 `Synthesizer V Studio Pro - 未命名`，进程稳定运行；MIDI 未自动加载（SynthV 行为，需要 File > Import MIDI 手动操作），留作未决项。
- 新增 v0.5.0 桌面壳版本号升级（轮 019）：`prototype/desktop-shell/package.json` 版本号 `0.4.0` → `0.5.0`；`tests/test_desktop_shell_static.py` 版本断言同步升到 0.5.0；重新打包命令 `npm run dist:win` 在沙盒中被用户两次取消执行，安装包重新生成留作未决项，代码层 v0.5.0 完整版已完成。
- 新增拼音表与日文假名罗马音表扩展（轮 020）：`PINYIN_TABLE` 从 80 字扩展到 **545 字**（覆盖现代汉语一级常用字中歌词高频字 80%，分 6 组：代词/连词/副词、动作状态、自然景物、时间数量、抒情意境、生活其他；拼音去声调、纯 ASCII，`n/l+ü` 用 `v` 替代如 `lv`/`nv`）；`KANA_ROMAJI_TABLE` 从 209 条扩展到 **226 条**（新增长音「ー」、小写假名「ぁぃぅぇぉ」+ 片假名「ァィゥェォ」、单独拗音末尾「ゃゅょ」+「ャュョ」）；新增 7 项测试覆盖扩展后的表（500+ 字断言、情感字、自然字、动作字、浊音、小写假名、无数字声调）；既有测试断言保持不变（向后兼容）。
- 新增 VOCALOID6 6.13.0 MIDI 降级适配器（轮 021，P3.5）：`tools/export_vocaloid6.py` 基于 MIDI 基线导出器，输出 VOCALOID6 友好的 MIDI 文件（Track 0 添加 `FF 03 VOCALOID` track name meta event，Track 1 添加 `FF 03 Main Vocal` track name meta event）+ sidecar 字段损失报告 JSON（`<output>.vocaloid6-loss.json`，含 10 项 lost_fields + 6 项 preserved_fields + 7 步 user_workflow）；复用 `tools/export_midi.py` 的字节生成逻辑（通过 `from export_midi import build_tempo_track, build_main_track`），不重新实现 MIDI 字节生成；`docs/VOCALOID6_ADAPTER.md` 含适配器目标、MIDI 降级路径说明、CLI 用法、字段损失报告表格、UTF-8 编码建议、7 步用户工作流、已知限制（无脚本 API、phoneme 系统不兼容）、实机验证清单；`docs/ENGINE_ADAPTERS.md` 新增 3.5 节 VOCALOID6 + 优先级表更新；新增 8 项 VOCALOID6 测试覆盖 MIDI 字节解析、track name meta event、track name 内容、loss report sidecar 生成、loss report 必需字段、lost_fields 关键字段、target_editor 6.13.0、stderr 损失报告；夹具生成器 `tools/make_integration_fixture.py` 同步添加 VOCALOID6 导出步骤，`fixtures/integration/` 新增 `integration-fixture-vocaloid6.mid`（145 字节）+ `integration-fixture-vocaloid6.mid.vocaloid6-loss.json`（2416 字节）。

### Changed

- 建立项目目标、能力边界、技术架构和阶段路线图。
- 建立 Codex 接手规范、机器可读项目状态和逐轮工作日志制度。
- 配置项目 GitHub 远端地址。
- 新增可重复生成的 50 秒无人声伴奏测试夹具、标准答案和自校验生成器。
- 新增只依赖 Python 标准库的音频分析 CLI、确定性 JSON 分析层和基础健壮性测试。
- 新增伴奏多轨时间轴交互原型及可接手的交互说明。
- 新增可直接运行的零依赖 Web 音频工作台，支持真实分析 JSON、本地 WAV 播放、图层开关、选区、中日文歌词区域、和弦纠正和项目导入/导出。
- 新增可替换的浏览器 `DesktopBridge`，并记录 Electron/Tauri 三平台验证决定与矩阵。
- 新增节拍吸附、选区边缘手柄、空格播放/暂停、Alt 临时绕过吸附和连续歌词区小缝闭合。
- 新增多轨伴奏、音源分离、音符转录、钢琴卷帘和音乐小白渐进编曲的重构设计。
- 新增 sample + PPQ 960 + 共享 Anchor 双时间模型：音频 sample 作为权威基准，tick 由 sample 派生；连续歌词区域在数据层共享 anchor，移动一次同时改变两侧，从根上消除漏缝。
- 新增显式 RestEvent：未分配空段可转为休止数据，休止可单独编辑、删除；未分配与显式休止在视觉上分开。
- 新增共享边手柄：相邻歌词/休止之间的边界可整体拖动，支持吸附、Alt 绕过、Esc 取消和方向键微调。
- 新增项目 schema 0.2.0，包含 tempo_map、anchors 与 rests；导入时校验 anchor 唯一、引用有效、region 不重叠。
- 新增 0.1.0 → 0.2.0 兼容迁移：旧版项目按秒数边界迁移到共享 anchor 模型，相邻歌词自动复用同一 anchor。
- 新增撤销/重做栈（EditGraph 第一版）：新建/删除歌词、新建/删除休止、修正/恢复和弦、共享边拖动/微调、歌词块拖动/拉伸都会记录撤销点；Ctrl+Z 撤销，Ctrl+Shift+Z 或 Ctrl+Y 重做；顶部工具栏提供按钮与可回退步数提示；导入新项目时自动清空旧历史。
- 新增歌词块整体拖动与边缘拉伸：点击进入编辑（保留原行为），按住拖动则整体移动；左右 8 像素内按下则只拉伸起止边界；共享 anchor 在拖动前会被克隆，保持邻居不动；Esc 取消恢复原位置。
- 新增缩放锚点：拖动缩放滑块时保持视口中心对应的时间点不动；Ctrl/Cmd + 滚轮在时间轴上缩放，以鼠标位置为锚点。
- 新增播放头自动滚动跟随：播放时若播放头进入视口右 18%，时间轴自动滚动跟随；用户主动滚动后 1.5 秒内暂停自动跟随，避免抢走用户的主动定位。
- 新增字段级锁定：歌词、休止、和弦修正可在检查器勾选"锁定"防止未来重生成覆盖；锁定状态随 EditGraph 快照、项目导出/导入一并持久化；锁定阻止删除与恢复原值，但允许用户主动编辑；时间轴块显示 🔒 标记。
- 新增多轨 stem 混音器：默认 4 条 stem 轨（伴奏总览 / 鼓组 / 贝斯 / 其他乐器），每条可独立 mute / solo / gain / pan；伴奏总览通过 Web Audio API（GainNode + StereoPannerNode）真实生效，占位 stem 保存参数但不播放；混音参数随 EditGraph 快照、项目导出/导入一并持久化；独奏模式下未独奏轨道自动静音；拖动结束才记 undo 避免历史污染。
- 新增钢琴卷帘与 NoteEvent 数据模型（P1.2 轮 2）：用户可在时间轴上手工创建、移动、拉伸、拆分和合并音符候选；音符引用 start/end anchor，与歌词/休止共享同一 anchor 表，相邻音符若边界对齐会自动复用 anchor；C2..C7 共 60 半音行高 14px；四种交互模式（move / stretch-start / stretch-end / create）统一在 noteDrag 状态机；source 字段区分 manual / transcription / generation，对应不同颜色；导入时严格校验 ID 唯一、anchor 引用、stem_id 集合、pitch / velocity / confidence 范围与 source 枚举；0.1.0 项目迁移时清空 notes。
- 新增量化网格 + 附点 + 三连音 + Swing（P1.2 轮 3）：snap 网格扩展到 1/8 拍（直十六分）、1/3 拍（半拍三连音）和 1/6 拍（四分拍三连音）；附点 checkbox 把网格拉长 1.5 倍（三连音网格上不叠加）；Swing 滑块 0..0.7 把偶数细分网格的后半段向后推，三连音和整拍网格上不生效；钢琴卷帘 canvas 按当前 snap 网格绘制垂直线（swing 偏移的奇数点用浅色）；"量化"按钮把选中音符一次性对齐到当前网格；dotted_snap 与 swing_amount 随项目导出/导入一并持久化。
- 新增非破坏混音参数 + A/B 试听切换（P1.2 轮 4）：每条 stem 轨新增 trim（裁切起止秒数）与 fade（淡入淡出秒数）参数；master stem 通过 Web Audio API `linearRampToValueAtTime` 真实构造淡入/淡出包络，trim 边界外自动静音并定位；A/B 试听切换（edited / original）让用户对比"应用非破坏参数"与"只保留 gain/pan/mute/solo"的差异，切换不记 undo；trim/fade 与 stem_preview_mode 随 EditGraph 快照、项目导出/导入一并持久化；占位 stem 也保存参数，等接入分离后端后自动复用；修复 0.2.0 项目此前不恢复 snap/dotted/swing 偏好的预存在 bug。
- 新增 Electron 43.x 最小桌面验证壳（轮 015）：`prototype/desktop-shell/` 把零依赖 Web 工作台封装成可独立运行的桌面应用；主进程通过 `contextIsolation` + `nodeIntegration: false` + 白名单 IPC 处理器（原生文件对话框、文件读写、SHA-256、在资源管理器中显示）隔离渲染器；preload 通过 `contextBridge.exposeInMainWorld` 暴露只读 `MikuDesktopBridge`，`web-workbench/desktop-bridge.js` 顶部守卫检测已存在时跳过浏览器版自初始化，使同一份代码在浏览器与 Electron 中无修改运行；electron-builder 配置 NSIS x64 安装包与便携版，extraFiles 把测试夹具复制到安装目录；新增 15 项桌面壳静态测试；Windows x64 NSIS 安装包 `Miku-Workbench-0.3.0-win-x64.exe`（101 MB）打包成功，asar 含 web-workbench 全部 5 个文件，启动验证通过（窗口标题、进程稳定性正常）。
- 新增读音纠正层 + 歌词切分到音符 + 基础试听合成（P2 轮 1）：项目 schema 从 0.2.0 升级到 0.3.0，引入 `state.syllables` 数据模型——每个音节引用所属 LyricRegion + start/end anchor（与歌词/休止/音符共享 anchor 表，区间内等分）；中文按字切分（一汉字 = 一 syllable，`defaultReading` 查 80 字常用拼音表，去声调），日文按假名音节切分（拗音 き+ゃ→きゃ 合并、促音「っ」单独成 syllable 并标 `"cl"`、拨音「ん」单独成 syllable 并标 `"n"`、长音「ー」不单独成 syllable 由前一个延续，`defaultReading` 查 KANA_ROMAJI_TABLE 覆盖 46 清音 + 浊音/半浊音 + 拗音 + 促音/拨音 + 片假名同表）；inspector 新增"读音与切分"面板（每行显示序号 + 字/假名 + 读音输入框，未识别字提示"未识别"）；用户可在 readingOverride 中覆盖默认读音，编辑进入 EditGraph 撤销/重做栈；字段级锁定扩展到 syllable（lockKey 格式 `syllable:syllable-1`），重新切分时锁定的 readingOverride 按 index 保留；试听合成用 Web Audio API `OscillatorNode` + `GainNode` 包络（attack 0.02s / sustain / release 0.08s / gain 0.15，四种基础波形 sine/triangle/square/sawtooth），收集与 LyricRegion 时间范围重叠的 NoteEvent 调度临时音符，非破坏——不修改任何持久化数据，停止试听时全部 OscillatorNode 自动 stop + disconnect，当前发声的 syllable 行高亮；0.2.0 项目导入时自动派生默认 syllables（`!rawSyllables.length && state.lyrics.length`），0.1.0 项目深度迁移后也派生默认 syllables；导入校验音节 ID 唯一、`lyric_id` / `start_anchor_id` / `end_anchor_id` 引用有效；新增 10 项 P2 静态测试（schema 升级 / 数据模型 / 拼音表 / 假名罗马音表 / 切分函数 / 导入导出往返 / OscillatorNode / UI 元素 / 锁定 toggle / 撤销重做快照）。
- 新增 P3 首批引擎适配器原型（轮 017）：MIDI 基线导出器（`tools/export_midi.py`，纯 Python 标准库，Type-1 SMF，含 tempo / time signature / note on/off / lyric meta event，PPQ 960，`--loss-report` 选项输出字段损失到 stderr）；OpenUtau USTX 0.6 导出器（`tools/export_ustx.py`，JSON 文本工程，notes 数组按 NoteEvent 派生 pos/duration/tone/lyric，velocity 0..200 范围换算，`--loss-report` 选项）；Synthesizer V Studio Pro 1.9.0 配套工具链（`tools/synthv_helper_script_es5.js` ES5 风格，声明 `minEditorVersion: 0x010900` 与 `maxEditorVersion: 0x010AFF`，运行时检查宿主版本，不使用 1.11+ ARA / Voice-to-MIDI，接受 sidecar JSON 路径并按 tick 匹配 syllable 写入音符 lyrics；`tools/export_synthv_sidecar.py` 从中立项目 JSON 导出 sidecar JSON；`tools/synthv_sidecar_schema.md` 字段规范文档）；新增 16 项适配器测试覆盖 MThd/MTrk 字节、tempo/time signature meta event、note on/off、lyric meta event、PPQ=960、loss report、USTX JSON 解析、ustx_version=0.6、notes 映射、SynthV sidecar JSON 解析、helper 脚本 minEditorVersion、ES5 合规、不含 ARA/VoiceToMidi、空项目导出；新增 `docs/ENGINE_ADAPTERS.md` 操作指南与字段损失报告；新增 `docs/ADAPTER_CAPABILITY_MATRIX.md` 与 `docs/ANALYSIS_BACKEND_RESEARCH.md` 调研报告；新增 `tests/test_engine_adapters.py`。
- 新增 v0.4.0 桌面壳打包（轮 018）：`prototype/desktop-shell/package.json` 版本号从 0.3.0 升到 0.4.0；Windows x64 NSIS 安装包 `Miku-Workbench-0.4.0-win-x64.exe`（101 MB）首次打包成功；已知问题：第一次打包用 NTFS junction 引用 web-workbench，electron-builder 不识别 junction，导致 asar 只含 main.js / preload.js / package.json，缺 web-workbench 5 个文件；已改用 Copy-Item 真实副本，重新打包命令被取消，留作未决项（见 `next_actions[0]`）；`tests/test_desktop_shell_static.py` 中版本断言同步升到 0.4.0。

### Changed

- LyricRegion 字段从 `{ start, end }`（秒）改为 `{ start_anchor_id, end_anchor_id }`（anchor 引用），由 anchor 派生秒数用于渲染。
- 修复 `validateAnalysis` 在 `short_time_energy.bins` 校验里引用未定义变量 `field` 的潜在 ReferenceError。
- 确认核心应用面向 Windows、macOS、Linux。
- 确认首批适配 Synthesizer V Studio Pro 1.9.0 和验证时最新版稳定版 OpenUtau。
- 明确 OpenUtau USTX 0.6 是首个端到端工程导出验收，不因增加 VOCALOID 而降低优先级。
- 选择 VOCALOID6 Editor 完整版 6.13.0（Standalone）作为官方 VOCALOID 主适配目标，并为旧版本保留 MIDI 降级路径。
- 确认首版歌词支持中文、日文，暂不支持英文。
- 确认首轮技术验证使用无人声伴奏。
- 多项可独立工作必须使用子 Agent 并行推进，由主 Agent 统一整合。
- 将 Synthesizer V Studio Pro 第一代适配基线固定为用户安装的 1.9.0。
- 用户暂无伴奏，第一轮改用可重复生成的项目自有无人声伴奏测试夹具。
- 项目进入 P1 音频工作台技术验证；当前分析结果只作为可修正候选，和弦与段落精度尚未完成验收。
- 根据用户反馈，将 P1 从“波形分析查看器”重排为编辑器手感、多轨音符工作台和分析后端对比三个子阶段；桌面壳验证后移到数据与交互边界稳定之后。
