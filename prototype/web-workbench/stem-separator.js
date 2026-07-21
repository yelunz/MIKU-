// P6 音源分离模块 (stem-separator.js)
// IIFE 模块，与 app.js 通过 CustomEvent 协调。
// 提供分离 4 个 stem（vocals/drums/bass/other）的能力，
// 通过 MikuDesktopBridge.separateStems 调用主进程 spawn 分析服务。
//
// 触发流程:
//   1. 用户在工作台点击"分离音源"按钮
//   2. 本模块调用 MikuDesktopBridge.separateStems(inputPath, outputDir, manifestPath)
//   3. 主进程通过 JSON-RPC 调用 launcher.py 的 separate_stems 方法
//   4. stem_separator.py 生成 4 个 stem WAV + manifest.json
//   5. 本模块收到响应后 dispatchEvent('miku:stems-separated')
//   6. app.js 监听该事件，把 stem 信息注入 stem_mixer 状态
//
// 浏览器降级模式：bridge.runtime === 'browser' 时无法调用分析服务，
// 显示提示并返回 fallback（用已有的占位 stem 数据）。

(function () {
  "use strict";

  const MODULE_NAME = "stem-separator";
  const MODULE_VERSION = "0.1.0";

  /**
   * 触发 4-stem 分离.
   * @param {string} inputPath 输入音频绝对路径
   * @param {string} outputDir stem WAV 输出目录
   * @param {string} [manifestPath] 可选 manifest.json 路径
   * @returns {Promise<{ status: string, output_dir: string, stems: object, analyzer: object }>}
   */
  async function separateStems(inputPath, outputDir, manifestPath) {
    const bridge = globalThis.MikuDesktopBridge;
    if (!bridge) {
      throw new Error("[stem-separator] MikuDesktopBridge not available");
    }
    if (typeof bridge.separateStems !== "function") {
      throw new Error(
        "[stem-separator] bridge.separateStems not implemented in runtime: " +
          (bridge.runtime || "unknown")
      );
    }
    return await bridge.separateStems(inputPath, outputDir, manifestPath);
  }

  /**
   * 渲染分离面板到指定容器.
   * @param {HTMLElement} container
   * @param {{ inputPath: string|null, onSeparated: (result: object) => void }} ctx
   */
  function renderPanel(container, ctx) {
    container.innerHTML = "";
    const panel = document.createElement("section");
    panel.className = "stem-separator-panel";
    panel.innerHTML = `
      <header class="panel-header">
        <p class="eyebrow">P6 · 音源分离</p>
        <h3>分离 4 个 stem</h3>
        <p class="panel-hint">把混合音频分离成 vocals / drums / bass / other 四个独立 stem，便于单独编辑或导出。</p>
      </header>
      <div class="panel-body">
        <div class="row">
          <label>输入音频</label>
          <code class="input-path">${ctx.inputPath || "(未选择)"}</code>
        </div>
        <div class="row">
          <button type="button" class="separate-stems-button primary" ${
            ctx.inputPath ? "" : "disabled"
          }>开始分离</button>
          <span class="status"></span>
        </div>
        <ul class="stem-list" hidden>
          <li data-stem="vocals"><span class="stem-name">人声 (vocals)</span><code class="stem-path"></code></li>
          <li data-stem="drums"><span class="stem-name">鼓 (drums)</span><code class="stem-path"></code></li>
          <li data-stem="bass"><span class="stem-name">贝斯 (bass)</span><code class="stem-path"></code></li>
          <li data-stem="other"><span class="stem-name">其他 (other)</span><code class="stem-path"></code></li>
        </ul>
      </div>
    `;
    container.appendChild(panel);

    const button = panel.querySelector(".separate-stems-button");
    const statusEl = panel.querySelector(".status");
    const stemList = panel.querySelector(".stem-list");

    button.addEventListener("click", async () => {
      if (!ctx.inputPath) {
        statusEl.textContent = "请先选择输入音频";
        return;
      }
      button.disabled = true;
      statusEl.textContent = "分离中... (可能需要数秒)";
      stemList.hidden = true;

      // 默认输出目录 = 输入音频同目录下 <stem>.stems/
      const outputDir = ctx.inputPath.replace(/\.[^.]+$/, "") + ".stems";
      const manifestPath = outputDir + "/manifest.json";

      try {
        const result = await separateStems(ctx.inputPath, outputDir, manifestPath);
        statusEl.textContent = `完成 (${result.analyzer?.method || "?"})`;
        stemList.hidden = false;
        for (const name of ["vocals", "drums", "bass", "other"]) {
          const li = stemList.querySelector(`li[data-stem="${name}"]`);
          const path = result.stems?.[name]?.path || "";
          li.querySelector(".stem-path").textContent = path || "(未生成)";
        }
        if (typeof ctx.onSeparated === "function") {
          ctx.onSeparated(result);
        }
        // 通知 app.js
        document.dispatchEvent(
          new CustomEvent("miku:stems-separated", {
            detail: { inputPath: ctx.inputPath, result },
          })
        );
      } catch (err) {
        statusEl.textContent = "失败: " + (err?.message || String(err));
      } finally {
        button.disabled = false;
      }
    });
  }

  // 模块导出
  globalThis.MikuStemSeparator = Object.freeze({
    name: MODULE_NAME,
    version: MODULE_VERSION,
    separateStems,
    renderPanel,
  });

  // 兼容 app.js 的事件协调：监听 miku:request-stems-separation
  document.addEventListener("miku:request-stems-separation", (event) => {
    const { inputPath, outputDir, manifestPath } = event.detail || {};
    if (!inputPath) return;
    separateStems(inputPath, outputDir, manifestPath)
      .then((result) => {
        document.dispatchEvent(
          new CustomEvent("miku:stems-separated", {
            detail: { inputPath, result },
          })
        );
      })
      .catch((err) => {
        document.dispatchEvent(
          new CustomEvent("miku:stems-separation-failed", {
            detail: { inputPath, error: String(err?.message || err) },
          })
        );
      });
  });
})();
