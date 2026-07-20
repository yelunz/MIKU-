# 2026-07-20 / 015 / Electron 43.x 最小桌面验证壳

## 本轮目标

按 `project-state.json` 的 `next_actions` 第二项 `wrap-stable-multitrack-workbench-in-minimal-electron-validation-shell`，把 P1.2 阶段已稳定的 Web 工作台封装进 Electron 43.x 最小桌面壳，作为 P1 末尾"可用第一版软件"的承载层。本轮只做壳层封装与 Windows x64 打包配置；Python 分析进程接入留待 P1.3。

## 用户确认的要求

- 用户最新要求：全程自动迭代，直到获取可用的第一版软件后再进行测试；不影响电脑、无威胁性的沙盒命令全部自动放行，无需手动操作。
- AGENTS.md 已规定"核心应用首版必须支持 Windows、macOS、Linux"——本轮先交付 Windows x64，macOS/Linux 打包脚本待添加。
- AGENTS.md 已规定"第三方集成优先使用厂商公开的导入/导出格式、脚本 API 或插件 API；不要依赖脆弱的界面自动点击"——Electron 是公开维护的桌面壳，不是界面自动化。
- DESKTOP_STACK_SPIKE.md 已决定 Electron 43.x 为第一验证候选，Tauri 2.11.x 保留为备选；本轮不锁定最终栈，只做验证壳。

## 子 Agent 分工

本轮为单一耦合实现（main.js / preload.js / package.json / desktop-bridge.js 守卫 / 静态测试 / 日志 / 项目状态全部共享同一桌面壳设计），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主 Agent 完成。

## 执行内容

### 1. 创建 prototype/desktop-shell/ 目录

新增 `prototype/desktop-shell/`，与 `prototype/web-workbench/` 平级。桌面壳不重复 web-workbench 源码，只包含主进程、预加载、打包配置与文档。

### 2. main.js（Electron 主进程）

- 创建 `BrowserWindow`：1440×900 默认尺寸，1024×700 最小尺寸，深色背景，标题"Miku 歌姬解放计划 · 音频工作台"。
- `webPreferences`：
  - `contextIsolation: true`（渲染器与 preload 隔离）
  - `nodeIntegration: false`（渲染器不能直接 require）
  - `sandbox: false`（preload 需要 require('electron')）
  - `spellcheck: false`
  - `preload: path.join(__dirname, "preload.js")`
- 加载本地 `../web-workbench/index.html`，不用 `loadURL`。
- 外部链接用 `setWindowOpenHandler` + `shell.openExternal` 转交系统浏览器。
- 注册白名单 IPC 处理器：
  - `miku:openFileDialog` → `dialog.showOpenDialog`
  - `miku:saveFileDialog` → `dialog.showSaveDialog`
  - `miku:readFileAsArrayBuffer` → `fs.readFile` 返回 Uint8Array 拷贝
  - `miku:readFileAsText` → `fs.readFile` utf8
  - `miku:writeTextFile` → `fs.writeFile` utf8
  - `miku:revealPathInExplorer` → `shell.showItemInFolder`
- 所有接受 `filePath` 的处理器都校验 `typeof filePath === "string" && length > 0`。
- macOS `activate` 重建窗口；非 macOS `window-all-closed` 退出。
- `uncaughtException` 捕获，避免渲染器看到崩溃窗口。

### 3. preload.js（contextBridge 桥接）

- `contextBridge.exposeInMainWorld("MikuDesktopBridge", bridge)` 暴露只读桥接对象。
- `runtime: "electron"`，`capabilities: { nativeFileDialog: true, launchAnalysisProcess: false, persistentFileAccess: true }`。
- 暴露方法：`openFileDialog`、`saveFileDialog`、`readFileAsArrayBuffer`、`readFileAsText`、`writeTextFile`、`revealPathInExplorer`、`sha256FromArrayBuffer`。
- 所有方法都是 `ipcRenderer.invoke` 白名单调用，不暴露 `ipcRenderer` 本身，不暴露 `require`。
- `sha256FromArrayBuffer` 优先用 Node `crypto`，回退到 Web Crypto。
- `bridge` 对象 `Object.freeze`，防止渲染器篡改。

### 4. desktop-bridge.js 守卫

- 在 `prototype/web-workbench/desktop-bridge.js` 顶部新增守卫：`if (typeof globalThis.MikuDesktopBridge !== "undefined") return;`
- 这样浏览器版自初始化只在 Electron preload 没设置桥接时执行。
- 同一份 web-workbench 代码可以在浏览器和 Electron 中无修改运行。
- 守卫位置在 `"use strict"` 之后、`globalThis.MikuDesktopBridge = Object.freeze({...})` 之前，避免 strict mode 下 contextBridge 只读属性赋值抛错。

### 5. package.json（electron-builder 配置）

- `name: miku-workbench`，`version: 0.3.0`，`private: true`。
- `devDependencies`：`electron ^43.1.1`、`electron-builder ^25.1.8`。
- scripts：`start`（dev 模式）、`start:prod`、`dist:win`（NSIS x64）、`dist:win:portable`、`lint`（node --check）。
- `build.files`：把 `main.js`、`preload.js`、`../web-workbench/{index.html,styles.css,app.js,desktop-bridge.js,README.md}` 打入 asar。
- `build.extraFiles`：把 `fixtures/.generated/basic-c-major-120-v1.{analysis.json,wav}` 复制到安装目录的 `fixtures/` 子目录，用户首次启动可直接选用。
- `build.win.target`：`nsis` + `x64`。
- `build.nsis`：非一键安装，允许选择安装目录，创建桌面与开始菜单快捷方式，安装语言 `zh_CN` + `en_US`。
- `build.portable`：便携版产物名。

### 6. .gitignore

排除 `node_modules/`、`dist/`、`build-resources/`、npm/yarn 调试日志与锁文件（锁文件按团队约定处理，当前为单机验证先不入库）。

### 7. README.md

- 说明桌面壳与 web-workbench 的关系（runtime、原生文件对话框、持久文件访问、中文路径可靠性、Python 分析进程）。
- 说明 desktop-bridge.js 守卫的工作原理。
- 运行环境：Node.js 18+，三平台，首轮 Windows 11 x64。
- 开发模式启动：`npm install && npm start`。
- 准备测试夹具：在仓库根目录运行 generate.py 与 analyze_audio.py。
- 打包 Windows x64：`npm run dist:win`，产物路径与命名。
- 当前边界：只暴露四类能力、Python 未接入、macOS/Linux 打包待添加、图标待补充。

### 8. 静态测试 tests/test_desktop_shell_static.py

新增 15 项静态测试，覆盖：
- package.json：name/version/private、devDependencies 含 electron ^43. 与 electron-builder、scripts 含 start/dist:win/dist:win:portable/lint 且 dist:win 含 --x64、build.files 含 web-workbench 核心文件、build.win.target 是 nsis+x64、build.extraFiles 含两个夹具文件。
- main.js：contextIsolation: true、nodeIntegration: false、preload 路径加载、加载本地 index.html 不用 loadURL、setWindowOpenHandler + shell.openExternal、6 个白名单 IPC 处理器、filePath 参数校验、activate/window-all-closed 生命周期。
- preload.js：contextBridge.exposeInMainWorld、不用 window.MikuDesktopBridge = 赋值、runtime: "electron"、openFileDialog/saveFileDialog/readFileAsArrayBuffer/readFileAsText/writeTextFile 暴露、nativeFileDialog: true + launchAnalysisProcess: false、Object.freeze、不暴露 ipcRenderer/require。
- desktop-bridge.js：Electron 守卫存在且在赋值之前、browser-prototype 回退、nativeFileDialog: false。
- .gitignore：node_modules/ 与 dist/。
- README.md：npm install / npm start / npm run dist:win / contextBridge / MikuDesktopBridge。

## 修改文件

- `prototype/desktop-shell/package.json`（新增）
- `prototype/desktop-shell/main.js`（新增）
- `prototype/desktop-shell/preload.js`（新增）
- `prototype/desktop-shell/.gitignore`（新增）
- `prototype/desktop-shell/README.md`（新增）
- `prototype/web-workbench/desktop-bridge.js`（新增 Electron 守卫）
- `tests/test_desktop_shell_static.py`（新增，15 项测试）
- `project-state.json`、`CHANGELOG.md`、`docs/ROADMAP.md`、本轮日志

## 验证

- `node --check main.js` / `node --check preload.js` / `node --check desktop-bridge.js` / `node --check app.js`：全部通过。
- `python -m unittest tests.test_web_workbench_static -v`：22 项通过（desktop-bridge.js 守卫不破坏既有测试）。
- `python -m unittest tests.test_desktop_shell_static -v`：15 项通过。
- `python -m unittest tests.test_audio_analysis -v`：4 项通过（未回归）。
- 共 41 项测试通过。
- `npm install`：344 个包安装成功（npm info ok）。
- Electron 二进制下载：通过 `node node_modules/electron/install.js` 手动触发。
- `npm start` 启动验证：未在自动化中执行（需要桌面环境），由用户首次测试时执行。
- `npm run dist:win` 打包验证：见本轮日志末尾 Git 状态前的执行结果记录。

## 决定与理由

- **桌面壳与 web-workbench 平级**：不把 Electron 文件放进 web-workbench，避免 web-workbench 被桌面壳污染。web-workbench 保持零依赖、浏览器可独立运行；桌面壳只是它的一个承载层。
- **contextBridge 而非直接 require**：contextIsolation 是 Electron 推荐的安全模型。渲染器只能调用白名单方法，不能直接 require 或访问 ipcRenderer，符合 DESKTOP_STACK_SPIKE.md "渲染器只能调用白名单桥接方法" 的边界。
- **desktop-bridge.js 守卫而非删除浏览器版**：同一份 web-workbench 代码在浏览器和 Electron 中无修改运行，降低维护成本。守卫只检查 `typeof globalThis.MikuDesktopBridge !== "undefined"`，不依赖任何 Electron 特有 API。
- **不暴露任意命令执行**：main.js 的 IPC 处理器只接受白名单方法名与字符串/ArrayBuffer 参数，不暴露 `child_process.exec` 或任意 shell。Python 分析进程接入时也会走固定的 spawn + 参数校验路径，不走通用 exec。
- **extraFiles 复制夹具**：用户首次启动桌面壳时需要立即有可用的分析 JSON 与 WAV，否则页面所有按钮都是 disabled。把夹具复制到安装目录的 `fixtures/` 子目录，用户不需要先装 Python 就能体验。
- **NSIS 而非一键安装**：NSIS 多步安装让用户选择安装目录，符合桌面应用惯例；便携版作为免安装备选。
- **不锁定最终栈**：本轮只验证 Electron 可用性，Tauri 仍保留为备选。只有三平台打包实测后才正式锁定。
- **版本号 0.3.0**：项目 schema 是 0.2.0，桌面壳作为 P1.2 末尾的承载层起步为 0.3.0，与 project-state.json 的 status 字段区分。

## 未决问题 / 下一步

- Electron 二进制下载：本轮在自动化中通过 `node node_modules/electron/install.js` 手动触发；若网络环境阻止 GitHub releases 下载，需要配置镜像（`ELECTRON_MIRROR` 环境变量）。
- `npm start` 真实启动验证：需要桌面环境，由用户首次测试时执行。
- `npm run dist:win` 打包验证：electron-builder 会下载 NSIS 与 winCodeSign 工具，可能在沙盒环境中失败；若失败需要用户在本地执行。
- macOS 与 Linux 的 electron-builder target 待添加（`dmg` + `arm64` / `AppImage` + `x64`）。
- Python 分析进程接入（P1.3）：通过 `child_process.spawn` 启动打包后的 Python，进度通过 IPC 流式回传。
- 应用图标：当前使用 Electron 默认图标，P1 末尾补充品牌图标（`build-resources/icon.ico` / `icon.icns` / `icon.png`）。
- 真实浏览器回归（next_actions 第一项）：P1.1 + P1.2 全部交互在浏览器中的真实回归测试。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待最终测试、提交和推送。
- 上一轮（014）的提交 f53ceb5 已固化本地，因 GitHub 网络连接重置暂未推送，本轮一并推送。
