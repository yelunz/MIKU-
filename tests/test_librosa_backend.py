"""Tests for the P1.3 librosa analysis backend spike.

These tests verify the librosa backend (``tools/miku_analysis/librosa_backend.py``)
against the ``basic-c-major-120-v1`` fixture using the A/B comparison utilities in
``tools/miku_analysis/compare_a_b.py``.

Core acceptance points (per P1.3 step-1 task spec):

1. ``test_librosa_backend_outputs_valid_schema`` - schema_version=0.1.0 + top-level
   ``analyzer`` / ``source_audio`` / ``analysis`` objects.
2. ``test_librosa_backend_analyzer_name`` - analyzer.name = "miku-librosa-backend".
3. ``test_librosa_backend_tempo_matches_ground_truth`` - tempo top-1 in [119.5, 120.5].
4. ``test_librosa_backend_first_beat_matches_ground_truth`` - first_beat in [0.95, 1.05].
5. ``test_librosa_backend_key_matches_ground_truth`` - key top-1 = "C major".
6. ``test_librosa_backend_chord_accuracy_meets_threshold`` - chord accuracy >= 0.9.
7. ``test_librosa_backend_sections_match_ground_truth`` - section boundaries match
   [9.0, 25.0, 41.0] (tolerance 0.5 s).
8. ``test_librosa_backend_no_extra_section_boundaries`` - section boundary count = 3.

Tests are organised in two tiers:

1. **Fixture-backed metric tests** (fast): load the pre-generated
   ``fixtures/basic-c-major-120-v1/librosa-analysis-v2.json`` and verify the metrics
   above.  These do not invoke the CLI and run in < 1 s.
2. **CLI behavioural tests** (slower): invoke ``python -m
   tools.miku_analysis.librosa_backend`` on a silent WAV and on the fixture WAV to
   verify exit codes, silence handling and overwrite protection.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

try:
    import librosa  # noqa: F401
    HAVE_LIBROSA = True
except ImportError:
    HAVE_LIBROSA = False


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = REPOSITORY_ROOT / "fixtures" / "basic-c-major-120-v1"
GROUND_TRUTH_PATH = FIXTURE_DIR / "ground-truth.json"
# The v2 artifact is produced by P1.3 step 1: it is the canonical output of the
# updated librosa_backend (analyzer.version=0.1.0, runtime=python-librosa-0.11.0,
# agglomerative-based section detection).
LIBROSA_ANALYSIS_PATH = FIXTURE_DIR / "librosa-analysis-v2.json"
BASELINE_ANALYSIS_PATH = (
    REPOSITORY_ROOT / "fixtures" / ".generated" / "basic-c-major-120-v1.analysis.json"
)
FIXTURE_WAV_PATH = (
    REPOSITORY_ROOT / "fixtures" / ".generated" / "basic-c-major-120-v1.wav"
)

MODULE = "tools.miku_analysis.librosa_backend"


def write_silent_wav(path: Path, frame_count: int = 8000) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(b"\x00\x00" * frame_count)


def run_cli(*arguments: object) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPOSITORY_ROOT)
    return subprocess.run(
        [sys.executable, "-m", MODULE, *(str(argument) for argument in arguments)],
        capture_output=True,
        check=False,
        text=True,
        cwd=str(REPOSITORY_ROOT),
        env=env,
    )


@unittest.skipUnless(HAVE_LIBROSA, "librosa not installed")
@unittest.skipUnless(LIBROSA_ANALYSIS_PATH.exists(), "librosa-analysis-v2.json not generated")
class LibrosaBackendFixtureMetricTests(unittest.TestCase):
    """Fast metric tests on the pre-generated librosa analysis v2 JSON."""

    @classmethod
    def setUpClass(cls) -> None:
        with GROUND_TRUTH_PATH.open("r", encoding="utf-8") as handle:
            cls.ground_truth = json.load(handle)
        with LIBROSA_ANALYSIS_PATH.open("r", encoding="utf-8") as handle:
            cls.analysis = json.load(handle)

    def test_librosa_backend_outputs_valid_schema(self) -> None:
        """Top-level: schema_version=0.1.0, analyzer/source_audio/analysis present."""
        self.assertEqual(self.analysis["schema_version"], "0.1.0")
        for key in ("analyzer", "source_audio", "analysis"):
            self.assertIn(key, self.analysis, f"missing top-level key: {key}")
            self.assertIsInstance(self.analysis[key], dict, f"{key} must be an object")
        # All baseline-compatible analysis layers must be present.
        layers = self.analysis["analysis"]
        for layer in (
            "waveform",
            "short_time_energy",
            "spectral_centroid",
            "tempo",
            "key",
            "chords",
            "sections",
        ):
            self.assertIn(layer, layers, f"missing analysis layer: {layer}")
        # Each layer must carry source / confidence / parameters / warnings
        # (task constraint: every analysis layer is labelled with these 4 fields).
        for layer_name, layer in layers.items():
            self.assertIn("source", layer, f"{layer_name}: missing 'source'")
            self.assertIn("parameters", layer, f"{layer_name}: missing 'parameters'")
            self.assertIn("warnings", layer, f"{layer_name}: missing 'warnings'")
            if layer_name in ("waveform", "short_time_energy", "spectral_centroid"):
                self.assertIn("confidence", layer, f"{layer_name}: missing 'confidence'")

    def test_librosa_backend_analyzer_name(self) -> None:
        """analyzer.name = 'miku-librosa-backend', version='0.1.0', runtime='python-librosa-0.11.0'."""
        analyzer = self.analysis["analyzer"]
        self.assertEqual(analyzer["name"], "miku-librosa-backend")
        self.assertEqual(analyzer["version"], "0.1.0")
        self.assertEqual(analyzer["runtime"], "python-librosa-0.11.0")
        self.assertTrue(analyzer["deterministic"])

    def test_librosa_backend_tempo_matches_ground_truth(self) -> None:
        """Top tempo candidate must be in [119.5, 120.5] (GT=120, tolerance=0.5)."""
        candidates = self.analysis["analysis"]["tempo"]["candidates"]
        self.assertGreaterEqual(len(candidates), 1)
        bpm = float(candidates[0]["bpm"])
        self.assertGreaterEqual(bpm, 119.5, f"tempo {bpm} < 119.5")
        self.assertLessEqual(bpm, 120.5, f"tempo {bpm} > 120.5")

    def test_librosa_backend_first_beat_matches_ground_truth(self) -> None:
        """First beat of top tempo candidate must be in [0.95, 1.05] (GT=1.0, tol=0.05)."""
        candidates = self.analysis["analysis"]["tempo"]["candidates"]
        self.assertGreaterEqual(len(candidates), 1)
        first_beat = float(candidates[0]["first_beat_seconds"])
        self.assertGreaterEqual(first_beat, 0.95, f"first_beat {first_beat} < 0.95")
        self.assertLessEqual(first_beat, 1.05, f"first_beat {first_beat} > 1.05")

    def test_librosa_backend_key_matches_ground_truth(self) -> None:
        """Top key candidate must be 'C major' (GT key region)."""
        candidates = self.analysis["analysis"]["key"]["candidates"]
        self.assertGreaterEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["label"], "C major")

    def test_librosa_backend_chord_accuracy_meets_threshold(self) -> None:
        """Core acceptance: strict Top-1 midpoint-weighted chord accuracy >= 0.9.

        Uses ``compare_a_b.chord_strict_top1_midpoint_weighted_accuracy`` so the
        metric matches the baseline evaluation exactly.  Windows whose midpoint
        falls outside every GT chord event (leading silence / release tail) are
        skipped.
        """
        from tools.miku_analysis.compare_a_b import chord_strict_top1_midpoint_weighted_accuracy

        accuracy, matched, evaluated = chord_strict_top1_midpoint_weighted_accuracy(
            self.analysis, self.ground_truth
        )
        threshold = float(
            self.ground_truth["acceptance"]["basic_chord_time_weighted_accuracy"]
        )
        self.assertGreaterEqual(
            accuracy,
            threshold,
            f"chord accuracy {accuracy:.4f} ({matched}/{evaluated}) < threshold {threshold}",
        )

    def test_librosa_backend_sections_match_ground_truth(self) -> None:
        """Section boundaries must match [9.0, 25.0, 41.0] (tolerance 0.5 s).

        Each expected boundary must have at least one detected boundary within
        +/- 0.5 s.  This is the core acceptance point for the agglomerative
        section detection (replacing the baseline's energy-only detector that
        missed no boundaries but emitted extra ones).
        """
        expected = list(
            self.ground_truth["acceptance"]["expected_section_boundaries_seconds"]
        )
        tolerance = float(
            self.ground_truth["acceptance"]["section_boundary_tolerance_seconds"]
        )
        detected = [
            float(b["time_seconds"])
            for b in self.analysis["analysis"]["sections"]["boundaries"]
        ]
        missing = [
            exp for exp in expected
            if not any(abs(exp - det) <= tolerance for det in detected)
        ]
        self.assertEqual(
            missing,
            [],
            f"missing expected section boundaries (tol={tolerance}s): {missing}; "
            f"detected={detected}",
        )

    def test_librosa_backend_no_extra_section_boundaries(self) -> None:
        """Section boundary count must equal 3 (no extras beyond GT expected).

        Combined with the match test above, this enforces "exactly the 3
        boundaries [9.0, 25.0, 41.0]" - the key acceptance point that the
        baseline failed (it emitted extra boundaries).
        """
        expected = list(
            self.ground_truth["acceptance"]["expected_section_boundaries_seconds"]
        )
        tolerance = float(
            self.ground_truth["acceptance"]["section_boundary_tolerance_seconds"]
        )
        detected = [
            float(b["time_seconds"])
            for b in self.analysis["analysis"]["sections"]["boundaries"]
        ]
        extras = [
            det for det in detected
            if not any(abs(det - exp) <= tolerance for exp in expected)
        ]
        self.assertEqual(
            len(detected),
            len(expected),
            f"section boundary count {len(detected)} != expected {len(expected)}; "
            f"detected={detected}, extras={extras}",
        )
        self.assertEqual(extras, [], f"extra section boundaries present: {extras}")


@unittest.skipUnless(HAVE_LIBROSA, "librosa not installed")
class LibrosaBackendCliTests(unittest.TestCase):
    """CLI behavioural tests: silence handling and overwrite protection."""

    def test_librosa_backend_silence_marks_inference_unavailable(self) -> None:
        """Silent WAV: measurement layers present, inference status='unavailable'."""
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "silence.wav"
            output = Path(directory) / "silence.analysis.json"
            write_silent_wav(source)

            completed = run_cli(source, "-o", output)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["analysis"]["waveform"]["bins"][0]["rms"], 0.0)
            for layer in ("tempo", "key", "chords", "sections"):
                self.assertEqual(result["analysis"][layer]["status"], "unavailable")
            self.assertEqual(result["analysis"]["tempo"]["candidates"], [])
            self.assertEqual(result["analysis"]["key"]["candidates"], [])
            self.assertEqual(result["analysis"]["chords"]["windows"], [])
            self.assertEqual(result["analysis"]["sections"]["boundaries"], [])

    def test_librosa_backend_output_cannot_overwrite_input(self) -> None:
        """Output path == input path must exit 2 without modifying the input."""
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.wav"
            write_silent_wav(source)
            original_bytes = source.read_bytes()

            completed = run_cli(source, "-o", source)

            self.assertEqual(completed.returncode, 2)
            self.assertEqual(source.read_bytes(), original_bytes)


if __name__ == "__main__":
    unittest.main()
