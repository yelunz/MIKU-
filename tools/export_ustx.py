#!/usr/bin/env python3
"""OpenUtau USTX 0.6 exporter (P3).

Reads a neutral miku-workbench-project JSON file and writes a USTX 0.6
engineering file in JSON text form.  USTX 0.6 is OpenUtau's native project
format (UTF-8 JSON text with ``.ustx`` extension).  This exporter produces
a single voice part holding the master notes plus per-syllable lyrics.

CLI usage:
    python tools/export_ustx.py <project.json> <output.ustx>
    python tools/export_ustx.py <project.json> <output.ustx> --loss-report
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


USTX_VERSION = "0.6"
DEFAULT_PPQ = 960
LOSS_REPORT_LINES = (
    "USTX 0.6 loss report",
    "- velocity mapped to USTX 0..200 range; confidence lost",
    "- source (manual/transcription/generation) lost: USTX has no origin field",
    "- multiple stem tracks flattened into a single voice part",
    "- rests are implicit: expressed as gaps between notes",
    "- syllable.default_reading lost: only reading_override or fallback used",
    "- stem_tracks trim/fade not carried: USTX mix does not support trim/fade directly",
    "- chord_overrides and analysis layers lost: USTX does not carry harmonic analysis",
    "- anchor shared boundary degrades: shared edge becomes consecutive note positions",
    "- source_audio hash and file name lost: USTX references audio by file path only",
)


def load_project(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def derive_tempo_map(project: dict[str, Any]) -> dict[str, Any]:
    raw = project.get("tempo_map") or {}
    if raw.get("ppq") and raw.get("bpm"):
        sample_rate = int(raw.get("sample_rate_hz") or 48000)
        bpm = float(raw["bpm"])
        first_beat_seconds = float(raw.get("first_beat_seconds") or 0.0)
        first_beat_sample = int(raw.get("first_beat_sample")
                                or round(first_beat_seconds * sample_rate))
        first_beat_tick = int(raw.get("first_beat_tick") or 0)
        ticks_per_second = (bpm / 60.0) * int(raw["ppq"])
        return {
            "sample_rate_hz": sample_rate,
            "ppq": int(raw["ppq"]),
            "bpm": bpm,
            "first_beat_seconds": first_beat_seconds,
            "first_beat_sample": first_beat_sample,
            "first_beat_tick": first_beat_tick,
            "ticks_per_second": ticks_per_second,
        }

    analysis = project.get("analysis") or {}
    inner = analysis.get("analysis") if isinstance(analysis, dict) else {}
    tempo = (inner or {}).get("tempo") or {}
    candidates = tempo.get("candidates") or []
    if not candidates:
        raise ValueError("Project has no tempo_map and analysis layer has no tempo candidate.")
    first = candidates[0]
    bpm = float(first["bpm"])
    first_beat_seconds = float(first.get("first_beat_seconds") or 0.0)
    sample_rate = int((project.get("source_audio") or {}).get("sample_rate_hz") or 48000)
    ppq = DEFAULT_PPQ
    first_beat_sample = round(first_beat_seconds * sample_rate)
    ticks_per_second = (bpm / 60.0) * ppq
    return {
        "sample_rate_hz": sample_rate,
        "ppq": ppq,
        "bpm": bpm,
        "first_beat_seconds": first_beat_seconds,
        "first_beat_sample": first_beat_sample,
        "first_beat_tick": 0,
        "ticks_per_second": ticks_per_second,
    }


def build_anchor_index(project: dict[str, Any], tempo_map: dict[str, Any]) -> dict[str, dict[str, int]]:
    anchors: dict[str, dict[str, int]] = {}
    for entry in project.get("anchors") or []:
        anchor_id = entry.get("id")
        if not anchor_id:
            continue
        sample = int(entry.get("sample") or 0)
        tick = entry.get("tick")
        if tick is None:
            tick = int(round(tempo_map["first_beat_tick"]
                            + (sample - tempo_map["first_beat_sample"])
                            / tempo_map["sample_rate_hz"]
                            * tempo_map["ticks_per_second"]))
        anchors[anchor_id] = {"sample": sample, "tick": max(0, int(tick))}
    return anchors


def anchor_tick(anchor_index: dict[str, dict[str, int]], anchor_id: str) -> int:
    anchor = anchor_index.get(anchor_id)
    if anchor is not None:
        return anchor["tick"]
    return 0


def collect_master_notes(project: dict[str, Any]) -> list[dict[str, Any]]:
    notes = (project.get("editing") or {}).get("notes") or []
    return [note for note in notes if (note.get("stem_id") or "master") == "master"]


def collect_syllables(project: dict[str, Any]) -> list[dict[str, Any]]:
    return (project.get("editing") or {}).get("syllables") or []


def derive_default_phonemizer(project: dict[str, Any]) -> str:
    lyrics = (project.get("editing") or {}).get("lyrics") or []
    for lyric in lyrics:
        language = (lyric or {}).get("language")
        if language == "zh":
            return "zh presamp"
        if language == "ja":
            return "ja CVVC"
    return "Default"


def velocity_to_ustx(velocity: float) -> int:
    clamped = max(0.0, min(1.0, float(velocity or 0.0)))
    return int(round(clamped * 200))


def build_lyric_for_note(note: dict[str, Any],
                         syllables_by_anchor: dict[str, list[dict[str, Any]]]) -> str:
    """Pick the first syllable starting at the same anchor as the note."""

    start_anchor = note.get("start_anchor_id")
    candidates = syllables_by_anchor.get(start_anchor) or []
    if not candidates:
        return note.get("id") or "R"
    first = candidates[0]
    override = first.get("reading_override") or ""
    if override:
        return override
    default = first.get("default_reading") or ""
    if default:
        return default
    return first.get("text") or first.get("id") or "R"


def build_notes_array(project: dict[str, Any],
                     tempo_map: dict[str, Any],
                     anchor_index: dict[str, dict[str, int]]) -> list[dict[str, Any]]:
    notes = collect_master_notes(project)
    syllables = collect_syllables(project)
    syllables_by_anchor: dict[str, list[dict[str, Any]]] = {}
    for syllable in syllables:
        anchor_id = syllable.get("start_anchor_id")
        if not anchor_id:
            continue
        syllables_by_anchor.setdefault(anchor_id, []).append(syllable)

    output: list[dict[str, Any]] = []
    for note in notes:
        start_tick = anchor_tick(anchor_index, note.get("start_anchor_id", ""))
        end_tick = anchor_tick(anchor_index, note.get("end_anchor_id", ""))
        duration = max(1, end_tick - start_tick)
        pitch = int(note.get("pitch") or 60)
        if pitch < 0:
            pitch = 0
        elif pitch > 127:
            pitch = 127
        lyric = build_lyric_for_note(note, syllables_by_anchor)
        velocity = velocity_to_ustx(note.get("velocity") or 0.8)
        output.append({
            "pos": start_tick,
            "duration": duration,
            "tone": pitch,
            "lyric": lyric,
            "velocity": velocity,
            "phoneme_override": "",
        })
    output.sort(key=lambda item: item["pos"])
    return output


def build_ustx_project(project: dict[str, Any],
                      tempo_map: dict[str, Any],
                      notes_array: list[dict[str, Any]]) -> dict[str, Any]:
    title = project.get("title") or "Miku workbench export"
    phonemizer = derive_default_phonemizer(project)
    beats_per_bar, note_value = 4, 4

    return {
        "ustx_version": USTX_VERSION,
        "name": title,
        "output": {
            "resampler": "",
            "wavtool": "",
            "sample_rate": int(tempo_map["sample_rate_hz"]),
            "channels": 1,
        },
        "tracks": [
            {
                "name": "Main vocal",
                "phonemizer": phonemizer,
                "synthesizer": "Default",
                "renderer": "CLASSIC",
            }
        ],
        "voicecolor": {
            "tracks": []
        },
        "phonemizers": [
            phonemizer
        ],
        "project": {
            "name": title,
            "voice_db_path": "",
            "resampler": "",
            "wavtool": "",
            "version": USTX_VERSION,
            "ppq": int(tempo_map["ppq"]),
            "tempo": [
                {
                    "position": int(tempo_map["first_beat_tick"]),
                    "bpm": float(tempo_map["bpm"])
                }
            ],
            "time_signature": [
                {
                    "beat_per_bar": beats_per_bar,
                    "note_per_beat": note_value,
                    "bar_position": 0
                }
            ]
        },
        "parts": [
            {
                "name": "Main part",
                "track_no": 0,
                "position": 0,
                "comment": "Exported from miku-workbench-project/0.3.0"
            }
        ],
        "notes": notes_array,
        "mix": []
    }


def export_ustx(project: dict[str, Any], output_path: Path) -> None:
    tempo_map = derive_tempo_map(project)
    anchor_index = build_anchor_index(project, tempo_map)
    notes_array = build_notes_array(project, tempo_map, anchor_index)
    ustx = build_ustx_project(project, tempo_map, notes_array)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(ustx, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def emit_loss_report() -> str:
    return "\n".join(LOSS_REPORT_LINES)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export neutral project to OpenUtau USTX 0.6.")
    parser.add_argument("project", help="Path to miku-workbench-project JSON file")
    parser.add_argument("output", help="Output .ustx file path")
    parser.add_argument("--loss-report", action="store_true",
                        help="Print field loss report to stderr and exit")
    args = parser.parse_args(argv)

    if args.loss_report:
        sys.stderr.write(emit_loss_report() + "\n")
        return 0

    project = load_project(Path(args.project))
    export_ustx(project, Path(args.output))
    sys.stdout.write(f"Wrote USTX 0.6 to {args.output}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
