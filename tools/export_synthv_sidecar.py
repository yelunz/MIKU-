#!/usr/bin/env python3
"""Synthesizer V Studio Pro 1.9.0 sidecar JSON exporter (P3).

Synthesizer V 1.9.0 has no public stable native-format writer.  The supported
adaptation path is Layer 2 (midi-plus-helper-script): export a standard MIDI
file plus a sidecar JSON carrying the metadata that MIDI cannot express
(language, syllable readings, rests, confidence, stem mix parameters).  The
companion ES5 helper script (``synthv_helper_script_es5.js``) reads the
sidecar after the user imports the MIDI into Synthesizer V.

CLI usage:
    python tools/export_synthv_sidecar.py <project.json> <output_sidecar.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


SIDECAR_SCHEMA_VERSION = "miku-synthv-sidecar/0.1.0"
SOURCE_PROJECT_SCHEMA = "miku-workbench-project/0.3.0"
DEFAULT_PPQ = 960


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


def build_notes(project: dict[str, Any], anchor_index: dict[str, dict[str, int]]) -> list[dict[str, Any]]:
    notes_out: list[dict[str, Any]] = []
    for note in (project.get("editing") or {}).get("notes") or []:
        start_tick = anchor_tick(anchor_index, note.get("start_anchor_id", ""))
        end_tick = anchor_tick(anchor_index, note.get("end_anchor_id", ""))
        if end_tick <= start_tick:
            end_tick = start_tick + 1
        notes_out.append({
            "id": note.get("id", ""),
            "stem_id": note.get("stem_id", "master"),
            "tick": start_tick,
            "duration": end_tick - start_tick,
            "tone": int(note.get("pitch") or 60),
            "velocity": float(note.get("velocity") or 0.8),
            "confidence": float(note.get("confidence") or 1.0),
            "source": note.get("source", "manual"),
            "lyric_id": "",
            "syllable_id": "",
        })
    notes_out.sort(key=lambda item: item["tick"])
    return notes_out


def build_syllables(project: dict[str, Any]) -> list[dict[str, Any]]:
    syllables_out: list[dict[str, Any]] = []
    for syllable in (project.get("editing") or {}).get("syllables") or []:
        syllables_out.append({
            "id": syllable.get("id", ""),
            "lyric_id": syllable.get("lyric_id", ""),
            "index": int(syllable.get("index") or 0),
            "text": syllable.get("text", ""),
            "default_reading": syllable.get("default_reading", ""),
            "reading_override": syllable.get("reading_override", ""),
        })
    return syllables_out


def build_rests(project: dict[str, Any], anchor_index: dict[str, dict[str, int]]) -> list[dict[str, Any]]:
    rests_out: list[dict[str, Any]] = []
    for rest in (project.get("editing") or {}).get("rests") or []:
        start_tick = anchor_tick(anchor_index, rest.get("start_anchor_id", ""))
        end_tick = anchor_tick(anchor_index, rest.get("end_anchor_id", ""))
        if end_tick <= start_tick:
            end_tick = start_tick + 1
        rests_out.append({
            "id": rest.get("id", ""),
            "tick": start_tick,
            "duration": end_tick - start_tick,
            "kind": rest.get("kind", "rest"),
        })
    return rests_out


def build_loss_report() -> dict[str, str]:
    return {
        "note_event.confidence": "Synthesizer V has no per-note confidence field; kept in sidecar only",
        "note_event.source": "Synthesizer V has no origin field; kept in sidecar only",
        "stem_tracks.trim_and_fade": "SynthV 1.9.0 has no scriptable trim/fade; mix params kept in sidecar",
        "anchor.shared_boundary": "Shared anchor degrades to same-tick note off + note on after MIDI import",
        "lyric.language": "Language is implied by phonemizer selection; not stored per-lyric in SynthV",
        "chord_overrides": "Synthesizer V has no chord layer; kept in sidecar only",
    }


def build_sidecar(project: dict[str, Any]) -> dict[str, Any]:
    tempo_map = derive_tempo_map(project)
    anchor_index = build_anchor_index(project, tempo_map)
    return {
        "schema_version": SIDECAR_SCHEMA_VERSION,
        "source_project_schema": SOURCE_PROJECT_SCHEMA,
        "tempo": {
            "bpm": float(tempo_map["bpm"]),
            "ppq": int(tempo_map["ppq"]),
            "first_beat_tick": int(tempo_map["first_beat_tick"]),
            "first_beat_sample": int(tempo_map["first_beat_sample"]),
            "sample_rate_hz": int(tempo_map["sample_rate_hz"]),
        },
        "time_signature": {
            "beat_per_bar": 4,
            "note_per_beat": 4,
        },
        "stem_tracks": list((project.get("editing") or {}).get("stem_tracks") or []),
        "notes": build_notes(project, anchor_index),
        "syllables": build_syllables(project),
        "rests": build_rests(project, anchor_index),
        "loss_report": build_loss_report(),
    }


def export_sidecar(project: dict[str, Any], output_path: Path) -> None:
    sidecar = build_sidecar(project)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(sidecar, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export neutral project to Synthesizer V sidecar JSON.")
    parser.add_argument("project", help="Path to miku-workbench-project JSON file")
    parser.add_argument("output", help="Output sidecar .json file path")
    args = parser.parse_args(argv)

    project = load_project(Path(args.project))
    export_sidecar(project, Path(args.output))
    sys.stdout.write(f"Wrote SynthV sidecar to {args.output}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
