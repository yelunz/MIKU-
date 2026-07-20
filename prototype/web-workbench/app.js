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
    continuousLyrics: true,
    layers: { waveform: true, energy: true, beats: true, sections: true, chords: true },
    dragging: null,
    handleDragging: null,
    edgeDragging: null,
    nextLyricId: 1,
    nextRestId: 1,
    nextAnchorId: 1,
  };

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
    exactData: byId("exact-data"),
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

  // ---- 选区与吸附 --------------------------------------------------------------

  function topTempoCandidate() {
    return state.analysis && state.analysis.analysis.tempo.candidates[0] || null;
  }

  function snapIntervalSeconds() {
    const tempo = topTempoCandidate();
    if (!tempo || state.snapMode === "none") return 0;
    const beat = 60 / finiteNumber(tempo.bpm, 120);
    if (state.snapMode === "quarter-beat") return beat / 4;
    if (state.snapMode === "half-beat") return beat / 2;
    return beat;
  }

  function snapTime(seconds, bypass = false) {
    const interval = snapIntervalSeconds();
    if (!interval || bypass) return clamp(seconds, 0, state.duration);
    if (seconds <= interval / 2) return 0;
    if (state.duration - seconds <= interval / 2) return state.duration;
    const tempo = topTempoCandidate();
    const origin = finiteNumber(tempo.first_beat_seconds);
    const snapped = origin + Math.round((seconds - origin) / interval) * interval;
    return clamp(Number(snapped.toFixed(6)), 0, state.duration);
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
    elements.lyricText.value = "";
    elements.lyricLanguage.value = "zh";
    elements.chordInspector.hidden = true;
    elements.restInspector.hidden = true;
    elements.exactData.textContent = "选择和弦或歌词区域后显示。";
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
    elements.exactData.textContent = JSON.stringify({ source: state.analysis.analysis.chords.source, window, override: state.chordOverrides[key] || null }, null, 2);
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
        const block = makeBlock("lyric-block", `${language} · ${region.text}`, startSeconds, endSeconds, `${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · 点击编辑`);
        block.style.removeProperty("width");
        block.style.right = percentAt(state.duration - endSeconds);
        if (state.selectedLyricId === region.id) block.classList.add("selected");
        block.addEventListener("click", () => editLyric(region.id));
        elements.lyricsLane.appendChild(block);
      } else {
        const block = makeBlock("rest-block explicit-rest", "休止", startSeconds, endSeconds, `${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · 显式休止；点击编辑`);
        block.style.removeProperty("width");
        block.style.right = percentAt(state.duration - endSeconds);
        if (state.selectedRestId === region.id) block.classList.add("selected");
        block.addEventListener("click", () => editRest(region.id));
        elements.lyricsLane.appendChild(block);
      }
      cursorSample = Math.max(cursorSample, endSample);
    });
    appendUnassigned(sampleToSeconds(cursorSample), state.duration);

    renderSharedEdges();
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
      start_anchor: state.anchors.get(region.startAnchorId),
      end_anchor: state.anchors.get(region.endAnchorId),
    }, null, 2);
    hideRestInspector();
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
      start_anchor: state.anchors.get(rest.startAnchorId),
      end_anchor: state.anchors.get(rest.endAnchorId),
    }, null, 2);
    hideLyricEditor();
    hideChordInspector();
    renderLyrics();
  }

  function endLyricEdit(clearText = false) {
    state.selectedLyricId = null;
    elements.cancelLyricEditButton.hidden = true;
    elements.deleteLyricButton.hidden = true;
    if (clearText) elements.lyricText.value = "";
    renderLyrics();
  }

  function hideLyricEditor() {
    elements.cancelLyricEditButton.hidden = true;
    elements.deleteLyricButton.hidden = true;
    elements.lyricText.value = "";
  }

  function hideRestInspector() {
    elements.restInspector.hidden = true;
  }

  function hideChordInspector() {
    elements.chordInspector.hidden = true;
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
    } else {
      elements.playhead.hidden = true;
    }
    elements.playButton.textContent = elements.audio.paused ? "播放" : "暂停";
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
    state.lyrics = state.lyrics.filter(region => region.id !== state.selectedLyricId);
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
    state.rests = state.rests.filter(rest => rest.id !== id);
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
    state.edgeDragging = { anchorId, previousSample: state.anchors.get(anchorId) ? state.anchors.get(anchorId).sample : 0 };
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
    state.edgeDragging = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (error) { /* pointer already released */ }
    const anchor = state.anchors.get(anchorId);
    if (anchor) setStatus(`共享边界已移动到 ${sampleToSeconds(anchor.sample).toFixed(3)} 秒。`, "success");
  }

  function cancelEdgeDrag() {
    if (!state.edgeDragging) return;
    const previous = state.edgeDragging.previousSample;
    moveAnchor(state.edgeDragging.anchorId, previous);
    state.edgeDragging = null;
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
    delete state.chordOverrides[chordKey(window)];
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
        preferences: { snap_mode: state.snapMode, continuous_lyrics: state.continuousLyrics },
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
    if (new Set(["beat", "half-beat", "quarter-beat", "none"]).has(preferences.snap_mode)) state.snapMode = preferences.snap_mode;
    state.continuousLyrics = preferences.continuous_lyrics !== false;
    elements.snapGrid.value = state.snapMode;
    elements.continuousLyrics.checked = state.continuousLyrics;
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
      importAnchorsAndRegions(candidate, analysis);
      const editing = candidate.editing || {};
      const preferences = editing.preferences && typeof editing.preferences === "object" ? editing.preferences : {};
      if (new Set(["beat", "half-beat", "quarter-beat", "none"]).has(preferences.snap_mode)) state.snapMode = preferences.snap_mode;
      state.continuousLyrics = preferences.continuous_lyrics !== false;
      elements.snapGrid.value = state.snapMode;
    elements.continuousLyrics.checked = state.continuousLyrics;
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

  async function togglePlayback() {
    if (!state.audioUrl) return;
    try {
      if (elements.audio.paused) {
        if (elements.audio.ended || elements.audio.currentTime >= state.duration - 0.01) {
          elements.audio.currentTime = state.selection.end > state.selection.start ? state.selection.start : 0;
        }
        await elements.audio.play();
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
  elements.audio.addEventListener("timeupdate", updateTransport);
  elements.audio.addEventListener("play", updateTransport);
  elements.audio.addEventListener("pause", updateTransport);
  elements.audio.addEventListener("ended", updateTransport);
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

  elements.zoomRange.addEventListener("input", event => {
    state.zoom = Number(event.target.value);
    renderAll();
  });
  elements.snapGrid.addEventListener("change", event => {
    state.snapMode = event.target.value;
    if (state.selection.end > state.selection.start) setSelection(state.selection.start, state.selection.end, true, true);
    else setStatus(`吸附已切换为：${event.target.options[event.target.selectedIndex].textContent}。`, "success");
  });
  elements.continuousLyrics.addEventListener("change", event => {
    state.continuousLyrics = event.target.checked;
    setStatus(state.continuousLyrics ? "连续歌词区已开启：相邻区域共享边界，移动会同步两侧。" : "连续歌词区已关闭：允许显式休止和空白。", "success");
  });
  document.querySelectorAll("[data-layer]").forEach(input => input.addEventListener("change", () => {
    state.layers[input.dataset.layer] = input.checked;
    renderLayerVisibility();
    renderCanvas();
  }));

  document.addEventListener("keydown", event => {
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
      }
      return;
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
