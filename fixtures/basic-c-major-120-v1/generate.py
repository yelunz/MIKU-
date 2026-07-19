#!/usr/bin/env python3
"""Generate and verify the basic-c-major-120-v1 instrumental fixture.

This module deliberately uses only the Python standard library.  The source
JSON is the musical ground truth; the rendered manifest records facts measured
from the generated PCM file.
"""

from __future__ import annotations

import argparse
from array import array
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import wave


SCRIPT_DIR = Path(__file__).resolve().parent
GROUND_TRUTH_PATH = SCRIPT_DIR / "ground-truth.json"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR.parent / ".generated"
MANIFEST_FILENAME = "basic-c-major-120-v1.render-manifest.json"
GENERATOR_VERSION = "1.0.0"
TARGET_PCM_PEAK = 29204  # round(32767 * 10 ** (-1 / 20))
PHASE_SCALE = 1 << 32


class XorShift32:
    """Small deterministic PRNG used only for synthetic percussion noise."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF
        if self.state == 0:
            raise ValueError("XorShift32 seed must be non-zero")

    def signed_16(self) -> int:
        value = self.state
        value ^= (value << 13) & 0xFFFFFFFF
        value ^= value >> 17
        value ^= (value << 5) & 0xFFFFFFFF
        self.state = value & 0xFFFFFFFF
        return ((self.state >> 16) & 0xFFFF) - 32768


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def seconds_to_frame(seconds: float, sample_rate: int) -> int:
    return int(round(seconds * sample_rate))


def midi_phase_increment(note: int, sample_rate: int) -> int:
    frequency = 440.0 * (2.0 ** ((note - 69) / 12.0))
    return int(round(frequency * PHASE_SCALE / sample_rate))


def triangle_q15(phase: int) -> int:
    position = (phase >> 16) & 0xFFFF
    rising = position if position < 32768 else 65535 - position
    return (rising << 1) - 32767


def envelope_q16(index: int, length: int, attack: int, release: int) -> int:
    level = 65535
    if attack > 0 and index < attack:
        level = min(level, index * 65535 // attack)
    remaining = length - index - 1
    if release > 0 and remaining < release:
        level = min(level, max(0, remaining) * 65535 // release)
    return level


class Renderer:
    def __init__(self, truth: dict) -> None:
        audio = truth["audio"]
        timeline = truth["timeline"]
        self.truth = truth
        self.sample_rate = int(audio["sample_rate_hz"])
        self.total_frames = int(audio["frames_per_channel"])
        self.first_downbeat = seconds_to_frame(
            float(timeline["first_downbeat_seconds"]), self.sample_rate
        )
        self.beat_frames = seconds_to_frame(
            float(timeline["beat_duration_seconds"]), self.sample_rate
        )
        self.bar_frames = seconds_to_frame(
            float(timeline["bar_duration_seconds"]), self.sample_rate
        )
        self.left = array("i", [0]) * self.total_frames
        self.right = array("i", [0]) * self.total_frames
        self.noise = XorShift32(int(truth["generator"]["seed"]))
        self.events_by_bar: dict[int, list[dict]] = {}
        for event in truth["chord_events"]:
            self.events_by_bar.setdefault(int(event["bar"]), []).append(event)

    def mix_value(
        self, frame: int, value: int, pan_left_q8: int, pan_right_q8: int
    ) -> None:
        if 0 <= frame < self.total_frames:
            self.left[frame] += value * pan_left_q8 // 256
            self.right[frame] += value * pan_right_q8 // 256

    def add_triangle_note(
        self,
        midi_note: int,
        start: int,
        length: int,
        amplitude: int,
        pan_left_q8: int = 256,
        pan_right_q8: int = 256,
        attack_ms: int = 5,
        release_ms: int = 80,
    ) -> None:
        if length <= 0 or start >= self.total_frames:
            return
        length = min(length, self.total_frames - max(0, start))
        phase = 0
        increment = midi_phase_increment(midi_note, self.sample_rate)
        attack = self.sample_rate * attack_ms // 1000
        release = min(length, self.sample_rate * release_ms // 1000)
        for index in range(length):
            oscillator = triangle_q15(phase)
            phase = (phase + increment) & 0xFFFFFFFF
            level = envelope_q16(index, length, attack, release)
            value = oscillator * amplitude // 32768
            value = value * level // 65535
            self.mix_value(start + index, value, pan_left_q8, pan_right_q8)

    def add_electric_piano_chord(
        self, notes: list[int], start: int, length: int, amplitude: int
    ) -> None:
        per_note = max(1, amplitude // max(1, len(notes)))
        for note in notes:
            self.add_triangle_note(
                note,
                start,
                length,
                per_note,
                pan_left_q8=256,
                pan_right_q8=170,
                attack_ms=7,
                release_ms=110,
            )
            self.add_triangle_note(
                note + 12,
                start,
                length,
                max(1, per_note // 5),
                pan_left_q8=210,
                pan_right_q8=140,
                attack_ms=7,
                release_ms=90,
            )

    def add_pad_chord(
        self, notes: list[int], start: int, length: int, amplitude: int
    ) -> None:
        per_note = max(1, amplitude // max(1, len(notes)))
        for index, note in enumerate(notes):
            if index % 2:
                pan_left, pan_right = 145, 256
            else:
                pan_left, pan_right = 256, 145
            self.add_triangle_note(
                note,
                start,
                length,
                per_note,
                pan_left_q8=pan_left,
                pan_right_q8=pan_right,
                attack_ms=45,
                release_ms=180,
            )

    def add_bass(self, note: int, start: int, length: int, amplitude: int) -> None:
        self.add_triangle_note(
            note,
            start,
            length,
            amplitude,
            attack_ms=4,
            release_ms=70,
        )

    def add_kick(self, start: int, amplitude: int) -> None:
        length = self.sample_rate * 180 // 1000
        phase = 0
        start_increment = int(round(92.0 * PHASE_SCALE / self.sample_rate))
        end_increment = int(round(46.0 * PHASE_SCALE / self.sample_rate))
        for index in range(length):
            increment = start_increment + (
                (end_increment - start_increment) * index // length
            )
            oscillator = triangle_q15(phase)
            phase = (phase + increment) & 0xFFFFFFFF
            remaining = length - index
            level = remaining * remaining * 65535 // (length * length)
            value = oscillator * amplitude // 32768
            value = value * level // 65535
            self.mix_value(start + index, value, 256, 256)

    def add_snare(self, start: int, amplitude: int) -> None:
        length = self.sample_rate * 150 // 1000
        phase = 0
        tone_increment = int(round(185.0 * PHASE_SCALE / self.sample_rate))
        previous_noise = 0
        for index in range(length):
            noise = self.noise.signed_16()
            high_pass = (noise - previous_noise) // 2
            previous_noise = noise
            tone = triangle_q15(phase)
            phase = (phase + tone_increment) & 0xFFFFFFFF
            remaining = length - index
            level = remaining * remaining * 65535 // (length * length)
            combined = (high_pass * 3 + tone) // 4
            value = combined * amplitude // 32768
            value = value * level // 65535
            self.mix_value(start + index, value, 230, 230)

    def add_hat(self, start: int, amplitude: int, open_hat: bool = False) -> None:
        duration_ms = 180 if open_hat else 38
        length = self.sample_rate * duration_ms // 1000
        previous_noise = 0
        for index in range(length):
            noise = self.noise.signed_16()
            high_pass = (noise - previous_noise) // 2
            previous_noise = noise
            remaining = length - index
            level = remaining * remaining * 65535 // (length * length)
            value = high_pass * amplitude // 32768
            value = value * level // 65535
            self.mix_value(start + index, value, 180, 256)

    def chord_at(self, bar: int, beat_offset: float = 0.0) -> dict:
        events = self.events_by_bar[bar]
        for event in events:
            start_offset = float(event["start_beat"]) - 1.0
            end_offset = start_offset + float(event["duration_beats"])
            if start_offset <= beat_offset < end_offset:
                return event
        return events[-1]

    def render_harmony(self) -> None:
        for event in self.truth["chord_events"]:
            bar = int(event["bar"])
            start = seconds_to_frame(float(event["start_seconds"]), self.sample_rate)
            event_length = seconds_to_frame(
                float(event["end_seconds"]) - float(event["start_seconds"]),
                self.sample_rate,
            )
            notes = [int(note) for note in event["rendered_midi_notes"]]
            if bar <= 4:
                self.add_electric_piano_chord(
                    notes, start, min(event_length, int(1.82 * self.sample_rate)), 2500
                )
            elif bar <= 12:
                note_length = int(0.86 * self.sample_rate)
                self.add_electric_piano_chord(notes, start, note_length, 3200)
                self.add_electric_piano_chord(
                    notes, start + 2 * self.beat_frames, note_length, 3000
                )
            elif bar <= 20:
                self.add_pad_chord(
                    notes,
                    start,
                    min(event_length + int(0.16 * self.sample_rate), self.total_frames - start),
                    2500,
                )
                note_length = min(event_length, int(0.72 * self.sample_rate))
                self.add_electric_piano_chord(notes, start, note_length, 3000)
                if event_length > 2 * self.beat_frames:
                    self.add_electric_piano_chord(
                        notes,
                        start + 2 * self.beat_frames,
                        note_length,
                        2800,
                    )
            else:
                if bar == 24:
                    length = int(2.8 * self.sample_rate)
                    amplitude = 2700
                else:
                    length = int(1.72 * self.sample_rate)
                    amplitude = 2400 if bar == 21 else 2100
                self.add_electric_piano_chord(notes, start, length, amplitude)

    def render_bass(self) -> None:
        for bar in range(1, 25):
            bar_start = self.first_downbeat + (bar - 1) * self.bar_frames
            root = int(self.chord_at(bar)["bass_midi"])
            if bar <= 4:
                for beat in (0, 2):
                    self.add_bass(
                        root,
                        bar_start + beat * self.beat_frames,
                        int(0.82 * self.sample_rate),
                        1050,
                    )
            elif bar <= 12:
                pattern = (root, root + 7, root + 12, root + 7)
                for beat, note in enumerate(pattern):
                    self.add_bass(
                        note,
                        bar_start + beat * self.beat_frames,
                        int(0.40 * self.sample_rate),
                        1500,
                    )
            elif bar <= 20:
                for eighth in range(8):
                    beat_offset = eighth * 0.5
                    active = self.chord_at(bar, beat_offset)
                    active_root = int(active["bass_midi"])
                    pattern = (0, 12, 7, 12)
                    note = active_root + pattern[eighth % len(pattern)]
                    self.add_bass(
                        note,
                        bar_start + eighth * self.beat_frames // 2,
                        int(0.19 * self.sample_rate),
                        1650,
                    )
            elif bar <= 22:
                amplitude = 1250 if bar == 21 else 950
                for beat in (0, 2):
                    self.add_bass(
                        root,
                        bar_start + beat * self.beat_frames,
                        int(0.78 * self.sample_rate),
                        amplitude,
                    )
            elif bar == 23:
                self.add_bass(root, bar_start, int(1.7 * self.sample_rate), 850)
            else:
                self.add_bass(root, bar_start, int(2.55 * self.sample_rate), 700)

    def render_arpeggiator(self) -> None:
        arp_order = (0, 1, 2, 1, 3, 2, 1, 2)
        for bar in range(13, 21):
            bar_start = self.first_downbeat + (bar - 1) * self.bar_frames
            for eighth, chord_index in enumerate(arp_order):
                active = self.chord_at(bar, eighth * 0.5)
                notes = [int(note) for note in active["rendered_midi_notes"]]
                note = notes[chord_index % len(notes)] + 12
                self.add_triangle_note(
                    note,
                    bar_start + eighth * self.beat_frames // 2,
                    int(0.18 * self.sample_rate),
                    720,
                    pan_left_q8=165,
                    pan_right_q8=256,
                    attack_ms=3,
                    release_ms=45,
                )

    def render_drums(self) -> None:
        for bar in range(1, 5):
            bar_start = self.first_downbeat + (bar - 1) * self.bar_frames
            for beat in range(4):
                self.add_hat(bar_start + beat * self.beat_frames, 180)

        for bar in range(5, 13):
            bar_start = self.first_downbeat + (bar - 1) * self.bar_frames
            for beat in (0, 2):
                self.add_kick(bar_start + beat * self.beat_frames, 2300)
            for beat in (1, 3):
                self.add_snare(bar_start + beat * self.beat_frames, 1700)
            for eighth in range(8):
                self.add_hat(bar_start + eighth * self.beat_frames // 2, 430)

        for bar in range(13, 21):
            bar_start = self.first_downbeat + (bar - 1) * self.bar_frames
            for sixteenth in (0, 6, 8, 10):
                self.add_kick(bar_start + sixteenth * self.beat_frames // 4, 2900)
            for beat in (1, 3):
                self.add_snare(bar_start + beat * self.beat_frames, 2100)
            for sixteenth in range(16):
                self.add_hat(bar_start + sixteenth * self.beat_frames // 4, 560)
            self.add_hat(bar_start + 7 * self.beat_frames // 2, 720, open_hat=True)

        for bar, scale_q8 in ((21, 170), (22, 115)):
            bar_start = self.first_downbeat + (bar - 1) * self.bar_frames
            for beat in (0, 2):
                self.add_kick(
                    bar_start + beat * self.beat_frames, 2300 * scale_q8 // 256
                )
            for beat in (1, 3):
                self.add_snare(
                    bar_start + beat * self.beat_frames, 1700 * scale_q8 // 256
                )
            for eighth in range(8):
                self.add_hat(
                    bar_start + eighth * self.beat_frames // 2,
                    430 * scale_q8 // 256,
                )

    def apply_section_dynamics(self) -> None:
        """Apply deterministic section gains before global peak normalization."""
        for section in self.truth["sections"]:
            start = seconds_to_frame(float(section["start_seconds"]), self.sample_rate)
            end = seconds_to_frame(float(section["end_seconds"]), self.sample_rate)
            start_gain = int(section["gain_q8"])
            end_gain = int(section.get("end_gain_q8", start_gain))
            span = max(1, end - start - 1)
            for frame in range(start, end):
                offset = frame - start
                gain = start_gain + (end_gain - start_gain) * offset // span
                self.left[frame] = self.left[frame] * gain // 256
                self.right[frame] = self.right[frame] * gain // 256

    def render(self) -> tuple[array, array, int]:
        self.render_harmony()
        self.render_bass()
        self.render_arpeggiator()
        self.render_drums()
        self.apply_section_dynamics()

        maximum = 0
        for channel in (self.left, self.right):
            for sample in channel:
                absolute = abs(sample)
                if absolute > maximum:
                    maximum = absolute
        if maximum == 0:
            raise RuntimeError("renderer produced silence")

        for channel in (self.left, self.right):
            for index, sample in enumerate(channel):
                numerator = sample * TARGET_PCM_PEAK
                if numerator >= 0:
                    scaled = (numerator + maximum // 2) // maximum
                else:
                    scaled = -((-numerator + maximum // 2) // maximum)
                channel[index] = max(-32768, min(32767, scaled))
        return self.left, self.right, maximum


def write_wav(path: Path, left: array, right: array, sample_rate: int) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with wave.open(str(temporary), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        chunk_frames = 8192
        for start in range(0, len(left), chunk_frames):
            end = min(len(left), start + chunk_frames)
            interleaved = array("h")
            for index in range(start, end):
                interleaved.append(left[index])
                interleaved.append(right[index])
            if sys.byteorder != "little":
                interleaved.byteswap()
            output.writeframesraw(interleaved.tobytes())
    os.replace(temporary, path)


def section_rms_dbfs(left: array, right: array, start: int, end: int) -> float:
    sum_squares = 0
    count = max(1, (end - start) * 2)
    for index in range(start, end):
        sum_squares += left[index] * left[index]
        sum_squares += right[index] * right[index]
    rms = math.sqrt(sum_squares / count) / 32768.0
    return round(20.0 * math.log10(max(rms, 1e-12)), 4)


def fft_in_place(values: list[complex]) -> None:
    size = len(values)
    target = 0
    for source in range(1, size):
        bit = size >> 1
        while target & bit:
            target ^= bit
            bit >>= 1
        target ^= bit
        if source < target:
            values[source], values[target] = values[target], values[source]

    length = 2
    while length <= size:
        angle = -2.0 * math.pi / length
        phase_step = complex(math.cos(angle), math.sin(angle))
        half = length // 2
        for block in range(0, size, length):
            phase = 1.0 + 0.0j
            for offset in range(half):
                even = values[block + offset]
                odd = values[block + offset + half] * phase
                values[block + offset] = even + odd
                values[block + offset + half] = even - odd
                phase *= phase_step
        length <<= 1


def spectral_snapshot(
    left: array,
    right: array,
    start: int,
    end: int,
    sample_rate: int,
    bands: dict,
) -> dict:
    fft_size = 4096
    center = (start + end) // 2
    window_start = max(0, min(len(left) - fft_size, center - fft_size // 2))
    values: list[complex] = []
    for offset in range(fft_size):
        sample = (left[window_start + offset] + right[window_start + offset]) / 65536.0
        window = 0.5 - 0.5 * math.cos(2.0 * math.pi * offset / (fft_size - 1))
        values.append(complex(sample * window, 0.0))
    fft_in_place(values)
    powers = [
        values[index].real * values[index].real
        + values[index].imag * values[index].imag
        for index in range(fft_size // 2 + 1)
    ]
    total_power = max(sum(powers[1:]), 1e-30)
    bin_hz = sample_rate / fft_size
    centroid = sum(index * bin_hz * power for index, power in enumerate(powers))
    centroid /= max(sum(powers), 1e-30)
    band_relative_db = {}
    for name, limits in bands.items():
        low, high = float(limits[0]), float(limits[1])
        band_power = 0.0
        for index, power in enumerate(powers):
            frequency = index * bin_hz
            if low <= frequency < high:
                band_power += power
        ratio = max(band_power / total_power, 1e-30)
        band_relative_db[name] = round(10.0 * math.log10(ratio), 4)
    return {
        "window_start_seconds": round(window_start / sample_rate, 6),
        "fft_size": fft_size,
        "window": "hann",
        "spectral_centroid_hz": round(centroid, 4),
        "band_power_relative_db": band_relative_db,
    }


def measured_reference(truth: dict, left: array, right: array) -> dict:
    sample_rate = int(truth["audio"]["sample_rate_hz"])
    sections = {}
    for section in truth["sections"]:
        start = seconds_to_frame(float(section["start_seconds"]), sample_rate)
        end = seconds_to_frame(float(section["end_seconds"]), sample_rate)
        sections[section["id"]] = {
            "rms_dbfs": section_rms_dbfs(left, right, start, end),
            "spectrum": spectral_snapshot(
                left,
                right,
                start,
                end,
                sample_rate,
                truth["frequency_bands_hz"],
            ),
        }
    peak = max(max(abs(value) for value in left), max(abs(value) for value in right))
    peak_dbfs = 20.0 * math.log10(peak / 32768.0)
    return {"peak_dbfs": round(peak_dbfs, 4), "sections": sections}


def validate_measured_reference(truth: dict, reference: dict) -> dict:
    sections = reference["sections"]
    minimum = float(truth["acceptance"]["minimum_adjacent_energy_difference_db"])
    intro_to_a = sections["a"]["rms_dbfs"] - sections["intro"]["rms_dbfs"]
    a_to_b = sections["b"]["rms_dbfs"] - sections["a"]["rms_dbfs"]
    checks = {
        "intro_to_a_energy_difference": intro_to_a >= minimum,
        "a_to_b_energy_difference": a_to_b >= minimum,
        "outro_quieter_than_a": sections["outro"]["rms_dbfs"] < sections["a"]["rms_dbfs"],
        "b_spectral_centroid_above_intro": (
            sections["b"]["spectrum"]["spectral_centroid_hz"]
            > sections["intro"]["spectrum"]["spectral_centroid_hz"]
        ),
    }
    if not all(checks.values()):
        failures = [name for name, passed in checks.items() if not passed]
        raise RuntimeError("measured fixture validation failed: " + ", ".join(failures))
    checks["intro_to_a_difference_db"] = round(intro_to_a, 4)
    checks["a_to_b_difference_db"] = round(a_to_b, 4)
    return checks


def validate_truth(truth: dict) -> None:
    audio = truth["audio"]
    timeline = truth["timeline"]
    expected = {
        "sample_rate_hz": 48000,
        "channels": 2,
        "sample_width_bytes": 2,
        "duration_seconds": 50.0,
        "frames_per_channel": 2400000,
    }
    for key, value in expected.items():
        if audio.get(key) != value:
            raise ValueError(f"ground truth audio.{key} must be {value!r}")
    if timeline["bpm"] != 120.0 or timeline["bar_count"] != 24:
        raise ValueError("ground truth must describe 120 BPM and 24 bars")
    if len(truth["chord_events"]) != 25:
        raise ValueError("ground truth must contain 25 chord events")
    previous_end = 1.0
    for event in truth["chord_events"]:
        if abs(float(event["start_seconds"]) - previous_end) > 1e-9:
            raise ValueError("chord events must be contiguous from 1.0 to 49.0 seconds")
        previous_end = float(event["end_seconds"])
    if abs(previous_end - 49.0) > 1e-9:
        raise ValueError("chord events must end at 49.0 seconds")


def verify_wav(path: Path, truth: dict, expected_sha256: str | None = None) -> dict:
    audio = truth["audio"]
    with wave.open(str(path), "rb") as source:
        actual = {
            "channels": source.getnchannels(),
            "sample_width_bytes": source.getsampwidth(),
            "sample_rate_hz": source.getframerate(),
            "frames_per_channel": source.getnframes(),
            "compression_type": source.getcomptype(),
        }
        first_second = source.readframes(int(audio["sample_rate_hz"]))
    expected = {
        "channels": int(audio["channels"]),
        "sample_width_bytes": int(audio["sample_width_bytes"]),
        "sample_rate_hz": int(audio["sample_rate_hz"]),
        "frames_per_channel": int(audio["frames_per_channel"]),
        "compression_type": "NONE",
    }
    checks = {key: actual[key] == value for key, value in expected.items()}
    checks["leading_silence_is_digital_zero"] = not any(first_second)
    wav_sha256 = sha256_file(path)
    if expected_sha256 is not None:
        checks["sha256_matches_manifest"] = wav_sha256 == expected_sha256
    duration = actual["frames_per_channel"] / actual["sample_rate_hz"]
    checks["duration_seconds"] = abs(duration - float(audio["duration_seconds"])) < 1e-12
    if not all(checks.values()):
        failures = [name for name, passed in checks.items() if not passed]
        raise RuntimeError("WAV verification failed: " + ", ".join(failures))
    return {
        "checks": checks,
        "actual": actual,
        "duration_seconds": duration,
        "sha256": wav_sha256,
    }


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)


def generate(output_dir: Path) -> dict:
    truth = load_json(GROUND_TRUTH_PATH)
    validate_truth(truth)
    output_dir.mkdir(parents=True, exist_ok=True)
    wav_path = output_dir / truth["audio"]["filename"]
    renderer = Renderer(truth)
    left, right, pre_normalization_peak = renderer.render()
    write_wav(wav_path, left, right, int(truth["audio"]["sample_rate_hz"]))
    wav_validation = verify_wav(wav_path, truth)
    reference = measured_reference(truth, left, right)
    reference_validation = validate_measured_reference(truth, reference)
    manifest = {
        "schema_version": "1.0.0",
        "fixture_id": truth["fixture_id"],
        "generator_version": GENERATOR_VERSION,
        "generator_source_sha256": sha256_file(Path(__file__).resolve()),
        "ground_truth_sha256": sha256_file(GROUND_TRUTH_PATH),
        "output": {
            "path": wav_path.name,
            "size_bytes": wav_path.stat().st_size,
            "sha256": wav_validation["sha256"],
            "sample_rate_hz": wav_validation["actual"]["sample_rate_hz"],
            "channels": wav_validation["actual"]["channels"],
            "sample_width_bytes": wav_validation["actual"]["sample_width_bytes"],
            "frames_per_channel": wav_validation["actual"]["frames_per_channel"],
            "duration_seconds": wav_validation["duration_seconds"],
        },
        "render": {
            "seed": int(truth["generator"]["seed"]),
            "noise_algorithm": truth["generator"]["noise_algorithm"],
            "pre_normalization_integer_peak": pre_normalization_peak,
            "target_pcm_peak": TARGET_PCM_PEAK,
        },
        "measured_reference": reference,
        "validation": {**wav_validation["checks"], **reference_validation},
    }
    manifest_path = output_dir / MANIFEST_FILENAME
    temporary = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(manifest, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")
    os.replace(temporary, manifest_path)
    loaded_manifest = load_json(manifest_path)
    verify_wav(wav_path, truth, loaded_manifest["output"]["sha256"])
    return {"wav": wav_path, "manifest": manifest_path, "data": loaded_manifest}


def verify_existing(output_dir: Path) -> dict:
    truth = load_json(GROUND_TRUTH_PATH)
    validate_truth(truth)
    wav_path = output_dir / truth["audio"]["filename"]
    manifest_path = output_dir / MANIFEST_FILENAME
    manifest = load_json(manifest_path)
    if manifest["ground_truth_sha256"] != sha256_file(GROUND_TRUTH_PATH):
        raise RuntimeError("ground-truth.json hash does not match the render manifest")
    if manifest["generator_source_sha256"] != sha256_file(Path(__file__).resolve()):
        raise RuntimeError("generate.py hash does not match the render manifest")
    boolean_checks = [value for value in manifest["validation"].values() if isinstance(value, bool)]
    if not boolean_checks or not all(boolean_checks):
        raise RuntimeError("render manifest contains failed validation checks")
    validation = verify_wav(wav_path, truth, manifest["output"]["sha256"])
    return {"wav": wav_path, "manifest": manifest_path, "validation": validation}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Verify an existing WAV and render manifest without rendering again.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    if args.verify_only:
        result = verify_existing(output_dir)
        summary = {
            "status": "verified",
            "wav": str(result["wav"]),
            "manifest": str(result["manifest"]),
            "sha256": result["validation"]["sha256"],
        }
    else:
        result = generate(output_dir)
        summary = {
            "status": "generated-and-verified",
            "wav": str(result["wav"]),
            "manifest": str(result["manifest"]),
            "sha256": result["data"]["output"]["sha256"],
            "duration_seconds": result["data"]["output"]["duration_seconds"],
            "sample_rate_hz": result["data"]["output"]["sample_rate_hz"],
            "channels": result["data"]["output"]["channels"],
            "sample_width_bytes": result["data"]["output"]["sample_width_bytes"],
        }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
