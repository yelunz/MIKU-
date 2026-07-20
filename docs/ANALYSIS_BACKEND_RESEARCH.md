# 分析后端调研报告

核对日期：2026-07-20
阶段：P1.3 分析后端对比（对应 `docs/ROADMAP.md` 的 P1.3 与 `docs/MULTITRACK_COMPOSITION_DESIGN.md` 的"技术验证候选与许可边界"）
状态：调研文档，不引入依赖，不写代码实现

## 0. 调研目的与背景

当前项目用 Python 标准库自实现了透明、可复现的音频分析基线 `tools/analyze_audio.py`，用于尽早跑通"本地音频 → 中立 JSON 分析层 → 时间轴可视化"的数据通路。但它在和弦与段落精度上未达验收线（`project-state.json` 中 `audio_analysis_baseline.fixture_result`）：

- 和弦严格 Top-1 中点加权准确率 = 0.875 < 0.9 验收阈值（`chord_acceptance_passed: false`）
- 段落"主边界已检测到，但存在额外边界"（`extra_section_boundaries_present: true`）

`docs/ROADMAP.md` 的 P1.3 明确要求对比生产级分析库；`project-state.json` 的 `next_actions` 包含 `run-librosa-basic-pitch-demucs-technology-and-license-spikes`。本报告为后续接入工作做准备，只做调研，不写实现。

## 1. 当前分析基线总结

### 1.1 实现位置与运行环境

- 实现：`tools/analyze_audio.py`，文件头声明 `Deterministic, standard-library-only PCM WAV analysis baseline`
- 运行时：`python-standard-library-only`（只依赖 `argparse`、`array`、`hashlib`、`json`、`math`、`os`、`pathlib`、`statistics`、`sys`、`tempfile`、`wave`）
- 分析器标识：`miku-standard-library-audio-baseline`，`ANALYZER_VERSION = "0.1.0"`
- 确定性：同一 Python/平台 + 同一输入 + 同一参数应产生逐字节相同 JSON

### 1.2 当前能力边界

| 分析层 | 算法来源 | 能力边界 |
|---|---|---|
| `waveform` | `waveform_bins()` 直接 PCM 测量 | 固定 bin 数的 min/max/peak/rms/rms_dbfs，confidence=1.0 |
| `short_time_energy` | `prefix_squares()` + `interval_rms()` | 固定 bin 数短时 RMS，confidence=1.0 |
| `spectral_centroid` | `fft_in_place()` 自实现 radix-2 Cooley-Tukey FFT + Hann 窗 | 固定 bin 数频谱质心，confidence=0.7 |
| `tempo` | `onset_envelope()` + `autocorrelation()` + 节拍层级折叠 | 3 个候选 BPM，含 bpm、confidence、first_beat_seconds |
| `key` | FFT 色度 + Krumhansl-Schmuckler 模板 + 余弦相似度 | 5 个候选调性 |
| `chords` | 2 秒固定窗口 + 4 种质量模板（major/minor/sus4/dominant-7th） | 每窗口 3 个候选 |
| `sections` | 双向能量变化比较（前后半径窗口）+ 最小边界间距 3.0s | 最多 8 个边界 |

### 1.3 当前夹具实测结果

- 测试夹具：`fixtures/basic-c-major-120-v1/`（50s、48kHz、16-bit PCM、立体声、120 BPM、4/4、C 大调、24 小节）
- 顶级速度候选：119.993 BPM（真值 120，通过）
- 首拍：0.970 s（真值 1.000，通过）
- 顶级调性候选：C major（通过）
- 主段落边界 9.0 / 25.0 / 41.0 s 均进入候选（通过）
- **和弦严格 Top-1 中点加权准确率 0.875 < 0.9 验收线（未通过）**
- **段落存在额外边界（未通过）**

### 1.4 准确率问题的根因

**和弦 0.875 不达标** 的根因：

1. **固定 2 秒窗口**：一窗一小节，但 `ground-truth.json` 中第 20 小节在第 3 拍从 `Gsus4` 切到 `G7`（半小节换和弦），固定窗口会把两个和弦合并
2. **不区分根音与低音**：`G/B`、`C/E` 转位的低音会让色度重心偏移，把 `C/E` 误判为 `Em`
3. **只有 4 种质量**：不支持 dim、maj7、m7、add9、sus2 等扩展
4. **不分离乐器**：整段混合色度包含贝斯、电钢、打击乐谐波
5. **不做谐波抑制**：FFT 色度把 2 次、3 次谐波也并入根音色度

**段落额外边界** 的根因：

1. **只看能量变化**：1.5 dB 阈值会捕获段落内部能量起伏
2. **不建模音色/和弦/乐器变化**
3. **不约束段落数量上限**
4. **不利用结构重复性**：A 段与 B 段在和弦序列上的 self-similarity 无法识别

### 1.5 当前基线的价值（不应被替换丢弃）

基线的价值是"固定最小 JSON 契约、置信度与来源字段"。后续接入生产级库时：

- **JSON schema 不应破坏**：新分析器仍输出 `source`、`parameters`、`confidence`、`candidates`、`warnings` 字段
- **A/B 比对基线**：生产库结果应与基线在同一段夹具上对比
- **可替换分析器原则**：新库是新增 `AnalysisRun` 实体，不是替代品

---

## 2. librosa 调研

### 2.1 官方资料

- 官方文档：https://librosa.org/
- 官方仓库：https://github.com/librosa/librosa
- 许可证：**ISC License**（BSD 风格的极宽松许可）
- 在项目中的状态：`project-state.json` 已标记为 P1.3 候选

### 2.2 提供的能力（与当前痛点对应）

| 能力 | librosa API | 对当前痛点的改进 |
|---|---|---|
| Tempo / 节拍 | `librosa.beat.beat_track`、`librosa.beat.plp` | 用 onset strength envelope + 动态规划替代当前自相关 |
| 起音检测 | `librosa.onset.onset_detect`、`onset_strength` | 更稳健的起音包络 |
| 色度（和弦） | `librosa.feature.chroma_cqt`、`chroma_cens` | CQT 色度比 FFT 色度在低频更准确 |
| 调性估计 | `librosa.key.estimate`（较新版本） | 内置 Krumhansl-Schmuckler 与 temperley |
| 频谱特征 | `spectral_centroid`、`melspectrogram`、`mfcc` | 替代当前 `aggregate_centroid`，提供 MFCC 用于段落相似度 |
| HPSS | `librosa.effects.hpss` | 把混合信号分成 harmonic 与 percussive，直接解决"不分离乐器"痛点 |
| 段落分割 | `librosa.segment.recurrence_matrix`、`agglomerative` | 基于 MFCC 自相似矩阵 + 层次聚类，识别 A/B 段重复结构 |
| 重采样 | `librosa.resample`（基于 `soxr`） | 生产级抗混叠 |

### 2.3 三平台支持

- **Windows**：`pip install librosa` 直接可用；需要 Visual C++ Redistributable
- **macOS**：`pip install librosa` 可用；Homebrew 的 libsndfile
- **Linux**：`pip install librosa` 可用；`libsndfile1-dev` 通过 apt

### 2.4 依赖与体积

| 依赖 | 用途 | 体积估计 | 许可证 |
|---|---|---|---|
| `numpy` | 数组计算 | ~30 MB | BSD |
| `scipy` | 信号处理 | ~50 MB | BSD |
| `numba` | JIT 加速 | ~30 MB | BSD |
| `soundfile` | 音频 I/O | ~5 MB | BSD |
| `soxr` | 高质量重采样 | ~1 MB | LGPL |
| 其他元依赖 | — | 各 <1 MB | 各自宽松 |

**总体积估计**：约 120-180 MB（**需要实际测试验证**）。

### 2.5 集成方式

| 方式 | 描述 | 适用性 |
|---|---|---|
| Python 模块直接调用 | `import librosa; y, sr = librosa.load(path)` | 与当前 `tools/analyze_audio.py` 改造最自然 |
| 独立进程 + IPC | 包装成独立分析服务，通过 stdin/stdout JSON-RPC 与 Electron 通信 | 适合桌面壳接入 |
| 命令行子进程 | `python -m miku_analysis <input.wav> -o <output.json>` | 最简单，与当前 CLI 一致 |

### 2.6 局限

1. **下拍/拍号不直接提供**：`beat_track` 返回拍点位置，但哪个拍是下拍需要额外算法。需要结合 `madmom`（GPL，许可敏感）或自实现拍号推断
2. **和弦识别仍是模板/色度层面**：librosa 提供 `chroma_cqt`，但"色度 → 和弦符号"仍需自己写模板匹配
3. **段落分割不是开箱即用**：边界数量、合并阈值需要自己调参
4. **numba 编译开销**：首次调用会触发 JIT 编译，需要数秒预热

---

## 3. basic-pitch 调研（单乐器音频转 MIDI）

### 3.1 官方资料

- 官方仓库：https://github.com/spotify/basic-pitch
- 许可证：**Apache 2.0**（允许商业使用、修改、分发，专利授权）
- 在项目中的状态：已标记为 P1.3 候选

### 3.2 提供的能力

| 能力 | 描述 |
|---|---|
| 音频 → MIDI | 输入 WAV/MP3/FLAC，输出 `.mid` 文件 |
| 音符事件 | 每音符含 onset（秒）、duration（秒）、pitch（MIDI 0-127）、velocity（0-127） |
| 弯音 | 输出 pitch bend 事件 |
| 复音转录 | 支持多音同时，但官方明确"单一乐器上效果最好" |
| CLI | `basic-pitch <output_dir> <input_audio>` |
| Python API | `from basic_pitch.inference import predict, predict_audio` 直接返回 `NoteEvent` 列表 |

### 3.3 模型与权重

- 基于 CNN 的 onset/frame/velocity 三头模型
- 模型权重：约 5-10 MB 的 TensorFlow Lite 模型（**需要实际测试验证**）
- 基本推理使用 `tflite-runtime`，约 5-10 MB
- 模型分发：Spotify 在 PyPI 包内附带预训练权重，Apache 2.0 许可涵盖权重

### 3.4 三平台支持

- Windows / macOS / Linux：`pip install basic-pitch` 在三平台都可用
- 依赖 `tflite-runtime` 或可选 `tensorflow`
- `tflite-runtime` 在某些平台可能需要 fallback 到完整 `tensorflow`（**需要实际测试验证**）

### 3.5 与项目痛点的对应

basic-pitch 解决多轨工作流的第 2 步（音频转录）：在分离后的 bass/乐器 stem 上转录出可编辑的 `NoteEvent` 候选，直接喂给已实现的钢琴卷帘。

**重要边界**：
- basic-pitch 不适合直接对完整混音伴奏做主旋律转录
- 应只对分离后的单乐器 stem 运行
- 转录结果必须标记为"可编辑候选"，不冒充既有旋律

### 3.6 局限

1. **不区分乐器**：输出 MIDI 不带乐器标签
2. **复音混音精度下降**
3. **不输出置信度**：需要用 `onset_threshold`/`frame_threshold` 作为代理
4. **不输出替代候选**：每个音符只有一个推断，没有 top-k 备选
5. **打击乐不适用**

### 3.7 打包注意

- `tflite-runtime` 体积小（~5-10 MB），适合内置打包
- 模型权重在 PyPI 包内，Apache 2.0 允许随发行包分发
- 与 librosa 共享大部分依赖，可复用同一 Python 环境

---

## 4. Demucs 调研（音源分离）

### 4.1 官方资料

- 官方仓库：https://github.com/facebookresearch/demucs
- 代码许可证：**MIT**
- **模型权重许可证：未明确，有 CC-BY-NC 4.0 嫌疑**（issue #327）。`project-state.json` 已标记 `license-blocked-for-bundling`
- 维护状态：原仓库已归档，不再积极维护

### 4.2 提供的能力

| 能力 | 描述 |
|---|---|
| 4-stem 分离 | `drums` / `bass` / `other` / `vocals`（默认） |
| 6-stem 分离 | 在 4-stem 基础上增加 `piano` / `guitar` |
| 2-stem 分离 | `vocals` / `no_vocals`（适合卡拉 OK） |
| 模型变体 | `htdemucs`（v4 默认）、`htdemucs_ft`（fine-tuned，质量更高但更慢） |
| GPU/CPU | 自动检测 CUDA/MPS，无 GPU 时回退 CPU（慢 10-30 倍） |

### 4.3 模型权重与体积

- 单个 `htdemucs` 模型权重：约 80 MB
- 首次运行从 Hugging Face Hub 或 GitHub Release 下载到本地缓存

### 4.4 依赖与体积

| 依赖 | 用途 | 体积 | 许可证 |
|---|---|---|---|
| `torch` | 推理后端 | CPU-only 约 200 MB；CUDA 版本 1-2 GB | BSD-style |
| `torchaudio` | 音频 I/O + 频谱变换 | ~30 MB | BSD-style |
| `numpy`、`scipy` | 数组/信号 | ~80 MB | BSD |
| 其他元依赖 | — | 各 <5 MB | 各自宽松 |

**总体积估计**：CPU-only 约 300-400 MB；若打包 CUDA 版 PyTorch 则 >1 GB（**需要实际测试验证**）。

### 4.5 打包注意（关键问题）

1. **PyTorch 体积巨大**：CPU-only 版约 200 MB，CUDA 版 >1 GB
2. **首次模型下载**：Demucs 默认从网络拉取权重，违反"本地优先"；但权重许可证不明，**不得随发行包分发**
3. **CPU 推理慢**：50 秒夹具在 CPU 上 4-stem 分离约需 30-90 秒
4. **内存占用**：推理时约 2-4 GB RAM
5. **numba 与 torch 共存**：若同时打包 librosa 与 Demucs，可能产生符号冲突

### 4.6 替代方案对比

| 方案 | 许可证 | 体积 | 维护 | 适合本项目 |
|---|---|---|---|---|
| **Demucs v4** | 代码 MIT，权重受限 | 大（torch） | 已归档 | 可作为可选质量基准，不内置 |
| **Spleeter** | Apache 2.0（代码+权重） | 大（TF） | 已停更 | 权重许可更清晰但精度低于 Demucs |
| **MDX-Net** | MIT（代码+权重） | 中（onnxruntime） | 社区维护 | 可作为 Demucs 的轻量替代 |
| **openunmix** | MIT（代码+权重） | 中（torch） | 维护中 | Demucs 的上游 |

**结论**：Demucs 精度最高但权重许可阻塞内置分发；MDX-Net + ONNX Runtime 是体积/许可/精度更平衡的候选。

### 4.7 局限

1. **权重许可阻塞**：`license-blocked-for-bundling`
2. **串音与伪影**：模型分离的 stem 不是录音时的原始分轨
3. **不能恢复原始分轨**
4. **修改转录音符不改变音频**

---

## 5. 集成方式建议

`docs/ARCHITECTURE.md` 已经明确架构："中立项目模型 + 可替换分析器 + 可替换生成器 + 外部引擎适配器"。

`prototype/desktop-shell/preload.js` 当前的 `capabilities` 标志是 `launchAnalysisProcess: false`，接入分析进程时需要改 true 并新增白名单 IPC。

### 5.1 方案 A：librosa + basic-pitch 内置到 Electron（PyInstaller 打包 + IPC）

**描述**：用 PyInstaller 把 librosa + basic-pitch 打包成独立 Python 可执行文件，随 Electron 安装包分发。Electron 主进程通过 `child_process.spawn` 启动 Python 子进程，通过 stdin/stdout 流式 JSON-RPC 通信。

**优点**：
- 用户体验最好：安装即可用，无需安装 Python
- 与现有 `tools/analyze_audio.py` CLI 一致
- 符合"本地优先"原则，完全离线运行

**缺点**：
- 安装包体积暴涨：当前 101 MB，加 librosa + basic-pitch 后约 270-300 MB
- PyInstaller 对 numba/tflite-runtime 的打包有已知坑
- macOS 需要签名与公证
- 三平台需要三套 PyInstaller 构建

**体积估计**：约 300 MB NSIS 安装包（**需要实际测试验证**）。

### 5.2 方案 B：独立 Python 工具链（CLI 生成 JSON，桌面应用加载）

**描述**：把 `tools/miku_analysis/` 作为独立 Python 包发布。用户先 `pip install miku-analysis`，然后通过命令行生成分析 JSON，再用桌面应用加载。

**优点**：
- 桌面应用体积不变（仍 101 MB）
- Python 工具链独立升级，不耦合桌面发布周期
- 开发调试方便

**缺点**：
- 用户体验差：需要用户先装 Python 与 pip 包
- 非技术用户无法独立完成安装
- 不符合 P5 阶段"让非专业用户可以独立完成任务"的方向

**适用阶段**：P1.3 调研期与技术验证期。作为方案 A 的前置步骤。

### 5.3 方案 C：云端分析服务（明确否决）

**否决理由**：
- 直接违反 `docs/AGENTS.md` 的"本地优先"
- 违反 `docs/ARCHITECTURE.md` 的"本地优先与隐私"
- 用户音频可能涉及版权
- 网络依赖与延迟
- 商业化成本

### 5.4 方案 D：Demucs 作为可选插件（推荐用于音源分离）

**描述**：Demucs 不内置到主发行包，作为可选插件。用户在设置中启用"音源分离"后：
1. 安装 Python 与 `pip install demucs`，或
2. 下载预打包的 `miku-stem-separator` 独立可执行文件，或
3. 自行提供已分离的 stem 文件

**优点**：
- 主发行包不暴涨
- Demucs 权重许可核查未完成前不强行内置
- 用户可选

### 5.5 推荐组合

| 阶段 | librosa + basic-pitch | Demucs | 说明 |
|---|---|---|---|
| P1.3 调研期 | 方案 B（独立工具链） | 不接入 | 在夹具上 A/B 对比 |
| P1.3 末 / P2 前 | 方案 A（内置 PyInstaller） | 方案 D（可选插件） | librosa + basic-pitch 内置 |
| P2 歌声垂直切片 | 方案 A | 方案 D（若许可通过） | 主分析内置 |

---

## 6. 建议的实现顺序

### 6.1 按性价比排序

| 排序 | 库 | 解决的痛点 | 性价比理由 |
|---|---|---|---|
| 1 | **librosa** | 和弦 0.875 不达标、段落额外边界 | `chroma_cqt` + HPSS 直接解决"不分离乐器"和"泛音污染"；许可证 ISC 极宽松；是其他库的共享依赖 |
| 2 | **basic-pitch** | 多轨/音符候选缺失 | Apache 2.0 可内置；模型权重小；直接输出 NoteEvent 对接钢琴卷帘 |
| 3 | **Demucs**（可选） | 4-stem 分离供 basic-pitch | 权重许可阻塞内置；PyTorch 体积巨大；已归档 |

### 6.2 每个库的预估工作量

#### librosa 接入（预估 3-5 个工作日）

| 任务 | 工作量 |
|---|---|
| 创建 `tools/miku_analysis/librosa_backend.py` | 1 日 |
| 在夹具上 A/B 对比 | 1 日 |
| 调参与下拍验证 | 1-2 日 |
| PyInstaller 打包三平台 | 1 日 |
| 文档与日志 | 0.5 日 |

**关键风险**：
- 下拍/拍号不直接提供
- numba 在 PyInstaller 下的缓存问题
- `chroma_cqt` 在低采样率下低频分辨率不足

#### basic-pitch 接入（预估 2-3 个工作日）

| 任务 | 工作量 |
|---|---|
| 创建 `tools/miku_analysis/basic_pitch_backend.py` | 0.5 日 |
| NoteEvent 映射到项目模型 | 0.5 日 |
| 在分离 stem 上验证 | 1 日 |
| 置信度与替代候选后处理 | 0.5 日 |
| PyInstaller 打包 | 0.5 日 |

#### Demucs 接入（预估 5-8 个工作日，且许可未通）

| 任务 | 工作量 |
|---|---|
| 权重许可核查 | 1-2 日（并行） |
| 创建 `tools/miku_analysis/demucs_backend.py` | 0.5 日 |
| stem 输出与缓存 | 0.5 日 |
| CPU/GPU 性能测试 | 1 日 |
| 替代方案评估（MDX-Net / openunmix） | 1-2 日 |
| 可选插件分发机制 | 1-2 日 |

### 6.3 依赖项与打包影响汇总

| 库 | 新增依赖 | 增量体积 | 许可证 | 内置打包 | 风险 |
|---|---|---|---|---|---|
| librosa | numpy, scipy, numba, soundfile, soxr | ~150 MB | ISC（主）+ LGPL（soxr） | 是 | numba PyInstaller 坑、soxr LGPL |
| basic-pitch | tflite-runtime, resampy | ~20 MB（增量） | Apache 2.0 | 是 | tflite-runtime wheel 可用性 |
| Demucs | torch, torchaudio | ~300 MB（CPU）/ >1 GB（CUDA） | MIT（代码）+ 不明（权重） | 否（许可阻塞） | 权重许可、体积、维护状态 |

### 6.4 推荐实施路径

```text
P1.3 阶段
├─ 步骤 1：librosa spike（方案 B 独立工具链）
│    ├─ 在夹具上对比 tempo/first_beat/key/chord/sections
│    ├─ 验证 chroma_cqt + HPSS 是否解决和弦 0.875 不达标
│    ├─ 验证 segment 工具是否消除段落额外边界
│    └─ 评估下拍检测方案
├─ 步骤 2：basic-pitch spike（方案 B 独立工具链）
│    ├─ 在夹具的单乐器段验证转录精度
│    ├─ 评估置信度代理方案
│    └─ 评估 NoteEvent 映射完整度
├─ 步骤 3：Demucs 许可与体积评估（不接入实现）
│    ├─ 核对 issue #327
│    ├─ 评估 MDX-Net / openunmix 替代方案
│    └─ 评估可选插件分发可行性
└─ 步骤 4：若步骤 1-2 验证通过
     ├─ 升级为方案 A（PyInstaller 内置）
     ├─ 三平台 PyInstaller 构建脚本
     └─ Electron IPC 接入（launchAnalysisProcess: true）
```

---

## 7. 待验证问题

以下问题需要实际测试验证：

1. **librosa 版本与 API**：稳定版本号、`librosa.key.estimate` 的可用性
2. **librosa 依赖体积**：numpy/scipy/numba/soundfile/soxr 在三平台 PyInstaller 打包后的精确增量体积
3. **numba PyInstaller 兼容性**：JIT 缓存在 `--onedir` 与 `--onefile` 模式下的行为
4. **librosa 在 8000 Hz vs 22050 Hz 下的色度质量**
5. **basic-pitch 模型权重大小**：完整模型与 mobile 模型的精确大小
6. **tflite-runtime 三平台 wheel 可用性**
7. **basic-pitch 置信度**：是否在新版本提供 per-note confidence
8. **Demucs 权重许可**：issue #327 的最新状态
9. **Demucs CPU 性能**：50 秒夹具在三平台 CPU 上的分离耗时与内存占用
10. **numba + torch 共存**：符号冲突情况
11. **下拍/拍号检测**：madmom 评估或自实现方案
12. **macOS 签名与公证**：PyInstaller 打包的 Python 子进程在 macOS 上是否需要单独签名

---

## 8. 决策建议汇总

| 决策项 | 建议 | 理由 |
|---|---|---|
| 第一个接入的库 | **librosa** | 直接解决和弦与段落两个不达标痛点，许可证宽松，体积可接受 |
| basic-pitch 接入时机 | librosa 验证后 | 依赖 stem 分离才能发挥精度，且与 librosa 共享依赖 |
| Demucs 接入时机 | 许可核查通过后 | 权重许可阻塞内置，体积巨大，已归档 |
| 集成方式 | 方案 B 先行，验证后升级方案 A | 方案 B 调试快；方案 A 用户体验好但需要三平台构建 |
| 云端方案 | 否决 | 违反本地优先原则 |
| JSON schema | 保持 0.1.0 兼容，新增 `source` 值 | 基线价值在于契约稳定 |
| 下拍/拍号 | 单独评估 madmom 或自实现 | librosa 不内置 |
| Demucs 替代 | 评估 MDX-Net + ONNX Runtime | 体积更小、许可更清晰、维护更活跃 |

---

## 9. 与项目已有文档的对应关系

- `docs/ROADMAP.md` 的 P1.3 定义：本报告覆盖全部四个方向（快速分析库、单乐器转录、4-stem 分离、下拍/拍号）
- `docs/MULTITRACK_COMPOSITION_DESIGN.md` 的"技术验证候选与许可边界"：本报告与该文档的许可证记录一致
- `docs/RESEARCH_NOTES.md`：本报告在该文档基础上扩展了能力对应、体积估计、集成方式
- `docs/ARCHITECTURE.md` 的"分析层"原则：本报告的"保持 schema 0.1.0 兼容"建议与此一致
- `project-state.json` 的 `next_actions`：本报告为 `run-librosa-basic-pitch-demucs-technology-and-license-spikes` 与 `connect-desktop-bridge-to-packaged-python-analysis-process` 提供前置调研
- `AGENTS.md` 的"引入依赖或外部格式前，核对其官方文档、维护状态和许可证，并写入调研或决策记录"：本报告即为该核对记录

---

## 10. 不在本次调研范围

- **madmom / essentia 调研**：Essentia AGPLv3 不采用；madmom 需要单独许可评估（GPL，敏感）
- **SoundTouch / Rubber Band 调研**：时间伸缩候选，与"分析后端"主题正交
- **chord-recognition 专门库**：需要单独评估准确率与许可
- **下拍/拍号检测的专门方案**：需要 madmom 评估后单独成文
- **歌声旋律生成**：不属于"分析后端"，属于 `docs/ARCHITECTURE.md` 的"D. 歌声编排层"
