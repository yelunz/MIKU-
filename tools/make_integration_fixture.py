"""生成 v0.5.0 实机验证夹具。

构造一个最小可端到端验证的中立项目 JSON：
- 4 个 anchor（共享边界）
- 4 个 NoteEvent（C4 D4 E4 F4，每音 1 拍）
- 2 个 LyricRegion（"你好" / "世界"，中文）
- 4 个 syllable（带 reading_override 测试）
- 1 个 rest（在两组歌词之间）

用法：
    python tools/make_integration_fixture.py <output_dir>

输出文件：
    <output_dir>/integration-fixture.json
    <output_dir>/integration-fixture.ustx
    <output_dir>/integration-fixture.mid
    <output_dir>/integration-fixture-sidecar.json
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def build_project() -> dict:
    """构造 v0.3.0 中立项目夹具。"""
    # 项目内部 PPQ = 960，1 拍 = 960 tick
    # 1 秒 = 960 * (120/60) = 1920 tick
    # sample_rate 48000, 1 tick = 48000 / 1920 = 25 samples
    sample_rate = 48000
    ppq = 960
    bpm = 120
    samples_per_tick = sample_rate * 60 // (bpm * ppq)  # 25

    anchors = [
        {"id": "anchor-1", "sample": 0,           "tick": 0},
        {"id": "anchor-2", "sample": 25 * 960,    "tick": 960},
        {"id": "anchor-3", "sample": 25 * 1920,   "tick": 1920},
        {"id": "anchor-4", "sample": 25 * 2880,   "tick": 2880},
        {"id": "anchor-5", "sample": 25 * 3840,   "tick": 3840},
        {"id": "anchor-6", "sample": 25 * 4800,   "tick": 4800},
    ]

    notes = [
        {"id": "note-1", "stem_id": "master", "start_anchor_id": "anchor-1",
         "end_anchor_id": "anchor-2", "pitch": 60, "velocity": 0.8,
         "confidence": 1.0, "source": "manual"},
        {"id": "note-2", "stem_id": "master", "start_anchor_id": "anchor-2",
         "end_anchor_id": "anchor-3", "pitch": 62, "velocity": 0.8,
         "confidence": 1.0, "source": "manual"},
        # anchor-3 → anchor-4 之间是显式 rest
        {"id": "note-3", "stem_id": "master", "start_anchor_id": "anchor-4",
         "end_anchor_id": "anchor-5", "pitch": 64, "velocity": 0.8,
         "confidence": 1.0, "source": "manual"},
        {"id": "note-4", "stem_id": "master", "start_anchor_id": "anchor-5",
         "end_anchor_id": "anchor-6", "pitch": 65, "velocity": 0.8,
         "confidence": 1.0, "source": "manual"},
    ]

    lyrics = [
        {"id": "lyric-1", "start_anchor_id": "anchor-1",
         "end_anchor_id": "anchor-3", "language": "zh", "text": "你好"},
        {"id": "lyric-2", "start_anchor_id": "anchor-4",
         "end_anchor_id": "anchor-6", "language": "zh", "text": "世界"},
    ]

    rests = [
        {"id": "rest-1", "start_anchor_id": "anchor-3",
         "end_anchor_id": "anchor-4", "kind": "rest"},
    ]

    syllables = [
        {"id": "syllable-1", "lyric_id": "lyric-1", "index": 0,
         "text": "你", "default_reading": "ni", "reading_override": "ni3",
         "start_anchor_id": "anchor-1", "end_anchor_id": "anchor-2"},
        {"id": "syllable-2", "lyric_id": "lyric-1", "index": 1,
         "text": "好", "default_reading": "hao", "reading_override": "",
         "start_anchor_id": "anchor-2", "end_anchor_id": "anchor-3"},
        {"id": "syllable-3", "lyric_id": "lyric-2", "index": 0,
         "text": "世", "default_reading": "shi", "reading_override": "",
         "start_anchor_id": "anchor-4", "end_anchor_id": "anchor-5"},
        {"id": "syllable-4", "lyric_id": "lyric-2", "index": 1,
         "text": "界", "default_reading": "jie", "reading_override": "",
         "start_anchor_id": "anchor-5", "end_anchor_id": "anchor-6"},
    ]

    return {
        "schema_version": "miku-workbench-project/0.3.0",
        "source_audio": {
            "sample_rate_hz": sample_rate,
            "duration_seconds": 5.0,
            "sha256": "integration-fixture-no-audio",
            "filename": "integration-fixture.wav",
        },
        "analysis": {
            "analysis": {
                "analyzer": "manual-fixture",
                "tempo": {"candidates": [{"bpm": 120, "first_beat_seconds": 0.0}]},
                "key": {"candidates": [{"label": "C major", "confidence": 1.0}]},
            }
        },
        "tempo_map": {
            "sample_rate_hz": sample_rate,
            "ppq": ppq,
            "bpm": bpm,
            "first_beat_seconds": 0.0,
            "first_beat_sample": 0,
            "first_beat_tick": 0,
        },
        "anchors": anchors,
        "editing": {
            "lyrics": lyrics,
            "rests": rests,
            "notes": notes,
            "syllables": syllables,
            "stem_tracks": [
                {"id": "master", "kind": "master", "label": "伴奏总览",
                 "gain": 1.0, "pan": 0.0, "mute": False, "solo": False,
                 "trim": {"start_seconds": 0.0, "end_seconds": 5.0},
                 "fade": {"in_seconds": 0.0, "out_seconds": 0.0}},
            ],
        },
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python tools/make_integration_fixture.py <output_dir>", file=sys.stderr)
        return 1

    out_dir = Path(sys.argv[1]).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    project = build_project()
    project_path = out_dir / "integration-fixture.json"
    project_path.write_text(
        json.dumps(project, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"[fixture] wrote {project_path}")

    # 导出 USTX
    ustx_path = out_dir / "integration-fixture.ustx"
    r = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "export_ustx.py"),
         str(project_path), str(ustx_path)],
        capture_output=True, text=True, encoding="utf-8"
    )
    if r.returncode != 0:
        print(f"[ustx] FAILED:\n{r.stderr}", file=sys.stderr)
        return r.returncode
    print(f"[ustx] wrote {ustx_path} ({ustx_path.stat().st_size} bytes)")

    # 导出 MIDI
    midi_path = out_dir / "integration-fixture.mid"
    r = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "export_midi.py"),
         str(project_path), str(midi_path)],
        capture_output=True, text=True, encoding="utf-8"
    )
    if r.returncode != 0:
        print(f"[midi] FAILED:\n{r.stderr}", file=sys.stderr)
        return r.returncode
    print(f"[midi] wrote {midi_path} ({midi_path.stat().st_size} bytes)")

    # 导出 SynthV sidecar
    sidecar_path = out_dir / "integration-fixture-sidecar.json"
    r = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "export_synthv_sidecar.py"),
         str(project_path), str(sidecar_path)],
        capture_output=True, text=True, encoding="utf-8"
    )
    if r.returncode != 0:
        print(f"[sidecar] FAILED:\n{r.stderr}", file=sys.stderr)
        return r.returncode
    print(f"[sidecar] wrote {sidecar_path} ({sidecar_path.stat().st_size} bytes)")

    print("\n[ok] integration fixture ready at:", out_dir)
    print("\nNext steps:")
    print(f"  1. Open {ustx_path} in OpenUtau 0.1.565")
    print(f"  2. Open {midi_path} in Synthesizer V Studio Pro 1.9.0")
    print(f"  3. Run synthv_helper_script_es5.js with sidecar {sidecar_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
