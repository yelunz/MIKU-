# 2026-07-20 / 006 / 可运行 Web 音频工作台

## 本轮目标

把上一轮的分析 JSON 和对话线框图接入可运行工作台，验证本地 WAV 播放、真实分析图层、选区、中文/日文歌词、和弦纠正和项目往返；同时确定桌面壳的下一轮验证方向，但不在三平台打包前不可逆锁栈。

## 用户确认的要求

- 用户连续两次要求继续推进，不需要先停下等待用户操作。
- 第一轮仍使用无人声伴奏；界面不得把伴奏分析说成已提取人声主旋律。
- 多项工作继续使用子 Agent 并行推进，主 Agent 负责整合、测试、日志、提交和推送。
- 首版仍只支持中文和日文歌词，不新增英文。
- OpenUtau、Synthesizer V Studio Pro 1.9.0 和 VOCALOID6 6.13.0 的既定顺序不改变。

## 子 Agent 分工与结论

- `workbench_frontend`：原计划独占 `prototype/web-workbench/` 实现，但持续运行后没有落盘文件。主 Agent 为避免空等而中断该任务并接管实现；该 Agent 没有可采用变更。
- `desktop_stack_research`：只读核对 Electron 与 Tauri 官方资料。结论是本轮不正式锁栈；Electron 43.x 作为第一验证候选，Tauri 2.11.x 作为体积优化备选，并先固定与桌面壳无关的 `DesktopBridge`。
- `workbench_review`：只读建立验收清单并使用 Windows Edge 做真实 fixture 烟测。第一次复审发现分析 schema 校验不足和歌词 ID 重复两个阻塞；修复后又发现极端 BPM/首拍可冻结节拍绘制。主 Agent逐项修复，最终回归确认无残留阻塞。

## 执行内容

- 新增零依赖 Web 工作台，可直接打开 HTML 或由 Python 静态服务器提供。
- 读取并严格校验分析 schema `0.1.0`；缺层、坏区间、非有限值、极端速度和越界首拍会被拒绝，旧有效状态不会被覆盖。
- 绘制真实波形、短时能量、速度节拍线、段落候选和和弦候选；图层可独立开关，时间轴可缩放。
- 关联本地 WAV，播放、暂停、停止和点击定位播放头；拖拽波形建立选区，精确秒数字段只在完整合法时成对生效。
- 计算本地 WAV SHA-256 并与分析源哈希、时长核对；大于 256 MB 或无 Web Crypto 时明确说明只核对时长。
- 建立、编辑和删除中文/日文歌词区域；英文或未知语言项目会被明确拒绝，不会静默改写为中文。
- 点击和弦候选后可保存修正或恢复分析值；修正保存在独立覆盖层，不改写源分析 JSON。
- 导出/导入项目 schema `miku-workbench-project/0.1.0`，恢复分析、选区、歌词和和弦修正；音频本体和绝对路径不写入项目，重新打开后要求用户重新关联。
- 处理稀疏/重复歌词 ID、非法和弦覆盖、项目导入后的播放按钮状态和对象 URL 释放。
- 加入节拍候选范围与绘制迭代双重保护，避免恶意或损坏 JSON 冻结页面。
- 新增浏览器 `DesktopBridge`，隔离对象 URL、SHA-256 和项目下载；桌面实现后续在同一边界扩展原生对话框与分析进程。
- 新增桌面技术栈决策记录、静态自动化测试，并更新根说明、架构、路线图、状态与变更记录。

## 修改文件

- `prototype/web-workbench/index.html`
- `prototype/web-workbench/styles.css`
- `prototype/web-workbench/app.js`
- `prototype/web-workbench/desktop-bridge.js`
- `prototype/web-workbench/README.md`
- `tests/test_web_workbench_static.py`
- `docs/DESKTOP_STACK_SPIKE.md`
- `docs/TIMELINE_PROTOTYPE.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `CHANGELOG.md`
- `project-state.json`
- `logs/2026-07-20_006-runnable-web-workbench.md`

## 验证

- Node `--check` 对 `desktop-bridge.js` 和 `app.js` 通过。
- `python -m unittest`：原有 4 项音频分析测试与新增 10 项 Web 静态测试，共 14 项全部通过。
- Python HTTP 静态服务器启动后，`index.html`、`app.js` 和 `styles.css` 均返回 HTTP 200；服务器在测试后关闭。
- Windows Edge 使用真实 50 秒 fixture：分析 JSON 与 WAV 均可载入，显示 119.993 BPM；播放、选区、歌词、和弦改为 Cmaj7、项目导出/导入和音频重关联提示通过。
- 恶意歌词 `<img onerror>` 只作为文本显示，没有执行；代码不使用 `innerHTML` 写入用户内容。
- 缺少 tempo/chords 的坏分析被拒绝，旧 50 秒状态保持，之后选区无页面错误。
- 稀疏 `lyric-2` 项目新增为 `lyric-3`；重复 ID、英文歌词和非法和弦覆盖被拒绝。
- 正确 WAV 的时长与 SHA-256 校验通过；异源 1 秒 WAV 同时报时长与 SHA 不匹配。
- `bpm=1e300` 和极大负首拍在约 0.2 秒内被拒绝，旧状态保持；边界 1000 BPM 正常渲染，无冻结。
- 尚未在 macOS、Linux 或 Firefox/WebKit 完成实机验证，也尚未生成 Electron/Tauri 安装包。

## 决定与理由

- 先提交标准浏览器前端，保证时间轴、项目模型和纠错状态不绑定某个桌面壳；这也让其他 Codex 无需安装依赖即可立即运行和继续开发。
- Electron 43.x 只是第一验证候选，不是最终锁定。统一 Chromium 与现有 Python CLI 的接入路径较短；Tauri 2.11.x 在体积或资源实测需要时保留。
- 浏览器原型不承诺长期文件权限或后台分析。桌面版必须通过受限桥接调用原生文件对话框和打包分析进程，渲染器不能执行任意命令。
- 当前工作台只编辑歌词区域和分析修正，不提前伪造演唱草稿；P2 才加入读音、音素、音符候选和撤销/锁定。

## 未决问题 / 下一步

- 建立最小 Electron 验证壳，保持沙箱与 `contextIsolation`，通过白名单桥接启动打包后的 Python 分析进程。
- 在 Windows、macOS、Linux 生成真实 packaged artifact，记录启动、内存、安装包体积、音频播放和时间轴性能。
- 在 Firefox、WebKit/Safari 与高 DPI、中文/日文输入法环境复测前端。
- 继续提高和弦与段落分析准确率；当前分析基线仍未达到正式验收线。
- P1 达到桌面打包与三平台标准后，再进入中文/日文读音、音符候选和 OpenUtau USTX 0.6 垂直切片。
- 用户当前仍不需要执行操作；外部编辑器实机验收时再请求安装路径或测试环境。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时存在本轮新增和修改，待最终差异检查、提交和推送。
