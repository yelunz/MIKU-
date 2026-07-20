#!/usr/bin/env python3
"""OpenUtau USTX 0.7 exporter (P3).

Reads a neutral miku-workbench-project JSON file and writes a USTX 0.7
engineering file in YAML text form.  USTX 0.7 is OpenUtau 0.1.565's native
project format (UTF-8 YAML text with ``.ustx`` extension).  This exporter
produces a single voice part holding the master notes plus per-syllable
lyrics.

The YAML serializer is hand-written and covers only the USTX schema subset
(dict / list / str / int / float / bool / null plus inline flow mappings for
``pitch.data`` points and the ``vibrato`` block).  No third-party YAML
dependency is required.

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


USTX_VERSION = "0.7"
USTX_RESOLUTION = 480
DEFAULT_PROJECT_PPQ = 960
LOSS_REPORT_LINES = (
    "USTX 0.7 loss report",
    "- velocity lost: USTX 0.7 notes have no velocity field; per-note dynamics use expressions",
    "- confidence lost: USTX has no per-note confidence field",
    "- source (manual/transcription/generation) lost: USTX has no origin field",
    "- stem_id lost: export flattens all stems into a single voice part (track_no 0)",
    "- rests lost: USTX expresses rests implicitly as gaps between notes",
    "- source_audio hash and file name lost: USTX references audio by file path only",
    "- LyricRegion container lost: only per-note lyric from syllable reading is carried",
    "- chord_overrides and analysis layers lost: USTX does not carry harmonic analysis",
    "- anchor shared boundary degrades: shared edge becomes consecutive note positions",
    "- project key signature label not mapped to USTX key integer (defaults to 0)",
)


# ---------------------------------------------------------------------------
# Minimal YAML serializer (covers only the USTX 0.7 schema subset).
# ---------------------------------------------------------------------------


class _FlowDict(dict):
    """Dict rendered as an inline YAML flow mapping (``{k: v, ...}``).

    Used for ``pitch.data`` point entries and the ``vibrato`` block so the
    output matches OpenUtau's real USTX layout exactly.
    """


_YAML_RESERVED = {"true", "false", "yes", "no", "null", "~", "on", "off", "none"}


def _emit_float(value: float) -> str:
    if value != value:  # NaN
        return ".nan"
    if value == float("inf"):
        return ".inf"
    if value == float("-inf"):
        return "-.inf"
    return repr(value)


def _needs_quotes(text: str) -> bool:
    if text == "":
        return True
    if text.lower() in _YAML_RESERVED:
        return True
    # Strings that look like numbers (e.g. "0.7") must be quoted so YAML keeps
    # them as strings.
    try:
        float(text)
        return True
    except ValueError:
        pass
    first = text[0]
    if first in "!&*?|>%@`\"'#,[]{}":
        return True
    if first == " " or text[-1] == " ":
        return True
    if first == "-" and len(text) > 1 and text[1] == " ":
        return True
    if ": " in text or text.endswith(":"):
        return True
    if " #" in text:
        return True
    for ch in "{}[]`\"'":
        if ch in text:
            return True
    return False


def _quote_string(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("\"", "\\\"")
    return f'"{escaped}"'


def _emit_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _emit_float(value)
    text = str(value)
    if _needs_quotes(text):
        return _quote_string(text)
    return text


def _emit_flow_mapping(d: dict) -> str:
    parts = [f"{k}: {_emit_scalar(v)}" for k, v in d.items()]
    return "{" + ", ".join(parts) + "}"


def _emit_pair(key: str, value: Any, indent: str, lines: list[str]) -> None:
    if isinstance(value, _FlowDict) and value:
        lines.append(f"{indent}{key}: {_emit_flow_mapping(value)}")
    elif isinstance(value, dict) and not value:
        lines.append(f"{indent}{key}: {{}}")
    elif isinstance(value, list) and not value:
        lines.append(f"{indent}{key}: []")
    elif isinstance(value, dict):
        lines.append(f"{indent}{key}:")
        _emit_mapping(value, indent + "  ", lines)
    elif isinstance(value, list):
        lines.append(f"{indent}{key}:")
        _emit_sequence(value, indent, lines)
    else:
        lines.append(f"{indent}{key}: {_emit_scalar(value)}")


def _emit_mapping(d: dict, indent: str, lines: list[str]) -> None:
    for key, value in d.items():
        _emit_pair(key, value, indent, lines)


def _emit_sequence(items: list, indent: str, lines: list[str]) -> None:
    for item in items:
        _emit_sequence_item(item, indent, lines)


def _emit_sequence_item(item: Any, indent: str, lines: list[str]) -> None:
    if isinstance(item, _FlowDict) and item:
        lines.append(f"{indent}- {_emit_flow_mapping(item)}")
    elif isinstance(item, dict) and not item:
        lines.append(f"{indent}- {{}}")
    elif isinstance(item, list) and not item:
        lines.append(f"{indent}- []")
    elif isinstance(item, dict):
        pairs = list(item.items())
        first_key, first_value = pairs[0]
        _emit_sequence_item_first_pair(first_key, first_value, pairs[1:], indent, lines)
    else:
        lines.append(f"{indent}- {_emit_scalar(item)}")


def _emit_sequence_item_first_pair(first_key: str, first_value: Any,
                                   rest: list[tuple[str, Any]],
                                   indent: str, lines: list[str]) -> None:
    prefix = f"{indent}- "
    if isinstance(first_value, _FlowDict) and first_value:
        lines.append(f"{prefix}{first_key}: {_emit_flow_mapping(first_value)}")
    elif isinstance(first_value, dict) and not first_value:
        lines.append(f"{prefix}{first_key}: {{}}")
    elif isinstance(first_value, list) and not first_value:
        lines.append(f"{prefix}{first_key}: []")
    elif isinstance(first_value, dict):
        lines.append(f"{prefix}{first_key}:")
        _emit_mapping(first_value, indent + "    ", lines)
    elif isinstance(first_value, list):
        lines.append(f"{prefix}{first_key}:")
        _emit_sequence(first_value, indent + "  ", lines)
    else:
        lines.append(f"{prefix}{first_key}: {_emit_scalar(first_value)}")
    rest_indent = indent + "  "
    for key, value in rest:
        _emit_pair(key, value, rest_indent, lines)


def dump_yaml(data: dict) -> str:
    """Serialize ``data`` to a YAML text string using the USTX schema subset."""

    lines: list[str] = []
    _emit_mapping(data, "", lines)
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Neutral project helpers (reused from the previous JSON exporter).
# ---------------------------------------------------------------------------


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
    ppq = DEFAULT_PROJECT_PPQ
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


def project_tick_to_ustx(tick: int, project_ppq: int) -> int:
    """Convert a project-internal tick (ppq 960) to a USTX tick (resolution 480)."""

    if project_ppq <= 0:
        project_ppq = DEFAULT_PROJECT_PPQ
    return int(round(tick * USTX_RESOLUTION / project_ppq))


# ---------------------------------------------------------------------------
# USTX 0.7 structure builders.
# ---------------------------------------------------------------------------


def build_pitch_block() -> dict[str, Any]:
    return {
        "data": [
            _FlowDict([("x", -40), ("y", 0), ("shape", "io")]),
            _FlowDict([("x", 40), ("y", 0), ("shape", "io")]),
        ],
        "snap_first": True,
    }


def build_vibrato_block() -> _FlowDict:
    return _FlowDict([
        ("length", 0),
        ("period", 175),
        ("depth", 25),
        ("in", 10),
        ("out", 10),
        ("shift", 0),
        ("drift", 0),
        ("vol_link", 0),
    ])


def build_note(note: dict[str, Any],
               syllables_by_anchor: dict[str, list[dict[str, Any]]],
               anchor_index: dict[str, dict[str, int]],
               project_ppq: int) -> dict[str, Any]:
    start_tick = anchor_tick(anchor_index, note.get("start_anchor_id", ""))
    end_tick = anchor_tick(anchor_index, note.get("end_anchor_id", ""))
    start_ustx = project_tick_to_ustx(start_tick, project_ppq)
    end_ustx = project_tick_to_ustx(end_tick, project_ppq)
    duration = max(1, end_ustx - start_ustx)
    tone = int(note.get("pitch") or 60)
    if tone < 0:
        tone = 0
    elif tone > 127:
        tone = 127
    lyric = build_lyric_for_note(note, syllables_by_anchor)
    return {
        "position": start_ustx,
        "duration": duration,
        "tone": tone,
        "lyric": lyric,
        "pitch": build_pitch_block(),
        "vibrato": build_vibrato_block(),
        "phoneme_expressions": [],
        "phoneme_overrides": [],
    }


def build_notes_array(project: dict[str, Any],
                      anchor_index: dict[str, dict[str, int]],
                      project_ppq: int) -> list[dict[str, Any]]:
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
        output.append(build_note(note, syllables_by_anchor, anchor_index, project_ppq))
    output.sort(key=lambda item: item["position"])
    return output


def build_track(track_name: str) -> dict[str, Any]:
    return {
        "phonemizer": "OpenUtau.Core.DefaultPhonemizer",
        "renderer_settings": {},
        "track_name": track_name,
        "track_color": "Blue",
        "mute": False,
        "solo": False,
        "volume": 0,
        "pan": 0,
        "track_expressions": [],
        "voice_color_names": [""],
    }


def build_voice_part(notes: list[dict[str, Any]]) -> dict[str, Any]:
    if notes:
        max_end = max(note["position"] + note["duration"] for note in notes)
        duration = max(USTX_RESOLUTION, max_end)
    else:
        duration = USTX_RESOLUTION
    return {
        "duration": duration,
        "name": "New Part",
        "comment": "",
        "track_no": 0,
        "position": 0,
        "notes": notes,
        "curves": [],
    }


def build_ustx_project(project: dict[str, Any],
                       tempo_map: dict[str, Any],
                       notes_array: list[dict[str, Any]]) -> dict[str, Any]:
    title = project.get("title") or "Miku workbench export"
    bpm = float(tempo_map["bpm"])
    return {
        "name": title,
        "comment": "",
        "output_dir": "Vocal",
        "cache_dir": "UCache",
        "ustx_version": USTX_VERSION,
        "resolution": USTX_RESOLUTION,
        "bpm": bpm,
        "beat_per_bar": 4,
        "beat_unit": 4,
        "expressions": {},
        "exp_selectors": [],
        "exp_primary": -1,
        "exp_secondary": -1,
        "key": 0,
        "time_signatures": [
            {"bar_position": 0, "beat_per_bar": 4, "beat_unit": 4},
        ],
        "tempos": [
            {"position": 0, "bpm": bpm},
        ],
        "tracks": [build_track("Main vocal")],
        "voice_parts": [build_voice_part(notes_array)],
        "wave_parts": [],
    }


def export_ustx(project: dict[str, Any], output_path: Path) -> None:
    tempo_map = derive_tempo_map(project)
    anchor_index = build_anchor_index(project, tempo_map)
    project_ppq = int(tempo_map.get("ppq") or DEFAULT_PROJECT_PPQ)
    notes_array = build_notes_array(project, anchor_index, project_ppq)
    ustx = build_ustx_project(project, tempo_map, notes_array)
    text = dump_yaml(ustx)
    with output_path.open("w", encoding="utf-8") as handle:
        handle.write(text)


def emit_loss_report() -> str:
    return "\n".join(LOSS_REPORT_LINES)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export neutral project to OpenUtau USTX 0.7.")
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
    sys.stdout.write(f"Wrote USTX 0.7 to {args.output}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
