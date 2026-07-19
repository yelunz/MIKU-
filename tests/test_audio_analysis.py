import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
ANALYZER = REPOSITORY_ROOT / "tools" / "analyze_audio.py"


def write_silent_wav(path: Path, frame_count: int = 8000) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(b"\x00\x00" * frame_count)


def run_analyzer(*arguments: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(ANALYZER), *(str(argument) for argument in arguments)],
        capture_output=True,
        check=False,
        text=True,
    )


class AudioAnalysisCliTests(unittest.TestCase):
    def test_silence_keeps_measurements_but_marks_inference_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "silence.wav"
            output = Path(directory) / "silence.analysis.json"
            write_silent_wav(source)

            completed = run_analyzer(source, "-o", output)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["analysis"]["waveform"]["bins"][0]["rms"], 0.0)
            for layer_name in ("tempo", "key", "chords", "sections"):
                self.assertEqual(result["analysis"][layer_name]["status"], "unavailable")
            self.assertEqual(result["analysis"]["tempo"]["candidates"], [])
            self.assertEqual(result["analysis"]["key"]["candidates"], [])
            self.assertEqual(result["analysis"]["chords"]["windows"], [])
            self.assertEqual(result["analysis"]["sections"]["regions"], [])

    def test_output_cannot_overwrite_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.wav"
            write_silent_wav(source)
            original_hash = hashlib.sha256(source.read_bytes()).hexdigest()

            completed = run_analyzer(source, "-o", source)

            self.assertEqual(completed.returncode, 2)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_hash)

    def test_invalid_numeric_parameters_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.wav"
            write_silent_wav(source)

            invalid_fft = run_analyzer(source, "--fft-size", 1)
            non_finite_threshold = run_analyzer(source, "--section-minimum-change-db", "nan")

            self.assertEqual(invalid_fft.returncode, 2)
            self.assertEqual(non_finite_threshold.returncode, 2)

    def test_truncated_pcm_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "truncated.wav"
            write_silent_wav(source)
            source.write_bytes(source.read_bytes()[:-2])

            completed = run_analyzer(source)

            self.assertEqual(completed.returncode, 2)
            self.assertIn("Truncated WAV", completed.stderr)


if __name__ == "__main__":
    unittest.main()
