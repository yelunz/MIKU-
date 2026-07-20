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
- 空格播放/暂停；框选默认吸附到 1/2 拍，也可切换为 1 拍、1/4 拍或关闭，按住 Alt/Option 可临时绕过吸附。
- 选区左右边缘提供可拖动、可用方向键微调的手柄；按 Esc 可取消正在进行的框选或边缘调整。
- 保存、编辑和删除中文/日文歌词区域；不提供英文选项。
- 内部时间模型：sample + PPQ 960 + 共享 Anchor。音频 sample 是权威基准，tick 由 sample 派生；连续歌词区域在数据层共享 anchor，从根上消除漏缝。
- 共享边手柄：相邻歌词/休止之间的边界可整体拖动，移动一次同时改变两侧 region；吸附、Alt 绕过、Esc 取消、方向键微调都支持。
- 显式休止：在未分配空段上点击 → 检查器提供“转为显式休止”按钮；显式休止可单独编辑、删除，删除后恢复为未分配空段。未分配与显式休止在视觉上分开。
- “连续歌词区”默认复用相邻 anchor（数据层共享）；关闭后允许独立边界与显式留白。
- 修改和恢复和弦候选；用户修正保存在独立覆盖层，不改写源分析 JSON。
- 导出/导入项目 schema `0.2.0`，包含 tempo_map、anchors、lyrics（anchor_id 引用）、rests、chord_overrides 与偏好；导入时校验 anchor 唯一、引用有效、region 不重叠。
- 兼容导入旧版 `0.1.0` 项目：按秒数边界迁移到 0.2.0 共享 anchor 模型，相邻歌词自动复用同一 anchor；导入后状态栏会明确提示已迁移。
- 项目不嵌入音频或绝对路径，重新打开后必须由用户重新关联本地 WAV。
- 替换音频或关闭页面时释放旧的对象 URL。

## 当前边界

- 这是浏览器技术原型，还没有 Electron/Tauri 桥接、原生文件对话框或安装包。
- 项目文件尚未包含撤销历史、锁定状态、读音、音素或演唱草稿。
- 歌词块整体拖动、缩放锚点、自动滚动和字段级锁定尚未实现（共享边手柄已覆盖最关键的边界共享诉求）。
- 当前还没有可编辑音符轨、钢琴卷帘、反拍/三连音网格或伴奏 stem；这些已进入下一阶段的多轨编曲重构。
- 浏览器不能在重新打开项目后静默访问原音频，必须重新选择文件。
- 分析 CLI 当前只接受未压缩整数 PCM WAV；和弦与段落准确率仍未通过完整验收。
- 三平台浏览器和高 DPI/输入法测试尚未完成；本轮新交互（共享边拖动、显式休止创建/删除、0.2.0 项目往返、0.1.0 项目迁移）尚未经过真实浏览器回归。
