// P7 自动音符转录面板 (transcription-panel.js)
// IIFE 模块。通过 MikuDesktopBridge.transcribeAudio 调用主进程 spawn 分析服务，
// 把分离后的 vocals stem 或原始音频转录成可编辑 NoteEvent 候选。
//
// 输出 JSON schema (miku-transcription/0.1.0) 由 transcriber.py 写到 outputPath，
// 本模块读取 JSON 后 dispatchEvent('miku:transcription-completed')，
// app.js 监听该事件把 notes 注入钢琴卷帘。

(function () {
  "use strict";

  const MODULE_NAME = "transcription-panel";
  const MODULE_VERSION = "0.1.0";

  // 默认转录参数
  const DEFAULT_FMIN_HZ = 65.41; // C2
  const DEFAULT_FMAX_HZ = 1046.5; // C6

  /**
   * 触发转录.
   * @param {string} inputPath 输入音频绝对路径（建议为 vocals stem）
   * @param {string} outputPath 输出 JSON 绝对路径
   * @param {{ fmin_hz?: number, fmax_hz?: number }} [options]
   * @returns {Promise<{ status: string, output_path: string, note_count: number, needs_review_count: number, analyzer: object }>}
   */
  async function transcribeAudio(inputPath, outputPath, options = {}) {
    const bridge = globalThis.MikuDesktopBridge;
    if (!bridge) {
      throw new Error("[transcription-panel] MikuDesktopBridge not available");
    }
    if (typeof bridge.transcribeAudio !== "function") {
      throw new Error(
        "[transcription-panel] bridge.transcribeAudio not implemented in runtime: " +
          (bridge.runtime || "unknown")
      );
    }
    const params = {
      fmin_hz: options.fmin_hz ?? DEFAULT_FMIN_HZ,
      fmax_hz: options.fmax_hz ?? DEFAULT_FMAX_HZ,
    };
    return await bridge.transcribeAudio(inputPath, outputPath, params);
  }

  /**
   * 渲染转录面板.
   * @param {HTMLElement} container
   * @param {{ inputPath: string|null, onCompleted: (manifest: object) => void }} ctx
   */
  function renderPanel(container, ctx) {
    container.innerHTML = "";
    const panel = document.createElement("section");
    panel.className = "transcription-panel";
    panel.innerHTML = `
      <header class="panel-header">
        <p class="eyebrow">P7 · 自动音符转录</p>
        <h3>从音频转录音符候选</h3>
        <p class="panel-hint">用 librosa.pyin 跟踪主旋律 + onset 检测生成可编辑 NoteEvent 候选，置信度低的音符会被标记为待修正。</p>
      </header>
      <div class="panel-body">
        <div class="row">
          <label>输入音频</label>
          <code class="input-path">${ctx.inputPath || "(未选择)"}</code>
        </div>
        <div class="row">
          <label>基频范围 (Hz)</label>
          <input type="number" class="fmin-input" value="${DEFAULT_FMIN_HZ}" min="20" max="2000" step="0.01">
          <span>~</span>
          <input type="number" class="fmax-input" value="${DEFAULT_FMAX_HZ}" min="100" max="8000" step="0.01">
        </div>
        <div class="row">
          <button type="button" class="transcribe-button primary" ${
            ctx.inputPath ? "" : "disabled"
          }>开始转录</button>
          <span class="status"></span>
        </div>
        <div class="result-summary" hidden>
          <div class="stat"><span class="stat-label">音符数</span><span class="stat-value note-count">0</span></div>
          <div class="stat"><span class="stat-label">待修正</span><span class="stat-value needs-review-count">0</span></div>
          <div class="stat"><span class="stat-label">方法</span><span class="stat-value method">-</span></div>
          <div class="stat"><span class="stat-label">输出</span><code class="output-path"></code></div>
        </div>
        <ul class="note-preview-list" hidden></ul>
      </div>
    `;
    container.appendChild(panel);

    const button = panel.querySelector(".transcribe-button");
    const statusEl = panel.querySelector(".status");
    const summaryEl = panel.querySelector(".result-summary");
    const noteListEl = panel.querySelector(".note-preview-list");

    button.addEventListener("click", async () => {
      if (!ctx.inputPath) {
        statusEl.textContent = "请先选择输入音频";
        return;
      }
      button.disabled = true;
      statusEl.textContent = "转录中... (pyin + onset)";
      summaryEl.hidden = true;
      noteListEl.hidden = true;

      const outputPath = ctx.inputPath.replace(/\.[^.]+$/, "") + ".transcription.json";
      const fmin = parseFloat(panel.querySelector(".fmin-input").value) || DEFAULT_FMIN_HZ;
      const fmax = parseFloat(panel.querySelector(".fmax-input").value) || DEFAULT_FMAX_HZ;

      try {
        const result = await transcribeAudio(ctx.inputPath, outputPath, {
          fmin_hz: fmin,
          fmax_hz: fmax,
        });
        statusEl.textContent = "完成";
        summaryEl.hidden = false;
        summaryEl.querySelector(".note-count").textContent = String(result.note_count ?? 0);
        summaryEl.querySelector(".needs-review-count").textContent = String(
          result.needs_review_count ?? 0
        );
        summaryEl.querySelector(".method").textContent = result.analyzer?.method || "-";
        summaryEl.querySelector(".output-path").textContent = result.output_path || outputPath;

        // 加载完整 JSON 并预览前 10 个音符
        try {
          const bridge = globalThis.MikuDesktopBridge;
          if (bridge && typeof bridge.readFileAsText === "function") {
            const manifestJson = await bridge.readFileAsText(result.output_path || outputPath);
            const manifest = JSON.parse(manifestJson);
            const notes = manifest.notes || [];
            noteListEl.hidden = false;
            noteListEl.innerHTML = "";
            for (const note of notes.slice(0, 10)) {
              const li = document.createElement("li");
              li.className = "note-preview" + (note.needs_review ? " needs-review" : "");
              li.innerHTML = `
                <span class="note-midi">MIDI ${note.midi}</span>
                <span class="note-freq">${note.frequency.toFixed(2)} Hz</span>
                <span class="note-time">${note.start_seconds.toFixed(2)}s +${note.duration_seconds.toFixed(2)}s</span>
                <span class="note-conf">置信度 ${(note.confidence * 100).toFixed(0)}%</span>
                ${note.needs_review ? '<span class="review-flag">待修正</span>' : ""}
              `;
              noteListEl.appendChild(li);
            }
            if (typeof ctx.onCompleted === "function") {
              ctx.onCompleted(manifest);
            }
            document.dispatchEvent(
              new CustomEvent("miku:transcription-completed", {
                detail: { inputPath: ctx.inputPath, manifest },
              })
            );
          }
        } catch (readErr) {
          statusEl.textContent = "完成，但预览读取失败: " + (readErr?.message || readErr);
        }
      } catch (err) {
        statusEl.textContent = "失败: " + (err?.message || String(err));
      } finally {
        button.disabled = false;
      }
    });
  }

  globalThis.MikuTranscriptionPanel = Object.freeze({
    name: MODULE_NAME,
    version: MODULE_VERSION,
    transcribeAudio,
    renderPanel,
    DEFAULT_FMIN_HZ,
    DEFAULT_FMAX_HZ,
  });

  document.addEventListener("miku:request-transcription", (event) => {
    const { inputPath, outputPath, options } = event.detail || {};
    if (!inputPath) return;
    transcribeAudio(inputPath, outputPath, options)
      .then((result) => {
        document.dispatchEvent(
          new CustomEvent("miku:transcription-completed", {
            detail: { inputPath, result },
          })
        );
      })
      .catch((err) => {
        document.dispatchEvent(
          new CustomEvent("miku:transcription-failed", {
            detail: { inputPath, error: String(err?.message || err) },
          })
        );
      });
  });
})();
