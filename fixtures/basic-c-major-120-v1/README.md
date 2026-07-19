# basic-c-major-120-v1 测试夹具

这是项目自有、可重复生成的首轮无人声伴奏测试夹具。它用于验证波形、频谱、节拍、小节、调性、和弦、段落、能量和歌声编排区域，不代表产品推荐的创作方法或唱法。

## 固定规格

- 50.000 秒、48 kHz、16-bit PCM、立体声 WAV。
- 0–1 秒为数字静音，第一拍位于 1.000 秒。
- 120 BPM、4/4、C 大调，共 24 小节。
- 1–49 秒为音乐网格，49–50 秒只保留乐器释放尾音。
- 段落为 Intro 4 小节、A 8 小节、B 8 小节、Outro 4 小节。
- 所有打击乐噪声由固定 XorShift32 种子 `20260720` 生成。
- 不读取外部歌曲、MIDI、采样包、模型或网络资源。
- 各段使用真值文件中的固定 Q8 增益；生成器会验证 Intro → A → B 的相邻能量差至少为 3 dB。

精确和弦、时间、段落和验收数据见 `ground-truth.json`。第 20 小节在第三拍从 Gsus4 切换到 G7，用于测试非整小节和弦边界。G/B 和 C/E 用于区分和弦根音与实际低音。

## 生成

在仓库根目录运行：

```powershell
python fixtures/basic-c-major-120-v1/generate.py
```

如果 Codex 环境中的系统 `python` 不可用，应先加载工作区依赖并使用其返回的 Python 可执行文件。

默认生成：

- `fixtures/.generated/basic-c-major-120-v1.wav`
- `fixtures/.generated/basic-c-major-120-v1.render-manifest.json`

可指定其他输出目录：

```powershell
python fixtures/basic-c-major-120-v1/generate.py --output-dir C:\path\to\fixture-output
```

生成器仅依赖 Python 标准库。它会在写出 WAV 后立即检查声道数、采样宽度、采样率、帧数、时长、前导数字静音和 SHA-256，并把测得的峰值、各段 RMS、频谱质心和频带相对能量写入渲染清单。

## 只验证已有输出

```powershell
python fixtures/basic-c-major-120-v1/generate.py --verify-only
```

只验证模式还会确认当前 `generate.py`、`ground-truth.json` 与渲染清单内记录的哈希一致，避免用旧音频验证新规格。

## 文件职责

- `ground-truth.json`：音乐时间轴和分析预期的权威来源。
- `generate.py`：只用数学波形和固定种子噪声渲染 WAV。
- `*.render-manifest.json`：一次具体渲染的哈希、音频元数据和测量结果。
- `*.wav`：本地生成的测试输入，不应作为大型二进制资产提交。

渲染清单是从 PCM 实测得到的记录，不应反过来覆盖符号真值。不同分析器可以有各自算法和置信度，但都应与同一份符号真值比较。

## 歌声编排说明

真值提供两个测试选区：A 段用于中文流程，B 段用于日文流程。它们只用于检查选区、歌词对齐、音符约束、局部锁定和适配器导出。`arrangement_test_vectors` 中的音域及音阶也是自动化回归约束，不是软件替用户作出的审美决定。

## 为什么不使用外部或随机素材

外部歌曲和伴奏会带来版权、分发、素材失效和持续集成无法获取的问题。每次随机改变编曲则会让失败无法复现。这个夹具只使用项目代码生成；噪声也固定算法与种子，因此同一版本的测试输入和失败现场都能重建。
