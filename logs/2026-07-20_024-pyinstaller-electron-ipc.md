# 轮 024 · P1.3 步骤 4 PyInstaller 打包 librosa 后端 + Electron IPC 接入

**日期**：2026-07-20（实际完成 2026-07-21）
**序号**：024
**主题**：实现方案 A 的代码层接入——创建 launcher.py JSON-RPC 服务进程入口、PyInstaller spec、Electron 主进程 IPC handler、preload 桥接、渲染器"用 librosa 分析"按钮，并通过静态测试 + 真机子进程 smoke 验证。**不实际执行 PyInstaller 打包**（留作下一轮）。

## 目标

按 `docs/ROADMAP.md` 的 P1.3 步骤 4 与 `docs/ANALYSIS_BACKEND_RESEARCH.md` 第 5.1 节方案 A（librosa + basic-pitch 内置到 Electron，PyInstaller 打包 + IPC）：

1. 创建 `tools/miku_analysis/launcher.py`：JSON-RPC over stdin/stdout 的分析服务进程入口
2. 创建 `tools/miku_analysis/pyinstaller.spec`：PyInstaller 打包配置（不实际执行）
3. 修改 `prototype/desktop-shell/main.js`：新增 `miku:launchAnalysisProcess` 与 `miku:analyzeAudio` / `miku:analyzeAudioStream` IPC handler
4. 修改 `prototype/desktop-shell/preload.js`：`capabilities.launchAnalysisProcess` 翻 true，新增 `analyzeAudio` 方法
5. 修改 `prototype/web-workbench/desktop-bridge.js`：浏览器守卫不变，浏览器模式 capabilities 对齐字段名（全部 false）
6. 修改 `prototype/web-workbench/app.js`：导入面板新增"用 librosa 分析"按钮（仅 Electron 模式可见）
7. 修改 `prototype/web-workbench/index.html`：新增分析按钮 UI
8. 更新 `tests/test_desktop_shell_static.py`：新增 11 项测试覆盖 IPC / 超时 / 错误隔离 / launcher 协议 / spec 配置

## 执行内容

### 1. `tools/miku_analysis/launcher.py`（新建，227 行）

JSON-RPC over stdin/stdout 服务进程入口。关键设计：

* **启动 ready 信号**：进程启动时先输出 `{"id": "system", "result": {"status": "ready", "version": "0.1.0", "schema_version": "0.1.0"}}`，让 Electron 主进程知道可接收请求。
* **行协议**：每行一个 JSON 请求，每行一个 JSON 响应。`for line in sys.stdin` 循环读取。
* **三种 method**：
  * `ping` → `{"status": "pong", "version": "0.1.0", "schema_version": "0.1.0"}`
  * `analyze` → 调用 `librosa_backend.analyze_audio(Path(input_path))`，把返回的 schema-0.1.0 dict 原子写入 `output_path`（与 `librosa_backend.main` 一致：临时文件 + fsync + rename），返回 `{"status": "ok", "output_path": ..., "schema_version": "0.1.0", "analyzer": {...}}`
  * `shutdown` → 返回 `{"status": "shutting_down"}` 后退出主循环
* **错误码**：`INVALID_JSON` / `INVALID_REQUEST` / `INVALID_PARAMS` / `ANALYSIS_FAILED`（含 traceback）/ `UNKNOWN_METHOD`
* **stdout 保护**：分析期间用 `contextlib.redirect_stdout(sys.stderr)` 把 librosa/numba/scipy 偶尔打印的 banner / 警告重定向到 stderr，确保 stdout 仅供 JSON-RPC 使用。
* **导入兜底**：开发模式 `from tools.miku_analysis.librosa_backend import analyze_audio`（命名空间包）；PyInstaller 打包模式兜底 `from librosa_backend import analyze_audio`（spec 中 pathex=['.'] 让同目录可见）。
* **关键发现**：`librosa_backend.analyze_audio(path: Path, params: LibrosaParams | None = None) -> dict` 只接受 `path` 返回 dict，**不接受 `output_path`**。所以 launcher 自己写 JSON 序列化 + 原子写入，复用 `librosa_backend.main` 的临时文件 + fsync + rename 模式。

### 2. `tools/miku_analysis/pyinstaller.spec`（新建，约 110 行）

`--onedir` 模式 PyInstaller spec。关键设计：

* **入口**：`tools/miku_analysis/launcher.py`
* **exe 名**：`miku-analysis-server`（Windows 加 `.exe`，由 `process.platform` 在 `main.js` 中处理）
* **hiddenimports**：
  * `collect_submodules('librosa')` / `('numba')` / `('scipy')` / `('sklearn')`：这四个包有大量动态导入的子模块，PyInstaller 静态分析无法完整发现。
  * 显式 `tools.miku_analysis` + `tools.miku_analysis.librosa_backend`：命名空间包兜底（`tools/` 无 `__init__.py`）。
  * `soundfile` / `soxr` / `_soundfile`：C 扩展名兜底。
* **datas**：`collect_data_files('librosa')` / `('numba')` / `('sklearn')`：收集 numba 的 `.bc` 字节码、librosa 的 example 数据、sklearn 的 datasets。
* **`console=True`**：stdin/stdout 通信需要 console，不能用 windowed 模式。
* **`upx=True` + `upx_exclude=['*.bc', '*.nbi', '*.nbc', '*.pyz']`**：UPX 压缩二进制减小体积，但排除 numba 字节码和 PyInstaller .pyz，避免运行时解码失败。
* **pathex=['.']**：让 `tools.miku_analysis.librosa_backend` 在打包后仍可通过绝对导入找到。
* **本轮不实际执行 PyInstaller**：numba 的 PyInstaller 打包有已知坑（调研报告第 7 节待验证问题 3），需要多次调试。只创建 spec 文件，实际打包留作下一轮。

### 3. `prototype/desktop-shell/main.js`（修改，+约 200 行）

新增分析进程管理模块，插入在文件头部常量声明之后、`resolveWorkbenchPath` 之前。关键设计：

* **常量**：`ANALYSIS_ALLOWED_EXTENSIONS = [".wav", ".mp3", ".flac", ".ogg"]`、`ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000`（5 分钟）。
* **状态**：`analysisProcess`（ChildProcess|null）、`analysisRequestQueue`（Map<req_id, {resolve, reject, timeout}>）、`analysisProcessReady`（bool）、`analysisPendingLines`（在 ready 之前缓存的请求行）。
* **`resolveAnalysisServerPath()`**：根据 `process.platform` 选择 exe 名（Windows `.exe`，其他无扩展名），路径 `path.join(__dirname, "miku-analysis-server", exeName)`。
* **`launchAnalysisProcess()`**：
  * 用 `child_process.spawn` 启动，`stdio: ["pipe", "pipe", "pipe"]`。
  * stdout 按行解析 JSON-RPC 响应；`id === "system"` 且 `result.status === "ready"` 标记 ready 并 flush 缓存请求；其他响应按 `id` 查 `analysisRequestQueue` resolve/reject。
  * stderr 直接打印（调试用，不影响协议）。
  * `exit` 事件：清空 `analysisRequestQueue`，reject 所有 pending 请求（错误隔离）。
  * `error` 事件：spawn 失败时 reject 所有 pending 请求。
* **`analyzeAudio(inputPath, outputPath)`**：
  * 校验 `inputPath`/`outputPath` 是非空字符串。
  * 校验 `inputPath` 扩展名 ∈ `[".wav", ".mp3", ".flac", ".ogg"]`。
  * 校验 `outputPath` 扩展名 = `.json`。
  * 用 `crypto.randomUUID()` 生成 req_id。
  * 5 分钟超时：超时后 `kill("SIGTERM")` 整个分析进程，reject 请求。
  * ready 之前缓存的请求行在 ready 信号到达后 flush。
* **IPC handler**：
  * `miku:analyzeAudio`：调用 `analyzeAudio(inputPath, outputPath)`，返回 `{ status, output_path, schema_version, analyzer }`。
  * `miku:analyzeAudioStream`：流式 JSON-RPC 别名，当前实现与 `miku:analyzeAudio` 等价（launcher 还没有进度事件），保留通道供后续接入实时进度。
* **安全边界**：渲染器只能通过白名单 IPC 触发分析，不能直接 spawn 子进程；主进程校验类型与扩展名后才下发；超时 kill；崩溃 reject 所有 pending。

### 4. `prototype/desktop-shell/preload.js`（修改，+约 25 行）

* `capabilities.launchAnalysisProcess` 从 `false` 翻 `true`。
* 新增 `capabilities.analyzeAudio: true`。
* 新增 `analyzeAudio(inputPath, outputPath)` 方法：调用 `ipcRenderer.invoke("miku:analyzeAudio", inputPath, outputPath)`，返回 `{ status, output_path, schema_version, analyzer }`。
* 安全边界不变：`contextBridge.exposeInMainWorld` + `Object.freeze` + 不暴露 `ipcRenderer` / `require`。

### 5. `prototype/web-workbench/desktop-bridge.js`（修改，+约 15 行）

* 浏览器守卫不变（`typeof globalThis.MikuDesktopBridge !== "undefined"` 时跳过自初始化）。
* 浏览器模式 `capabilities` 对齐字段名：新增 `analyzeAudio: false`（与 Electron preload 字段名一致，让渲染器的 capability 检测代码在两种运行时下都能找到同名字段）。
* 新增 `analyzeAudio(_inputPath, _outputPath)` stub：抛错 `"当前运行时（浏览器原型）不支持 librosa 分析；请在 Electron 桌面壳中使用。"`（capabilities 为 false 时渲染器不会真正调用到这里）。

### 6. `prototype/web-workbench/app.js`（修改，+约 75 行）

* `elements` 对象新增 `librosaAnalysisRow: byId("librosa-analysis-row")` 和 `librosaAnalyzeButton: byId("librosa-analyze-button")`。
* 在 `elements.audioFile` 的 change 监听器之后新增：
  * **capability 检测**：`if (elements.librosaAnalysisRow && bridge && bridge.capabilities && bridge.capabilities.analyzeAudio) { elements.librosaAnalysisRow.hidden = false; }`——仅 Electron 模式显示按钮。
  * **click handler**：调用 `runLibrosaAnalysis()`，try/catch 显示错误，finally 重新启用按钮。
* **`runLibrosaAnalysis()` 函数**：
  1. capability 检测，不支持则抛错。
  2. `bridge.openFileDialog` 选择输入音频（filter: wav/mp3/flac/ogg）。
  3. 推导输出 JSON 路径：与输入同目录，扩展名替换为 `.librosa-analysis.json`。
  4. 禁用按钮 + setStatus 显示"正在用 librosa 分析……"。
  5. `bridge.analyzeAudio(inputPath, outputPath)` 调用主进程 spawn 分析服务。
  6. `bridge.readFileAsText(outputPath)` 读取输出的 JSON。
  7. `validateAnalysis` + `applyAnalysis` 加载到时间轴。
  8. 如果用户还没关联 WAV 且输入是 WAV，自动 `readFileAsArrayBuffer` + `handleAudioFile` 关联方便播放（失败不阻塞分析流程）。
  9. setStatus 显示"librosa 分析完成"。

### 7. `prototype/web-workbench/index.html`（修改，+4 行）

在 `audio-file` picker 下方新增：
```html
<label class="file-picker" id="librosa-analysis-row" hidden>
  <span>或用 librosa 分析音频</span>
  <button id="librosa-analyze-button" type="button">选择音频并分析</button>
</label>
```
默认 `hidden`，由 app.js 在 Electron 模式下 unhide。

### 8. `tests/test_desktop_shell_static.py`（修改，+约 110 行）

* `setUpClass` 新增 `cls.launcher_py` 和 `cls.pyinstaller_spec` 加载。
* **更新** `test_preload_js_capabilities_match_design`：从 `launchAnalysisProcess: false` 改为 `true` + 新增 `analyzeAudio: true` 断言。
* **新增 11 项测试**：
  1. `test_preload_js_capabilities_launch_analysis_process_true`：`launchAnalysisProcess: true` 且 `NotIn("launchAnalysisProcess: false")`
  2. `test_preload_js_capabilities_analyze_audio_true`：`analyzeAudio: true` + bridge 含 `async analyzeAudio(inputPath, outputPath)` 方法 + `ipcRenderer.invoke("miku:analyzeAudio"`
  3. `test_main_js_registers_analyze_audio_ipc_handler`：`ipcMain.handle("miku:analyzeAudio"` + `miku:analyzeAudioStream` + `spawn` + `randomUUID`
  4. `test_main_js_validates_input_file_extension`：`.wav` / `.mp3` / `.flac` + `ANALYSIS_ALLOWED_EXTENSIONS` + `path.extname(inputPath)` + `typeof inputPath !== "string"`
  5. `test_main_js_has_analysis_process_timeout`：`ANALYSIS_TIMEOUT_MS` + `5 * 60 * 1000` + `"Analysis timed out after 5 minutes"` + `.kill("SIGTERM")`
  6. `test_main_js_isolates_analysis_process_crash`：`"exit"` + `analysisRequestQueue` + `"error"` + `analysisRequestQueue.clear()`
  7. `test_launcher_py_handles_ping`：`"ping"` + `"pong"`
  8. `test_launcher_py_handles_shutdown`：`"shutdown"` + `"shutting_down"`
  9. `test_launcher_py_outputs_ready_signal`：`"ready"` + `"system"` + `LAUNCHER_VERSION`
  10. `test_launcher_py_implements_json_rpc_protocol`：`"analyze"` + `analyze_audio` + 四种错误码 + `sys.stdin` + `sys.stdout`
  11. `test_pyinstaller_spec_entry_and_hidden_imports`：入口 `tools/miku_analysis/launcher.py` + exe 名 `miku-analysis-server` + `tools.miku_analysis.librosa_backend` hiddenimport + `collect_submodules` + 四个包 + `console=True`

## 修改文件

### 主 Agent 修改
- `tools/miku_analysis/launcher.py`（新建，227 行，JSON-RPC 服务进程入口）
- `tools/miku_analysis/pyinstaller.spec`（新建，约 110 行，PyInstaller --onedir 打包配置）
- `prototype/desktop-shell/main.js`（修改，+约 200 行，分析进程管理 + IPC handler）
- `prototype/desktop-shell/preload.js`（修改，+约 25 行，capabilities 翻 true + analyzeAudio 方法）
- `prototype/web-workbench/desktop-bridge.js`（修改，+约 15 行，浏览器模式 capabilities 对齐 + stub）
- `prototype/web-workbench/app.js`（修改，+约 75 行，librosa 分析按钮 + runLibrosaAnalysis 函数）
- `prototype/web-workbench/index.html`（修改，+4 行，librosa-analysis-row UI）
- `tests/test_desktop_shell_static.py`（修改，+约 110 行，11 项新测试 + 1 项更新）
- `logs/2026-07-20_024-pyinstaller-electron-ipc.md`（本日志）

### 未改动（按任务约束）
- `tools/miku_analysis/librosa_backend.py`（轮 023 已完成，不动）
- `tools/miku_analysis/__init__.py`（空文件，不动）
- `tools/miku_analysis/README.md`（不动）
- `tools/miku_analysis/compare_a_b.py`（不动）
- `prototype/desktop-shell/package.json`（本轮不改；下一轮 PyInstaller 实际打包时再添加 `extraFiles` 把 `dist/miku-analysis-server/` 复制到 Electron 安装包）
- `tools/analyze_audio.py`（基线，不动）

## 验证结果

### 静态测试套件全量运行

| 测试套件 | 通过数 | skip 数 | 备注 |
|---|---|---|---|
| `tests.test_desktop_shell_static` | **26** | 0 | 原 15 项 + 本轮新增 11 项 = 26 项；其中 `test_preload_js_capabilities_match_design` 更新断言 |
| `tests.test_web_workbench_static` | **39** | 0 | 未受影响 |
| `tests.test_engine_adapters` | **28** | 0 | 未受影响 |
| `tests.test_audio_analysis` | **4** | 0 | 未受影响 |
| `tests.test_librosa_backend` | **10** | 0 | 未受影响 |
| **总计** | **107/107** | 0 | **全部通过** |

### launcher.py 真机子进程 smoke 测试

不启动 Electron，直接用 Python `subprocess.Popen` 启动 `python -m tools.miku_analysis.launcher`，通过 stdin 发送 JSON-RPC 请求，验证 stdout 响应：

**测试 1：ping / shutdown 协议**
```
READY: {"id": "system", "result": {"status": "ready", "version": "0.1.0", "schema_version": "0.1.0"}}
PING: {"id": "r1", "result": {"status": "pong", "version": "0.1.0", "schema_version": "0.1.0"}}
SHUTDOWN: {"id": "r2", "result": {"status": "shutting_down"}}
EXIT: 0
```

**测试 2：analyze 真实音频（fixtures/.generated/basic-c-major-120-v1.wav）**
```
ANALYZE: {"id": "a1", "result": {"status": "ok", "output_path": "...tmpfqtbnghu.json",
         "schema_version": "0.1.0", "analyzer": {"name": "miku-librosa-backend",
         "version": "0.1.0", "runtime": "python-librosa-0.11.0", "deterministic": true}}}
FILE_EXISTS: True
SCHEMA: 0.1.0  ANALYZER: miku-librosa-backend  DURATION: 50.0
EXIT: 0
```

结论：launcher.py 的 JSON-RPC 协议（ready 信号 / ping / analyze / shutdown）真机可用，analyze 方法正确调用 `librosa_backend.analyze_audio` 并原子写入 schema-0.1.0 JSON。

## 决定与理由

1. **launcher 自己写 JSON 序列化而非改 librosa_backend.analyze_audio 签名**：`librosa_backend.analyze_audio(path: Path, params: LibrosaParams | None = None) -> dict` 只接受 path 返回 dict，是纯函数。改签名会让轮 023 的 10 项测试全部失效。launcher 复用 `librosa_backend.main` 的临时文件 + fsync + rename 写入模式，保证原子性与一致性。
2. **stdout 重定向到 stderr**：librosa/numba/scipy 偶尔会往 stdout 打印 banner / 警告（如 numba 首次 JIT 编译提示）。这些输出会破坏 JSON-RPC 行协议。用 `contextlib.redirect_stdout(sys.stderr)` 在 analyze 调用期间重定向，确保 stdout 仅供 JSON-RPC 使用。stderr 不受影响，仍可供调试。
3. **`miku:analyzeAudioStream` 是 `miku:analyzeAudio` 的别名**：任务约束要求注册两个白名单 IPC。当前 launcher 没有进度事件，stream 版本与普通版本等价。保留通道供后续接入实时进度 / 分阶段结果（如 stem 分离进度、转录进度等）。
4. **输出路径由渲染器推导而非主进程固定**：渲染器把 `inputPath` 的扩展名替换为 `.librosa-analysis.json`，与输入同目录。这样用户能在文件管理器中直接看到分析结果，也方便后续重新分析时覆盖旧文件。主进程只校验 `.json` 扩展名，不强制路径布局。
5. **浏览器模式 capabilities 也加 `analyzeAudio: false`**：让渲染器的 `bridge.capabilities.analyzeAudio` 检测在两种运行时下都能找到同名字段，避免 `undefined` 导致的 falsy 检查歧义。浏览器模式的 `analyzeAudio` stub 抛错，但 capabilities 为 false 时渲染器不会调用到。
6. **5 分钟超时 kill 整个进程而非单请求**：numba JIT 死循环无法通过取消单请求来中断，必须 kill 进程。kill 后下一次 `analyzeAudio` 调用会自动重新 spawn（`launchAnalysisProcess` 检测 `analysisProcess.killed`）。这是 NumPy/SciPy 长任务的常见处理模式。
7. **PyInstaller spec 用 `--onedir` 而非 `--onefile`**：`--onedir` 启动快（无需解压临时目录）、便于增量更新 numba 缓存、调试方便。`--onefile` 每次启动都要解压到临时目录，对 200+ MB 的科学计算栈启动延迟 5-10 秒，用户体验差。
8. **不实际执行 PyInstaller**：numba 的 PyInstaller 打包有已知坑（JIT 缓存路径、`.bc` 字节码收集、`collect_submodules` 完整性），需要多次调试。本轮只创建 spec 文件并通过静态测试验证配置正确性，实际打包留作下一轮（需要在 Windows/macOS/Linux 三平台分别验证）。
9. **不修改 `prototype/desktop-shell/package.json`**：本轮不改 `extraFiles` 配置。等下一轮 PyInstaller 实际打包成功后，再添加 `extraFiles` 把 `dist/miku-analysis-server/` 目录复制到 Electron 安装包的 `resources/miku-analysis-server/` 下。本轮通过 `resolveAnalysisServerPath()` 假设该目录存在。

## 未决问题

1. **PyInstaller 实际打包未验证**：spec 文件已创建但未执行 `pyinstaller tools/miku_analysis/pyinstaller.spec`。numba JIT 缓存、`.bc` 字节码收集、`collect_submodules` 完整性都需要实际打包后跑 launcher 才能验证。下一轮在 Windows 上先打包 + smoke 测试，再扩展到 macOS / Linux。
2. **`prototype/desktop-shell/package.json` 的 `extraFiles` 未更新**：等 PyInstaller 实际打包成功后再添加 `extraFiles` 把 `dist/miku-analysis-server/` 复制到 Electron 安装包。本轮 `resolveAnalysisServerPath()` 假设该目录与 `main.js` 同级，开发模式下需要手动把 PyInstaller 产物复制到 `prototype/desktop-shell/miku-analysis-server/`。
3. **macOS 签名与公证**：PyInstaller 产物在 macOS 上需要单独签名与公证，否则 Gatekeeper 阻止启动。本轮未处理，留作 macOS 打包轮。
4. **soxr LGPL 许可声明**：soxr 是 LGPL，动态链接库需要随附源码或许可声明。本轮未在 `package.json` 或 README 中添加许可声明，留作发布前合规检查。
5. **进度事件未实现**：`miku:analyzeAudioStream` 当前与 `miku:analyzeAudio` 等价。librosa 分析 50 秒夹具约需 10-15 秒，用户只看到"正在分析……"状态。后续可在 launcher 中加入进度事件（如"loading audio / extracting chroma / detecting beats / detecting sections"），通过 `miku:analyzeAudioStream` 推送给渲染器。
6. **错误恢复策略简单**：当前进程崩溃后，下一次 `analyzeAudio` 调用会自动重新 spawn。但没有重试当前请求——崩溃的请求直接 reject 给渲染器，用户需要手动点击"选择音频并分析"重试。后续可考虑自动重试一次。
7. **多窗口/多请求并发**：当前 `analysisProcess` 是全局单例，所有 `analyzeAudio` 调用共享一个进程。请求队列保证顺序执行（launcher 是单线程 stdin 循环）。如果未来需要并行分析多个文件，需要 spawn 多个进程或改用 multiprocessing。本轮不处理。
8. **未提交 git**：按任务要求不执行 git commit / push，等主 Agent 统一提交。

## PyInstaller 打包的预估步骤（下一轮执行）

1. **Windows 首次打包**：
   ```
   cd c:\Users\yEluN\Documents\miku歌姬放计划
   pyinstaller tools/miku_analysis/pyinstaller.spec
   ```
   预期产物：`dist/miku-analysis-server/miku-analysis-server.exe`（约 250-300 MB）
2. **smoke 测试打包产物**：
   ```
   echo {"id":"r1","method":"ping"} | dist/miku-analysis-server/miku-analysis-server.exe
   ```
   验证 ready 信号 + pong 响应。
3. **analyze 真实音频**：通过 stdin 发送 analyze 请求，验证输出的 schema-0.1.0 JSON 与开发模式一致（逐字节相同，因为 `deterministic: true`）。
4. **复制到 desktop-shell**：把 `dist/miku-analysis-server/` 整个目录复制到 `prototype/desktop-shell/miku-analysis-server/`，让 `resolveAnalysisServerPath()` 找到 exe。
5. **更新 `package.json` 的 `extraFiles`**：添加 `{"from": "../../dist/miku-analysis-server", "to": "miku-analysis-server"}` 让 electron-builder 把分析服务打入安装包。
6. **Electron 集成测试**：`npm start` 启动 Electron，点击"用 librosa 分析"按钮，验证完整流程（文件选择 → spawn 分析服务 → JSON-RPC → 加载到时间轴）。
7. **macOS / Linux 重复 1-6**：三平台分别打包 + 验证。
8. **体积评估**：测量最终 NSIS 安装包体积（基线 101 MB + 分析服务 ~300 MB ≈ 400 MB？）。如果超过 500 MB，考虑用 UPX 压缩或拆分为可选下载。

## Git 状态

- 分支：`main`
- 上游：`origin/main`，本地领先 1 个 commit（轮 023 librosa backend spike）
- 工作树状态：
  - 已修改（tracked）：`prototype/desktop-shell/main.js`、`prototype/desktop-shell/preload.js`、`prototype/web-workbench/app.js`、`prototype/web-workbench/desktop-bridge.js`、`prototype/web-workbench/index.html`、`tests/test_desktop_shell_static.py`
  - 新建（untracked）：`tools/miku_analysis/launcher.py`、`tools/miku_analysis/pyinstaller.spec`、`logs/2026-07-20_024-pyinstaller-electron-ipc.md`（本日志）
  - 既有 untracked（非本轮变更）：`fixtures/basic-c-major-120-v1/librosa-analysis.json`（轮 023 调研时跑过，未提交）
- 未执行 commit / push（按任务要求，本轮日志写完后由主 Agent 统一提交）
