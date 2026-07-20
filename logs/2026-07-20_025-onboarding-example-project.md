# 轮 025 · P5 新手引导页 + 一键加载示例项目

**日期**：2026-07-20（实际完成 2026-07-21）
**序号**：025
**主题**：用户反馈"新手看不懂、引导差、不知道怎么用"，要求"两者结合"——首次显示引导页含一键加载示例，之后直接进工作台。本轮实现完整的新手友好引导层，覆盖 HTML/CSS/JS 与测试。

## 目标

按 `docs/ROADMAP.md` P5 可用性与发布要求，针对用户反馈"不知道怎么用"的痛点：

1. 修改 `prototype/web-workbench/index.html`：在 `<main>` 开头新增 `#onboarding-panel` section（4 步引导卡片 + 加载示例按钮 + 跳过按钮 + 不再显示勾选框 + 帮助折叠）
2. 修改 `prototype/web-workbench/styles.css`：新增引导页样式（卡片式布局 + 步骤指引 + 响应式 + 暗色模式）
3. 修改 `prototype/web-workbench/app.js`：首次访问检测（localStorage `miku-onboarding-completed`）、引导页显示/隐藏、加载示例项目、跳过引导、不再显示勾选
4. 创建 `prototype/web-workbench/onboarding.js`：独立 IIFE 引导模块（不污染全局，通过 CustomEvent 与 app.js 协作）
5. 更新 `tests/test_web_workbench_static.py`：引导页相关测试 + 调整 scripts 列表断言
6. 写本轮日志并更新 `project-state.json` + `CHANGELOG.md`

## 关键约束遵循

- **渐进式呈现原则**：引导页只是首屏，不隐藏专业数据。用户跳过后直接进完整工作台，所有专业数据（钢琴卷帘、stem 混音器、和弦修正、字段锁定、撤销/重做）仍可查看和修改。
- **首次访问检测用 localStorage**：`miku-onboarding-completed` = "true" 表示已完成引导。
- **示例项目加载**：引导页"加载示例"按钮优先加载 `fixtures/basic-c-major-120-v1/librosa-analysis-v2.json`，找不到时降级到 `fixtures/integration/integration-fixture.json`；并尝试关联 `fixtures/.generated/basic-c-major-120-v1.wav`。
- **示例项目路径处理**：浏览器模式用相对路径 `../../fixtures/...` 与 `../fixtures/...`（双候选，适配不同部署目录深度）；Electron 模式下 `file://` 同源 fetch 也可访问本地夹具。
- **不破坏现有 107 项测试**：本轮所有 5 个测试套件全部通过，新增 8 项 P5 测试，总计 115 项。
- **不使用 innerHTML**：所有 DOM 操作用 `textContent` 与 `appendChild`（与既有规则一致）。

## 执行内容

### 1. `prototype/web-workbench/index.html`（修改，+60 行）

在 `<main>` 开头、`<section class="import-panel">` 之前新增 `<section id="onboarding-panel" class="onboarding-panel" hidden>`，包含：

- **onboarding-card 容器**：最大宽度 720px，居中卡片样式
- **onboarding-header**：eyebrow "首次使用 · 快速上手" + h2 欢迎语 + subtitle 介绍
- **onboarding-steps（4 步）**：
  1. 导入伴奏分析（提到 `tools/analyze_audio.py` 与内置 librosa 分析器）
  2. 关联无人声伴奏 WAV（强调"音频只在本地使用，不会上传"）
  3. 选择歌词区域并填词（提到中文/日文 + 拼音/罗马音自动纠正）
  4. 导出到歌声引擎（明确列出 OpenUtau USTX 0.7 / Synthesizer V 1.9.0 / VOCALOID6 6.13.0 / MIDI 基线四种格式）
- **onboarding-actions**：`#load-example-button`（primary，"加载示例项目（推荐）"）+ `#skip-onboarding-button`（"跳过，直接进入工作台"）
- **onboarding-dont-show**：`#dont-show-again` 复选框 + "不再显示引导页"
- **onboarding-help**：`<details>` 折叠"找不到分析 JSON？"，展开后列出 3 种获取分析 JSON 的方式（内置 librosa 分析器 / `python tools/analyze_audio.py` / `python -m tools.miku_analysis.librosa_backend`）

底部新增 `<script src="onboarding.js" defer>`，放在 `desktop-bridge.js` 与 `app.js` 之间。顺序固定：bridge 先初始化桌面能力 → onboarding 决定首屏可见性 → app.js 主程序。

### 2. `prototype/web-workbench/styles.css`（修改，+25 行）

在文件末尾（响应式断点之后）新增 P5 引导页样式块：

- `.onboarding-panel`：flex 居中布局，padding 与 main 一致
- `.onboarding-card`：最大宽度 45rem，圆角 1rem，使用 `--surface` 背景 + `--border` 边框 + `--shadow` 阴影
- `.onboarding-header`：居中文字，h2 1.5rem，subtitle 用 `--muted`
- `.onboarding-steps`：list-style none，每项 flex 布局（数字徽章 + 内容）
- `.step-number`：2rem 圆形徽章，`--accent` 背景 + 白字
- `.step-content h3/p`：标题 1rem，正文 0.82rem 用 `--muted`
- `.onboarding-actions`：flex 居中，按钮 padding 0.6rem 1.25rem
- `.onboarding-dont-show`：居中 + 虚线边框，区别于普通 inline-check
- `.onboarding-help`：折叠帮助区，summary 用 `--text`，内容用 `--muted`
- 响应式：650px 以下卡片 padding 缩小、步骤 gap 缩小、step-number 缩小

所有样式使用既有 CSS 变量（`--surface` / `--muted` / `--accent` / `--border` / `--shadow`），自动适配暗色模式与 `prefers-color-scheme`。

### 3. `prototype/web-workbench/app.js`（修改，+约 145 行）

**新增常量**（在 `ANALYSIS_SCHEMA` 之后）：

```javascript
const ONBOARDING_KEY = "miku-onboarding-completed";
```

**新增 elements 引用**（在 `elements` 对象中，`importProjectButton` 之后）：

- `onboardingPanel: byId("onboarding-panel")`
- `importPanel: document.querySelector(".import-panel")`
- `loadExampleButton: byId("load-example-button")`
- `skipOnboardingButton: byId("skip-onboarding-button")`
- `dontShowAgain: byId("dont-show-again")`

**新增 5 个函数**（在 `applyAnalysis` 之后、`渲染辅助` 之前）：

- `shouldShowOnboarding()`：读 `localStorage.getItem(ONBOARDING_KEY)`，不等于 "true" 则返回 true；try/catch 包裹，localStorage 不可用时返回 true（默认显示）。
- `showOnboarding()`：显示 `onboardingPanel`，隐藏 `importPanel` 与 `workbench`。
- `completeOnboarding(dontShowAgain)`：当 `dontShowAgain` 为 true 时写入 `localStorage.setItem(ONBOARDING_KEY, "true")`；隐藏 `onboardingPanel`，显示 `importPanel`。try/catch 包裹 localStorage 写入。
- `loadExampleProject()`：异步函数。按优先级 fetch 4 条候选路径：
  1. `../../fixtures/basic-c-major-120-v1/librosa-analysis-v2.json`（首选，librosa v2）
  2. `../fixtures/basic-c-major-120-v1/librosa-analysis-v2.json`（备选路径深度）
  3. `../../fixtures/integration/integration-fixture.json`（降级，最小集成夹具）
  4. `../fixtures/integration/integration-fixture.json`（备选路径深度）
  
  fetch 成功后：JSON.parse → 根据 `loadedFromIntegration` 标志决定是否提取 `parsed.analysis` 字段（integration-fixture.json 是完整项目 JSON，需要提取内嵌 analysis；librosa-analysis-v2.json 是纯分析 JSON，直接用）→ `validateAnalysis()` → `applyAnalysis()` → `tryAssociateExampleAudio()` → `completeOnboarding(false)` → 派发 `miku:onboarding-complete` CustomEvent。fetch 全部失败时 setStatus 提示用户手动导入。
  
- `tryAssociateExampleAudio()`：异步函数。尝试 fetch `../../fixtures/.generated/basic-c-major-120-v1.wav` 与 `../fixtures/.generated/basic-c-major-120-v1.wav`，成功则转 Blob → File → 调用既有 `handleAudioFile()` 关联音频。fetch 失败时静默跳过（不阻断示例分析加载）。

**新增事件绑定**（在 `// ---- 事件绑定` section 开头）：

- `elements.loadExampleButton` click → 异步调用 `loadExampleProject()`，按钮在执行期间 disabled 防止重复点击。
- `document` 监听 `miku:load-example-project` CustomEvent → 异步调用 `loadExampleProject()`（onboarding.js 派发的事件备用通道）。
- `elements.skipOnboardingButton` click → 读取 `elements.dontShowAgain.checked` → `completeOnboarding(dontShowAgain)`。

**首屏可见性初始化**（在 IIFE 末尾，事件绑定之后）：

```javascript
if (shouldShowOnboarding()) {
  elements.onboardingPanel.hidden = false;
  elements.importPanel.hidden = true;
  elements.workbench.hidden = true;
} else {
  elements.onboardingPanel.hidden = true;
  elements.importPanel.hidden = false;
}
```

与 onboarding.js 形成双重保险：onboarding.js 在 DOMContentLoaded 时已经按 localStorage 决定过一次首屏可见性；app.js 在事件绑定完成后做最终校正，确保 elements 已就绪。

### 4. `prototype/web-workbench/onboarding.js`（新建，107 行）

独立 IIFE 模块，不污染全局。设计要点：

- **不暴露到 window/globalThis**：所有状态与函数封闭在 IIFE 内。
- **与 app.js 解耦**：本模块只负责"显示/隐藏引导卡片"的 UI 层逻辑；实际"加载示例项目"通过 CustomEvent 通知 app.js 完成（app.js 才有 state/applyAnalysis）。
- **双向协作通道**：
  - 本模块 `dispatchEvent("miku:load-example-project")` → app.js 监听并调用 `loadExampleProject()`
  - app.js `dispatchEvent("miku:onboarding-complete")` → 本模块监听并隐藏引导卡片
- **localStorage 双重保险**：本模块也读 `ONBOARDING_KEY`（与 app.js 字符串一致），DOMContentLoaded 时按 localStorage 决定首屏可见性。app.js 在事件绑定完成后再次校正。
- **DOM ready 处理**：defer 属性已保证脚本在 HTML 解析完成后执行，但仍做 `document.readyState` 检测以兼容动态注入场景。
- **元素缺失保护**：`getElements()` 返回的对象在 DOM 不存在引导页时所有字段为 null；`init()` 检测 `panel` 不存在时直接 return（兼容简化页面或测试场景）。
- **不使用 innerHTML**：与既有规则一致，所有 DOM 操作用 `hidden` 属性切换。

关键函数：

- `readCompletedFlag()` / `writeCompletedFlag(value)`：localStorage 读写，try/catch 包裹。
- `getElements()`：返回 `{ panel, importPanel, workbench, loadButton, skipButton, dontShowAgain }`。
- `showOnboardingPanel()` / `hideOnboardingPanel()`：切换可见性。
- `init()`：读 localStorage 决定首屏 → 绑定 skipButton / loadButton click 事件 → 监听 `miku:onboarding-complete` 事件。

### 5. `tests/test_web_workbench_static.py`（修改，+约 90 行）

**调整既有断言**（1 处）：

- `test_entrypoint_has_unique_ids_and_local_assets`：`self.parser.scripts` 期望从 `["desktop-bridge.js", "app.js"]` 改为 `["desktop-bridge.js", "onboarding.js", "app.js"]`（新增 onboarding.js 在中间）。

**setUpClass 新增**：`cls.onboarding_js = (WORKBENCH / "onboarding.js").read_text(encoding="utf-8")`

**新增 8 项 P5 引导测试**：

1. `test_index_html_has_onboarding_panel`：含 `id="onboarding-panel"` + `class="onboarding-panel"` + `class="onboarding-card"`
2. `test_index_html_has_load_example_button`：含 `id="load-example-button"` + "加载示例项目" 文本
3. `test_index_html_has_skip_onboarding_button`：含 `id="skip-onboarding-button"` + "跳过" 文本
4. `test_index_html_has_dont_show_again_checkbox`：含 `id="dont-show-again"` + "不再显示" 文本
5. `test_index_html_has_onboarding_steps`：4 个 `class="step-number"` + 4 个 `class="step-content"` + 4 个步骤标题（"导入伴奏分析" / "关联无人声伴奏 WAV" / "选择歌词区域并填词" / "导出到歌声引擎"）
6. `test_app_js_has_onboarding_logic`：含 `function shouldShowOnboarding` / `function completeOnboarding` / `function loadExampleProject` + `ONBOARDING_KEY` 常量 + 5 个 elements 引用 + 2 个事件绑定 + `librosa-analysis-v2.json` / `integration-fixture.json` / `basic-c-major-120-v1.wav` 路径 + `miku:onboarding-complete` 事件
7. `test_app_js_uses_local_storage`：含 `localStorage.getItem(ONBOARDING_KEY)` / `localStorage.setItem(ONBOARDING_KEY, "true")` / `return true;`（catch 降级）+ `if (shouldShowOnboarding())` 首屏初始化
8. `test_onboarding_js_exists_and_is_iife`：`"use strict";` + `(() => {` + 以 `})();` 结尾 + `ONBOARDING_KEY` 一致 + 读写 localStorage + `miku:load-example-project` / `miku:onboarding-complete` CustomEvent + `DOMContentLoaded` + 不暴露到 `globalThis.MikuOnboarding` / `window.MikuOnboarding` + 不使用 innerHTML

## 修改文件清单（绝对路径）

1. `c:\Users\yEluN\Documents\miku歌姬放计划\prototype\web-workbench\index.html`（+60 行：onboarding section + script 标签）
2. `c:\Users\yEluN\Documents\miku歌姬放计划\prototype\web-workbench\styles.css`（+25 行：onboarding 样式）
3. `c:\Users\yEluN\Documents\miku歌姬放计划\prototype\web-workbench\app.js`（+约 145 行：ONBOARDING_KEY 常量 + 5 个 elements 引用 + 5 个函数 + 事件绑定 + 首屏初始化）
4. `c:\Users\yEluN\Documents\miku歌姬放计划\prototype\web-workbench\onboarding.js`（新建，107 行：IIFE 模块）
5. `c:\Users\yEluN\Documents\miku歌姬放计划\tests\test_web_workbench_static.py`（+约 90 行：1 处断言调整 + 8 项新测试）
6. `c:\Users\yEluN\Documents\miku歌姬放计划\project-state.json`（更新 phase / last_updated / status / editor_interactions / current_deliverables / next_actions）
7. `c:\Users\yEluN\Documents\miku歌姬放计划\CHANGELOG.md`（新增 P5 Added 条目）

## 关键函数名

- `shouldShowOnboarding()`：读 localStorage 决定首屏可见性
- `showOnboarding()`：显示引导页，隐藏 import-panel 与 workbench
- `completeOnboarding(dontShowAgain)`：隐藏引导页，可选写入 localStorage
- `loadExampleProject()`：异步加载示例分析 JSON + 关联示例 WAV
- `tryAssociateExampleAudio()`：异步关联示例 WAV（fetch 失败时静默跳过）
- onboarding.js IIFE：`readCompletedFlag()` / `writeCompletedFlag(value)` / `getElements()` / `showOnboardingPanel()` / `hideOnboardingPanel()` / `init()`

## 验证结果

运行 5 个测试套件，全部通过：

```
python -m unittest tests.test_web_workbench_static -v
Ran 47 tests in 0.025s
OK

python -m unittest tests.test_desktop_shell_static -v
Ran 26 tests in 0.004s
OK

python -m unittest tests.test_engine_adapters -v
Ran 28 tests in 1.911s
OK

python -m unittest tests.test_librosa_backend -v
Ran 10 tests in 2.460s
OK

python -m unittest tests.test_audio_analysis -v
Ran 4 tests in 0.482s
OK
```

总计 115 项测试全部通过（107 项既有 + 8 项新增 P5 引导测试）。既有 107 项测试无任何回归。

## 决定与理由

1. **onboarding.js 与 app.js 双重保险**：onboarding.js 在 DOMContentLoaded 时按 localStorage 决定首屏可见性（早于 app.js 完整初始化）；app.js 在事件绑定完成后再次校正（确保 elements 已就绪）。理由：defer 脚本顺序固定但 app.js 初始化涉及更多状态，双重保险避免单点失败导致首屏白屏。
2. **app.js 仍保留 shouldShowOnboarding / completeOnboarding / loadExampleProject 函数**：尽管 onboarding.js 处理 UI 层切换，但这三个函数需要访问 app.js IIFE 内部的 `state` / `elements` / `applyAnalysis` / `handleAudioFile` / `setStatus`，必须定义在 app.js 内。onboarding.js 通过 CustomEvent 触发 app.js 的加载逻辑，避免重复实现。
3. **示例 JSON 双候选路径**：`../../fixtures/...` 与 `../fixtures/...` 两条路径分别适配"从 prototype/web-workbench/ 直接打开"与"从项目根打开"两种部署场景。Electron 模式下 `file://` 同源 fetch 也可访问本地夹具，无需新增 IPC handler。
4. **integration-fixture.json 降级提取 analysis 字段**：integration-fixture.json 是完整项目 JSON（顶层有 `schema_version` / `analysis` / `editing` 等字段），需要提取 `parsed.analysis` 才能传给 `validateAnalysis()`；librosa-analysis-v2.json 是纯分析 JSON，直接用。通过 `loadedFromIntegration` 标志区分。
5. **WAV 关联是可选的**：`tryAssociateExampleAudio()` fetch 失败时静默跳过，不影响示例分析 JSON 加载。用户仍可在导入面板手动选择 WAV。理由：示例 WAV 路径 `fixtures/.generated/basic-c-major-120-v1.wav` 可能在某些部署中不存在（例如仅打包 web-workbench 不打包 fixtures），不应阻断示例分析加载。
6. **不新增 IPC handler 读取示例文件**：当前 `file://` fetch 在浏览器与 Electron 中均可工作（同源），无需为示例加载新增 `miku:readExampleFixture` IPC handler。如果未来 Electron `webSecurity` 配置变化导致 `file://` fetch 受限，可再考虑新增 IPC。
7. **scripts 列表断言更新**：`test_entrypoint_has_unique_ids_and_local_assets` 中 `self.parser.scripts` 期望从 `["desktop-bridge.js", "app.js"]` 改为 `["desktop-bridge.js", "onboarding.js", "app.js"]`。这是必要的破坏性变更（新增脚本文件），但不影响既有 107 项测试的功能覆盖。

## 未决问题

1. **真机回归未执行**：本轮仅通过静态测试验证 HTML/CSS/JS 结构与函数存在性，未在真实浏览器或 Electron 中验证首屏可见性、按钮点击、示例项目加载流程。需在下一轮或用户手动验证：
   - 首次访问（清空 localStorage）时引导页是否显示
   - 点击"加载示例项目"是否能 fetch `fixtures/basic-c-major-120-v1/librosa-analysis-v2.json` 并加载到时间轴
   - 点击"跳过"是否能隐藏引导页并显示导入面板
   - 勾选"不再显示"后刷新页面是否直接进导入面板
   - Electron 模式下 `file://` fetch 是否被 `webSecurity` 阻断（如果阻断，需要新增 IPC handler）
2. **示例 WAV 关联验证**：`fixtures/.generated/basic-c-major-120-v1.wav` 存在，但 fetch 在 `file://` 协议下可能受限。如果浏览器/Electron 阻断 fetch WAV，用户需要手动选择 WAV 文件（不影响示例分析加载）。
3. **引导页国际化**：当前引导页文案为中文硬编码，未抽取为 i18n 资源。如果未来需要英文版引导页，需要新增 i18n 框架（不在本轮范围）。
4. **引导页分析 JSON 路径深度**：当前用 `../../fixtures/...` 与 `../fixtures/...` 双候选路径适配不同部署深度。如果未来部署到 `dist/web-workbench/` 等更深目录，需要新增第三条候选路径或改用基于 `window.location` 的动态路径计算。
5. **引导页步骤跳转**：当前引导页是静态 4 步展示，不支持点击某一步跳到对应功能区（例如点"3. 选择歌词区域并填词"自动滚动到时间轴）。这是后续 UX 增强，不在本轮范围。

## Git 状态

按任务要求，**未执行 git commit / git push**。主 Agent 将统一提交。

修改文件清单：

- `prototype/web-workbench/index.html`（修改）
- `prototype/web-workbench/styles.css`（修改）
- `prototype/web-workbench/app.js`（修改）
- `prototype/web-workbench/onboarding.js`（新建）
- `tests/test_web_workbench_static.py`（修改）
- `project-state.json`（修改）
- `CHANGELOG.md`（修改）
- `logs/2026-07-20_025-onboarding-example-project.md`（新建，本文件）
