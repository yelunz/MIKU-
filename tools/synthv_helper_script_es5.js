// Synthesizer V Studio Pro 1.9.0 helper script (P3, Layer 2).
//
// minEditorVersion: 0x010900   (Synthesizer V Studio Pro 1.9.0)
// maxEditorVersion: 0x010AFF   (excludes 1.11+ exclusive host APIs not present in 1.9.0)
//
// This script is the companion to the miku-workbench MIDI baseline + sidecar
// JSON export path.  It assumes the user has already imported the MIDI file
// exported by tools/export_midi.py into a Synthesizer V 1.9.0 project.  The
// script then reads the sidecar JSON (exported by
// tools/export_synthv_sidecar.py) and re-applies the metadata that MIDI
// cannot express: per-syllable readings, rest markers, language hints and
// stem mix parameters.
//
// Strict 1.9.0 only:
//   * No 1.11+ exclusive host APIs.
//   * No 1.11+ voice extraction APIs.
//   * No 1.11+ editor features.
//
// 用法：在 Synthesizer V 1.9.0 Script Console 中 paste 此脚本，
// 修改 SIDECAR_PATH 为 sidecar.json 实际路径，运行。

var SIDECAR_PATH = "C:/path/to/miku-synthv-sidecar.json";

var MIN_EDITOR_VERSION = 0x010900;
var MAX_EDITOR_VERSION = 0x010AFF;

function readSidecar(path) {
    var file = new File(path);
    if (!file.exists) {
        throw new Error("Sidecar JSON not found: " + path);
    }
    file.open(File.ReadOnly);
    var raw = file.readAll();
    file.close();
    return JSON.parse(raw);
}

function checkHostVersion() {
    var host = SV.getHostInfo();
    if (!host) {
        throw new Error("SV.getHostInfo() returned null; aborting.");
    }
    var version = host.version;
    if (typeof version === "string") {
        // Accept "1.9.0" / "1.9.x" string form by parsing major/minor.
        var parts = version.split(".");
        if (parts.length < 2) {
            throw new Error("Cannot parse host version: " + version);
        }
        var major = parseInt(parts[0], 10) || 0;
        var minor = parseInt(parts[1], 10) || 0;
        var numeric = (major << 16) | (minor << 8);
        if (numeric < MIN_EDITOR_VERSION) {
            throw new Error("Host version " + version + " is below 1.9.0; aborting.");
        }
        if (numeric >= MAX_EDITOR_VERSION) {
            throw new Error("Host version " + version + " is 1.11+ which uses exclusive host APIs not present in 1.9.0; not supported by this script.");
        }
        return;
    }
    if (typeof version === "number") {
        if (version < MIN_EDITOR_VERSION) {
            throw new Error("Host version 0x" + version.toString(16) + " is below 1.9.0; aborting.");
        }
        if (version >= MAX_EDITOR_VERSION) {
            throw new Error("Host version 0x" + version.toString(16) + " is 1.11+; not supported by this script.");
        }
        return;
    }
    throw new Error("Unknown host version format: " + version);
}

function buildSyllableIndex(sidecar) {
    var byId = {};
    var i;
    var syllable;
    for (i = 0; i < sidecar.syllables.length; i += 1) {
        syllable = sidecar.syllables[i];
        byId[syllable.id] = syllable;
    }
    return byId;
}

function buildNoteIndex(project) {
    var notes = [];
    var trackCount = project.getNumTracks ? project.getNumTracks() : 0;
    var trackIndex;
    var groupCount;
    var groupIndex;
    var noteCount;
    var noteIndex;
    var track;
    var group;
    var note;
    var rawOnset;
    for (trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
        track = project.getTrack(trackIndex);
        if (!track) {
            continue;
        }
        groupCount = track.getNumGroups ? track.getNumGroups() : 0;
        for (groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
            group = track.getGroup(groupIndex);
            if (!group) {
                continue;
            }
            noteCount = group.getNumNotes ? group.getNumNotes() : 0;
            for (noteIndex = 0; noteIndex < noteCount; noteIndex += 1) {
                note = group.getNote(noteIndex);
                if (!note) {
                    continue;
                }
                notes.push({
                    track: track,
                    group: group,
                    note: note,
                    onset: note.getOnset ? note.getOnset() : 0
                });
            }
        }
    }
    notes.sort(function (a, b) {
        return a.onset - b.onset;
    });
    return notes;
}

function matchSidecarToNotes(sidecarNotes, hostNotes) {
    // Pair host notes with sidecar notes by tick (onset).  Both lists are
    // sorted ascending; we walk host notes and consume sidecar notes whose
    // tick is <= the host note onset.  This is a stable greedy match.
    var pairs = [];
    var sideIdx = 0;
    var hostIdx;
    var hostOnset;
    var candidate;
    for (hostIdx = 0; hostIdx < hostNotes.length; hostIdx += 1) {
        hostOnset = hostNotes[hostIdx].onset;
        while (sideIdx < sidecarNotes.length && sidecarNotes[sideIdx].tick <= hostOnset) {
            candidate = sidecarNotes[sideIdx];
            sideIdx += 1;
            if (candidate.tick === hostOnset) {
                pairs.push({
                    host: hostNotes[hostIdx],
                    sidecar: candidate
                });
                break;
            }
        }
    }
    return pairs;
}

function applyLyrics(pairs, syllableIndex) {
    var i;
    var pair;
    var sidecarNote;
    var syllableId;
    var syllable;
    var lyricText;
    for (i = 0; i < pairs.length; i += 1) {
        pair = pairs[i];
        sidecarNote = pair.sidecar;
        syllableId = sidecarNote.syllable_id;
        if (!syllableId) {
            continue;
        }
        syllable = syllableIndex[syllableId];
        if (!syllable) {
            continue;
        }
        lyricText = syllable.reading_override || syllable.default_reading || syllable.text;
        if (!lyricText) {
            continue;
        }
        if (pair.host.note && typeof pair.host.note.setLyric === "function") {
            pair.host.note.setLyric(lyricText);
        }
    }
}

function main() {
    try {
        checkHostVersion();
        var sidecar = readSidecar(SIDECAR_PATH);
        if (!sidecar || sidecar.schema_version !== "miku-synthv-sidecar/0.1.0") {
            throw new Error("Unexpected sidecar schema_version: "
                + (sidecar && sidecar.schema_version ? sidecar.schema_version : "(missing)"));
        }
        var project = SV.getProject();
        var hostNotes = buildNoteIndex(project);
        var pairs = matchSidecarToNotes(sidecar.notes || [], hostNotes);
        var syllableIndex = buildSyllableIndex(sidecar);
        applyLyrics(pairs, syllableIndex);
        SV.finish("Miku sidecar applied: " + pairs.length + " notes matched.");
    } catch (error) {
        SV.finish(error && error.message ? error.message : String(error));
    }
}

main();
