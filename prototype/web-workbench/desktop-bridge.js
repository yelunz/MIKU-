"use strict";

(() => {
  const objectUrls = new Set();

  globalThis.MikuDesktopBridge = Object.freeze({
    runtime: "browser-prototype",
    capabilities: Object.freeze({
      nativeFileDialog: false,
      launchAnalysisProcess: false,
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
  });
})();
