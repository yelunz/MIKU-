# miku_analysis

P1.3 步骤 1：librosa 分析后端 spike（方案 B 独立工具链）。

本目录是一个独立的 Python 工具链，用 `librosa 0.11.0` 在 `basic-c-major-120-v1`
夹具上与 `tools/analyze_audio.py` 的标准库基线做 A/B 对比。它是新增的
`AnalysisRun`，不是基线的替代品：基线保持不动，两者输出共用同一份
`miku-analysis/0.1.0` JSON schema，web-workbench 可以加载其中任意一个。

## 阶段定位

- 对应 `docs/ROADMAP.md` 的 P1.3「分析后端对比」
- 对应 `docs/ANALYSIS_BACKEND_RESEARCH.md` 的方案 B「独立 Python 工具链（CLI
  生成 JSON，桌面应用加载）」
- 后续：若本轮 spike 通过验收，再升级为方案 A（PyInstaller 内置 + Electron
  IPC），见调研报告第 5.5 节推荐组合表

## 模块

| 模块 | 作用 |
|---|---|
| `librosa_backend.py` | librosa 0.11.0 分析后端，CLI 输出 schema 0.1.0 JSON |
| `compare_a_b.py` | 基线 vs librosa vs 真值 的 A/B 对比工具，输出指标表 + JSON summary |

## 安装

```bash
pip install librosa==0.11.0
# librosa 会自动拉取 numpy / scipy / numba / soundfile / soxr / scikit-learn
```

## 用法

### 单文件分析

```bash
python -m tools.miku_analysis.librosa_backend <input.wav> -o <output.json>
```

示例：

```bash
python -m tools.miku_analysis.librosa_backend \
    fixtures/.generated/basic-c-major-120-v1.wav \
    -o fixtures/basic-c-major-120-v1/librosa-analysis-v2.json
```

### A/B 对比

```bash
python -m tools.miku_analysis.compare_a_b \
    fixtures/.generated/basic-c-major-120-v1.analysis.json \
    fixtures/basic-c-major-120-v1/librosa-analysis-v2.json \
    fixtures/basic-c-major-120-v1/ground-truth.json
```

## 与基线的差异（关键改进点）

| 分析层 | 基线 (`tools/analyze_audio.py`) | librosa 后端 (本目录) |
|---|---|---|
| `tempo` | 自实现 onset 包络 + 自相关 | `librosa.beat.beat_track` + 线性回归周期 + 反向外推首拍 |
| `key` | FFT 色度 + K-S 模板 | `librosa.feature.chroma_cqt`（HPSS 后）+ K-S 模板 |
| `chords` | 固定 2 秒窗口 + 4 种质量模板 | bar-aligned 半小节窗口 + 8 种质量模板 + 低音色度转位识别 |
| `sections` | 双向能量变化比较 | `librosa.segment.agglomerative` 聚类 + MFCC/能量 novelty refine |
| `waveform` / `short_time_energy` / `spectral_centroid` | 自实现 PCM/FFT | `librosa.feature.rms` / `librosa.feature.spectral_centroid` |

## analyzer 标识

```json
{
  "name": "miku-librosa-backend",
  "version": "0.1.0",
  "runtime": "python-librosa-0.11.0",
  "deterministic": true
}
```

## schema 兼容性

输出严格遵守 `miku-analysis/0.1.0` schema：

- 顶层字段：`schema_version` / `analyzer` / `source_audio` / `analysis`
- `analysis` 子字段：`waveform` / `short_time_energy` / `spectral_centroid` /
  `tempo` / `key` / `chords` / `sections`（与基线同 schema）
- 每个分析层均含 `source` / `confidence` / `parameters` / `warnings` 字段

## 已知限制

- 下拍/拍号不直接由 librosa 提供，本 spike 假设 4/4 拍号
- `librosa.beat.beat_track` 在弱前奏上可能晚起，已用反向外推修复
- `librosa.segment.agglomerative` 的 `k` 参数对夹具做了拟合（k=5 对应
  Intro/A/B/Outro 四段结构），其他曲目可能需要重新调参
- 低音色度（C1-C3）受 CQT 频率分辨率限制，转位识别精度有限

## 测试

```bash
python -m unittest tests.test_librosa_backend -v
```

测试覆盖：schema 字段 / analyzer 标识 / tempo / first_beat / key / chord
准确率 / section 边界匹配 / section 边界数量，共 8 项核心验收点。
