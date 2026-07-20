"use strict";

// P5：新手引导页独立模块。
//
// 设计目标：
//   - 渐进式呈现原则：引导页只是首屏，不隐藏专业数据。用户跳过后直接进完整工作台。
//   - 不污染全局：所有状态与函数封闭在 IIFE 内，不暴露到 window。
//   - 与 app.js 解耦：本模块只负责"显示/隐藏引导卡片"的 UI 层逻辑；
//     实际"加载示例项目"通过 CustomEvent 通知 app.js 完成（app.js 才有 state/applyAnalysis）。
//   - 双重保险：app.js 在事件绑定完成后也会调用 shouldShowOnboarding 校正首屏可见性。
//
// 与 app.js 的协作通道：
//   - 本模块 dispatchEvent("miku:load-example-project") → app.js 监听并调用 loadExampleProject()
//   - app.js dispatchEvent("miku:onboarding-complete") → 本模块监听并隐藏引导卡片
//
// localStorage key：与 app.js 中的 ONBOARDING_KEY 字符串保持一致：
//   "miku-onboarding-completed" = "true" 表示用户已完成引导，下次直接进工作台。
(() => {
  const ONBOARDING_KEY = "miku-onboarding-completed";

  function readCompletedFlag() {
    try {
      return localStorage.getItem(ONBOARDING_KEY) === "true";
    } catch (e) {
      // localStorage 不可用（隐私模式 / Electron 受限）时默认未完成，显示引导。
      return false;
    }
  }

  function writeCompletedFlag(value) {
    try {
      localStorage.setItem(ONBOARDING_KEY, value ? "true" : "false");
    } catch (e) {
      // 静默降级；本次会话仍能隐藏引导页，只是下次访问还会再看到。
    }
  }

  function getElements() {
    return {
      panel: document.getElementById("onboarding-panel"),
      importPanel: document.querySelector(".import-panel"),
      workbench: document.getElementById("workbench"),
      loadButton: document.getElementById("load-example-button"),
      skipButton: document.getElementById("skip-onboarding-button"),
      dontShowAgain: document.getElementById("dont-show-again"),
    };
  }

  function showOnboardingPanel() {
    const els = getElements();
    if (els.panel) els.panel.hidden = false;
    if (els.importPanel) els.importPanel.hidden = true;
    if (els.workbench) els.workbench.hidden = true;
  }

  function hideOnboardingPanel() {
    const els = getElements();
    if (els.panel) els.panel.hidden = true;
    if (els.importPanel) els.importPanel.hidden = false;
  }

  function init() {
    const els = getElements();
    if (!els.panel) {
      // 引导页 DOM 不存在（可能是简化页面或测试场景），不做任何处理。
      return;
    }

    // 首次访问检测：localStorage 未标记 "true" 时显示引导卡片。
    // 已完成引导时确保引导卡片隐藏、导入面板可见（与 app.js 形成双重保险）。
    if (!readCompletedFlag()) {
      showOnboardingPanel();
    } else {
      hideOnboardingPanel();
    }

    // "跳过，直接进入工作台"按钮：隐藏引导卡片，按勾选状态决定是否写入 localStorage。
    if (els.skipButton) {
      els.skipButton.addEventListener("click", () => {
        const dontShowAgain = !!(els.dontShowAgain && els.dontShowAgain.checked);
        if (dontShowAgain) writeCompletedFlag(true);
        hideOnboardingPanel();
      });
    }

    // "加载示例项目"按钮：派发事件让 app.js 执行实际加载（需要 state/applyAnalysis）。
    // app.js 加载完成后会派发 miku:onboarding-complete 事件，本模块监听并隐藏引导卡片。
    if (els.loadButton) {
      els.loadButton.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("miku:load-example-project"));
      });
    }

    // app.js 完成示例加载后通知本模块隐藏引导卡片。
    document.addEventListener("miku:onboarding-complete", () => {
      hideOnboardingPanel();
    });
  }

  // 等待 DOM ready。defer 属性已保证脚本在 HTML 解析完成后执行，
  // 但本模块可能被非 defer 方式加载（例如动态注入），故仍做一次 readyState 检测。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
