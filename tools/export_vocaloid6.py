#!/usr/bin/env python3
"""VOCALOID6 Editor 6.13.0 (Standalone) MIDI degradation adapter (P3.5).

VOCALOID6 has no public stable scripting API and its native format (``.vpr``)
is proprietary binary, so this adapter walks the MIDI baseline degradation path
defined in ``docs/ADAPTER_CAPABILITY_MATRIX.md`` section 5.  It reuses the
byte-level MIDI generation logic from ``tools/export_midi.py`` and adds
VOCALOID6-friendly track name meta events (``FF 03``) plus a sidecar field-loss
report JSON so the user knows exactly which neutral fields are lost when
importing the MIDI into VOCALOID6 6.13.0.

Per AGENTS.md: "VOCALOID 后续适配目标已选定为 VOCALOID6 Editor 完整版 6.13.0
（Standalone）；旧版本只走明确标注损失的 MIDI 降级路径。"  This adapter only
emits the MIDI degradation path and the explicit loss report; it never reads or
writes ``.vpr`` / ``.vsqx`` proprietary binaries.

CLI usage:
    python tools/export_vocaloid6.py <project.json> <output.mid>
    python tools/export_vocaloid6.py <project.json> <output.mid> --loss-report

The sidecar loss report is always written next to the output MIDI file as
``<output>.vocaloid6-loss.json`` whenever a real export is performed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Reuse the byte-level MIDI generation logic from the baseline exporter.
# ``tools/`` has no ``__init__.py``, so the directory is added to ``sys.path``
# explicitly to make ``export_midi`` importable when this script is invoked as
# ``python tools/export_vocaloid6.py ...`` from the repository root.
_TOOLS_DIR = Path(__file__).resolve().parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

from export_midi import (  # noqa: E402  (import after sys.path mutation)
    build_anchor_index,
    build_main_track,
    build_meta_event,
    build_smf,
    build_tempo_track,
    derive_tempo_map,
    load_project,
)


SIDECAR_SCHEMA_VERSION = "miku-vocaloid6-loss-report/0.1.0"
SOURCE_PROJECT_SCHEMA = "miku-workbench-project/0.3.0"
TARGET_EDITOR = "vocaloid6-editor-6.13.0-standalone"

# VOCALOID6-friendly track names written via the FF 03 meta event.
# Track 0 (tempo/conductor) carries the project-level label; Track 1
# (notes/lyrics) carries the human-friendly vocal track label that VOCALOID6
# shows in its track list when the user picks the vocal track during import.
TRACK_NAME_TEMPO = b"VOCALOID"
TRACK_NAME_MAIN = b"Main Vocal"


def build_vocaloid6_tempo_track(tempo_map: dict[str, Any], max_tick: int) -> bytes:
    """Tempo track with a VOCALOID6 track name meta event prepended.

    The baseline tempo track already emits tempo + time signature + EOT with
    correct delta encoding; prepending a tick-0 track name event (delta 0)
    leaves every subsequent delta unchanged because deltas are relative to the
    previous event's absolute tick.
    """

    track_name_event = build_meta_event(0, 0x03, TRACK_NAME_TEMPO)
    return track_name_event + build_tempo_track(tempo_map, max_tick)


def build_vocaloid6_main_track(project: dict[str, Any],
                               tempo_map: dict[str, Any],
                               anchor_index: dict[str, dict[str, int]]
                               ) -> tuple[bytes, int]:
    """Main track with a VOCALOID6 track name meta event prepended.

    ``build_main_track`` returns delta-encoded bytes whose first event already
    carries the correct delta from tick 0; prepending a tick-0 track name event
    (delta 0) preserves every subsequent delta.
    """

    track_bytes, max_tick = build_main_track(project, tempo_map, anchor_index)
    track_name_event = build_meta_event(0, 0x03, TRACK_NAME_MAIN)
    return track_name_event + track_bytes, max_tick


def build_loss_report() -> dict[str, Any]:
    """Static field-loss report mirroring ``docs/ADAPTER_CAPABILITY_MATRIX.md`` §5.

    The structure is intentionally explicit: every lost field is listed with a
    human-readable reason so the sidecar JSON doubles as a machine-readable and
    user-readable loss contract, satisfying AGENTS.md's requirement that "旧版
    本只走明确标注损失的 MIDI 降级路径".
    """

    return {
        "schema_version": SIDECAR_SCHEMA_VERSION,
        "source_project_schema": SOURCE_PROJECT_SCHEMA,
        "target_editor": TARGET_EDITOR,
        "export_path": "MIDI baseline degradation",
        "encoding": (
            "UTF-8 (VOCALOID6 V6.2+ supports UTF-8 lyrics; user must select "
            "UTF-8 in Import dialog)"
        ),
        "track_naming": (
            "Track 0: VOCALOID, Track 1: Main Vocal (via FF 03 meta event)"
        ),
        "lost_fields": [
            {
                "field": "syllable.default_reading",
                "reason": (
                    "VOCALOID6 uses its own phoneme system; only lyric text is "
                    "preserved via MIDI lyric meta event"
                ),
            },
            {
                "field": "syllable.reading_override",
                "reason": "same as above",
            },
            {
                "field": "note.confidence",
                "reason": "MIDI baseline does not carry confidence",
            },
            {
                "field": "note.source",
                "reason": (
                    "MIDI baseline does not distinguish "
                    "manual/transcription/generation"
                ),
            },
            {
                "field": "note.stem_id",
                "reason": (
                    "VOCALOID6 imports single vocal track; multi-stem info lost"
                ),
            },
            {
                "field": "rests",
                "reason": (
                    "VOCALOID6 expresses rests as gaps between notes, no "
                    "explicit rest event"
                ),
            },
            {
                "field": "lyrics (LyricRegion container)",
                "reason": (
                    "Only syllable-level lyrics are written to MIDI; "
                    "LyricRegion grouping lost"
                ),
            },
            {
                "field": "source_audio",
                "reason": "MIDI does not carry audio references",
            },
            {
                "field": "tempo_map.first_beat_seconds",
                "reason": "VOCALOID6 assumes first tempo at position 0",
            },
            {
                "field": "stem_tracks non-destructive params",
                "reason": "VOCALOID6 does not support stem mixer",
            },
        ],
        "preserved_fields": [
            "note.pitch (as MIDI tone)",
            "note.velocity (as MIDI note on velocity 0-127)",
            "note timing (via anchors tick)",
            "syllable.text (as MIDI lyric meta event FF 05)",
            "tempo_map.bpm (as tempo meta event FF 51)",
            "time signature (as FF 58)",
        ],
        "user_workflow": [
            "1. Open VOCALOID6 Editor 6.13.0 Standalone",
            "2. File > Import > MIDI",
            "3. Select the exported .mid file",
            "4. In encoding dialog, choose UTF-8",
            "5. Confirm track name 'Main Vocal' is selected as vocal track",
            "6. Visually verify notes and lyrics in piano roll",
            "7. Manually adjust phonemes for each note using VOCALOID6 phoneme panel",
        ],
    }


def emit_loss_report() -> str:
    """Human-readable loss report for the ``--loss-report`` stderr option."""

    report = build_loss_report()
    lines = [
        "VOCALOID6 6.13.0 MIDI degradation loss report",
        f"target_editor: {report['target_editor']}",
        f"export_path: {report['export_path']}",
        f"encoding: {report['encoding']}",
        f"track_naming: {report['track_naming']}",
        "",
        "Lost fields:",
    ]
    for item in report["lost_fields"]:
        lines.append(f"  - {item['field']}: {item['reason']}")
    lines.append("")
    lines.append("Preserved fields:")
    for field in report["preserved_fields"]:
        lines.append(f"  + {field}")
    lines.append("")
    lines.append("User workflow:")
    for step in report["user_workflow"]:
        lines.append(f"  {step}")
    return "\n".join(lines)


def sidecar_path_for(output_path: Path) -> Path:
    """Return ``<output>.vocaloid6-loss.json`` next to the MIDI file.

    The sidecar is appended to the full output filename (including its
    extension) so that ``out.mid`` produces ``out.mid.vocaloid6-loss.json``;
    this keeps the sidecar visually associated with its MIDI file even when
    multiple adapters export to the same base name.
    """

    return output_path.parent / (output_path.name + ".vocaloid6-loss.json")


def export_vocaloid6(project: dict[str, Any], output_path: Path) -> Path:
    """Write the VOCALOID6-friendly MIDI file and the sidecar loss report.

    Returns the path of the sidecar loss report JSON that was written.
    """

    tempo_map = derive_tempo_map(project)
    anchor_index = build_anchor_index(project, tempo_map)
    main_track, max_tick = build_vocaloid6_main_track(project, tempo_map, anchor_index)
    tempo_track = build_vocaloid6_tempo_track(tempo_map, max_tick)
    smf = build_smf(tempo_map, tempo_track, main_track)
    output_path.write_bytes(smf)

    sidecar = build_loss_report()
    sidecar_file = sidecar_path_for(output_path)
    with sidecar_file.open("w", encoding="utf-8") as handle:
        json.dump(sidecar, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return sidecar_file


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Export neutral project to a VOCALOID6-friendly MIDI file "
            "(degradation path) with a sidecar loss report."
        )
    )
    parser.add_argument("project", help="Path to miku-workbench-project JSON file")
    parser.add_argument("output", help="Output .mid file path")
    parser.add_argument(
        "--loss-report",
        action="store_true",
        help="Print field loss report to stderr and exit",
    )
    args = parser.parse_args(argv)

    if args.loss_report:
        sys.stderr.write(emit_loss_report() + "\n")
        return 0

    project = load_project(Path(args.project))
    sidecar_file = export_vocaloid6(project, Path(args.output))
    sys.stdout.write(
        f"Wrote VOCALOID6 MIDI to {args.output}\n"
        f"Wrote loss report to {sidecar_file}\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
