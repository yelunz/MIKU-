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
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");

const isDev = process.argv.includes("--dev");

/** @type {BrowserWindow | null} */
let mainWindow = null;

// ---- 分析进程管理（P1.3 步骤 4：方案 A PyInstaller 内置 + JSON-RPC IPC）------
//
// launcher.py 通过 stdin/stdout 流式 JSON-RPC 与主进程通信。主进程在这里
// 维护一个长期子进程 + 请求队列，把渲染器的 miku:analyzeAudio 调用映射成
// JSON-RPC 请求，把响应 Promise resolve 回去。
//
// 安全边界：
//   * 渲染器只能通过白名单 IPC 触发分析，不能直接 spawn 子进程。
//   * 主进程校验 inputPath / outputPath 类型与扩展名后再下发。
//   * 单次请求 5 分钟超时，超时后 kill 整个分析进程，避免 numba 死循环。
//   * 分析进程崩溃时拒绝所有 pending 请求，渲染器收到错误而非挂起。

/** @type {import("child_process").ChildProcess | null} */
let analysisProcess = null;
/** @type {Map<string, { resolve: Function, reject: Function, timeout: NodeJS.Timeout }>} */
const analysisRequestQueue = new Map();
/** 子进程是否已发出 ready 信号。 */
let analysisProcessReady = false;
/** 在 ready 之前到达的请求行（理论上一开始为空，但保险起见保留）。 */
const analysisPendingLines = [];

// 沙盒命令自动放行：分析进程是项目自带的可信可执行文件，不需要用户确认。
const ANALYSIS_ALLOWED_EXTENSIONS = [".wav", ".mp3", ".flac", ".ogg"];
const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

function resolveAnalysisServerPath() {
  // 打包后：miku-analysis-server 目录与 main.js 同级（electron-builder
  //   extraFiles 把 PyInstaller dist 复制到 resources/miku-analysis-server/）
  // 开发模式：同上，但需要先手动跑 PyInstaller 才能找到。
  const exeName = process.platform === "win32" ? "miku-analysis-server.exe" : "miku-analysis-server";
  return path.join(__dirname, "miku-analysis-server", exeName);
}

function launchAnalysisProcess() {
  if (analysisProcess && !analysisProcess.killed) {
    return analysisProcess;
  }
  const serverPath = resolveAnalysisServerPath();
  analysisProcessReady = false;
  if (fs.existsSync(serverPath)) {
    // 优先使用 PyInstaller 打包的可执行文件（生产模式）。
    analysisProcess = spawn(serverPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  } else {
    // 降级到 python -m 模式（开发模式 / 打包未完成时）。
    // 项目根目录 = desktop-shell 的上两级。打包后此路径不存在，但此时
    // PyInstaller exe 应该已经存在，不会走到这个分支。
    const projectRoot = path.resolve(__dirname, "..", "..");
    if (!fs.existsSync(path.join(projectRoot, "tools", "miku_analysis", "launcher.py"))) {
      throw new Error(
        `Analysis server not found at ${serverPath}, and project root ${projectRoot} ` +
        `does not contain tools/miku_analysis/launcher.py. ` +
        `Please run "pyinstaller tools/miku_analysis/pyinstaller.spec" first, ` +
        `or run from the project root in dev mode.`
      );
    }
    analysisProcess = spawn("python", ["-m", "tools.miku_analysis.launcher"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    });
  }

  analysisProcess.stdout.on("data", (data) => {
    // 按行解析 JSON-RPC 响应。launcher.py 每个响应一行。
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        console.error("[analysis-server] failed to parse stdout line:", line, error);
        continue;
      }
      // ready 信号：id === "system" && result.status === "ready"
      if (response.id === "system" && response.result && response.result.status === "ready") {
        analysisProcessReady = true;
        // 保险起见：flush 任何在 ready 之前缓存的请求行。
        for (const pending of analysisPendingLines) {
          analysisProcess.stdin.write(pending);
        }
        analysisPendingLines.length = 0;
        continue;
      }
      const reqId = response.id;
      if (!reqId) continue;
      const pending = analysisRequestQueue.get(reqId);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      analysisRequestQueue.delete(reqId);
      if (response.error) {
        const err = new Error(response.error.message || "analysis failed");
        err.code = response.error.code;
        err.traceback = response.error.traceback;
        pending.reject(err);
      } else {
        pending.resolve(response.result);
      }
    }
  });

  analysisProcess.stderr.on("data", (data) => {
    // stderr 仅供调试，不影响 JSON-RPC 协议。
    console.error("[analysis-server]", data.toString().trimEnd());
  });

  analysisProcess.on("exit", (code, signal) => {
    console.log(`[analysis-server] exited code=${code} signal=${signal}`);
    analysisProcess = null;
    analysisProcessReady = false;
    // 拒绝所有 pending 请求：进程崩溃不能让渲染器挂起。
    for (const [, pending] of analysisRequestQueue) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Analysis server exited (code=${code}, signal=${signal})`));
    }
    analysisRequestQueue.clear();
  });

  analysisProcess.on("error", (error) => {
    // spawn 本身失败（路径不存在 / 权限不足等）。
    console.error("[analysis-server] spawn error:", error);
    analysisProcess = null;
    analysisProcessReady = false;
    for (const [, pending] of analysisRequestQueue) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Failed to launch analysis server: ${error.message}`));
    }
    analysisRequestQueue.clear();
  });

  return analysisProcess;
}

function analyzeAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (typeof inputPath !== "string" || typeof outputPath !== "string") {
      reject(new Error("inputPath and outputPath must be strings"));
      return;
    }
    if (inputPath.length === 0 || outputPath.length === 0) {
      reject(new Error("inputPath and outputPath must not be empty"));
      return;
    }
    // 校验输入扩展名。output 必须是 .json（与 schema 一致）。
    const allowedExt = ANALYSIS_ALLOWED_EXTENSIONS;
    const inputExt = path.extname(inputPath).toLowerCase();
    if (!allowedExt.includes(inputExt)) {
      reject(new Error(`Unsupported input format: ${inputExt}. Allowed: ${allowedExt.join(", ")}`));
      return;
    }
    const outputExt = path.extname(outputPath).toLowerCase();
    if (outputExt !== ".json") {
      reject(new Error(`Output path must end with .json, got: ${outputExt}`));
      return;
    }

    let processHandle;
    try {
      processHandle = launchAnalysisProcess();
    } catch (error) {
      reject(error);
      return;
    }

    const reqId = randomUUID();
    const request = {
      id: reqId,
      method: "analyze",
      params: { input_path: inputPath, output_path: outputPath },
    };
    const line = JSON.stringify(request) + "\n";

    const timeout = setTimeout(() => {
      analysisRequestQueue.delete(reqId);
      // 超时后 kill 整个分析进程，避免 numba 死循环继续占用 CPU。
      if (analysisProcess && !analysisProcess.killed) {
        analysisProcess.kill("SIGTERM");
      }
      reject(new Error("Analysis timed out after 5 minutes"));
    }, ANALYSIS_TIMEOUT_MS);

    analysisRequestQueue.set(reqId, { resolve, reject, timeout });

    // 如果还没 ready，缓存请求行，等 ready 信号到达后再 flush。
    if (analysisProcessReady) {
      processHandle.stdin.write(line);
    } else {
      analysisPendingLines.push(line);
    }
  });
}

// IPC: 用打包后的 librosa 分析进程分析本地音频，把 schema-0.1.0 JSON 写到
// outputPath。渲染器拿到 outputPath 后用 readFileAsText 读取并加载到时间轴。
ipcMain.handle("miku:analyzeAudio", async (event, inputPath, outputPath) => {
  return await analyzeAudio(inputPath, outputPath);
});

// IPC: 流式 JSON-RPC 别名。当前实现与 miku:analyzeAudio 等价（launcher 还
// 没有进度事件），保留通道供后续接入实时进度 / 分阶段结果。
ipcMain.handle("miku:analyzeAudioStream", async (event, inputPath, outputPath) => {
  return await analyzeAudio(inputPath, outputPath);
});

// P6: 4-stem 音源分离。复用 analysisProcess，通过 JSON-RPC 调用 separate_stems。
// inputPath 校验扩展名；outputDir 由调用方决定（通常是输入音频同级 .stems/ 目录）。
function separateStems(inputPath, outputDir, manifestPath) {
  return new Promise((resolve, reject) => {
    if (typeof inputPath !== "string" || typeof outputDir !== "string") {
      reject(new Error("inputPath and outputDir must be strings"));
      return;
    }
    if (inputPath.length === 0 || outputDir.length === 0) {
      reject(new Error("inputPath and outputDir must not be empty"));
      return;
    }
    const inputExt = path.extname(inputPath).toLowerCase();
    if (!ANALYSIS_ALLOWED_EXTENSIONS.includes(inputExt)) {
      reject(new Error(`Unsupported input format: ${inputExt}. Allowed: ${ANALYSIS_ALLOWED_EXTENSIONS.join(", ")}`));
      return;
    }

    let processHandle;
    try {
      processHandle = launchAnalysisProcess();
    } catch (error) {
      reject(error);
      return;
    }

    const reqId = randomUUID();
    const request = {
      id: reqId,
      method: "separate_stems",
      params: { input_path: inputPath, output_dir: outputDir, manifest_path: manifestPath || "" },
    };
    const line = JSON.stringify(request) + "\n";

    const timeout = setTimeout(() => {
      analysisRequestQueue.delete(reqId);
      if (analysisProcess && !analysisProcess.killed) {
        analysisProcess.kill("SIGTERM");
      }
      reject(new Error("Stem separation timed out after 5 minutes"));
    }, ANALYSIS_TIMEOUT_MS);

    analysisRequestQueue.set(reqId, { resolve, reject, timeout });
    if (analysisProcessReady) {
      processHandle.stdin.write(line);
    } else {
      analysisPendingLines.push(line);
    }
  });
}

ipcMain.handle("miku:separateStems", async (event, inputPath, outputDir, manifestPath) => {
  return await separateStems(inputPath, outputDir, manifestPath);
});

// P7: 自动音符转录。复用 analysisProcess，通过 JSON-RPC 调用 transcribe。
function transcribeAudio(inputPath, outputPath, params) {
  return new Promise((resolve, reject) => {
    if (typeof inputPath !== "string" || typeof outputPath !== "string") {
      reject(new Error("inputPath and outputPath must be strings"));
      return;
    }
    if (inputPath.length === 0 || outputPath.length === 0) {
      reject(new Error("inputPath and outputPath must not be empty"));
      return;
    }
    const inputExt = path.extname(inputPath).toLowerCase();
    if (!ANALYSIS_ALLOWED_EXTENSIONS.includes(inputExt)) {
      reject(new Error(`Unsupported input format: ${inputExt}. Allowed: ${ANALYSIS_ALLOWED_EXTENSIONS.join(", ")}`));
      return;
    }
    const outputExt = path.extname(outputPath).toLowerCase();
    if (outputExt !== ".json") {
      reject(new Error(`Output path must end with .json, got: ${outputExt}`));
      return;
    }

    let processHandle;
    try {
      processHandle = launchAnalysisProcess();
    } catch (error) {
      reject(error);
      return;
    }

    const reqId = randomUUID();
    const safeParams = params && typeof params === "object" ? params : {};
    const request = {
      id: reqId,
      method: "transcribe",
      params: {
        input_path: inputPath,
        output_path: outputPath,
        fmin_hz: typeof safeParams.fmin_hz === "number" ? safeParams.fmin_hz : 65.41,
        fmax_hz: typeof safeParams.fmax_hz === "number" ? safeParams.fmax_hz : 1046.5,
      },
    };
    const line = JSON.stringify(request) + "\n";

    const timeout = setTimeout(() => {
      analysisRequestQueue.delete(reqId);
      if (analysisProcess && !analysisProcess.killed) {
        analysisProcess.kill("SIGTERM");
      }
      reject(new Error("Transcription timed out after 5 minutes"));
    }, ANALYSIS_TIMEOUT_MS);

    analysisRequestQueue.set(reqId, { resolve, reject, timeout });
    if (analysisProcessReady) {
      processHandle.stdin.write(line);
    } else {
      analysisPendingLines.push(line);
    }
  });
}

ipcMain.handle("miku:transcribeAudio", async (event, inputPath, outputPath, params) => {
  return await transcribeAudio(inputPath, outputPath, params);
});

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

// v0.10.1 IPC: 解析打包后 fixtures 目录下的文件绝对路径。
// 渲染器用此路径 + bridge.readFileAsText / readFileAsArrayBuffer 读取示例项目，
// 绕过 Electron webSecurity 对 file:// 跨目录 fetch 的限制。
// relativePath 例如 "basic-c-major-120-v1/librosa-analysis-v2.json"。
// 查找顺序：
//   1. <安装根>/fixtures/<relativePath>（打包后：win-unpacked/fixtures/，
//      process.resourcesPath 是 <安装根>/resources/，取上一层得安装根）
//   2. __dirname/../../fixtures/<relativePath>（开发模式：desktop-shell/../fixtures/）
//   3. __dirname/../fixtures/<relativePath>（备用）
// 返回找到的绝对路径字符串；找不到返回空字符串。
ipcMain.handle("miku:resolvePackagedFixture", async (event, relativePath) => {
  if (typeof relativePath !== "string" || relativePath.length === 0) return "";
  // 防止路径穿越：只允许相对子路径，不允许 .. 或绝对路径。
  if (relativePath.includes("..") || path.isAbsolute(relativePath)) return "";
  const installRoot = path.dirname(process.resourcesPath);
  const candidates = [
    path.join(installRoot, "fixtures", relativePath),
    path.join(__dirname, "..", "..", "fixtures", relativePath),
    path.join(__dirname, "..", "fixtures", relativePath),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (e) {
      // continue searching
    }
  }
  return "";
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
