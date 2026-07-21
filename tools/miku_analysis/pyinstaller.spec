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

import os
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# SPECPATH 是 PyInstaller 注入的变量，指向 spec 文件所在目录。
# 用它构造绝对路径，避免 PyInstaller 把 spec 内的相对路径当成相对 spec
# 文件所在目录解析（这会导致 tools/miku_analysis/launcher.py 被叠加成
# tools/miku_analysis/tools/miku_analysis/launcher.py）。
SPEC_DIR = SPECPATH if 'SPECPATH' in dir() else os.path.dirname(os.path.abspath(__file__))
LAUNCHER_PATH = os.path.join(SPEC_DIR, 'launcher.py')

# numba / librosa / scipy / sklearn 都有大量动态导入的子模块，PyInstaller
# 静态分析无法完整发现，必须用 collect_submodules 显式收集。
hiddenimports = []
hiddenimports += collect_submodules('librosa')
hiddenimports += collect_submodules('numba')
hiddenimports += collect_submodules('scipy')
hiddenimports += collect_submodules('sklearn')
# 显式声明 tools.miku_analysis.librosa_backend（命名空间包兜底）。
# P6: stem_separator；P7: transcriber 都需要显式声明。
hiddenimports += [
    'tools.miku_analysis',
    'tools.miku_analysis.librosa_backend',
    'tools.miku_analysis.stem_separator',
    'tools.miku_analysis.transcriber',
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

# 排除分析后端不需要的重型依赖：
#   * torch / torchvision：librosa 0.11.0 可选依赖，分析后端不使用
#   * onnxruntime：basic-pitch 等推理后端依赖，P1.3 步骤 2 未完成
#   * matplotlib / PIL / kiwisolver：librosa 的 plotting 子模块依赖，分析后端不画图
#   * IPython / jedi / parso / prompt_toolkit / pyreadline3：交互式 shell 依赖
#   * pandas：librosa 可选依赖，分析后端用 numpy 而非 pandas
#   * cryptography / sqlalchemy / google：网络/数据库依赖
#   * lxml / yaml / setuptools / tqdm / wcwidth：其他可选依赖
# 注意：msgpack / greenlet 不能排除，numba 运行时需要 msgpack 做缓存序列化。
# 这些排除能把打包体积从 ~780 MB 降到 ~300 MB 以下。
excludes = [
    'torch',
    'torchvision',
    'onnxruntime',
    'matplotlib',
    'PIL',
    'kiwisolver',
    'IPython',
    'jedi',
    'parso',
    'prompt_toolkit',
    'pyreadline3',
    'pandas',
    'cryptography',
    'sqlalchemy',
    'google',
    'lxml',
    'yaml',
    'setuptools',
    'tqdm',
    'wcwidth',
    'chardet',
    'charset_normalizer',
    'certifi',
    'urllib3',
    'requests',
    'dateutil',
    'pytz',
    'contourpy',
]

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
    [LAUNCHER_PATH],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
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
