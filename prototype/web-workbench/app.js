"use strict";

(() => {
  const PROJECT_SCHEMA = "miku-workbench-project/0.1.0";
  const ANALYSIS_SCHEMA = "0.1.0";
  const bridge = globalThis.MikuDesktopBridge;
  const state = {
    analysis: null,
    duration: 0,
    audioUrl: null,
    audioFileName: null,
    audioDuration: null,
    audioSha256: null,
    audioHashSkipped: false,
    selection: { start: 0, end: 0 },
    lyrics: [],
    chordOverrides: {},
    selectedChordKey: null,
    selectedLyricId: null,
    zoom: 16,
    layers: { waveform: true, energy: true, beats: true, sections: true, chords: true },
    dragging: null,
    nextLyricId: 1,
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
    timelineScroll: byId("timeline-scroll"),
    timelineContent: byId("timeline-content"),
    ruler: byId("ruler"),
    sectionsLane: byId("sections-lane"),
    chordsLane: byId("chords-lane"),
    waveformLane: byId("waveform-lane"),
    canvas: byId("timeline-canvas"),
    selectionOverlay: byId("selection-overlay"),
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
    state.chordOverrides = {};
    state.selectedChordKey = null;
    state.selectedLyricId = null;
    state.nextLyricId = 1;
    elements.lyricText.value = "";
    elements.lyricLanguage.value = "zh";
    elements.chordInspector.hidden = true;
    elements.exactData.textContent = "选择和弦或歌词区域后显示。";
  }

  function applyAnalysis(analysis, preserveEdits = false) {
    state.analysis = validateAnalysis(analysis);
    state.duration = Number(analysis.source_audio.duration_seconds);
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

  function renderLyrics() {
    clearElement(elements.lyricsLane);
    if (!state.lyrics.length) {
      elements.lyricsLane.appendChild(elements.lyricsEmpty);
      elements.lyricsEmpty.hidden = false;
      return;
    }
    state.lyrics.slice().sort((a, b) => a.start - b.start).forEach(region => {
      const language = region.language === "ja" ? "日" : "中";
      const block = makeBlock("lyric-block", `${language} · ${region.text}`, region.start, region.end, `${region.start.toFixed(3)}–${region.end.toFixed(3)} 秒 · 点击编辑`);
      if (state.selectedLyricId === region.id) block.classList.add("selected");
      block.addEventListener("click", () => editLyric(region.id));
      elements.lyricsLane.appendChild(block);
    });
  }

  function editLyric(id) {
    const region = state.lyrics.find(item => item.id === id);
    if (!region) return;
    state.selectedLyricId = id;
    elements.lyricLanguage.value = region.language;
    elements.lyricText.value = region.text;
    elements.cancelLyricEditButton.hidden = false;
    elements.deleteLyricButton.hidden = false;
    setSelection(region.start, region.end);
    elements.exactData.textContent = JSON.stringify(region, null, 2);
    renderLyrics();
  }

  function endLyricEdit(clearText = false) {
    state.selectedLyricId = null;
    elements.cancelLyricEditButton.hidden = true;
    elements.deleteLyricButton.hidden = true;
    if (clearText) elements.lyricText.value = "";
    renderLyrics();
  }

  function setSelection(start, end, announce = true) {
    if (!state.analysis) return;
    let safeStart = clamp(finiteNumber(start), 0, state.duration);
    let safeEnd = clamp(finiteNumber(end), 0, state.duration);
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

  function saveLyricRegion() {
    const { start, end } = state.selection;
    const text = elements.lyricText.value.trim();
    const language = elements.lyricLanguage.value;
    if (!(end > start)) {
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
    if (state.selectedLyricId) {
      const existing = state.lyrics.find(region => region.id === state.selectedLyricId);
      if (existing) Object.assign(existing, { start, end, language, text });
      setStatus("已更新歌词区域。", "success");
    } else {
      let identifier;
      do {
        identifier = `lyric-${state.nextLyricId++}`;
      } while (state.lyrics.some(region => region.id === identifier));
      state.lyrics.push({ id: identifier, start, end, language, text });
      setStatus("已建立歌词区域；尚未生成演唱音符。", "success");
    }
    endLyricEdit(true);
  }

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
      editing: {
        selection: state.selection,
        lyrics: state.lyrics,
        chord_overrides: state.chordOverrides,
      },
    };
    bridge.downloadJson("miku-workbench-project.json", project);
    setStatus("项目已导出。音频本体未写入项目，请在重新打开后手动关联。", "success");
  }

  async function importProject(file) {
    const candidate = await readJsonFile(file);
    if (candidate.schema_version !== PROJECT_SCHEMA) throw new Error(`不支持的项目版本：${String(candidate.schema_version || "缺失")}。`);
    const analysis = validateAnalysis(candidate.analysis);
    const editing = candidate.editing || {};
    const seenLyricIds = new Set();
    let maximumLyricNumber = 0;
    const lyrics = Array.isArray(editing.lyrics) ? editing.lyrics.map((region, index) => {
      if (!region || typeof region !== "object") throw new Error(`歌词区域 ${index + 1} 无效。`);
      if (!new Set(["zh", "ja"]).has(region.language)) throw new Error(`歌词区域 ${index + 1} 使用不支持的语言；首版只接受 zh/ja。`);
      const language = region.language;
      const start = clamp(finiteNumber(region.start), 0, analysis.source_audio.duration_seconds);
      const end = clamp(finiteNumber(region.end), 0, analysis.source_audio.duration_seconds);
      if (!(end > start) || !String(region.text || "").trim()) throw new Error(`歌词区域 ${index + 1} 的时间或文本无效。`);
      const id = String(region.id || `lyric-${index + 1}`);
      if (seenLyricIds.has(id)) throw new Error(`歌词区域 ID 重复：${id}。`);
      seenLyricIds.add(id);
      const match = /^lyric-(\d+)$/.exec(id);
      if (match) maximumLyricNumber = Math.max(maximumLyricNumber, Number(match[1]));
      return { id, start, end, language, text: String(region.text).trim() };
    }) : [];
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
    releaseAudioUrl();
    applyAnalysis(analysis, false);
    state.lyrics = lyrics;
    state.chordOverrides = overrides;
    state.nextLyricId = Math.max(1, maximumLyricNumber + 1);
    const selection = editing.selection || {};
    setSelection(finiteNumber(selection.start), finiteNumber(selection.end), false);
    elements.audioName.textContent = candidate.source_audio && candidate.source_audio.local_file_name ? `${candidate.source_audio.local_file_name}（需要重新关联）` : "需要重新关联 WAV";
    renderAll();
    setStatus("项目已导入；分析和编辑状态已恢复，请重新选择本地 WAV 才能播放。", "success");
  }

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

  elements.playButton.addEventListener("click", async () => {
    if (!state.audioUrl) return;
    try {
      if (elements.audio.paused) await elements.audio.play(); else elements.audio.pause();
      updateTransport();
    } catch (error) {
      setStatus(`音频播放失败：${error.message}`, "error");
    }
  });
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
    const anchor = timeFromPointer(event);
    state.dragging = { anchor, clientX: event.clientX, moved: false, previous: { ...state.selection } };
    elements.waveformLane.setPointerCapture(event.pointerId);
  });
  elements.waveformLane.addEventListener("pointermove", event => {
    if (!state.dragging) return;
    if (Math.abs(event.clientX - state.dragging.clientX) < 3 && !state.dragging.moved) return;
    state.dragging.moved = true;
    setSelection(state.dragging.anchor, timeFromPointer(event), false);
  });
  elements.waveformLane.addEventListener("pointerup", event => {
    if (!state.dragging) return;
    if (state.dragging.moved) {
      setSelection(state.dragging.anchor, timeFromPointer(event));
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
  elements.waveformLane.addEventListener("keydown", event => {
    if (!state.analysis || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 0.1 : -0.1;
    const length = Math.max(0.5, state.selection.end - state.selection.start);
    const start = clamp(state.selection.start + delta, 0, state.duration - length);
    setSelection(start, start + length);
  });

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
  elements.deleteLyricButton.addEventListener("click", () => {
    state.lyrics = state.lyrics.filter(region => region.id !== state.selectedLyricId);
    endLyricEdit(true);
    setStatus("歌词区域已删除。", "success");
  });
  elements.saveChordButton.addEventListener("click", saveChordOverride);
  elements.restoreChordButton.addEventListener("click", restoreChord);

  elements.zoomRange.addEventListener("input", event => {
    state.zoom = Number(event.target.value);
    renderAll();
  });
  document.querySelectorAll("[data-layer]").forEach(input => input.addEventListener("change", () => {
    state.layers[input.dataset.layer] = input.checked;
    renderLayerVisibility();
    renderCanvas();
  }));

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
