"use strict";

// Electron 主进程：最小验证壳。
// 仅做三件事：
//   1. 创建 BrowserWindow 加载 web-workbench/index.html
//   2. 注册 IPC 处理器，让渲染器通过 preload 桥接触发原生文件对话框
//   3. 处理 macOS 重新激活与窗口全关闭行为
//
// 主进程不直接读取用户音频内容；所有文件路径都通过 IPC 返回给渲染器，
// 由渲染器用 fetch / File API 自行读取。这是 DESKTOP_STACK_SPIKE.md 规定
// 的最小权限边界：渲染器只能调用白名单桥接方法，不能执行任意命令。

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");

const isDev = process.argv.includes("--dev");

/** @type {BrowserWindow | null} */
let mainWindow = null;

function resolveWorkbenchPath() {
  // 开发模式：__dirname 是 prototype/desktop-shell/，web-workbench 是本地 junction。
  // 打包后：__dirname 是 resources/app/，web-workbench 已通过 files 字段打入 asar 同级。
  // 两种情况下 path.join(__dirname, "web-workbench", "index.html") 都有效。
  return path.join(__dirname, "web-workbench", "index.html");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#1a1a2e",
    title: "Miku 歌姬解放计划 · 音频工作台",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow) mainWindow.show();
  });

  mainWindow.loadFile(resolveWorkbenchPath());

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // 让外部链接在系统浏览器打开，而不是在应用内导航。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// IPC: 打开原生文件对话框。返回选中的绝对路径数组；用户取消返回 []。
// filtersName + filters 后缀由调用方决定，主进程不预设任何后端偏好。
ipcMain.handle("miku:openFileDialog", async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const params = {
    title: typeof options?.title === "string" ? options.title : "选择文件",
    properties: typeof options?.properties === "string" ? [options.properties] : ["openFile"],
  };
  if (Array.isArray(options?.filters) && options.filters.length > 0) {
    params.filters = options.filters;
  }
  const result = await dialog.showOpenDialog(win || undefined, params);
  if (result.canceled || result.filePaths.length === 0) return [];
  return result.filePaths;
});

// IPC: 保存文件对话框。返回选中路径或空字符串。
ipcMain.handle("miku:saveFileDialog", async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const params = {
    title: typeof options?.title === "string" ? options.title : "保存文件",
  };
  if (typeof options?.defaultFileName === "string") params.defaultPath = options.defaultFileName;
  if (Array.isArray(options?.filters) && options.filters.length > 0) params.filters = options.filters;
  const result = await dialog.showSaveDialog(win || undefined, params);
  if (result.canceled || !result.filePath) return "";
  return result.filePath;
});

// IPC: 读取本地文件为 ArrayBuffer。比 fetch(file://) 更可靠地处理中文路径。
// 仅暴露读取能力，不暴露写入能力；写入由 saveFileDialog + 渲染器自行处理。
ipcMain.handle("miku:readFileAsArrayBuffer", async (event, filePath) => {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("readFileAsArrayBuffer: filePath 不能为空");
  }
  const fs = require("fs/promises");
  const buffer = await fs.readFile(filePath);
  // 返回 Uint8Array 的拷贝，避免 Buffer 引用泄露到渲染器。
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
});

// IPC: 读取文本文件。
ipcMain.handle("miku:readFileAsText", async (event, filePath) => {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("readFileAsText: filePath 不能为空");
  }
  const fs = require("fs/promises");
  return await fs.readFile(filePath, "utf8");
});

// IPC: 写入文本文件（用于项目保存）。
ipcMain.handle("miku:writeTextFile", async (event, filePath, contents) => {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("writeTextFile: filePath 不能为空");
  }
  if (typeof contents !== "string") {
    throw new Error("writeTextFile: contents 必须是字符串");
  }
  const fs = require("fs/promises");
  await fs.writeFile(filePath, contents, "utf8");
  return true;
});

// IPC: 在文件管理器中显示文件。
ipcMain.handle("miku:revealPathInExplorer", async (event, filePath) => {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  shell.showItemInFolder(filePath);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 捕获未处理异常，避免渲染器看到崩溃窗口。
process.on("uncaughtException", (error) => {
  console.error("[main] uncaughtException:", error);
});
