#!/usr/bin/env python3
"""A/B comparison: standard-library baseline vs librosa backend on the same fixture.

Usage:
    python -m tools.miku_analysis.compare_a_b <baseline.json> <librosa.json> <ground-truth.json>

Prints a human-readable comparison table to stderr and emits a JSON summary to
stdout.  The chord accuracy metric ("严格 Top-1 中点加权准确率") matches the
baseline's evaluation:

* for each analyzer chord window, take the top-1 candidate label
* look up the ground-truth chord event whose [start, end) interval contains the
  window midpoint
* strict string equality between the analyzer label and the ground-truth symbol
  (inversions like "G/B" must match exactly)
* weight each window by its duration; accuracy = sum(weight * match) / sum(weight)

Windows whose midpoint falls outside every ground-truth chord event (e.g. leading
silence, release tail) are skipped from both numerator and denominator.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import math
import sys
from pathlib import Path


EPSILON = 1e-9
SECTION_TOLERANCE_SECONDS = 0.5  # mirrors ground-truth acceptance tolerance


@dataclass
class MetricRow:
    name: str
    baseline: object
    librosa: object
    ground_truth: object
    baseline_close: bool
    librosa_close: bool
    winner: str  # "baseline" | "librosa" | "tie" | "neither"


def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _top_tempo(analysis: dict) -> dict | None:
    candidates = analysis.get("analysis", {}).get("tempo", {}).get("candidates", [])
    return candidates[0] if candidates else None


def _top_key(analysis: dict) -> dict | None:
    candidates = analysis.get("analysis", {}).get("key", {}).get("candidates", [])
    return candidates[0] if candidates else None


def _chord_windows(analysis: dict) -> list[dict]:
    return analysis.get("analysis", {}).get("chords", {}).get("windows", [])


def _section_boundaries(analysis: dict) -> list[dict]:
    return analysis.get("analysis", {}).get("sections", {}).get("boundaries", [])


def _expected_section_boundaries(ground_truth: dict) -> list[float]:
    return list(ground_truth.get("acceptance", {}).get("expected_section_boundaries_seconds", []))


def _gt_chord_events(ground_truth: dict) -> list[dict]:
    return list(ground_truth.get("chord_events", []))


def _find_gt_chord_at(chord_events: list[dict], seconds: float) -> dict | None:
    for event in chord_events:
        start = float(event["start_seconds"])
        end = float(event["end_seconds"])
        if start - EPSILON <= seconds < end - EPSILON:
            return event
    return None


def chord_strict_top1_midpoint_weighted_accuracy(analysis: dict, ground_truth: dict) -> tuple[float, int, int]:
    """Return (accuracy, matched_windows, evaluated_windows).

    Windows whose midpoint misses every ground-truth chord event are skipped.
    """
    windows = _chord_windows(analysis)
    chord_events = _gt_chord_events(ground_truth)
    if not windows or not chord_events:
        return 0.0, 0, 0
    total_weight = 0.0
    match_weight = 0.0
    matched = 0
    evaluated = 0
    for window in windows:
        start = float(window.get("start_seconds", 0.0))
        end = float(window.get("end_seconds", start))
        candidates = window.get("candidates", [])
        if not candidates:
            continue
        midpoint = (start + end) / 2.0
        gt = _find_gt_chord_at(chord_events, midpoint)
        if gt is None:
            continue
        weight = max(end - start, EPSILON)
        total_weight += weight
        evaluated += 1
        top_label = candidates[0].get("label", "")
        if top_label == gt.get("symbol", ""):
            match_weight += weight
            matched += 1
    if total_weight <= EPSILON:
        return 0.0, 0, 0
    accuracy = match_weight / total_weight
    return accuracy, matched, evaluated


def _section_extra_boundaries(
    boundaries: list[dict], expected: list[float], tolerance: float
) -> tuple[list[float], list[float], list[float]]:
    """Return (detected_matched, missed_expected, extra_detected)."""
    detected = [float(b["time_seconds"]) for b in boundaries]
    matched: list[float] = []
    extra: list[float] = []
    for det in detected:
        if any(abs(det - exp) <= tolerance for exp in expected):
            matched.append(det)
        else:
            extra.append(det)
    missed = [exp for exp in expected if not any(abs(exp - det) <= tolerance for det in detected)]
    return matched, missed, extra


def _format_value(value: object) -> str:
    if isinstance(value, float):
        if abs(value) < 1e-3 or abs(value) >= 1e6:
            return f"{value:.4g}"
        return f"{value:.3f}"
    return str(value)


def _close(value: object, target: object, tolerance: float) -> bool:
    try:
        return abs(float(value) - float(target)) <= tolerance
    except (TypeError, ValueError):
        return False


def build_metric_rows(baseline: dict, librosa: dict, ground_truth: dict) -> list[MetricRow]:
    rows: list[MetricRow] = []

    b_tempo = _top_tempo(baseline) or {}
    l_tempo = _top_tempo(librosa) or {}
    gt_bpm = float(ground_truth["timeline"]["bpm"])
    gt_first_beat = float(ground_truth["timeline"]["first_downbeat_seconds"])
    rows.append(_row("tempo_bpm", b_tempo.get("bpm"), l_tempo.get("bpm"), gt_bpm, 0.5))
    rows.append(_row("first_beat_seconds", b_tempo.get("first_beat_seconds"), l_tempo.get("first_beat_seconds"), gt_first_beat, 0.05))

    b_key = _top_key(baseline) or {}
    l_key = _top_key(librosa) or {}
    gt_key_label = ground_truth["key_regions"][0]["label"]
    rows.append(_row("key_top_candidate", b_key.get("label"), l_key.get("label"), gt_key_label, 0.0))

    b_acc, b_matched, b_eval = chord_strict_top1_midpoint_weighted_accuracy(baseline, ground_truth)
    l_acc, l_matched, l_eval = chord_strict_top1_midpoint_weighted_accuracy(librosa, ground_truth)
    gt_threshold = float(ground_truth["acceptance"]["basic_chord_time_weighted_accuracy"])
    rows.append(MetricRow(
        name="chord_strict_top1_midpoint_weighted_accuracy",
        baseline=round(b_acc, 6),
        librosa=round(l_acc, 6),
        ground_truth=f">= {gt_threshold}",
        baseline_close=b_acc >= gt_threshold,
        librosa_close=l_acc >= gt_threshold,
        winner=_winner_higher(b_acc, l_acc, gt_threshold),
    ))
    rows.append(MetricRow(
        name="chord_evaluated_windows",
        baseline=f"{b_matched}/{b_eval}",
        librosa=f"{l_matched}/{l_eval}",
        ground_truth="n/a",
        baseline_close=False,
        librosa_close=False,
        winner="n/a",
    ))

    expected = _expected_section_boundaries(ground_truth)
    b_matched_s, b_missed, b_extra = _section_extra_boundaries(_section_boundaries(baseline), expected, SECTION_TOLERANCE_SECONDS)
    l_matched_s, l_missed, l_extra = _section_extra_boundaries(_section_boundaries(librosa), expected, SECTION_TOLERANCE_SECONDS)
    rows.append(MetricRow(
        name="section_boundaries_detected",
        baseline=f"{len(b_matched_s)}/{len(expected)}",
        librosa=f"{len(l_matched_s)}/{len(expected)}",
        ground_truth=f"{len(expected)} expected",
        baseline_close=len(b_missed) == 0,
        librosa_close=len(l_missed) == 0,
        winner=_winner_section(len(b_missed), len(b_extra), len(l_missed), len(l_extra)),
    ))
    rows.append(MetricRow(
        name="section_extra_boundaries",
        baseline=len(b_extra),
        librosa=len(l_extra),
        ground_truth=0,
        baseline_close=len(b_extra) == 0,
        librosa_close=len(l_extra) == 0,
        winner=_winner_lower(len(b_extra), len(l_extra)),
    ))
    return rows


def _row(name: str, baseline: object, librosa: object, ground_truth: object, tolerance: float) -> MetricRow:
    b_close = _close(baseline, ground_truth, tolerance)
    l_close = _close(librosa, ground_truth, tolerance)
    if tolerance == 0.0:
        # Exact match metric (e.g. key label).
        b_close = baseline == ground_truth
        l_close = librosa == ground_truth
    if b_close and not l_close:
        winner = "baseline"
    elif l_close and not b_close:
        winner = "librosa"
    elif b_close and l_close:
        winner = "tie"
    else:
        winner = "neither"
    return MetricRow(name=name, baseline=baseline, librosa=librosa, ground_truth=ground_truth, baseline_close=b_close, librosa_close=l_close, winner=winner)


def _winner_higher(b_value: float, l_value: float, threshold: float) -> str:
    b_passes = b_value >= threshold
    l_passes = l_value >= threshold
    if b_passes and not l_passes:
        return "baseline"
    if l_passes and not b_passes:
        return "librosa"
    if b_passes and l_passes:
        return "tie (both pass)"
    return "neither"


def _winner_lower(b_value: int, l_value: int) -> str:
    if b_value < l_value:
        return "baseline"
    if l_value < b_value:
        return "librosa"
    return "tie"


def _winner_section(b_missed: int, b_extra: int, l_missed: int, l_extra: int) -> str:
    b_score = b_missed * 2 + b_extra
    l_score = l_missed * 2 + l_extra
    if b_score < l_score:
        return "baseline"
    if l_score < b_score:
        return "librosa"
    return "tie"


def _print_table(rows: list[MetricRow], stream) -> None:
    headers = ("metric", "baseline", "librosa", "ground_truth", "winner")
    widths = [max(len(headers[i]), max(len(_format_value(getattr(r, h))) for r in rows)) for i, h in enumerate(["name", "baseline", "librosa", "ground_truth", "winner"])]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    print(fmt.format(*headers), file=stream)
    print(fmt.format(*["-" * w for w in widths]), file=stream)
    for row in rows:
        print(fmt.format(
            row.name,
            _format_value(row.baseline),
            _format_value(row.librosa),
            _format_value(row.ground_truth),
            row.winner,
        ), file=stream)


def build_summary(baseline: dict, librosa: dict, ground_truth: dict) -> dict:
    rows = build_metric_rows(baseline, librosa, ground_truth)
    b_acc, b_matched, b_eval = chord_strict_top1_midpoint_weighted_accuracy(baseline, ground_truth)
    l_acc, l_matched, l_eval = chord_strict_top1_midpoint_weighted_accuracy(librosa, ground_truth)
    expected = _expected_section_boundaries(ground_truth)
    b_matched_s, b_missed, b_extra = _section_extra_boundaries(_section_boundaries(baseline), expected, SECTION_TOLERANCE_SECONDS)
    l_matched_s, l_missed, l_extra = _section_extra_boundaries(_section_boundaries(librosa), expected, SECTION_TOLERANCE_SECONDS)
    threshold = float(ground_truth["acceptance"]["basic_chord_time_weighted_accuracy"])
    return {
        "schema_version": "miku-ab-compare/0.1.0",
        "baseline_analyzer": baseline.get("analyzer", {}).get("name"),
        "librosa_analyzer": librosa.get("analyzer", {}).get("name"),
        "metrics": [
            {
                "name": row.name,
                "baseline": row.baseline,
                "librosa": row.librosa,
                "ground_truth": row.ground_truth,
                "winner": row.winner,
            }
            for row in rows
        ],
        "chord_accuracy": {
            "threshold": threshold,
            "baseline": {
                "accuracy": round(b_acc, 6),
                "matched_windows": b_matched,
                "evaluated_windows": b_eval,
                "passes": b_acc >= threshold,
            },
            "librosa": {
                "accuracy": round(l_acc, 6),
                "matched_windows": l_matched,
                "evaluated_windows": l_eval,
                "passes": l_acc >= threshold,
            },
        },
        "section_boundaries": {
            "expected": expected,
            "tolerance_seconds": SECTION_TOLERANCE_SECONDS,
            "baseline": {
                "detected": [float(b["time_seconds"]) for b in _section_boundaries(baseline)],
                "matched_expected": b_matched_s,
                "missed_expected": b_missed,
                "extra": b_extra,
            },
            "librosa": {
                "detected": [float(b["time_seconds"]) for b in _section_boundaries(librosa)],
                "matched_expected": l_matched_s,
                "missed_expected": l_missed,
                "extra": l_extra,
            },
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path, help="Baseline analysis JSON (miku-standard-library-audio-baseline)")
    parser.add_argument("librosa", type=Path, help="librosa analysis JSON (miku-librosa-backend)")
    parser.add_argument("ground_truth", type=Path, help="Fixture ground-truth JSON")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        baseline = _load_json(args.baseline)
        librosa = _load_json(args.librosa)
        ground_truth = _load_json(args.ground_truth)
    except (OSError, ValueError) as error:
        print(f"compare failed: {error}", file=sys.stderr)
        return 2
    rows = build_metric_rows(baseline, librosa, ground_truth)
    print("A/B comparison (baseline vs librosa vs ground truth):", file=sys.stderr)
    _print_table(rows, sys.stderr)
    summary = build_summary(baseline, librosa, ground_truth)
    sys.stdout.write(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
