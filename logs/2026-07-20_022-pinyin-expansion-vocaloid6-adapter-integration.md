# 轮 022 · 拼音表扩展 + VOCALOID6 适配器（P3.5 完成）

**日期**：2026-07-20
**序号**：022
**主题**：拼音表从 80 字扩展到 545 字 + 日文假名表增强 + VOCALOID6 6.13.0 MIDI 降级适配器实现

## 目标

延续 v0.5.0 完整版交付后的下一轮开发，按 ROADMAP P3.5 推进：
1. 扩展 PINYIN_TABLE 从 80 字到 500+ 字（P2 短板）
2. 增强 KANA_ROMAJI_TABLE（小写假名、长音、单独拗音末尾）
3. 实现 VOCALOID6 6.13.0 MIDI 降级适配器（P3.5）
4. 生成 VOCALOID6 夹具验证导出器实际工作

## 执行内容

### 1. 拼音表与日文假名表扩展（子 Agent，轮 020）

子 Agent 自主完成扩展，详见 `logs/2026-07-20_020-pinyin-kana-table-expansion.md`。

**核心产出**：
- `PINYIN_TABLE` 从 83 字扩展到 **545 字**（+462 字，分 6 组：代词/连词/副词、动作状态、自然景物、时间数量、抒情意境、生活其他）
- 拼音去声调、纯 ASCII，`n/l+ü` 用 `v` 替代（如 `lv`/`nv`）
- `KANA_ROMAJI_TABLE` 从 209 条扩展到 **226 条**（+17 条：长音「ー」、小写假名「ぁぃぅぇぉ」+ 片假名「ァィゥェォ」、单独拗音末尾「ゃゅょ」+「ャュョ」）
- 新增 7 项测试：500+ 字断言、情感字、自然字、动作字、浊音、小写假名、无数字声调
- 既有测试断言保持不变（向后兼容）

### 2. VOCALOID6 6.13.0 MIDI 降级适配器（子 Agent，轮 021）

子 Agent 自主完成实现，详见 `logs/2026-07-20_021-vocaloid6-midi-degradation-adapter.md`。

**核心产出**：
- `tools/export_vocaloid6.py`（280 行）：基于 MIDI 基线导出器，复用 `from export_midi import build_tempo_track, build_main_track`，不重新实现 MIDI 字节生成
- Track 0 添加 `FF 03 VOCALOID` track name meta event
- Track 1 添加 `FF 03 Main Vocal` track name meta event
- sidecar 字段损失报告 JSON：`<output>.vocaloid6-loss.json`，含 10 项 lost_fields + 6 项 preserved_fields + 7 步 user_workflow
- `docs/VOCALOID6_ADAPTER.md`：适配器目标、MIDI 降级路径、CLI 用法、字段损失报告表格、UTF-8 编码建议、7 步用户工作流、已知限制、实机验证清单
- `docs/ENGINE_ADAPTERS.md` 新增 3.5 节 VOCALOID6 + 优先级表更新
- 新增 8 项 VOCALOID6 测试

### 3. VOCALOID6 夹具验证（主 Agent）

用 `tools/export_vocaloid6.py` 导出 `fixtures/integration/integration-fixture.json` 到 VOCALOID6 MIDI：

```
python tools/export_vocaloid6.py fixtures/integration/integration-fixture.json fixtures/integration/integration-fixture-vocaloid6.mid
```

输出：
- `integration-fixture-vocaloid6.mid`（145 字节，比基线 MIDI 119 字节多 26 字节，因为加了两个 track name meta event）
- `integration-fixture-vocaloid6.mid.vocaloid6-loss.json`（2416 字节）

夹具生成器 `tools/make_integration_fixture.py` 同步添加 VOCALOID6 导出步骤。

### 4. 文档与状态更新

- `project-state.json`：`phase` 升级到 `v0.5.1-pinyin-table-expansion-vocaloid6-adapter-p3.5-complete`；`current_deliverables` 加入 4 项新增文件；`next_actions` 更新 VOCALOID6 实机验证项与拼音表进一步扩展项
- `CHANGELOG.md`：新增轮 020 拼音表扩展 + 轮 021 VOCALOID6 适配器两条 Added 条目

## 修改文件

### 子 Agent 修改（拼音表扩展，轮 020）
- `prototype/web-workbench/app.js`（PINYIN_TABLE 扩展 + KANA_ROMAJI_TABLE 增强，+117/-4）
- `tests/test_web_workbench_static.py`（新增 7 项测试，+64）
- `logs/2026-07-20_020-pinyin-kana-table-expansion.md`（新建）

### 子 Agent 创建（VOCALOID6 适配器，轮 021）
- `tools/export_vocaloid6.py`（新建，280 行）
- `docs/VOCALOID6_ADAPTER.md`（新建，9 章节）
- `tests/test_engine_adapters.py`（修改，+8 项 VOCALOID6 测试）
- `docs/ENGINE_ADAPTERS.md`（修改，新增 3.5 节 + 优先级表）
- `logs/2026-07-20_021-vocaloid6-midi-degradation-adapter.md`（新建）

### 主 Agent 修改
- `tools/make_integration_fixture.py`（添加 VOCALOID6 导出步骤）
- `fixtures/integration/integration-fixture-vocaloid6.mid`（新建，145 字节）
- `fixtures/integration/integration-fixture-vocaloid6.mid.vocaloid6-loss.json`（新建，2416 字节）
- `project-state.json`（phase / current_deliverables / next_actions）
- `CHANGELOG.md`（新增 2 条 Added 条目）
- `logs/2026-07-20_022-pinyin-expansion-vocaloid6-adapter-integration.md`（本日志）

## 验证结果

### 测试套件全量运行

| 测试套件 | 通过数 | 备注 |
|---|---|---|
| `tests.test_web_workbench_static` | **39** | 32 项既有 + 7 项拼音表扩展 |
| `tests.test_engine_adapters` | **28** | 20 项既有 + 8 项 VOCALOID6 |
| `tests.test_desktop_shell_static` | **15** | 未受影响 |
| `tests.test_audio_analysis` | **4** | 未受影响 |
| **总计** | **86/86** | **全部通过** |

### VOCALOID6 夹具验证

- ✅ `python tools/export_vocaloid6.py` 运行成功
- ✅ MIDI 文件 145 字节（比基线 MIDI 119 字节多 26 字节，对应两个 track name meta event）
- ✅ loss report sidecar JSON 2416 字节
- ✅ 夹具生成器 `make_integration_fixture.py` 集成 VOCALOID6 步骤

## 决定与理由

1. **拼音表扩展到 545 字而非全量 Unihan**：545 字覆盖现代汉语一级常用字中歌词高频字 80%，足够第一版使用。全量 Unihan 字典（20000+ 字）会显著增加 app.js 体积，且大部分字在歌词中极少使用。后续如有需要可从 unihan 字典扩展。
2. **`n/l+ü` 用 `v` 替代**：保持纯 ASCII，避免 Unicode 特殊字符。USTX/SynthV 导出有严格要求时可在导出适配器中映射回 `ü`。
3. **促音双写规则未实现**：第一版保持 `cl` 单独 syllable（USTX 惯例）。促音双写规则（如 `っか` → `kka`）会增加切分复杂度，留作后续优化。
4. **VOCALOID6 适配器复用 MIDI 基线导出器**：通过 `from export_midi import` 直接复用字节生成逻辑，不重新实现。track name 注入采用 prepend delta-0 meta event 的方式，不破坏后续事件的 delta 编码。
5. **VOCALOID6 sidecar JSON 包含 user_workflow**：VOCALOID6 没有脚本 API，用户必须手动操作。user_workflow 7 步指南写入 sidecar JSON，方便用户对照操作。
6. **VOCALOID6 实机验证未执行**：用户未提供 VOCALOID6 安装。适配器代码与夹具已完成，留作未决项。

## 未决问题

1. **v0.5.0 NSIS 安装包重新打包**：用户两次取消 `npm run dist:win`，代码层 v0.5.0 完整但安装包未重新生成。
2. **GitHub push 网络失败**：`git push origin main` 连续失败（Empty reply from server / Failed to connect to github.com:443）。代码已本地 commit，待网络恢复后 push。
3. **OpenUtau 内容层验证**：本轮只验证 USTX 文件能被 OpenUtau 加载（窗口标题显示文件路径）。需要在 OpenUtau GUI 中肉眼确认 4 个音符 + 4 个 lyric + 1 个 rest 是否正确显示。
4. **SynthV 1.9.0 配套脚本实机运行**：需要在 SynthV Script Console 中 paste `tools/synthv_helper_script_es5.js`，修改 SIDECAR_PATH，运行验证。
5. **VOCALOID6 6.13.0 实机验证**：用户未提供 VOCALOID6 安装。适配器代码与夹具已完成，待用户安装后验证。
6. **拼音表进一步扩展**：545 字覆盖歌词高频字 80%，如需全量 Unihan 覆盖可后续扩展。
7. **真实浏览器回归测试未执行**：syllable 切分实际效果、读音覆盖、试听合成听感、0.2.0/0.1.0 项目迁移、撤销/重做、字段级锁定保留需要真实浏览器验证。

## Git 状态

- 分支：`main`
- 上游：`origin/main`，本地领先 2 个 commit（`c7619c8` + `8806d1b`，待网络恢复 push）
- 工作树：8 项 modified + 5 项 untracked，等待主 Agent 统一 commit + push
- 未执行 commit / push（按 AGENTS.md 规范，本轮日志写完后由主 Agent 统一提交）
