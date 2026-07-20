"""Tests for P3 engine adapters (MIDI baseline, USTX 0.7, Synthesizer V sidecar)."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import yaml
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = REPOSITORY_ROOT / "tools"
MIDI_EXPORTER = TOOLS_DIR / "export_midi.py"
USTX_EXPORTER = TOOLS_DIR / "export_ustx.py"
SYNTHV_SIDECAR_EXPORTER = TOOLS_DIR / "export_synthv_sidecar.py"
SYNTHV_HELPER_SCRIPT = TOOLS_DIR / "synthv_helper_script_es5.js"


def make_minimal_project() -> dict:
    """Build a small neutral project matching miku-workbench-project/0.3.0."""

    return {
        "schema_version": "miku-workbench-project/0.3.0",
        "title": "Miku adapter test",
        "source_audio": {
            "sample_rate_hz": 48000,
            "duration_seconds": 4.0,
            "sha256": "deadbeef",
            "local_file_name": "test.wav",
            "relink_required_after_import": True,
        },
        "analysis": {
            "analysis": {
                "tempo": {
                    "candidates": [{"bpm": 120.0, "first_beat_seconds": 0.0}]
                },
                "key": {"candidates": [{"label": "C major"}]},
            },
            "source_audio": {"sample_rate_hz": 48000, "duration_seconds": 4.0},
        },
        "tempo_map": {
            "sample_rate_hz": 48000,
            "ppq": 960,
            "bpm": 120.0,
            "first_beat_seconds": 0.0,
            "first_beat_sample": 0,
            "first_beat_tick": 0,
        },
        "anchors": [
            {"id": "anchor-1", "sample": 0, "tick": 0},
            {"id": "anchor-2", "sample": 96000, "tick": 960},
            {"id": "anchor-3", "sample": 192000, "tick": 1920},
            {"id": "anchor-4", "sample": 288000, "tick": 2880},
        ],
        "editing": {
            "lyrics": [
                {
                    "id": "lyric-1",
                    "start_anchor_id": "anchor-1",
                    "end_anchor_id": "anchor-4",
                    "language": "zh",
                    "text": "你好世界",
                }
            ],
            "rests": [
                {
                    "id": "rest-1",
                    "start_anchor_id": "anchor-3",
                    "end_anchor_id": "anchor-4",
                    "kind": "rest",
                }
            ],
            "chord_overrides": {},
            "locked_fields": [],
            "stem_tracks": [
                {
                    "id": "master",
                    "name": "Master",
                    "role": "master",
                    "mute": False,
                    "solo": False,
                    "gain": 1.0,
                    "pan": 0.0,
                    "source": "main",
                    "trim_start_seconds": 0.0,
                    "trim_end_seconds": 0.0,
                    "fade_in_seconds": 0.0,
                    "fade_out_seconds": 0.0,
                }
            ],
            "notes": [
                {
                    "id": "note-1",
                    "stem_id": "master",
                    "start_anchor_id": "anchor-1",
                    "end_anchor_id": "anchor-2",
                    "pitch": 60,
                    "velocity": 0.8,
                    "confidence": 1.0,
                    "source": "manual",
                },
                {
                    "id": "note-2",
                    "stem_id": "master",
                    "start_anchor_id": "anchor-2",
                    "end_anchor_id": "anchor-3",
                    "pitch": 62,
                    "velocity": 0.5,
                    "confidence": 0.7,
                    "source": "transcription",
                },
            ],
            "syllables": [
                {
                    "id": "syllable-1",
                    "lyric_id": "lyric-1",
                    "index": 0,
                    "text": "你",
                    "default_reading": "ni",
                    "reading_override": "ni3",
                    "start_anchor_id": "anchor-1",
                    "end_anchor_id": "anchor-2",
                },
                {
                    "id": "syllable-2",
                    "lyric_id": "lyric-1",
                    "index": 1,
                    "text": "好",
                    "default_reading": "hao",
                    "reading_override": "",
                    "start_anchor_id": "anchor-2",
                    "end_anchor_id": "anchor-3",
                },
            ],
            "preferences": {
                "snap_mode": "1/4",
                "continuous_lyrics": True,
                "dotted_snap": False,
                "swing_amount": 0.0,
                "stem_preview_mode": "edited",
            },
        },
    }


def make_empty_project() -> dict:
    project = make_minimal_project()
    project["editing"]["notes"] = []
    project["editing"]["syllables"] = []
    project["editing"]["rests"] = []
    project["editing"]["lyrics"] = []
    return project


def write_project(tmp: Path, project: dict) -> Path:
    path = tmp / "project.json"
    with path.open("w", encoding="utf-8") as handle:
        json.dump(project, handle, ensure_ascii=False)
    return path


def run_exporter(script: Path, *args: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script), *(str(arg) for arg in args)],
        capture_output=True,
        check=False,
        text=True,
    )


def find_subsequence(haystack: bytes, needle: bytes) -> int:
    return haystack.find(needle)


class MidiExporterTests(unittest.TestCase):
    def test_midi_exporter_outputs_valid_mthd_mtrk(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            project_path = write_project(tmp, make_minimal_project())
            output = tmp / "out.mid"
            completed = run_exporter(MIDI_EXPORTER, project_path, output)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            data = output.read_bytes()
            self.assertTrue(data.startswith(b"MThd"))
            # MThd length is 6; MThd chunk = 4 (type) + 4 (length) + 6 (data) = 14 bytes.
            self.assertEqual(struct.unpack(">I", data[4:8])[0], 6)
            # First MTrk chunk begins immediately after the 14-byte MThd chunk.
            self.assertEqual(find_subsequence(data, b"MTrk"), 14)
            # Count MTrk chunks: tempo track + main track.
            self.assertEqual(data.count(b"MTrk"), 2)

    def test_midi_exporter_writes_tempo_meta_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            project_path = write_project(tmp, make_minimal_project())
            output = tmp / "out.mid"
            run_exporter(MIDI_EXPORTER, project_path, output)
            data = output.read_bytes()
            self.assertGreaterEqual(find_subsequence(data, b"\xFF\x51\x03"), 0)

    def test_midi_exporter_writes_time_signature(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            project_path = write_project(tmp, make_minimal_project())
            output = tmp / "out.mid"
            run_exporter(MIDI_EXPORTER, project_path, output)
            data = output.read_bytes()
            self.assertGreaterEqual(find_subsequence(data, b"\xFF\x58\x04"), 0)

    def test_midi_exporter_writes_note_on_off(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            project_path = write_project(tmp, make_minimal_project())
            output = tmp / "out.mid"
            run_exporter(MIDI_EXPORTER, project_path, output)
            data = output.read_bytes()
            self.assertIn(b"\x90", data)  # note on channel 0
            self.assertIn(b"\x80", data)  # note off channel 0

    def test_midi_exporter_writes_lyric_meta_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            project_path = write_project(tmp, make_minimal_project())
            output = tmp / "out.mid"
            run_exporter(MIDI_EXPORTER, project_path, output)
            data = output.read_bytes()
            self.assertGreaterEqual(find_subsequence(data, b"\xFF\x05"), 0)
            self.assertIn("你".encode("utf-8"), data)
            self.assertIn("好".encode("utf-8"), data)

    def test_midi_exporter_ppq_is_960(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            project_path = write_project(tmp, make_minimal_project())
            output = tmp / "out.mid"
            run_exporter(MIDI_EXPORTER, project_path, output)
            data = output.read_bytes()
            # Header layout: MThd(4) + length(4) + format(2) + tracks(2) + division(2).
            division = struct.unpack(">H", data[12:14])[0]
            self.assertEqual(division, 960)

    def test_midi_exporter_loss_report_to_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            project_path = write_project(tmp, make_minimal_project())
            completed = run_exporter(MIDI_EXPORTER, project_path, "out.mid", "--loss-report")
            self.assertEqual(completed.returncode, 0)
            self.assertIn("confidence", completed.stderr)
            self.assertIn("language", completed.stderr)
            self.assertIn("syllable", completed.stderr)


class UstxExporterTests(unittest.TestCase):
    def _run_export(self, tmp: Path) -> Path:
        project_path = write_project(tmp, make_minimal_project())
        output = tmp / "out.ustx"
        completed = run_exporter(USTX_EXPORTER, project_path, output)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return output

    def _load_yaml(self, path: Path) -> dict:
        if not HAVE_YAML:
            self.skipTest("PyYAML not available")
        with path.open("r", encoding="utf-8") as handle:
            return yaml.safe_load(handle)

    def test_ustx_exporter_outputs_valid_yaml(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            output = self._run_export(tmp)
            text = output.read_text(encoding="utf-8")
            # Must NOT be JSON (no leading brace or bracket).
            self.assertFalse(text.lstrip().startswith(("{", "[")))
            data = self._load_yaml(output)
            self.assertIsInstance(data, dict)
            # Top-level USTX 0.7 fields must be present.
            for key in ("name", "ustx_version", "resolution", "tracks",
                        "voice_parts", "tempos", "time_signatures"):
                self.assertIn(key, data)

    def test_ustx_exporter_has_ustx_version_0_7(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            output = self._run_export(tmp)
            text = output.read_text(encoding="utf-8")
            # YAML text must contain the quoted 0.7 version string.
            self.assertIn('ustx_version: "0.7"', text)
            data = self._load_yaml(output)
            self.assertEqual(data["ustx_version"], "0.7")

    def test_ustx_exporter_has_resolution_480(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            output = self._run_export(tmp)
            text = output.read_text(encoding="utf-8")
            self.assertIn("resolution: 480", text)
            data = self._load_yaml(output)
            self.assertEqual(data["resolution"], 480)

    def test_ustx_exporter_notes_mapped_from_project_notes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            output = self._run_export(tmp)
            data = self._load_yaml(output)
            parts = data.get("voice_parts") or []
            self.assertEqual(len(parts), 1)
            notes = parts[0].get("notes") or []
            # Fixture has 2 master notes.
            self.assertEqual(len(notes), 2)
            # Project ticks are 0 and 960; USTX resolution 480 -> ticks / 2.
            self.assertEqual(notes[0]["position"], 0)
            self.assertEqual(notes[1]["position"], 480)
            # tone is integer MIDI pitch.
            self.assertEqual(notes[0]["tone"], 60)
            self.assertEqual(notes[1]["tone"], 62)
            # duration is (end_tick - start_tick) / 2 = 960 / 2 = 480.
            self.assertEqual(notes[0]["duration"], 480)

    def test_ustx_exporter_writes_track_and_voice_part(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            output = self._run_export(tmp)
            text = output.read_text(encoding="utf-8")
            self.assertIn("tracks:", text)
            self.assertIn("voice_parts:", text)
            self.assertIn("track_name:", text)
            self.assertIn("phonemizer:", text)
            data = self._load_yaml(output)
            self.assertEqual(len(data["tracks"]), 1)
            self.assertEqual(data["tracks"][0]["track_color"], "Blue")
            self.assertEqual(data["tracks"][0]["phonemizer"],
                             "OpenUtau.Core.DefaultPhonemizer")

    def test_ustx_exporter_writes_tempos_and_time_signatures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            output = self._run_export(tmp)
            text = output.read_text(encoding="utf-8")
            self.assertIn("tempos:", text)
            self.assertIn("time_signatures:", text)
            data = self._load_yaml(output)
            self.assertEqual(data["tempos"][0]["position"], 0)
            self.assertEqual(data["tempos"][0]["bpm"], 120.0)
            self.assertEqual(data["time_signatures"][0]["bar_position"], 0)
            self.assertEqual(data["time_signatures"][0]["beat_per_bar"], 4)
            self.assertEqual(data["time_signatures"][0]["beat_unit"], 4)

    def test_ustx_exporter_lyric_uses_syllable_reading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            output = self._run_export(tmp)
            data = self._load_yaml(output)
            notes = data["voice_parts"][0]["notes"]
            lyrics = [note["lyric"] for note in notes]
            # syllable-1 has reading_override "ni3" -> override wins over default.
            # syllable-2 has reading_override "" and default_reading "hao".
            self.assertIn("ni3", lyrics)
            self.assertIn("hao", lyrics)
            # Override must win over default for the note at position 0.
            note1 = next(n for n in notes if n["position"] == 0)
            self.assertEqual(note1["lyric"], "ni3")
            # Default reading path for the note at position 480.
            note2 = next(n for n in notes if n["position"] == 480)
            self.assertEqual(note2["lyric"], "hao")

    def test_ustx_exporter_loss_report_to_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            project_path = write_project(tmp, make_minimal_project())
            completed = run_exporter(USTX_EXPORTER, project_path, "out.ustx", "--loss-report")
            self.assertEqual(completed.returncode, 0)
            self.assertIn("confidence", completed.stderr)
            self.assertIn("source", completed.stderr)
            self.assertIn("velocity", completed.stderr)
            self.assertIn("stem_id", completed.stderr)
            self.assertIn("rests", completed.stderr)
            self.assertIn("source_audio", completed.stderr)


class SynthvSidecarExporterTests(unittest.TestCase):
    def test_synthv_sidecar_exporter_outputs_valid_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            project_path = write_project(tmp, make_minimal_project())
            output = tmp / "sidecar.json"
            completed = run_exporter(SYNTHV_SIDECAR_EXPORTER, project_path, output)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            data = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(data["schema_version"], "miku-synthv-sidecar/0.1.0")
            self.assertEqual(data["source_project_schema"], "miku-workbench-project/0.3.0")
            self.assertEqual(len(data["notes"]), 2)
            self.assertEqual(len(data["syllables"]), 2)
            self.assertEqual(len(data["rests"]), 1)
            self.assertIn("loss_report", data)


class SynthvHelperScriptTests(unittest.TestCase):
    def test_synthv_helper_script_declares_min_version_010900(self) -> None:
        text = SYNTHV_HELPER_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("0x010900", text)
        self.assertIn("minEditorVersion", text)

    def test_synthv_helper_script_is_es5_compliant(self) -> None:
        text = SYNTHV_HELPER_SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("=>", text)
        self.assertNotIn("`", text)
        self.assertNotIn("const ", text)
        self.assertNotIn("let ", text)

    def test_synthv_helper_script_does_not_use_ara_or_voice_to_midi(self) -> None:
        text = SYNTHV_HELPER_SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("ARA", text)
        self.assertNotIn("VoiceToMidi", text)
        self.assertNotIn("voice_to_midi", text)


class AllExportersEmptyProjectTests(unittest.TestCase):
    def test_all_exporters_handle_empty_project(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            empty = make_empty_project()
            project_path = write_project(tmp, empty)

            midi_out = tmp / "empty.mid"
            completed_midi = run_exporter(MIDI_EXPORTER, project_path, midi_out)
            self.assertEqual(completed_midi.returncode, 0, completed_midi.stderr)
            self.assertTrue(midi_out.exists())

            ustx_out = tmp / "empty.ustx"
            completed_ustx = run_exporter(USTX_EXPORTER, project_path, ustx_out)
            self.assertEqual(completed_ustx.returncode, 0, completed_ustx.stderr)
            ustx_text = ustx_out.read_text(encoding="utf-8")
            # Empty project still yields valid YAML with an empty notes list
            # inside the single voice part.
            if HAVE_YAML:
                ustx_data = yaml.safe_load(ustx_text)
                parts = ustx_data.get("voice_parts") or []
                self.assertEqual(len(parts), 1)
                self.assertEqual(parts[0].get("notes"), [])
            else:
                self.assertIn("voice_parts:", ustx_text)
                self.assertIn("notes: []", ustx_text)

            sidecar_out = tmp / "empty_sidecar.json"
            completed_side = run_exporter(SYNTHV_SIDECAR_EXPORTER, project_path, sidecar_out)
            self.assertEqual(completed_side.returncode, 0, completed_side.stderr)
            side = json.loads(sidecar_out.read_text(encoding="utf-8"))
            self.assertEqual(side["notes"], [])


if __name__ == "__main__":
    unittest.main()
