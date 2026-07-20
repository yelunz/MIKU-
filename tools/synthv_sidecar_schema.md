# Synthesizer V 1.9.0 Sidecar JSON Schema

This document describes the sidecar JSON file format produced by
`tools/export_synthv_sidecar.py` and consumed by
`tools/synthv_helper_script_es5.js`.

## Purpose

Synthesizer V Studio Pro 1.9.0 has no public stable native-format writer
for `.svp` project files.  The P3 adaptation path is Layer 2
(midi-plus-helper-script):

1. Export a standard MIDI file with `tools/export_midi.py` (notes, tempo,
   time signature, lyric meta events).
2. Export a sidecar JSON with `tools/export_synthv_sidecar.py`
   (all metadata MIDI cannot express).
3. Import the MIDI into a new Synthesizer V 1.9.0 project
   (`File > Import > MIDI`).
4. Open `Script > Script Console`, paste
   `tools/synthv_helper_script_es5.js`, edit `SIDECAR_PATH` to point at the
   sidecar JSON, and run.
5. The script matches host notes to sidecar notes by tick (onset) and
   re-applies per-syllable readings and other metadata.

## Schema version

```text
schema_version: "miku-synthv-sidecar/0.1.0"
source_project_schema: "miku-workbench-project/0.3.0"
```

## Top-level fields

| Field | Type | Description |
|---|---|---|
| `schema_version` | string | Always `"miku-synthv-sidecar/0.1.0"`. |
| `source_project_schema` | string | Always `"miku-workbench-project/0.3.0"`. |
| `tempo` | object | Tempo map snapshot used to compute ticks. |
| `time_signature` | object | Default 4/4. |
| `stem_tracks` | array | Copy of `editing.stem_tracks` from the neutral project (SynthV 1.9.0 has no scriptable trim/fade; kept for reference). |
| `notes` | array | Per-note metadata. |
| `syllables` | array | Per-syllable lyric/readings. |
| `rests` | array | Explicit rest events. |
| `loss_report` | object | Field loss notes for human review. |

## `tempo`

```json
{
  "bpm": 119.993,
  "ppq": 960,
  "first_beat_tick": 0,
  "first_beat_sample": 46560,
  "sample_rate_hz": 48000
}
```

## `time_signature`

```json
{
  "beat_per_bar": 4,
  "note_per_beat": 4
}
```

## `notes[]`

Each entry mirrors a neutral `NoteEvent` plus pre-computed tick information
for the helper script.

| Field | Type | Description |
|---|---|---|
| `id` | string | Neutral `NoteEvent.id` (e.g. `"note-1"`). |
| `stem_id` | string | `"master"`, `"drums"`, `"bass"` or `"other"`. |
| `tick` | int | Absolute MIDI tick of note onset (PPQ 960). |
| `duration` | int | Tick duration of the note. |
| `tone` | int | MIDI pitch (0..127). |
| `velocity` | float | Neutral 0..1 velocity (NOT yet mapped to MIDI 0..127). |
| `confidence` | float | Neutral confidence (0..1); kept in sidecar because SynthV has no per-note confidence field. |
| `source` | string | `"manual"`, `"transcription"` or `"generation"`. |
| `lyric_id` | string | Optional reference to a `LyricRegion.id`. |
| `syllable_id` | string | Optional reference to a `Syllable.id`. |

## `syllables[]`

Each entry mirrors a neutral `Syllable`.

| Field | Type | Description |
|---|---|---|
| `id` | string | `Syllable.id` (e.g. `"syllable-1"`). |
| `lyric_id` | string | Parent `LyricRegion.id`. |
| `index` | int | Index within the lyric region. |
| `text` | string | Original text (one Chinese char, one Japanese kana, etc.). |
| `default_reading` | string | Lookup result from the pinyin/kana-romaji table. |
| `reading_override` | string | User override (empty = use `default_reading`). |

## `rests[]`

| Field | Type | Description |
|---|---|---|
| `id` | string | `RestEvent.id`. |
| `tick` | int | Absolute MIDI tick of rest onset. |
| `duration` | int | Tick duration of the rest. |
| `kind` | string | Currently always `"rest"`. |

## `loss_report`

An object mapping lost-field names to human-readable explanations.  The
helper script does not consume this; it is purely for the user to
understand what the SynthV 1.9.0 adaptation cannot preserve.

## Helper script matching algorithm

The ES5 helper script performs a greedy tick-aligned match:

1. Collect all notes from the loaded Synthesizer V project, sorted by
   onset.
2. Sort sidecar `notes[]` by `tick`.
3. Walk host notes left-to-right; for each, consume sidecar notes whose
   `tick` is `<=` the host note onset, and pair on exact equality.
4. For each pair, look up `sidecarNote.syllable_id` in `syllables[]`;
   apply `reading_override` if non-empty, otherwise `default_reading`,
   otherwise `text`, to the host note's lyric via `note.setLyric(...)`.

The script does not modify the project's tempo, time signature or stem
mix parameters.  Tempo must be imported via the MIDI file; mix parameters
must be set by the user via the Synthesizer V UI.
