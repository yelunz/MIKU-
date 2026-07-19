# 2026-07-20 / 003 / 确认平台、语言与适配器范围

## 本轮目标

把用户确认的跨平台、歌词语言、首轮音频类型和外部编辑器范围写入项目，并使用多个子 Agent 并行核对官方兼容资料。

## 用户确认的要求

- 核心应用需要在 Windows、macOS、Linux 运行。
- 第一优先适配 Synthesizer V Studio Pro 第一代（1.x，不是 Studio 2 Pro）和验证时最新版稳定版 OpenUtau。
- VOCALOID 官方编辑器也应可用，但具体版本尚未确认。
- 首版支持中文、日文歌词，暂不支持英文。
- 第一轮测试使用无人声伴奏。
- 遇到多项能够独立处理的工作时，使用多个子 Agent 协助，由主 Agent 完成整合。

## 子 Agent 分工与结论

- `docs_impact_review`：审查现有文档冲突，指出 Windows 单平台建议、Synthesizer V 2 资料和旧待确认状态必须改正；建议三个后端按优先级和版本管理。
- `research_synthv1`：核对 Dreamtonics 官方资料。确认第一代独立版支持三个系统，但插件只支持 Windows/macOS；建议 MIDI 基线加实机验证后的配套脚本，不直接读写未公开稳定规范的 `.svp`。
- `research_openutau`：核对官方 GitHub/Wiki。确认当前稳定基线 0.1.565、USTX 0.6 和三平台安装；建议直接生成 USTX，首版不依赖实验性 Phonemizer API。
- `research_vocaloid`：核对 Yamaha/VOCALOID 官方资料。确认 V3/V4 使用 VSQX、V5/V6 使用 VPR，扩展能力和 MIDI 歌词支持随代际变化；官方编辑器没有 Linux 版，未知版本时只使用 MIDI 基线和损失报告。

## 执行内容

- 新增并执行多 Agent 协作规则。
- 更新首版运行平台、语言、测试输入和后端优先级。
- 把 OpenUtau 固定为“验证时最新版稳定版”，当前调研基线为 0.1.565 / USTX 0.6。
- 建立独立的 `synthv-v1` 适配器方向，区分 Linux 独立版和 Windows/macOS 插件增强路径。
- 为 VOCALOID 采用按主版本和编辑器形态划分的版本化适配器方向，不擅自锁定 VOCALOID6。
- 增加中文、日文中立读音模块和三平台验收边界。

## 修改文件

- `README.md`
- `AGENTS.md`
- `CHANGELOG.md`
- `project-state.json`
- `docs/PRODUCT_DEFINITION.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/RESEARCH_NOTES.md`
- `docs/WORKFLOW.md`
- `logs/2026-07-20_003-confirmed-platform-language-and-adapters.md`

## 验证

- 已执行 JSON 解析、必需文件、过时待确认项、首版范围字段、Markdown 行尾空白和 Git 差异检查；结果通过。
- 外部事实只采用 Dreamtonics、OpenUtau 项目和 Yamaha/VOCALOID 的官方资料。
- 本轮只更新产品与技术定义，尚未生成可运行应用或进行真实编辑器导入测试。

## 决定与理由

- 核心应用三平台运行与第三方编辑器三平台可用性分开验收，避免后端平台限制污染核心架构。
- OpenUtau 首版走 USTX 文件适配，因为格式公开且能承载歌声专用数据。
- Synthesizer V 第一代首版走 MIDI/辅助数据，配套脚本必须先在用户实际版本验证。
- VOCALOID 版本未知时只承诺保守 MIDI 交换；确认版本后再增加版本专用能力。
- 中文、日文的显示文字、标准读音和引擎音素分别保存，英文模块首版不实现。

## 未决问题 / 下一步

- 用户安装的 Synthesizer V Studio Pro 1.x 确切版本号。
- 用户希望优先适配的 VOCALOID 官方编辑器版本和形态。
- 获取或创建一段有合法处理权的 30–60 秒无人声伴奏测试素材。
- 制作交互线框图并进行三平台音频分析技术验证。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时存在本轮文档修改，待检查后提交并推送。
