#!/usr/bin/env python3
"""自动音符转录后端（P7）.

用 librosa.pyin 跟踪主旋律 + onset 检测生成可编辑 NoteEvent 候选.

转录管线:
1. ``librosa.pyin`` 在 [fmin, fmax] 范围内逐帧估计基频 + 置信度.
2. ``librosa.onset.onset_detect`` 找音符起始点.
3. 把连续 voiced 帧合并成音符，每个音符:
   * start_seconds / duration_seconds
   * midi (从频率换算)
   * frequency (Hz, 中位数)
   * confidence (voiced 帧占比)
4. 置信度 < 0.5 的音符标记为 ``needs_review``.

输出 schema (miku-transcription/0.1.0):
{
  "schema_version": "0.1.0",
  "analyzer": {"name": "miku-transcriber", "version": "0.1.0",
               "runtime": "python-librosa-0.11.0", "method": "pyin+onset"},
  "input": {"path": "...", "duration_seconds": 50.0, "sample_rate_hz": 48000},
  "notes": [
    {"id": "n0", "start_seconds": 1.2, "duration_seconds": 0.5,
     "midi": 60, "frequency": 261.63, "confidence": 0.92,
     "needs_review": false, "source": "transcription"}
  ],
  "parameters": {"fmin_hz": 65.0, "fmax_hz": 1046.5, "hop_length": 512,
                 "onset_backtrack": true, "min_note_duration_s": 0.15}
}
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Dict, List

import librosa
import numpy as np


ANALYZER_NAME = "miku-transcriber"
ANALYZER_VERSION = "0.1.0"
ANALYZER_RUNTIME = "python-librosa-0.11.0"
SCHEMA_VERSION = "0.1.0"
METHOD = "pyin+onset"

# 默认参数：覆盖 C2 (65.41 Hz) 到 C6 (1046.5 Hz)，适合大多数人声与主旋律乐器。
DEFAULT_FMIN_HZ = 65.41
DEFAULT_FMAX_HZ = 1046.5
HOP_LENGTH = 512
MIN_NOTE_DURATION_S = 0.15  # 短于此长度的音符丢弃
NEEDS_REVIEW_THRESHOLD = 0.5  # 置信度低于此值的音符标记为待修正


def _hz_to_midi(hz: float) -> int:
    if hz <= 0:
        return 0
    return int(round(12 * math.log2(hz / 440.0) + 69))


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def transcribe_audio(
    input_path: Path,
    fmin_hz: float = DEFAULT_FMIN_HZ,
    fmax_hz: float = DEFAULT_FMAX_HZ,
) -> Dict:
    """从 input_path 转录主旋律，返回 NoteEvent 候选 manifest dict."""
    input_path = Path(input_path)
    if not input_path.exists():
        raise FileNotFoundError(f"Input audio not found: {input_path}")

    y, sr = librosa.load(str(input_path), sr=None, mono=True)
    duration = float(len(y) / sr)

    # 1. pyin 基频跟踪
    f0, voiced_flag, voiced_prob = librosa.pyin(
        y, fmin=fmin_hz, fmax=fmax_hz, sr=sr, hop_length=HOP_LENGTH,
    )
    times = librosa.times_like(f0, sr=sr, hop_length=HOP_LENGTH)

    # 2. onset 检测（用 backtrack 让 onset 落在音符真实起始点）
    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=HOP_LENGTH, backtrack=True,
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=HOP_LENGTH)

    # 3. 把连续 voiced 帧合并成音符
    notes: List[Dict] = []
    note_idx = 0
    in_note = False
    note_start = 0.0
    note_frames_f0: List[float] = []
    note_frames_prob: List[float] = []

    # 用 onset 时间作为音符边界提示：onset 附近的 voiced 转换更可能开始新音符
    onset_set = set(round(float(t), 3) for t in onset_times)

    def _flush_note(end_time: float) -> None:
        nonlocal note_idx
        if not note_frames_f0:
            return
        duration_s = float(end_time - note_start)
        if duration_s < MIN_NOTE_DURATION_S:
            return
        median_f0 = float(np.median(note_frames_f0))
        if median_f0 <= 0:
            return
        midi = _hz_to_midi(median_f0)
        confidence = float(np.mean(note_frames_prob)) if note_frames_prob else 0.0
        needs_review = confidence < NEEDS_REVIEW_THRESHOLD
        notes.append({
            "id": f"n{note_idx}",
            "start_seconds": round(float(note_start), 4),
            "duration_seconds": round(duration_s, 4),
            "midi": midi,
            "frequency": round(median_f0, 2),
            "confidence": round(confidence, 3),
            "needs_review": needs_review,
            "source": "transcription",
        })
        note_idx += 1

    for i, t in enumerate(times):
        is_voiced = bool(voiced_flag[i]) if voiced_flag is not None else (f0[i] > 0)
        is_onset = round(float(t), 3) in onset_set

        if is_voiced and not in_note:
            # 开始新音符
            in_note = True
            note_start = float(t)
            note_frames_f0 = [float(f0[i])]
            note_frames_prob = [float(voiced_prob[i]) if voiced_prob is not None else 1.0]
        elif is_voiced and in_note and is_onset:
            # onset 触发新音符边界，先 flush 旧音符
            _flush_note(float(t))
            note_start = float(t)
            note_frames_f0 = [float(f0[i])]
            note_frames_prob = [float(voiced_prob[i]) if voiced_prob is not None else 1.0]
        elif is_voiced and in_note:
            # 继续当前音符
            note_frames_f0.append(float(f0[i]))
            note_frames_prob.append(float(voiced_prob[i]) if voiced_prob is not None else 1.0)
        elif not is_voiced and in_note:
            # 音符结束
            _flush_note(float(t))
            in_note = False
            note_frames_f0 = []
            note_frames_prob = []

    # flush 最后一个音符
    if in_note:
        _flush_note(float(times[-1]))

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
            "sha256": _sha256_file(input_path),
        },
        "notes": notes,
        "parameters": {
            "fmin_hz": float(fmin_hz),
            "fmax_hz": float(fmax_hz),
            "hop_length": HOP_LENGTH,
            "onset_backtrack": True,
            "min_note_duration_s": MIN_NOTE_DURATION_S,
            "needs_review_threshold": NEEDS_REVIEW_THRESHOLD,
        },
    }
    return manifest


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Auto transcription via librosa.pyin")
    parser.add_argument("input", type=Path, help="Input audio file (wav/mp3/flac)")
    parser.add_argument(
        "-o", "--output", type=Path, default=None,
        help="Output JSON path (default: <input>.transcription.json)",
    )
    parser.add_argument("--fmin", type=float, default=DEFAULT_FMIN_HZ, help="Min fundamental frequency (Hz)")
    parser.add_argument("--fmax", type=float, default=DEFAULT_FMAX_HZ, help="Max fundamental frequency (Hz)")
    args = parser.parse_args()

    manifest = transcribe_audio(args.input, fmin_hz=args.fmin, fmax_hz=args.fmax)
    output_path = args.output or args.input.parent / f"{args.input.stem}.transcription.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(f"Transcribed {len(manifest['notes'])} notes from {args.input}")
    print(f"Output: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
