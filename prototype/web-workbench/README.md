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
- 歌词块整体拖动与边缘拉伸：点击歌词块进入编辑；按住拖动则整体移动；在左右 8 像素内按下则只拉伸起止边界。共享 anchor 在拖动前会被克隆，保持邻居不动。
- 显式休止：在未分配空段上点击 → 检查器提供“转为显式休止”按钮；显式休止可单独编辑、删除，删除后恢复为未分配空段。未分配与显式休止在视觉上分开。
- “连续歌词区”默认复用相邻 anchor（数据层共享）；关闭后允许独立边界与显式留白。
- 撤销/重做栈（EditGraph 第一版）：新建/删除歌词、新建/删除休止、修正/恢复和弦、共享边拖动/微调、歌词块拖动/拉伸、字段锁定都会记录撤销点。Ctrl+Z 撤销，Ctrl+Shift+Z 或 Ctrl+Y 重做；按钮在顶部工具栏。
- 缩放锚点：拖动缩放滑块时保持视口中心对应的时间点不动；Ctrl/Cmd + 滚轮在时间轴上缩放，以鼠标位置为锚点。
- 播放头自动滚动跟随：播放时若播放头进入视口右 18%，时间轴自动滚动跟随；用户主动滚动后 1.5 秒内暂停自动跟随，避免抢走用户的主动定位。
- 字段级锁定：歌词、休止、和弦修正可在检查器勾选"锁定"防止未来重生成覆盖；锁定状态随 EditGraph 快照、项目导出/导入一并持久化；锁定阻止删除与恢复原值，但允许用户主动编辑；时间轴块显示 🔒 标记。
- 多轨 stem 混音器（P1.2 轮 1）：默认 4 条 stem 轨（伴奏总览 / 鼓组 / 贝斯 / 其他乐器），每条可独立 mute / solo / gain / pan。伴奏总览通过 Web Audio API 真实生效（GainNode + StereoPannerNode），占位 stem 保存参数但不播放，等接入音源分离后端后才会实际发声。混音参数随 EditGraph 快照、项目导出/导入一并持久化；拖动结束才记 undo，避免每个像素一条历史。
- 钢琴卷帘与 NoteEvent 数据模型（P1.2 轮 2）：C2..C7 共 60 半音，14px 行高，含小节/拍线网格。在空白处拖出新音符；点击选中并编辑；拖动音符整体移动；拖动左右边缘拉伸起止；Shift + 点击第二个音符设为合并候选；按钮支持中点拆分、合并相邻同音高音符、删除选中音符。音符引用 start/end anchor，与歌词/休止共享同一 anchor 表，相邻边界对齐时自动复用 anchor；拖动前克隆共享 anchor 保持邻居不动。source 字段区分 manual / transcription / generation，对应不同颜色。Esc 取消当前拖动/创建，Delete 删除选中音符，Ctrl/Cmd + 滚轮缩放。音符与 nextNoteId 随 EditGraph 快照、项目导出/导入一并持久化；0.1.0 项目迁移时清空 notes。
- 量化网格 + 附点 + 三连音 + Swing（P1.2 轮 3）：snap 网格扩展到 1/8 拍（直十六分）、1/3 拍（半拍三连音）和 1/6 拍（四分拍三连音）；附点 checkbox 把网格拉长 1.5 倍（三连音网格上不叠加）；Swing 滑块 0..0.7 把偶数细分网格的后半段向后推，三连音和整拍网格上不生效；钢琴卷帘 canvas 按当前 snap 网格绘制垂直线（swing 偏移的奇数点用浅色）；"量化"按钮把选中音符一次性对齐到当前网格（先 detach 共享 anchor 保持邻居不动）；dotted_snap 与 swing_amount 随项目导出/导入一并持久化。
- 修改和恢复和弦候选；用户修正保存在独立覆盖层，不改写源分析 JSON。
- 导出/导入项目 schema `0.2.0`，包含 tempo_map、anchors、lyrics（anchor_id 引用）、rests、chord_overrides、locked_fields 与偏好；导入时校验 anchor 唯一、引用有效、region 不重叠，并丢弃指向已删除对象的锁定项。
- 兼容导入旧版 `0.1.0` 项目：按秒数边界迁移到 0.2.0 共享 anchor 模型，相邻歌词自动复用同一 anchor；0.1.0 没有锁定概念，迁移时清空锁定字段；导入后状态栏会明确提示已迁移。
- 项目不嵌入音频或绝对路径，重新打开后必须由用户重新关联本地 WAV。
- 替换音频或关闭页面时释放旧的对象 URL。

## 当前边界

- 这是浏览器技术原型，还没有 Electron/Tauri 桥接、原生文件对话框或安装包。
- 项目文件尚未包含读音、音素或演唱草稿。
- 撤销栈不区分"操作类型"也不支持分支历史；超大快捷操作（如批量重生成）尚未有"折叠为一步"的机制。
- 钢琴卷帘已落地，但所有音符都是用户手工创建（source=manual）；等接入 Basic Pitch / Demucs 后端后才会有 source=transcription 的转录音符。已支持量化、1/8 拍、三连音、附点、Swing 网格与"量化"按钮，但还没有非破坏混音参数（cut/warp/effect）与原始/重合成试听切换。
- stem 混音器已落地，但 drums/bass/other 是占位 stem（无分离音频），等接入 Demucs / Basic Pitch 后端后才会实际播放与转录。
- 浏览器不能在重新打开项目后静默访问原音频，必须重新选择文件。
- 分析 CLI 当前只接受未压缩整数 PCM WAV；和弦与段落准确率仍未通过完整验收。
- 三平台浏览器和高 DPI/输入法测试尚未完成；本轮新交互（钢琴卷帘）尚未经过真实浏览器回归。
