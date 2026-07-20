# 2026-07-20 / 009 / EditGraph 撤销重做栈与歌词块整体拖动拉伸

## 本轮目标

推进 P1.1 编辑器手感收尾的两项：撤销/重做栈（EditGraph 第一版）与歌词块整体拖动/边缘拉伸。这两项是用户反馈"专业编辑器手感"的核心缺口，也是后续 P1.2 多轨音符工作台撤销栈的前置基础。

## 用户确认的要求

- 用户最新要求：全程自动迭代，直到获取可用的第一版软件后再进行测试；不影响电脑、无威胁性的沙盒命令全部自动放行，无需手动操作。
- AGENTS.md 已规定"所有自动生成操作必须可撤销、可比较，并支持锁定局部结果后重生成"，本轮是"可撤销"的首次落地。
- AGENTS.md 已规定"连续歌词/音符区域必须共享边界或明确显示休止"，歌词块整体拖动时需要谨慎处理共享 anchor：克隆后才能单独移动，否则会破坏邻居。

## 子 Agent 分工

本轮为单一耦合实现（EditGraph 与歌词块拖动共享 state 与 renderAll），按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主 Agent 完成。

## 执行内容

### EditGraph 第一版

- 在 IIFE 顶部 `state` 之后定义 `editGraph` 对象：`undoStack` / `redoStack` / `maxSize = 50`。
- `snapshot()` 深拷贝 anchors（Map→数组→新 Map）、lyrics、rests、chordOverrides、selection、selectedLyricId、selectedRestId、nextLyricId、nextRestId、nextAnchorId；不保存 audioUrl / analysis 等不可变状态。
- `restore(snapshot)` 把上述字段全部还原，并清除编辑器视图（lyricText / chordInspector / restInspector / cancelLyricEditButton / deleteLyricButton）。
- `begin(label)` 在执行操作前调用：把当前状态推入 undoStack，超出 50 条则丢弃最旧，清空 redoStack，调用 `updateUndoRedoButtons()`。
- `undo()` / `redo()` 互相搬运快照；返回布尔表示是否处理；调用 `setStatus` 提示。
- `canUndo()` / `canRedo()` 用于按钮 disabled 状态。
- `updateUndoRedoButtons()` 同步按钮 disabled 与 title（含可回退/可重做步数）。
- `resetEditingState()`（导入新项目时调用）清空 undo/redo 栈，避免旧历史污染新项目。

### 撤销点记录

在以下用户操作前调用 `editGraph.begin(label)`：
- 新建歌词：`editGraph.begin("新建歌词")`
- 编辑歌词：`editGraph.begin(`编辑歌词 ${existing.id}`)`
- 删除歌词：`editGraph.begin(`删除歌词 ${state.selectedLyricId}`)`
- 新建休止：`editGraph.begin("新建休止")`
- 删除休止：`editGraph.begin(`删除休止 ${id}`)`
- 修正和弦：`editGraph.begin(`修正和弦 ${label}`)`
- 恢复和弦：`editGraph.begin("恢复和弦")`
- 拖动共享边：`editGraph.begin("拖动共享边界")`（首次实际移动时才记录，避免没移动也写 undo）
- 微调共享边（方向键）：`editGraph.begin("微调共享边界")`
- 拖动歌词块：`editGraph.begin(`拖动歌词 ${region.id}`)` 或 `editGraph.begin(`拉伸歌词 ${region.id}`)`

### 拖动取消时不留撤销步

- 共享边拖动 `pointercancel` / Esc：调用 `cancelEdgeDrag`，先回退 anchor 到 previousSample，再 `editGraph.undoStack.pop()` 丢弃刚记录的撤销点。
- 歌词块拖动 `pointercancel` / Esc：`cancelLyricBlockDrag` 把 region 的 startAnchorId/endAnchorId 恢复到 originalStartAnchorId/originalEndAnchorId（如果 detach 过），然后 `editGraph.undoStack.pop()` 丢弃撤销点，再 `pruneAnchors()` 清理克隆出来又被丢弃的 anchor。

### 快捷键

- `Ctrl+Z` 撤销，`Ctrl+Shift+Z` 或 `Ctrl+Y` 重做。
- 在文本输入框（input / textarea / select / contentEditable）中不拦截，让浏览器原生文本编辑正常工作。
- Esc 现在新增"取消歌词块拖动"分支。

### UI 按钮

- 在 `index.html` 的 `header-actions` 顶部新增 `#undo-button` 和 `#redo-button`，初始 `disabled`。
- `styles.css` 给这两个按钮设置 `min-width: 4.5rem`，让标签长度变化不会引起布局抖动。

### 歌词块整体拖动与边缘拉伸

- `renderLyrics` 中 lyric-block 的 `click` 监听器替换为 `pointerdown`，进入 `beginLyricBlockDrag`。
- `beginLyricBlockDrag`：根据 `event.clientX` 距块左右边的距离判定模式：
  - `<= 8 px` → `stretch-start` 或 `stretch-end`
  - 否则 → `move`
- `state.lyricDrag` 保存 regionId、模式、起始 clientX、起始 startSample/endSample、原始 startAnchorId/endAnchorId、beganEdit、detachedStart、detachedEnd。
- `setPointerCapture` 锁定到块元素，再在 document 上加 capture-phase `pointermove` / `pointerup` / `pointercancel` 监听。
- `moveLyricBlock`：移动距离 < 4 像素且未 beginEdit 时直接返回（视为点击）；首次实际移动时 `editGraph.begin`，并按需 `detachAnchorIfShared`。
- `detachAnchorIfShared(region, which)`：如果 start/end anchor 与其他 region 共享，则克隆一个新 anchor 给当前 region，保持邻居不动。这是连续歌词区在单独拖动后产生小缝的根因——这是用户预期。
- `move` 模式：保持时长不变，整体平移；限制不能跨越邻居的另一端 anchor。
- `stretch-start` / `stretch-end`：只移动一端 anchor，不能让起止 sample 反转。
- `endLyricBlockDrag`：移除 document 监听；如果没真正拖动（!beganEdit），调用 `editLyric(drag.regionId)` 进入编辑模式（保留原点击行为）；否则 `pruneAnchors()` 并报告新位置。
- `cancelLyricBlockDrag`：恢复原始 anchor 引用，丢弃撤销点，清理克隆 anchor，重新渲染。

### 视觉提示

- `.lyric-block` 默认 `cursor: grab`，`:active` 时 `cursor: grabbing`。
- `::before` / `::after` 在块左右 8 像素显示 `ew-resize` 光标，提示可拉伸。

## 修改文件

- `prototype/web-workbench/app.js`：editGraph 模块、撤销点记录、歌词块拖动/拉伸、快捷键、按钮绑定
- `prototype/web-workbench/index.html`：撤销/重做按钮
- `prototype/web-workbench/styles.css`：撤销/重做按钮宽度、lyric-block 拖动光标与拉伸边缘
- `prototype/web-workbench/README.md`：已实现与当前边界章节同步
- `tests/test_web_workbench_static.py`：新增 2 项静态测试（EditGraph、歌词块拖动）
- `CHANGELOG.md`、`docs/ROADMAP.md`、`project-state.json`、本轮日志

## 验证

- `python -m unittest discover -s tests -v`：20 项通过（4 项音频分析 CLI + 16 项 Web 工作台静态测试，新增 2 项：`test_edit_graph_undo_redo_is_present`、`test_lyric_block_drag_and_stretch_are_present`）。
- `node --check prototype/web-workbench/app.js` 与 `node --check prototype/web-workbench/desktop-bridge.js`：语法通过。
- 真实浏览器交互测试本轮未执行；下一轮应在 Windows Edge 上验证：新建歌词 → 撤销 → 重做；拖动歌词块 → 验证邻居不动；拉伸歌词块边缘 → 验证时长变化；Esc 取消拖动 → 验证位置恢复。

## 决定与理由

- **快照而非 diff**：第一版用深拷贝快照实现简单可靠；diff 模型要为每种操作定义 inverse，工作量大且易错。50 条上限足以覆盖常见编辑链；后续若需要更长历史或更细粒度，再升级为 diff。
- **不在文本输入时拦截 Ctrl+Z**：浏览器原生文本框撤销是用户熟悉的行为；强行拦截会破坏输入体验。检测 `target instanceof HTMLInputElement || HTMLTextAreaElement || HTMLSelectElement || isContentEditable` 后 early-return。
- **拖动取消丢弃撤销点**：用户 Esc 取消拖动时，anchor 已经回退到 previousSample；如果保留撤销点，下一步 Ctrl+Z 会把 anchor 移回取消前的位置（也就是回退后的位置），产生"撤销无变化"的错觉。丢弃撤销点更符合直觉。
- **共享 anchor 拖动前克隆**：连续歌词区共享 anchor 是数据层共享；如果用户单独拖动一块，强行移动共享 anchor 会同时改变邻居，这不是"移动一块"的预期。克隆一个新 anchor 给当前 region，邻居保持原位，是更符合直觉的行为。代价是连续区会留下小缝——但用户可以用共享边手柄重新合并。
- **撤销栈不区分操作类型**：第一版所有操作都是同一类快照，不区分"歌词创建"和"和弦修正"。后续若需要分组撤销（如"撤销所有和弦修正"），再扩展。

## 未决问题 / 下一步

- 缩放锚点（鼠标位置或播放头锚定）。
- 自动滚动跟随播放头。
- 字段级锁定（防重生成覆盖）。
- 真实浏览器回归：撤销/重做、歌词块拖动/拉伸、共享边拖动、显式休止创建/删除、0.2.0 项目往返、0.1.0 项目迁移。
- 撤销栈分组与"折叠为一步"机制（用于后续批量重生成）。
- 进入 P1.2 多轨与音符工作台。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待最终测试、提交和推送。
