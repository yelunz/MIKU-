# 外部能力调研

核对日期：2026-07-20。这里只记录对架构有影响的事实，不代表最终选型。

## 音频分析候选

- [librosa 官方文档](https://librosa.org/doc/latest/beat.html)提供节拍/速度分析；其特征模块可计算色度等音乐特征，显示模块支持频谱和色度图。适合做基础分析验证，但不能把单一算法结果当成正确答案。
- [Spotify Basic Pitch 官方仓库](https://github.com/spotify/basic-pitch)可将音频转成带弯音的 MIDI，支持复音输入，但官方说明它在单一乐器上效果最好。因此它适合作为候选转录器，不适合直接承诺任意混音的准确主旋律。
- [Demucs 官方仓库](https://github.com/facebookresearch/demucs)可分离人声、鼓、贝斯和其他部分，但原仓库已说明不再积极维护。若采用源分离，需要在技术验证中比较仍在维护的实现，并单独检查模型许可证、体积和硬件成本。
- [Essentia 官方文档](https://essentia.upf.edu/)包含节奏、调性、和弦等音乐信息检索算法，可作为分析准确率和部署可行性的候选对照。

## 歌声编辑器接入事实

- [OpenUtau 官方仓库](https://github.com/stakira/openutau)是开源歌声编辑器。截至 2026-07-20，[0.1.565](https://github.com/openutau/OpenUtau/releases/tag/0.1.565)是 GitHub 标记的最新稳定版，0.1.568 Beta 是预发布版。“最新版”在本项目中指每次验证时的最新版稳定发布，并必须把实际版本固定到测试记录。
- [官方安装说明](https://github.com/openutau/OpenUtau/wiki/Install)提供 Windows、macOS、Linux 版本。首版适配基线为官方公开的 [USTX 0.6 文件格式](https://github.com/openutau/OpenUtau/wiki/USTX-file-format)：UTF-8/YAML 文本可保存速度、拍号、轨道、歌词、音符、音高点、颤音、音素覆盖、参数曲线和伴奏引用，适合由中立项目模型直接生成。
- OpenUtau 可导入 USTX、UST、VSQX、MIDI、UFDATA、MusicXML，并可保存 USTX、导出 UST/MIDI/WAV；VSQX 不是双向输出桥。Phonemizer API 官方标注为实验性且可能变化，所以首版不依赖插件，只把插件作为后续增强。[官方入门说明](https://github.com/openutau/OpenUtau/wiki/Getting-Started)、[官方 API 说明](https://github.com/openutau/OpenUtau/blob/master/OpenUtau.Core/Api/README.md)
- VOCALOID 的工程格式和扩展能力随代际变化：V3/V4 使用 VSQX，V5/V6 使用 VPR；V3/V4 有 Job Plugin，V5/V6 已取消。V6 官方可读取 VPR、VSQX、MIDI并写出 VPR、MIDI，但这不能外推为所有版本能力。[VOCALOID6 官方规格](https://www.vocaloid.com/en/vocaloid6/specs/)、[V6 Job Plugin FAQ](https://www.vocaloid.com/en/support/faq/614)、[VOCALOID5 官方参考手册](https://rsc-net.vocaloid.com/assets/pdf_files/VOCALOID5_Reference_Manual_ENG.pdf)
- MIDI 是未知 VOCALOID 版本时的保守交换基线，但不同代际不能保证歌词、音素、音高曲线或厂商参数。V6 到 6.2 才明确支持识别 MIDI 内嵌歌词，所以不能把带歌词 MIDI 当成所有版本的可靠通道。用户确认版本后，适配器按 `vocaloid/{major}/{editor-flavor}` 建立能力表和真实编辑器验收样例。[V6 MIDI 导出 FAQ](https://www.vocaloid.com/en/support/faq/636)、[V4 MIDI 导入边界](https://www.vocaloid.com/en/support/faq/308)
- VOCALOID3/4 独立编辑器仅 Windows；VOCALOID5/6 支持 Windows、macOS；官方编辑器没有 Linux 版本。Linux 上只准备和检查交换文件，不承诺本机打开官方编辑器。[V3 平台要求](https://www.vocaloid.com/en/support/faq/586)、[V4 平台要求](https://www.vocaloid.com/en/support/faq/585)、[V5 平台要求](https://www.vocaloid.com/en/support/faq/711)
- [Synthesizer V Studio Pro 第一代官方手册](https://sv1.docs.dreamtonics.com/)覆盖 1.x 工作流；[官方产品比较](https://www.dreamtonics.com/synthesizerv/)列明第一代支持 Windows、macOS、Linux。[第一代插件手册](https://sv1.docs.dreamtonics.com/en/synthv/plugins/instrument)同时说明插件只支持 Windows/macOS，Linux 安装程序不包含插件。因此 Linux 适配只能把第一代作为独立应用，不能承诺 VST3、AU、AAX 或 ARA 集成。
- 第一代工程文件为 `.svp`，但官方没有公开稳定的内部格式规范。本项目不直接生成或修改 `.svp`；基础适配使用官方支持的 MIDI 交换，高保真路径使用在用户实际 1.x 版本上验证过的配套脚本。[第一代项目手册](https://sv1.docs.dreamtonics.com/en/synthv/basic-usage/project)还说明“Import as Tracks”不会导入速度数据，因此适配器必须额外处理或提示速度图。
- [第一代官方脚本说明](https://sv1.docs.dreamtonics.com/en/synthv/advanced-usage/scripts)确认 Pro 版支持 JavaScript 和 Lua 脚本。当前在线 API 参考已经包含第二代新增内容，不能把所有现有接口自动视为 1.x 能力；首轮必须读取用户确切版本并做最小实机验证。

## 名称与第三方权利

- Crypton 官方资料说明“初音ミク”为其角色和软件名称，相关 EULA 也标明它是注册商标。
- [Piapro 角色许可摘要](https://piapro.jp/license/pcl/summary)主要面向符合条件的角色二次创作，不应自动推定它许可第三方软件以相关名称进行商业发布。

因此当前名称只作为工作名称。公开品牌、角色图像、声库内容、示例歌曲和商业用途必须分别审查；本文不是法律意见。

## 待验证问题

- 用户安装的 Synthesizer V Studio Pro 1.x 确切版本，以及该版本可用的脚本 API 子集。
- 用户希望优先支持的 VOCALOID 官方编辑器具体版本和编辑器形态；现有 VOCALOID6 资料只是一项调研事实，不代表目标已经锁定为第六代。
- 各目标格式能否保存音素、音高曲线、力度、呼吸和声库特有参数。
- Windows、macOS、Linux 上各音频分析依赖的安装体积、CPU/GPU 速度和离线打包方式。
- 中文、日文歌词切分与目标声库发音系统之间的映射；英文不在首版范围内。
