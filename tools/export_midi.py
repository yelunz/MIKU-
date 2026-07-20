#!/usr/bin/env python3
"""MIDI baseline exporter (P3).

Reads a neutral miku-workbench-project JSON file and writes a Type-1 Standard
MIDI File (SMF) using only the Python standard library.  The output is the
lowest-fidelity exchange format: notes, tempo, time signature and lyric meta
events.  All other neutral fields (stem mix, anchors, confidence, source,
language, syllable readings) are reported as losses via ``--loss-report``.

CLI usage:
    python tools/export_midi.py <project.json> <output.mid>
    python tools/export_midi.py <project.json> <output.mid> --loss-report
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path
from typing import Any


DEFAULT_PPQ = 960
LOSS_REPORT_LINES = (
    "MIDI baseline loss report",
    "- language (zh/ja) lost: MIDI lyric meta event has no language field",
    "- confidence lost: MIDI does not store per-note confidence",
    "- source (manual/transcription/generation) lost: MIDI does not encode origin",
    "- syllable.default_reading and reading_override lost: only syllable.text is written",
    "- stem_tracks non-destructive mix parameters lost: MIDI only carries note events",
    "- rests are implicit: expressed as gaps between notes, no explicit rest event",
    "- anchor shared boundary degrades: shared edge becomes same-tick Note Off + Note On",
    "- chord_overrides and analysis layers lost: MIDI does not carry harmonic analysis",
    "- source_audio hash and file name lost: MIDI has no audio reference",
    "- preferences lost: snap/swing/preview mode are editor-local only",
)


def load_project(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def derive_tempo_map(project: dict[str, Any]) -> dict[str, Any]:
    """Return a normalized tempo map dict, falling back to analysis layer."""

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
    """Return mapping anchor_id -> {sample, tick}; tick derived when missing."""

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


def anchor_tick(anchor_index: dict[str, dict[str, int]], anchor_id: str,
                tempo_map: dict[str, Any]) -> int:
    anchor = anchor_index.get(anchor_id)
    if anchor is not None:
        return anchor["tick"]
    # Fallback: derive from a numeric sample encoded in the anchor_id; otherwise 0.
    return 0


def encode_variable_length(value: int) -> bytes:
    if value < 0:
        value = 0
    if value == 0:
        return b"\x00"
    output = []
    output.append(value & 0x7F)
    value >>= 7
    while value:
        output.append((value & 0x7F) | 0x80)
        value >>= 7
    output.reverse()
    return bytes(output)


def build_midi_event(delta: int, status: int, data: bytes) -> bytes:
    return encode_variable_length(delta) + bytes([status]) + data


def build_meta_event(delta: int, meta_type: int, payload: bytes) -> bytes:
    return (encode_variable_length(delta)
            + b"\xFF"
            + bytes([meta_type])
            + encode_variable_length(len(payload))
            + payload)


def bpm_to_microseconds_per_quarter(bpm: float) -> int:
    if bpm <= 0:
        return 500000
    return int(round(60000000.0 / bpm))


def derive_time_signature(project: dict[str, Any]) -> tuple[int, int]:
    """Default 4/4; future expansions may pull this from analysis."""

    return 4, 4


def collect_master_notes(project: dict[str, Any]) -> list[dict[str, Any]]:
    notes = (project.get("editing") or {}).get("notes") or []
    return [note for note in notes if (note.get("stem_id") or "master") == "master"]


def collect_syllables(project: dict[str, Any]) -> list[dict[str, Any]]:
    return (project.get("editing") or {}).get("syllables") or []


def build_tempo_track(tempo_map: dict[str, Any], max_tick: int) -> bytes:
    ppq = int(tempo_map["ppq"])
    events: list[bytes] = []

    # Tempo meta event at tick 0.
    microseconds = bpm_to_microseconds_per_quarter(float(tempo_map["bpm"]))
    tempo_payload = struct.pack(">I", microseconds)[1:]  # 24-bit big-endian
    events.append(build_meta_event(0, 0x51, tempo_payload))

    # Time signature meta event at tick 0.
    beats_per_bar, note_value = derive_time_signature(None)
    cc = 24
    bb = 8
    time_sig_payload = bytes([beats_per_bar, note_value_to_power(note_value), cc, bb])
    events.append(build_meta_event(0, 0x58, time_sig_payload))

    # End of track at the latest tick we know about (or 0 if no notes).
    events.append(build_meta_event(max_tick, 0x2F, b""))

    return b"".join(events)


def note_value_to_power(note_value: int) -> int:
    """MIDI stores denominator as log2 (4 -> 2, 8 -> 3)."""

    power = 0
    value = note_value
    while value > 1:
        value >>= 1
        power += 1
    return power


def build_main_track(project: dict[str, Any],
                     tempo_map: dict[str, Any],
                     anchor_index: dict[str, dict[str, int]]) -> tuple[bytes, int]:
    """Return (track_bytes, max_tick)."""

    notes = collect_master_notes(project)
    syllables = collect_syllables(project)

    # Map syllable -> anchor ticks for lyric events.
    syllable_events: list[tuple[int, str]] = []
    for syllable in syllables:
        anchor_id = syllable.get("start_anchor_id")
        if not anchor_id:
            continue
        tick = anchor_tick(anchor_index, anchor_id, tempo_map)
        text = syllable.get("text") or ""
        if not text:
            continue
        syllable_events.append((tick, text))
    syllable_events.sort(key=lambda item: item[0])

    # Build note on/off events.
    note_events: list[tuple[int, int, int]] = []  # (tick, pitch, velocity)
    for note in notes:
        start_tick = anchor_tick(anchor_index, note.get("start_anchor_id", ""),
                                 tempo_map)
        end_tick = anchor_tick(anchor_index, note.get("end_anchor_id", ""),
                               tempo_map)
        if end_tick <= start_tick:
            end_tick = start_tick + 1
        pitch = int(note.get("pitch") or 60)
        if pitch < 0:
            pitch = 0
        elif pitch > 127:
            pitch = 127
        velocity_float = float(note.get("velocity") or 0.0)
        velocity = int(round(max(0.0, min(1.0, velocity_float)) * 127))
        if velocity < 1:
            velocity = 1  # MIDI Note On with velocity 0 is interpreted as Note Off by some hosts.
        note_events.append((start_tick, pitch, velocity))
        note_events.append((end_tick, pitch, 0))  # Note Off uses velocity 0 for clarity.

    # Merge events by absolute tick.
    event_queue: list[tuple[int, int, bytes]] = []
    # 0 = note off, 1 = note on, 2 = lyric meta event
    for tick, pitch, velocity in note_events:
        if velocity == 0:
            status = 0x80
            data = bytes([pitch, 0])
        else:
            status = 0x90
            data = bytes([pitch, velocity])
        event_queue.append((tick, 0 if status == 0x80 else 1, build_midi_event(0, status, data)))
    for tick, text in syllable_events:
        payload = text.encode("utf-8")
        event_queue.append((tick, 2, build_meta_event(0, 0x05, payload)))

    # Sort: note off first, then note on, then lyric to keep ordering stable.
    event_queue.sort(key=lambda item: (item[0], item[1]))

    output: list[bytes] = []
    previous_tick = 0
    max_tick = 0
    for tick, _, event_bytes in event_queue:
        delta = max(0, tick - previous_tick)
        # Rewrite the delta portion of the prebuilt event_bytes.
        body = event_bytes[len(encode_variable_length(0)):]
        output.append(encode_variable_length(delta) + body)
        previous_tick = tick
        if tick > max_tick:
            max_tick = tick

    # End-of-track meta event.
    output.append(build_meta_event(0, 0x2F, b""))

    return b"".join(output), max_tick


def pack_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return chunk_type + struct.pack(">I", len(data)) + data


def build_smf(tempo_map: dict[str, Any], tempo_track: bytes, main_track: bytes) -> bytes:
    ppq = int(tempo_map["ppq"])
    header = pack_chunk(b"MThd", struct.pack(">HHH", 1, 2, ppq))
    return header + pack_chunk(b"MTrk", tempo_track) + pack_chunk(b"MTrk", main_track)


def export_midi(project: dict[str, Any], output_path: Path) -> None:
    tempo_map = derive_tempo_map(project)
    anchor_index = build_anchor_index(project, tempo_map)
    main_track, max_tick = build_main_track(project, tempo_map, anchor_index)
    tempo_track = build_tempo_track(tempo_map, max_tick)
    smf = build_smf(tempo_map, tempo_track, main_track)
    output_path.write_bytes(smf)


def emit_loss_report() -> str:
    return "\n".join(LOSS_REPORT_LINES)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export neutral project to a Type-1 MIDI baseline.")
    parser.add_argument("project", help="Path to miku-workbench-project JSON file")
    parser.add_argument("output", help="Output .mid file path")
    parser.add_argument("--loss-report", action="store_true",
                        help="Print field loss report to stderr and exit")
    args = parser.parse_args(argv)

    if args.loss_report:
        sys.stderr.write(emit_loss_report() + "\n")
        return 0

    project = load_project(Path(args.project))
    export_midi(project, Path(args.output))
    sys.stdout.write(f"Wrote MIDI baseline to {args.output}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
