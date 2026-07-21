// P8 智能歌声旋律生成器 (melody-generator.js)
// 基于和弦 + 节奏 + 音域约束的规则生成候选旋律。
// 不依赖外部模型，纯前端 JS 规则算法。
//
// 生成策略:
//   1. 从项目当前段落提取和弦序列（如 [C, G, Am, F]）
//   2. 从节奏轨道提取节拍位置（每拍 1 个候选音符）
//   3. 对每个和弦，从其 chord tones (根音/三音/五音/七音) 中
//      按权重随机选择 MIDI 音高，约束在用户音域 [low, high] 内
//   4. 生成 3 套候选：
//      * "保守" - 主要用根音 + 五音，节奏简单
//      * "流畅" - 加入经过音，节奏中等
//      * "活泼" - 加入邻音 + 跳进，节奏丰富
//   5. 候选可比较、接受、局部锁定后重生成
//
// 输出 NoteEvent 数组，与现有 piano roll 数据模型兼容。

(function () {
  "use strict";

  const MODULE_NAME = "melody-generator";
  const MODULE_VERSION = "0.1.0";

  // 和弦音阶模板（相对根音的半音偏移）
  const CHORD_TONES = {
    major: [0, 4, 7, 12],        // 根音 大三 五音 八度
    minor: [0, 3, 7, 12],         // 根音 小三 五音 八度
    "dominant-seventh": [0, 4, 7, 10],
    "major-seventh": [0, 4, 7, 11],
    "minor-seventh": [0, 3, 7, 10],
    suspended: [0, 5, 7, 12],
    diminished: [0, 3, 6, 12],
    "added-ninth": [0, 4, 7, 14],
  };

  // 通过音（用于"流畅"与"活泼"模式，相邻和弦音之间的过渡音）
  const PASSING_TONES = [2, 5, 9, 11];

  // 三套生成模式的权重
  const PROFILES = {
    conservative: { chord_weight: 0.85, passing_weight: 0.10, leap_weight: 0.05, rhythm_density: 0.5 },
    flowing: { chord_weight: 0.65, passing_weight: 0.25, leap_weight: 0.10, rhythm_density: 0.75 },
    lively: { chord_weight: 0.45, passing_weight: 0.30, leap_weight: 0.25, rhythm_density: 0.9 },
  };

  /**
   * 把和弦名解析为 {root_pc, quality, bass_pc} 结构.
   * "C" -> {root_pc:0, quality:"major"}
   * "Am" -> {root_pc:9, quality:"minor"}
   * "G7" -> {root_pc:7, quality:"dominant-seventh"}
   * "F#m7" -> {root_pc:6, quality:"minor-seventh"}
   */
  function parseChordName(name) {
    if (!name || typeof name !== "string") return null;
    const trimmed = name.trim();
    if (!trimmed) return null;

    const pcMap = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4,
      F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11 };
    // 兼容小写根音
    const normalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    const m = normalized.match(/^([A-G][#b]?)(.*)$/);
    if (!m) return null;
    const root_pc = pcMap[m[1]];
    if (root_pc === undefined) return null;
    const suffix = m[2] || "";
    let quality = "major";
    if (suffix === "m" || suffix === "min") quality = "minor";
    else if (suffix === "7" || suffix === "dom7") quality = "dominant-seventh";
    else if (suffix === "maj7" || suffix === "M7") quality = "major-seventh";
    else if (suffix === "m7" || suffix === "min7") quality = "minor-seventh";
    else if (suffix === "sus" || suffix === "sus4") quality = "suspended";
    else if (suffix === "dim" || suffix === "°") quality = "diminished";
    else if (suffix === "add9" || suffix === "add2") quality = "added-ninth";
    return { root_pc, quality, name: trimmed };
  }

  /**
   * 在音域 [low_midi, high_midi] 内，从 chord tones 中按权重选择一个 MIDI 音高.
   */
  function pickPitchFromChord(chord, low_midi, high_midi, profile, rng) {
    const tones = CHORD_TONES[chord.quality] || CHORD_TONES.major;
    // 收集所有落在音域内的候选音高
    const candidates = [];
    for (let octave = -2; octave <= 6; octave++) {
      for (const offset of tones) {
        const midi = 12 * (octave + 1) + chord.root_pc + offset;
        if (midi >= low_midi && midi <= high_midi) {
          candidates.push(midi);
        }
      }
    }
    if (candidates.length === 0) {
      // 兜底：用音域中点
      return Math.floor((low_midi + high_midi) / 2);
    }
    // 按权重选：chord_weight 直接选 chord tone
    // passing_weight 选 PASSING_TONES 附近
    // leap_weight 允许跨八度跳进
    const r = rng();
    if (r < profile.chord_weight) {
      return candidates[Math.floor(rng() * candidates.length)];
    } else if (r < profile.chord_weight + profile.passing_weight) {
      // 通过音：和弦音 ± 2 半音
      const base = candidates[Math.floor(rng() * candidates.length)];
      const offset = PASSING_TONES[Math.floor(rng() * PASSING_TONES.length)];
      const candidate = base + (rng() < 0.5 ? -1 : 1) * (offset === 2 ? 2 : 1);
      if (candidate >= low_midi && candidate <= high_midi) return candidate;
      return base;
    } else {
      // 跳进：跨八度
      const base = candidates[Math.floor(rng() * candidates.length)];
      const leap = rng() < 0.5 ? 12 : -12;
      const candidate = base + leap;
      if (candidate >= low_midi && candidate <= high_midi) return candidate;
      return base;
    }
  }

  /**
   * 简单种子随机数（Mulberry32），保证可重现.
   */
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 生成单套旋律候选.
   * @param {object} ctx
   * @param {Array<{name:string,start_beats:number,duration_beats:number}>} ctx.chords 和弦序列
   * @param {number} ctx.bps 每秒拍数
   * @param {number} ctx.low_midi 音域低
   * @param {number} ctx.high_midi 音域高
   * @param {string} profile_name conservative | flowing | lively
   * @param {number} seed
   * @returns {Array<object>} NoteEvent 数组
   */
  function generateCandidate(ctx, profile_name, seed) {
    const profile = PROFILES[profile_name] || PROFILES.flowing;
    const rng = makeRng(seed);
    const { chords, bps, low_midi, high_midi } = ctx;
    if (!chords || chords.length === 0 || bps <= 0) return [];

    const notes = [];
    let note_idx = 0;
    for (const chordEvent of chords) {
      const parsed = parseChordName(chordEvent.name);
      if (!parsed) continue;
      const start_seconds = chordEvent.start_beats / bps;
      const duration_seconds = chordEvent.duration_beats / bps;
      // 每和弦按 rhythm_density 切分若干小音符
      const sub_count = Math.max(1, Math.floor(chordEvent.duration_beats * profile.rhythm_density));
      const sub_duration = duration_seconds / sub_count;
      for (let i = 0; i < sub_count; i++) {
        // 跳过部分以增加节奏变化
        if (profile_name !== "conservative" && rng() < 0.1) continue;
        const midi = pickPitchFromChord(parsed, low_midi, high_midi, profile, rng);
        notes.push({
          id: `m-${profile_name}-${note_idx}`,
          start_seconds: start_seconds + i * sub_duration,
          duration_seconds: sub_duration * 0.9, // 留 10% 间隔
          midi,
          frequency: 440 * Math.pow(2, (midi - 69) / 12),
          velocity: 0.7 + rng() * 0.2,
          confidence: 1.0,
          needs_review: false,
          source: `generation-${profile_name}`,
          generator_seed: seed,
        });
        note_idx++;
      }
    }
    return notes;
  }

  /**
   * 生成 3 套候选.
   * @param {object} ctx 见 generateCandidate
   * @param {number} base_seed
   * @returns {Array<{profile: string, seed: number, notes: Array<object>}>}
   */
  function generateCandidates(ctx, base_seed = 42) {
    return [
      { profile: "conservative", seed: base_seed, notes: generateCandidate(ctx, "conservative", base_seed) },
      { profile: "flowing", seed: base_seed + 1, notes: generateCandidate(ctx, "flowing", base_seed + 1) },
      { profile: "lively", seed: base_seed + 2, notes: generateCandidate(ctx, "lively", base_seed + 2) },
    ];
  }

  /**
   * 渲染生成器面板.
   * @param {HTMLElement} container
   * @param {{ chords: Array, bps: number, low_midi: number, high_midi: number, onAccept: (notes: Array) => void }} ctx
   */
  function renderPanel(container, ctx) {
    container.innerHTML = "";
    const panel = document.createElement("section");
    panel.className = "melody-generator-panel";
    panel.innerHTML = `
      <header class="panel-header">
        <p class="eyebrow">P8 · 智能歌声旋律生成</p>
        <h3>生成旋律候选</h3>
        <p class="panel-hint">基于和弦序列、节奏和音域约束生成 3 套候选（保守/流畅/活泼），可比较与接受。</p>
      </header>
      <div class="panel-body">
        <div class="row">
          <label>和弦数</label>
          <code class="chord-count">${ctx.chords?.length || 0}</code>
          <label>BPS</label>
          <code class="bps">${ctx.bps || 2.0}</code>
        </div>
        <div class="row">
          <label>音域 (MIDI)</label>
          <input type="number" class="low-midi" value="${ctx.low_midi ?? 55}" min="24" max="96">
          <span>~</span>
          <input type="number" class="high-midi" value="${ctx.high_midi ?? 76}" min="24" max="96">
        </div>
        <div class="row">
          <label>种子</label>
          <input type="number" class="seed" value="42" min="0" max="999999">
          <button type="button" class="generate-button primary">生成 3 套候选</button>
          <span class="status"></span>
        </div>
        <div class="candidates" hidden></div>
      </div>
    `;
    container.appendChild(panel);

    const button = panel.querySelector(".generate-button");
    const statusEl = panel.querySelector(".status");
    const candidatesEl = panel.querySelector(".candidates");

    button.addEventListener("click", () => {
      const low_midi = parseInt(panel.querySelector(".low-midi").value, 10) || 55;
      const high_midi = parseInt(panel.querySelector(".high-midi").value, 10) || 76;
      const seed = parseInt(panel.querySelector(".seed").value, 10) || 42;
      if (!ctx.chords || ctx.chords.length === 0) {
        statusEl.textContent = "请先选择段落与和弦";
        return;
      }
      statusEl.textContent = "生成中...";
      candidatesEl.hidden = true;

      const fullCtx = { chords: ctx.chords, bps: ctx.bps || 2.0, low_midi, high_midi };
      const candidates = generateCandidates(fullCtx, seed);

      candidatesEl.hidden = false;
      candidatesEl.innerHTML = "";
      for (const c of candidates) {
        const card = document.createElement("div");
        card.className = "candidate-card";
        card.innerHTML = `
          <header><h4>${c.profile}</h4><span class="note-count">${c.notes.length} 音符</span></header>
          <ul class="note-list"></ul>
          <button type="button" class="accept-button">接受</button>
        `;
        const ul = card.querySelector(".note-list");
        for (const n of c.notes.slice(0, 8)) {
          const li = document.createElement("li");
          li.textContent = `M${n.midi} @ ${n.start_seconds.toFixed(2)}s +${n.duration_seconds.toFixed(2)}s`;
          ul.appendChild(li);
        }
        if (c.notes.length > 8) {
          const li = document.createElement("li");
          li.textContent = `... 还有 ${c.notes.length - 8} 个`;
          ul.appendChild(li);
        }
        card.querySelector(".accept-button").addEventListener("click", () => {
          if (typeof ctx.onAccept === "function") {
            ctx.onAccept(c.notes);
          }
          document.dispatchEvent(
            new CustomEvent("miku:melody-accepted", {
              detail: { profile: c.profile, notes: c.notes },
            })
          );
          statusEl.textContent = `已接受 ${c.profile}`;
        });
        candidatesEl.appendChild(card);
      }
      statusEl.textContent = `生成 ${candidates.length} 套候选`;
    });
  }

  globalThis.MikuMelodyGenerator = Object.freeze({
    name: MODULE_NAME,
    version: MODULE_VERSION,
    PROFILES,
    parseChordName,
    generateCandidate,
    generateCandidates,
    renderPanel,
  });
})();
