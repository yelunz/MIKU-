#!/usr/bin/env python3
"""分析服务进程入口（P1.3 步骤 4：方案 A PyInstaller 内置）。

通过 stdin/stdout 流式 JSON-RPC 与 Electron 主进程通信。
每行一个 JSON 请求，每行一个 JSON 响应。

启动时首先输出 ready 信号，然后循环读取 stdin 每一行作为 JSON 请求，
处理后将响应写为一行 JSON 到 stdout。遇到 ``shutdown`` 方法或 stdin EOF
时退出。

请求格式::

    {"id": "<uuid>", "method": "analyze",
     "params": {"input_path": "<wav>", "output_path": "<json>"}}

响应格式::

    {"id": "<uuid>", "result": {"status": "ok", "output_path": "<json>"}}

或::

    {"id": "<uuid>", "error": {"code": "ANALYSIS_FAILED", "message": "...",
                                "traceback": "..."}}

支持的方法：

* ``ping``    —— 健康检查，返回 ``{"status": "pong", "version": ...}``。
* ``analyze`` —— 调用 ``librosa_backend.analyze_audio(Path(input_path))``，
  把返回的 schema-0.1.0 dict 原子写入 ``output_path``。
* ``shutdown``—— 返回 ``{"status": "shutting_down"}`` 后退出主循环。

安全边界：本进程只接受 stdin 上的 JSON-RPC 请求；不读取环境变量，不联网，
不写除 ``output_path`` 以外的任何路径。``output_path`` 的父目录会被自动
创建。主进程（Electron）在调用前已校验扩展名（.wav/.mp3/.flac/.ogg）。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
from contextlib import contextmanager, redirect_stdout
from pathlib import Path

# Windows + PyInstaller 打包模式下，stdin/stdout/stderr 默认编码是 cp936（GBK），
# 会导致 JSON-RPC 请求/响应中的中文路径乱码（surrogateescape 后变成 \udcXX）。
# 强制重新配置为 UTF-8，保证 Electron 主进程（Node.js 默认 UTF-8）能正确往返。
# Python 3.7+ 支持 sys.stdin.reconfigure(encoding="utf-8")。
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="surrogateescape")
    except (AttributeError, ValueError):
        # 某些 PyInstaller 版本下 stream 不支持 reconfigure，忽略。
        pass

# 兼容两种运行模式：
#   1. 开发模式：``python -m tools.miku_analysis.launcher``（``tools`` 是
#      命名空间包，``tools.miku_analysis`` 是普通子包）。
#   2. PyInstaller 打包模式：``miku-analysis-server.exe``。打包时把
#      ``tools.miku_analysis.librosa_backend`` 列为 hiddenimport，但在
#      某些 PyInstaller 版本下命名空间包仍可能找不到，所以兜底直接从
#      ``librosa_backend`` 导入（spec 中 pathex=['.'] 让同目录可见）。
try:
    from tools.miku_analysis.librosa_backend import analyze_audio
except ImportError:  # pragma: no cover - PyInstaller bundle fallback
    from librosa_backend import analyze_audio  # type: ignore[no-redef]


LAUNCHER_VERSION = "0.1.0"
SCHEMA_VERSION = "0.1.0"


def _emit(payload: dict) -> None:
    """Write one JSON-RPC line to stdout and flush."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


@contextmanager
def _stdout_redirected_to_stderr():
    """Temporarily redirect stdout to stderr.

    librosa / numba / scipy 偶尔会往 stdout 打印 banner / 警告，这会破坏
    JSON-RPC 行协议。分析期间把 stdout 重定向到 stderr，确保 stdout 仅供
    JSON-RPC 使用。
    """
    with redirect_stdout(sys.stderr):
        yield


def _write_result_json(output_path: str, result: dict) -> None:
    """Atomically write the analysis dict to output_path as UTF-8 JSON.

    与 ``librosa_backend.main`` 的写入逻辑保持一致：先写临时文件再 rename，
    避免崩溃留下半截 JSON 让 web-workbench 误读。
    """
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    serialized = (
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", newline="\n", dir=target.parent,
            prefix=f".{target.name}.", suffix=".tmp", delete=False,
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(serialized)
            temporary.flush()
            os.fsync(temporary.fileno())
        Path(temporary_name).replace(target)
    except OSError:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)
        raise


def handle_request(request: dict) -> dict:
    """Dispatch a single JSON-RPC request and return its response dict."""
    req_id = request.get("id", "")
    method = request.get("method")
    params = request.get("params") or {}

    if method == "ping":
        return {
            "id": req_id,
            "result": {
                "status": "pong",
                "version": LAUNCHER_VERSION,
                "schema_version": SCHEMA_VERSION,
            },
        }

    if method == "shutdown":
        return {"id": req_id, "result": {"status": "shutting_down"}}

    if method == "analyze":
        input_path = params.get("input_path", "")
        output_path = params.get("output_path", "")
        if not isinstance(input_path, str) or not input_path:
            return {
                "id": req_id,
                "error": {
                    "code": "INVALID_PARAMS",
                    "message": "input_path (non-empty string) is required",
                },
            }
        if not isinstance(output_path, str) or not output_path:
            return {
                "id": req_id,
                "error": {
                    "code": "INVALID_PARAMS",
                    "message": "output_path (non-empty string) is required",
                },
            }
        try:
            with _stdout_redirected_to_stderr():
                result = analyze_audio(Path(input_path))
                _write_result_json(output_path, result)
        except Exception as exc:  # noqa: BLE001 - surface any failure to the host
            return {
                "id": req_id,
                "error": {
                    "code": "ANALYSIS_FAILED",
                    "message": str(exc) or exc.__class__.__name__,
                    "traceback": traceback.format_exc(),
                },
            }
        return {
            "id": req_id,
            "result": {
                "status": "ok",
                "output_path": output_path,
                "schema_version": SCHEMA_VERSION,
                "analyzer": result.get("analyzer", {}),
            },
        }

    return {
        "id": req_id,
        "error": {
            "code": "UNKNOWN_METHOD",
            "message": f"Unknown method: {method!r}",
        },
    }


def main() -> int:
    # 启动 ready 信号。Electron 主进程以此判断子进程已就绪可接收请求。
    _emit({
        "id": "system",
        "result": {
            "status": "ready",
            "version": LAUNCHER_VERSION,
            "schema_version": SCHEMA_VERSION,
        },
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({
                "id": "",
                "error": {
                    "code": "INVALID_JSON",
                    "message": str(exc),
                },
            })
            continue
        if not isinstance(request, dict):
            _emit({
                "id": "",
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": "request must be a JSON object",
                },
            })
            continue

        response = handle_request(request)
        _emit(response)

        if request.get("method") == "shutdown":
            return 0

    # stdin EOF without explicit shutdown。
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
