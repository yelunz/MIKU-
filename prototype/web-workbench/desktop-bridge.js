"use strict";

// 浏览器版桌面桥接：只在渲染器还没有 MikuDesktopBridge 时初始化。
// 在 Electron 中，preload.js 通过 contextBridge.exposeInMainWorld 暴露一个
// 只读的 MikuDesktopBridge，此时本脚本会跳过自初始化，让桌面能力生效。
// 这样同一份 web-workbench 代码可以在浏览器和 Electron 中无修改运行。
//
// 浏览器模式下的 capabilities 与 Electron preload 对齐字段名，但全部为
// false：浏览器不能 spawn 本地分析进程，也不能持久访问本地文件。渲染器
// 通过 capabilities.analyzeAudio 判断是否显示"用 librosa 分析"按钮。
(() => {
  if (typeof globalThis.MikuDesktopBridge !== "undefined") return;

  const objectUrls = new Set();

  globalThis.MikuDesktopBridge = Object.freeze({
    runtime: "browser-prototype",
    capabilities: Object.freeze({
      nativeFileDialog: false,
      launchAnalysisProcess: false,
      analyzeAudio: false,
      persistentFileAccess: false,
    }),

    createObjectUrl(blob) {
      const url = URL.createObjectURL(blob);
      objectUrls.add(url);
      return url;
    },

    revokeObjectUrl(url) {
      if (!url) return;
      URL.revokeObjectURL(url);
      objectUrls.delete(url);
    },

    revokeAllObjectUrls() {
      objectUrls.forEach(url => URL.revokeObjectURL(url));
      objectUrls.clear();
    },

    async sha256(file) {
      if (!globalThis.crypto || !crypto.subtle) throw new Error("当前浏览器不提供 Web Crypto。");
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    },

    downloadJson(fileName, value) {
      const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
      const url = this.createObjectUrl(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => this.revokeObjectUrl(url), 0);
    },

    // 浏览器模式不能调用本地分析进程；保留方法签名让渲染器的 capability
    // 检测代码在两种运行时下都能找到同名字段（但 capabilities.analyzeAudio
    // 为 false，渲染器不会真正调用到这里）。
    async analyzeAudio(_inputPath, _outputPath) {
      throw new Error("当前运行时（浏览器原型）不支持 librosa 分析；请在 Electron 桌面壳中使用。");
    },
  });
})();
