# Web 音频工作台技术原型

这是 P1 阶段的零依赖可运行原型。它把 `tools/analyze_audio.py` 的真实 JSON 接入时间轴，验证本地 WAV 播放、分析图层、选区、中文/日文歌词区域、和弦纠正及项目保存。它不是最终桌面安装包，也不生成演唱音符。

## 准备测试数据

在仓库根目录运行：

```powershell
python fixtures/basic-c-major-120-v1/generate.py
python tools/analyze_audio.py fixtures/.generated/basic-c-major-120-v1.wav -o fixtures/.generated/basic-c-major-120-v1.analysis.json
```

如果系统 Python 不可用，应使用 Codex 工作区依赖返回的 Python 可执行文件。

## 启动

可以直接用浏览器打开 `prototype/web-workbench/index.html`。为避免浏览器对本地文件页面的额外限制，也可以在仓库根目录运行：

```powershell
python -m http.server 4173 --directory prototype/web-workbench
```

然后打开 `http://127.0.0.1:4173/`。

页面中依次选择：

1. `fixtures/.generated/basic-c-major-120-v1.analysis.json`
2. `fixtures/.generated/basic-c-major-120-v1.wav`

所有文件只由当前浏览器页面在本机读取；原型不包含上传代码。

## 已实现

- 校验并读取分析 schema `0.1.0`，坏 JSON 或版本不匹配不会覆盖已加载状态。
- 绘制真实波形、能量、节拍、段落和和弦候选，图层可独立开关。
- 本地 WAV 播放、暂停、停止、跳转播放头和音频/分析时长差异提示。
- 在波形拖拽或输入精确秒数建立选区。
- 保存、编辑和删除中文/日文歌词区域；不提供英文选项。
- 修改和恢复和弦候选；用户修正保存在独立覆盖层，不改写源分析 JSON。
- 导出/导入原型项目 JSON；恢复分析、歌词、选区和和弦修正。
- 项目不嵌入音频或绝对路径，重新打开后必须由用户重新关联本地 WAV。
- 替换音频或关闭页面时释放旧的对象 URL。

## 当前边界

- 这是浏览器技术原型，还没有 Electron/Tauri 桥接、原生文件对话框或安装包。
- 项目文件尚未包含撤销历史、锁定状态、读音、音素或演唱草稿。
- 浏览器不能在重新打开项目后静默访问原音频，必须重新选择文件。
- 分析 CLI 当前只接受未压缩整数 PCM WAV；和弦与段落准确率仍未通过完整验收。
- 三平台浏览器和高 DPI/输入法测试尚未完成。
