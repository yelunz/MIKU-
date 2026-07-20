# Miku 歌姬工作台 · Electron 桌面壳

这是 P1.2 阶段的最小 Electron 43.x 验证壳。它把 `prototype/web-workbench/` 的零依赖 Web 工作台封装成可独立运行的桌面应用，并提供原生文件对话框、本地文件读写、SHA-256 计算等能力，作为后续接入打包 Python 分析进程的承载层。

本目录不重复 web-workbench 的源码；它只包含主进程、预加载脚本和打包配置。Web 工作台的代码通过 `electron-builder` 的 `files` 字段直接打入 asar。

## 与 web-workbench 的关系

| 维度 | 浏览器原型（`../web-workbench/`） | Electron 桌面壳（本目录） |
|---|---|---|
| 入口 | `index.html` 直接在浏览器打开 | Electron 主进程加载 `index.html` |
| `MikuDesktopBridge.runtime` | `"browser-prototype"` | `"electron"` |
| 原生文件对话框 | 否（用 `<input type="file">`） | 是（IPC + `dialog.showOpenDialog`） |
| 持久文件访问 | 否（每次重开页面要重新选文件） | 是（路径由主进程持有，可重新读取） |
| 中文路径可靠性 | 视浏览器而定 | Node `fs` 直接读取，无编码问题 |
| Python 分析进程 | 不适用 | P1.3 阶段接入（当前未启用） |

`web-workbench/desktop-bridge.js` 顶部有一段守卫：如果 `globalThis.MikuDesktopBridge` 已被 Electron preload 通过 `contextBridge` 设置，则跳过浏览器版的自初始化。这样同一份 web-workbench 代码可以在浏览器和 Electron 中无修改运行。

## 运行环境

- Node.js 18+（Electron 43.x 官方前置条件）
- Windows 10/11 x64、macOS 13+ Apple Silicon、Ubuntu 22.04 x64
- 首轮打包验证目标：Windows 11 x64

## 开发模式启动

```powershell
cd prototype/desktop-shell
npm install
npm start
```

`npm start` 会以 `--dev` 参数启动 Electron，自动打开 DevTools。窗口加载 `../web-workbench/index.html`。

首次启动时仍需通过页面上的"分析 JSON"和"无人声伴奏 WAV"按钮选择文件。在 Electron 中，`<input type="file">` 会触发系统原生文件对话框；同时 preload 暴露了 `MikuDesktopBridge.openFileDialog()` 等方法供后续扩展使用。

## 准备测试夹具

桌面壳不打包夹具，需要在仓库根目录生成：

```powershell
python fixtures/basic-c-major-120-v1/generate.py
python tools/analyze_audio.py fixtures/.generated/basic-c-major-120-v1.wav -o fixtures/.generated/basic-c-major-120-v1.analysis.json
```

打包后的安装包会通过 `electron-builder` 的 `extraFiles` 把 `fixtures/.generated/basic-c-major-120-v1.analysis.json` 与 `.wav` 复制到安装目录的 `fixtures/` 子目录，方便用户首次启动时直接选用。

## 打包 Windows x64 安装包

```powershell
cd prototype/desktop-shell
npm install
npm run dist:win
```

产物位于 `prototype/desktop-shell/dist/`：
- `Miku-Workbench-0.3.0-win-x64.exe`：NSIS 安装程序，支持选择安装目录、创建桌面与开始菜单快捷方式。
- `Miku-Workbench-0.3.0-win-x64-portable.exe`（如运行 `npm run dist:win:portable`）：免安装便携版。

## 当前边界

- 这是 P1.2 阶段的最小验证壳，不是最终发布版本。
- 桌面壳只暴露文件对话框、文件读写、SHA-256 与"在资源管理器中显示"四类能力；不暴露任意命令执行。
- Python 分析进程尚未接入，启动后仍需手动选择已生成的分析 JSON 与 WAV。
- macOS 与 Linux 的打包脚本待添加（`electron-builder` 配置已预留三平台字段）。
- 应用图标暂未提供，使用 Electron 默认图标；P1 末尾会补充品牌图标。
