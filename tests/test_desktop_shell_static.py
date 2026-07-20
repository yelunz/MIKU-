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

    def test_package_json_declares_electron_and_electron_builder(self) -> None:
        self.assertEqual(self.package_json["name"], "miku-workbench")
        self.assertEqual(self.package_json["main"], "main.js")
        self.assertEqual(self.package_json["private"], True)
        # 版本号与项目 0.3.0 schema 一致；USTX 0.7 YAML 重写后桌面壳升到 0.5.0
        self.assertEqual(self.package_json["version"], "0.5.0")
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

    def test_package_json_build_win_target_is_nsis_x64(self) -> None:
        win = self.package_json["build"]["win"]
        self.assertEqual(win["target"][0]["target"], "nsis")
        self.assertIn("x64", win["target"][0]["arch"])

    def test_package_json_build_carries_fixtures_as_extra_files(self) -> None:
        # 打包后用户首次启动需要夹具，否则页面无法选择分析 JSON
        extra_files = self.package_json["build"]["extraFiles"]
        self.assertEqual(len(extra_files), 1)
        self.assertEqual(extra_files[0]["to"], "fixtures")
        filters = extra_files[0]["filter"]
        self.assertIn("basic-c-major-120-v1.analysis.json", filters)
        self.assertIn("basic-c-major-120-v1.wav", filters)

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
        # DESKTOP_STACK_SPIKE.md 规定：原生文件对话框=是；Python 分析进程=否（P1.3 接入）
        self.assertIn("nativeFileDialog: true", self.preload_js)
        self.assertIn("launchAnalysisProcess: false", self.preload_js)

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
