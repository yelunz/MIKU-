"use strict";

(() => {
  // 项目与分析 schema。当内部数据结构发生破坏性变化时，PROJECT_SCHEMA 递增；
  // 旧版本必须能在导入时显式迁移，避免静默覆盖用户工作。
  const PROJECT_SCHEMA = "miku-workbench-project/0.2.0";
  const PROJECT_SCHEMA_LEGACY = "miku-workbench-project/0.1.0";
  const ANALYSIS_SCHEMA = "0.1.0";
  const PPQ = 960;
  // sample 是音频定位的权威基准。当 sample 与 tick 出现数值漂移时以 sample 为准。
  const ANCHOR_TOLERANCE_SECONDS = 0.005;

  const bridge = globalThis.MikuDesktopBridge;
  const state = {
    analysis: null,
    duration: 0,
    sampleRateHz: 48000,
    tempoMap: null,
    anchors: new Map(),
    lyrics: [],
    rests: [],
    audioUrl: null,
    audioFileName: null,
    audioDuration: null,
    audioSha256: null,
    audioHashSkipped: false,
    selection: { start: 0, end: 0 },
    chordOverrides: {},
    selectedChordKey: null,
    selectedLyricId: null,
    selectedRestId: null,
    zoom: 16,
    snapMode: "half-beat",
    // P1.2 轮 3：附点与 Swing 扩展。附点把当前网格拉长 1.5 倍；
    // Swing 在偶数细分网格上把第二个半段延迟，比例 0..0.7。
    dottedSnap: false,
    swingAmount: 0,
    continuousLyrics: true,
    layers: { waveform: true, energy: true, beats: true, sections: true, chords: true },
    dragging: null,
    handleDragging: null,
    edgeDragging: null,
    nextLyricId: 1,
    nextRestId: 1,
    nextAnchorId: 1,
    // 歌词块整体拖动/拉伸状态。拖动阈值超过 4 像素才进入拖动模式，
    // 否则保留原点击行为（进入编辑器）。
    lyricDrag: null,
    // 字段级锁定：防止未来重生成覆盖用户手工确认的字段。
    // 格式 "lyric:lyric-1" / "rest:rest-1" / "chord:<chordKey>"。
    lockedFields: new Set(),
    // 用户最近一次手动滚动时间戳。播放头自动跟随在用户滚动后暂停 1.5 秒，
    // 避免抢走用户的主动定位。
    manualScrollAt: 0,
    // 程序触发的滚动标记。autoScrollToPlayhead 修改 scrollLeft 时设为 true，
    // scroll 事件据此区分"程序滚动"与"用户滚动"。
    programmaticScroll: false,
    // 多轨 stem 轨数据模型（P1.2 轮 1）。
    // 第一版采用非破坏编辑：原始音频永不覆盖；mute/solo/gain/pan 只保存参数。
    // master stem 关联主 audio 元素，gain/pan/mute/solo 通过 Web Audio API 真实生效；
    // drums/bass/other 是占位 stem（无分离音频），只保存参数与展示 UI，
    // 等 Demucs 等音源分离后端接入后才会真实播放。
    stemTracks: defaultStemTracks(),
    // P1.2 轮 4：A/B 试听模式。"edited" 应用 trim/fade 等非破坏参数；
    // "original" 忽略所有非破坏参数（仍保留 gain/pan/mute/solo）。
    // 没有真实重合成后端，"original" 等同于"忽略非破坏混音参数的原始音频"。
    stemPreviewMode: "edited",
    // NoteEvent 数据模型（P1.2 轮 2）：可编辑的音符候选。
    // 每个音符引用 start/end anchor（与歌词/休止共享时间模型），
    // 浮点 MIDI pitch（60 = C4），velocity 0..1，confidence 0..1，
    // source 标注来源（manual / transcription / generation）。
    // 第一版没有真实转录后端，所有音符都是用户手工创建或后续从 Basic Pitch 等后端导入。
    notes: [],
    nextNoteId: 1,
    selectedNoteId: null,
    // 钢琴卷帘拖动状态：{ noteId, mode, startClientX, startClientY, startStartSample, startEndSample, startPitch, beganEdit, detachedStart, detachedEnd }
    noteDrag: null,
    // 钢琴卷帘当前选中的 stem 轨（决定新音符创建在哪个 stem）。
    pianoRollStemId: "master",
    // 钢琴卷帘选中用于合并的第二个音符（按住 Shift 点击选中第二个 → 合并按钮可用）。
    pianoRollMergeCandidateId: null,
  };

  // 音高范围：C2 (36) .. C7 (96)，共 60 个半音。第一版用此固定范围。
  const PIANO_ROLL_MIN_PITCH = 36;
  const PIANO_ROLL_MAX_PITCH = 96;
  const PIANO_ROLL_ROW_HEIGHT = 14; // px

  function midiToNoteName(midi) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const octave = Math.floor(midi / 12) - 1;
    return `${names[((midi % 12) + 12) % 12]}${octave}`;
  }

  function isBlackKey(midi) {
    const within = ((midi % 12) + 12) % 12;
    return within === 1 || within === 3 || within === 6 || within === 8 || within === 10;
  }

  function defaultStemTracks() {
    return [
      { id: "master", name: "伴奏总览", role: "master", mute: false, solo: false, gain: 1.0, pan: 0, source: "main",
        // P1.2 轮 4：非破坏混音参数。trim 是首尾裁切秒数；fade 是淡入淡出秒数。
        // master stem 真实生效（通过 audioGraph 与 timeupdate 监听）；占位 stem 只保存参数。
        trimStartSeconds: 0, trimEndSeconds: 0, fadeInSeconds: 0, fadeOutSeconds: 0 },
      { id: "drums", name: "鼓组", role: "drums", mute: false, solo: false, gain: 1.0, pan: 0, source: "placeholder",
        trimStartSeconds: 0, trimEndSeconds: 0, fadeInSeconds: 0, fadeOutSeconds: 0 },
      { id: "bass", name: "贝斯", role: "bass", mute: false, solo: false, gain: 1.0, pan: 0, source: "placeholder",
        trimStartSeconds: 0, trimEndSeconds: 0, fadeInSeconds: 0, fadeOutSeconds: 0 },
      { id: "other", name: "其他乐器", role: "other", mute: false, solo: false, gain: 1.0, pan: 0, source: "placeholder",
        trimStartSeconds: 0, trimEndSeconds: 0, fadeInSeconds: 0, fadeOutSeconds: 0 },
    ];
  }

  // Web Audio API 节点图：第一版只为 master stem 真实生效 gain/pan/mute/solo。
  // createMediaElementSource 一旦调用就不能撤销，所以 setup 只执行一次；
  // 失败时降级到 audio.volume（只能控制 master gain，pan 不生效）。
  const audioGraph = {
    context: null,
    source: null,
    masterGain: null,
    masterPanner: null,
    ready: false,
  };

  function setupAudioGraph() {
    if (audioGraph.ready) return;
    if (!state.audioUrl) return;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      audioGraph.context = new Ctor();
      audioGraph.source = audioGraph.context.createMediaElementSource(elements.audio);
      audioGraph.masterGain = audioGraph.context.createGain();
      audioGraph.masterPanner = audioGraph.context.createStereoPanner();
      audioGraph.source.connect(audioGraph.masterGain);
      audioGraph.masterGain.connect(audioGraph.masterPanner);
      audioGraph.masterPanner.connect(audioGraph.context.destination);
      audioGraph.ready = true;
    } catch (error) {
      audioGraph.ready = false;
      setStatus(`Web Audio API 初始化失败，降级到音量控制：${error.message}`, "error");
    }
  }

  function resumeAudioContext() {
    if (audioGraph.ready && audioGraph.context && audioGraph.context.state === "suspended") {
      audioGraph.context.resume().catch(() => { /* 静默；下次手势再试 */ });
    }
  }

  // 计算每个 stem 的实际播放状态（用于 UI 显示与混音）。
  //   - 若有任意 stem solo：只 solo 的 stem 发声，其他静音；
  //   - 否则：所有未 mute 的 stem 发声。
  function stemEffectiveState(track) {
    const anySolo = state.stemTracks.some(item => item.solo);
    const muted = track.mute || (anySolo && !track.solo);
    return {
      muted,
      effectiveGain: muted ? 0 : clamp(track.gain, 0, 1.5),
      effectivePan: clamp(track.pan, -1, 1),
    };
  }

  function applyStemMix() {
    if (!state.stemTracks.length) return;
    const master = state.stemTracks.find(track => track.id === "master");
    if (!master) return;
    const { effectiveGain, effectivePan } = stemEffectiveState(master);
    if (audioGraph.ready) {
      audioGraph.masterGain.gain.value = effectiveGain;
      audioGraph.masterPanner.pan.value = effectivePan;
    } else {
      // 降级：HTMLAudioElement.volume 范围是 0..1，pan 不生效。
      elements.audio.volume = clamp(effectiveGain, 0, 1);
    }
    // 占位 stem 没有 audio 节点；UI 在 renderStemMixer 中反映状态。
  }

  // P1.2 轮 4：非破坏混音参数。master stem 真实生效 trim/fade。
  //   - trim：播放开始时跳到 trimStartSeconds；到达 trimEndSeconds 时停止（timeupdate 监听）
  //   - fade：用 masterGain 的 linearRampToValueAtTime 在播放头进入淡入/淡出区间时构造包络
  // "original" 模式忽略所有非破坏参数（只保留 gain/pan/mute/solo）。
  function stemEffectiveTrimRange(track) {
    if (state.stemPreviewMode === "original") return { start: 0, end: state.duration };
    const trimStart = clamp(finiteNumber(track.trimStartSeconds, 0), 0, Math.max(0, state.duration));
    const trimEndRaw = clamp(finiteNumber(track.trimEndSeconds, 0), 0, Math.max(0, state.duration));
    const trimEnd = trimEndRaw > 0 ? Math.max(trimStart + 0.01, trimEndRaw) : state.duration;
    return { start: trimStart, end: Math.min(trimEnd, state.duration) };
  }

  function stemEffectiveFade(track) {
    if (state.stemPreviewMode === "original") return { fadeIn: 0, fadeOut: 0 };
    return {
      fadeIn: Math.max(0, finiteNumber(track.fadeInSeconds, 0)),
      fadeOut: Math.max(0, finiteNumber(track.fadeOutSeconds, 0)),
    };
  }

  // 在播放开始 / seek / timeupdate 时调用，更新 masterGain 包络。
  function applyMasterFadeEnvelope() {
    if (!audioGraph.ready || !audioGraph.context) return;
    const master = state.stemTracks.find(track => track.id === "master");
    if (!master) return;
    const { effectiveGain } = stemEffectiveState(master);
    const { start, end } = stemEffectiveTrimRange(master);
    const { fadeIn, fadeOut } = stemEffectiveFade(master);
    const current = elements.audio.currentTime;
    const ctx = audioGraph.context;
    const gainParam = audioGraph.masterGain.gain;
    gainParam.cancelScheduledValues(ctx.currentTime);
    // 不在 trim 范围内 → 静音
    if (current < start - 0.001 || current > end + 0.001) {
      gainParam.setValueAtTime(0, ctx.currentTime);
      return;
    }
    // 淡入：从 start 到 start + fadeIn，gain 从 0 线性升到 effectiveGain
    if (fadeIn > 0 && current < start + fadeIn) {
      gainParam.setValueAtTime(0, ctx.currentTime);
      gainParam.linearRampToValueAtTime(effectiveGain, ctx.currentTime + Math.max(0.001, start + fadeIn - current));
    } else {
      gainParam.setValueAtTime(effectiveGain, ctx.currentTime);
    }
    // 淡出：从 end - fadeOut 到 end，gain 从 effectiveGain 线性降到 0
    if (fadeOut > 0 && current < end && current < end - 0.001) {
      const fadeOutStart = Math.max(current, end - fadeOut);
      if (fadeOutStart < end) {
        gainParam.setValueAtTime(effectiveGain, ctx.currentTime + Math.max(0, fadeOutStart - current));
        gainParam.linearRampToValueAtTime(0, ctx.currentTime + Math.max(0.001, end - current));
      }
    }
  }

  // 播放头进入 trim 范围外时停止播放（timeupdate 监听调用）。
  function enforceMasterTrimBoundary() {
    if (state.stemPreviewMode === "original") return;
    const master = state.stemTracks.find(track => track.id === "master");
    if (!master) return;
    const { start, end } = stemEffectiveTrimRange(master);
    const current = elements.audio.currentTime;
    if (current < start - 0.01) {
      elements.audio.currentTime = start;
    } else if (current > end + 0.05) {
      elements.audio.pause();
      elements.audio.currentTime = end;
    }
  }

  // ---- EditGraph：撤销/重做栈（第一版）-----------------------------------------
  // 设计原则：
  // - 每次会改变 anchors / lyrics / rests / chordOverrides / selection 的"用户操作"
  //   在执行前调用 editGraph.begin(label) 保存当前状态快照。
  // - 撤销 = 把当前状态推入 redo 栈，弹出 undo 栈顶恢复。
  // - 新操作清空 redo 栈（与常见编辑器一致）。
  // - 快照限制 50 条防止内存爆炸；超出后丢弃最旧。
  // - 快照只保存可编辑数据，不保存 audioUrl / analysis 等不可变状态。
  const editGraph = {
    undoStack: [],
    redoStack: [],
    maxSize: 50,

    snapshot() {
      return {
        anchors: Array.from(state.anchors.values()).map(anchor => ({ ...anchor })),
        lyrics: state.lyrics.map(region => ({ ...region })),
        rests: state.rests.map(rest => ({ ...rest })),
        chordOverrides: JSON.parse(JSON.stringify(state.chordOverrides)),
        selection: { ...state.selection },
        selectedLyricId: state.selectedLyricId,
        selectedRestId: state.selectedRestId,
        nextLyricId: state.nextLyricId,
        nextRestId: state.nextRestId,
        nextAnchorId: state.nextAnchorId,
        // 锁定状态也是用户编辑的一部分，撤销/重做时需要一起恢复。
        lockedFields: Array.from(state.lockedFields),
        // stem 轨混音参数也是用户编辑的一部分，撤销/重做时一并恢复。
        stemTracks: state.stemTracks.map(track => ({ ...track })),
        // P1.2 轮 4：试听模式（edited / original）也随快照保存。
        stemPreviewMode: state.stemPreviewMode,
        // 音符候选也是用户编辑的一部分，撤销/重做时一并恢复（P1.2 轮 2 起）。
        notes: state.notes.map(note => ({ ...note })),
        nextNoteId: state.nextNoteId,
      };
    },

    restore(snapshot) {
      state.anchors = new Map(snapshot.anchors.map(anchor => [anchor.id, { ...anchor }]));
      state.lyrics = snapshot.lyrics.map(region => ({ ...region }));
      state.rests = snapshot.rests.map(rest => ({ ...rest }));
      state.chordOverrides = JSON.parse(JSON.stringify(snapshot.chordOverrides));
      state.selection = { ...snapshot.selection };
      state.selectedLyricId = snapshot.selectedLyricId;
      state.selectedRestId = snapshot.selectedRestId;
      state.nextLyricId = snapshot.nextLyricId;
      state.nextRestId = snapshot.nextRestId;
      state.nextAnchorId = snapshot.nextAnchorId;
      state.lockedFields = new Set(Array.isArray(snapshot.lockedFields) ? snapshot.lockedFields : []);
      // stem 轨可能在旧版快照中不存在（向前兼容），缺失时保留默认 stem。
      state.stemTracks = Array.isArray(snapshot.stemTracks) && snapshot.stemTracks.length
        ? snapshot.stemTracks.map(track => ({
          ...track,
          // P1.2 轮 4：旧版快照可能没有 trim/fade 字段，缺失时回退到 0。
          trimStartSeconds: Number.isFinite(track.trimStartSeconds) ? track.trimStartSeconds : 0,
          trimEndSeconds: Number.isFinite(track.trimEndSeconds) ? track.trimEndSeconds : 0,
          fadeInSeconds: Number.isFinite(track.fadeInSeconds) ? track.fadeInSeconds : 0,
          fadeOutSeconds: Number.isFinite(track.fadeOutSeconds) ? track.fadeOutSeconds : 0,
        }))
        : defaultStemTracks();
      state.stemPreviewMode = snapshot.stemPreviewMode === "original" ? "original" : "edited";
      // 音符候选可能在旧版快照中不存在（P1.2 轮 2 之前），缺失时清空。
      state.notes = Array.isArray(snapshot.notes) ? snapshot.notes.map(note => ({ ...note })) : [];
      state.nextNoteId = Number.isFinite(snapshot.nextNoteId) ? snapshot.nextNoteId : 1;
      state.selectedNoteId = null;
      state.noteDrag = null;
      state.pianoRollMergeCandidateId = null;
      // 恢复后清除选中编辑器视图，避免引用已不存在的 region
      elements.lyricText.value = "";
      elements.lyricLanguage.value = "zh";
      elements.cancelLyricEditButton.hidden = true;
      elements.deleteLyricButton.hidden = true;
      elements.chordInspector.hidden = true;
      elements.restInspector.hidden = true;
      elements.selectionStart.value = state.selection.start.toFixed(3);
      elements.selectionEnd.value = state.selection.end.toFixed(3);
    },

    begin(label) {
      this.undoStack.push({ label, snapshot: this.snapshot() });
      if (this.undoStack.length > this.maxSize) this.undoStack.shift();
      this.redoStack = [];
      updateUndoRedoButtons();
    },

    undo() {
      if (!this.undoStack.length) return false;
      const entry = this.undoStack.pop();
      this.redoStack.push({ label: entry.label, snapshot: this.snapshot() });
      this.restore(entry.snapshot);
      updateUndoRedoButtons();
      setStatus(`已撤销：${entry.label}。`, "success");
      return true;
    },

    redo() {
      if (!this.redoStack.length) return false;
      const entry = this.redoStack.pop();
      this.undoStack.push({ label: entry.label, snapshot: this.snapshot() });
      this.restore(entry.snapshot);
      updateUndoRedoButtons();
      setStatus(`已重做：${entry.label}。`, "success");
      return true;
    },

    canUndo() { return this.undoStack.length > 0; },
    canRedo() { return this.redoStack.length > 0; },
  };

  function updateUndoRedoButtons() {
    if (elements.undoButton) {
      elements.undoButton.disabled = !editGraph.canUndo();
      elements.undoButton.title = editGraph.canUndo() ? `撤销（Ctrl+Z）· ${editGraph.undoStack.length} 步可回退` : "无可撤销操作";
    }
    if (elements.redoButton) {
      elements.redoButton.disabled = !editGraph.canRedo();
      elements.redoButton.title = editGraph.canRedo() ? `重做（Ctrl+Shift+Z）· ${editGraph.redoStack.length} 步可重做` : "无可重做操作";
    }
  }

  const byId = id => document.getElementById(id);
  const elements = {
    analysisFile: byId("analysis-file"),
    audioFile: byId("audio-file"),
    projectFile: byId("project-file"),
    importProjectButton: byId("import-project-button"),
    exportProjectButton: byId("export-project-button"),
    status: byId("status"),
    workbench: byId("workbench"),
    audio: byId("audio-player"),
    playButton: byId("play-button"),
    stopButton: byId("stop-button"),
    playTime: byId("play-time"),
    audioName: byId("audio-name"),
    zoomRange: byId("zoom-range"),
    snapGrid: byId("snap-grid"),
    dottedSnap: byId("dotted-snap"),
    swingAmount: byId("swing-amount"),
    continuousLyrics: byId("continuous-lyrics"),
    timelineScroll: byId("timeline-scroll"),
    timelineContent: byId("timeline-content"),
    ruler: byId("ruler"),
    sectionsLane: byId("sections-lane"),
    chordsLane: byId("chords-lane"),
    waveformLane: byId("waveform-lane"),
    canvas: byId("timeline-canvas"),
    selectionOverlay: byId("selection-overlay"),
    selectionStartHandle: byId("selection-start-handle"),
    selectionEndHandle: byId("selection-end-handle"),
    playhead: byId("playhead"),
    lyricsLane: byId("lyrics-lane"),
    lyricsEmpty: byId("lyrics-empty"),
    selectionSummary: byId("selection-summary"),
    selectionStart: byId("selection-start"),
    selectionEnd: byId("selection-end"),
    lyricLanguage: byId("lyric-language"),
    lyricText: byId("lyric-text"),
    saveLyricButton: byId("save-lyric-button"),
    cancelLyricEditButton: byId("cancel-lyric-edit-button"),
    deleteLyricButton: byId("delete-lyric-button"),
    convertRestButton: byId("convert-rest-button"),
    deleteRestButton: byId("delete-rest-button"),
    restInspector: byId("rest-inspector"),
    restDetail: byId("rest-detail"),
    chordInspector: byId("chord-inspector"),
    chordDetail: byId("chord-detail"),
    chordLabel: byId("chord-label"),
    saveChordButton: byId("save-chord-button"),
    restoreChordButton: byId("restore-chord-button"),
    undoButton: byId("undo-button"),
    redoButton: byId("redo-button"),
    exactData: byId("exact-data"),
    lockLyricWrapper: byId("lock-lyric-wrapper"),
    lockLyricCheckbox: byId("lock-lyric-checkbox"),
    lockChordWrapper: byId("lock-chord-wrapper"),
    lockChordCheckbox: byId("lock-chord-checkbox"),
    lockRestWrapper: byId("lock-rest-wrapper"),
    lockRestCheckbox: byId("lock-rest-checkbox"),
    stemMixer: byId("stem-mixer"),
    // P1.2 轮 4：A/B 试听模式切换控件（edited / original）。
    stemPreviewMode: byId("stem-preview-mode"),
    pianoRollScroll: byId("piano-roll-scroll"),
    pianoRollContent: byId("piano-roll-content"),
    pianoRollCanvas: byId("piano-roll-canvas"),
    pianoRollGrid: byId("piano-roll-grid"),
    pianoRollStemSelect: byId("piano-roll-stem-select"),
    splitNoteButton: byId("split-note-button"),
    mergeNoteButton: byId("merge-note-button"),
    quantizeNoteButton: byId("quantize-note-button"),
    deleteNoteButton: byId("delete-note-button"),
  };

  function setStatus(message, kind = "") {
    elements.status.textContent = message;
    elements.status.className = `status${kind ? ` ${kind}` : ""}`;
  }

  function finiteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function formatTime(seconds) {
    const safe = Math.max(0, finiteNumber(seconds));
    const minutes = Math.floor(safe / 60);
    const remainder = safe - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
  }

  // ---- 时间模型：TempoMap + Anchor ---------------------------------------------

  function buildTempoMap(analysis) {
    const sampleRateHz = finiteNumber(
      analysis && analysis.source_audio && analysis.source_audio.sample_rate_hz,
      48000
    );
    if (!(sampleRateHz > 0)) throw new Error("分析 JSON 缺少有效的采样率。");
    const tempo = analysis.analysis.tempo && analysis.analysis.tempo.candidates && analysis.analysis.tempo.candidates[0];
    if (!tempo || !finiteNumber(tempo.bpm) || tempo.bpm <= 0) throw new Error("分析 JSON 缺少有效的速度候选。");
    const bpm = finiteNumber(tempo.bpm);
    const firstBeatSeconds = finiteNumber(tempo.first_beat_seconds);
    const firstBeatSample = Math.round(firstBeatSeconds * sampleRateHz);
    const firstBeatTick = 0;
    const ticksPerSecond = (bpm / 60) * PPQ;
    const samplesPerTick = sampleRateHz / ticksPerSecond;
    return {
      sampleRateHz,
      ppq: PPQ,
      bpm,
      firstBeatSeconds,
      firstBeatSample,
      firstBeatTick,
      ticksPerSecond,
      samplesPerTick,
    };
  }

  function sampleToTick(sample) {
    const map = state.tempoMap;
    if (!map) return 0;
    return Math.round(map.firstBeatTick + ((sample - map.firstBeatSample) / map.sampleRateHz) * map.ticksPerSecond);
  }

  function tickToSample(tick) {
    const map = state.tempoMap;
    if (!map) return 0;
    return map.firstBeatSample + ((tick - map.firstBeatTick) / map.ticksPerSecond) * map.sampleRateHz;
  }

  function sampleToSeconds(sample) {
    return sample / state.sampleRateHz;
  }

  function secondsToSample(seconds) {
    return Math.round(seconds * state.sampleRateHz);
  }

  function createAnchorAtSample(sample) {
    const safeSample = Math.max(0, Math.min(Math.round(sample), Math.round(state.duration * state.sampleRateHz)));
    let identifier;
    do {
      identifier = `anchor-${state.nextAnchorId++}`;
    } while (state.anchors.has(identifier));
    const anchor = { id: identifier, sample: safeSample, tick: sampleToTick(safeSample) };
    state.anchors.set(identifier, anchor);
    return anchor;
  }

  function findAnchorBySample(sample, toleranceSeconds = ANCHOR_TOLERANCE_SECONDS) {
    const target = Math.round(sample);
    const toleranceSamples = Math.max(1, Math.round(toleranceSeconds * state.sampleRateHz));
    let closest = null;
    let closestDelta = Infinity;
    for (const anchor of state.anchors.values()) {
      const delta = Math.abs(anchor.sample - target);
      if (delta <= toleranceSamples && delta < closestDelta) {
        closest = anchor;
        closestDelta = delta;
      }
    }
    return closest;
  }

  function moveAnchor(anchorId, sample) {
    const anchor = state.anchors.get(anchorId);
    if (!anchor) return;
    const safeSample = Math.max(0, Math.min(Math.round(sample), Math.round(state.duration * state.sampleRateHz)));
    anchor.sample = safeSample;
    anchor.tick = sampleToTick(safeSample);
  }

  function anchorStartSeconds(region) {
    const anchor = state.anchors.get(region.startAnchorId);
    return anchor ? sampleToSeconds(anchor.sample) : 0;
  }

  function anchorEndSeconds(region) {
    const anchor = state.anchors.get(region.endAnchorId);
    return anchor ? sampleToSeconds(anchor.sample) : 0;
  }

  function anchorStartSample(region) {
    const anchor = state.anchors.get(region.startAnchorId);
    return anchor ? anchor.sample : 0;
  }

  function anchorEndSample(region) {
    const anchor = state.anchors.get(region.endAnchorId);
    return anchor ? anchor.sample : 0;
  }

  // 删除未被任何 lyric/rest 引用的 anchor，避免 anchor 表无限增长。
  function pruneAnchors() {
    const referenced = new Set();
    state.lyrics.forEach(region => {
      referenced.add(region.startAnchorId);
      referenced.add(region.endAnchorId);
    });
    state.rests.forEach(rest => {
      referenced.add(rest.startAnchorId);
      referenced.add(rest.endAnchorId);
    });
    for (const id of Array.from(state.anchors.keys())) {
      if (!referenced.has(id)) state.anchors.delete(id);
    }
  }

  // ---- 字段级锁定 -------------------------------------------------------------
  // 设计：
  //   - 锁定 key 形如 "lyric:lyric-1" / "rest:rest-1" / "chord:<chordKey>"
  //   - 用户主动操作（编辑、删除、解锁）始终允许；锁定只阻止"自动重生成"覆盖。
  //   - 当前阶段没有自动重生成，锁定主要承担两件事：
  //     1) UI 高亮显示用户已确认的字段；
  //     2) 在删除/恢复原值等会丢失用户确认结果的操作前提示先解锁。
  //   - 锁定状态随 editGraph 快照保存，撤销/重做时一并恢复。
  function lockKey(type, id) {
    return `${type}:${id}`;
  }

  function isLocked(type, id) {
    return state.lockedFields.has(lockKey(type, id));
  }

  function setLocked(type, id, locked) {
    const key = lockKey(type, id);
    if (locked) state.lockedFields.add(key);
    else state.lockedFields.delete(key);
  }

  function serializeLockedFields() {
    return Array.from(state.lockedFields).sort();
  }

  function refreshLockToggle(wrapper, checkbox, type, id) {
    if (!wrapper || !checkbox) return;
    if (!id) {
      wrapper.hidden = true;
      checkbox.checked = false;
      return;
    }
    wrapper.hidden = false;
    checkbox.checked = isLocked(type, id);
  }

  // ---- 选区与吸附 --------------------------------------------------------------

  function topTempoCandidate() {
    return state.analysis && state.analysis.analysis.tempo.candidates[0] || null;
  }

  function snapIntervalSeconds() {
    const tempo = topTempoCandidate();
    if (!tempo || state.snapMode === "none") return 0;
    const beat = 60 / finiteNumber(tempo.bpm, 120);
    let interval;
    switch (state.snapMode) {
      case "quarter-beat": interval = beat / 4; break;
      case "eighth-beat": interval = beat / 8; break;
      case "triplet-half": interval = beat / 3; break;       // 1/3 拍 = 三连音半拍
      case "triplet-quarter": interval = beat / 6; break;    // 1/6 拍 = 三连音四分拍
      case "half-beat": interval = beat / 2; break;
      case "beat":
      default: interval = beat; break;
    }
    // 附点：网格拉长 1.5 倍（仅在非三连音网格上有意义，但允许在所有网格上叠加）
    if (state.dottedSnap && state.snapMode !== "triplet-half" && state.snapMode !== "triplet-quarter") {
      interval = interval * 1.5;
    }
    return interval;
  }

  // Swing 偏移：在偶数细分网格上，把每个网格的"后半段"边界向后推 swingAmount * (interval/2)。
  // 奇数段（第 0/2/4... 个网格）起点保持原位，偶数段起点被延迟。
  // 三连音网格不应用 swing（三连音本身已是奇分，swing 概念不适用）。
  function swingOffsetForIndex(gridIndex, interval) {
    if (!state.swingAmount || interval <= 0) return 0;
    if (state.snapMode === "triplet-half" || state.snapMode === "triplet-quarter") return 0;
    if (state.snapMode === "beat") return 0; // 整拍网格上 swing 无可推点位
    if (gridIndex % 2 === 0) return 0;       // 前半段不动
    return state.swingAmount * (interval / 2);
  }

  function snapTime(seconds, bypass = false) {
    const interval = snapIntervalSeconds();
    if (!interval || bypass) return clamp(seconds, 0, state.duration);
    if (seconds <= interval / 2) return 0;
    if (state.duration - seconds <= interval / 2) return state.duration;
    const tempo = topTempoCandidate();
    const origin = finiteNumber(tempo.first_beat_seconds);
    const rawIndex = Math.round((seconds - origin) / interval);
    // 在 swing 网格上，需要比较"加 swing 偏移后的网格点"与"原始偶数段边界"两个候选，取最近者
    const candidateEven = origin + rawIndex * interval;            // 不带 swing 的常规网格点
    const oddIndex = rawIndex - (rawIndex % 2 === 0 ? 0 : 1) + 1;  // 落在后半段的候选奇数网格点
    const candidateOdd = origin + oddIndex * interval + swingOffsetForIndex(oddIndex, interval);
    const candidates = [candidateEven];
    if (oddIndex !== rawIndex && candidateOdd !== candidateEven) candidates.push(candidateOdd);
    let best = candidates[0];
    let bestDist = Math.abs(seconds - best);
    for (let i = 1; i < candidates.length; i++) {
      const d = Math.abs(seconds - candidates[i]);
      if (d < bestDist) { best = candidates[i]; bestDist = d; }
    }
    return clamp(Number(best.toFixed(6)), 0, state.duration);
  }

  // 量化函数（P1.2 轮 3）：把任意 sample 对齐到当前网格。
  // 用于钢琴卷帘拖动结束后强制对齐，以及将选区转换为歌词/休止时的边界吸附。
  function quantizeSample(sample) {
    const interval = snapIntervalSeconds();
    if (!interval || !state.sampleRateHz) return sample;
    const seconds = sample / state.sampleRateHz;
    const snapped = snapTime(seconds);
    return Math.round(snapped * state.sampleRateHz);
  }

  // ---- 分析 JSON 校验 ----------------------------------------------------------

  function validateAnalysis(candidate) {
    if (!candidate || typeof candidate !== "object") throw new Error("分析 JSON 顶层必须是对象。");
    if (candidate.schema_version !== ANALYSIS_SCHEMA) {
      throw new Error(`不支持的分析版本：${String(candidate.schema_version || "缺失")}；当前只接受 ${ANALYSIS_SCHEMA}。`);
    }
    const duration = Number(candidate.source_audio && candidate.source_audio.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("分析 JSON 缺少有效的音频时长。");
    const analysis = candidate.analysis;
    if (!analysis || typeof analysis !== "object") throw new Error("分析 JSON 缺少 analysis 对象。");
    const requiredArrays = [
      ["waveform", "bins"],
      ["short_time_energy", "bins"],
      ["tempo", "candidates"],
      ["key", "candidates"],
      ["chords", "windows"],
      ["sections", "boundaries"],
      ["sections", "regions"],
    ];
    requiredArrays.forEach(([layerName, fieldName]) => {
      const layer = analysis[layerName];
      if (!layer || typeof layer !== "object" || !Array.isArray(layer[fieldName])) {
        throw new Error(`分析 JSON 缺少 ${layerName}.${fieldName} 数组。`);
      }
    });
    const isFiniteNumber = value => typeof value === "number" && Number.isFinite(value);
    const validateInterval = (item, label, allowZeroLength = false) => {
      if (!item || typeof item !== "object" || !isFiniteNumber(item.start_seconds) || !isFiniteNumber(item.end_seconds)) {
        throw new Error(`${label} 包含无效时间。`);
      }
      if (item.start_seconds < 0 || item.end_seconds > duration + 1e-6 || (allowZeroLength ? item.end_seconds < item.start_seconds : item.end_seconds <= item.start_seconds)) {
        throw new Error(`${label} 的时间超出音频范围或顺序错误。`);
      }
    };
    analysis.waveform.bins.forEach((bin, index) => {
      validateInterval(bin, `waveform.bins[${index}]`);
      ["minimum", "maximum", "rms"].forEach(field => {
        if (!isFiniteNumber(bin[field])) throw new Error(`waveform.bins[${index}].${field} 不是有限数。`);
      });
    });
    analysis.short_time_energy.bins.forEach((bin, index) => {
      validateInterval(bin, `short_time_energy.bins[${index}]`);
      if (!isFiniteNumber(bin.rms) || !isFiniteNumber(bin.rms_dbfs)) throw new Error(`short_time_energy.bins[${index}] 含无效能量。`);
    });
    analysis.tempo.candidates.forEach((candidateItem, index) => {
      if (!candidateItem || !isFiniteNumber(candidateItem.bpm) || candidateItem.bpm <= 0 || candidateItem.bpm > 1000 ||
          !isFiniteNumber(candidateItem.first_beat_seconds) || candidateItem.first_beat_seconds < 0 || candidateItem.first_beat_seconds > duration) {
        throw new Error(`tempo.candidates[${index}] 无效。`);
      }
    });
    analysis.key.candidates.forEach((candidateItem, index) => {
      if (!candidateItem || typeof candidateItem.label !== "string" || !candidateItem.label.trim()) throw new Error(`key.candidates[${index}] 无效。`);
    });
    analysis.chords.windows.forEach((window, index) => {
      validateInterval(window, `chords.windows[${index}]`);
      if (!Array.isArray(window.candidates)) throw new Error(`chords.windows[${index}].candidates 不是数组。`);
      window.candidates.forEach((candidateItem, candidateIndex) => {
        if (!candidateItem || typeof candidateItem.label !== "string" || !candidateItem.label.trim()) {
          throw new Error(`chords.windows[${index}].candidates[${candidateIndex}] 无效。`);
        }
      });
    });
    analysis.sections.boundaries.forEach((boundary, index) => {
      if (!boundary || !isFiniteNumber(boundary.time_seconds) || boundary.time_seconds < 0 || boundary.time_seconds > duration) {
        throw new Error(`sections.boundaries[${index}] 无效。`);
      }
    });
    analysis.sections.regions.forEach((region, index) => validateInterval(region, `sections.regions[${index}]`));
    return candidate;
  }

  async function readJsonFile(file) {
    if (!file) throw new Error("没有选择文件。");
    if (file.size > 25 * 1024 * 1024) throw new Error("JSON 超过 25 MB，技术原型暂不载入。");
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      throw new Error(`JSON 无法解析：${error.message}`);
    }
    return parsed;
  }

  function resetEditingState() {
    state.selection = { start: 0, end: 0 };
    state.lyrics = [];
    state.rests = [];
    state.anchors.clear();
    state.chordOverrides = {};
    state.selectedChordKey = null;
    state.selectedLyricId = null;
    state.selectedRestId = null;
    state.nextLyricId = 1;
    state.nextRestId = 1;
    state.nextAnchorId = 1;
    // 清空 undo/redo 栈：新项目里旧历史无意义。
    editGraph.undoStack = [];
    editGraph.redoStack = [];
    updateUndoRedoButtons();
    // 锁定状态也是项目编辑历史的一部分，重置时一并清空。
    state.lockedFields = new Set();
    // stem 轨混音参数重置为默认；新项目里旧的混音参数无意义。
    state.stemTracks = defaultStemTracks();
    // P1.2 轮 4：试听模式重置为 edited；新项目里没有"原始/重合成"对比的必要。
    state.stemPreviewMode = "edited";
    if (elements.stemPreviewMode) elements.stemPreviewMode.value = "edited";
    // 音符候选清空；新项目里旧的音符无意义。
    state.notes = [];
    state.nextNoteId = 1;
    state.selectedNoteId = null;
    state.noteDrag = null;
    state.pianoRollMergeCandidateId = null;
    state.pianoRollStemId = "master";
    if (elements.pianoRollStemSelect) elements.pianoRollStemSelect.value = "master";
    updatePianoRollToolButtons();
    elements.lyricText.value = "";
    elements.lyricLanguage.value = "zh";
    elements.chordInspector.hidden = true;
    elements.restInspector.hidden = true;
    if (elements.lockLyricWrapper) elements.lockLyricWrapper.hidden = true;
    if (elements.lockChordWrapper) elements.lockChordWrapper.hidden = true;
    if (elements.lockRestWrapper) elements.lockRestWrapper.hidden = true;
    elements.exactData.textContent = "选择和弦或歌词区域后显示。";
    renderStemMixer();
    applyStemMix();
  }

  function applyAnalysis(analysis, preserveEdits = false) {
    state.analysis = validateAnalysis(analysis);
    state.duration = Number(analysis.source_audio.duration_seconds);
    state.sampleRateHz = finiteNumber(analysis.source_audio.sample_rate_hz, 48000);
    state.tempoMap = buildTempoMap(state.analysis);
    if (!preserveEdits) resetEditingState();
    elements.workbench.hidden = false;
    elements.exportProjectButton.disabled = false;
    elements.selectionStart.max = String(state.duration);
    elements.selectionEnd.max = String(state.duration);
    elements.selectionStart.value = String(state.selection.start);
    elements.selectionEnd.value = String(state.selection.end);
    const tempo = analysis.analysis.tempo && analysis.analysis.tempo.candidates && analysis.analysis.tempo.candidates[0];
    const key = analysis.analysis.key && analysis.analysis.key.candidates && analysis.analysis.key.candidates[0];
    byId("summary-duration").textContent = `${state.duration.toFixed(3)} s`;
    byId("summary-tempo").textContent = tempo ? `${finiteNumber(tempo.bpm).toFixed(3)} BPM` : "不可用";
    byId("summary-key").textContent = key ? key.label : "不可用";
    byId("summary-analyzer").textContent = `${analysis.analyzer && analysis.analyzer.name || "unknown"} ${analysis.analyzer && analysis.analyzer.version || ""}`;
    setStatus(`已载入分析：${analysis.source_audio.filename || "未命名音频"}。和弦与段落是可修正候选。`, "success");
    renderAll();
    checkAudioAssociation();
  }

  // ---- 渲染辅助 ----------------------------------------------------------------

  function timelineWidth() {
    const viewport = Math.max(640, elements.timelineScroll.clientWidth - 145);
    return Math.max(viewport, state.duration * state.zoom);
  }

  function setTimelineGeometry() {
    if (!state.analysis) return;
    elements.timelineContent.style.width = `${timelineWidth() + 118}px`;
  }

  function percentAt(seconds) {
    return `${clamp(seconds / state.duration, 0, 1) * 100}%`;
  }

  function clearElement(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function renderRuler() {
    clearElement(elements.ruler);
    const width = timelineWidth();
    const targetSpacing = 86;
    const rawStep = state.duration / Math.max(1, Math.floor(width / targetSpacing));
    const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = candidates.find(value => value >= rawStep) || 120;
    for (let time = 0; time <= state.duration + 1e-6; time += step) {
      const tick = document.createElement("span");
      tick.className = "ruler-tick";
      tick.style.left = percentAt(time);
      const label = document.createElement("span");
      label.textContent = `${time.toFixed(step < 1 ? 1 : 0)}s`;
      tick.appendChild(label);
      elements.ruler.appendChild(tick);
    }
  }

  function makeBlock(className, label, start, end, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `timeline-block ${className}`;
    button.textContent = label;
    button.title = title;
    button.style.left = percentAt(start);
    button.style.width = percentAt(Math.max(0, end - start));
    return button;
  }

  function renderSections() {
    clearElement(elements.sectionsLane);
    const layer = state.analysis.analysis.sections;
    const regions = layer && Array.isArray(layer.regions) ? layer.regions : [];
    regions.forEach((region, index) => {
      const start = finiteNumber(region.start_seconds);
      const end = finiteNumber(region.end_seconds);
      const confidence = Number.isFinite(Number(region.confidence)) ? ` · 置信度 ${(Number(region.confidence) * 100).toFixed(0)}%` : "";
      const block = makeBlock("section-block", `段落候选 ${index + 1}`, start, end, `${start.toFixed(3)}–${end.toFixed(3)} 秒${confidence}`);
      block.addEventListener("click", () => setSelection(start, end));
      elements.sectionsLane.appendChild(block);
    });
  }

  function chordKey(window) {
    return `${finiteNumber(window.start_seconds).toFixed(6)}:${finiteNumber(window.end_seconds).toFixed(6)}`;
  }

  function topChord(window) {
    return window && Array.isArray(window.candidates) && window.candidates[0] ? window.candidates[0] : null;
  }

  function effectiveChordLabel(window) {
    const key = chordKey(window);
    const override = state.chordOverrides[key];
    const original = topChord(window);
    return override ? override.label : (original ? original.label : "?");
  }

  function renderChords() {
    clearElement(elements.chordsLane);
    const layer = state.analysis.analysis.chords;
    const windows = layer && Array.isArray(layer.windows) ? layer.windows : [];
    windows.forEach(window => {
      const start = finiteNumber(window.start_seconds);
      const end = finiteNumber(window.end_seconds);
      const candidate = topChord(window);
      const key = chordKey(window);
      const confidence = Number.isFinite(Number(window.confidence)) ? Number(window.confidence) : (candidate ? Number(candidate.confidence) : NaN);
      const titleConfidence = Number.isFinite(confidence) ? `${(confidence * 100).toFixed(1)}%` : "未提供";
      const block = makeBlock("chord-block", effectiveChordLabel(window), start, end, `${start.toFixed(3)}–${end.toFixed(3)} 秒 · 置信度 ${titleConfidence} · 点击修正`);
      if (state.chordOverrides[key]) block.classList.add("corrected");
      if (state.selectedChordKey === key) block.classList.add("selected");
      if (isLocked("chord", key)) block.classList.add("locked");
      block.addEventListener("click", () => selectChord(window));
      elements.chordsLane.appendChild(block);
    });
  }

  function selectChord(window) {
    const key = chordKey(window);
    const candidate = topChord(window);
    state.selectedChordKey = key;
    elements.chordInspector.hidden = false;
    elements.chordLabel.value = effectiveChordLabel(window);
    const confidence = Number.isFinite(Number(window.confidence)) ? Number(window.confidence) : (candidate ? Number(candidate.confidence) : NaN);
    const confidenceText = Number.isFinite(confidence) ? `${(confidence * 100).toFixed(1)}%` : "未提供";
    elements.chordDetail.textContent = `分析值：${candidate ? candidate.label : "无"} · ${finiteNumber(window.start_seconds).toFixed(3)}–${finiteNumber(window.end_seconds).toFixed(3)} 秒 · 置信度 ${confidenceText} · 来源 ${state.analysis.analysis.chords.source || "unknown"}`;
    elements.exactData.textContent = JSON.stringify({ source: state.analysis.analysis.chords.source, window, override: state.chordOverrides[key] || null, locked: isLocked("chord", key) }, null, 2);
    refreshLockToggle(elements.lockChordWrapper, elements.lockChordCheckbox, "chord", key);
    setSelection(finiteNumber(window.start_seconds), finiteNumber(window.end_seconds));
    renderChords();
  }

  function selectedChordWindow() {
    const windows = state.analysis && state.analysis.analysis.chords && state.analysis.analysis.chords.windows;
    return Array.isArray(windows) ? windows.find(window => chordKey(window) === state.selectedChordKey) : null;
  }

  // ---- 歌词 / 休止渲染 --------------------------------------------------------

  function renderLyrics() {
    clearElement(elements.lyricsLane);
    if (!state.lyrics.length && !state.rests.length) {
      elements.lyricsLane.appendChild(elements.lyricsEmpty);
      elements.lyricsEmpty.hidden = false;
      return;
    }
    // 合并 lyrics 与 rests，按 start sample 排序，渲染时按时间顺序处理空段。
    const combined = [];
    state.lyrics.forEach(region => combined.push({ kind: "lyric", region }));
    state.rests.forEach(region => combined.push({ kind: "rest", region }));
    combined.sort((a, b) => anchorStartSample(a.region) - anchorStartSample(b.region));

    const appendUnassigned = (startSeconds, endSeconds) => {
      if (endSeconds - startSeconds <= 1e-6) return;
      const gap = document.createElement("span");
      gap.className = "timeline-block rest-block unassigned-block";
      gap.textContent = "未分配";
      gap.title = `${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · 明确留白，不是渲染漏缝；可选中后转为休止`;
      gap.style.left = percentAt(startSeconds);
      gap.style.right = percentAt(state.duration - endSeconds);
      gap.dataset.unassignedStart = String(startSeconds);
      gap.dataset.unassignedEnd = String(endSeconds);
      gap.addEventListener("click", () => {
        setSelection(Number(gap.dataset.unassignedStart), Number(gap.dataset.unassignedEnd));
        selectUnassignedGap(Number(gap.dataset.unassignedStart), Number(gap.dataset.unassignedEnd));
      });
      elements.lyricsLane.appendChild(gap);
    };

    let cursorSample = 0;
    combined.forEach(({ kind, region }) => {
      const startSample = anchorStartSample(region);
      const endSample = anchorEndSample(region);
      const startSeconds = sampleToSeconds(startSample);
      const endSeconds = sampleToSeconds(endSample);
      appendUnassigned(sampleToSeconds(cursorSample), startSeconds);
      if (kind === "lyric") {
        const language = region.language === "ja" ? "日" : "中";
        const lockMarker = isLocked("lyric", region.id) ? " · 已锁定" : "";
        const block = makeBlock("lyric-block", `${language} · ${region.text}`, startSeconds, endSeconds, `${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · 点击编辑 · 拖动移动 · 边缘拉伸${lockMarker}`);
        block.style.removeProperty("width");
        block.style.right = percentAt(state.duration - endSeconds);
        if (state.selectedLyricId === region.id) block.classList.add("selected");
        if (isLocked("lyric", region.id)) block.classList.add("locked");
        // 用 pointerdown 替代 click，以便区分"点击编辑"和"拖动移动/拉伸"。
        block.addEventListener("pointerdown", event => beginLyricBlockDrag(event, region));
        elements.lyricsLane.appendChild(block);
      } else {
        const lockMarker = isLocked("rest", region.id) ? " · 已锁定" : "";
        const block = makeBlock("rest-block explicit-rest", "休止", startSeconds, endSeconds, `${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · 显式休止；点击编辑${lockMarker}`);
        block.style.removeProperty("width");
        block.style.right = percentAt(state.duration - endSeconds);
        if (state.selectedRestId === region.id) block.classList.add("selected");
        if (isLocked("rest", region.id)) block.classList.add("locked");
        block.addEventListener("click", () => editRest(region.id));
        elements.lyricsLane.appendChild(block);
      }
      cursorSample = Math.max(cursorSample, endSample);
    });
    appendUnassigned(sampleToSeconds(cursorSample), state.duration);

    renderSharedEdges();
  }

  // ---- 歌词块整体拖动与拉伸 ----------------------------------------------------
  // 行为：
  //   - pointerdown 在块左右 6 px 内 → stretch-start / stretch-end 模式，只移动一端 anchor
  //   - pointerdown 在块中间 → move 模式，整体移动 start/end anchor
  //   - 移动距离 < 4 px → 视为点击，进入编辑模式（保留原 editLyric 行为）
  //   - 若被移动的 anchor 与相邻 region 共享，先克隆一个新 anchor 给当前 region，
  //     保持邻居不动；这会让连续歌词区在单独拖动后产生小缝（用户预期）。
  //   - 不能跨越相邻 region 的另一端 anchor；吸附、Alt 绕过、Esc 取消、方向键微调都支持。
  function beginLyricBlockDrag(event, region) {
    if (!state.analysis || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetLeft = event.clientX - rect.left;
    const offsetRight = rect.right - event.clientX;
    const edgeTolerance = 8;
    let mode;
    if (offsetLeft <= edgeTolerance) mode = "stretch-start";
    else if (offsetRight <= edgeTolerance) mode = "stretch-end";
    else mode = "move";
    state.lyricDrag = {
      regionId: region.id,
      mode,
      startClientX: event.clientX,
      startStartSample: anchorStartSample(region),
      startEndSample: anchorEndSample(region),
      originalStartAnchorId: region.startAnchorId,
      originalEndAnchorId: region.endAnchorId,
      beganEdit: false,
      detachedStart: false,
      detachedEnd: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.addEventListener("pointermove", moveLyricBlock, true);
    document.addEventListener("pointerup", endLyricBlockDrag, true);
    document.addEventListener("pointercancel", cancelLyricBlockDrag, true);
  }

  // 如果 anchor 与其他 region 共享，克隆一个新 anchor 给当前 region，
  // 把当前 region 的对应 anchorId 切换到新克隆的 anchor，保持邻居不动。
  function detachAnchorIfShared(region, which) {
    const anchorId = which === "start" ? region.startAnchorId : region.endAnchorId;
    const shared = [...state.lyrics, ...state.rests].some(other => other.id !== region.id && (other.startAnchorId === anchorId || other.endAnchorId === anchorId));
    if (!shared) return false;
    const original = state.anchors.get(anchorId);
    const cloned = createAnchorAtSample(original.sample);
    if (which === "start") {
      region.startAnchorId = cloned.id;
      state.lyricDrag.detachedStart = true;
    } else {
      region.endAnchorId = cloned.id;
      state.lyricDrag.detachedEnd = true;
    }
    return true;
  }

  function moveLyricBlock(event) {
    if (!state.lyricDrag) return;
    if (Math.abs(event.clientX - state.lyricDrag.startClientX) < 4 && !state.lyricDrag.beganEdit) return;
    const region = state.lyrics.find(item => item.id === state.lyricDrag.regionId);
    if (!region) return;
    if (!state.lyricDrag.beganEdit) {
      editGraph.begin(state.lyricDrag.mode === "move" ? `拖动歌词 ${region.id}` : `拉伸歌词 ${region.id}`);
      state.lyricDrag.beganEdit = true;
      // 进入拖动模式前，按需克隆共享 anchor，使当前 region 独立移动。
      if (state.lyricDrag.mode === "move" || state.lyricDrag.mode === "stretch-start") {
        detachAnchorIfShared(region, "start");
      }
      if (state.lyricDrag.mode === "move" || state.lyricDrag.mode === "stretch-end") {
        detachAnchorIfShared(region, "end");
      }
    }
    event.preventDefault();
    event.stopPropagation();
    const pointerTime = snapTime(timeFromPointer(event), event.altKey);
    const pointerSample = secondsToSample(pointerTime);
    const minSample = 0;
    const maxSample = Math.round(state.duration * state.sampleRateHz);
    const minimum = event.altKey ? 1 : Math.max(1, Math.round((snapIntervalSeconds() || 0.001) * state.sampleRateHz));

    if (state.lyricDrag.mode === "move") {
      const durationSamples = state.lyricDrag.startEndSample - state.lyricDrag.startStartSample;
      // 限制不能跨越邻居的另一端 anchor
      const neighbors = [...state.lyrics, ...state.rests].filter(other => other.id !== region.id).sort((a, b) => anchorStartSample(a) - anchorStartSample(b));
      let lowerBound = minSample;
      let upperBound = maxSample;
      const previousNeighbor = neighbors.filter(other => anchorEndSample(other) <= state.lyricDrag.startStartSample).at(-1);
      if (previousNeighbor) lowerBound = anchorEndSample(previousNeighbor) + minimum;
      const nextNeighbor = neighbors.find(other => anchorStartSample(other) >= state.lyricDrag.startEndSample);
      if (nextNeighbor) upperBound = anchorStartSample(nextNeighbor) - minimum - durationSamples;
      const newStart = Math.max(lowerBound, Math.min(upperBound, pointerSample));
      moveAnchor(region.startAnchorId, newStart);
      moveAnchor(region.endAnchorId, newStart + durationSamples);
    } else if (state.lyricDrag.mode === "stretch-start") {
      const endSample = anchorEndSample(region);
      const newStart = Math.max(minSample, Math.min(endSample - minimum, pointerSample));
      moveAnchor(region.startAnchorId, newStart);
    } else if (state.lyricDrag.mode === "stretch-end") {
      const startSample = anchorStartSample(region);
      const newEnd = Math.max(startSample + minimum, Math.min(maxSample, pointerSample));
      moveAnchor(region.endAnchorId, newEnd);
    }
    setSelection(anchorStartSeconds(region), anchorEndSeconds(region), false);
    renderLyrics();
  }

  function endLyricBlockDrag(event) {
    if (!state.lyricDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const drag = state.lyricDrag;
    state.lyricDrag = null;
    document.removeEventListener("pointermove", moveLyricBlock, true);
    document.removeEventListener("pointerup", endLyricBlockDrag, true);
    document.removeEventListener("pointercancel", cancelLyricBlockDrag, true);
    if (!drag.beganEdit) {
      // 没真正拖动 → 视为点击，进入编辑
      editLyric(drag.regionId);
      return;
    }
    pruneAnchors();
    const region = state.lyrics.find(item => item.id === drag.regionId);
    if (region) {
      const startSeconds = anchorStartSeconds(region);
      const endSeconds = anchorEndSeconds(region);
      setStatus(`${drag.mode === "move" ? "歌词区域已移动到" : "歌词区域已拉伸到"} ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒。`, "success");
    }
  }

  function cancelLyricBlockDrag() {
    if (!state.lyricDrag) return;
    const drag = state.lyricDrag;
    state.lyricDrag = null;
    document.removeEventListener("pointermove", moveLyricBlock, true);
    document.removeEventListener("pointerup", endLyricBlockDrag, true);
    document.removeEventListener("pointercancel", cancelLyricBlockDrag, true);
    if (drag.beganEdit) {
      // 取消拖动：丢弃刚记录的撤销点
      editGraph.undoStack.pop();
      updateUndoRedoButtons();
    }
    // 恢复原始 anchor 引用（如果分离过）
    const region = state.lyrics.find(item => item.id === drag.regionId);
    if (region) {
      if (drag.detachedStart) region.startAnchorId = drag.originalStartAnchorId;
      if (drag.detachedEnd) region.endAnchorId = drag.originalEndAnchorId;
    }
    pruneAnchors();
    renderLyrics();
    setStatus("系统取消了歌词块拖动，已恢复原位置。", "success");
  }

  // 在相邻 lyric/rest 共享 anchor 的位置渲染一个可拖动的共享边手柄。
  function renderSharedEdges() {
    const combined = [];
    state.lyrics.forEach(region => combined.push({ kind: "lyric", region }));
    state.rests.forEach(region => combined.push({ kind: "rest", region }));
    combined.sort((a, b) => anchorStartSample(a.region) - anchorStartSample(b.region));
    for (let index = 1; index < combined.length; index += 1) {
      const previous = combined[index - 1].region;
      const current = combined[index].region;
      if (anchorEndSample(previous) === anchorStartSample(current)) {
        const anchorId = previous.endAnchorId;
        const seconds = sampleToSeconds(anchorEndSample(previous));
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "shared-edge-handle";
        handle.title = `共享边界 ${seconds.toFixed(3)} 秒 · 拖动会同时移动两侧区域`;
        handle.style.left = percentAt(seconds);
        handle.dataset.anchorId = anchorId;
        handle.addEventListener("pointerdown", event => beginEdgeDrag(event, anchorId));
        handle.addEventListener("keydown", event => nudgeEdge(event, anchorId));
        elements.lyricsLane.appendChild(handle);
      }
    }
  }

  function selectUnassignedGap(start, end) {
    state.selectedLyricId = null;
    state.selectedRestId = null;
    elements.restInspector.hidden = false;
    elements.restDetail.textContent = `未分配空段 ${start.toFixed(3)}–${end.toFixed(3)} 秒；可以转为显式休止，或保留作为留白。`;
    elements.convertRestButton.hidden = false;
    elements.deleteRestButton.hidden = true;
    elements.convertRestButton.onclick = () => convertSelectionToRest();
    hideLyricEditor();
    hideChordInspector();
    refreshLockToggle(elements.lockRestWrapper, elements.lockRestCheckbox, "rest", null);
    renderLyrics();
  }

  function editLyric(id) {
    const region = state.lyrics.find(item => item.id === id);
    if (!region) return;
    state.selectedLyricId = id;
    state.selectedRestId = null;
    elements.lyricLanguage.value = region.language;
    elements.lyricText.value = region.text;
    elements.cancelLyricEditButton.hidden = false;
    elements.deleteLyricButton.hidden = false;
    setSelection(anchorStartSeconds(region), anchorEndSeconds(region));
    elements.exactData.textContent = JSON.stringify({
      id: region.id,
      language: region.language,
      text: region.text,
      locked: isLocked("lyric", region.id),
      start_anchor: state.anchors.get(region.startAnchorId),
      end_anchor: state.anchors.get(region.endAnchorId),
    }, null, 2);
    hideRestInspector();
    hideChordInspector();
    refreshLockToggle(elements.lockLyricWrapper, elements.lockLyricCheckbox, "lyric", id);
    renderLyrics();
  }

  function editRest(id) {
    const rest = state.rests.find(item => item.id === id);
    if (!rest) return;
    state.selectedRestId = id;
    state.selectedLyricId = null;
    elements.restInspector.hidden = false;
    elements.deleteRestButton.hidden = false;
    elements.convertRestButton.hidden = true;
    const startSeconds = anchorStartSeconds(rest);
    const endSeconds = anchorEndSeconds(rest);
    elements.restDetail.textContent = `显式休止 ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒；删除后会恢复为未分配空段。`;
    elements.deleteRestButton.onclick = () => deleteRest(rest.id);
    setSelection(startSeconds, endSeconds);
    elements.exactData.textContent = JSON.stringify({
      id: rest.id,
      kind: rest.kind,
      locked: isLocked("rest", rest.id),
      start_anchor: state.anchors.get(rest.startAnchorId),
      end_anchor: state.anchors.get(rest.endAnchorId),
    }, null, 2);
    hideLyricEditor();
    hideChordInspector();
    refreshLockToggle(elements.lockRestWrapper, elements.lockRestCheckbox, "rest", id);
    renderLyrics();
  }

  function endLyricEdit(clearText = false) {
    state.selectedLyricId = null;
    elements.cancelLyricEditButton.hidden = true;
    elements.deleteLyricButton.hidden = true;
    if (clearText) elements.lyricText.value = "";
    refreshLockToggle(elements.lockLyricWrapper, elements.lockLyricCheckbox, "lyric", null);
    renderLyrics();
  }

  function hideLyricEditor() {
    elements.cancelLyricEditButton.hidden = true;
    elements.deleteLyricButton.hidden = true;
    elements.lyricText.value = "";
    refreshLockToggle(elements.lockLyricWrapper, elements.lockLyricCheckbox, "lyric", null);
  }

  function hideRestInspector() {
    elements.restInspector.hidden = true;
    refreshLockToggle(elements.lockRestWrapper, elements.lockRestCheckbox, "rest", null);
  }

  function hideChordInspector() {
    elements.chordInspector.hidden = true;
    refreshLockToggle(elements.lockChordWrapper, elements.lockChordCheckbox, "chord", null);
  }

  function setSelection(start, end, announce = true, useSnap = false, bypassSnap = false) {
    if (!state.analysis) return;
    let safeStart = clamp(finiteNumber(start), 0, state.duration);
    let safeEnd = clamp(finiteNumber(end), 0, state.duration);
    if (useSnap) {
      safeStart = snapTime(safeStart, bypassSnap);
      safeEnd = snapTime(safeEnd, bypassSnap);
    }
    if (safeStart > safeEnd) [safeStart, safeEnd] = [safeEnd, safeStart];
    state.selection = { start: safeStart, end: safeEnd };
    elements.selectionStart.value = safeStart.toFixed(3);
    elements.selectionEnd.value = safeEnd.toFixed(3);
    renderSelection();
    if (announce && safeEnd > safeStart) setStatus(`选区：${safeStart.toFixed(3)}–${safeEnd.toFixed(3)} 秒。`, "success");
  }

  function renderSelection() {
    const { start, end } = state.selection;
    if (!state.analysis || end <= start) {
      elements.selectionOverlay.hidden = true;
      elements.selectionSummary.textContent = "尚未选择区域。";
      return;
    }
    elements.selectionOverlay.hidden = false;
    elements.selectionOverlay.style.left = percentAt(start);
    elements.selectionOverlay.style.width = percentAt(end - start);
    elements.selectionStartHandle.title = `开始 ${start.toFixed(3)} 秒；拖动或方向键调整`;
    elements.selectionEndHandle.title = `结束 ${end.toFixed(3)} 秒；拖动或方向键调整`;
    const chordLabels = (state.analysis.analysis.chords.windows || [])
      .filter(window => finiteNumber(window.end_seconds) > start && finiteNumber(window.start_seconds) < end)
      .map(window => effectiveChordLabel(window));
    elements.selectionSummary.textContent = `选区 ${start.toFixed(3)}–${end.toFixed(3)} 秒 · ${(end - start).toFixed(3)} 秒 · 和弦候选 ${chordLabels.join(" → ") || "无"}`;
  }

  function canvasColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      surface: style.getPropertyValue("--surface-soft").trim(),
      border: style.getPropertyValue("--border").trim(),
      accent: style.getPropertyValue("--accent").trim(),
      violet: style.getPropertyValue("--violet").trim(),
      muted: style.getPropertyValue("--muted").trim(),
    };
  }

  function renderCanvas() {
    if (!state.analysis) return;
    const rect = elements.waveformLane.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    elements.canvas.width = Math.round(width * dpr);
    elements.canvas.height = Math.round(height * dpr);
    const context = elements.canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = canvasColors();
    context.fillStyle = colors.surface;
    context.fillRect(0, 0, width, height);

    if (state.layers.beats) {
      const tempo = state.analysis.analysis.tempo && state.analysis.analysis.tempo.candidates && state.analysis.analysis.tempo.candidates[0];
      if (tempo && finiteNumber(tempo.bpm) > 0) {
        const step = 60 / finiteNumber(tempo.bpm);
        const first = finiteNumber(tempo.first_beat_seconds);
        context.strokeStyle = colors.border;
        context.lineWidth = 1;
        const estimatedLineCount = Math.max(0, Math.floor((state.duration - first) / step) + 1);
        const maximumLines = Math.min(10000, Math.max(1, Math.floor(width / 2)));
        const stride = Math.max(1, Math.ceil(estimatedLineCount / maximumLines));
        for (let index = 0; index < estimatedLineCount; index += stride) {
          const time = first + index * step;
          const x = time / state.duration * width;
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, height);
          context.stroke();
        }
      }
    }

    if (state.layers.waveform) {
      const bins = state.analysis.analysis.waveform.bins || [];
      context.strokeStyle = colors.accent;
      context.lineWidth = Math.max(1, width / Math.max(1, bins.length) * 0.58);
      bins.forEach(bin => {
        const x = finiteNumber(bin.start_seconds) / state.duration * width;
        const minimum = clamp(finiteNumber(bin.minimum), -1, 1);
        const maximum = clamp(finiteNumber(bin.maximum), -1, 1);
        context.beginPath();
        context.moveTo(x, height * (0.5 - maximum * 0.44));
        context.lineTo(x, height * (0.5 - minimum * 0.44));
        context.stroke();
      });
    }

    if (state.layers.energy) {
      const bins = state.analysis.analysis.short_time_energy.bins || [];
      const usable = bins.filter(bin => finiteNumber(bin.rms_dbfs, -120) > -119.9);
      if (usable.length) {
        context.strokeStyle = colors.violet;
        context.lineWidth = 2;
        context.beginPath();
        usable.forEach((bin, index) => {
          const x = ((finiteNumber(bin.start_seconds) + finiteNumber(bin.end_seconds)) / 2) / state.duration * width;
          const normalized = clamp((finiteNumber(bin.rms_dbfs, -120) + 60) / 60, 0, 1);
          const y = height - 8 - normalized * height * 0.34;
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        });
        context.stroke();
      }
    }
  }

  function renderLayerVisibility() {
    document.querySelector('[data-track="sections"]').hidden = !state.layers.sections;
    document.querySelector('[data-track="chords"]').hidden = !state.layers.chords;
  }

  // ---- Stem 混音器渲染 --------------------------------------------------------
  // 每轨显示：名字、角色徽章、Mute/Solo 按钮、Gain 滑块、Pan 滑块、数值。
  // master 标记为"主输出"，其他标记为"占位 stem"，提示用户未接入分离后端。
  // 渲染只更新数值与按钮状态，控件本身（input/button）不重建，避免拖动时丢失焦点。
  function renderStemMixer() {
    if (!elements.stemMixer) return;
    const container = elements.stemMixer;
    if (container.children.length !== state.stemTracks.length) {
      clearElement(container);
      state.stemTracks.forEach(track => container.appendChild(buildStemRow(track)));
    }
    state.stemTracks.forEach((track, index) => {
      const row = container.children[index];
      if (!row) return;
      row.dataset.trackId = track.id;
      const { muted } = stemEffectiveState(track);
      const muteButton = row.querySelector('[data-stem-control="mute"]');
      const soloButton = row.querySelector('[data-stem-control="solo"]');
      const gainInput = row.querySelector('[data-stem-control="gain"]');
      const panInput = row.querySelector('[data-stem-control="pan"]');
      const gainValue = row.querySelector('[data-stem-readout="gain"]');
      const panValue = row.querySelector('[data-stem-readout="pan"]');
      const statusBadge = row.querySelector('[data-stem-readout="status"]');
      if (muteButton) {
        muteButton.setAttribute("aria-pressed", String(track.mute));
        muteButton.classList.toggle("active", track.mute);
        muteButton.textContent = track.mute ? "已静音" : "静音";
      }
      if (soloButton) {
        soloButton.setAttribute("aria-pressed", String(track.solo));
        soloButton.classList.toggle("active", track.solo);
        soloButton.textContent = track.solo ? "独奏中" : "独奏";
      }
      if (gainInput) gainInput.value = String(track.gain);
      if (panInput) panInput.value = String(track.pan);
      if (gainValue) gainValue.textContent = `${(track.gain * 100).toFixed(0)}%`;
      if (panValue) {
        const percent = Math.round(track.pan * 100);
        if (percent === 0) panValue.textContent = "中";
        else if (percent < 0) panValue.textContent = `L ${Math.abs(percent)}`;
        else panValue.textContent = `R ${percent}`;
      }
      if (statusBadge) {
        if (track.source === "main") {
          statusBadge.textContent = muted ? "主输出 · 静音" : "主输出";
        } else {
          statusBadge.textContent = muted ? "占位 · 静音" : "占位 stem";
        }
      }
      row.classList.toggle("muted", muted);
      row.classList.toggle("soloed", track.solo);
    });
  }

  function buildStemRow(track) {
    const row = document.createElement("div");
    row.className = "stem-row";
    row.dataset.trackId = track.id;
    if (track.source === "main") row.classList.add("stem-master");
    else row.classList.add("stem-placeholder");

    const header = document.createElement("div");
    header.className = "stem-header";
    const name = document.createElement("span");
    name.className = "stem-name";
    name.textContent = track.name;
    const role = document.createElement("span");
    role.className = "stem-role";
    role.textContent = track.role;
    header.appendChild(name);
    header.appendChild(role);
    row.appendChild(header);

    const controls = document.createElement("div");
    controls.className = "stem-controls";

    const muteButton = document.createElement("button");
    muteButton.type = "button";
    muteButton.dataset.stemControl = "mute";
    muteButton.setAttribute("aria-pressed", String(track.mute));
    muteButton.textContent = track.mute ? "已静音" : "静音";
    controls.appendChild(muteButton);

    const soloButton = document.createElement("button");
    soloButton.type = "button";
    soloButton.dataset.stemControl = "solo";
    soloButton.setAttribute("aria-pressed", String(track.solo));
    soloButton.textContent = track.solo ? "独奏中" : "独奏";
    controls.appendChild(soloButton);

    const gainLabel = document.createElement("label");
    gainLabel.className = "stem-slider";
    const gainCaption = document.createElement("span");
    gainCaption.className = "stem-caption";
    gainCaption.textContent = "音量";
    const gainInput = document.createElement("input");
    gainInput.type = "range";
    gainInput.min = "0";
    gainInput.max = "1.5";
    gainInput.step = "0.01";
    gainInput.value = String(track.gain);
    gainInput.dataset.stemControl = "gain";
    const gainValue = document.createElement("span");
    gainValue.className = "stem-value";
    gainValue.dataset.stemReadout = "gain";
    gainValue.textContent = `${(track.gain * 100).toFixed(0)}%`;
    gainLabel.appendChild(gainCaption);
    gainLabel.appendChild(gainInput);
    gainLabel.appendChild(gainValue);
    controls.appendChild(gainLabel);

    const panLabel = document.createElement("label");
    panLabel.className = "stem-slider";
    const panCaption = document.createElement("span");
    panCaption.className = "stem-caption";
    panCaption.textContent = "声像";
    const panInput = document.createElement("input");
    panInput.type = "range";
    panInput.min = "-1";
    panInput.max = "1";
    panInput.step = "0.01";
    panInput.value = String(track.pan);
    panInput.dataset.stemControl = "pan";
    const panValue = document.createElement("span");
    panValue.className = "stem-value";
    panValue.dataset.stemReadout = "pan";
    const panPercent = Math.round(track.pan * 100);
    panValue.textContent = panPercent === 0 ? "中" : (panPercent < 0 ? `L ${Math.abs(panPercent)}` : `R ${panPercent}`);
    panLabel.appendChild(panCaption);
    panLabel.appendChild(panInput);
    panLabel.appendChild(panValue);
    controls.appendChild(panLabel);

    // P1.2 轮 4：非破坏混音参数。trim 是首尾裁切秒数；fade 是淡入淡出秒数。
    // 在所有 stem 上都呈现参数 UI（占位 stem 也保存参数，等接入分离后端时复用）。
    const trimGroup = document.createElement("div");
    trimGroup.className = "stem-number-group";
    const trimStartLabel = document.createElement("label");
    trimStartLabel.className = "stem-number";
    const trimStartCaption = document.createElement("span");
    trimStartCaption.textContent = "裁切起（秒）";
    trimStartLabel.appendChild(trimStartCaption);
    const trimStartInput = document.createElement("input");
    trimStartInput.type = "number";
    trimStartInput.min = "0";
    trimStartInput.step = "0.01";
    trimStartInput.value = String(track.trimStartSeconds);
    trimStartInput.dataset.stemControl = "trimStartSeconds";
    trimStartLabel.appendChild(trimStartInput);
    trimGroup.appendChild(trimStartLabel);
    const trimEndLabel = document.createElement("label");
    trimEndLabel.className = "stem-number";
    const trimEndCaption = document.createElement("span");
    trimEndCaption.textContent = "裁切止（秒）";
    trimEndLabel.appendChild(trimEndCaption);
    const trimEndInput = document.createElement("input");
    trimEndInput.type = "number";
    trimEndInput.min = "0";
    trimEndInput.step = "0.01";
    trimEndInput.value = String(track.trimEndSeconds);
    trimEndInput.dataset.stemControl = "trimEndSeconds";
    trimEndLabel.appendChild(trimEndInput);
    trimGroup.appendChild(trimEndLabel);
    controls.appendChild(trimGroup);

    const fadeGroup = document.createElement("div");
    fadeGroup.className = "stem-number-group";
    const fadeInLabel = document.createElement("label");
    fadeInLabel.className = "stem-number";
    const fadeInCaption = document.createElement("span");
    fadeInCaption.textContent = "淡入（秒）";
    fadeInLabel.appendChild(fadeInCaption);
    const fadeInInput = document.createElement("input");
    fadeInInput.type = "number";
    fadeInInput.min = "0";
    fadeInInput.step = "0.01";
    fadeInInput.value = String(track.fadeInSeconds);
    fadeInInput.dataset.stemControl = "fadeInSeconds";
    fadeInLabel.appendChild(fadeInInput);
    fadeGroup.appendChild(fadeInLabel);
    const fadeOutLabel = document.createElement("label");
    fadeOutLabel.className = "stem-number";
    const fadeOutCaption = document.createElement("span");
    fadeOutCaption.textContent = "淡出（秒）";
    fadeOutLabel.appendChild(fadeOutCaption);
    const fadeOutInput = document.createElement("input");
    fadeOutInput.type = "number";
    fadeOutInput.min = "0";
    fadeOutInput.step = "0.01";
    fadeOutInput.value = String(track.fadeOutSeconds);
    fadeOutInput.dataset.stemControl = "fadeOutSeconds";
    fadeOutLabel.appendChild(fadeOutInput);
    fadeGroup.appendChild(fadeOutLabel);
    controls.appendChild(fadeGroup);

    const status = document.createElement("span");
    status.className = "stem-status";
    status.dataset.stemReadout = "status";
    status.textContent = track.source === "main" ? "主输出" : "占位 stem";
    controls.appendChild(status);

    row.appendChild(controls);
    return row;
  }

  // 用户操作 stem 控件时统一入口：先记录撤销点，再更新数据，再应用混音与渲染。
  function updateStemField(trackId, field, value) {
    const track = state.stemTracks.find(item => item.id === trackId);
    if (!track) return;
    const oldValue = track[field];
    if (oldValue === value) return;
    editGraph.begin(`调整 stem ${track.name} 的 ${field}`);
    track[field] = value;
    applyStemMix();
    renderStemMixer();
    setStatus(`已调整 ${track.name} 的 ${field}：${formatStemFieldValue(field, value)}。`, "success");
  }

  function formatStemFieldValue(field, value) {
    if (field === "mute" || field === "solo") return value ? "开" : "关";
    if (field === "gain") return `${Math.round(value * 100)}%`;
    if (field === "pan") {
      const percent = Math.round(value * 100);
      return percent === 0 ? "中" : (percent < 0 ? `L ${Math.abs(percent)}` : `R ${percent}`);
    }
    if (field === "trimStartSeconds" || field === "trimEndSeconds" || field === "fadeInSeconds" || field === "fadeOutSeconds") {
      return `${value.toFixed(3)} 秒`;
    }
    return String(value);
  }

  // ---- NoteEvent 数据模型（P1.2 轮 2）-----------------------------------------
  // 每个 note 引用 start/end anchor（与歌词/休止共享时间模型），
  // 浮点 pitch（60 = C4），velocity 0..1，confidence 0..1，
  // source 标注来源（manual / transcription / generation）。
  // 第一版所有音符都是用户手工创建或后续从转录后端导入；这里只负责 CRUD 与渲染。

  function createNote(stemId, startSample, endSample, pitch, velocity = 0.8, source = "manual") {
    if (!state.tempoMap) return null;
    const safeStart = Math.max(0, Math.min(Math.round(startSample), Math.round(state.duration * state.sampleRateHz)));
    const safeEnd = Math.max(safeStart + 1, Math.min(Math.round(endSample), Math.round(state.duration * state.sampleRateHz)));
    const safePitch = clamp(Math.round(pitch), PIANO_ROLL_MIN_PITCH, PIANO_ROLL_MAX_PITCH);
    const startAnchor = findAnchorBySample(safeStart) || createAnchorAtSample(safeStart);
    const endAnchor = findAnchorBySample(safeEnd) || createAnchorAtSample(safeEnd);
    let identifier;
    do {
      identifier = `note-${state.nextNoteId++}`;
    } while (state.notes.some(note => note.id === identifier));
    const note = {
      id: identifier,
      stemId: stemId || "master",
      startAnchorId: startAnchor.id,
      endAnchorId: endAnchor.id,
      pitch: safePitch,
      velocity: clamp(velocity, 0, 1),
      confidence: source === "manual" ? 1 : 0,
      source,
    };
    state.notes.push(note);
    return note;
  }

  function deleteNote(id) {
    const note = state.notes.find(item => item.id === id);
    if (!note) return;
    editGraph.begin(`删除音符 ${id}`);
    state.notes = state.notes.filter(item => item.id !== id);
    if (state.selectedNoteId === id) state.selectedNoteId = null;
    if (state.pianoRollMergeCandidateId === id) state.pianoRollMergeCandidateId = null;
    pruneAnchors();
    renderPianoRoll();
    updatePianoRollToolButtons();
    setStatus(`已删除音符 ${id}。`, "success");
  }

  // 选中音符；additive=true 时把当前 click 视为"合并候选"选择（Shift 修饰）。
  function selectNote(id, additive = false) {
    if (additive && state.selectedNoteId && id !== state.selectedNoteId) {
      state.pianoRollMergeCandidateId = id;
    } else {
      state.selectedNoteId = id;
      if (!additive) state.pianoRollMergeCandidateId = null;
    }
    const note = state.notes.find(item => item.id === id);
    if (note) {
      const startSeconds = anchorStartSeconds(note);
      const endSeconds = anchorEndSeconds(note);
      setSelection(startSeconds, endSeconds, false);
      setStatus(`已选中音符 ${id}：${midiToNoteName(note.pitch)} · ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒。`, "success");
    }
    renderPianoRoll();
    updatePianoRollToolButtons();
  }

  function splitSelectedNote() {
    if (!state.selectedNoteId) return;
    const note = state.notes.find(item => item.id === state.selectedNoteId);
    if (!note) return;
    const startSample = anchorStartSample(note);
    const endSample = anchorEndSample(note);
    const midSample = Math.round((startSample + endSample) / 2);
    if (endSample - startSample < 2) {
      setStatus("音符太短，无法拆分。", "error");
      return;
    }
    editGraph.begin(`拆分音符 ${note.id}`);
    // 把当前音符的 end 缩到中点，再创建一个新音符从中点到原 end。
    const midAnchor = findAnchorBySample(midSample) || createAnchorAtSample(midSample);
    note.endAnchorId = midAnchor.id;
    const newNote = createNote(note.stemId, midSample, endSample, note.pitch, note.velocity, note.source);
    state.selectedNoteId = newNote ? newNote.id : note.id;
    state.pianoRollMergeCandidateId = null;
    pruneAnchors();
    renderPianoRoll();
    updatePianoRollToolButtons();
    setStatus(`已拆分音符 ${note.id} → ${note.id} + ${newNote ? newNote.id : "?"}。`, "success");
  }

  function mergeSelectedNotes() {
    if (!state.selectedNoteId || !state.pianoRollMergeCandidateId) return;
    if (state.selectedNoteId === state.pianoRollMergeCandidateId) return;
    const a = state.notes.find(item => item.id === state.selectedNoteId);
    const b = state.notes.find(item => item.id === state.pianoRollMergeCandidateId);
    if (!a || !b) return;
    if (a.pitch !== b.pitch) {
      setStatus("只有音高相同的音符才能合并。", "error");
      return;
    }
    let first, second;
    if (anchorStartSample(a) < anchorStartSample(b)) {
      first = a; second = b;
    } else {
      first = b; second = a;
    }
    if (Math.abs(anchorEndSample(first) - anchorStartSample(second)) > Math.round(ANCHOR_TOLERANCE_SECONDS * state.sampleRateHz)) {
      setStatus("只有时间相邻的音符才能合并。", "error");
      return;
    }
    editGraph.begin(`合并音符 ${first.id} 与 ${second.id}`);
    first.endAnchorId = second.endAnchorId;
    state.notes = state.notes.filter(item => item.id !== second.id);
    state.selectedNoteId = first.id;
    state.pianoRollMergeCandidateId = null;
    pruneAnchors();
    renderPianoRoll();
    updatePianoRollToolButtons();
    setStatus(`已合并音符 → ${first.id}。`, "success");
  }

  // 量化选中音符（P1.2 轮 3）：把起止 sample 对齐到当前 snap 网格。
  // 网格关闭时不做任何改动；调用前先 detach 共享 anchor，保持邻居不动。
  function quantizeSelectedNote() {
    if (!state.selectedNoteId) return;
    const note = state.notes.find(item => item.id === state.selectedNoteId);
    if (!note) return;
    if (!snapIntervalSeconds()) {
      setStatus("吸附网格已关闭，无法量化；请先选择 1 拍 / 1/2 拍 / 1/4 拍 / 1/8 拍 / 三连音之一。", "error");
      return;
    }
    const startSample = anchorStartSample(note);
    const endSample = anchorEndSample(note);
    const newStartSample = quantizeSample(startSample);
    const newEndSample = Math.max(newStartSample + 1, quantizeSample(endSample));
    if (newStartSample === startSample && newEndSample === endSample) {
      setStatus(`音符 ${note.id} 已在网格上，无需量化。`, "success");
      return;
    }
    editGraph.begin(`量化音符 ${note.id}`);
    detachNoteAnchorIfShared(note, "start");
    detachNoteAnchorIfShared(note, "end");
    moveAnchor(note.startAnchorId, newStartSample);
    moveAnchor(note.endAnchorId, newEndSample);
    pruneAnchors();
    renderPianoRoll();
    updatePianoRollToolButtons();
    setStatus(`已量化音符 ${note.id} → ${anchorStartSeconds(note).toFixed(3)}–${anchorEndSeconds(note).toFixed(3)} 秒。`, "success");
  }

  // 钢琴卷帘工具按钮可用性：拆分需要选中；合并需要选中 + 候选；量化与删除需要选中。
  function updatePianoRollToolButtons() {
    const hasSelection = Boolean(state.selectedNoteId);
    const hasMergeCandidate = Boolean(state.pianoRollMergeCandidateId) && state.pianoRollMergeCandidateId !== state.selectedNoteId;
    if (elements.splitNoteButton) elements.splitNoteButton.disabled = !hasSelection;
    if (elements.mergeNoteButton) elements.mergeNoteButton.disabled = !(hasSelection && hasMergeCandidate);
    if (elements.quantizeNoteButton) elements.quantizeNoteButton.disabled = !hasSelection;
    if (elements.deleteNoteButton) elements.deleteNoteButton.disabled = !hasSelection;
  }

  // ---- 钢琴卷帘渲染 -----------------------------------------------------------
  // 横向是时间（与时间轴共用 timelineWidth），纵向是音高（C2..C7，60 半音）。
  // canvas 渲染音高网格（黑白键、C 标记），DOM 渲染音符块（便于拖动交互）。
  function renderPianoRoll() {
    if (!elements.pianoRollContent) return;
    const width = Math.max(timelineWidth(), 640);
    elements.pianoRollContent.style.width = `${width}px`;
    const height = (PIANO_ROLL_MAX_PITCH - PIANO_ROLL_MIN_PITCH + 1) * PIANO_ROLL_ROW_HEIGHT;
    elements.pianoRollContent.style.height = `${height}px`;
    drawPianoRollCanvas(width, height);
    // 重建音符块（保留 canvas，清空 grid 后重建）
    const grid = elements.pianoRollGrid;
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    state.notes.forEach(note => {
      const block = buildNoteBlock(note);
      if (block) grid.appendChild(block);
    });
    // 同步播放头
    if (state.audioUrl && state.analysis) {
      const playhead = document.createElement("div");
      playhead.className = "piano-roll-playhead";
      playhead.style.left = percentAt(elements.audio.currentTime);
      grid.appendChild(playhead);
    }
  }

  function drawPianoRollCanvas(width, height) {
    const canvas = elements.pianoRollCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(document.documentElement);
    const surface = style.getPropertyValue("--surface-soft").trim() || "#f8f9fc";
    const border = style.getPropertyValue("--border").trim() || "#d7dce5";
    const muted = style.getPropertyValue("--muted").trim() || "#667085";
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, width, height);
    for (let midi = PIANO_ROLL_MIN_PITCH; midi <= PIANO_ROLL_MAX_PITCH; midi += 1) {
      const y = (PIANO_ROLL_MAX_PITCH - midi) * PIANO_ROLL_ROW_HEIGHT;
      if (isBlackKey(midi)) {
        ctx.fillStyle = "rgba(0,0,0,0.06)";
        ctx.fillRect(0, y, width, PIANO_ROLL_ROW_HEIGHT);
      }
      if (midi % 12 === 0) {
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + PIANO_ROLL_ROW_HEIGHT);
        ctx.lineTo(width, y + PIANO_ROLL_ROW_HEIGHT);
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(midiToNoteName(midi), 4, y + PIANO_ROLL_ROW_HEIGHT - 3);
      }
    }
    if (state.analysis && state.duration > 0) {
      // P1.2 轮 3：垂直网格按当前 snap 网格绘制（含附点与 Swing）。
      // 无 snap 时回退到固定秒数网格；有 snap 时按网格点画，swing 偏移的奇数点用更浅色。
      const interval = snapIntervalSeconds();
      const tempo = topTempoCandidate();
      ctx.lineWidth = 1;
      if (interval > 0 && tempo) {
        const origin = finiteNumber(tempo.first_beat_seconds);
        const totalGrids = Math.ceil((state.duration - origin) / interval) + 2;
        for (let i = -1; i <= totalGrids; i += 1) {
          const baseTime = origin + i * interval;
          if (baseTime < -0.001 || baseTime > state.duration + 0.001) continue;
          const swingOffset = swingOffsetForIndex(i, interval);
          const time = baseTime + swingOffset;
          if (time < -0.001 || time > state.duration + 0.001) continue;
          const x = (time / state.duration) * width;
          // 偶数（含 0）= 强线，奇数 + 无 swing = 中等线，奇数 + swing = 浅线
          const isStrong = i % 2 === 0;
          const isSwung = swingOffset > 0;
          ctx.strokeStyle = isStrong ? border : (isSwung ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.28)");
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      } else {
        const targetSpacing = 86;
        const rawStep = state.duration / Math.max(1, Math.floor(width / targetSpacing));
        const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
        const step = candidates.find(value => value >= rawStep) || 120;
        ctx.strokeStyle = border;
        for (let time = 0; time <= state.duration + 1e-6; time += step) {
          const x = (time / state.duration) * width;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      }
    }
  }

  function buildNoteBlock(note) {
    const startSample = anchorStartSample(note);
    const endSample = anchorEndSample(note);
    const startSeconds = sampleToSeconds(startSample);
    const endSeconds = sampleToSeconds(endSample);
    if (endSeconds <= startSeconds) return null;
    const block = document.createElement("button");
    block.type = "button";
    block.className = "piano-roll-note";
    block.dataset.noteId = note.id;
    block.textContent = midiToNoteName(note.pitch);
    block.title = `${note.id} · ${midiToNoteName(note.pitch)} · ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · velocity ${(note.velocity * 100).toFixed(0)}% · 来源 ${note.source}`;
    block.style.left = percentAt(startSeconds);
    block.style.width = percentAt(Math.max(0, endSeconds - startSeconds));
    block.style.top = `${(PIANO_ROLL_MAX_PITCH - note.pitch) * PIANO_ROLL_ROW_HEIGHT}px`;
    block.style.height = `${PIANO_ROLL_ROW_HEIGHT - 1}px`;
    if (state.selectedNoteId === note.id) block.classList.add("selected");
    if (state.pianoRollMergeCandidateId === note.id) block.classList.add("merge-candidate");
    if (note.source === "transcription") block.classList.add("source-transcription");
    else if (note.source === "generation") block.classList.add("source-generation");
    block.addEventListener("pointerdown", event => beginNoteDrag(event, note));
    return block;
  }

  // ---- 钢琴卷帘交互 -----------------------------------------------------------
  // 行为：
  //   - 在空白区域 pointerdown + 拖动 → 创建新音符（吸附起止）
  //   - 在音符上 pointerdown 中间 → move 模式（整体移动）
  //   - 在音符上 pointerdown 左 8px → stretch-start
  //   - 在音符上 pointerdown 右 8px → stretch-end
  //   - 移动距离 < 4px 视为点击 → 选中（Shift 则设为合并候选）
  //   - 若被移动的 anchor 与其他对象共享，先克隆一个新 anchor 给当前音符。
  function beginNoteDrag(event, note) {
    if (!state.analysis || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetLeft = event.clientX - rect.left;
    const offsetRight = rect.right - event.clientX;
    const edgeTolerance = 8;
    let mode;
    if (offsetLeft <= edgeTolerance) mode = "stretch-start";
    else if (offsetRight <= edgeTolerance) mode = "stretch-end";
    else mode = "move";
    state.noteDrag = {
      noteId: note.id,
      mode,
      startClientX: event.clientX,
      startStartSample: anchorStartSample(note),
      startEndSample: anchorEndSample(note),
      startPitch: note.pitch,
      originalStartAnchorId: note.startAnchorId,
      originalEndAnchorId: note.endAnchorId,
      beganEdit: false,
      detachedStart: false,
      detachedEnd: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.addEventListener("pointermove", moveNote, true);
    document.addEventListener("pointerup", endNoteDrag, true);
    document.addEventListener("pointercancel", cancelNoteDrag, true);
  }

  function detachNoteAnchorIfShared(note, which) {
    const anchorId = which === "start" ? note.startAnchorId : note.endAnchorId;
    const sharedByNote = state.notes.some(other => other.id !== note.id && (other.startAnchorId === anchorId || other.endAnchorId === anchorId));
    const sharedByLyric = state.lyrics.some(r => r.startAnchorId === anchorId || r.endAnchorId === anchorId);
    const sharedByRest = state.rests.some(r => r.startAnchorId === anchorId || r.endAnchorId === anchorId);
    if (!sharedByNote && !sharedByLyric && !sharedByRest) return false;
    const original = state.anchors.get(anchorId);
    if (!original) return false;
    const cloned = createAnchorAtSample(original.sample);
    if (which === "start") {
      note.startAnchorId = cloned.id;
      state.noteDrag.detachedStart = true;
    } else {
      note.endAnchorId = cloned.id;
      state.noteDrag.detachedEnd = true;
    }
    return true;
  }

  function moveNote(event) {
    if (!state.noteDrag) return;
    if (state.noteDrag.mode === "create") return; // create 模式由 moveNoteCreate 处理
    if (Math.abs(event.clientX - state.noteDrag.startClientX) < 4 && !state.noteDrag.beganEdit) return;
    const note = state.notes.find(item => item.id === state.noteDrag.noteId);
    if (!note) return;
    if (!state.noteDrag.beganEdit) {
      editGraph.begin(state.noteDrag.mode === "move" ? `拖动音符 ${note.id}` : `拉伸音符 ${note.id}`);
      state.noteDrag.beganEdit = true;
      if (state.noteDrag.mode === "move" || state.noteDrag.mode === "stretch-start") {
        detachNoteAnchorIfShared(note, "start");
      }
      if (state.noteDrag.mode === "move" || state.noteDrag.mode === "stretch-end") {
        detachNoteAnchorIfShared(note, "end");
      }
    }
    event.preventDefault();
    event.stopPropagation();
    const pointerTime = snapTime(timeFromPianoPointer(event), event.altKey);
    const pointerSample = secondsToSample(pointerTime);
    const minSample = 0;
    const maxSample = Math.round(state.duration * state.sampleRateHz);
    const minimum = event.altKey ? 1 : Math.max(1, Math.round((snapIntervalSeconds() || 0.001) * state.sampleRateHz));
    if (state.noteDrag.mode === "move") {
      const durationSamples = state.noteDrag.startEndSample - state.noteDrag.startStartSample;
      const newStart = Math.max(minSample, Math.min(maxSample - durationSamples, pointerSample - Math.round(durationSamples / 2)));
      moveAnchor(note.startAnchorId, newStart);
      moveAnchor(note.endAnchorId, newStart + durationSamples);
    } else if (state.noteDrag.mode === "stretch-start") {
      const endSample = anchorEndSample(note);
      const newStart = Math.max(minSample, Math.min(endSample - minimum, pointerSample));
      moveAnchor(note.startAnchorId, newStart);
    } else if (state.noteDrag.mode === "stretch-end") {
      const startSample = anchorStartSample(note);
      const newEnd = Math.max(startSample + minimum, Math.min(maxSample, pointerSample));
      moveAnchor(note.endAnchorId, newEnd);
    }
    setSelection(anchorStartSeconds(note), anchorEndSeconds(note), false);
    renderPianoRoll();
  }

  function endNoteDrag(event) {
    if (!state.noteDrag) return;
    if (state.noteDrag.mode === "create") return;
    event.preventDefault();
    event.stopPropagation();
    const drag = state.noteDrag;
    state.noteDrag = null;
    document.removeEventListener("pointermove", moveNote, true);
    document.removeEventListener("pointerup", endNoteDrag, true);
    document.removeEventListener("pointercancel", cancelNoteDrag, true);
    if (!drag.beganEdit) {
      // 视为点击：选中音符（Shift 则设为合并候选）
      selectNote(drag.noteId, event.shiftKey);
      return;
    }
    pruneAnchors();
    const note = state.notes.find(item => item.id === drag.noteId);
    if (note) {
      setStatus(`${drag.mode === "move" ? "音符已移动到" : "音符已拉伸到"} ${anchorStartSeconds(note).toFixed(3)}–${anchorEndSeconds(note).toFixed(3)} 秒。`, "success");
    }
  }

  function cancelNoteDrag() {
    if (!state.noteDrag) return;
    if (state.noteDrag.mode === "create") return;
    const drag = state.noteDrag;
    state.noteDrag = null;
    document.removeEventListener("pointermove", moveNote, true);
    document.removeEventListener("pointerup", endNoteDrag, true);
    document.removeEventListener("pointercancel", cancelNoteDrag, true);
    if (drag.beganEdit) {
      editGraph.undoStack.pop();
      updateUndoRedoButtons();
    }
    const note = state.notes.find(item => item.id === drag.noteId);
    if (note) {
      if (drag.detachedStart) note.startAnchorId = drag.originalStartAnchorId;
      if (drag.detachedEnd) note.endAnchorId = drag.originalEndAnchorId;
    }
    pruneAnchors();
    renderPianoRoll();
    setStatus("系统取消了音符拖动，已恢复原位置。", "success");
  }

  // 钢琴卷帘空白处 pointerdown + 拖动 = 创建新音符。
  function beginNoteCreate(event) {
    if (!state.analysis || event.button !== 0) return;
    // 只在 grid 本体或 canvas（透明区域）响应，避免点音符也触发
    if (event.target !== elements.pianoRollGrid && event.target !== elements.pianoRollCanvas) return;
    event.preventDefault();
    event.stopPropagation();
    const startTime = snapTime(timeFromPianoPointer(event), event.altKey);
    const pitch = pitchFromPianoPointer(event);
    state.noteDrag = {
      noteId: null,
      mode: "create",
      startClientX: event.clientX,
      startTime,
      startPitch: pitch,
      currentEnd: startTime,
      beganEdit: false,
    };
    document.addEventListener("pointermove", moveNoteCreate, true);
    document.addEventListener("pointerup", endNoteCreate, true);
    document.addEventListener("pointercancel", cancelNoteCreate, true);
  }

  function moveNoteCreate(event) {
    if (!state.noteDrag || state.noteDrag.mode !== "create") return;
    event.preventDefault();
    const endTime = snapTime(timeFromPianoPointer(event), event.altKey);
    state.noteDrag.currentEnd = endTime;
    const existing = document.getElementById("piano-roll-note-preview");
    if (existing) existing.remove();
    const preview = document.createElement("div");
    preview.id = "piano-roll-note-preview";
    preview.className = "piano-roll-note preview";
    const startSec = Math.min(state.noteDrag.startTime, endTime);
    const endSec = Math.max(state.noteDrag.startTime, endTime);
    preview.style.left = percentAt(startSec);
    preview.style.width = percentAt(Math.max(0, endSec - startSec));
    preview.style.top = `${(PIANO_ROLL_MAX_PITCH - state.noteDrag.startPitch) * PIANO_ROLL_ROW_HEIGHT}px`;
    preview.style.height = `${PIANO_ROLL_ROW_HEIGHT - 1}px`;
    elements.pianoRollGrid.appendChild(preview);
  }

  function endNoteCreate(event) {
    if (!state.noteDrag || state.noteDrag.mode !== "create") return;
    event.preventDefault();
    const drag = state.noteDrag;
    state.noteDrag = null;
    document.removeEventListener("pointermove", moveNoteCreate, true);
    document.removeEventListener("pointerup", endNoteCreate, true);
    document.removeEventListener("pointercancel", cancelNoteCreate, true);
    const preview = document.getElementById("piano-roll-note-preview");
    if (preview) preview.remove();
    const startSec = Math.min(drag.startTime, drag.currentEnd);
    const endSec = Math.max(drag.startTime, drag.currentEnd);
    if (endSec - startSec < 0.02) {
      setStatus("音符太短，未创建。", "error");
      return;
    }
    editGraph.begin("新建音符");
    const note = createNote(state.pianoRollStemId, secondsToSample(startSec), secondsToSample(endSec), drag.startPitch);
    if (note) {
      state.selectedNoteId = note.id;
      state.pianoRollMergeCandidateId = null;
      renderPianoRoll();
      updatePianoRollToolButtons();
      setStatus(`已创建音符 ${note.id}：${midiToNoteName(note.pitch)} · ${startSec.toFixed(3)}–${endSec.toFixed(3)} 秒。`, "success");
    }
  }

  function cancelNoteCreate() {
    if (!state.noteDrag || state.noteDrag.mode !== "create") return;
    state.noteDrag = null;
    document.removeEventListener("pointermove", moveNoteCreate, true);
    document.removeEventListener("pointerup", endNoteCreate, true);
    document.removeEventListener("pointercancel", cancelNoteCreate, true);
    const preview = document.getElementById("piano-roll-note-preview");
    if (preview) preview.remove();
  }

  function timeFromPianoPointer(event) {
    const rect = elements.pianoRollContent.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / Math.max(1, rect.width) * state.duration, 0, state.duration);
  }

  function pitchFromPianoPointer(event) {
    const rect = elements.pianoRollContent.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const rowIndex = Math.floor(y / PIANO_ROLL_ROW_HEIGHT);
    const pitch = PIANO_ROLL_MAX_PITCH - rowIndex;
    return clamp(pitch, PIANO_ROLL_MIN_PITCH, PIANO_ROLL_MAX_PITCH);
  }

  function renderAll() {
    if (!state.analysis) return;
    setTimelineGeometry();
    renderRuler();
    renderSections();
    renderChords();
    renderLyrics();
    renderCanvas();
    renderSelection();
    renderLayerVisibility();
    renderStemMixer();
    applyStemMix();
    renderPianoRoll();
    updatePianoRollToolButtons();
    updateTransport();
  }

  function timeFromPointer(event) {
    const rect = elements.waveformLane.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / Math.max(1, rect.width) * state.duration, 0, state.duration);
  }

  function updateTransport() {
    const current = finiteNumber(elements.audio.currentTime);
    elements.playTime.textContent = `${formatTime(current)} / ${formatTime(state.duration)}`;
    if (state.audioUrl) {
      elements.playhead.hidden = false;
      elements.playhead.style.left = percentAt(current);
      // 播放时自动滚动跟随播放头，避免播放头跑出视口右侧。
      // 用户最近 1.5 秒内手动滚动过则暂停自动跟随，让用户能自由定位。
      if (!elements.audio.paused && state.analysis) {
        autoScrollToPlayhead(current);
      }
    } else {
      elements.playhead.hidden = true;
    }
    elements.playButton.textContent = elements.audio.paused ? "播放" : "暂停";
    // 同步钢琴卷帘播放头：renderPianoRoll 重建 grid 时会创建初始 playhead div，
    // 这里只更新它的 left，避免每帧重建 DOM。
    if (elements.pianoRollGrid) {
      const pianoPlayhead = elements.pianoRollGrid.querySelector(".piano-roll-playhead");
      if (pianoPlayhead) {
        if (state.audioUrl && state.analysis) {
          pianoPlayhead.style.left = percentAt(current);
          pianoPlayhead.style.display = "";
        } else {
          pianoPlayhead.style.display = "none";
        }
      }
    }
  }

  // 自动滚动策略：
  //   - 时间轴内容未溢出视口时不动作；
  //   - 播放头进入视口右 18% 区域时，把 scrollLeft 推到"播放头位于视口 18% 处"；
  //   - 播放头落在视口左侧之外时，向前追赶到"播放头位于视口 10% 处"；
  //   - 用户最近 1.5 秒内手动滚动过则跳过，避免抢走用户的主动定位。
  function autoScrollToPlayhead(currentTime) {
    const scroll = elements.timelineScroll;
    const contentWidth = elements.timelineContent.offsetWidth;
    const viewportWidth = scroll.clientWidth;
    if (!contentWidth || contentWidth <= viewportWidth) return;
    if (state.manualScrollAt && performance.now() - state.manualScrollAt < 1500) return;
    const playheadPx = (currentTime / state.duration) * contentWidth;
    const viewportLeft = scroll.scrollLeft;
    const viewportRight = viewportLeft + viewportWidth;
    const rightThreshold = viewportLeft + viewportWidth * 0.82;
    let target = null;
    if (playheadPx > rightThreshold) {
      target = playheadPx - viewportWidth * 0.18;
    } else if (playheadPx < viewportLeft) {
      target = playheadPx - viewportWidth * 0.10;
    }
    if (target === null) return;
    const clamped = Math.max(0, Math.min(contentWidth - viewportWidth, target));
    if (Math.abs(scroll.scrollLeft - clamped) < 1) return;
    // 标记为程序滚动，让 scroll 事件知道不要更新 manualScrollAt。
    state.programmaticScroll = true;
    scroll.scrollLeft = clamped;
    // 同步重置标记，下一次用户滚动事件到来时再正常记录。
    setTimeout(() => { state.programmaticScroll = false; }, 0);
  }

  // ---- 音频关联 ----------------------------------------------------------------

  async function handleAudioFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".wav")) {
      setStatus("当前技术原型只接受 WAV 音频。", "error");
      return;
    }
    if (file.size > 1024 * 1024 * 1024) {
      setStatus("WAV 超过 1 GB，当前技术原型拒绝载入。", "error");
      return;
    }
    releaseAudioUrl();
    state.audioUrl = bridge.createObjectUrl(file);
    state.audioFileName = file.name;
    state.audioDuration = null;
    state.audioSha256 = null;
    state.audioHashSkipped = false;
    elements.audio.src = state.audioUrl;
    elements.audioName.textContent = file.name;
    elements.playButton.disabled = false;
    elements.stopButton.disabled = false;
    setStatus(`已关联本地 WAV：${file.name}，正在核对时长和 SHA-256。`, "success");
    elements.audio.load();
    const urlAtStart = state.audioUrl;
    if (globalThis.crypto && crypto.subtle && file.size <= 256 * 1024 * 1024) {
      try {
        const fileHash = await bridge.sha256(file);
        if (state.audioUrl !== urlAtStart) return;
        state.audioSha256 = fileHash;
        checkAudioAssociation();
      } catch (error) {
        if (state.audioUrl === urlAtStart) setStatus(`WAV 已关联，但浏览器无法计算 SHA-256：${error.message}`, "error");
      }
    } else {
      state.audioHashSkipped = true;
      setStatus("WAV 已关联；文件超过 256 MB 或浏览器缺少 Web Crypto，本轮只核对时长，未核对 SHA-256。", "error");
      checkAudioAssociation();
    }
  }

  function releaseAudioUrl() {
    elements.audio.pause();
    elements.audio.removeAttribute("src");
    elements.audio.load();
    if (state.audioUrl) bridge.revokeObjectUrl(state.audioUrl);
    state.audioUrl = null;
    state.audioFileName = null;
    state.audioDuration = null;
    state.audioSha256 = null;
    state.audioHashSkipped = false;
    elements.playButton.disabled = true;
    elements.stopButton.disabled = true;
    elements.audioName.textContent = "尚未关联 WAV";
  }

  function checkAudioAssociation() {
    if (!state.audioUrl || !state.analysis) return;
    const problems = [];
    if (Number.isFinite(state.audioDuration) && Math.abs(state.audioDuration - state.duration) > 0.25) {
      problems.push(`WAV 时长 ${state.audioDuration.toFixed(3)} 秒与分析时长 ${state.duration.toFixed(3)} 秒不一致`);
    }
    const expectedHash = String(state.analysis.source_audio.sha256 || "").toLowerCase();
    if (expectedHash && state.audioSha256 && expectedHash !== state.audioSha256) problems.push("WAV SHA-256 与分析源文件不一致");
    if (problems.length) {
      setStatus(`音频关联警告：${problems.join("；")}。`, "error");
    } else if (Number.isFinite(state.audioDuration) && (!expectedHash || state.audioSha256)) {
      setStatus(`WAV 已关联并通过${expectedHash ? "时长与 SHA-256" : "时长"}核对。`, "success");
    } else if (Number.isFinite(state.audioDuration) && state.audioHashSkipped) {
      setStatus("WAV 时长与分析一致；SHA-256 未核对，不能确认它就是分析源文件。", "error");
    }
  }

  // ---- 歌词区域 / 休止创建与编辑 ----------------------------------------------

  // 把当前选区保存为歌词区域。在连续模式下，相邻歌词共享 anchor：
  //   previous.endAnchorId === new.startAnchorId
  //   new.endAnchorId === next.startAnchorId
  // 这是数据层的边界共享，移动 anchor 会同时改变两侧，从根上消除漏缝。
  function saveLyricRegion() {
    if (!state.analysis) return;
    let { start: startSeconds, end: endSeconds } = state.selection;
    const text = elements.lyricText.value.trim();
    const language = elements.lyricLanguage.value;
    if (!(endSeconds > startSeconds)) {
      setStatus("请先建立有效选区；结束时间必须大于开始时间。", "error");
      return;
    }
    if (!text) {
      setStatus("歌词不能为空。", "error");
      return;
    }
    if (!new Set(["zh", "ja"]).has(language)) {
      setStatus("首版只支持中文和日文歌词。", "error");
      return;
    }

    const existing = state.selectedLyricId ? state.lyrics.find(region => region.id === state.selectedLyricId) : null;
    const otherRegions = state.lyrics.filter(region => !existing || region.id !== existing.id).sort((a, b) => anchorStartSample(a) - anchorStartSample(b));
    const tolerance = Math.max(0.08, snapIntervalSeconds() * 1.05);

    // 1) 编辑现有歌词：保留原 anchor，只移动它们到新位置；
    //    若新位置与相邻区域产生共享边界，复用相邻 anchor。
    if (existing) {
      let linkedPrevious = null;
      let linkedNext = null;
      if (state.continuousLyrics) {
        linkedPrevious = otherRegions.filter(region => Math.abs(anchorEndSeconds(region) - anchorStartSeconds(existing)) <= tolerance).at(-1) || null;
        linkedNext = otherRegions.find(region => Math.abs(anchorStartSeconds(region) - anchorEndSeconds(existing)) <= tolerance) || null;
      }
      // 检查不与未参与共享的区域重叠
      const ignoredIds = new Set([existing.id, linkedPrevious && linkedPrevious.id, linkedNext && linkedNext.id].filter(Boolean));
      const overlap = state.lyrics.find(region => !ignoredIds.has(region.id) && startSeconds < anchorEndSeconds(region) - 1e-6 && endSeconds > anchorStartSeconds(region) + 1e-6);
      if (overlap) {
        setStatus("歌词区域与已有区域重叠；请调整边界，或编辑已有区域。", "error");
        return;
      }
      if (linkedPrevious && startSeconds <= anchorStartSeconds(linkedPrevious)) {
        setStatus("边界调整会吞掉相邻歌词区域，请缩小移动范围。", "error");
        return;
      }
      if (linkedNext && endSeconds >= anchorEndSeconds(linkedNext)) {
        setStatus("边界调整会吞掉相邻歌词区域，请缩小移动范围。", "error");
        return;
      }
      editGraph.begin(existing ? `编辑歌词 ${existing.id}` : "新建歌词");
      // 复用或创建 start anchor
      let startAnchor;
      if (linkedPrevious) {
        startAnchor = state.anchors.get(linkedPrevious.endAnchorId);
      } else {
        startAnchor = findAnchorBySample(secondsToSample(startSeconds)) || createAnchorAtSample(secondsToSample(startSeconds));
      }
      // 复用或创建 end anchor
      let endAnchor;
      if (linkedNext) {
        endAnchor = state.anchors.get(linkedNext.startAnchorId);
      } else {
        endAnchor = findAnchorBySample(secondsToSample(endSeconds)) || createAnchorAtSample(secondsToSample(endSeconds));
      }
      moveAnchor(startAnchor.id, secondsToSample(startSeconds));
      moveAnchor(endAnchor.id, secondsToSample(endSeconds));
      existing.startAnchorId = startAnchor.id;
      existing.endAnchorId = endAnchor.id;
      existing.language = language;
      existing.text = text;
      pruneAnchors();
      setStatus("已更新歌词区域；与相邻区域共享的边界会一起移动。", "success");
      endLyricEdit(true);
      return;
    }

    // 2) 新建歌词区域
    if (state.continuousLyrics) {
      const previous = otherRegions.filter(region => Math.abs(anchorEndSeconds(region) - startSeconds) <= tolerance).at(-1) || null;
      const next = otherRegions.find(region => Math.abs(anchorStartSeconds(region) - endSeconds) <= tolerance) || null;
      if (previous && Math.abs(anchorEndSeconds(previous) - startSeconds) <= tolerance) startSeconds = anchorEndSeconds(previous);
      if (next && Math.abs(anchorStartSeconds(next) - endSeconds) <= tolerance) endSeconds = anchorStartSeconds(next);
    }
    if (!(endSeconds > startSeconds)) {
      setStatus("吸附后的歌词区域没有有效长度，请调整边界或关闭吸附。", "error");
      return;
    }
    const ignoredIds = new Set();
    const overlap = state.lyrics.find(region => !ignoredIds.has(region.id) && startSeconds < anchorEndSeconds(region) - 1e-6 && endSeconds > anchorStartSeconds(region) + 1e-6);
    if (overlap) {
      setStatus("歌词区域与已有区域重叠；请调整边界，或编辑已有区域。", "error");
      return;
    }

    let startAnchor;
    let endAnchor;
    if (state.continuousLyrics) {
      const previous = otherRegions.filter(region => Math.abs(anchorEndSeconds(region) - startSeconds) <= tolerance).at(-1) || null;
      const next = otherRegions.find(region => Math.abs(anchorStartSeconds(region) - endSeconds) <= tolerance) || null;
      if (previous) startAnchor = state.anchors.get(previous.endAnchorId);
      if (next) endAnchor = state.anchors.get(next.startAnchorId);
    }
    if (!startAnchor) startAnchor = findAnchorBySample(secondsToSample(startSeconds)) || createAnchorAtSample(secondsToSample(startSeconds));
    if (!endAnchor) endAnchor = findAnchorBySample(secondsToSample(endSeconds)) || createAnchorAtSample(secondsToSample(endSeconds));

    editGraph.begin("新建歌词");
    let identifier;
    do {
      identifier = `lyric-${state.nextLyricId++}`;
    } while (state.lyrics.some(region => region.id === identifier));
    state.lyrics.push({
      id: identifier,
      startAnchorId: startAnchor.id,
      endAnchorId: endAnchor.id,
      language,
      text,
    });
    setStatus("已建立歌词区域；与相邻区域共享的边界会一起移动。", "success");
    endLyricEdit(true);
  }

  function deleteLyric() {
    if (!state.selectedLyricId) return;
    if (isLocked("lyric", state.selectedLyricId)) {
      setStatus("此歌词已锁定；请先在检查器取消锁定再删除。", "error");
      return;
    }
    editGraph.begin(`删除歌词 ${state.selectedLyricId}`);
    state.lyrics = state.lyrics.filter(region => region.id !== state.selectedLyricId);
    // 锁定状态随对象一起清除，避免遗留无主锁定项。
    setLocked("lyric", state.selectedLyricId, false);
    pruneAnchors();
    endLyricEdit(true);
    setStatus("歌词区域已删除；引用的 anchor 已清理。", "success");
  }

  function convertSelectionToRest() {
    if (!state.analysis) return;
    const { start, end } = state.selection;
    if (!(end > start)) {
      setStatus("请先选择一段未分配区域再转为休止。", "error");
      return;
    }
    // 与现有 lyrics/rests 不能重叠
    const overlapLyric = state.lyrics.find(region => start < anchorEndSeconds(region) - 1e-6 && end > anchorStartSeconds(region) + 1e-6);
    if (overlapLyric) {
      setStatus("休止不能与已有歌词区域重叠。", "error");
      return;
    }
    const overlapRest = state.rests.find(rest => start < anchorEndSeconds(rest) - 1e-6 && end > anchorStartSeconds(rest) + 1e-6);
    if (overlapRest) {
      setStatus("休止不能与已有休止重叠。", "error");
      return;
    }
    // 复用相邻 anchor（与歌词区域相同规则）
    const tolerance = Math.max(0.08, snapIntervalSeconds() * 1.05);
    const previousLyric = state.lyrics.filter(region => Math.abs(anchorEndSeconds(region) - start) <= tolerance).at(-1) || null;
    const previousRest = state.rests.filter(rest => Math.abs(anchorEndSeconds(rest) - start) <= tolerance).at(-1) || null;
    const nextLyric = state.lyrics.find(region => Math.abs(anchorStartSeconds(region) - end) <= tolerance) || null;
    const nextRest = state.rests.find(rest => Math.abs(anchorStartSeconds(rest) - end) <= tolerance) || null;
    let startAnchor;
    let endAnchor;
    if (previousLyric) startAnchor = state.anchors.get(previousLyric.endAnchorId);
    else if (previousRest) startAnchor = state.anchors.get(previousRest.endAnchorId);
    if (nextLyric) endAnchor = state.anchors.get(nextLyric.startAnchorId);
    else if (nextRest) endAnchor = state.anchors.get(nextRest.startAnchorId);
    if (!startAnchor) startAnchor = findAnchorBySample(secondsToSample(start)) || createAnchorAtSample(secondsToSample(start));
    if (!endAnchor) endAnchor = findAnchorBySample(secondsToSample(end)) || createAnchorAtSample(secondsToSample(end));
    editGraph.begin("新建休止");
    let identifier;
    do {
      identifier = `rest-${state.nextRestId++}`;
    } while (state.rests.some(rest => rest.id === identifier));
    state.rests.push({
      id: identifier,
      startAnchorId: startAnchor.id,
      endAnchorId: endAnchor.id,
      kind: "rest",
    });
    setStatus(`已建立显式休止 ${start.toFixed(3)}–${end.toFixed(3)} 秒。`, "success");
    editRest(identifier);
  }

  function deleteRest(id) {
    if (isLocked("rest", id)) {
      setStatus("此休止已锁定；请先在检查器取消锁定再删除。", "error");
      return;
    }
    editGraph.begin(`删除休止 ${id}`);
    state.rests = state.rests.filter(rest => rest.id !== id);
    setLocked("rest", id, false);
    pruneAnchors();
    hideRestInspector();
    renderLyrics();
    setStatus("显式休止已删除，原区域恢复为未分配空段。", "success");
  }

  // ---- 共享边手柄：拖动 anchor 同时改变两侧 region ----------------------------

  function beginEdgeDrag(event, anchorId) {
    if (!state.analysis || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = state.anchors.get(anchorId);
    state.edgeDragging = {
      anchorId,
      startSample: anchor ? anchor.sample : 0,
      previousSample: anchor ? anchor.sample : 0,
      beganEdit: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveEdge(event) {
    if (!state.edgeDragging) return;
    event.preventDefault();
    event.stopPropagation();
    const time = snapTime(timeFromPointer(event), event.altKey);
    const newSample = secondsToSample(time);
    // 不允许跨越两侧 region 的另一端 anchor
    const consumers = [...state.lyrics, ...state.rests].filter(region => region.startAnchorId === state.edgeDragging.anchorId || region.endAnchorId === state.edgeDragging.anchorId);
    let minSample = 0;
    let maxSample = Math.round(state.duration * state.sampleRateHz);
    consumers.forEach(region => {
      if (region.startAnchorId === state.edgeDragging.anchorId) {
        const endSample = anchorEndSample(region);
        if (endSample < maxSample) maxSample = endSample;
      }
      if (region.endAnchorId === state.edgeDragging.anchorId) {
        const startSample = anchorStartSample(region);
        if (startSample > minSample) minSample = startSample;
      }
    });
    const minimum = event.altKey ? 1 : Math.max(1, Math.round((snapIntervalSeconds() || 0.001) * state.sampleRateHz));
    const clamped = Math.max(minSample + minimum, Math.min(maxSample - minimum, newSample));
    // 首次实际移动时记录撤销点（避免没移动也写一条 undo 记录）
    if (!state.edgeDragging.beganEdit && clamped !== state.edgeDragging.startSample) {
      editGraph.begin("拖动共享边界");
      state.edgeDragging.beganEdit = true;
    }
    moveAnchor(state.edgeDragging.anchorId, clamped);
    // 同步选区到正在编辑的 region（如果有）
    if (state.selectedLyricId) {
      const region = state.lyrics.find(item => item.id === state.selectedLyricId);
      if (region) setSelection(anchorStartSeconds(region), anchorEndSeconds(region), false);
    } else if (state.selectedRestId) {
      const rest = state.rests.find(item => item.id === state.selectedRestId);
      if (rest) setSelection(anchorStartSeconds(rest), anchorEndSeconds(rest), false);
    }
    renderLyrics();
  }

  function endEdgeDrag(event) {
    if (!state.edgeDragging) return;
    event.preventDefault();
    event.stopPropagation();
    const anchorId = state.edgeDragging.anchorId;
    const beganEdit = state.edgeDragging.beganEdit;
    state.edgeDragging = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (error) { /* pointer already released */ }
    const anchor = state.anchors.get(anchorId);
    if (anchor) {
      if (!beganEdit) {
        // 没真正移动，不报告"已移动"
      } else {
        setStatus(`共享边界已移动到 ${sampleToSeconds(anchor.sample).toFixed(3)} 秒。`, "success");
      }
    }
  }

  function cancelEdgeDrag() {
    if (!state.edgeDragging) return;
    const anchorId = state.edgeDragging.anchorId;
    const previous = state.edgeDragging.previousSample;
    const beganEdit = state.edgeDragging.beganEdit;
    state.edgeDragging = null;
    moveAnchor(anchorId, previous);
    if (beganEdit) {
      // 取消拖动：丢弃这次刚记录的撤销点，避免无效 undo 步骤。
      editGraph.undoStack.pop();
      updateUndoRedoButtons();
    }
    renderLyrics();
    setStatus("系统取消了共享边移动，已恢复原边界。", "success");
  }

  function nudgeEdge(event, anchorId) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.key === "ArrowRight" ? 1 : -1) * (snapIntervalSeconds() || 0.01);
    const anchor = state.anchors.get(anchorId);
    if (!anchor) return;
    editGraph.begin("微调共享边界");
    moveAnchor(anchorId, anchor.sample + secondsToSample(delta));
    renderLyrics();
    setStatus(`共享边界已微调到 ${sampleToSeconds(anchor.sample).toFixed(3)} 秒。`, "success");
  }

  // ---- 和弦修正 ----------------------------------------------------------------

  function saveChordOverride() {
    const window = selectedChordWindow();
    const label = elements.chordLabel.value.trim();
    if (!window || !label) {
      setStatus("请选择和弦候选并输入修正值。", "error");
      return;
    }
    editGraph.begin(`修正和弦 ${label}`);
    const key = chordKey(window);
    state.chordOverrides[key] = {
      label,
      original_label: topChord(window) ? topChord(window).label : null,
      start_seconds: finiteNumber(window.start_seconds),
      end_seconds: finiteNumber(window.end_seconds),
      status: "user-confirmed",
    };
    setStatus(`已把和弦候选修正为 ${label}；源分析值仍保留。`, "success");
    selectChord(window);
  }

  function restoreChord() {
    const window = selectedChordWindow();
    if (!window) return;
    const key = chordKey(window);
    if (isLocked("chord", key)) {
      setStatus("此和弦修正已锁定；请先在检查器取消锁定再恢复分析值。", "error");
      return;
    }
    editGraph.begin("恢复和弦");
    delete state.chordOverrides[key];
    setLocked("chord", key, false);
    elements.chordLabel.value = topChord(window) ? topChord(window).label : "";
    setStatus("已恢复原分析候选。", "success");
    selectChord(window);
  }

  // ---- 项目导入 / 导出 --------------------------------------------------------

  function serializeAnchors() {
    return Array.from(state.anchors.values()).map(anchor => ({
      id: anchor.id,
      sample: anchor.sample,
      tick: anchor.tick,
    }));
  }

  function exportProject() {
    if (!state.analysis) return;
    const project = {
      schema_version: PROJECT_SCHEMA,
      title: "Miku 歌姬解放计划 · 工作台原型项目",
      source_audio: {
        ...state.analysis.source_audio,
        local_file_name: state.audioFileName,
        relink_required_after_import: true,
      },
      analysis: state.analysis,
      tempo_map: {
        sample_rate_hz: state.tempoMap.sampleRateHz,
        ppq: state.tempoMap.ppq,
        bpm: state.tempoMap.bpm,
        first_beat_seconds: state.tempoMap.firstBeatSeconds,
        first_beat_sample: state.tempoMap.firstBeatSample,
        first_beat_tick: state.tempoMap.firstBeatTick,
      },
      anchors: serializeAnchors(),
      editing: {
        selection: state.selection,
        lyrics: state.lyrics.map(region => ({
          id: region.id,
          start_anchor_id: region.startAnchorId,
          end_anchor_id: region.endAnchorId,
          language: region.language,
          text: region.text,
        })),
        rests: state.rests.map(rest => ({
          id: rest.id,
          start_anchor_id: rest.startAnchorId,
          end_anchor_id: rest.endAnchorId,
          kind: rest.kind,
        })),
        chord_overrides: state.chordOverrides,
        locked_fields: serializeLockedFields(),
        // stem 轨混音参数（非破坏编辑）随项目持久化；占位 stem 也保存参数，
        // 后续接入分离后端时可以复用用户已有的混音设置。
        // P1.2 轮 4：trim/fade 字段一并持久化，重新打开项目后恢复 A/B 试听边界。
        stem_tracks: state.stemTracks.map(track => ({
          id: track.id,
          name: track.name,
          role: track.role,
          mute: track.mute,
          solo: track.solo,
          gain: track.gain,
          pan: track.pan,
          source: track.source,
          trim_start_seconds: finiteNumber(track.trimStartSeconds, 0),
          trim_end_seconds: finiteNumber(track.trimEndSeconds, 0),
          fade_in_seconds: finiteNumber(track.fadeInSeconds, 0),
          fade_out_seconds: finiteNumber(track.fadeOutSeconds, 0),
        })),
        // 音符候选（P1.2 轮 2 起）随项目持久化；引用 anchor 与 stem。
        notes: state.notes.map(note => ({
          id: note.id,
          stem_id: note.stemId,
          start_anchor_id: note.startAnchorId,
          end_anchor_id: note.endAnchorId,
          pitch: note.pitch,
          velocity: note.velocity,
          confidence: note.confidence,
          source: note.source,
        })),
        preferences: {
          snap_mode: state.snapMode,
          continuous_lyrics: state.continuousLyrics,
          dotted_snap: state.dottedSnap,
          swing_amount: state.swingAmount,
          // P1.2 轮 4：试听模式（edited / original）随项目持久化。
          stem_preview_mode: state.stemPreviewMode,
        },
      },
    };
    bridge.downloadJson("miku-workbench-project.json", project);
    setStatus("项目已导出。音频本体未写入项目，请在重新打开后手动关联。", "success");
  }

  function importAnchorsAndRegions(project, analysis) {
    // 重建 TempoMap 以便校验 anchor.tick 是否与 sample 一致；不一致时以 sample 为准。
    const tempoMap = buildTempoMap(analysis);
    state.tempoMap = tempoMap;
    state.sampleRateHz = tempoMap.sampleRateHz;

    const anchors = Array.isArray(project.anchors) ? project.anchors : [];
    state.anchors.clear();
    let maxAnchorNumber = 0;
    anchors.forEach(entry => {
      if (!entry || typeof entry.id !== "string" || !entry.id) throw new Error(`anchor 条目缺少 id。`);
      if (state.anchors.has(entry.id)) throw new Error(`anchor ID 重复：${entry.id}。`);
      const sample = Math.max(0, Math.min(Math.round(finiteNumber(entry.sample)), Math.round(state.duration * state.sampleRateHz)));
      const anchor = { id: entry.id, sample, tick: sampleToTick(sample) };
      // 写入的 tick 与重算的 tick 不一致时以 sample 为权威；只记录不抛错。
      state.anchors.set(entry.id, anchor);
      const match = /^anchor-(\d+)$/.exec(entry.id);
      if (match) maxAnchorNumber = Math.max(maxAnchorNumber, Number(match[1]));
    });
    state.nextAnchorId = Math.max(state.nextAnchorId, maxAnchorNumber + 1);

    const editing = project.editing || {};
    const seenLyricIds = new Set();
    let maximumLyricNumber = 0;
    const lyrics = Array.isArray(editing.lyrics) ? editing.lyrics.map((region, index) => {
      if (!region || typeof region !== "object") throw new Error(`歌词区域 ${index + 1} 无效。`);
      if (!new Set(["zh", "ja"]).has(region.language)) throw new Error(`歌词区域 ${index + 1} 使用不支持的语言；首版只接受 zh/ja。`);
      const startAnchorId = String(region.start_anchor_id || "");
      const endAnchorId = String(region.end_anchor_id || "");
      if (!state.anchors.has(startAnchorId) || !state.anchors.has(endAnchorId)) {
        throw new Error(`歌词区域 ${index + 1} 引用了不存在的 anchor。`);
      }
      if (startAnchorId === endAnchorId) throw new Error(`歌词区域 ${index + 1} 的起止 anchor 不能相同。`);
      if (!String(region.text || "").trim()) throw new Error(`歌词区域 ${index + 1} 的文本为空。`);
      const id = String(region.id || `lyric-${index + 1}`);
      if (seenLyricIds.has(id)) throw new Error(`歌词区域 ID 重复：${id}。`);
      seenLyricIds.add(id);
      const match = /^lyric-(\d+)$/.exec(id);
      if (match) maximumLyricNumber = Math.max(maximumLyricNumber, Number(match[1]));
      return {
        id,
        startAnchorId,
        endAnchorId,
        language: region.language,
        text: String(region.text).trim(),
      };
    }) : [];
    state.lyrics = lyrics;
    state.nextLyricId = Math.max(1, maximumLyricNumber + 1);

    const seenRestIds = new Set();
    let maximumRestNumber = 0;
    const rests = Array.isArray(editing.rests) ? editing.rests.map((rest, index) => {
      if (!rest || typeof rest !== "object") throw new Error(`休止 ${index + 1} 无效。`);
      if (rest.kind !== "rest") throw new Error(`休止 ${index + 1} 的 kind 不被支持；首版只接受 rest。`);
      const startAnchorId = String(rest.start_anchor_id || "");
      const endAnchorId = String(rest.end_anchor_id || "");
      if (!state.anchors.has(startAnchorId) || !state.anchors.has(endAnchorId)) {
        throw new Error(`休止 ${index + 1} 引用了不存在的 anchor。`);
      }
      if (startAnchorId === endAnchorId) throw new Error(`休止 ${index + 1} 的起止 anchor 不能相同。`);
      const id = String(rest.id || `rest-${index + 1}`);
      if (seenRestIds.has(id)) throw new Error(`休止 ID 重复：${id}。`);
      seenRestIds.add(id);
      const match = /^rest-(\d+)$/.exec(id);
      if (match) maximumRestNumber = Math.max(maximumRestNumber, Number(match[1]));
      return { id, startAnchorId, endAnchorId, kind: "rest" };
    }) : [];
    state.rests = rests;
    state.nextRestId = Math.max(1, maximumRestNumber + 1);

    // 同一主唱轨上的歌词区域不能重叠；和声请使用独立声部轨。
    const orderedLyrics = lyrics.slice().sort((a, b) => anchorStartSample(a) - anchorStartSample(b));
    for (let index = 1; index < orderedLyrics.length; index += 1) {
      if (anchorStartSample(orderedLyrics[index]) < anchorEndSample(orderedLyrics[index - 1]) - 1) {
        throw new Error("同一主唱轨上的歌词区域不能重叠；和声请使用独立声部轨。");
      }
    }
    // 休止也不能与歌词或其他休止重叠
    const allRegions = [...lyrics, ...rests];
    for (let outer = 0; outer < allRegions.length; outer += 1) {
      for (let inner = outer + 1; inner < allRegions.length; inner += 1) {
        const a = allRegions[outer];
        const b = allRegions[inner];
        const overlap = anchorStartSample(a) < anchorEndSample(b) - 1 && anchorEndSample(a) > anchorStartSample(b) + 1;
        if (overlap) throw new Error("歌词或休止区域之间存在重叠。");
      }
    }

    // 加载字段级锁定：只保留指向当前项目中仍存在的 lyric/rest/chord 的项。
    const rawLocked = Array.isArray(editing.locked_fields) ? editing.locked_fields : [];
    const validLyricIds = new Set(lyrics.map(region => region.id));
    const validRestIds = new Set(rests.map(rest => rest.id));
    const validChordKeys = new Set(analysis.analysis.chords.windows.map(window => chordKey(window)));
    const lockedFields = new Set();
    rawLocked.forEach(entry => {
      if (typeof entry !== "string") return;
      // chordKey 本身含 ":"，所以这里只在第一个冒号处分割。
      const colonIndex = entry.indexOf(":");
      if (colonIndex < 0) return;
      const type = entry.slice(0, colonIndex);
      const id = entry.slice(colonIndex + 1);
      if (!type || !id) return;
      if (type === "lyric" && validLyricIds.has(id)) lockedFields.add(entry);
      else if (type === "rest" && validRestIds.has(id)) lockedFields.add(entry);
      else if (type === "chord" && validChordKeys.has(id)) lockedFields.add(entry);
      // 静默丢弃指向已删除对象的锁定项，不抛错。
    });
    state.lockedFields = lockedFields;

    // 加载 stem 轨混音参数；缺失或损坏时回退到默认 stem 集，保证向前兼容。
    // 0.2.0 项目早期版本可能没有 stem_tracks 字段；这种情况视为新建项目。
    // P1.2 轮 4：trim/fade 字段也一并加载并 clamp 到 0..duration；早期版本缺失时回退到 0。
    const rawStemTracks = Array.isArray(editing.stem_tracks) ? editing.stem_tracks : [];
    const validStemIds = new Set(["master", "drums", "bass", "other"]);
    const durationUpper = Math.max(0, state.duration);
    const loadedStemTracks = rawStemTracks
      .filter(track => track && typeof track === "object" && typeof track.id === "string" && validStemIds.has(track.id))
      .map(track => ({
        id: track.id,
        name: typeof track.name === "string" && track.name.trim() ? track.name.trim() : track.id,
        role: typeof track.role === "string" ? track.role : track.id,
        mute: Boolean(track.mute),
        solo: Boolean(track.solo),
        gain: clamp(finiteNumber(track.gain, 1.0), 0, 1.5),
        pan: clamp(finiteNumber(track.pan, 0), -1, 1),
        source: track.source === "main" ? "main" : "placeholder",
        // P1.2 轮 4：trim/fade 字段向前兼容；旧项目缺失或字段非有限数时回退到 0。
        // trim_end_seconds = 0 在 stemEffectiveTrimRange 中表示"不裁切，到音频结尾"。
        trimStartSeconds: clamp(finiteNumber(track.trim_start_seconds, 0), 0, durationUpper),
        trimEndSeconds: clamp(finiteNumber(track.trim_end_seconds, 0), 0, durationUpper),
        fadeInSeconds: Math.max(0, finiteNumber(track.fade_in_seconds, 0)),
        fadeOutSeconds: Math.max(0, finiteNumber(track.fade_out_seconds, 0)),
      }));
    // 必须存在 master 轨；缺失时整套回退到默认。
    state.stemTracks = loadedStemTracks.some(track => track.id === "master")
      ? loadedStemTracks
      : defaultStemTracks();

    // P1.2 轮 4：加载偏好集合（snap/continuous/dotted/swing/stem_preview_mode）。
    // 此前 0.2.0 项目导入时偏好未恢复，这里一并补齐。
    const importedPreferences = editing.preferences && typeof editing.preferences === "object" ? editing.preferences : {};
    if (new Set(["beat", "half-beat", "quarter-beat", "eighth-beat", "triplet-half", "triplet-quarter", "none"]).has(importedPreferences.snap_mode)) {
      state.snapMode = importedPreferences.snap_mode;
    }
    state.continuousLyrics = importedPreferences.continuous_lyrics !== false;
    state.dottedSnap = importedPreferences.dotted_snap === true;
    const importedSwing = Number(importedPreferences.swing_amount);
    state.swingAmount = Number.isFinite(importedSwing) ? Math.max(0, Math.min(0.7, importedSwing)) : 0;
    state.stemPreviewMode = importedPreferences.stem_preview_mode === "original" ? "original" : "edited";
    if (elements.snapGrid) elements.snapGrid.value = state.snapMode;
    if (elements.continuousLyrics) elements.continuousLyrics.checked = state.continuousLyrics;
    if (elements.dottedSnap) elements.dottedSnap.checked = state.dottedSnap;
    if (elements.swingAmount) elements.swingAmount.value = String(state.swingAmount);
    if (elements.stemPreviewMode) elements.stemPreviewMode.value = state.stemPreviewMode;

    // 加载音符候选（P1.2 轮 2 起）。0.2.0 早期项目可能没有 notes 字段；这种情况视为没有音符。
    const rawNotes = Array.isArray(editing.notes) ? editing.notes : [];
    const validStemIdsForNotes = new Set(state.stemTracks.map(track => track.id));
    const seenNoteIds = new Set();
    let maximumNoteNumber = 0;
    const notes = rawNotes.map((entry, index) => {
      if (!entry || typeof entry !== "object") throw new Error(`音符 ${index + 1} 无效。`);
      const id = String(entry.id || `note-${index + 1}`);
      if (seenNoteIds.has(id)) throw new Error(`音符 ID 重复：${id}。`);
      seenNoteIds.add(id);
      const startAnchorId = String(entry.start_anchor_id || "");
      const endAnchorId = String(entry.end_anchor_id || "");
      if (!state.anchors.has(startAnchorId) || !state.anchors.has(endAnchorId)) {
        throw new Error(`音符 ${id} 引用了不存在的 anchor。`);
      }
      if (startAnchorId === endAnchorId) throw new Error(`音符 ${id} 的起止 anchor 不能相同。`);
      const stemId = validStemIdsForNotes.has(entry.stem_id) ? entry.stem_id : "master";
      const match = /^note-(\d+)$/.exec(id);
      if (match) maximumNoteNumber = Math.max(maximumNoteNumber, Number(match[1]));
      return {
        id,
        stemId,
        startAnchorId,
        endAnchorId,
        pitch: clamp(Math.round(finiteNumber(entry.pitch, 60)), PIANO_ROLL_MIN_PITCH, PIANO_ROLL_MAX_PITCH),
        velocity: clamp(finiteNumber(entry.velocity, 0.8), 0, 1),
        confidence: clamp(finiteNumber(entry.confidence, 0), 0, 1),
        source: ["manual", "transcription", "generation"].includes(entry.source) ? entry.source : "manual",
      };
    });
    state.notes = notes;
    state.nextNoteId = Math.max(1, maximumNoteNumber + 1);
    state.selectedNoteId = null;
    state.pianoRollMergeCandidateId = null;
  }

  // 把 0.1.0 项目的秒数边界迁移到 0.2.0 的 anchor 表。
  // 相邻歌词（previous.end ≈ next.start within tolerance）共享同一个 anchor。
  function migrateLegacyProject(project, analysis) {
    const editing = project.editing || {};
    const legacyLyrics = Array.isArray(editing.lyrics) ? editing.lyrics : [];
    const sampleRateHz = finiteNumber(analysis.source_audio.sample_rate_hz, 48000);
    state.sampleRateHz = sampleRateHz;
    state.tempoMap = buildTempoMap(analysis);

    const tolerance = 0.005;
    const sortedLegacy = legacyLyrics
      .map((region, index) => ({
        id: String(region.id || `lyric-${index + 1}`),
        language: region.language,
        text: String(region.text || "").trim(),
        startSeconds: clamp(finiteNumber(region.start), 0, analysis.source_audio.duration_seconds),
        endSeconds: clamp(finiteNumber(region.end), 0, analysis.source_audio.duration_seconds),
      }))
      .filter(region => region.endSeconds > region.startSeconds && region.text)
      .sort((a, b) => a.startSeconds - b.startSeconds);

    state.anchors.clear();
    state.lyrics = [];
    state.rests = [];
    state.nextAnchorId = 1;
    state.nextLyricId = 1;
    state.nextRestId = 1;
    // 0.1.0 项目没有锁定字段概念；迁移时清空，避免上一项目的锁定残留。
    state.lockedFields = new Set();
    // 0.1.0 项目没有 stem_tracks 字段；迁移时回退到默认 stem 集。
    state.stemTracks = defaultStemTracks();
    // P1.2 轮 4：0.1.0 项目没有 stem_preview_mode 字段；迁移时回退到 edited。
    state.stemPreviewMode = "edited";
    if (elements.stemPreviewMode) elements.stemPreviewMode.value = "edited";
    // 0.1.0 项目没有 notes 字段；迁移时清空音符候选。
    state.notes = [];
    state.nextNoteId = 1;
    state.selectedNoteId = null;
    state.pianoRollMergeCandidateId = null;
    state.pianoRollStemId = "master";
    if (elements.pianoRollStemSelect) elements.pianoRollStemSelect.value = "master";

    let previousEndAnchorId = null;
    sortedLegacy.forEach((legacy, index) => {
      let startAnchorId;
      if (previousEndAnchorId) {
        const previousEnd = sampleToSeconds(state.anchors.get(previousEndAnchorId).sample);
        if (Math.abs(previousEnd - legacy.startSeconds) <= tolerance) {
          startAnchorId = previousEndAnchorId;
        }
      }
      if (!startAnchorId) {
        const existing = findAnchorBySample(secondsToSample(legacy.startSeconds));
        const anchor = existing || createAnchorAtSample(secondsToSample(legacy.startSeconds));
        startAnchorId = anchor.id;
      }
      const existingEnd = findAnchorBySample(secondsToSample(legacy.endSeconds));
      const endAnchor = existingEnd || createAnchorAtSample(secondsToSample(legacy.endSeconds));
      state.lyrics.push({
        id: legacy.id,
        startAnchorId,
        endAnchorId: endAnchor.id,
        language: legacy.language,
        text: legacy.text,
      });
      previousEndAnchorId = endAnchor.id;
      const match = /^lyric-(\d+)$/.exec(legacy.id);
      if (match) state.nextLyricId = Math.max(state.nextLyricId, Number(match[1]) + 1);
    });

    const rawOverrides = editing.chord_overrides === undefined ? {} : editing.chord_overrides;
    if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) throw new Error("和弦修正层必须是对象。");
    const validChordKeys = new Set(analysis.analysis.chords.windows.map(window => chordKey(window)));
    const overrides = {};
    Object.entries(rawOverrides).forEach(([key, override]) => {
      if (!validChordKeys.has(key) || !override || typeof override !== "object" || typeof override.label !== "string" || !override.label.trim()) {
        throw new Error(`和弦修正 ${key} 无效或不属于当前分析。`);
      }
      if (!Number.isFinite(Number(override.start_seconds)) || !Number.isFinite(Number(override.end_seconds)) || override.status !== "user-confirmed") {
        throw new Error(`和弦修正 ${key} 的时间或状态无效。`);
      }
      overrides[key] = { ...override, label: override.label.trim() };
    });
    state.chordOverrides = overrides;

    const preferences = editing.preferences && typeof editing.preferences === "object" ? editing.preferences : {};
    // P1.2 轮 3：偏好集合扩展，接受新网格与 swing 设置；旧版项目缺失时回退默认。
    if (new Set(["beat", "half-beat", "quarter-beat", "eighth-beat", "triplet-half", "triplet-quarter", "none"]).has(preferences.snap_mode)) {
      state.snapMode = preferences.snap_mode;
    }
    state.continuousLyrics = preferences.continuous_lyrics !== false;
    state.dottedSnap = preferences.dotted_snap === true;
    const swingValue = Number(preferences.swing_amount);
    state.swingAmount = Number.isFinite(swingValue) ? Math.max(0, Math.min(0.7, swingValue)) : 0;
    elements.snapGrid.value = state.snapMode;
    elements.continuousLyrics.checked = state.continuousLyrics;
    if (elements.dottedSnap) elements.dottedSnap.checked = state.dottedSnap;
    if (elements.swingAmount) elements.swingAmount.value = String(state.swingAmount);
    const selection = editing.selection || {};
    return { selection };
  }

  async function importProject(file) {
    const candidate = await readJsonFile(file);
    if (candidate.schema_version !== PROJECT_SCHEMA && candidate.schema_version !== PROJECT_SCHEMA_LEGACY) {
      throw new Error(`不支持的项目版本：${String(candidate.schema_version || "缺失")}。`);
    }
    const analysis = validateAnalysis(candidate.analysis);
    releaseAudioUrl();
    applyAnalysis(analysis, false);

    if (candidate.schema_version === PROJECT_SCHEMA_LEGACY) {
      // 旧版项目：把秒数边界迁移到共享 anchor 模型
      const { selection } = migrateLegacyProject(candidate, analysis);
      setSelection(finiteNumber(selection.start), finiteNumber(selection.end), false);
      setStatus("已导入 0.1.0 项目并迁移到 0.2.0 共享 anchor 模型；请重新选择本地 WAV 才能播放。", "success");
    } else {
      // 0.2.0 项目：直接加载 anchor 与 region
      // 注意 importAnchorsAndRegions 内部已处理 editing.preferences，这里只取 selection。
      importAnchorsAndRegions(candidate, analysis);
      const editing = candidate.editing || {};
      const selection = editing.selection || {};
      setSelection(finiteNumber(selection.start), finiteNumber(selection.end), false);
      setStatus("项目已导入；分析和编辑状态已恢复，请重新选择本地 WAV 才能播放。", "success");
    }

    elements.audioName.textContent = candidate.source_audio && candidate.source_audio.local_file_name ? `${candidate.source_audio.local_file_name}（需要重新关联）` : "需要重新关联 WAV";
    renderAll();
  }

  // ---- 事件绑定 ---------------------------------------------------------------

  elements.analysisFile.addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const candidate = validateAnalysis(await readJsonFile(file));
      applyAnalysis(candidate);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      event.target.value = "";
    }
  });

  elements.audioFile.addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (file) await handleAudioFile(file);
    event.target.value = "";
  });

  elements.importProjectButton.addEventListener("click", () => elements.projectFile.click());
  elements.projectFile.addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      await importProject(file);
    } catch (error) {
      setStatus(`项目导入失败：${error.message}`, "error");
    } finally {
      event.target.value = "";
    }
  });
  elements.exportProjectButton.addEventListener("click", exportProject);
  if (elements.undoButton) elements.undoButton.addEventListener("click", () => { editGraph.undo(); renderAll(); });
  if (elements.redoButton) elements.redoButton.addEventListener("click", () => { editGraph.redo(); renderAll(); });
  updateUndoRedoButtons();

  async function togglePlayback() {
    if (!state.audioUrl) return;
    // 首次播放时初始化 Web Audio API 节点图，让 stem 混音参数真实生效。
    // AudioContext 必须在用户手势中创建/恢复，所以放在这里而不是模块加载时。
    setupAudioGraph();
    resumeAudioContext();
    try {
      if (elements.audio.paused) {
        // P1.2 轮 4：播放起点受 master stem 的 trimStart 影响（仅 edited 模式）。
        const master = state.stemTracks.find(track => track.id === "master");
        const { start: trimStart, end: trimEnd } = master ? stemEffectiveTrimRange(master) : { start: 0, end: state.duration };
        const selectionStart = state.selection.end > state.selection.start ? state.selection.start : null;
        const baseStart = elements.audio.ended || elements.audio.currentTime >= state.duration - 0.01;
        if (baseStart) {
          // 重新开始播放：优先用选区起点，否则用 trimStart（edited 模式）或 0。
          const target = selectionStart !== null ? selectionStart : trimStart;
          if (target >= trimStart && target < trimEnd) {
            elements.audio.currentTime = target;
          } else {
            elements.audio.currentTime = trimStart;
          }
        } else if (elements.audio.currentTime < trimStart - 0.01 || elements.audio.currentTime > trimEnd + 0.05) {
          // 当前播放头在 trim 范围外，重置到 trimStart。
          elements.audio.currentTime = trimStart;
        }
        await elements.audio.play();
        applyMasterFadeEnvelope();
      } else elements.audio.pause();
      updateTransport();
    } catch (error) {
      setStatus(`音频播放失败：${error.message}`, "error");
    }
  }
  elements.playButton.addEventListener("click", togglePlayback);
  elements.stopButton.addEventListener("click", () => {
    elements.audio.pause();
    elements.audio.currentTime = state.selection.end > state.selection.start ? state.selection.start : 0;
    updateTransport();
  });
  elements.audio.addEventListener("timeupdate", () => {
    updateTransport();
    enforceMasterTrimBoundary();
    applyMasterFadeEnvelope();
  });
  elements.audio.addEventListener("play", updateTransport);
  elements.audio.addEventListener("pause", updateTransport);
  elements.audio.addEventListener("ended", updateTransport);
  elements.audio.addEventListener("seeked", () => {
    applyMasterFadeEnvelope();
    enforceMasterTrimBoundary();
  });
  elements.audio.addEventListener("error", () => setStatus("浏览器无法解码这个 WAV，请检查编码和文件完整性。", "error"));
  elements.audio.addEventListener("loadedmetadata", () => {
    state.audioDuration = Number.isFinite(elements.audio.duration) ? elements.audio.duration : null;
    checkAudioAssociation();
    updateTransport();
  });

  elements.waveformLane.addEventListener("pointerdown", event => {
    if (!state.analysis || event.button !== 0) return;
    const anchor = snapTime(timeFromPointer(event), event.altKey);
    state.dragging = { anchor, clientX: event.clientX, moved: false, previous: { ...state.selection } };
    elements.waveformLane.setPointerCapture(event.pointerId);
  });
  elements.waveformLane.addEventListener("pointermove", event => {
    if (!state.dragging) return;
    if (Math.abs(event.clientX - state.dragging.clientX) < 3 && !state.dragging.moved) return;
    state.dragging.moved = true;
    setSelection(state.dragging.anchor, timeFromPointer(event), false, true, event.altKey);
  });
  elements.waveformLane.addEventListener("pointerup", event => {
    if (!state.dragging) return;
    if (state.dragging.moved) {
      setSelection(state.dragging.anchor, timeFromPointer(event), true, true, event.altKey);
    } else {
      const targetTime = timeFromPointer(event);
      setSelection(state.dragging.previous.start, state.dragging.previous.end, false);
      if (state.audioUrl) {
        elements.audio.currentTime = targetTime;
        updateTransport();
        setStatus(`播放头已定位到 ${targetTime.toFixed(3)} 秒。`, "success");
      } else {
        setStatus("已定位时间；关联 WAV 后可以从这里播放。", "success");
      }
    }
    state.dragging = null;
    elements.waveformLane.releasePointerCapture(event.pointerId);
  });
  elements.waveformLane.addEventListener("pointercancel", () => {
    if (!state.dragging) return;
    const previous = state.dragging.previous;
    state.dragging = null;
    setSelection(previous.start, previous.end, false);
    setStatus("系统取消了框选，已恢复原选区。", "success");
  });
  elements.waveformLane.addEventListener("keydown", event => {
    if (!state.analysis || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const delta = (event.key === "ArrowRight" ? 1 : -1) * (snapIntervalSeconds() || 0.1);
    const length = state.selection.end > state.selection.start ? state.selection.end - state.selection.start : (snapIntervalSeconds() || 0.5);
    if (event.shiftKey) {
      setSelection(state.selection.start, clamp(state.selection.end + delta, state.selection.start + 0.001, state.duration), true, true);
    } else {
      const start = clamp(state.selection.start + delta, 0, state.duration - length);
      setSelection(start, start + length, true, true);
    }
  });

  function beginHandleDrag(event, edge) {
    event.preventDefault();
    event.stopPropagation();
    state.handleDragging = { edge, previous: { ...state.selection } };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveHandle(event) {
    if (!state.handleDragging) return;
    event.preventDefault();
    event.stopPropagation();
    const time = snapTime(timeFromPointer(event), event.altKey);
    const minimum = event.altKey ? 0.001 : (snapIntervalSeconds() || 0.001);
    if (state.handleDragging.edge === "start") {
      setSelection(Math.min(time, state.selection.end - minimum), state.selection.end, false, true, event.altKey);
    } else {
      setSelection(state.selection.start, Math.max(time, state.selection.start + minimum), false, true, event.altKey);
    }
  }

  function endHandleDrag(event) {
    if (!state.handleDragging) return;
    event.preventDefault();
    event.stopPropagation();
    state.handleDragging = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setStatus(`选区边界已调整为 ${state.selection.start.toFixed(3)}–${state.selection.end.toFixed(3)} 秒。`, "success");
  }

  function cancelHandleDrag() {
    if (!state.handleDragging) return;
    const previous = state.handleDragging.previous;
    state.handleDragging = null;
    setSelection(previous.start, previous.end, false);
    setStatus("系统取消了边缘调整，已恢复原选区。", "success");
  }

  function nudgeHandle(event, edge) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.key === "ArrowRight" ? 1 : -1) * (snapIntervalSeconds() || 0.01);
    const minimum = event.altKey ? 0.001 : (snapIntervalSeconds() || 0.001);
    if (edge === "start") setSelection(clamp(state.selection.start + delta, 0, state.selection.end - minimum), state.selection.end, true, true);
    else setSelection(state.selection.start, clamp(state.selection.end + delta, state.selection.start + minimum, state.duration), true, true);
  }

  [
    [elements.selectionStartHandle, "start"],
    [elements.selectionEndHandle, "end"],
  ].forEach(([handle, edge]) => {
    handle.addEventListener("pointerdown", event => beginHandleDrag(event, edge));
    handle.addEventListener("pointermove", moveHandle);
    handle.addEventListener("pointerup", endHandleDrag);
    handle.addEventListener("pointercancel", cancelHandleDrag);
    handle.addEventListener("keydown", event => nudgeHandle(event, edge));
  });

  // 共享边手柄的全局 pointermove/up/cancel 路由（在 beginEdgeDrag 中已 setPointerCapture）。
  document.addEventListener("pointermove", moveEdge, true);
  document.addEventListener("pointerup", endEdgeDrag, true);
  document.addEventListener("pointercancel", cancelEdgeDrag, true);

  function applyNumericSelection() {
    const start = Number(elements.selectionStart.value);
    const end = Number(elements.selectionEnd.value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > state.duration || end <= start) {
      setStatus("精确选区尚未生效：请保证 0 ≤ 开始 < 结束 ≤ 音频时长。", "error");
      return;
    }
    setSelection(start, end);
  }
  elements.selectionStart.addEventListener("change", applyNumericSelection);
  elements.selectionEnd.addEventListener("change", applyNumericSelection);
  elements.saveLyricButton.addEventListener("click", saveLyricRegion);
  elements.cancelLyricEditButton.addEventListener("click", () => endLyricEdit(true));
  elements.deleteLyricButton.addEventListener("click", deleteLyric);
  elements.saveChordButton.addEventListener("click", saveChordOverride);
  elements.restoreChordButton.addEventListener("click", restoreChord);

  // 字段级锁定 toggle：用户主动勾选/取消即视为一次提交，记入撤销栈。
  if (elements.lockLyricCheckbox) {
    elements.lockLyricCheckbox.addEventListener("change", () => {
      if (!state.selectedLyricId) return;
      const id = state.selectedLyricId;
      editGraph.begin(`锁定歌词 ${id}`);
      setLocked("lyric", id, elements.lockLyricCheckbox.checked);
      renderLyrics();
      editLyric(id);
      setStatus(elements.lockLyricCheckbox.checked ? `已锁定歌词 ${id}；重生成不会覆盖此字段。` : `已取消锁定歌词 ${id}。`, "success");
    });
  }
  if (elements.lockRestCheckbox) {
    elements.lockRestCheckbox.addEventListener("change", () => {
      if (!state.selectedRestId) return;
      const id = state.selectedRestId;
      editGraph.begin(`锁定休止 ${id}`);
      setLocked("rest", id, elements.lockRestCheckbox.checked);
      renderLyrics();
      editRest(id);
      setStatus(elements.lockRestCheckbox.checked ? `已锁定休止 ${id}。` : `已取消锁定休止 ${id}。`, "success");
    });
  }
  if (elements.lockChordCheckbox) {
    elements.lockChordCheckbox.addEventListener("change", () => {
      const window = selectedChordWindow();
      if (!window) return;
      const key = chordKey(window);
      editGraph.begin(`锁定和弦 ${key}`);
      setLocked("chord", key, elements.lockChordCheckbox.checked);
      renderChords();
      selectChord(window);
      setStatus(elements.lockChordCheckbox.checked ? `已锁定和弦修正 ${key}。` : `已取消锁定和弦 ${key}。`, "success");
    });
  }

  // Stem 混音器事件委托：mute/solo 按钮点击、gain/pan 滑块输入。
  // 用事件委托避免每次 renderStemMixer 都重新绑定监听器（控件不重建，但事件委托更稳）。
  if (elements.stemMixer) {
    elements.stemMixer.addEventListener("click", event => {
      const button = event.target.closest('button[data-stem-control]');
      if (!button) return;
      const row = button.closest("[data-track-id]");
      if (!row) return;
      const trackId = row.dataset.trackId;
      const field = button.dataset.stemControl;
      if (field === "mute" || field === "solo") {
        const track = state.stemTracks.find(item => item.id === trackId);
        if (!track) return;
        updateStemField(trackId, field, !track[field]);
      }
    });
    // input 事件用 change 提交（拖动结束才记撤销点），input 事件只实时更新音频。
    // 这样拖动 gain 滑块不会每个像素都写一条 undo。
    // P1.2 轮 4：trim/fade 字段也通过同一委托处理；trim/fade 字段在 master stem 上实时生效。
    const numberFieldClamps = {
      gain: v => clamp(v, 0, 1.5),
      pan: v => clamp(v, -1, 1),
      trimStartSeconds: v => Math.max(0, v),
      trimEndSeconds: v => Math.max(0, v),
      fadeInSeconds: v => Math.max(0, v),
      fadeOutSeconds: v => Math.max(0, v),
    };
    elements.stemMixer.addEventListener("input", event => {
      const input = event.target.closest('input[data-stem-control]');
      if (!input) return;
      const row = input.closest("[data-track-id]");
      if (!row) return;
      const trackId = row.dataset.trackId;
      const field = input.dataset.stemControl;
      if (!(field in numberFieldClamps)) return;
      const track = state.stemTracks.find(item => item.id === trackId);
      if (!track) return;
      const value = numberFieldClamps[field](Number(input.value));
      if (!Number.isFinite(value)) return;
      // 拖动过程中直接改值并应用混音，但不记 undo（change 事件再提交）
      track[field] = value;
      applyStemMix();
      applyMasterFadeEnvelope();
      // 只更新数值显示，不重建控件
      const gainValue = row.querySelector('[data-stem-readout="gain"]');
      const panValue = row.querySelector('[data-stem-readout="pan"]');
      const statusBadge = row.querySelector('[data-stem-readout="status"]');
      if (field === "gain" && gainValue) gainValue.textContent = `${Math.round(value * 100)}%`;
      if (field === "pan" && panValue) {
        const percent = Math.round(value * 100);
        panValue.textContent = percent === 0 ? "中" : (percent < 0 ? `L ${Math.abs(percent)}` : `R ${percent}`);
      }
      if (statusBadge) {
        const { muted } = stemEffectiveState(track);
        if (track.source === "main") statusBadge.textContent = muted ? "主输出 · 静音" : "主输出";
        else statusBadge.textContent = muted ? "占位 · 静音" : "占位 stem";
      }
    });
    elements.stemMixer.addEventListener("change", event => {
      const input = event.target.closest('input[data-stem-control]');
      if (!input) return;
      const row = input.closest("[data-track-id]");
      if (!row) return;
      const trackId = row.dataset.trackId;
      const field = input.dataset.stemControl;
      if (!(field in numberFieldClamps)) return;
      const value = numberFieldClamps[field](Number(input.value));
      if (!Number.isFinite(value)) return;
      // 拖动结束才记 undo：把当前值视为"新值"，但数据已经改过，所以直接 begin + 保留值。
      const track = state.stemTracks.find(item => item.id === trackId);
      if (!track) return;
      if (track[field] === value) return;
      editGraph.begin(`调整 stem ${track.name} 的 ${field}`);
      track[field] = value;
      applyStemMix();
      applyMasterFadeEnvelope();
      renderStemMixer();
      setStatus(`已调整 ${track.name} 的 ${field}：${formatStemFieldValue(field, value)}。`, "success");
    });
  }

  // 钢琴卷帘事件绑定：目标 stem 选择、拆分/合并/删除按钮、空白处创建音符。
  if (elements.pianoRollStemSelect) {
    elements.pianoRollStemSelect.addEventListener("change", event => {
      state.pianoRollStemId = event.target.value;
      setStatus(`钢琴卷帘目标 stem 已切换为：${state.pianoRollStemId}。`, "success");
    });
  }
  if (elements.splitNoteButton) elements.splitNoteButton.addEventListener("click", splitSelectedNote);
  if (elements.mergeNoteButton) elements.mergeNoteButton.addEventListener("click", mergeSelectedNotes);
  if (elements.quantizeNoteButton) elements.quantizeNoteButton.addEventListener("click", quantizeSelectedNote);
  if (elements.deleteNoteButton) elements.deleteNoteButton.addEventListener("click", () => {
    if (state.selectedNoteId) deleteNote(state.selectedNoteId);
  });
  if (elements.pianoRollGrid) {
    elements.pianoRollGrid.addEventListener("pointerdown", beginNoteCreate);
  }
  // 钢琴卷帘也响应 Ctrl/Cmd + 滚轮缩放（与时间轴同步）。
  if (elements.pianoRollScroll) {
    elements.pianoRollScroll.addEventListener("wheel", event => {
      if (!state.analysis || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const delta = -Math.sign(event.deltaY) * 4;
      const minZoom = Number(elements.zoomRange.min);
      const maxZoom = Number(elements.zoomRange.max);
      const newZoom = clamp(state.zoom + delta, minZoom, maxZoom);
      if (newZoom === state.zoom) return;
      state.zoom = newZoom;
      elements.zoomRange.value = String(state.zoom);
      renderAll();
    }, { passive: false });
  }
  // Esc 取消钢琴卷帘拖动/创建。
  // 删除键删除选中音符（在非文本输入区域）。
  // 这些快捷键在文档级 keydown 中统一处理，避免重复绑定。

  elements.zoomRange.addEventListener("input", event => {
    if (!state.analysis) {
      state.zoom = Number(event.target.value);
      return;
    }
    // 缩放锚点：保持"视口中心对应的时间点"在缩放后仍位于视口中心。
    // 这样用户在时间轴中部缩放时不会丢失当前位置感。
    const scroll = elements.timelineScroll;
    const prevContentWidth = elements.timelineContent.offsetWidth || 1;
    const viewportWidth = scroll.clientWidth;
    const centerPx = scroll.scrollLeft + viewportWidth / 2;
    const centerTime = (centerPx / prevContentWidth) * state.duration;
    state.zoom = Number(event.target.value);
    renderAll();
    const newContentWidth = elements.timelineContent.offsetWidth || 1;
    const newCenterPx = (centerTime / state.duration) * newContentWidth;
    scroll.scrollLeft = Math.max(0, Math.min(Math.max(0, newContentWidth - viewportWidth), newCenterPx - viewportWidth / 2));
  });

  // Ctrl/Cmd + 滚轮在时间轴上缩放，以鼠标位置为锚点。
  // 这是 DAW 类编辑器的常见手感：鼠标指向哪里，缩放就以哪里为定点。
  elements.timelineScroll.addEventListener("wheel", event => {
    if (!state.analysis || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const scroll = elements.timelineScroll;
    const rect = scroll.getBoundingClientRect();
    const pointerOffsetX = event.clientX - rect.left;  // 视口内 X
    const prevContentWidth = elements.timelineContent.offsetWidth || 1;
    const pointerAbsolutePx = scroll.scrollLeft + pointerOffsetX;
    const pointerTime = (pointerAbsolutePx / prevContentWidth) * state.duration;
    const minZoom = Number(elements.zoomRange.min);
    const maxZoom = Number(elements.zoomRange.max);
    const delta = -Math.sign(event.deltaY) * 4;
    const newZoom = clamp(state.zoom + delta, minZoom, maxZoom);
    if (newZoom === state.zoom) return;
    state.zoom = newZoom;
    elements.zoomRange.value = String(state.zoom);
    renderAll();
    // 缩放后调整 scrollLeft，使"鼠标位置对应的时间点"仍位于鼠标视口 X 处。
    const newContentWidth = elements.timelineContent.offsetWidth || 1;
    const newPointerAbsolutePx = (pointerTime / state.duration) * newContentWidth;
    scroll.scrollLeft = Math.max(0, Math.min(Math.max(0, newContentWidth - scroll.clientWidth), newPointerAbsolutePx - pointerOffsetX));
  }, { passive: false });

  // 用户主动滚动时间轴时记录时间戳，让自动跟随暂停 1.5 秒。
  // 区分用户滚动与程序滚动：autoScrollToPlayhead 修改 scrollLeft 时会置 programmaticScroll=true。
  elements.timelineScroll.addEventListener("scroll", () => {
    if (state.programmaticScroll) return;
    state.manualScrollAt = performance.now();
  });
  elements.snapGrid.addEventListener("change", event => {
    state.snapMode = event.target.value;
    if (state.selection.end > state.selection.start) setSelection(state.selection.start, state.selection.end, true, true);
    else setStatus(`吸附已切换为：${event.target.options[event.target.selectedIndex].textContent}。`, "success");
  });
  if (elements.dottedSnap) {
    elements.dottedSnap.addEventListener("change", event => {
      state.dottedSnap = event.target.checked;
      const swingNote = state.swingAmount ? "（与 Swing 叠加）" : "";
      setStatus(state.dottedSnap ? `附点已开启：网格拉长 1.5 倍${swingNote}。` : "附点已关闭。", "success");
    });
  }
  if (elements.swingAmount) {
    elements.swingAmount.addEventListener("input", event => {
      state.swingAmount = Number(event.target.value);
    });
    elements.swingAmount.addEventListener("change", event => {
      const value = Number(event.target.value);
      const percent = Math.round(value * 100);
      setStatus(value === 0 ? "Swing 已关闭：直八分。" : `Swing 已设置为 ${percent}%。`, "success");
    });
  }
  elements.continuousLyrics.addEventListener("change", event => {
    state.continuousLyrics = event.target.checked;
    setStatus(state.continuousLyrics ? "连续歌词区已开启：相邻区域共享边界，移动会同步两侧。" : "连续歌词区已关闭：允许显式休止和空白。", "success");
  });
  // P1.2 轮 4：A/B 试听模式切换。edited 应用 trim/fade；original 忽略非破坏参数，只保留 gain/pan/mute/solo。
  // 切换时立即重新应用混音与包络，让用户听到差异；不记 undo（试听模式不属于编辑操作）。
  if (elements.stemPreviewMode) {
    elements.stemPreviewMode.addEventListener("change", event => {
      state.stemPreviewMode = event.target.value === "original" ? "original" : "edited";
      applyStemMix();
      applyMasterFadeEnvelope();
      enforceMasterTrimBoundary();
      setStatus(state.stemPreviewMode === "original"
        ? "已切换到原始试听：忽略裁切与淡入淡出，只保留 gain/pan/mute/solo。"
        : "已切换到编辑后试听：应用裁切与淡入淡出参数。", "success");
    });
  }
  document.querySelectorAll("[data-layer]").forEach(input => input.addEventListener("change", () => {
    state.layers[input.dataset.layer] = input.checked;
    renderLayerVisibility();
    renderCanvas();
  }));

  document.addEventListener("keydown", event => {
    // 撤销/重做快捷键：Ctrl+Z 撤销，Ctrl+Shift+Z 或 Ctrl+Y 重做
    // 在文本输入框中不拦截，让浏览器原生文本编辑正常工作。
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "z" || event.key === "Z" || event.key === "y" || event.key === "Y")) {
      const target = event.target;
      const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
      if (editingText) return;
      const isRedo = event.shiftKey || event.key === "y" || event.key === "Y";
      event.preventDefault();
      const handled = isRedo ? editGraph.redo() : editGraph.undo();
      if (handled) renderAll();
      return;
    }
    if (event.key === "Escape") {
      if (state.handleDragging) {
        const previous = state.handleDragging.previous;
        state.handleDragging = null;
        setSelection(previous.start, previous.end, false);
        setStatus("已取消边缘调整。", "success");
      } else if (state.edgeDragging) {
        cancelEdgeDrag();
      } else if (state.dragging) {
        const previous = state.dragging.previous;
        state.dragging = null;
        setSelection(previous.start, previous.end, false);
        setStatus("已取消框选。", "success");
      } else if (state.lyricDrag) {
        cancelLyricDrag();
      } else if (state.noteDrag) {
        if (state.noteDrag.mode === "create") cancelNoteCreate();
        else cancelNoteDrag();
      }
      return;
    }
    // Delete / Backspace 删除选中音符（非文本输入区域）
    if ((event.key === "Delete" || event.key === "Backspace") && state.selectedNoteId) {
      const target = event.target;
      const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
      if (!editingText) {
        event.preventDefault();
        deleteNote(state.selectedNoteId);
        return;
      }
    }
    if (event.code !== "Space" || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
    if (editingText || !state.audioUrl) return;
    event.preventDefault();
    togglePlayback();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 80);
  });
  window.addEventListener("pagehide", () => {
    releaseAudioUrl();
    bridge.revokeAllObjectUrls();
  });
})();
