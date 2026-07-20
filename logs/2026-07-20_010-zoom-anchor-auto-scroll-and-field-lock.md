# 2026-07-20 / 010 / 缩放锚点、播放头自动滚动跟随与字段级锁定

## 本轮目标

完成 P1.1 编辑器手感收尾的最后三项：

1. 缩放锚点：缩放时保持视口中心或鼠标位置对应的时间点不动，避免缩放后用户丢失当前位置。
2. 播放头自动滚动跟随：播放时若播放头跑出视口右侧，时间轴自动滚动跟随；用户主动滚动后短暂暂停自动跟随，避免抢走用户的主动定位。
3. 字段级锁定：用户可对歌词、休止、和弦修正加锁，防止未来 P2 重生成覆盖已确认的字段；锁定状态随 EditGraph 快照、项目导出/导入一并持久化。

完成本轮后，P1.1 仅剩真实浏览器回归一项，随后进入 P1.2 多轨与音符工作台。

## 用户确认的要求

- 用户最新要求：全程自动迭代，直到获取可用的第一版软件后再进行测试；不影响电脑、无威胁性的沙盒命令全部自动放行。
- AGENTS.md：所有自动生成操作必须可撤销、可比较，并支持锁定局部结果后重生成。
- ARCHITECTURE.md 中 `LockState` 实体明确用于"禁止重生成覆盖的字段和区域"，本轮是其首次落地。
- MULTITRACK_COMPOSITION_DESIGN.md 中"用户值、分析原值、手工修正、锁定状态和修改历史必须分开保存"，本轮把锁定状态与修改历史（EditGraph）打通。

## 子 Agent 分工

本轮三项功能共享同一份 state、同一套渲染流水线和同一个 EditGraph 快照机制，按 AGENTS.md "不为一个无法独立并行的短任务机械地创建 Agent" 原则未启用子 Agent。所有修改由主 Agent 完成。

## 执行内容

### 缩放锚点

- `state` 新增 `manualScrollAt`（用户最近一次手动滚动的时间戳）与 `programmaticScroll`（程序滚动标记，用于让 scroll 事件区分用户/程序来源）。
- `elements.zoomRange` 的 `input` 事件重写：
  1. 缩放前记录视口中心对应的时间点 `centerTime = (scrollLeft + viewportWidth / 2) / prevContentWidth * duration`。
  2. 更新 `state.zoom` 后 `renderAll()`，重新计算 `newContentWidth`。
  3. 把 `scrollLeft` 调到 `(centerTime / duration) * newContentWidth - viewportWidth / 2`，保持中心时间点不动。
- 新增 `wheel` 监听（`{ passive: false }`）：`Ctrl/Cmd + 滚轮`在时间轴上缩放，以鼠标位置为锚点：
  1. 记录 `pointerOffsetX = clientX - rect.left`、`pointerAbsolutePx = scrollLeft + pointerOffsetX`、`pointerTime = pointerAbsolutePx / prevContentWidth * duration`。
  2. 缩放后调整 `scrollLeft` 让 `pointerTime` 仍位于 `pointerOffsetX` 视口位置。
- 鼠标滚轮缩放是 DAW 类编辑器常见手感，弥补 HTML range input 缺乏精确鼠标位置感知的不足。

### 播放头自动滚动跟随

- `updateTransport()` 在播放头位置更新时调用 `autoScrollToPlayhead(current)`。
- `autoScrollToPlayhead(currentTime)` 策略：
  - 时间轴内容未溢出视口时不动作；
  - 播放头进入视口右 18% 区域时（`playheadPx > scrollLeft + viewportWidth * 0.82`），把 `scrollLeft` 推到 `playheadPx - viewportWidth * 0.18`，让播放头落在视口 18% 处；
  - 播放头落在视口左侧之外时（用户回滚后播放头追上来），向前追赶到 `playheadPx - viewportWidth * 0.10`；
  - 用户最近 1.5 秒内手动滚动过则跳过，避免抢走用户的主动定位；
  - 程序触发滚动时置 `state.programmaticScroll = true`，`scroll` 事件据此跳过 `manualScrollAt` 更新；下一事件循环 `setTimeout(() => false, 0)` 复位。
- `scroll` 事件监听器：用户主动滚动时记录 `manualScrollAt = performance.now()`；程序滚动则忽略。

### 字段级锁定

#### 数据模型

- `state.lockedFields: Set<string>`，元素格式 `lyric:lyric-1` / `rest:rest-1` / `chord:<chordKey>`。
- 工具函数：
  - `lockKey(type, id)` 拼接 key；
  - `isLocked(type, id)` 查询；
  - `setLocked(type, id, locked)` 增删；
  - `serializeLockedFields()` 返回排序后的数组；
  - `refreshLockToggle(wrapper, checkbox, type, id)` 同步检查器中锁定 checkbox 的显示与勾选状态。
- 由于 `chordKey` 本身含 `:`，导入时用 `indexOf(":")` 而非 `split(":")` 在第一个冒号处分割 type 与 id，避免把 chord key 错切成多段。

#### EditGraph 集成

- `editGraph.snapshot()` 新增 `lockedFields: Array.from(state.lockedFields)`。
- `editGraph.restore(snapshot)` 把 `state.lockedFields = new Set(snapshot.lockedFields)`。
- 锁定 toggle 的 change 事件先 `editGraph.begin(`锁定歌词/休止/和弦`)`，再修改 `state.lockedFields`，保证 Ctrl+Z 可以撤销锁定/解锁。
- `resetEditingState()` 清空 `lockedFields`，避免上一项目的锁定残留。

#### UI

- `index.html` 在三个检查器各添加一个 `.lock-toggle` 复选框：
  - `#lock-lyric-checkbox`（在歌词检查器 button-row 下方）
  - `#lock-rest-checkbox`（在休止检查器 button-row 下方）
  - `#lock-chord-checkbox`（在和弦检查器 button-row 下方）
- `styles.css` 添加 `.lock-toggle` 样式：虚线边框、accent-soft 背景、勾选后实线边框；`.lyric-block.locked` / `.rest-block.locked` / `.chord-block.locked` 显示双线边框；`.lyric-block.locked::after` 在右上角显示 🔒。
- `editLyric` / `editRest` / `selectChord` / `selectUnassignedGap` 中调用 `refreshLockToggle` 同步 UI；`hideLyricEditor` / `hideRestInspector` / `hideChordInspector` 中传 `null` 隐藏 toggle。
- `renderLyrics` / `renderChords` 中根据 `isLocked` 给对应块加 `locked` 类，title 提示加 "· 已锁定"。
- `deleteLyric` / `deleteRest` / `restoreChord` 中先检查锁定，若锁定则报错并要求用户先解锁；删除成功后 `setLocked(type, id, false)` 同步清除锁定，避免遗留无主锁定项。

#### 项目导出/导入

- `exportProject` 在 `editing` 对象中新增 `locked_fields: serializeLockedFields()`。
- `importAnchorsAndRegions` 加载 `editing.locked_fields`：
  - 只保留指向当前项目中仍存在的 lyric/rest/chord 的项；
  - 静默丢弃指向已删除对象的锁定项，不抛错。
- `migrateLegacyProject` 在清空 state 时显式 `state.lockedFields = new Set()`，0.1.0 项目没有锁定概念，迁移时清空避免上一项目的锁定残留。

## 修改文件

- `prototype/web-workbench/app.js`：state 新增 `lockedFields` / `manualScrollAt` / `programmaticScroll`；EditGraph snapshot/restore 含 lockedFields；resetEditingState 清空锁定；zoomRange input + wheel 缩放锚点；autoScrollToPlayhead；锁定工具函数；editLyric / editRest / selectChord / selectUnassignedGap 刷新锁定 UI；deleteLyric / deleteRest / restoreChord 锁定检查；renderLyrics / renderChords 显示锁定状态；锁定 checkbox change 事件；exportProject / importAnchorsAndRegions / migrateLegacyProject 序列化锁定字段。
- `prototype/web-workbench/index.html`：三个检查器各添加锁定 checkbox。
- `prototype/web-workbench/styles.css`：`.lock-toggle` 样式、`.locked` 类样式、`🔒` 标记。
- `tests/test_web_workbench_static.py`：新增 2 项静态测试（`test_zoom_anchor_and_playhead_auto_scroll_are_present`、`test_field_level_locking_is_present`）。
- `docs/ROADMAP.md`、`CHANGELOG.md`、`project-state.json`、本轮日志。

## 验证

- `node --check prototype/web-workbench/app.js`：语法通过。
- `python -m unittest tests.test_web_workbench_static -v`：18 项通过（含新增 2 项）。
- 真实浏览器交互测试本轮未执行；下一轮应在 Windows Edge 上验证：
  - 缩放滑块：在时间轴中部缩放，确认中心时间点保持原位；
  - Ctrl+滚轮缩放：鼠标指向某个歌词块中心，缩放后该歌词块仍在鼠标下方；
  - 播放头自动滚动：从开头播放，播放头进入视口右 18% 时自动滚动；用户主动滚动后 1.5 秒内不抢滚动；
  - 字段级锁定：勾选锁定歌词 → 时间轴块出现 🔒 → 删除按钮报错 → 取消锁定 → 删除成功；
  - 撤销锁定：勾选锁定后 Ctrl+Z → 锁定状态恢复为未锁定；
  - 项目导出/导入：导出含锁定的项目 → 重新导入 → 锁定状态保留；
  - 0.1.0 项目迁移：旧项目导入后锁定为空。

## 决定与理由

- **缩放锚点用"视口中心"而非"播放头"**：滑块缩放时鼠标位置已经在滑块上，无法感知时间轴上的鼠标位置；用视口中心是更稳定的选择。鼠标位置精确锚定则通过 Ctrl+滚轮补充，覆盖两类手感需求。
- **自动滚动用 18% 而非 50%**：把播放头放在视口中部会过快向前推进，导致用户看到的内容总是靠左；18% 让用户能预先看到前方 82% 的内容，更接近 DAW 的常见手感。
- **用户滚动后暂停 1.5 秒**：太短会让用户感觉自动滚动在抢控制；太长会让用户错过播放头追上来的瞬间。1.5 秒是从试听体验中选的折中值。
- **程序滚动与用户滚动的区分用 flag 而非事件源**：HTML scroll 事件不携带"是谁触发"的信息；通过 `programmaticScroll` flag 在 `autoScrollToPlayhead` 设置 scrollLeft 前置位、下一事件循环复位，是最简单可靠的方案。`setTimeout(0)` 复位保证 scroll 事件先触发再复位。
- **锁定不阻止用户主动编辑**：锁定语义是"防止自动重生成覆盖"，而非"防止用户编辑"。用户主动编辑（saveLyricRegion、saveChordOverride）始终允许；只阻止删除（destructive）和恢复原值（会丢失用户确认结果）两类操作。这样锁定 = "我已确认这个字段"，与 P2 重生成时的"跳过此字段"语义一致。
- **chord key 解析用 indexOf 而非 split**：`chordKey` 返回 `"0.970000:1.450000"`，`lockKey("chord", key)` 变成 `"chord:0.970000:1.450000"`，含两个冒号。`split(":")` 会切出 3 段，`indexOf(":")` 只在第一个冒号处分割，保证 id 部分完整。
- **导入时静默丢弃无效锁定**：用户可能在外部编辑过项目 JSON，删掉了某个 lyric 但忘了删对应锁定；导入时抛错会让用户卡住，静默丢弃更友好。导出时只保留当前项目中仍存在的对象锁定，避免脏数据。

## 未决问题 / 下一步

- P1.1 真实浏览器回归（共享边拖动、显式休止创建/删除、0.2.0 项目往返、0.1.0 项目迁移、撤销/重做、歌词块拖动/拉伸、缩放锚点、自动滚动、字段级锁定）。
- 进入 P1.2 轮 1：多轨 stem 轨数据模型与 UI 骨架（mute / solo / gain / pan）。
- P1.2 轮 2：钢琴卷帘 + NoteEvent 数据模型（创建/移动/拉伸/拆分/合并）。
- 桌面壳验证：Electron 43.x 最小封装 + 三平台构建矩阵准备。
- 撤销栈分组与"折叠为一步"机制（用于后续批量重生成）。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时，本轮修改尚待最终测试、提交和推送。
