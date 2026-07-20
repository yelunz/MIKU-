"use strict";

// Electron 预加载脚本：通过 contextBridge 向渲染器暴露受限的桌面能力。
//
// 安全边界：
//   - contextIsolation: true（main.js 中设置）
//   - nodeIntegration: false
//   - 渲染器只能调用这里显式暴露的方法，无法直接 require 或访问 Node API
//   - 所有方法都是白名单 IPC 调用，主进程校验参数后才执行
//
// 与 web-workbench/desktop-bridge.js 的关系：
//   - 浏览器原型中 desktop-bridge.js 会创建 globalThis.MikuDesktopBridge
//   - 在 Electron 中，本预加载脚本通过 contextBridge.exposeInMainWorld 创建
//     一个只读的 MikuDesktopBridge，desktop-bridge.js 顶部检测到已存在时会
//     跳过自初始化，从而让桌面能力覆盖浏览器能力
//   - 这样同一份 web-workbench 代码可以在浏览器和 Electron 中无修改运行

const { contextBridge, ipcRenderer } = require("electron");

const bridge = Object.freeze({
  runtime: "electron",
  capabilities: Object.freeze({
    nativeFileDialog: true,
    launchAnalysisProcess: false, // P1.3 阶段接入打包后的 Python 分析进程
    persistentFileAccess: true,
  }),

  /**
   * 打开原生文件选择对话框。
   * @param {{ title?: string, filters?: Array<{name: string, extensions: string[]}>, multiple?: boolean }} options
   * @returns {Promise<string[]>} 选中文件绝对路径数组；用户取消返回 []
   */
  async openFileDialog(options = {}) {
    const properties = options.multiple ? "multiSelections" : "openFile";
    return await ipcRenderer.invoke("miku:openFileDialog", {
      title: options.title,
      filters: options.filters,
      properties,
    });
  },

  /**
   * 打开原生保存文件对话框。
   * @param {{ title?: string, defaultFileName?: string, filters?: Array<{name: string, extensions: string[]}> }} options
   * @returns {Promise<string>} 选中路径；用户取消返回 ""
   */
  async saveFileDialog(options = {}) {
    return await ipcRenderer.invoke("miku:saveFileDialog", {
      title: options.title,
      defaultFileName: options.defaultFileName,
      filters: options.filters,
    });
  },

  /**
   * 通过 Node fs 读取文件为 ArrayBuffer。比 fetch(file://) 更可靠地处理中文路径。
   * @param {string} filePath
   * @returns {Promise<ArrayBuffer>}
   */
  async readFileAsArrayBuffer(filePath) {
    const uint8 = await ipcRenderer.invoke("miku:readFileAsArrayBuffer", filePath);
    return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
  },

  /**
   * 通过 Node fs 读取文本文件。
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  async readFileAsText(filePath) {
    return await ipcRenderer.invoke("miku:readFileAsText", filePath);
  },

  /**
   * 通过 Node fs 写入文本文件（项目保存）。
   * @param {string} filePath
   * @param {string} contents
   * @returns {Promise<boolean>}
   */
  async writeTextFile(filePath, contents) {
    return await ipcRenderer.invoke("miku:writeTextFile", filePath, contents);
  },

  /**
   * 在系统文件管理器中显示文件。
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async revealPathInExplorer(filePath) {
    return await ipcRenderer.invoke("miku:revealPathInExplorer", filePath);
  },

  /**
   * 计算 SHA-256。优先用 Node crypto，回退到 Web Crypto。
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<string>}
   */
  async sha256FromArrayBuffer(arrayBuffer) {
    try {
      const crypto = require("crypto");
      const hash = crypto.createHash("sha256");
      hash.update(Buffer.from(arrayBuffer));
      return hash.digest("hex");
    } catch (_error) {
      // 回退到 Web Crypto（与浏览器路径一致）
      const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
      return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
    }
  },
});

contextBridge.exposeInMainWorld("MikuDesktopBridge", bridge);
