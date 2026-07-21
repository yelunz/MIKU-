"""测试 PyInstaller 打包后的 miku-analysis-server.exe 是否能正确处理中文路径。

用法（在仓库根目录执行）::

    python tools/miku_analysis/test_pyinstaller_bundle.py

前提：已运行 ``python -m PyInstaller tools/miku_analysis/pyinstaller.spec --noconfirm``
生成 ``dist/miku-analysis-server/miku-analysis-server.exe``。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    exe = repo_root / "dist" / "miku-analysis-server" / "miku-analysis-server.exe"
    if not exe.exists():
        print(f"[FAIL] EXE not found: {exe}")
        return 1

    wav = repo_root / "fixtures" / ".generated" / "basic-c-major-120-v1.wav"
    if not wav.exists():
        print(f"[FAIL] WAV fixture not found: {wav}")
        return 1

    out_path = Path(os.environ.get("TEMP", "/tmp")) / "miku-pyinstaller-test.json"
    if out_path.exists():
        out_path.unlink()

    print(f"[INFO] Launching: {exe}")
    proc = subprocess.Popen(
        [str(exe)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        text=True,
        encoding="utf-8",
        errors="surrogateescape",
        bufsize=1,
    )

    try:
        # 等待 ready 信号
        ready_line = proc.stdout.readline()
        print(f"[READY] {ready_line.strip()}")
        ready = json.loads(ready_line)
        assert ready["result"]["status"] == "ready", f"unexpected ready: {ready}"

        # ping
        ping_req = '{"id":"ping-1","method":"ping","params":{}}\n'
        proc.stdin.write(ping_req)
        proc.stdin.flush()
        ping_resp = proc.stdout.readline()
        print(f"[PING] {ping_resp.strip()}")
        ping = json.loads(ping_resp)
        assert ping["result"]["status"] == "pong", f"unexpected ping: {ping}"

        # analyze（中文路径）
        analyze_req = json.dumps({
            "id": "analyze-1",
            "method": "analyze",
            "params": {
                "input_path": str(wav),
                "output_path": str(out_path),
            },
        }, ensure_ascii=False) + "\n"
        print(f"[ANALYZE] Sending analyze request (path has 中文: {wav})")
        proc.stdin.write(analyze_req)
        proc.stdin.flush()

        # 等待响应（最多 5 分钟）
        start = time.time()
        analyze_resp = proc.stdout.readline()
        elapsed = time.time() - start
        print(f"[ANALYZE] Response ({elapsed:.1f}s): {analyze_resp.strip()[:200]}")
        result = json.loads(analyze_resp)
        if "error" in result:
            print(f"[FAIL] analyze returned error: {result['error']['message']}")
            return 2
        assert result["result"]["status"] == "ok", f"unexpected analyze: {result}"

        # shutdown
        shutdown_req = '{"id":"shutdown-1","method":"shutdown","params":{}}\n'
        proc.stdin.write(shutdown_req)
        proc.stdin.flush()
        proc.wait(timeout=10)

        # 验证输出文件
        if not out_path.exists():
            print(f"[FAIL] output file not created: {out_path}")
            return 3
        parsed = json.loads(out_path.read_text(encoding="utf-8"))
        analysis = parsed["analysis"]
        print(f"[OUTPUT] analyzer.name: {parsed['analyzer']['name']}")
        print(f"[OUTPUT] tempo[0].bpm: {analysis['tempo']['candidates'][0]['bpm']}")
        print(f"[OUTPUT] key[0].label: {analysis['key']['candidates'][0]['label']}")
        print(f"[OUTPUT] chord windows: {len(analysis['chords']['windows'])}")
        print(f"[OUTPUT] section boundaries: {len(analysis['sections']['boundaries'])}")

        # 与 librosa_backend 直接运行的结果对比关键指标
        assert parsed["analyzer"]["name"] == "miku-librosa-backend"
        assert 119.0 < analysis["tempo"]["candidates"][0]["bpm"] < 121.0
        assert analysis["key"]["candidates"][0]["label"] == "C major"
        print("[PASS] All assertions passed. PyInstaller bundle works with Chinese paths.")
        return 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
