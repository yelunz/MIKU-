# 第一轮音频分析技术验证

`tools/analyze_audio.py` 是一个可运行、可复现、仅依赖 Python 标准库的 PCM WAV 分析基线。它用于尽早验证“本地音频 → 中立 JSON 分析层 → 时间轴可视化”的数据通路，不代表生产版算法选型。

## 运行

在仓库根目录执行：

```powershell
python tools/analyze_audio.py input.wav -o output.analysis.json
```

如果系统 Python 不可用，可先加载 Codex 工作区依赖，再把命令中的 `python` 替换为返回的 Python 可执行文件。测试夹具的完整命令为：

```powershell
python tools/analyze_audio.py fixtures/.generated/basic-c-major-120-v1.wav -o fixtures/.generated/basic-c-major-120-v1.analysis.json
```

输入必须是未压缩的整数 PCM WAV，支持 8/16/24/32-bit 和任意正声道数。分析器先把多声道取算术平均，再以确定性的参数完成分析；它不读取夹具真值，也不根据文件名推断答案。无信号输入仍可生成测量层，但速度、调性、和弦和段落会明确标记为 `unavailable`，不会伪造候选。

## 输出结构

JSON 顶层包含：

- `source_audio`：文件名、SHA-256、编码、采样率、声道、帧数和时长。
- `analysis.waveform`：固定数量的波形最小值、最大值、峰值、RMS 和 dBFS。
- `analysis.short_time_energy`：固定数量的短时 RMS/dBFS 能量格。
- `analysis.spectral_centroid`：纯 Python radix-2 FFT 计算的固定数量频谱质心格。
- `analysis.tempo`：由对数能量起音包络、自相关、节拍层级折叠和宽松速度先验得到的速度/首拍候选。
- `analysis.key`：FFT 色度与大小调模板得到的调性候选。
- `analysis.chords`：按顶级速度候选的首拍对齐、固定时长窗口计算的和弦候选。
- `analysis.sections`：比较边界前后能量得到的段落边界和区域候选。

每个分析层都保存 `source` 与 `parameters`；直接测量层给出层级 `confidence`，推断层给出 `status`、`warnings`，并为候选、边界及候选段落保存 `confidence`。所有浮点数在序列化前固定舍入，JSON 键排序且拒绝 NaN/Infinity，因此同一 Python/平台、同一输入和参数应产生逐字节相同的输出。文件输出先写同目录临时文件再原子替换，并禁止把输出路径指向输入 WAV。

## 当前夹具结果

在 `basic-c-major-120-v1.wav` 上使用默认参数实测：

- 输入：50.0 秒、48 kHz、16-bit、双声道，SHA-256 与夹具清单一致。
- 顶级速度候选：约 `119.993 BPM`，首拍约 `0.970 s`；`60 BPM` 仍作为半速候选保留。
- 顶级调性候选：`C major`。
- 主段落边界候选包含 `9.0 s`、`25.0 s`、`41.0 s`；同时会保留音乐起点、尾奏衰减和局部能量变化造成的额外候选。
- 使用 2 秒和弦窗时，基础三和弦序列大部分可进入顶级候选；转位会因低音权重被误判，例如 `C/E` 可能被识别为 `Em`，半小节换和弦也会被一个窗口合并。
- 在当前 Windows/Codex Python 环境中，50 秒夹具单次分析约 6 秒。该数字只是技术验证测量，不是跨平台性能承诺。

生成的 WAV 与分析 JSON 位于 Git 忽略的 `fixtures/.generated/`，不提交音频或缓存。

## 局限与后续替换点

- 节拍算法对半速/倍速、切分、弱打击和变速音乐会歧义；当前速度先验只参与候选排序，不应成为不可修改的用户事实。
- 色度模板没有做人声/乐器分离、谐波抑制或复杂和声建模；不能可靠覆盖转位、扩展和弦、非三和弦及快速换和弦。
- 和弦使用固定窗口，段落仅使用能量变化；两者都必须允许用户纠正，并在生产架构中由可替换分析器升级。
- 降采样只做块平均，不是生产级抗混叠重采样器；压缩格式和浮点 WAV 也尚未支持。
- 当前实现为内存内分析，适合技术夹具。长音频需要流式解码、分层缓存、任务取消与进度报告。

该基线的价值是固定最小 JSON 契约、置信度与来源字段，并为后续跨平台分析库对比提供一个不依赖外部包的可复现参照。
