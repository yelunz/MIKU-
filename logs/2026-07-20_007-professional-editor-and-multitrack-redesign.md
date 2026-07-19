# 2026-07-20 / 007 / 专业编辑交互与多轨编曲重构

## 本轮目标

根据用户对可运行工作台的实测反馈，修正框选、吸附、播放快捷键和歌词区域缝隙等第一批编辑器手感问题；同时把产品从“波形分析查看器”重新定义为包含音源分离、音符候选、节奏编辑、钢琴卷帘和渐进式新手界面的多轨编曲工作台。

## 用户反馈

- 当前页面只显示波形和分段，不像标准虚拟歌姬或填词软件。
- 框选有时难以命中目标，缺少边缘吸附，相邻区域之间会漏出小缝。
- 播放只能点击按钮，缺少常见的空格播放/暂停快捷键。
- 无法逐音符调整位置、时值、正拍/反拍和节奏。
- 希望尽可能拆解无人声伴奏，形成多个可观察、可独奏、可编辑的轨道，并把可转录部分显示为音符候选。
- 完全不懂乐理的用户也应能先通过试听、形状和自然语言体验编曲，再逐步展开专业数据。

## 子 Agent 分工与结论

- `editor_interaction_audit`：审查专业时间轴交互，提出点击定位、拖动选区、可命中的边缘手柄、节拍吸附、Alt 临时绕过、Esc 取消、相邻区域共享边界和显式休止等规则，并复核本轮实现。
- `audio_decomposition_research`：核对音源分离、音频转符号和时间伸缩的官方技术与许可边界。结论是必须把音源分离、伴奏转录和人声旋律生成拆成三个独立层；`librosa` 与 `Basic Pitch` 可进入技术验证，`Demucs` 的预训练权重许可仍需解决，`Essentia` 不宜在未取得合适许可前作为默认可分发核心。
- `workbench_frontend`：设计音乐小白的渐进式体验。结论是简洁模式与专业模式必须使用同一份底层数据；界面先提供“提前/拖后、抬高/压低、更密/更疏、留空、添加上方声部”等可试听操作，再逐步展开拍、音符、钢琴卷帘、音素和引擎参数。

## 本轮完成

### 可运行工作台交互

- 增加空格播放/暂停；在歌词输入、选择框、按钮、输入法组合输入或按键重复时不误触发。
- 增加 1 拍、1/2 拍、1/4 拍和关闭四档吸附；默认 1/2 拍，按住 Alt/Option 可临时绕过。
- 增加选区起点和终点手柄、拖动调整、键盘微调与 Esc 取消。
- 增加 `pointercancel` 恢复；系统中断拖动时不会留下半完成的选区状态。
- Alt/Option 绕过吸附时同时解除网格最小时长限制；空格在非文字按钮获得焦点时仍作为全局播放键。
- 增加“连续歌词区不留小缝”选项：保存歌词区时，小于当前吸附单位的缝隙会贴合相邻区。
- 编辑相邻歌词边界时同步修改两侧时间，渲染改为共享像素边缘，减少视觉裂缝。
- 对仍然存在的较大空段显示“未分配 / 休止”块，避免用户把有意留白误认成漏选。
- 项目导入和导出保存吸附档位与连续区域偏好；导入时拒绝同轨重叠歌词区。

这些改动仍是 P1.1 的第一轮：当前边界内部仍使用秒数，不是最终的共享 `Anchor`；休止块目前由空隙计算显示，不是已保存的 `RestEvent`；歌词块整体拖动、缩放锚点、撤销/重做仍未实现。

### 产品与架构重构

- 新增《多轨伴奏与歌声编曲重构》，把处理链明确拆为：
  1. 音源分离，输出音频 stem；
  2. 音频转符号，输出带置信度的音符/鼓点候选；
  3. 人声旋律生成或输入，输出独立 `VocalTrack`。
- 规划 sample + PPQ 960 + `Anchor` 的双时间模型，使相邻歌词、休止和音符共享同一边界，从数据层消除裂缝。
- 规划 `StemAsset`、`NoteEvent`、`DrumEvent`、`RestEvent`、`BreathEvent`、`VocalTrack` 和 `EditGraph`。
- 规划 stem 轨、鼓点轨、贝斯/和声音符候选轨、钢琴卷帘和非破坏性 mute/solo/gain/pan/cut/warp。
- 明确编辑转录出的 MIDI 不会自动修改原始 WAV；用户必须清楚当前试听来自原始/分离音频、重合成候选还是外部引擎。
- 重排路线：先完成专业编辑手感和多轨/音符模型，再锁定桌面壳和三平台打包。

## 技术与许可边界

- `librosa`：ISC，可用于节拍、起音、色谱和 HPSS 快速层；下拍与拍号仍需单独验证。
- `Basic Pitch`：Apache-2.0，优先验证分离后的单一乐器轨，不承诺完整混音准确转录。[官方仓库](https://github.com/spotify/basic-pitch)
- `Demucs v4`：可作为 4-stem 质量基准，但原仓库已归档，预训练权重许可仍不明确；当前不得把权重直接随发行包分发。[官方仓库](https://github.com/facebookresearch/demucs)、[权重许可问题](https://github.com/facebookresearch/demucs/issues/327)
- `Essentia`：核心 AGPLv3，模型还可能受非商业或专有许可约束；未取得相应许可前不作为默认可分发核心。[许可说明](https://essentia.upf.edu/licensing_information.html)
- 音源分离可能产生串音和伪影；音符转录可能漏音、重音、错八度或错时值。界面只显示可替换候选和置信信息，不宣称无损恢复原工程。

## 修改文件

- `prototype/web-workbench/index.html`
- `prototype/web-workbench/styles.css`
- `prototype/web-workbench/app.js`
- `prototype/web-workbench/README.md`
- `tests/test_web_workbench_static.py`
- `docs/MULTITRACK_COMPOSITION_DESIGN.md`
- `docs/PRODUCT_DEFINITION.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `AGENTS.md`
- `README.md`
- `CHANGELOG.md`
- `project-state.json`
- `logs/2026-07-20_007-professional-editor-and-multitrack-redesign.md`

## 验证

- 使用工作区 Node 运行时检查 `app.js` 和 `desktop-bridge.js`，语法通过。
- 使用工作区 Python 运行时执行 4 项音频分析测试和 11 项 Web 工作台静态测试，共 15 项通过。
- `project-state.json` 通过 JSON 解析验证。
- `git diff --check` 通过。
- 审查 Agent 静态确认吸附、连续歌词、双侧手柄、空格、Alt、方向键和 Esc 都已实际绑定；同时发现的 `pointercancel`、Alt 最小时长和按钮焦点问题已在本轮修复。
- 最新交互的 Windows Edge 自动化因窗口状态调用超时未完成，因此本轮不宣称这些新操作已经通过真实浏览器回归；上一轮工作台基础流程的 Edge 结果不受影响。

## 尚未实现 / 下一步

- 使用 sample + PPQ 960 + 共享 `Anchor` 替换独立浮点秒边界，并保存真实 `RestEvent`。
- 增加歌词块整体拖动/拉伸、鼠标或播放头锚定缩放、自动滚动、撤销/重做和锁定。
- 建立多轨项目 schema 和最小钢琴卷帘，先用人工 fixture 验证音符移动、拉伸、拆分、合并、量化、反拍和休止。
- 对 `librosa`、`Basic Pitch` 和可替换分离后端做速度、质量、模型大小、CPU/GPU、三平台和许可 spike。
- 只有多轨数据模型稳定后才建立桌面壳，并继续 OpenUtau USTX 0.6、Synthesizer V Studio Pro 1.9.0、VOCALOID6 6.13.0 的既定适配顺序。
- 当前仍未完成真实 stem 分离、音符转录、钢琴卷帘、歌声生成、外部编辑器导出或三平台安装包。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待最终测试、提交和推送。
