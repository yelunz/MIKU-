# 轮 003 · PyInstaller 内置分析服务 + v0.6.1 NSIS 安装包

**日期**：2026-07-21
**阶段**：P5 可用性与发布 / P1.3 步骤 4 完成
**目标**：把 librosa 分析后端用 PyInstaller 打包成独立 exe，随 Electron 安装包分发，让用户无需 Python 环境也能用 librosa 分析新音频。

## 执行内容

### 1. 修复 pyinstaller.spec 路径解析问题

原 spec 文件用相对路径 `tools/miku_analysis/launcher.py` 作为 Analysis 入口，但 PyInstaller 6.x 把 spec 内的相对路径解析为相对于 spec 文件所在目录，导致路径叠加成 `tools/miku_analysis/tools/miku_analysis/launcher.py`（not found 错误）。

修复：用 PyInstaller 注入的 `SPECPATH` 变量构造绝对路径：

```python
SPEC_DIR = SPECPATH if 'SPECPATH' in dir() else os.path.dirname(os.path.abspath(__file__))
LAUNCHER_PATH = os.path.join(SPEC_DIR, 'launcher.py')
```

### 2. 修复 launcher.py 中文路径乱码

PyInstaller 打包后的 exe 在 Windows 上默认用 cp936（GBK）解码 stdin，导致 JSON-RPC 请求中的中文路径乱码（"歌姬放计划" 变成 "歌姬放\udcae\udc86划"），librosa 无法打开 WAV 文件。

修复：在 launcher.py 启动时强制把 stdin/stdout/stderr 重新配置为 UTF-8：

```python
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="surrogateescape")
    except (AttributeError, ValueError):
        pass
```

### 3. 优化 PyInstaller spec 排除重型依赖

第一版打包体积 778 MB（含 torch / torchvision / onnxruntime / matplotlib / pandas 等 librosa 可选依赖）。更新 spec 添加 `excludes` 列表排除 27 个不必要的包：

- `torch` / `torchvision`：librosa 0.11.0 可选依赖，分析后端不使用
- `onnxruntime`：basic-pitch 等推理后端依赖，P1.3 步骤 2 未完成
- `matplotlib` / `PIL` / `kiwisolver`：librosa plotting 子模块依赖，分析后端不画图
- `IPython` / `jedi` / `parso` / `prompt_toolkit` / `pyreadline3`：交互式 shell 依赖
- `pandas`：librosa 可选依赖，分析后端用 numpy
- `cryptography` / `sqlalchemy` / `google`：网络/数据库依赖
- `lxml` / `yaml` / `setuptools` / `tqdm` / `wcwidth` / `chardet` / `charset_normalizer` / `certifi` / `urllib3` / `requests` / `dateutil` / `pytz` / `contourpy`：其他可选依赖

**注意**：`msgpack` / `greenlet` 不能排除——numba 运行时需要 msgpack 做缓存序列化（第一版排除后 analyze 报 `No module named 'msgpack'`）。

优化后体积从 778 MB 降到 288 MB（-63%）。

### 4. 新增 test_pyinstaller_bundle.py 集成测试

`tools/miku_analysis/test_pyinstaller_bundle.py` 完整验证打包后的 exe 功能：
- 启动 exe 等待 ready 信号
- 发送 ping 请求验证 JSON-RPC 协议
- 发送 analyze 请求（路径含中文"歌姬放计划"）分析 50 秒 WAV 夹具
- 验证输出 JSON 的关键字段：analyzer.name = miku-librosa-backend / tempo 120.007 BPM / key C major / chord windows 49 / section boundaries 3
- 发送 shutdown 请求优雅退出

**验证结果**：
- 启动 < 5s
- 分析 50 秒音频 6.5s（numba JIT 缓存生效后；首次冷启动 34.9s）
- 中文路径正确处理
- 所有关键指标与 librosa_backend 直接运行结果一致

### 5. 新增 2 项静态测试防回归

`tests/test_desktop_shell_static.py` 新增：
- `test_pyinstaller_spec_excludes_unnecessary_heavy_deps`：验证 spec 排除 torch/onnxruntime/matplotlib 等重型依赖，且不排除 msgpack
- `test_launcher_py_enforces_utf8_streams`：验证 launcher.py 启动时强制 UTF-8 + surrogateescape 配置三个流

更新既有测试：
- `test_pyinstaller_spec_entry_and_hidden_imports`：从断言 `tools/miku_analysis/launcher.py` 字面量改为断言 `LAUNCHER_PATH` + `SPECPATH` 变量
- `test_package_json_declares_electron_and_electron_builder`：版本断言 0.6.0 → 0.6.1
- `test_package_json_build_carries_fixtures_as_extra_files`：extraFiles 从 3 组扩展到 4 组（新增第 0 组 miku-analysis-server 目录）

### 6. 更新 package.json v0.6.1 配置

`prototype/desktop-shell/package.json`：
- 版本 `0.6.0` → `0.6.1`
- description 同步更新（"+ PyInstaller 内置分析服务"）
- `directories.output` 从 `dist-v0.6.0` 改为 `dist-v0.6.1`
- `extraFiles` 新增第 0 组：`from: "../../dist/miku-analysis-server"` → `to: "miku-analysis-server"`，filter `["**/*"]` 复制整个 PyInstaller 产物目录（含 exe + _internal 依赖 + numba 缓存）

### 7. 更新 .gitignore

新增 `dist-v0.6.1/` 行（与 `dist/` / `dist-v0.6.0/` 并列）。

### 8. 打包 v0.6.1 NSIS 安装包

```powershell
cd prototype\desktop-shell
npm.cmd run lint        # 通过
npm.cmd run dist:win    # 成功
```

**安装包产物**：
- 路径：`prototype/desktop-shell/dist-v0.6.1/Miku-Workbench-0.6.1-win-x64.exe`
- 大小：**190.62 MB**（v0.6.0 是 101.14 MB，新增 89.48 MB 是 PyInstaller 分析服务压缩后体积）
- 架构：x64
- 目标：Windows 10/11
- 签名：未签名

**win-unpacked 结构**：
- 顶层：Miku-Workbench.exe + Electron 运行时（chromium 二进制 + locales）
- `resources/`：app.asar（含 main.js / preload.js / web-workbench 全部 7 个文件）
- `miku-analysis-server/`：PyInstaller 打包的分析服务（miku-analysis-server.exe 22.34 MB + _internal/ 依赖目录，共 768 文件 288 MB）
- `fixtures/`：3 组夹具（生成夹具 / 基础夹具目录 / 集成夹具目录，共 11 文件）

### 9. 完整测试回归

`python -m unittest discover -s tests` 全部通过：**136 项测试 OK**（5.090s）。

新增 2 项 PyInstaller 测试 + 既有 134 项 = 136 项。

## 修改文件清单

| 文件 | 修改类型 | 说明 |
|---|---|---|
| `tools/miku_analysis/pyinstaller.spec` | 修改 | SPECPATH 绝对路径 + excludes 列表排除 27 个重型依赖 |
| `tools/miku_analysis/launcher.py` | 修改 | 启动时强制 stdin/stdout/stderr UTF-8 + surrogateescape |
| `tools/miku_analysis/test_pyinstaller_bundle.py` | 新建 | PyInstaller 打包产物集成测试（ready/ping/analyze/shutdown + 中文路径） |
| `prototype/desktop-shell/package.json` | 修改 | 版本 0.6.1 + dist-v0.6.1 + extraFiles 新增 miku-analysis-server 目录 |
| `.gitignore` | 修改 | 新增 `dist-v0.6.1/` |
| `tests/test_desktop_shell_static.py` | 修改 | 版本 0.6.1 + extraFiles 4 组 + 2 项新 PyInstaller 测试 + spec 路径变量断言 |

## 验证结果

| 验证项 | 结果 |
|---|---|
| `python -m PyInstaller tools/miku_analysis/pyinstaller.spec` | ✓ 成功（288 MB / 767 文件） |
| `python tools/miku_analysis/test_pyinstaller_bundle.py` | ✓ PASS（ready + ping + analyze 6.5s + shutdown） |
| 中文路径 analyze（"歌姬放计划"）| ✓ 正确处理，120.007 BPM / C major |
| `npm run lint` | ✓ 通过 |
| `npm run dist:win` | ✓ 成功 |
| 安装包 `Miku-Workbench-0.6.1-win-x64.exe` | ✓ 190.62 MB |
| `python -m unittest discover -s tests` | ✓ 136 项全部通过 |

## 决定

1. **--onedir 模式**：保持 spec 的 `--onedir` 模式（COLLECT 步骤），启动快、便于增量更新 numba 缓存；不用 `--onefile`（单文件启动慢 5-10s，每次启动都要解压到临时目录）。
2. **不签名**：保持 `signAndEditExecutable: false`，首版用户测试阶段接受 SmartScreen 警告。
3. **msgpack 保留**：numba 运行时需要 msgpack 做缓存序列化，不能排除；greenlet 同理（msgpack 间接依赖）。
4. **UTF-8 强制配置**：launcher.py 启动时必须 reconfigure 三个流为 UTF-8，否则 Windows 默认 cp936 会让中文路径乱码。这是 PyInstaller 打包模式特有的问题（开发模式 `python -m` 时 stdin 默认 UTF-8）。
5. **v0.6.1 是首版完整功能软件**：v0.6.0 还需要用户机器有 Python 3.10+ 和 librosa 0.11.0 才能用分析新音频功能；v0.6.1 把分析服务内置到安装包，用户无需任何 Python 环境即可使用全部功能。

## 未决问题

1. **真实 Electron 回归测试**：本轮只验证了 PyInstaller exe 独立运行，未在真实 Electron 43.x 中跑通"点击分析按钮 → spawn miku-analysis-server.exe → 收到响应 → 渲染分析结果"完整链路。用户测试时请重点验证此流程。
2. **首次启动延迟**：numba JIT 首次编译需要 30-35s（之后 6-7s），用户首次点击"用 librosa 分析"可能感觉卡顿。考虑在应用启动时预热分析进程（后台 ping）。
3. **macOS / Linux 打包**：本轮只生成 Windows x64，macOS Apple Silicon 与 Ubuntu 22.04 x64 的 PyInstaller + electron-builder 跨平台打包留待后续。
4. **安装包体积优化**：190 MB 偏大（主要是 numba + scipy + sklearn 占 250 MB 未压缩）。可考虑：(a) UPX 压缩（spec 已配置但本机无 UPX）；(b) 用 onnxruntime 替换 numba（librosa 0.11+ 支持）；(c) 把分析服务做成独立下载包（按需安装）。
5. **PyInstaller 产物不提交仓库**：`dist/miku-analysis-server/` 在 .gitignore 的 `dist/` 规则下被忽略，构建时需要先跑 `python -m PyInstaller tools/miku_analysis/pyinstaller.spec` 生成产物，再跑 `npm run dist:win`。未来可考虑用 CI 自动化此流程。
6. **basic-pitch spike**：P1.3 步骤 2 单乐器转录后端 spike 环境阻塞，跳过。
7. **Demucs 许可评估**：P1.3 步骤 3 音源分离后端许可评估 pending。

## Git 状态

- 分支：`main`
- 最新 commit：（本轮待提交）
- 远端：`https://github.com/yelunz/MIKU-.git`
- 工作区：有未提交变更（本轮所有修改）
