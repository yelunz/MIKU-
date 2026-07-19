# 桌面技术栈验证决定

## 当前结论

截至 2026-07-20，本轮不把核心前端不可逆地绑定到某一个桌面壳。将 Electron 43.x 作为第一验证候选，Tauri 2.11.x 作为体积与权限优化备选；只有同一时间轴和分析进程在 Windows、macOS、Linux 完成打包实测后才正式锁定。

这是 `Proposed` 技术决定，不改变用户已经确认的三平台要求，也不改变 OpenUtau、Synthesizer V Studio Pro 1.9.0 和 VOCALOID6 的适配优先级。

## 官方资料核对

| 维度 | Electron | Tauri 2 |
|---|---|---|
| 当前维护 | 官方发布列表当前稳定版为 43.1.1；官方只支持最近三个稳定大版本，需要持续跟进安全更新。 | 官方发布页当前核心版本为 2.11.5。 |
| 三平台 | 官方二进制支持 Windows、macOS、Linux；Linux 预编译件以 Ubuntu 22.04 构建。 | Bundler 支持三平台，但 Windows 需要 MSVC/WebView2、macOS 需要 Xcode 工具、Linux 需要 WebKitGTK 等平台依赖。 |
| 渲染 | 随应用捆绑同一 Chromium，复杂 Canvas/WebAudio/字体行为更容易保持一致。 | 使用系统 WebView：Windows WebView2、macOS WKWebView、Linux WebKitGTK，必须额外验证差异。 |
| 文件与分析进程 | 主进程是 Node 环境，可通过受限 IPC 调用文件 API 和 Python 子进程；渲染器保持沙箱。 | Rust 后端具有文件能力；Python 作为 sidecar 时，需要为各系统和架构准备 target-triple 二进制并授予权限。 |
| 体积 | 分发物携带 Chromium 与 Node，基础体积较大，必须实测成品。 | 最小壳较小；但官方说明 Linux AppImage 加入音视频媒体框架后可能增大到 70 MB 以上，不能用空项目数字估算本项目。 |
| 工程成本 | JavaScript/TypeScript + 现有 Python，第一轮接入路径较短；需要频繁升级 Electron。 | JavaScript/TypeScript + Rust + Python，加上三平台原生工具链；换取更小基础壳和更细权限。 |

官方来源：

- Electron：[发布列表](https://releases.electronjs.org/release/)、[支持周期](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)、[平台说明](https://github.com/electron/electron)、[进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[沙箱](https://www.electronjs.org/docs/latest/tutorial/sandbox/)、[分发](https://www.electronjs.org/docs/latest/tutorial/application-distribution/)
- Tauri：[发布列表](https://tauri.app/release/)、[架构](https://v2.tauri.app/concept/architecture/)、[前置条件](https://v2.tauri.app/start/prerequisites/)、[WebView 版本](https://v2.tauri.app/reference/webview-versions/)、[文件系统插件](https://v2.tauri.app/plugin/file-system/)、[Sidecar](https://v2.tauri.app/develop/sidecar/)、[AppImage 音视频说明](https://v2.tauri.app/distribute/appimage/)

## 为什么优先验证 Electron

以下是基于官方事实的工程推断，不是流行度结论：

- 项目已有 Python 分析 CLI，Electron 主进程管理子进程的路径更短。
- 时间轴将依赖 Canvas/WebGL/WebAudio、高 DPI、中文和日文字体；统一 Chromium 可以降低首轮跨平台渲染变量。
- 当前没有安装包体积硬指标，不能仅凭最小空壳体积牺牲验证速度。
- Electron 的安全代价需要通过固定受支持版本、及时升级、`contextIsolation`、沙箱和白名单 IPC 管理。

## 与桌面壳无关的桥接边界

前端业务状态不得直接调用 Electron、Tauri、Node 或 Rust API。当前浏览器原型已用 `desktop-bridge.js` 隔离对象 URL、文件哈希和 JSON 下载；进入桌面验证后扩展统一接口：

- `openAudioFile()`
- `startAnalysis(input, options)`
- `cancelAnalysis(jobId)`
- `subscribeAnalysisProgress(jobId)`
- `readAnalysisResult(projectId)`
- `saveProject(project)`
- `revealExportedFile(path)`

桌面实现只返回授权文件句柄、任务状态和中立项目数据，不向渲染器暴露任意文件系统或命令执行能力。

## 最小验证矩阵

在 Windows 10/11 x64、macOS 13+ Apple Silicon、Ubuntu 22.04 x64 分别构建真正的 packaged artifact，并验证：

1. 原生文件对话框导入当前 50 秒 WAV，核对 SHA-256。
2. 启动打包后的 Python 分析进程，读取进度、取消任务并处理异常退出和中文路径。
3. 绘制波形、节拍、和弦、段落、歌词选区；连续缩放拖动 60 秒。
4. 检查高 DPI、窗口缩放、中文/日文字体和输入法。
5. 播放、暂停、跳转后检查播放头误差。
6. 记录安装包体积、冷启动、空闲内存和分析峰值内存。
7. 验证渲染器只能调用白名单桥接方法，不能执行任意命令。
8. 在未安装 Python、Node 或 Rust 的干净机器运行。

若两者均通过，默认选择 Electron；只有成品体积、内存或启动指标不可接受时，才把 Tauri 提升为首选。
