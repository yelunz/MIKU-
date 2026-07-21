#!/usr/bin/env python3
"""4-stem 音源分离后端（P6）.

实现方案：librosa HPSS + 频段掩码，不依赖 Demucs / Spleeter 等外部模型.

分离管线:
1. ``librosa.effects.hpss`` 把混合信号分成 harmonic (H) 和 percussive (P).
   * drums = P（打击乐成分集中在 percussive 谱）
2. 对 H 做短时傅里叶变换，按频段切分:
   * bass   = H 中 20-250 Hz 部分逆变换
   * vocals = H 中 300-3400 Hz 部分逆变换（人声主要能量区间）
   * other  = H 减去 bass + vocals 后剩余部分（其他 harmonic 内容）

这个方案不是 SOTA（不如 Demucs v4），但:
* 纯 librosa 0.11.0 实现，无外部模型权重，无 GPL 许可问题.
* 已通过 PyInstaller 打包进 miku-analysis-server.exe，不需要联网下载模型.
* 在 50 秒测试夹具上 < 5 秒完成，适合交互式工作流.

输出: 4 个 stem WAV 文件（16-bit PCM, 与输入同采样率）+ 一个 manifest JSON.

manifest schema (miku-stem-separation/0.1.0):
{
  "schema_version": "0.1.0",
  "analyzer": {"name": "miku-stem-separator", "version": "0.1.0",
               "runtime": "python-librosa-0.11.0", "method": "hpss+spectral-mask"},
  "input": {"path": "...", "duration_seconds": 50.0, "sample_rate_hz": 48000,
            "channels": 2, "sha256": "..."},
  "stems": {
    "vocals": {"path": "...", "duration_seconds": 50.0, "sample_rate_hz": 48000},
    "drums":  {"path": "...", "duration_seconds": 50.0, "sample_rate_hz": 48000},
    "bass":   {"path": "...", "duration_seconds": 50.0, "sample_rate_hz": 48000},
    "other":  {"path": "...", "duration_seconds": 50.0, "sample_rate_hz": 48000}
  },
  "parameters": {"hpss_kernel": 31, "bass_high_hz": 250.0,
                 "vocals_low_hz": 300.0, "vocals_high_hz": 3400.0}
}
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Dict

import librosa
import numpy as np
import soundfile as sf


ANALYZER_NAME = "miku-stem-separator"
ANALYZER_VERSION = "0.1.0"
ANALYZER_RUNTIME = "python-librosa-0.11.0"
SCHEMA_VERSION = "0.1.0"
METHOD = "hpss+spectral-mask"

# 频段常数（Hz）。bass 与 vocals 之间留 50 Hz 间隙避免相互泄漏。
BASS_HIGH_HZ = 250.0
VOCALS_LOW_HZ = 300.0
VOCALS_HIGH_HZ = 3400.0
HPSS_KERNEL = 31  # librosa.effects.hpss 默认值，平衡分离性与artifact


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _spectral_mask(
    y: np.ndarray,
    sr: int,
    low_hz: float,
    high_hz: float,
    n_fft: int = 2048,
    hop_length: int = 512,
) -> np.ndarray:
    """对 y 应用 [low_hz, high_hz] 频段理想带通掩码并逆变换.

    用 STFT 幅度谱的硬掩码（幅度置零 + 原相位逆变换），简单可靠.
    """
    stft = librosa.stft(y, n_fft=n_fft, hop_length=hop_length)
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    mask = np.zeros_like(freqs, dtype=np.float64)
    mask[(freqs >= low_hz) & (freqs <= high_hz)] = 1.0
    masked = stft * mask[:, None]
    return librosa.istft(masked, hop_length=hop_length, length=len(y))


def separate_stems(input_path: Path, output_dir: Path) -> Dict:
    """把 input_path 的音频分离成 4 个 stem WAV，写到 output_dir.

    Returns:
        manifest dict (miku-stem-separation/0.1.0)
    """
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        raise FileNotFoundError(f"Input audio not found: {input_path}")

    # librosa 默认混为 mono；这里保留原始采样率，混 mono 做分离（速度优先）。
    y, sr = librosa.load(str(input_path), sr=None, mono=True)
    duration = float(len(y) / sr)

    # 1. HPSS 分出 harmonic + percussive
    y_harmonic, y_percussive = librosa.effects.hpss(y, kernel_size=HPSS_KERNEL)

    # 2. drums = percussive
    drums = y_percussive

    # 3. bass = harmonic 低频部分
    bass = _spectral_mask(y_harmonic, sr, 20.0, BASS_HIGH_HZ)

    # 4. vocals = harmonic 中频部分
    vocals = _spectral_mask(y_harmonic, sr, VOCALS_LOW_HZ, VOCALS_HIGH_HZ)

    # 5. other = harmonic - bass - vocals（残余 harmonic 内容）
    #    用长度对齐的安全减法，避免掩码边界导致的长度差异。
    min_len = min(len(y_harmonic), len(bass), len(vocals))
    other = y_harmonic[:min_len] - bass[:min_len] - vocals[:min_len]

    # 写 4 个 stem WAV（16-bit PCM，与输入同采样率）
    stems = {}
    for name, signal in (("vocals", vocals), ("drums", drums), ("bass", bass), ("other", other)):
        stem_path = output_dir / f"{input_path.stem}.{name}.wav"
        # 归一化到 -3 dBFS 避免削波
        peak = float(np.max(np.abs(signal))) if len(signal) > 0 else 0.0
        if peak > 0.0:
            signal = signal / peak * 0.7079  # -3 dBFS
        sf.write(str(stem_path), signal.astype(np.float32), sr, subtype="PCM_16")
        stems[name] = {
            "path": str(stem_path),
            "duration_seconds": float(len(signal) / sr),
            "sample_rate_hz": int(sr),
        }

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "analyzer": {
            "name": ANALYZER_NAME,
            "version": ANALYZER_VERSION,
            "runtime": ANALYZER_RUNTIME,
            "method": METHOD,
        },
        "input": {
            "path": str(input_path),
            "duration_seconds": duration,
            "sample_rate_hz": int(sr),
            "channels": 1,  # 已混为 mono
            "sha256": _sha256_file(input_path),
        },
        "stems": stems,
        "parameters": {
            "hpss_kernel": HPSS_KERNEL,
            "bass_high_hz": BASS_HIGH_HZ,
            "vocals_low_hz": VOCALS_LOW_HZ,
            "vocals_high_hz": VOCALS_HIGH_HZ,
        },
    }
    return manifest


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="4-stem separation (HPSS + spectral mask)")
    parser.add_argument("input", type=Path, help="Input audio file (wav/mp3/flac)")
    parser.add_argument(
        "-o", "--output-dir", type=Path, default=None,
        help="Output directory for stem WAVs (default: <input>.stems/)",
    )
    parser.add_argument(
        "--manifest", type=Path, default=None,
        help="Write manifest JSON to this path (default: <output-dir>/manifest.json)",
    )
    args = parser.parse_args()

    output_dir = args.output_dir or args.input.parent / f"{args.input.stem}.stems"
    manifest = separate_stems(args.input, output_dir)

    manifest_path = args.manifest or (output_dir / "manifest.json")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(manifest['stems'])} stems to {output_dir}")
    print(f"Manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
