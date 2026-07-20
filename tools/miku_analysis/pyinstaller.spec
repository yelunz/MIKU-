# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for miku-analysis-server（P1.3 步骤 4：方案 A 内置）.

打包命令（在仓库根目录执行）::

    pyinstaller tools/miku_analysis/pyinstaller.spec

输出（``--onedir`` 模式，启动快、便于增量更新 numba 缓存）::

    dist/miku-analysis-server/miku-analysis-server.exe   (Windows)
    dist/miku-analysis-server/miku-analysis-server       (macOS / Linux)

随后的 ``extraFiles`` 配置在 ``prototype/desktop-shell/package.json`` 中把
整个 ``dist/miku-analysis-server/`` 目录复制到 Electron 安装包的
``resources/miku-analysis-server/`` 下，由 ``main.js`` 通过 ``spawn`` 启动。

关键设计：

* 入口是 ``tools/miku_analysis/launcher.py``（JSON-RPC over stdin/stdout）。
* ``pathex=['.']`` 让 ``tools.miku_analysis.librosa_backend`` 在打包后仍可
  通过绝对导入找到；同时把 ``tools.miku_analysis.librosa_backend`` 显式
  列入 hiddenimports，避免命名空间包（``tools/`` 无 ``__init__.py``）在
  PyInstaller 下漏收。
* numba / librosa / scipy / sklearn 的子模块和数据文件用
  ``collect_submodules`` + ``collect_data_files`` 收集，覆盖 PyInstaller
  静态分析无法发现的动态导入（典型如 numba 的 ``@jit`` 装饰器延迟加载的
  typing 模块）。
* ``console=True``：服务进程需要 stdin/stdout 通信，不能用 windowed 模式。
* ``upx=True``：用 UPX 压缩二进制，减小安装包体积（约 -30%）。numba 的
  ``.bc`` 缓存文件已在 ``upx_exclude`` 中排除，避免 UPX 破坏字节码。

已知风险（详见 ``docs/ANALYSIS_BACKEND_RESEARCH.md`` 第 7 节）：

1. numba JIT 缓存在 ``--onedir`` 与 ``--onefile`` 模式下行为不同；本 spec
   用 ``--onedir``，首次启动时 numba 会在 ``dist/miku-analysis-server/``
   同级写 ``numba_cache`` 目录，需要该目录可写。
2. macOS 上 PyInstaller 产物需要单独签名与公证，否则 Gatekeeper 阻止启动。
3. soxr 是 LGPL，动态链接库需要随附源码或许可声明（不在本 spec 处理）。

本轮只创建 spec 文件，**不实际执行 PyInstaller**。打包验证留作下一轮。
"""

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# numba / librosa / scipy / sklearn 都有大量动态导入的子模块，PyInstaller
# 静态分析无法完整发现，必须用 collect_submodules 显式收集。
hiddenimports = []
hiddenimports += collect_submodules('librosa')
hiddenimports += collect_submodules('numba')
hiddenimports += collect_submodules('scipy')
hiddenimports += collect_submodules('sklearn')
# 显式声明 tools.miku_analysis.librosa_backend（命名空间包兜底）。
hiddenimports += [
    'tools.miku_analysis',
    'tools.miku_analysis.librosa_backend',
    'soundfile',
    'soxr',
    '_soundfile',  # soundfile 的 C 扩展名
]

# numba / librosa / sklearn 自带数据文件（numba 的 .bc 字节码、librosa 的
# example 数据、sklearn 的 datasets / model 数据）。collect_data_files
# 返回 (source, dest_dir) 二元组列表。
datas = []
datas += collect_data_files('librosa')
datas += collect_data_files('numba')
datas += collect_data_files('sklearn')

# UPX 压缩排除项：numba 的 .bc 字节码和 .nbi 缓存不能被 UPX 压缩，否则
# 运行时解码失败。PyInstaller 的 .pyz 也排除。
upx_exclude = [
    '*.bc',
    '*.nbi',
    '*.nbc',
    '*.pyz',
]


block_cipher = None


a = Analysis(
    ['tools/miku_analysis/launcher.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='miku-analysis-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=upx_exclude,
    name='miku-analysis-server',
)
