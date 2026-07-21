"""桌面壳（Electron）静态测试。

只检查 prototype/desktop-shell/ 下的源文件内容与配置，不启动 Electron。
启动与打包验证由人工或集成测试在 Windows/macOS/Linux 上执行。
"""

from pathlib import Path
import json
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DESKTOP_SHELL = REPOSITORY_ROOT / "prototype" / "desktop-shell"
WEB_WORKBENCH = REPOSITORY_ROOT / "prototype" / "web-workbench"
MIKU_ANALYSIS = REPOSITORY_ROOT / "tools" / "miku_analysis"


class DesktopShellStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.main_js = (DESKTOP_SHELL / "main.js").read_text(encoding="utf-8")
        cls.preload_js = (DESKTOP_SHELL / "preload.js").read_text(encoding="utf-8")
        cls.package_json_raw = (DESKTOP_SHELL / "package.json").read_text(encoding="utf-8")
        cls.package_json = json.loads(cls.package_json_raw)
        cls.readme = (DESKTOP_SHELL / "README.md").read_text(encoding="utf-8")
        cls.gitignore = (DESKTOP_SHELL / ".gitignore").read_text(encoding="utf-8")
        cls.desktop_bridge_js = (WEB_WORKBENCH / "desktop-bridge.js").read_text(encoding="utf-8")
        # P1.3 步骤 4：分析服务进程入口与 PyInstaller spec。
        cls.launcher_py = (MIKU_ANALYSIS / "launcher.py").read_text(encoding="utf-8")
        cls.pyinstaller_spec = (MIKU_ANALYSIS / "pyinstaller.spec").read_text(encoding="utf-8")

    def test_package_json_declares_electron_and_electron_builder(self) -> None:
        self.assertEqual(self.package_json["name"], "miku-workbench")
        self.assertEqual(self.package_json["main"], "main.js")
        self.assertEqual(self.package_json["private"], True)
        # 版本号与项目 0.4.0 schema 一致；P4 完整编排 + P5 错误恢复 + USTX 0.7 + VOCALOID6 适配
        # v0.6.1 新增 PyInstaller 内置分析服务（miku-analysis-server.exe 随安装包分发）
        self.assertEqual(self.package_json["version"], "0.6.1")
        # Electron 43.x 与 electron-builder 25.x 是 DESKTOP_STACK_SPIKE.md 决定的版本
        self.assertIn("electron", self.package_json["devDependencies"])
        self.assertRegex(
            self.package_json["devDependencies"]["electron"],
            r"\^43\.",
        )
        self.assertIn("electron-builder", self.package_json["devDependencies"])

    def test_package_json_scripts_cover_dev_and_dist(self) -> None:
        scripts = self.package_json["scripts"]
        self.assertIn("start", scripts)
        self.assertIn("dist:win", scripts)
        self.assertIn("dist:win:portable", scripts)
        self.assertIn("lint", scripts)
        # dist:win 必须显式指定 --x64
        self.assertIn("--x64", scripts["dist:win"])

    def test_package_json_build_includes_web_workbench_files(self) -> None:
        files = self.package_json["build"]["files"]
        # 必须把 web-workbench 的核心文件打入 asar
        # web-workbench 通过 junction 出现在 desktop-shell 本地目录
        self.assertIn("web-workbench/index.html", files)
        self.assertIn("web-workbench/styles.css", files)
        self.assertIn("web-workbench/app.js", files)
        self.assertIn("web-workbench/desktop-bridge.js", files)
        # v0.6.0：P5 新手引导 + 错误恢复模块必须随 asar 打包
        self.assertIn("web-workbench/onboarding.js", files)
        self.assertIn("web-workbench/error-recovery.js", files)

    def test_package_json_build_win_target_is_nsis_x64(self) -> None:
        win = self.package_json["build"]["win"]
        self.assertEqual(win["target"][0]["target"], "nsis")
        self.assertIn("x64", win["target"][0]["arch"])

    def test_package_json_build_carries_fixtures_as_extra_files(self) -> None:
        # 打包后用户首次启动需要夹具，否则页面无法选择分析 JSON
        # v0.6.0：extraFiles 扩展到 3 组 —— 生成夹具、基础夹具目录、集成夹具目录
        # v0.6.1：新增第 0 组 PyInstaller 打包的 miku-analysis-server 目录（含 exe + 依赖）
        extra_files = self.package_json["build"]["extraFiles"]
        self.assertEqual(len(extra_files), 4)
        # 第 0 组（v0.6.1 新增）：PyInstaller 打包的分析服务目录
        self.assertEqual(extra_files[0]["to"], "miku-analysis-server")
        self.assertEqual(extra_files[0]["from"], "../../dist/miku-analysis-server")
        # 第一组：生成夹具（分析 JSON + WAV）
        self.assertEqual(extra_files[1]["to"], "fixtures")
        filters1 = extra_files[1]["filter"]
        self.assertIn("basic-c-major-120-v1.analysis.json", filters1)
        self.assertIn("basic-c-major-120-v1.wav", filters1)
        # 第二组：基础夹具目录（librosa 分析 v2 + 标准答案 + README）
        self.assertEqual(extra_files[2]["to"], "fixtures/basic-c-major-120-v1")
        filters2 = extra_files[2]["filter"]
        self.assertIn("librosa-analysis-v2.json", filters2)
        self.assertIn("ground-truth.json", filters2)
        self.assertIn("README.md", filters2)
        # 第三组：集成夹具目录（USTX/MIDI/SynthV sidecar/VOCALOID6 一致性样例）
        self.assertEqual(extra_files[3]["to"], "fixtures/integration")
        filters3 = extra_files[3]["filter"]
        self.assertIn("integration-fixture.json", filters3)
        self.assertIn("integration-fixture.ustx", filters3)
        self.assertIn("integration-fixture.mid", filters3)
        self.assertIn("integration-fixture-vocaloid6.mid", filters3)

    def test_main_js_enforces_security_boundaries(self) -> None:
        # contextIsolation 必须开启，渲染器不能直接访问 Node
        self.assertIn("contextIsolation: true", self.main_js)
        # nodeIntegration 必须关闭
        self.assertIn("nodeIntegration: false", self.main_js)
        # preload 必须通过路径加载
        self.assertIn('path.join(__dirname, "preload.js")', self.main_js)
        # 必须加载 web-workbench/index.html，不能是远程 URL
        self.assertIn('path.join(__dirname, "web-workbench", "index.html")', self.main_js)
        self.assertNotIn("loadURL", self.main_js)
        # 外部链接必须用系统浏览器打开，不能在应用内导航
        self.assertIn("setWindowOpenHandler", self.main_js)
        self.assertIn("shell.openExternal", self.main_js)

    def test_main_js_registers_whitelist_ipc_handlers(self) -> None:
        # IPC 处理器只能通过 ipcMain.handle 注册（白名单），不能 expose 任意 ipcRenderer.send
        for handler in (
            "miku:openFileDialog",
            "miku:saveFileDialog",
            "miku:readFileAsArrayBuffer",
            "miku:readFileAsText",
            "miku:writeTextFile",
            "miku:revealPathInExplorer",
        ):
            self.assertIn(f'ipcMain.handle("{handler}"', self.main_js)
        # 主进程必须校验 filePath 参数，不能盲接渲染器传入的任意路径
        self.assertIn('typeof filePath !== "string"', self.main_js)

    def test_main_js_handles_window_lifecycle(self) -> None:
        # macOS 重新激活时若没有窗口要新建
        self.assertIn('app.on("activate"', self.main_js)
        # 非 macOS 平台窗口全关闭时退出
        self.assertIn('app.on("window-all-closed"', self.main_js)
        self.assertIn('process.platform !== "darwin"', self.main_js)

    def test_preload_js_uses_context_bridge(self) -> None:
        # 必须通过 contextBridge.exposeInMainWorld 暴露桥接，不能用 window.MikuDesktopBridge = 赋值
        self.assertIn('contextBridge.exposeInMainWorld("MikuDesktopBridge"', self.preload_js)
        self.assertNotIn("window.MikuDesktopBridge =", self.preload_js)
        # runtime 必须标注为 electron
        self.assertIn('runtime: "electron"', self.preload_js)
        # 必须暴露原生文件对话框能力
        self.assertIn("openFileDialog", self.preload_js)
        self.assertIn("saveFileDialog", self.preload_js)
        # 必须暴露本地文件读写
        self.assertIn("readFileAsArrayBuffer", self.preload_js)
        self.assertIn("readFileAsText", self.preload_js)
        self.assertIn("writeTextFile", self.preload_js)

    def test_preload_js_capabilities_match_design(self) -> None:
        # P1.3 步骤 4 接入后：原生文件对话框=是；Python 分析进程=是；
        # analyzeAudio=是（PyInstaller 打包的 librosa 后端已通过 IPC 接入）。
        self.assertIn("nativeFileDialog: true", self.preload_js)
        self.assertIn("launchAnalysisProcess: true", self.preload_js)
        self.assertIn("analyzeAudio: true", self.preload_js)

    def test_preload_js_capabilities_launch_analysis_process_true(self) -> None:
        # P1.3 步骤 4：launchAnalysisProcess 从 false 翻 true
        self.assertIn("launchAnalysisProcess: true", self.preload_js)
        self.assertNotIn("launchAnalysisProcess: false", self.preload_js)

    def test_preload_js_capabilities_analyze_audio_true(self) -> None:
        # capabilities.analyzeAudio 必须为 true，且 bridge 必须暴露 analyzeAudio 方法
        self.assertIn("analyzeAudio: true", self.preload_js)
        self.assertIn("async analyzeAudio(inputPath, outputPath)", self.preload_js)
        self.assertIn('ipcRenderer.invoke("miku:analyzeAudio"', self.preload_js)

    def test_main_js_registers_analyze_audio_ipc_handler(self) -> None:
        # 主进程必须注册 miku:analyzeAudio 白名单 IPC handler
        self.assertIn('ipcMain.handle("miku:analyzeAudio"', self.main_js)
        # 流式别名 miku:analyzeAudioStream 也必须注册（约束第 2 条）
        self.assertIn('ipcMain.handle("miku:analyzeAudioStream"', self.main_js)
        # 必须用 child_process.spawn 启动分析进程（不能用 exec/eval）
        self.assertIn("spawn", self.main_js)
        # 必须用 crypto.randomUUID 生成请求 id（不能用 Math.random）
        self.assertIn("randomUUID", self.main_js)

    def test_main_js_validates_input_file_extension(self) -> None:
        # 主进程必须校验 inputPath 扩展名（.wav/.mp3/.flac/.ogg）
        # 约束第 3 条：路径校验扩展名 .wav/.mp3/.flac
        self.assertIn('".wav"', self.main_js)
        self.assertIn('".mp3"', self.main_js)
        self.assertIn('".flac"', self.main_js)
        # 必须有 allowedExt / ANALYSIS_ALLOWED_EXTENSIONS 常量
        self.assertTrue(
            "ANALYSIS_ALLOWED_EXTENSIONS" in self.main_js or "allowedExt" in self.main_js,
            "main.js must define an allowed extensions list for analysis input",
        )
        # 必须用 path.extname 提取扩展名做校验
        self.assertIn("path.extname(inputPath)", self.main_js)
        # 必须校验 inputPath / outputPath 类型为 string
        self.assertIn('typeof inputPath !== "string"', self.main_js)

    def test_main_js_has_analysis_process_timeout(self) -> None:
        # 约束第 5 条：分析进程单次运行超时 5 分钟自动 kill
        # 5 * 60 * 1000 ms = 300000 ms
        self.assertIn("ANALYSIS_TIMEOUT_MS", self.main_js)
        # 5 分钟可以是 5 * 60 * 1000 或 "5 minutes" 文案
        self.assertTrue(
            "5 * 60 * 1000" in self.main_js or "300000" in self.main_js,
            "main.js must configure a 5-minute analysis timeout",
        )
        self.assertIn('"Analysis timed out after 5 minutes"', self.main_js)
        # 超时后必须 kill 进程
        self.assertIn('.kill("SIGTERM")', self.main_js)

    def test_main_js_isolates_analysis_process_crash(self) -> None:
        # 约束第 4 条：分析进程崩溃不能影响 Electron 主进程
        # 必须监听 exit 事件并拒绝所有 pending 请求
        self.assertIn('"exit"', self.main_js)
        self.assertIn("analysisRequestQueue", self.main_js)
        # 必须监听 error 事件（spawn 失败）
        self.assertIn('"error"', self.main_js)
        # 必须在崩溃时 clear 请求队列
        self.assertIn("analysisRequestQueue.clear()", self.main_js)

    def test_launcher_py_handles_ping(self) -> None:
        # launcher.py 必须实现 ping method（健康检查）
        self.assertIn('"ping"', self.launcher_py)
        self.assertIn('"pong"', self.launcher_py)

    def test_launcher_py_handles_shutdown(self) -> None:
        # launcher.py 必须实现 shutdown method（优雅退出）
        self.assertIn('"shutdown"', self.launcher_py)
        self.assertIn('"shutting_down"', self.launcher_py)

    def test_launcher_py_outputs_ready_signal(self) -> None:
        # launcher.py 启动时必须输出 ready 信号，让 Electron 主进程知道可接收请求
        self.assertIn('"ready"', self.launcher_py)
        self.assertIn('"system"', self.launcher_py)
        # 必须有 LAUNCHER_VERSION 常量
        self.assertIn("LAUNCHER_VERSION", self.launcher_py)

    def test_launcher_py_implements_json_rpc_protocol(self) -> None:
        # 必须实现 analyze method 调用 librosa_backend.analyze_audio
        self.assertIn('"analyze"', self.launcher_py)
        self.assertIn("analyze_audio", self.launcher_py)
        # 必须处理 INVALID_JSON / INVALID_PARAMS / ANALYSIS_FAILED / UNKNOWN_METHOD 错误码
        for code in ("INVALID_JSON", "INVALID_PARAMS", "ANALYSIS_FAILED", "UNKNOWN_METHOD"):
            self.assertIn(code, self.launcher_py)
        # 必须用 stdin 循环读取请求行
        self.assertIn("sys.stdin", self.launcher_py)
        # 必须用 stdout 写响应
        self.assertIn("sys.stdout", self.launcher_py)

    def test_pyinstaller_spec_entry_and_hidden_imports(self) -> None:
        # spec 入口必须是 launcher.py（通过 LAUNCHER_PATH 变量构造绝对路径，
        # 避免 PyInstaller 把 spec 内相对路径叠加到 spec 文件所在目录）
        self.assertIn("LAUNCHER_PATH", self.pyinstaller_spec)
        self.assertIn("SPECPATH", self.pyinstaller_spec)
        self.assertIn("launcher.py", self.pyinstaller_spec)
        # exe 名必须是 miku-analysis-server
        self.assertIn("miku-analysis-server", self.pyinstaller_spec)
        # 必须把 librosa_backend 显式列为 hiddenimport（命名空间包兜底）
        self.assertIn("tools.miku_analysis.librosa_backend", self.pyinstaller_spec)
        # 必须收集 numba / librosa / scipy / sklearn 子模块（动态导入兜底）
        self.assertIn("collect_submodules", self.pyinstaller_spec)
        for pkg in ("librosa", "numba", "scipy", "sklearn"):
            self.assertIn(f"'{pkg}'", self.pyinstaller_spec)
        # 必须是 console 模式（stdin/stdout 通信需要 console）
        self.assertIn("console=True", self.pyinstaller_spec)

    def test_pyinstaller_spec_excludes_unnecessary_heavy_deps(self) -> None:
        # v0.6.1：spec 必须排除分析后端不需要的重型依赖，把体积从 ~780 MB 降到 ~288 MB
        # torch / torchvision / onnxruntime 是 librosa 可选依赖（推理后端），分析后端不使用
        for excluded in ("torch", "torchvision", "onnxruntime", "matplotlib", "PIL", "pandas"):
            self.assertIn(f"'{excluded}'", self.pyinstaller_spec)
        # msgpack 不能排除（numba 运行时需要做缓存序列化）
        self.assertNotIn("'msgpack'", self.pyinstaller_spec)

    def test_launcher_py_enforces_utf8_streams(self) -> None:
        # v0.6.1：PyInstaller 打包后 Windows 默认 cp936 会让中文路径乱码，
        # launcher.py 必须在启动时把 stdin/stdout/stderr 重新配置为 UTF-8。
        self.assertIn("reconfigure(encoding=\"utf-8\"", self.launcher_py)
        self.assertIn("surrogateescape", self.launcher_py)
        # 必须覆盖三个流
        for stream in ("sys.stdin", "sys.stdout", "sys.stderr"):
            self.assertIn(stream, self.launcher_py)

    def test_preload_js_does_not_expose_arbitrary_ipc(self) -> None:
        # 渲染器只能调用白名单方法，不能直接 require 或访问 ipcRenderer
        # preload.js 内部可以用 require('electron')，但不能把 require 或 ipcRenderer 直接暴露
        # 检查 bridge 对象内不允许出现 ipcRenderer.on/send 的直通方法
        self.assertIn("Object.freeze({", self.preload_js)
        # 不应出现把 ipcRenderer 直接挂到 bridge 上的写法
        self.assertNotIn("ipcRenderer: ipcRenderer", self.preload_js)
        self.assertNotIn("require: require", self.preload_js)

    def test_desktop_bridge_js_has_electron_guard(self) -> None:
        # 浏览器版桥接必须先检测 Electron preload 是否已设置 MikuDesktopBridge
        # 否则 contextBridge 暴露的只读属性会被 strict mode 赋值报错
        self.assertIn(
            'typeof globalThis.MikuDesktopBridge !== "undefined"',
            self.desktop_bridge_js,
        )
        # 守卫必须出现在赋值之前
        guard_pos = self.desktop_bridge_js.index(
            'typeof globalThis.MikuDesktopBridge !== "undefined"'
        )
        assign_pos = self.desktop_bridge_js.index("globalThis.MikuDesktopBridge = Object.freeze(")
        self.assertLess(guard_pos, assign_pos)

    def test_desktop_bridge_js_browser_runtime_fallback(self) -> None:
        # 浏览器模式下 runtime 必须是 browser-prototype
        self.assertIn('runtime: "browser-prototype"', self.desktop_bridge_js)
        # 浏览器模式下不能承诺原生文件对话框
        self.assertIn("nativeFileDialog: false", self.desktop_bridge_js)

    def test_gitignore_excludes_node_modules_and_dist(self) -> None:
        self.assertIn("node_modules/", self.gitignore)
        self.assertIn("dist/", self.gitignore)

    def test_readme_documents_dev_and_dist_commands(self) -> None:
        self.assertIn("npm install", self.readme)
        self.assertIn("npm start", self.readme)
        self.assertIn("npm run dist:win", self.readme)
        # README 必须说明与 web-workbench 的关系
        self.assertIn("contextBridge", self.readme)
        self.assertIn("MikuDesktopBridge", self.readme)


if __name__ == "__main__":
    unittest.main()
