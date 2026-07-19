# 2026-07-20 / 004 / 固定编辑器版本并建立测试伴奏

## 本轮目标

固定 Synthesizer V 的实际版本，选择稳定且兼容范围广的 VOCALOID 目标，并在用户暂无伴奏时建立项目自有的第一轮测试音频。

## 用户确认的要求

- 用户现有 Synthesizer V Studio Pro 第一代版本为 1.9.0。
- VOCALOID 具体版本由项目根据使用覆盖面和稳定性选择。
- 用户暂时没有可提供的无人声伴奏。
- OpenUtau 不能被遗漏或因新增 VOCALOID 而降低优先级。

## 子 Agent 分工与结论

- `synthv_190_impact`：只读核对 Dreamtonics 官方资料，确认应建立独立的 1.9.0 档案；1.9.0 三平台支持独立版、Linux 无插件，ARA 与 Voice-to-MIDI 不属于 1.9.0；1.10+ 普通工程需要另存为 1.9.0 兼容副本。
- `vocaloid_target_choice`：核对官方维护、兼容和支持状态。没有可信版本用户数，不能宣称某一代用户最多；推荐当前官方维护且向后读取范围最广的 VOCALOID6 Editor 完整版 6.13.0（Standalone）。
- `test_fixture_design`：设计并创建 `basic-c-major-120-v1` 的生成器、标准答案和说明。子 Agent 因系统 `python.exe` 不可执行未完成生成验证，主 Agent 使用 Codex 内置 Python 接管。

## 执行内容

- 将 Synthesizer V 主适配基线从 1.x 固定为 1.9.0 final。
- 设计 `midi-baseline`、`midi-plus-helper-script`、`ust-group-fallback` 三层 1.9.0 路线，禁止直接写 `.svp`。
- 选择 `vocaloid/6/standalone` 6.13.0 完整版为 VOCALOID 主目标；旧版本只提供 MIDI 降级路径和字段损失报告。
- 再次固化 OpenUtau 首批优先级：USTX 0.6 是首个端到端工程导出验收，并要求三平台打开。
- 建立只使用 Python 标准库的 50 秒确定性无人声伴奏生成器和真值文件。
- 首次渲染发现 Intro→A 和 A→B 能量差未达到设计的 3 dB；主 Agent 增加真值驱动的固定段落增益和自动能量校验后重新生成。
- 将 9.6 MB WAV 和渲染清单保存在 Git 忽略的 `fixtures/.generated/`，仓库只提交可复现源码和标准答案。

## 修改文件

- `.gitignore`
- `README.md`
- `AGENTS.md`
- `CHANGELOG.md`
- `project-state.json`
- `docs/PRODUCT_DEFINITION.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/RESEARCH_NOTES.md`
- `fixtures/basic-c-major-120-v1/generate.py`
- `fixtures/basic-c-major-120-v1/ground-truth.json`
- `fixtures/basic-c-major-120-v1/README.md`
- `logs/2026-07-20_004-editor-versions-and-test-fixture.md`

## 验证

- 生成器通过 Python 语法检查，仅使用标准库。
- 生成与内置验证成功：50.0 秒、48,000 Hz、16-bit、双声道、2,400,000 帧/声道，前导 1 秒为数字零。
- 当前 WAV SHA-256：`160de5896fff7379fe7fb3d32961b20ac935ec6251d60f25bb98453d38fc35d1`。
- 峰值为 -1.0002 dBFS；Intro→A 能量差 5.5648 dB，A→B 能量差 6.5278 dB，均超过 3 dB 验收线；Outro 低于 A，B 的频谱质心高于 Intro。
- `--verify-only` 再验证成功。
- 尚未在 Windows、macOS、Linux 三台真实机器比较 WAV SHA，也尚未运行节拍/和弦/段落分析算法。

## 决定与理由

- VOCALOID 选择 6.13.0 的依据是当前官方维护、最新稳定更新和向后读取能力，不使用无法证实的用户数量作为事实。
- OpenUtau 保持首个端到端工程适配，VOCALOID 是新增后续适配，不替代 OpenUtau。
- 测试素材由项目确定性合成，避免版权、外部链接失效和随机生成导致回归不可复现。
- 生成音频不进 Git，避免仓库膨胀；源码、真值和清单验证逻辑足以让其他 Codex 立即重建。

## 未决问题 / 下一步

- 使用该夹具运行第一轮波形、频谱、节拍、小节、调性、和弦与段落分析技术验证。
- 制作时间轴交互线框图。
- 在 Synthesizer V 1.9.0 实机验证 MIDI、速度图和辅助脚本。
- 获得 VOCALOID6 6.13.0 完整版测试环境后验证 MIDI 与歌词编码。

## Git 状态

- 分支：`main`，上游为 `origin/main`。
- 本日志创建时存在本轮文档、生成器和夹具真值修改，待最终检查后提交并推送。
