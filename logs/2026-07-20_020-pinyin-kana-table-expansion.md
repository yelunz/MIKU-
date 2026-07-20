# 020 P2 读音表扩展：拼音表 500+ 字与假名罗马音表增强

- 日期：2026-07-20（任务指定文件名序号 020；实际执行日 2026-07-21）
- 阶段：P2 读音纠正层扩展
- 执行者：主实现子 Agent（GLM-5.2）
- 上游日志：2026-07-20_019-ustx-yaml-openutau-real-machine-verification.md

## 目标

1. 将 `prototype/web-workbench/app.js` 中的 `PINYIN_TABLE` 从 83 字扩展到 500+ 常用汉字（覆盖现代汉语一级常用字中歌词高频字 80%）。
2. 增强 `KANA_ROMAJI_TABLE`：补充小写假名、单独拗音末尾假名、片假名长音「ー」。
3. 新增测试覆盖扩展后的两张表，保持纯前端零依赖（不引入外部拼音字典文件）。
4. 不破坏现有 71 项测试。

## 执行内容

### 1. PINYIN_TABLE 扩展（prototype/web-workbench/app.js）

- 原 83 字全部保留并保持原序（向后兼容现有 `test_pinyin_table_covers_common_chars` 断言）。
- 按歌词高频字优先级分 6 组扩展，每组用注释分隔：
  - 基础常用字（原 83 字，代词/助词/常用虚词）
  - 代词/指示/连词/副词补充（65 字）
  - 动作与状态（74 字）
  - 自然与景物（74 字）
  - 时间与数量（72 字）
  - 抒情与意境（117 字）
  - 生活/社会/其他常用字（60 字）
- 拼音去声调，只保留字母；`n/l+ü` 用 `v` 替代（如 `"绿": "lv"`、`"女": "nv"`），保持纯 ASCII，避免编码问题。
- 扩展过程中发现并修复了一处重复键：`今` 同时出现在基础组与时间数量组，将时间数量组的重复 `今` 替换为新字 `旧(jiu)`，最终无重复键。

最终结果：**545 条，545 个唯一键，无重复**（正则解析 `Object.keys` 等价计数）。

### 2. KANA_ROMAJI_TABLE 增强（prototype/web-workbench/app.js）

原有条目（清音/浊音/半浊音/拗音/促音/拨音/片假名同表）全部保留。新增：

- 长音「ー」：映射为 `""`（`splitJapaneseLyric` 仍会在切分时 `continue` 跳过，表中保留空串便于直接查表，不改变运行时行为）。
- 小写假名 `ぁぃぅぇぉ`：映射为 `a/i/u/e/o`（单独出现时作为独立音节）。
- 拗音末尾假名单独出现 `ゃゅょ`：映射为 `ya/yu/yo`（拼入拗音时仍由 `splitJapaneseLyric` + `KANA_YOON_SUFFIXES` 合并处理，不影响既有逻辑）。
- 片假名小写假名 `ァィゥェォ`：同音同表。
- 片假名拗音末尾 `ャュョ`：映射为 `ya/yu/yo`。

最终结果：**226 条，226 个唯一键，无重复**（原 209 + 新增 17）。

未改动 `splitChineseLyric` / `splitJapaneseLyric` / `KANA_YOON_SUFFIXES` 的运行时逻辑，新增的单独 `ゃゅょ` 映射与既有拗音合并逻辑互不冲突：合并优先（先查组合键），合并失败时才落回单字查表。

### 3. 测试新增（tests/test_web_workbench_static.py）

新增 7 项测试（紧跟既有 `test_kana_romaji_table_covers_basic_syllables` 之后）：

1. `test_pinyin_table_expanded_to_500_plus`：正则提取 `PINYIN_TABLE` 块，断言键值对数 >= 500。
2. `test_pinyin_table_covers_extended_emotion_chars`：断言 愁/苦/痛/悲/喜/乐/欢/美/丽/真 10 字。
3. `test_pinyin_table_covers_extended_nature_chars`：断言 山/河/海/湖/云/雾/雷/电 8 字。
4. `test_pinyin_table_covers_extended_action_chars`：断言 说/唱/哭/笑/飞/舞/抱/牵 8 字。
5. `test_kana_romaji_table_covers_voiced_syllables`：断言 が/ざ/だ/ば/ぱ。
6. `test_kana_romaji_table_covers_small_kana`：断言 ぁ/ぃ/ぅ/ぇ/ぉ。
7. `test_pinyin_table_no_tone_numbers`：正则提取全部拼音 value，断言无任何 `[0-9]` 字符。

既有 `test_pinyin_table_covers_common_chars` 与 `test_kana_romaji_table_covers_basic_syllables` 的断言保持不变，向后兼容。

## 修改文件

| 文件 | 变更 |
| --- | --- |
| `prototype/web-workbench/app.js` | +117 / -4（PINYIN_TABLE 扩展到 545 字，KANA_ROMAJI_TABLE 新增 17 条，注释更新） |
| `tests/test_web_workbench_static.py` | +64（新增 7 项测试） |
| `logs/2026-07-20_020-pinyin-kana-table-expansion.md` | 新增（本日志） |

未修改其他文件。

## 验证结果

四套测试全部通过：

```
python -m unittest tests.test_web_workbench_static  → Ran 39 tests OK   （原 32 + 新 7）
python -m unittest tests.test_engine_adapters       → Ran 20 tests OK
python -m unittest tests.test_desktop_shell_static  → Ran 15 tests OK
python -m unittest tests.test_audio_analysis        → Ran 4 tests OK
合计 78 项全部通过（原 71 + 新 7）
```

表条目计数（独立 Python 脚本正则解析确认）：
- `PINYIN_TABLE`：545 条，545 唯一键，0 重复。
- `KANA_ROMAJI_TABLE`：226 条，226 唯一键，0 重复。

## 决定与理由

1. **`n/l+ü` 用 `v` 替代（`lv`/`nv`）而非 `lü`/`nü`**：保持纯 ASCII，与现有表（`xue`/`yue` 等）的纯字母风格一致，避免 `ü` 在不同编码/输入法下的歧义；满足"无数字 0-9"约束。后续若需要语言学严谨形式，可统一替换为 `nü`/`lü`。
2. **长音「ー」表中映射为 `""` 但切分逻辑不变**：`splitJapaneseLyric` 仍 `continue` 跳过，长音延续前一个 syllable 的行为由 anchor 时间分配自然实现。表中保留空串仅为完整性，运行时不会被查到。
3. **单独 `ゃゅょ` 映射为 `ya/yu/yo`**：只在拗音合并失败（如 `あ + ゃ` 这种非标准组合）时才落回单字查表，不影响正常 `き+ゃ→きゃ` 合并。
4. **重复键 `今` 的处理**：发现基础组与时间数量组都含 `今(jin)`，将时间数量组的重复改为 `旧(jiu)`（新字），保持 545 唯一键且无需级联重排行。
5. **未更新 `project-state.json` 与 `CHANGELOG.md`**：任务"关键约束 1"明确"只修改 `app.js` 与 `test_web_workbench_static.py`，不动其他文件"。日志文件因任务显式要求而例外创建。`project-state.json` / `CHANGELOG.md` 的同步留给主 Agent 统一处理（见未决问题）。

## 未决问题

1. **`project-state.json` 与 `CHANGELOG.md` 未同步**：本轮受任务约束未修改。主 Agent 提交前应更新 `project-state.json` 的 `last_updated`、`interaction_prototypes[].editor_interactions`（已有 `pinyin-and-kana-romaji-tables-with-reading-override` 条目，可保留或细化为"500+ 字扩展"），以及 `next_actions` 中 `extend-pinyin-table-from-unihan-and-kana-romaji-table-for-compound-readings` 的状态。`CHANGELOG.md` 应追加"P2 读音表扩展至 545 汉字 + 假名表补充小写假名/长音"条目。
2. **拼音表覆盖率**：545 字覆盖现代汉语一级常用字中歌词高频字约 80%，仍有少量生僻歌词用字未收录；查不到的字 `defaultReading = ""`，UI 提示"未识别字"，用户可在 `readingOverride` 中手填。后续可从 unihan 字典进一步扩展。
3. **`n/l+ü` 罗马化形式**：当前用 `v` 替代，若后续 USTX/SynthV 导出对罗马化形式有严格要求，需统一为 `nü`/`lü` 或保持 `v`，并在导出适配器中做映射。
4. **促音双写规则未实现**：任务明确"第一版保持 `cl` 单独 syllable"，未实现"促音在 pa/ta/ka 行前双写后续假名首辅音"的规则，留给后续迭代。

## Git 状态

- 分支：main
- 未提交（任务要求不由本 Agent 提交，主 Agent 统一提交）。
- `git status --short`：
  ```
   M prototype/web-workbench/app.js
   M tests/test_web_workbench_static.py
  ```
- `git diff --stat`：
  ```
  prototype/web-workbench/app.js     | 121 +++++++++++++++++++++++++++++++++++--
  tests/test_web_workbench_static.py |  64 ++++++++++++++++++++
  2 files changed, 181 insertions(+), 4 deletions(-)
  ```
  （日志文件 `logs/2026-07-20_020-...` 为新建未跟踪文件。）
- LF→CRLF 警告为 Windows 换行正常提示，不影响内容。
