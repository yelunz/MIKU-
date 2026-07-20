"use strict";

// P5 错误恢复模块（IIFE，不污染全局）。
// 职责：
//   1. 全局错误边界：捕获未处理的同步错误与 Promise 拒绝，显示用户友好提示。
//   2. 崩溃恢复：定期自动保存项目草稿到 localStorage；重新打开时检测未恢复的草稿并提示。
//   3. 错误通知：非阻断式 toast，可手动关闭；critical 级别显示恢复建议。
//
// 与 app.js 的协作：
//   - app.js 在每次 editGraph 操作后派发 miku:state-changed 事件（携带项目 JSON 字符串）。
//   - 本模块监听该事件，防抖保存到 localStorage。
//   - 页面加载时检测是否有未恢复的草稿，派发 miku:restore-draft 事件让 app.js 处理。
//   - 本模块不直接访问 app.js 内部状态，只通过 CustomEvent 协作。

(() => {
  const AUTOSAVE_KEY = "miku-autosave-draft";
  const AUTOSAVE_TIMESTAMP_KEY = "miku-autosave-timestamp";
  const AUTOSAVE_DEBOUNCE_MS = 2000;
  const AUTOSAVE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 小时后过期

  let autosaveTimer = null;
  let toastTimer = null;

  // ---- 错误通知 toast ----
  function ensureToastContainer() {
    let container = document.getElementById("error-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "error-toast-container";
      container.className = "error-toast-container";
      container.setAttribute("role", "alert");
      container.setAttribute("aria-live", "assertive");
      document.body.appendChild(container);
    }
    return container;
  }

  function showErrorToast(message, level) {
    const container = ensureToastContainer();
    // level: "error" | "warning" | "info"
    const toast = document.createElement("div");
    toast.className = `error-toast error-toast-${level || "error"}`;

    const text = document.createElement("span");
    text.className = "error-toast-text";
    text.textContent = message;
    toast.appendChild(text);

    const dismiss = document.createElement("button");
    dismiss.className = "error-toast-dismiss";
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "关闭通知");
    dismiss.addEventListener("click", () => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    });
    toast.appendChild(dismiss);

    container.appendChild(toast);

    // 自动消失（error 级别保留更久）
    const ttl = level === "error" ? 8000 : 5000;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, ttl);
  }

  // ---- 全局错误边界 ----
  function handleGlobalError(event) {
    // event: ErrorEvent
    const msg = event && event.message ? event.message : "发生未知错误。";
    const filename = event && event.filename ? event.filename : "";
    const lineno = event && event.lineno ? ` (${event.lineno}` : "";
    const colno = event && event.colno ? `:${event.colno})` : (lineno ? ")" : "");
    const detail = filename ? ` ${filename}${lineno}${colno}` : "";
    showErrorToast(`应用遇到错误：${msg}${detail}。已保存的草稿可在下次打开时恢复。`, "error");
    // 阻止默认的控制台错误输出被掩盖
    return false;
  }

  function handleUnhandledRejection(event) {
    const reason = event && event.reason;
    const msg = reason && reason.message
      ? reason.message
      : (typeof reason === "string" ? reason : "未处理的异步操作失败。");
    showErrorToast(`异步操作失败：${msg}`, "warning");
  }

  // ---- 自动保存草稿 ----
  function saveDraft(projectJson) {
    try {
      localStorage.setItem(AUTOSAVE_KEY, projectJson);
      localStorage.setItem(AUTOSAVE_TIMESTAMP_KEY, String(Date.now()));
    } catch (error) {
      // localStorage 满 或不可用：静默降级，不影响用户操作。
      // 如果是 QuotaExceededError，尝试清除旧草稿后重试一次。
      if (error && error.name === "QuotaExceededError") {
        try {
          localStorage.removeItem(AUTOSAVE_KEY);
          localStorage.setItem(AUTOSAVE_KEY, projectJson);
          localStorage.setItem(AUTOSAVE_TIMESTAMP_KEY, String(Date.now()));
        } catch (retryError) {
          // 仍然失败：放弃自动保存，不阻断用户。
        }
      }
    }
  }

  function handleStateChanged(event) {
    const projectJson = event && event.detail ? event.detail.projectJson : null;
    if (!projectJson) return;
    // 防抖：2 秒内的多次状态变更只保存一次。
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      saveDraft(projectJson);
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  // ---- 崩溃恢复检测 ----
  function checkPendingDraft() {
    try {
      const timestamp = Number(localStorage.getItem(AUTOSAVE_TIMESTAMP_KEY));
      if (!Number.isFinite(timestamp)) return;
      // 超过 24 小时的草稿视为过期，清除。
      if (Date.now() - timestamp > AUTOSAVE_MAX_AGE_MS) {
        localStorage.removeItem(AUTOSAVE_KEY);
        localStorage.removeItem(AUTOSAVE_TIMESTAMP_KEY);
        return;
      }
      const draft = localStorage.getItem(AUTOSAVE_KEY);
      if (!draft) return;
      // 派发恢复事件，让 app.js 决定是否加载草稿。
      // app.js 监听 miku:restore-draft 事件，显示恢复确认对话框。
      document.dispatchEvent(new CustomEvent("miku:restore-draft", {
        detail: { projectJson: draft, timestamp },
      }));
    } catch (error) {
      // localStorage 不可用：静默跳过。
    }
  }

  // ---- 清除草稿（项目成功导出或用户主动清除后调用）----
  function clearDraft() {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
      localStorage.removeItem(AUTOSAVE_TIMESTAMP_KEY);
    } catch (error) {
      // 静默
    }
  }

  // ---- 初始化 ----
  function init() {
    // 全局错误边界（必须在 app.js 之前注册以捕获其初始化错误）
    window.addEventListener("error", handleGlobalError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    // 监听 app.js 的状态变更事件（自动保存）
    document.addEventListener("miku:state-changed", handleStateChanged);

    // 监听清除草稿事件（项目导出后 app.js 派发）
    document.addEventListener("miku:clear-draft", clearDraft);

    // 页面加载时检测未恢复的草稿
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", checkPendingDraft);
    } else {
      checkPendingDraft();
    }

    // 页面隐藏前强制保存一次（防抖计时器可能还没触发）
    window.addEventListener("pagehide", () => {
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
        // pagehide 时不能依赖异步事件，直接派发一次同步保存请求
        document.dispatchEvent(new CustomEvent("miku:request-autosave"));
      }
    });
  }

  init();
})();
