# 外部能力调研

核对日期：2026-07-20。这里只记录对架构有影响的事实，不代表最终选型。

## 音频分析候选

- [librosa 官方文档](https://librosa.org/doc/latest/beat.html)提供节拍/速度分析；其特征模块可计算色度等音乐特征，显示模块支持频谱和色度图。适合做基础分析验证，但不能把单一算法结果当成正确答案。
- [Spotify Basic Pitch 官方仓库](https://github.com/spotify/basic-pitch)可将音频转成带弯音的 MIDI，支持复音输入，但官方说明它在单一乐器上效果最好。因此它适合作为候选转录器，不适合直接承诺任意混音的准确主旋律。
- [Demucs 官方仓库](https://github.com/facebookresearch/demucs)可分离人声、鼓、贝斯和其他部分，但原仓库已说明不再积极维护。若采用源分离，需要在技术验证中比较仍在维护的实现，并单独检查模型许可证、体积和硬件成本。
- [Essentia 官方文档](https://essentia.upf.edu/)包含节奏、调性、和弦等音乐信息检索算法，可作为分析准确率和部署可行性的候选对照。

## 歌声编辑器接入事实

- [OpenUtau 官方仓库](https://github.com/stakira/openutau)是开源歌声编辑器，提供编辑宏和音素器插件 API，并支持导入 VSQX。它适合用来验证开放适配器路线。
- [VOCALOID6 官方规格](https://www.vocaloid.com/en/vocaloid6/specs/)显示其可读取 VPR、VSQX 和 MIDI，写出 VPR 和 MIDI。第一版可以使用 MIDI 做基础交换，但高级参数能否保留需要逐项验证。
- [Synthesizer V Studio 2 Pro 官方页面](https://www.dreamtonics.com/synthesizerv/)说明其支持 MIDI 导入；[官方脚本手册](https://resource.dreamtonics.com/scripting/)说明脚本可以访问音符、参数、音组和轨道。它适合在基础文件交换后增加脚本增强适配。

## 名称与第三方权利

- Crypton 官方资料说明“初音ミク”为其角色和软件名称，相关 EULA 也标明它是注册商标。
- [Piapro 角色许可摘要](https://piapro.jp/license/pcl/summary)主要面向符合条件的角色二次创作，不应自动推定它许可第三方软件以相关名称进行商业发布。

因此当前名称只作为工作名称。公开品牌、角色图像、声库内容、示例歌曲和商业用途必须分别审查；本文不是法律意见。

## 待验证问题

- 首个目标编辑器及其版本。
- 各目标格式能否保存音素、音高曲线、力度、呼吸和声库特有参数。
- Windows 上各音频分析依赖的安装体积、CPU/GPU 速度和离线打包方式。
- 中文、日文、英文歌词切分与目标声库发音系统之间的映射。
