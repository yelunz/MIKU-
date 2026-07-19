# 变更记录

本文件记录用户可见的项目能力与重要项目定义变化。详细执行过程见 `logs/`。

## Unreleased

### Added

- 建立项目目标、能力边界、技术架构和阶段路线图。
- 建立 Codex 接手规范、机器可读项目状态和逐轮工作日志制度。
- 配置项目 GitHub 远端地址。
- 新增可重复生成的 50 秒无人声伴奏测试夹具、标准答案和自校验生成器。

### Changed

- 确认核心应用面向 Windows、macOS、Linux。
- 确认首批适配 Synthesizer V Studio Pro 1.9.0 和验证时最新版稳定版 OpenUtau。
- 明确 OpenUtau USTX 0.6 是首个端到端工程导出验收，不因增加 VOCALOID 而降低优先级。
- 选择 VOCALOID6 Editor 完整版 6.13.0（Standalone）作为官方 VOCALOID 主适配目标，并为旧版本保留 MIDI 降级路径。
- 确认首版歌词支持中文、日文，暂不支持英文。
- 确认首轮技术验证使用无人声伴奏。
- 多项可独立工作必须使用子 Agent 并行推进，由主 Agent 统一整合。
- 将 Synthesizer V Studio Pro 第一代适配基线固定为用户安装的 1.9.0。
- 用户暂无伴奏，第一轮改用可重复生成的项目自有无人声伴奏测试夹具。
