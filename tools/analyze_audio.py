#!/usr/bin/env python3
"""Deterministic, standard-library-only PCM WAV analysis baseline.

This spike favors transparent and reproducible features over production-grade
music-information-retrieval accuracy.  It intentionally does not read fixture
ground truth or infer results from filenames.
"""

from __future__ import annotations

import argparse
from array import array
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import sys
import tempfile
import wave


ANALYZER_VERSION = "0.1.0"
EPSILON = 1e-12
PITCH_CLASS_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
KEY_PROFILES = {
    "major": (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88),
    "minor": (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17),
}
CHORD_QUALITIES = {
    "major": ((0, 1.0), (4, 0.85), (7, 0.85)),
    "minor": ((0, 1.0), (3, 0.85), (7, 0.85)),
    "suspended-fourth": ((0, 1.0), (5, 0.78), (7, 0.85)),
    "dominant-seventh": ((0, 1.0), (4, 0.78), (7, 0.78), (10, 0.65)),
}


def rounded(value: float, digits: int = 6) -> float:
    return round(float(value), digits)


def dbfs(value: float) -> float:
    if value <= EPSILON:
        return -120.0
    return 20.0 * math.log10(value)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def decode_pcm_chunk(raw: bytes, sample_width: int, channels: int) -> array:
    """Decode interleaved little-endian PCM and return normalized mono samples."""
    if sample_width == 1:
        values = [byte - 128 for byte in raw]
        scale = 128.0
    elif sample_width == 2:
        decoded = array("h")
        decoded.frombytes(raw)
        if sys.byteorder != "little":
            decoded.byteswap()
        values = decoded
        scale = 32768.0
    elif sample_width == 3:
        values = []
        for offset in range(0, len(raw), 3):
            value = raw[offset] | (raw[offset + 1] << 8) | (raw[offset + 2] << 16)
            if value & 0x800000:
                value -= 1 << 24
            values.append(value)
        scale = 8388608.0
    elif sample_width == 4:
        decoded = array("i")
        decoded.frombytes(raw)
        if sys.byteorder != "little":
            decoded.byteswap()
        values = decoded
        scale = 2147483648.0
    else:
        raise ValueError(f"Unsupported PCM sample width: {sample_width} bytes")

    mono = array("d")
    for offset in range(0, len(values), channels):
        mono.append(sum(values[offset : offset + channels]) / (scale * channels))
    return mono


def read_pcm_wav(path: Path) -> tuple[dict, array]:
    samples = array("d")
    with wave.open(str(path), "rb") as source:
        if source.getcomptype() != "NONE":
            raise ValueError(f"Only uncompressed PCM WAV is supported, got {source.getcomptype()}")
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        sample_rate = source.getframerate()
        frame_count = source.getnframes()
        if channels < 1 or sample_rate < 1 or frame_count < 1:
            raise ValueError("WAV must contain at least one channel and one frame")
        while raw := source.readframes(65536):
            samples.extend(decode_pcm_chunk(raw, sample_width, channels))
    if len(samples) != frame_count:
        raise ValueError(f"Truncated WAV: header declares {frame_count} frames but decoded {len(samples)}")

    metadata = {
        "filename": path.name,
        "sha256": sha256_file(path),
        "container": "wav",
        "encoding": f"pcm-s{sample_width * 8}le" if sample_width > 1 else "pcm-u8",
        "sample_rate_hz": sample_rate,
        "channels": channels,
        "sample_width_bytes": sample_width,
        "frames_per_channel": frame_count,
        "duration_seconds": rounded(frame_count / sample_rate),
    }
    return metadata, samples


def waveform_bins(samples: array, sample_rate: int, bin_count: int) -> list[dict]:
    result = []
    length = len(samples)
    for index in range(bin_count):
        start = index * length // bin_count
        end = max(start + 1, (index + 1) * length // bin_count)
        chunk = samples[start:end]
        minimum = min(chunk)
        maximum = max(chunk)
        rms = math.sqrt(sum(value * value for value in chunk) / len(chunk))
        result.append(
            {
                "start_seconds": rounded(start / sample_rate),
                "end_seconds": rounded(min(end, length) / sample_rate),
                "minimum": rounded(minimum),
                "maximum": rounded(maximum),
                "peak": rounded(max(abs(minimum), abs(maximum))),
                "rms": rounded(rms),
                "rms_dbfs": rounded(dbfs(rms), 4),
            }
        )
    return result


def downsample(samples: array, source_rate: int, requested_rate: int) -> tuple[array, float, int]:
    factor = max(1, int(round(source_rate / requested_rate)))
    reduced = array("d")
    for start in range(0, len(samples), factor):
        chunk = samples[start : start + factor]
        reduced.append(sum(chunk) / len(chunk))
    return reduced, source_rate / factor, factor


def prefix_squares(samples: array) -> array:
    result = array("d", [0.0])
    total = 0.0
    for value in samples:
        total += value * value
        result.append(total)
    return result


def interval_rms(prefix: array, start: int, end: int) -> float:
    end = min(end, len(prefix) - 1)
    start = max(0, min(start, end - 1))
    return math.sqrt(max(0.0, prefix[end] - prefix[start]) / max(1, end - start))


def energy_bins(samples: array, sample_rate: float, bin_count: int) -> list[dict]:
    prefix = prefix_squares(samples)
    length = len(samples)
    result = []
    for index in range(bin_count):
        start = index * length // bin_count
        end = max(start + 1, (index + 1) * length // bin_count)
        rms = interval_rms(prefix, start, end)
        result.append(
            {
                "start_seconds": rounded(start / sample_rate),
                "end_seconds": rounded(min(end, length) / sample_rate),
                "rms": rounded(rms),
                "rms_dbfs": rounded(dbfs(rms), 4),
            }
        )
    return result


def fft_in_place(values: list[complex]) -> None:
    """Iterative radix-2 Cooley-Tukey FFT."""
    size = len(values)
    if size < 2 or size & (size - 1):
        raise ValueError("FFT size must be a power of two")
    target = 0
    for index in range(1, size):
        bit = size >> 1
        while target & bit:
            target ^= bit
            bit >>= 1
        target ^= bit
        if index < target:
            values[index], values[target] = values[target], values[index]
    span = 2
    while span <= size:
        root = complex(math.cos(-2.0 * math.pi / span), math.sin(-2.0 * math.pi / span))
        half = span // 2
        for base in range(0, size, span):
            factor = 1.0 + 0.0j
            for offset in range(half):
                even = values[base + offset]
                odd = factor * values[base + offset + half]
                values[base + offset] = even + odd
                values[base + offset + half] = even - odd
                factor *= root
        span <<= 1


def spectral_frames(samples: array, sample_rate: float, fft_size: int, hop_ms: float) -> list[dict]:
    hop = max(1, int(round(sample_rate * hop_ms / 1000.0)))
    window = [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (fft_size - 1)) for i in range(fft_size)]
    frames = []
    last_start = max(0, len(samples) - fft_size)
    starts = list(range(0, last_start + 1, hop)) or [0]
    if starts[-1] != last_start:
        starts.append(last_start)
    for start in starts:
        raw = samples[start : start + fft_size]
        if len(raw) < fft_size:
            raw.extend([0.0] * (fft_size - len(raw)))
        rms = math.sqrt(sum(value * value for value in raw) / fft_size)
        transformed = [complex(raw[i] * window[i], 0.0) for i in range(fft_size)]
        fft_in_place(transformed)
        magnitudes = [abs(value) for value in transformed[: fft_size // 2 + 1]]
        weighted = 0.0
        magnitude_sum = 0.0
        chroma = [0.0] * 12
        for index, magnitude in enumerate(magnitudes[1:], start=1):
            frequency = index * sample_rate / fft_size
            weighted += frequency * magnitude
            magnitude_sum += magnitude
            if 55.0 <= frequency <= min(2500.0, sample_rate / 2.0):
                midi = int(round(69.0 + 12.0 * math.log2(frequency / 440.0)))
                chroma[midi % 12] += magnitude / math.sqrt(frequency)
        chroma_sum = sum(chroma)
        normalized = [value / chroma_sum for value in chroma] if chroma_sum > EPSILON else [0.0] * 12
        frames.append(
            {
                "time": (start + fft_size / 2) / sample_rate,
                "rms_dbfs": dbfs(rms),
                "centroid": weighted / magnitude_sum if magnitude_sum > EPSILON else 0.0,
                "chroma": normalized,
            }
        )
    return frames


def aggregate_centroid(frames: list[dict], duration: float, bin_count: int) -> list[dict]:
    buckets: list[list[float]] = [[] for _ in range(bin_count)]
    for frame in frames:
        index = min(bin_count - 1, int(frame["time"] / max(duration, EPSILON) * bin_count))
        if frame["rms_dbfs"] > -80.0:
            buckets[index].append(frame["centroid"])
    result = []
    for index, bucket in enumerate(buckets):
        result.append(
            {
                "start_seconds": rounded(duration * index / bin_count),
                "end_seconds": rounded(duration * (index + 1) / bin_count),
                "centroid_hz": rounded(statistics.fmean(bucket), 3) if bucket else 0.0,
            }
        )
    return result


def onset_envelope(samples: array, sample_rate: float, hop_ms: float = 10.0) -> tuple[list[float], float]:
    prefix = prefix_squares(samples)
    hop = max(1, int(round(sample_rate * hop_ms / 1000.0)))
    window = max(hop, int(round(sample_rate * 0.04)))
    levels = []
    for start in range(0, len(samples), hop):
        levels.append(math.log(max(interval_rms(prefix, start, start + window), 1e-7)))
    novelty = [0.0]
    novelty.extend(max(0.0, levels[i] - levels[i - 1]) for i in range(1, len(levels)))
    if novelty:
        local = []
        radius = max(1, int(round(0.2 / (hop / sample_rate))))
        for index, value in enumerate(novelty):
            start = max(0, index - radius)
            baseline = sum(novelty[start:index + 1]) / (index + 1 - start)
            local.append(max(0.0, value - 0.5 * baseline))
        novelty = local
    return novelty, hop / sample_rate


def autocorrelation(values: list[float], lag: int) -> float:
    if lag <= 0 or lag >= len(values):
        return 0.0
    numerator = left = right = 0.0
    for index in range(lag, len(values)):
        a = values[index]
        b = values[index - lag]
        numerator += a * b
        left += a * a
        right += b * b
    return numerator / math.sqrt(left * right) if left > EPSILON and right > EPSILON else 0.0


def tempo_candidates(samples: array, sample_rate: float, minimum_bpm: float, maximum_bpm: float) -> list[dict]:
    envelope, step_seconds = onset_envelope(samples, sample_rate)
    minimum_lag = max(2, int(math.floor(60.0 / maximum_bpm / step_seconds)))
    maximum_lag = min(len(envelope) - 1, int(math.ceil(60.0 / minimum_bpm / step_seconds)))
    correlations = {lag: autocorrelation(envelope, lag) for lag in range(minimum_lag, maximum_lag + 1)}
    peaks = []
    for lag in range(minimum_lag, maximum_lag + 1):
        score = correlations[lag]
        if score >= correlations.get(lag - 1, -1.0) and score >= correlations.get(lag + 1, -1.0):
            adjustment = 0.0
            if lag - 1 in correlations and lag + 1 in correlations:
                left = correlations[lag - 1]
                right = correlations[lag + 1]
                denominator = left - 2.0 * score + right
                if abs(denominator) > EPSILON:
                    adjustment = max(-0.5, min(0.5, 0.5 * (left - right) / denominator))
            refined_lag = lag + adjustment
            bpm = 60.0 / (refined_lag * step_seconds)
            # Bar-level accents often make half-tempo autocorrelation stronger
            # than the beat.  Fold one slower metrical level into the score and
            # apply a broad, documented perceptual tempo prior only for ranking.
            slower_level = correlations.get(lag * 2, 0.0)
            tempo_prior = math.exp(-0.5 * (math.log(max(bpm, EPSILON) / 120.0) / 0.6) ** 2)
            ranking_score = (score + 0.75 * slower_level) * tempo_prior
            peaks.append((ranking_score, score, lag, bpm))
    peaks.sort(reverse=True)
    selected = []
    for ranking_score, raw_score, lag, bpm in peaks:
        if all(abs(bpm - existing[3]) >= 3.0 for existing in selected):
            selected.append((ranking_score, raw_score, lag, bpm))
        if len(selected) == 3:
            break
    if not selected and correlations:
        lag = max(correlations, key=correlations.get)
        score = correlations[lag]
        selected = [(score, score, lag, 60.0 / (lag * step_seconds))]

    mean = statistics.fmean(envelope) if envelope else 0.0
    deviation = statistics.pstdev(envelope) if len(envelope) > 1 else 0.0
    results = []
    for ranking_score, raw_score, lag, bpm in selected:
        phases = [0.0] * lag
        for index, value in enumerate(envelope):
            phases[index % lag] += value
        phase = max(range(lag), key=phases.__getitem__)
        significant = [
            index for index, value in enumerate(envelope)
            if value >= mean + deviation and min((index - phase) % lag, (phase - index) % lag) <= 1
        ]
        first_beat = significant[0] * step_seconds if significant else phase * step_seconds
        results.append(
            {
                "bpm": rounded(bpm, 3),
                "confidence": rounded(max(0.0, min(1.0, ranking_score))),
                "autocorrelation": rounded(raw_score),
                "first_beat_seconds": rounded(first_beat, 3),
                "period_seconds": rounded(60.0 / bpm, 6),
            }
        )
    return results


def cosine_score(values: list[float], template: list[float]) -> float:
    numerator = sum(a * b for a, b in zip(values, template))
    denominator = math.sqrt(sum(a * a for a in values) * sum(b * b for b in template))
    return numerator / denominator if denominator > EPSILON else 0.0


def key_candidates(frames: list[dict]) -> list[dict]:
    chroma = [0.0] * 12
    used = 0
    for frame in frames:
        if frame["rms_dbfs"] > -55.0:
            for index, value in enumerate(frame["chroma"]):
                chroma[index] += value
            used += 1
    if used:
        chroma = [value / used for value in chroma]
    scored = []
    for tonic in range(12):
        for mode, profile in KEY_PROFILES.items():
            template = [profile[(pitch - tonic) % 12] for pitch in range(12)]
            scored.append((cosine_score(chroma, template), tonic, mode))
    scored.sort(reverse=True)
    total = sum(math.exp((score - scored[0][0]) * 8.0) for score, _, _ in scored[:5]) if scored else 1.0
    return [
        {
            "label": f"{PITCH_CLASS_NAMES[tonic]} {mode}",
            "tonic_pitch_class": tonic,
            "mode": mode,
            "confidence": rounded(math.exp((score - scored[0][0]) * 8.0) / total),
            "similarity": rounded(score),
        }
        for score, tonic, mode in scored[:5]
    ]


def chord_label(root: int, quality: str) -> str:
    suffix = {"major": "", "minor": "m", "suspended-fourth": "sus4", "dominant-seventh": "7"}[quality]
    return PITCH_CLASS_NAMES[root] + suffix


def chord_windows(frames: list[dict], duration: float, window_seconds: float, alignment_seconds: float) -> list[dict]:
    windows = []
    start = max(0.0, min(duration, alignment_seconds))
    while start < duration - EPSILON:
        end = min(duration, start + window_seconds)
        selected = [frame for frame in frames if start <= frame["time"] < end and frame["rms_dbfs"] > -55.0]
        if not selected:
            windows.append({"start_seconds": rounded(start), "end_seconds": rounded(end), "candidates": [], "confidence": 0.0})
            start = end
            continue
        chroma = [sum(frame["chroma"][pitch] for frame in selected) / len(selected) for pitch in range(12)]
        scored = []
        for root in range(12):
            for quality, intervals in CHORD_QUALITIES.items():
                template = [0.08] * 12
                for interval, weight in intervals:
                    template[(root + interval) % 12] = weight
                score = cosine_score(chroma, template)
                scored.append((score, root, quality))
        scored.sort(reverse=True)
        top = scored[:3]
        denominator = sum(math.exp((score - top[0][0]) * 12.0) for score, _, _ in top)
        candidates = [
            {
                "label": chord_label(root, quality),
                "root_pitch_class": root,
                "quality": quality,
                "confidence": rounded(math.exp((score - top[0][0]) * 12.0) / denominator),
                "similarity": rounded(score),
            }
            for score, root, quality in top
        ]
        windows.append(
            {
                "start_seconds": rounded(start),
                "end_seconds": rounded(end),
                "candidates": candidates,
                "confidence": candidates[0]["confidence"],
            }
        )
        start = end
    return windows


def section_candidates(energy: list[dict], duration: float, comparison_seconds: float, minimum_change_db: float) -> dict:
    if len(energy) < 3:
        return {"boundaries": [], "regions": [{"start_seconds": 0.0, "end_seconds": rounded(duration), "label": "candidate-1"}]}
    bin_seconds = duration / len(energy)
    radius = max(1, int(round(comparison_seconds / max(bin_seconds, EPSILON))))
    scored = []
    for index in range(radius, len(energy) - radius):
        before = statistics.fmean(item["rms_dbfs"] for item in energy[index - radius : index])
        after = statistics.fmean(item["rms_dbfs"] for item in energy[index : index + radius])
        change = abs(after - before)
        if change >= minimum_change_db:
            scored.append((change, index, before, after))
    scored.sort(reverse=True)
    selected = []
    exclusion = max(1, int(round(3.0 / max(bin_seconds, EPSILON))))
    for item in scored:
        if all(abs(item[1] - existing[1]) >= exclusion for existing in selected):
            selected.append(item)
        if len(selected) == 8:
            break
    selected.sort(key=lambda item: item[1])
    boundaries = [
        {
            "time_seconds": rounded(index * bin_seconds),
            "confidence": rounded(min(1.0, change / 8.0)),
            "energy_change_db": rounded(after - before, 4),
        }
        for change, index, before, after in selected
    ]
    points = [0.0] + [item["time_seconds"] for item in boundaries] + [rounded(duration)]
    boundary_confidence = [1.0] + [item["confidence"] for item in boundaries] + [1.0]
    regions = [
        {
            "start_seconds": points[i],
            "end_seconds": points[i + 1],
            "label": f"candidate-{i + 1}",
            "confidence": rounded(min(boundary_confidence[i], boundary_confidence[i + 1])),
        }
        for i in range(len(points) - 1) if points[i + 1] > points[i]
    ]
    return {"boundaries": boundaries, "regions": regions}


def analyze(path: Path, args: argparse.Namespace) -> dict:
    metadata, mono = read_pcm_wav(path)
    sample_rate = int(metadata["sample_rate_hz"])
    duration = float(metadata["duration_seconds"])
    reduced, analysis_rate, decimation_factor = downsample(mono, sample_rate, args.analysis_rate)
    energy = energy_bins(reduced, analysis_rate, args.energy_bins)
    frames = spectral_frames(reduced, analysis_rate, args.fft_size, args.feature_hop_ms)
    has_signal = any(abs(sample) > EPSILON for sample in reduced)
    sections = (
        section_candidates(energy, duration, args.section_window_seconds, args.section_minimum_change_db)
        if has_signal else {"boundaries": [], "regions": []}
    )
    tempos = tempo_candidates(reduced, analysis_rate, args.minimum_bpm, args.maximum_bpm) if has_signal else []
    keys = key_candidates(frames) if has_signal else []
    chord_alignment = tempos[0]["first_beat_seconds"] if tempos else 0.0
    chords = chord_windows(frames, duration, args.chord_window_seconds, chord_alignment) if has_signal else []
    inference_status = "candidates" if has_signal else "unavailable"
    inference_warnings = [] if has_signal else ["No non-silent signal was available for inference."]
    return {
        "schema_version": "0.1.0",
        "analyzer": {
            "name": "miku-standard-library-audio-baseline",
            "version": ANALYZER_VERSION,
            "runtime": "python-standard-library-only",
            "deterministic": True,
        },
        "source_audio": metadata,
        "analysis": {
            "waveform": {
                "source": "measured-pcm",
                "confidence": 1.0,
                "parameters": {"bin_count": args.waveform_bins, "channel_mix": "arithmetic-mean"},
                "bins": waveform_bins(mono, sample_rate, args.waveform_bins),
            },
            "short_time_energy": {
                "source": "measured-pcm",
                "confidence": 1.0,
                "parameters": {"bin_count": args.energy_bins, "analysis_sample_rate_hz": rounded(analysis_rate, 3)},
                "bins": energy,
            },
            "spectral_centroid": {
                "source": "standard-library-radix2-fft",
                "confidence": 0.7,
                "parameters": {
                    "bin_count": args.feature_bins,
                    "fft_size": args.fft_size,
                    "hop_ms": args.feature_hop_ms,
                    "window": "hann",
                    "analysis_sample_rate_hz": rounded(analysis_rate, 3),
                    "decimation_factor": decimation_factor,
                },
                "bins": aggregate_centroid(frames, duration, args.feature_bins),
            },
            "tempo": {
                "source": "log-energy-onset-autocorrelation-baseline",
                "status": inference_status,
                "warnings": inference_warnings,
                "parameters": {
                    "minimum_bpm": args.minimum_bpm,
                    "maximum_bpm": args.maximum_bpm,
                    "onset_hop_ms": 10.0,
                    "slower_metrical_level_weight": 0.75,
                    "ranking_tempo_prior_bpm": 120.0,
                    "ranking_log_prior_sigma": 0.6,
                },
                "candidates": tempos,
            },
            "key": {
                "source": "fft-chroma-key-profile-baseline",
                "status": inference_status,
                "warnings": inference_warnings,
                "parameters": {"pitch_min_hz": 55.0, "pitch_max_hz": min(2500.0, analysis_rate / 2.0), "profiles": "Krumhansl-Schmuckler"},
                "candidates": keys,
            },
            "chords": {
                "source": "fft-chroma-template-baseline",
                "status": inference_status,
                "warnings": inference_warnings,
                "parameters": {
                    "window_seconds": args.chord_window_seconds,
                    "alignment_seconds": chord_alignment,
                    "alignment_source": "top-tempo-candidate-first-beat",
                    "qualities": list(CHORD_QUALITIES),
                },
                "windows": chords,
            },
            "sections": {
                "source": "bidirectional-energy-change-baseline",
                "status": inference_status,
                "warnings": inference_warnings,
                "parameters": {"comparison_window_seconds": args.section_window_seconds, "minimum_change_db": args.section_minimum_change_db, "minimum_boundary_spacing_seconds": 3.0},
                **sections,
            },
        },
        "limitations": [
            "This is a transparent technical spike, not a production music-information-retrieval algorithm.",
            "Tempo can be confused by half-time, double-time, syncopation, weak percussion, or changing tempo.",
            "Key and chord templates do not separate instruments or suppress overtones, inversions, extensions, and non-triad harmony reliably.",
            "Chord windows are fixed-duration and section boundaries use only energy change; both require later manual correction and replaceable analyzers.",
            "Input is limited to uncompressed integer PCM WAV; resampling uses block averaging rather than a production anti-alias filter.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Input uncompressed PCM WAV")
    parser.add_argument("-o", "--output", type=Path, help="Output JSON; omit to write stdout")
    parser.add_argument("--waveform-bins", type=int, default=240)
    parser.add_argument("--energy-bins", type=int, default=200)
    parser.add_argument("--feature-bins", type=int, default=200)
    parser.add_argument("--analysis-rate", type=int, default=8000)
    parser.add_argument("--fft-size", type=int, default=2048)
    parser.add_argument("--feature-hop-ms", type=float, default=50.0)
    parser.add_argument("--minimum-bpm", type=float, default=60.0)
    parser.add_argument("--maximum-bpm", type=float, default=200.0)
    parser.add_argument("--chord-window-seconds", type=float, default=2.0)
    parser.add_argument("--section-window-seconds", type=float, default=1.0)
    parser.add_argument("--section-minimum-change-db", type=float, default=1.5)
    args = parser.parse_args()
    numeric = (
        "waveform_bins", "energy_bins", "feature_bins", "analysis_rate", "fft_size",
        "feature_hop_ms", "minimum_bpm", "maximum_bpm", "chord_window_seconds",
        "section_window_seconds", "section_minimum_change_db",
    )
    if any(not math.isfinite(getattr(args, name)) for name in numeric):
        parser.error("numeric analysis parameters must be finite")
    positive = (
        "waveform_bins", "energy_bins", "feature_bins", "analysis_rate", "fft_size",
        "feature_hop_ms", "chord_window_seconds", "section_window_seconds",
        "section_minimum_change_db",
    )
    if any(getattr(args, name) <= 0 for name in positive):
        parser.error("bin counts, rates, FFT size, hops, and windows must be positive")
    if args.fft_size < 16 or args.fft_size & (args.fft_size - 1):
        parser.error("--fft-size must be a power of two and at least 16")
    if not 0 < args.minimum_bpm < args.maximum_bpm:
        parser.error("tempo range must satisfy 0 < minimum < maximum")
    return args


def main() -> int:
    args = parse_args()
    if args.output and args.input.resolve() == args.output.resolve():
        print("analysis failed: output path must differ from input path", file=sys.stderr)
        return 2
    try:
        result = analyze(args.input, args)
    except (OSError, EOFError, wave.Error, ValueError) as error:
        print(f"analysis failed: {error}", file=sys.stderr)
        return 2
    try:
        serialized = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"
    except ValueError as error:
        print(f"analysis failed: result contains a non-finite number: {error}", file=sys.stderr)
        return 2
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary_name = None
        try:
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", newline="\n", dir=args.output.parent,
                prefix=f".{args.output.name}.", suffix=".tmp", delete=False,
            ) as temporary:
                temporary_name = temporary.name
                temporary.write(serialized)
                temporary.flush()
                os.fsync(temporary.fileno())
            Path(temporary_name).replace(args.output)
        except OSError as error:
            if temporary_name:
                Path(temporary_name).unlink(missing_ok=True)
            print(f"analysis failed: could not write output: {error}", file=sys.stderr)
            return 2
        print(f"wrote {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(serialized)
    tempo = result["analysis"]["tempo"]["candidates"]
    key = result["analysis"]["key"]["candidates"]
    if args.output:
        print(
            f"summary: duration={result['source_audio']['duration_seconds']}s, "
            f"tempo={tempo[0]['bpm'] if tempo else 'n/a'} BPM, "
            f"key={key[0]['label'] if key else 'n/a'}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
