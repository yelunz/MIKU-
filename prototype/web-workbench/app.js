"use strict";

(() => {
  // 项目与分析 schema。当内部数据结构发生破坏性变化时，PROJECT_SCHEMA 递增；
  // 旧版本必须能在导入时显式迁移，避免静默覆盖用户工作。
  // P2：0.3.0 在 0.2.0 基础上新增 syllables（歌词音节切分）+ vocalPreview（试听合成）。
  //   - 0.2.0 项目导入时为已有歌词区域派生默认 syllables（保留所有 0.2.0 能力）。
  //   - 0.1.0 项目仍可通过 migrateLegacyProject 迁移到 0.3.0（含 syllables 派生）。
  const PROJECT_SCHEMA = "miku-workbench-project/0.3.0";
  const PROJECT_SCHEMA_LEGACY = "miku-workbench-project/0.1.0";
  const PROJECT_SCHEMA_LEGACY_020 = "miku-workbench-project/0.2.0";
  const ANALYSIS_SCHEMA = "0.1.0";
  const PPQ = 960;
  // sample 是音频定位的权威基准。当 sample 与 tick 出现数值漂移时以 sample 为准。
  const ANCHOR_TOLERANCE_SECONDS = 0.005;

  const bridge = globalThis.MikuDesktopBridge;
  const state = {
    analysis: null,
    duration: 0,
    sampleRateHz: 48000,
    tempoMap: null,
    anchors: new Map(),
    lyrics: [],
    rests: [],
    audioUrl: null,
    audioFileName: null,
    audioDuration: null,
    audioSha256: null,
    audioHashSkipped: false,
    selection: { start: 0, end: 0 },
    chordOverrides: {},
    selectedChordKey: null,
    selectedLyricId: null,
    selectedRestId: null,
    zoom: 16,
    snapMode: "half-beat",
    // P1.2 轮 3：附点与 Swing 扩展。附点把当前网格拉长 1.5 倍；
    // Swing 在偶数细分网格上把第二个半段延迟，比例 0..0.7。
    dottedSnap: false,
    swingAmount: 0,
    continuousLyrics: true,
    layers: { waveform: true, energy: true, beats: true, sections: true, chords: true },
    dragging: null,
    handleDragging: null,
    edgeDragging: null,
    nextLyricId: 1,
    nextRestId: 1,
    nextAnchorId: 1,
    // 歌词块整体拖动/拉伸状态。拖动阈值超过 4 像素才进入拖动模式，
    // 否则保留原点击行为（进入编辑器）。
    lyricDrag: null,
    // 字段级锁定：防止未来重生成覆盖用户手工确认的字段。
    // 格式 "lyric:lyric-1" / "rest:rest-1" / "chord:<chordKey>"。
    lockedFields: new Set(),
    // 用户最近一次手动滚动时间戳。播放头自动跟随在用户滚动后暂停 1.5 秒，
    // 避免抢走用户的主动定位。
    manualScrollAt: 0,
    // 程序触发的滚动标记。autoScrollToPlayhead 修改 scrollLeft 时设为 true，
    // scroll 事件据此区分"程序滚动"与"用户滚动"。
    programmaticScroll: false,
    // 多轨 stem 轨数据模型（P1.2 轮 1）。
    // 第一版采用非破坏编辑：原始音频永不覆盖；mute/solo/gain/pan 只保存参数。
    // master stem 关联主 audio 元素，gain/pan/mute/solo 通过 Web Audio API 真实生效；
    // drums/bass/other 是占位 stem（无分离音频），只保存参数与展示 UI，
    // 等 Demucs 等音源分离后端接入后才会真实播放。
    stemTracks: defaultStemTracks(),
    // P1.2 轮 4：A/B 试听模式。"edited" 应用 trim/fade 等非破坏参数；
    // "original" 忽略所有非破坏参数（仍保留 gain/pan/mute/solo）。
    // 没有真实重合成后端，"original" 等同于"忽略非破坏混音参数的原始音频"。
    stemPreviewMode: "edited",
    // NoteEvent 数据模型（P1.2 轮 2）：可编辑的音符候选。
    // 每个音符引用 start/end anchor（与歌词/休止共享时间模型），
    // 浮点 MIDI pitch（60 = C4），velocity 0..1，confidence 0..1，
    // source 标注来源（manual / transcription / generation）。
    // 第一版没有真实转录后端，所有音符都是用户手工创建或后续从 Basic Pitch 等后端导入。
    notes: [],
    nextNoteId: 1,
    selectedNoteId: null,
    // 钢琴卷帘拖动状态：{ noteId, mode, startClientX, startClientY, startStartSample, startEndSample, startPitch, beganEdit, detachedStart, detachedEnd }
    noteDrag: null,
    // 钢琴卷帘当前选中的 stem 轨（决定新音符创建在哪个 stem）。
    pianoRollStemId: "master",
    // 钢琴卷帘选中用于合并的第二个音符（按住 Shift 点击选中第二个 → 合并按钮可用）。
    pianoRollMergeCandidateId: null,
    // P2：歌词音节切分。每个 syllable 引用所属 lyric 区域 + start/end anchor（共享时间模型）。
    // text 是单字（中文）或单假名/音节（日文）；readingOverride 是用户覆盖的读音（空表示用默认读音）。
    // 切分由 splitLyricToSyllables 派生；用户可锁定防止重生成覆盖。
    syllables: [],
    nextSyllableId: 1,
    selectedSyllableId: null,
    // P2：试听合成状态。oscillators 数组保存当前发声的 OscillatorNode，stopPreview 时全部停止。
    // scheduleIds 保存 setTimeout 句柄，便于在停止时清除未触发的调度。
    vocalPreview: { active: false, oscillators: [], startAt: 0, scheduleIds: [] },
    // P2：试听音色参数（不进入项目持久化，只保存在内存）。
    // waveform 限制为 OscillatorNode 支持的四种基础波形；gain/attack/release 控制包络。
    vocalPreviewTimbre: { waveform: "sine", gain: 0.15, attack: 0.02, release: 0.08 },
  };

  // 音高范围：C2 (36) .. C7 (96)，共 60 个半音。第一版用此固定范围。
  const PIANO_ROLL_MIN_PITCH = 36;
  const PIANO_ROLL_MAX_PITCH = 96;
  const PIANO_ROLL_ROW_HEIGHT = 14; // px

  function midiToNoteName(midi) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const octave = Math.floor(midi / 12) - 1;
    return `${names[((midi % 12) + 12) % 12]}${octave}`;
  }

  function isBlackKey(midi) {
    const within = ((midi % 12) + 12) % 12;
    return within === 1 || within === 3 || within === 6 || within === 8 || within === 10;
  }

  function defaultStemTracks() {
    return [
      { id: "master", name: "伴奏总览", role: "master", mute: false, solo: false, gain: 1.0, pan: 0, source: "main",
        // P1.2 轮 4：非破坏混音参数。trim 是首尾裁切秒数；fade 是淡入淡出秒数。
        // master stem 真实生效（通过 audioGraph 与 timeupdate 监听）；占位 stem 只保存参数。
        trimStartSeconds: 0, trimEndSeconds: 0, fadeInSeconds: 0, fadeOutSeconds: 0 },
      { id: "drums", name: "鼓组", role: "drums", mute: false, solo: false, gain: 1.0, pan: 0, source: "placeholder",
        trimStartSeconds: 0, trimEndSeconds: 0, fadeInSeconds: 0, fadeOutSeconds: 0 },
      { id: "bass", name: "贝斯", role: "bass", mute: false, solo: false, gain: 1.0, pan: 0, source: "placeholder",
        trimStartSeconds: 0, trimEndSeconds: 0, fadeInSeconds: 0, fadeOutSeconds: 0 },
      { id: "other", name: "其他乐器", role: "other", mute: false, solo: false, gain: 1.0, pan: 0, source: "placeholder",
        trimStartSeconds: 0, trimEndSeconds: 0, fadeInSeconds: 0, fadeOutSeconds: 0 },
    ];
  }

  // ---- P2 读音表 -------------------------------------------------------------
  // 设计：
  //   - 中文常用字拼音表（500+ 字，覆盖现代汉语一级常用字中歌词高频字）。
  //     defaultReading 去掉声调数字，只保留拼音字母；用户可在 readingOverride 中
  //     输入完整带声调的读音。n/l+ü 用 v 替代（如 "绿": "lv", "女": "nv"）。
  //   - 日文假名罗马音表（46 清音 + 浊音/半浊音 + 拗音 + 促音 + 拨音 + 小写假名
  //     + 片假名同音同表 + 长音「ー」映射为空）。
  //   - 查不到的字/假名 defaultReading = ""，UI 在读音纠正行提示"未识别字"。
  //   - 这是离线内嵌版本，后续可从 unihan/kana 字典扩展。
  const PINYIN_TABLE = {
    // === 基础常用字（代词/助词/常用虚词，原 83 字保持原序，向后兼容） ===
    "你": "ni", "好": "hao", "的": "de", "我": "wo", "是": "shi",
    "在": "zai", "他": "ta", "她": "ta", "一": "yi", "个": "ge",
    "有": "you", "不": "bu", "这": "zhe", "中": "zhong", "国": "guo",
    "人": "ren", "大": "da", "小": "xiao", "上": "shang", "下": "xia",
    "为": "wei", "来": "lai", "去": "qu", "说": "shuo", "唱": "chang",
    "歌": "ge", "心": "xin", "里": "li", "天": "tian", "空": "kong",
    "星": "xing", "光": "guang", "月": "yue", "亮": "liang", "风": "feng",
    "雨": "yu", "雪": "xue", "花": "hua", "草": "cao", "树": "shu",
    "爱": "ai", "情": "qing", "想": "xiang", "念": "nian", "梦": "meng",
    "春": "chun", "夏": "xia", "秋": "qiu", "冬": "dong", "早": "zao",
    "晚": "wan", "今": "jin", "明": "ming", "年": "nian", "前": "qian",
    "后": "hou", "左": "zuo", "右": "you", "外": "wai", "内": "nei",
    "多": "duo", "少": "shao", "很": "hen", "就": "jiu", "都": "dou",
    "也": "ye", "还": "hai", "再": "zai", "会": "hui", "能": "neng",
    "可": "ke", "以": "yi", "要": "yao", "把": "ba", "被": "bei",
    "让": "rang", "给": "gei", "到": "dao", "看": "kan", "听": "ting",
    "见": "jian", "走": "zou", "跑": "pao",
    // === 代词/指示/连词/副词补充 ===
    "它": "ta", "您": "nin", "自": "zi", "己": "ji", "此": "ci",
    "那": "na", "其": "qi", "余": "yu", "某": "mou", "各": "ge",
    "但": "dan", "而": "er", "并": "bing", "且": "qie", "或": "huo",
    "若": "ruo", "如": "ru", "似": "si", "比": "bi", "同": "tong",
    "与": "yu", "及": "ji", "共": "gong", "因": "yin", "故": "gu",
    "所": "suo", "由": "you", "从": "cong", "向": "xiang", "往": "wang",
    "将": "jiang", "已": "yi", "曾": "ceng", "正": "zheng", "才": "cai",
    "刚": "gang", "便": "bian", "即": "ji", "却": "que", "偏": "pian",
    "最": "zui", "更": "geng", "越": "yue", "颇": "po", "稍": "shao",
    "极": "ji", "甚": "shen", "太": "tai", "挺": "ting", "顶": "ding",
    "应": "ying", "该": "gai", "须": "xu", "需": "xu", "得": "de",
    "必": "bi", "务": "wu", "独": "du", "专": "zhuan", "沿": "yan",
    "顺": "shun", "达": "da", "至": "zhi", "望": "wang", "朝": "chao",
    // === 动作与状态 ===
    "哭": "ku", "笑": "xiao", "叫": "jiao", "喊": "han", "问": "wen",
    "答": "da", "读": "du", "写": "xie", "画": "hua", "弹": "tan",
    "拍": "pai", "打": "da", "拉": "la", "推": "tui", "拿": "na",
    "放": "fang", "丢": "diu", "捡": "jian", "找": "zhao", "寻": "xun",
    "遇": "yu", "离": "li", "别": "bie", "聚": "ju", "散": "san",
    "回": "hui", "归": "gui", "进": "jin", "出": "chu", "起": "qi",
    "落": "luo", "升": "sheng", "降": "jiang", "飞": "fei", "跳": "tiao",
    "舞": "wu", "游": "you", "躺": "tang", "坐": "zuo", "站": "zhan",
    "睡": "shui", "醒": "xing", "吃": "chi", "喝": "he", "呼": "hu",
    "吸": "xi", "叹": "tan", "气": "qi", "闻": "wen", "嗅": "xiu",
    "尝": "chang", "咬": "yao", "嚼": "jiao", "吞": "tun", "抱": "bao",
    "牵": "qian", "握": "wo", "摸": "mo", "抚": "fu", "亲": "qin",
    "吻": "wen", "拥": "yong", "靠": "kao", "依": "yi", "偎": "wei",
    "伴": "ban", "陪": "pei", "随": "sui", "跟": "gen", "追": "zhui",
    "逃": "tao", "躲": "duo", "藏": "cang", "露": "lu",
    // === 自然与景物 ===
    "山": "shan", "河": "he", "海": "hai", "湖": "hu", "江": "jiang",
    "水": "shui", "火": "huo", "土": "tu", "石": "shi", "云": "yun",
    "雾": "wu", "霜": "shuang", "冰": "bing", "冷": "leng", "热": "re",
    "温": "wen", "凉": "liang", "寒": "han", "暖": "nuan", "晨": "chen",
    "昏": "hun", "昼": "zhou", "夜": "ye", "夕": "xi", "曦": "xi",
    "暮": "mu", "辰": "chen", "宇": "yu", "宙": "zhou", "日": "ri",
    "阳": "yang", "阴": "yin", "晴": "qing", "雷": "lei", "电": "dian",
    "闪": "shan", "林": "lin", "森": "sen", "枝": "zhi", "叶": "ye",
    "根": "gen", "茎": "jing", "苗": "miao", "芽": "ya", "穗": "sui",
    "麦": "mai", "稻": "dao", "米": "mi", "谷": "gu", "豆": "dou",
    "瓜": "gua", "果": "guo", "梨": "li", "桃": "tao", "红": "hong",
    "黄": "huang", "蓝": "lan", "绿": "lv", "白": "bai", "黑": "hei",
    "紫": "zi", "灰": "hui", "粉": "fen", "橙": "cheng", "青": "qing",
    "赤": "chi", "翠": "cui", "碧": "bi", "苍": "cang", "茫": "mang",
    "荒": "huang", "沃": "wo", "肥": "fei", "瘦": "shou",
    // === 时间与数量 ===
    "秒": "miao", "分": "fen", "时": "shi", "刻": "ke", "钟": "zhong",
    "周": "zhou", "季": "ji", "岁": "sui", "载": "zai", "世": "shi",
    "纪": "ji", "古": "gu", "旧": "jiu", "昔": "xi", "初": "chu",
    "始": "shi", "终": "zhong", "末": "mo", "尾": "wei", "端": "duan",
    "头": "tou", "尖": "jian", "底": "di", "深": "shen", "浅": "qian",
    "高": "gao", "低": "di", "长": "chang", "短": "duan", "宽": "kuan",
    "窄": "zhai", "厚": "hou", "薄": "bo", "粗": "cu", "细": "xi",
    "二": "er", "三": "san", "四": "si", "五": "wu", "六": "liu",
    "七": "qi", "八": "ba", "九": "jiu", "十": "shi", "百": "bai",
    "千": "qian", "万": "wan", "亿": "yi", "零": "ling", "半": "ban",
    "两": "liang", "双": "shuang", "单": "dan", "几": "ji", "第": "di",
    "次": "ci", "遍": "bian", "场": "chang", "阵": "zhen", "段": "duan",
    "批": "pi", "组": "zu", "类": "lei", "种": "zhong", "样": "yang",
    "般": "ban", "式": "shi", "型": "xing", "形": "xing", "状": "zhuang",
    "态": "tai", "相": "xiang",
    // === 抒情与意境 ===
    "愁": "chou", "苦": "ku", "痛": "tong", "伤": "shang", "悲": "bei",
    "哀": "ai", "忧": "you", "恼": "nao", "怒": "nu", "恨": "hen",
    "悔": "hui", "愧": "kui", "惭": "can", "惶": "huang", "惑": "huo",
    "迷": "mi", "彷": "pang", "徨": "huang", "徘": "pai", "徊": "huai",
    "喜": "xi", "乐": "le", "欢": "huan", "欣": "xin", "悦": "yue",
    "愉": "yu", "畅": "chang", "舒": "shu", "适": "shi", "恬": "tian",
    "淡": "dan", "宁": "ning", "静": "jing", "和": "he", "平": "ping",
    "安": "an", "稳": "wen", "泰": "tai", "然": "ran", "定": "ding",
    "美": "mei", "丽": "li", "秀": "xiu", "娟": "juan", "娇": "jiao",
    "艳": "yan", "媚": "mei", "俏": "qiao", "俊": "jun", "英": "ying",
    "豪": "hao", "杰": "jie", "伟": "wei", "壮": "zhuang", "宏": "hong",
    "硕": "shuo", "博": "bo", "渊": "yuan", "真": "zhen", "假": "jia",
    "虚": "xu", "实": "shi", "幻": "huan", "醉": "zui", "痴": "chi",
    "狂": "kuang", "恋": "lian", "慕": "mu", "倾": "qing", "眷": "juan",
    "孤": "gu", "寂": "ji", "寞": "mo", "寥": "liao", "凄": "qi",
    "辽": "liao", "阔": "kuo", "广": "guang", "旷": "kuang", "远": "yuan",
    "近": "jin", "隔": "ge", "缘": "yuan", "份": "fen", "命": "ming",
    "运": "yun", "数": "shu", "理": "li", "道": "dao", "法": "fa",
    "意": "yi", "思": "si", "忆": "yi", "记": "ji", "忘": "wang",
    "识": "shi", "认": "ren", "谁": "shui", "何": "he", "什": "shen",
    "么": "me", "怎": "zen", "哪": "na", "吗": "ma", "呢": "ne",
    "吧": "ba", "啊": "a", "哦": "o", "唉": "ai", "嗯": "en",
    "呀": "ya", "哇": "wa", "哈": "ha", "嘿": "hei", "嗨": "hai",
    "喂": "wei", "噢": "o",
    // === 生活/社会/其他常用字 ===
    "方": "fang", "处": "chu", "边": "bian", "旁": "pang", "界": "jie",
    "城": "cheng", "街": "jie", "路": "lu", "桥": "qiao", "家": "jia",
    "乡": "xiang", "村": "cun", "男": "nan", "女": "nv", "童": "tong",
    "老": "lao", "父": "fu", "母": "mu", "哥": "ge", "姐": "jie",
    "弟": "di", "妹": "mei", "书": "shu", "信": "xin", "字": "zi",
    "言": "yan", "语": "yu", "话": "hua", "声": "sheng", "音": "yin",
    "色": "se", "香": "xiang", "味": "wei", "影": "ying", "失": "shi",
    "成": "cheng", "败": "bai", "生": "sheng", "死": "si", "活": "huo",
    "希": "xi", "永": "yong", "恒": "heng", "久": "jiu", "门": "men",
    "窗": "chuang", "衣": "yi", "金": "jin", "银": "yin", "玉": "yu",
    "词": "ci", "诗": "shi", "怨": "yuan", "盼": "pan", "等": "deng",
    "候": "hou", "守": "shou", "学": "xue", "考": "kao", "息": "xi",
  };

  // 日文假名罗马音表。清音 / 浊音 / 半浊音 / 拗音 / 促音 / 拨音 / 片假名同音。
  // 促音「っ」单独成 syllable，defaultReading = "cl"（USTX 惯例）。
  // 拨音「ん」单独成 syllable，defaultReading = "n"。
  // 长音「ー」不单独成 syllable，由 splitJapaneseLyric 修改前一个 syllable 的 endAnchorId。
  const KANA_ROMAJI_TABLE = {
    // 平假名清音
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "を": "wo", "ん": "n",
    // 浊音 / 半浊音
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    // 拗音（や/ゆ/よ 拗音合并为一个 syllable）
    "きゃ": "kya", "きゅ": "kyu", "きょ": "kyo",
    "しゃ": "sha", "しゅ": "shu", "しょ": "sho",
    "ちゃ": "cha", "ちゅ": "chu", "ちょ": "cho",
    "にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
    "ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo",
    "みゃ": "mya", "みゅ": "myu", "みょ": "myo",
    "りゃ": "rya", "りゅ": "ryu", "りょ": "ryo",
    "ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
    "じゃ": "ja", "じゅ": "ju", "じょ": "jo",
    "びゃ": "bya", "びゅ": "byu", "びょ": "byo",
    "ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
    // 促音（单独成 syllable，defaultReading = "cl"）
    "っ": "cl",
    // 片假名同音同表
    "ア": "a", "イ": "i", "ウ": "u", "エ": "e", "オ": "o",
    "カ": "ka", "キ": "ki", "ク": "ku", "ケ": "ke", "コ": "ko",
    "サ": "sa", "シ": "shi", "ス": "su", "セ": "se", "ソ": "so",
    "タ": "ta", "チ": "chi", "ツ": "tsu", "テ": "te", "ト": "to",
    "ナ": "na", "ニ": "ni", "ヌ": "nu", "ネ": "ne", "ノ": "no",
    "ハ": "ha", "ヒ": "hi", "フ": "fu", "ヘ": "he", "ホ": "ho",
    "マ": "ma", "ミ": "mi", "ム": "mu", "メ": "me", "モ": "mo",
    "ヤ": "ya", "ユ": "yu", "ヨ": "yo",
    "ラ": "ra", "リ": "ri", "ル": "ru", "レ": "re", "ロ": "ro",
    "ワ": "wa", "ヲ": "wo", "ン": "n",
    "ガ": "ga", "ギ": "gi", "グ": "gu", "ゲ": "ge", "ゴ": "go",
    "ザ": "za", "ジ": "ji", "ズ": "zu", "ゼ": "ze", "ゾ": "zo",
    "ダ": "da", "ヂ": "ji", "ヅ": "zu", "デ": "de", "ド": "do",
    "バ": "ba", "ビ": "bi", "ブ": "bu", "ベ": "be", "ボ": "bo",
    "パ": "pa", "ピ": "pi", "プ": "pu", "ペ": "pe", "ポ": "po",
    "キャ": "kya", "キュ": "kyu", "キョ": "kyo",
    "シャ": "sha", "シュ": "shu", "ショ": "sho",
    "チャ": "cha", "チュ": "chu", "チョ": "cho",
    "ニャ": "nya", "ニュ": "nyu", "ニョ": "nyo",
    "ヒャ": "hya", "ヒュ": "hyu", "ヒョ": "hyo",
    "ミャ": "mya", "ミュ": "myu", "ミョ": "myo",
    "リャ": "rya", "リュ": "ryu", "リョ": "ryo",
    "ギャ": "gya", "ギュ": "gyu", "ギョ": "gyo",
    "ジャ": "ja", "ジュ": "ju", "ジョ": "jo",
    "ビャ": "bya", "ビュ": "byu", "ビョ": "byo",
    "ピャ": "pya", "ピュ": "pyu", "ピョ": "pyo",
    "ッ": "cl",
    // 长音「ー」（splitJapaneseLyric 会跳过不单独成 syllable；表中保留 "" 便于直接查表）
    "ー": "",
    // 小写假名（单独出现时作为独立音节，映射为单元音）
    "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o",
    // 拗音末尾假名单独出现时映射为 ya/yu/yo（拼入拗音时由 splitJapaneseLyric 合并处理）
    "ゃ": "ya", "ゅ": "yu", "ょ": "yo",
    // 片假名小写假名同音同表
    "ァ": "a", "ィ": "i", "ゥ": "u", "ェ": "e", "ォ": "o",
    // 片假名拗音末尾假名单独出现时映射为 ya/yu/yo
    "ャ": "ya", "ュ": "yu", "ョ": "yo",
  };

  // 拗音首字符集合：splitJapaneseLyric 用它判断"当前假名 + 下一假名"能否合并为拗音。
  // 例：き + ゃ → きゃ。集合里的字符是 ゃ/ゅ/ょ 三个拗音末尾。
  const KANA_YOON_SUFFIXES = new Set(["ゃ", "ゅ", "ょ", "ャ", "ュ", "ョ"]);

  // Web Audio API 节点图：第一版只为 master stem 真实生效 gain/pan/mute/solo。
  // createMediaElementSource 一旦调用就不能撤销，所以 setup 只执行一次；
  // 失败时降级到 audio.volume（只能控制 master gain，pan 不生效）。
  const audioGraph = {
    context: null,
    source: null,
    masterGain: null,
    masterPanner: null,
    ready: false,
  };

  function setupAudioGraph() {
    if (audioGraph.ready) return;
    if (!state.audioUrl) return;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      audioGraph.context = new Ctor();
      audioGraph.source = audioGraph.context.createMediaElementSource(elements.audio);
      audioGraph.masterGain = audioGraph.context.createGain();
      audioGraph.masterPanner = audioGraph.context.createStereoPanner();
      audioGraph.source.connect(audioGraph.masterGain);
      audioGraph.masterGain.connect(audioGraph.masterPanner);
      audioGraph.masterPanner.connect(audioGraph.context.destination);
      audioGraph.ready = true;
    } catch (error) {
      audioGraph.ready = false;
      setStatus(`Web Audio API 初始化失败，降级到音量控制：${error.message}`, "error");
    }
  }

  function resumeAudioContext() {
    if (audioGraph.ready && audioGraph.context && audioGraph.context.state === "suspended") {
      audioGraph.context.resume().catch(() => { /* 静默；下次手势再试 */ });
    }
  }

  // 计算每个 stem 的实际播放状态（用于 UI 显示与混音）。
  //   - 若有任意 stem solo：只 solo 的 stem 发声，其他静音；
  //   - 否则：所有未 mute 的 stem 发声。
  function stemEffectiveState(track) {
    const anySolo = state.stemTracks.some(item => item.solo);
    const muted = track.mute || (anySolo && !track.solo);
    return {
      muted,
      effectiveGain: muted ? 0 : clamp(track.gain, 0, 1.5),
      effectivePan: clamp(track.pan, -1, 1),
    };
  }

  function applyStemMix() {
    if (!state.stemTracks.length) return;
    const master = state.stemTracks.find(track => track.id === "master");
    if (!master) return;
    const { effectiveGain, effectivePan } = stemEffectiveState(master);
    if (audioGraph.ready) {
      audioGraph.masterGain.gain.value = effectiveGain;
      audioGraph.masterPanner.pan.value = effectivePan;
    } else {
      // 降级：HTMLAudioElement.volume 范围是 0..1，pan 不生效。
      elements.audio.volume = clamp(effectiveGain, 0, 1);
    }
    // 占位 stem 没有 audio 节点；UI 在 renderStemMixer 中反映状态。
  }

  // P1.2 轮 4：非破坏混音参数。master stem 真实生效 trim/fade。
  //   - trim：播放开始时跳到 trimStartSeconds；到达 trimEndSeconds 时停止（timeupdate 监听）
  //   - fade：用 masterGain 的 linearRampToValueAtTime 在播放头进入淡入/淡出区间时构造包络
  // "original" 模式忽略所有非破坏参数（只保留 gain/pan/mute/solo）。
  function stemEffectiveTrimRange(track) {
    if (state.stemPreviewMode === "original") return { start: 0, end: state.duration };
    const trimStart = clamp(finiteNumber(track.trimStartSeconds, 0), 0, Math.max(0, state.duration));
    const trimEndRaw = clamp(finiteNumber(track.trimEndSeconds, 0), 0, Math.max(0, state.duration));
    const trimEnd = trimEndRaw > 0 ? Math.max(trimStart + 0.01, trimEndRaw) : state.duration;
    return { start: trimStart, end: Math.min(trimEnd, state.duration) };
  }

  function stemEffectiveFade(track) {
    if (state.stemPreviewMode === "original") return { fadeIn: 0, fadeOut: 0 };
    return {
      fadeIn: Math.max(0, finiteNumber(track.fadeInSeconds, 0)),
      fadeOut: Math.max(0, finiteNumber(track.fadeOutSeconds, 0)),
    };
  }

  // 在播放开始 / seek / timeupdate 时调用，更新 masterGain 包络。
  function applyMasterFadeEnvelope() {
    if (!audioGraph.ready || !audioGraph.context) return;
    const master = state.stemTracks.find(track => track.id === "master");
    if (!master) return;
    const { effectiveGain } = stemEffectiveState(master);
    const { start, end } = stemEffectiveTrimRange(master);
    const { fadeIn, fadeOut } = stemEffectiveFade(master);
    const current = elements.audio.currentTime;
    const ctx = audioGraph.context;
    const gainParam = audioGraph.masterGain.gain;
    gainParam.cancelScheduledValues(ctx.currentTime);
    // 不在 trim 范围内 → 静音
    if (current < start - 0.001 || current > end + 0.001) {
      gainParam.setValueAtTime(0, ctx.currentTime);
      return;
    }
    // 淡入：从 start 到 start + fadeIn，gain 从 0 线性升到 effectiveGain
    if (fadeIn > 0 && current < start + fadeIn) {
      gainParam.setValueAtTime(0, ctx.currentTime);
      gainParam.linearRampToValueAtTime(effectiveGain, ctx.currentTime + Math.max(0.001, start + fadeIn - current));
    } else {
      gainParam.setValueAtTime(effectiveGain, ctx.currentTime);
    }
    // 淡出：从 end - fadeOut 到 end，gain 从 effectiveGain 线性降到 0
    if (fadeOut > 0 && current < end && current < end - 0.001) {
      const fadeOutStart = Math.max(current, end - fadeOut);
      if (fadeOutStart < end) {
        gainParam.setValueAtTime(effectiveGain, ctx.currentTime + Math.max(0, fadeOutStart - current));
        gainParam.linearRampToValueAtTime(0, ctx.currentTime + Math.max(0.001, end - current));
      }
    }
  }

  // 播放头进入 trim 范围外时停止播放（timeupdate 监听调用）。
  function enforceMasterTrimBoundary() {
    if (state.stemPreviewMode === "original") return;
    const master = state.stemTracks.find(track => track.id === "master");
    if (!master) return;
    const { start, end } = stemEffectiveTrimRange(master);
    const current = elements.audio.currentTime;
    if (current < start - 0.01) {
      elements.audio.currentTime = start;
    } else if (current > end + 0.05) {
      elements.audio.pause();
      elements.audio.currentTime = end;
    }
  }

  // ---- EditGraph：撤销/重做栈（第一版）-----------------------------------------
  // 设计原则：
  // - 每次会改变 anchors / lyrics / rests / chordOverrides / selection 的"用户操作"
  //   在执行前调用 editGraph.begin(label) 保存当前状态快照。
  // - 撤销 = 把当前状态推入 redo 栈，弹出 undo 栈顶恢复。
  // - 新操作清空 redo 栈（与常见编辑器一致）。
  // - 快照限制 50 条防止内存爆炸；超出后丢弃最旧。
  // - 快照只保存可编辑数据，不保存 audioUrl / analysis 等不可变状态。
  const editGraph = {
    undoStack: [],
    redoStack: [],
    maxSize: 50,

    snapshot() {
      return {
        anchors: Array.from(state.anchors.values()).map(anchor => ({ ...anchor })),
        lyrics: state.lyrics.map(region => ({ ...region })),
        rests: state.rests.map(rest => ({ ...rest })),
        chordOverrides: JSON.parse(JSON.stringify(state.chordOverrides)),
        selection: { ...state.selection },
        selectedLyricId: state.selectedLyricId,
        selectedRestId: state.selectedRestId,
        nextLyricId: state.nextLyricId,
        nextRestId: state.nextRestId,
        nextAnchorId: state.nextAnchorId,
        // 锁定状态也是用户编辑的一部分，撤销/重做时需要一起恢复。
        lockedFields: Array.from(state.lockedFields),
        // stem 轨混音参数也是用户编辑的一部分，撤销/重做时一并恢复。
        stemTracks: state.stemTracks.map(track => ({ ...track })),
        // P1.2 轮 4：试听模式（edited / original）也随快照保存。
        stemPreviewMode: state.stemPreviewMode,
        // 音符候选也是用户编辑的一部分，撤销/重做时一并恢复（P1.2 轮 2 起）。
        notes: state.notes.map(note => ({ ...note })),
        nextNoteId: state.nextNoteId,
        // P2：歌词音节切分也是用户编辑的一部分，撤销/重做时一并恢复。
        // 读音纠正、重新切分、手动边界拖动都会进入 undo/redo 栈。
        syllables: state.syllables.map(syllable => ({ ...syllable })),
        nextSyllableId: state.nextSyllableId,
      };
    },

    restore(snapshot) {
      state.anchors = new Map(snapshot.anchors.map(anchor => [anchor.id, { ...anchor }]));
      state.lyrics = snapshot.lyrics.map(region => ({ ...region }));
      state.rests = snapshot.rests.map(rest => ({ ...rest }));
      state.chordOverrides = JSON.parse(JSON.stringify(snapshot.chordOverrides));
      state.selection = { ...snapshot.selection };
      state.selectedLyricId = snapshot.selectedLyricId;
      state.selectedRestId = snapshot.selectedRestId;
      state.nextLyricId = snapshot.nextLyricId;
      state.nextRestId = snapshot.nextRestId;
      state.nextAnchorId = snapshot.nextAnchorId;
      state.lockedFields = new Set(Array.isArray(snapshot.lockedFields) ? snapshot.lockedFields : []);
      // stem 轨可能在旧版快照中不存在（向前兼容），缺失时保留默认 stem。
      state.stemTracks = Array.isArray(snapshot.stemTracks) && snapshot.stemTracks.length
        ? snapshot.stemTracks.map(track => ({
          ...track,
          // P1.2 轮 4：旧版快照可能没有 trim/fade 字段，缺失时回退到 0。
          trimStartSeconds: Number.isFinite(track.trimStartSeconds) ? track.trimStartSeconds : 0,
          trimEndSeconds: Number.isFinite(track.trimEndSeconds) ? track.trimEndSeconds : 0,
          fadeInSeconds: Number.isFinite(track.fadeInSeconds) ? track.fadeInSeconds : 0,
          fadeOutSeconds: Number.isFinite(track.fadeOutSeconds) ? track.fadeOutSeconds : 0,
        }))
        : defaultStemTracks();
      state.stemPreviewMode = snapshot.stemPreviewMode === "original" ? "original" : "edited";
      // 音符候选可能在旧版快照中不存在（P1.2 轮 2 之前），缺失时清空。
      state.notes = Array.isArray(snapshot.notes) ? snapshot.notes.map(note => ({ ...note })) : [];
      state.nextNoteId = Number.isFinite(snapshot.nextNoteId) ? snapshot.nextNoteId : 1;
      state.selectedNoteId = null;
      state.noteDrag = null;
      state.pianoRollMergeCandidateId = null;
      // P2：音节切分可能在旧版快照中不存在（0.2.0 之前），缺失时清空。
      // 试听合成是临时状态，不进快照；恢复时强制停止。
      state.syllables = Array.isArray(snapshot.syllables) ? snapshot.syllables.map(syllable => ({ ...syllable })) : [];
      state.nextSyllableId = Number.isFinite(snapshot.nextSyllableId) ? snapshot.nextSyllableId : 1;
      state.selectedSyllableId = null;
      stopVocalPreview();
      // 恢复后清除选中编辑器视图，避免引用已不存在的 region
      elements.lyricText.value = "";
      elements.lyricLanguage.value = "zh";
      elements.cancelLyricEditButton.hidden = true;
      elements.deleteLyricButton.hidden = true;
      elements.chordInspector.hidden = true;
      elements.restInspector.hidden = true;
      elements.selectionStart.value = state.selection.start.toFixed(3);
      elements.selectionEnd.value = state.selection.end.toFixed(3);
    },

    begin(label) {
      this.undoStack.push({ label, snapshot: this.snapshot() });
      if (this.undoStack.length > this.maxSize) this.undoStack.shift();
      this.redoStack = [];
      updateUndoRedoButtons();
    },

    undo() {
      if (!this.undoStack.length) return false;
      const entry = this.undoStack.pop();
      this.redoStack.push({ label: entry.label, snapshot: this.snapshot() });
      this.restore(entry.snapshot);
      updateUndoRedoButtons();
      setStatus(`已撤销：${entry.label}。`, "success");
      return true;
    },

    redo() {
      if (!this.redoStack.length) return false;
      const entry = this.redoStack.pop();
      this.undoStack.push({ label: entry.label, snapshot: this.snapshot() });
      this.restore(entry.snapshot);
      updateUndoRedoButtons();
      setStatus(`已重做：${entry.label}。`, "success");
      return true;
    },

    canUndo() { return this.undoStack.length > 0; },
    canRedo() { return this.redoStack.length > 0; },
  };

  function updateUndoRedoButtons() {
    if (elements.undoButton) {
      elements.undoButton.disabled = !editGraph.canUndo();
      elements.undoButton.title = editGraph.canUndo() ? `撤销（Ctrl+Z）· ${editGraph.undoStack.length} 步可回退` : "无可撤销操作";
    }
    if (elements.redoButton) {
      elements.redoButton.disabled = !editGraph.canRedo();
      elements.redoButton.title = editGraph.canRedo() ? `重做（Ctrl+Shift+Z）· ${editGraph.redoStack.length} 步可重做` : "无可重做操作";
    }
  }

  const byId = id => document.getElementById(id);
  const elements = {
    analysisFile: byId("analysis-file"),
    audioFile: byId("audio-file"),
    projectFile: byId("project-file"),
    importProjectButton: byId("import-project-button"),
    exportProjectButton: byId("export-project-button"),
    status: byId("status"),
    workbench: byId("workbench"),
    audio: byId("audio-player"),
    playButton: byId("play-button"),
    stopButton: byId("stop-button"),
    playTime: byId("play-time"),
    audioName: byId("audio-name"),
    zoomRange: byId("zoom-range"),
    snapGrid: byId("snap-grid"),
    dottedSnap: byId("dotted-snap"),
    swingAmount: byId("swing-amount"),
    continuousLyrics: byId("continuous-lyrics"),
    timelineScroll: byId("timeline-scroll"),
    timelineContent: byId("timeline-content"),
    ruler: byId("ruler"),
    sectionsLane: byId("sections-lane"),
    chordsLane: byId("chords-lane"),
    waveformLane: byId("waveform-lane"),
    canvas: byId("timeline-canvas"),
    selectionOverlay: byId("selection-overlay"),
    selectionStartHandle: byId("selection-start-handle"),
    selectionEndHandle: byId("selection-end-handle"),
    playhead: byId("playhead"),
    lyricsLane: byId("lyrics-lane"),
    lyricsEmpty: byId("lyrics-empty"),
    selectionSummary: byId("selection-summary"),
    selectionStart: byId("selection-start"),
    selectionEnd: byId("selection-end"),
    lyricLanguage: byId("lyric-language"),
    lyricText: byId("lyric-text"),
    saveLyricButton: byId("save-lyric-button"),
    cancelLyricEditButton: byId("cancel-lyric-edit-button"),
    deleteLyricButton: byId("delete-lyric-button"),
    convertRestButton: byId("convert-rest-button"),
    deleteRestButton: byId("delete-rest-button"),
    restInspector: byId("rest-inspector"),
    restDetail: byId("rest-detail"),
    chordInspector: byId("chord-inspector"),
    chordDetail: byId("chord-detail"),
    chordLabel: byId("chord-label"),
    saveChordButton: byId("save-chord-button"),
    restoreChordButton: byId("restore-chord-button"),
    undoButton: byId("undo-button"),
    redoButton: byId("redo-button"),
    exactData: byId("exact-data"),
    lockLyricWrapper: byId("lock-lyric-wrapper"),
    lockLyricCheckbox: byId("lock-lyric-checkbox"),
    lockChordWrapper: byId("lock-chord-wrapper"),
    lockChordCheckbox: byId("lock-chord-checkbox"),
    lockRestWrapper: byId("lock-rest-wrapper"),
    lockRestCheckbox: byId("lock-rest-checkbox"),
    stemMixer: byId("stem-mixer"),
    // P1.2 轮 4：A/B 试听模式切换控件（edited / original）。
    stemPreviewMode: byId("stem-preview-mode"),
    pianoRollScroll: byId("piano-roll-scroll"),
    pianoRollContent: byId("piano-roll-content"),
    pianoRollCanvas: byId("piano-roll-canvas"),
    pianoRollGrid: byId("piano-roll-grid"),
    pianoRollStemSelect: byId("piano-roll-stem-select"),
    splitNoteButton: byId("split-note-button"),
    mergeNoteButton: byId("merge-note-button"),
    quantizeNoteButton: byId("quantize-note-button"),
    deleteNoteButton: byId("delete-note-button"),
    // P2：读音与切分检查器
    syllableInspector: byId("syllable-inspector"),
    syllableDetail: byId("syllable-detail"),
    syllableList: byId("syllable-list"),
    resplitSyllablesButton: byId("resplit-syllables-button"),
    vocalPreviewButton: byId("vocal-preview-button"),
    stopVocalPreviewButton: byId("stop-vocal-preview-button"),
    vocalTimbreWaveform: byId("vocal-timbre-waveform"),
    lockSyllableWrapper: byId("lock-syllable-wrapper"),
    lockSyllableCheckbox: byId("lock-syllable-checkbox"),
  };

  function setStatus(message, kind = "") {
    elements.status.textContent = message;
    elements.status.className = `status${kind ? ` ${kind}` : ""}`;
  }

  function finiteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function formatTime(seconds) {
    const safe = Math.max(0, finiteNumber(seconds));
    const minutes = Math.floor(safe / 60);
    const remainder = safe - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
  }

  // ---- 时间模型：TempoMap + Anchor ---------------------------------------------

  function buildTempoMap(analysis) {
    const sampleRateHz = finiteNumber(
      analysis && analysis.source_audio && analysis.source_audio.sample_rate_hz,
      48000
    );
    if (!(sampleRateHz > 0)) throw new Error("分析 JSON 缺少有效的采样率。");
    const tempo = analysis.analysis.tempo && analysis.analysis.tempo.candidates && analysis.analysis.tempo.candidates[0];
    if (!tempo || !finiteNumber(tempo.bpm) || tempo.bpm <= 0) throw new Error("分析 JSON 缺少有效的速度候选。");
    const bpm = finiteNumber(tempo.bpm);
    const firstBeatSeconds = finiteNumber(tempo.first_beat_seconds);
    const firstBeatSample = Math.round(firstBeatSeconds * sampleRateHz);
    const firstBeatTick = 0;
    const ticksPerSecond = (bpm / 60) * PPQ;
    const samplesPerTick = sampleRateHz / ticksPerSecond;
    return {
      sampleRateHz,
      ppq: PPQ,
      bpm,
      firstBeatSeconds,
      firstBeatSample,
      firstBeatTick,
      ticksPerSecond,
      samplesPerTick,
    };
  }

  function sampleToTick(sample) {
    const map = state.tempoMap;
    if (!map) return 0;
    return Math.round(map.firstBeatTick + ((sample - map.firstBeatSample) / map.sampleRateHz) * map.ticksPerSecond);
  }

  function tickToSample(tick) {
    const map = state.tempoMap;
    if (!map) return 0;
    return map.firstBeatSample + ((tick - map.firstBeatTick) / map.ticksPerSecond) * map.sampleRateHz;
  }

  function sampleToSeconds(sample) {
    return sample / state.sampleRateHz;
  }

  function secondsToSample(seconds) {
    return Math.round(seconds * state.sampleRateHz);
  }

  function createAnchorAtSample(sample) {
    const safeSample = Math.max(0, Math.min(Math.round(sample), Math.round(state.duration * state.sampleRateHz)));
    let identifier;
    do {
      identifier = `anchor-${state.nextAnchorId++}`;
    } while (state.anchors.has(identifier));
    const anchor = { id: identifier, sample: safeSample, tick: sampleToTick(safeSample) };
    state.anchors.set(identifier, anchor);
    return anchor;
  }

  function findAnchorBySample(sample, toleranceSeconds = ANCHOR_TOLERANCE_SECONDS) {
    const target = Math.round(sample);
    const toleranceSamples = Math.max(1, Math.round(toleranceSeconds * state.sampleRateHz));
    let closest = null;
    let closestDelta = Infinity;
    for (const anchor of state.anchors.values()) {
      const delta = Math.abs(anchor.sample - target);
      if (delta <= toleranceSamples && delta < closestDelta) {
        closest = anchor;
        closestDelta = delta;
      }
    }
    return closest;
  }

  function moveAnchor(anchorId, sample) {
    const anchor = state.anchors.get(anchorId);
    if (!anchor) return;
    const safeSample = Math.max(0, Math.min(Math.round(sample), Math.round(state.duration * state.sampleRateHz)));
    anchor.sample = safeSample;
    anchor.tick = sampleToTick(safeSample);
  }

  function anchorStartSeconds(region) {
    const anchor = state.anchors.get(region.startAnchorId);
    return anchor ? sampleToSeconds(anchor.sample) : 0;
  }

  function anchorEndSeconds(region) {
    const anchor = state.anchors.get(region.endAnchorId);
    return anchor ? sampleToSeconds(anchor.sample) : 0;
  }

  function anchorStartSample(region) {
    const anchor = state.anchors.get(region.startAnchorId);
    return anchor ? anchor.sample : 0;
  }

  function anchorEndSample(region) {
    const anchor = state.anchors.get(region.endAnchorId);
    return anchor ? anchor.sample : 0;
  }

  // 删除未被任何 lyric/rest/syllable 引用的 anchor，避免 anchor 表无限增长。
  function pruneAnchors() {
    const referenced = new Set();
    state.lyrics.forEach(region => {
      referenced.add(region.startAnchorId);
      referenced.add(region.endAnchorId);
    });
    state.rests.forEach(rest => {
      referenced.add(rest.startAnchorId);
      referenced.add(rest.endAnchorId);
    });
    // P2：音节切分也引用 anchor（与歌词/休止共享时间模型），不能被 prune 掉。
    state.syllables.forEach(syllable => {
      referenced.add(syllable.startAnchorId);
      referenced.add(syllable.endAnchorId);
    });
    for (const id of Array.from(state.anchors.keys())) {
      if (!referenced.has(id)) state.anchors.delete(id);
    }
  }

  // ---- 字段级锁定 -------------------------------------------------------------
  // 设计：
  //   - 锁定 key 形如 "lyric:lyric-1" / "rest:rest-1" / "chord:<chordKey>"
  //   - 用户主动操作（编辑、删除、解锁）始终允许；锁定只阻止"自动重生成"覆盖。
  //   - 当前阶段没有自动重生成，锁定主要承担两件事：
  //     1) UI 高亮显示用户已确认的字段；
  //     2) 在删除/恢复原值等会丢失用户确认结果的操作前提示先解锁。
  //   - 锁定状态随 editGraph 快照保存，撤销/重做时一并恢复。
  function lockKey(type, id) {
    return `${type}:${id}`;
  }

  function isLocked(type, id) {
    return state.lockedFields.has(lockKey(type, id));
  }

  function setLocked(type, id, locked) {
    const key = lockKey(type, id);
    if (locked) state.lockedFields.add(key);
    else state.lockedFields.delete(key);
  }

  function serializeLockedFields() {
    return Array.from(state.lockedFields).sort();
  }

  function refreshLockToggle(wrapper, checkbox, type, id) {
    if (!wrapper || !checkbox) return;
    if (!id) {
      wrapper.hidden = true;
      checkbox.checked = false;
      return;
    }
    wrapper.hidden = false;
    checkbox.checked = isLocked(type, id);
  }

  // ---- 选区与吸附 --------------------------------------------------------------

  function topTempoCandidate() {
    return state.analysis && state.analysis.analysis.tempo.candidates[0] || null;
  }

  function snapIntervalSeconds() {
    const tempo = topTempoCandidate();
    if (!tempo || state.snapMode === "none") return 0;
    const beat = 60 / finiteNumber(tempo.bpm, 120);
    let interval;
    switch (state.snapMode) {
      case "quarter-beat": interval = beat / 4; break;
      case "eighth-beat": interval = beat / 8; break;
      case "triplet-half": interval = beat / 3; break;       // 1/3 拍 = 三连音半拍
      case "triplet-quarter": interval = beat / 6; break;    // 1/6 拍 = 三连音四分拍
      case "half-beat": interval = beat / 2; break;
      case "beat":
      default: interval = beat; break;
    }
    // 附点：网格拉长 1.5 倍（仅在非三连音网格上有意义，但允许在所有网格上叠加）
    if (state.dottedSnap && state.snapMode !== "triplet-half" && state.snapMode !== "triplet-quarter") {
      interval = interval * 1.5;
    }
    return interval;
  }

  // Swing 偏移：在偶数细分网格上，把每个网格的"后半段"边界向后推 swingAmount * (interval/2)。
  // 奇数段（第 0/2/4... 个网格）起点保持原位，偶数段起点被延迟。
  // 三连音网格不应用 swing（三连音本身已是奇分，swing 概念不适用）。
  function swingOffsetForIndex(gridIndex, interval) {
    if (!state.swingAmount || interval <= 0) return 0;
    if (state.snapMode === "triplet-half" || state.snapMode === "triplet-quarter") return 0;
    if (state.snapMode === "beat") return 0; // 整拍网格上 swing 无可推点位
    if (gridIndex % 2 === 0) return 0;       // 前半段不动
    return state.swingAmount * (interval / 2);
  }

  function snapTime(seconds, bypass = false) {
    const interval = snapIntervalSeconds();
    if (!interval || bypass) return clamp(seconds, 0, state.duration);
    if (seconds <= interval / 2) return 0;
    if (state.duration - seconds <= interval / 2) return state.duration;
    const tempo = topTempoCandidate();
    const origin = finiteNumber(tempo.first_beat_seconds);
    const rawIndex = Math.round((seconds - origin) / interval);
    // 在 swing 网格上，需要比较"加 swing 偏移后的网格点"与"原始偶数段边界"两个候选，取最近者
    const candidateEven = origin + rawIndex * interval;            // 不带 swing 的常规网格点
    const oddIndex = rawIndex - (rawIndex % 2 === 0 ? 0 : 1) + 1;  // 落在后半段的候选奇数网格点
    const candidateOdd = origin + oddIndex * interval + swingOffsetForIndex(oddIndex, interval);
    const candidates = [candidateEven];
    if (oddIndex !== rawIndex && candidateOdd !== candidateEven) candidates.push(candidateOdd);
    let best = candidates[0];
    let bestDist = Math.abs(seconds - best);
    for (let i = 1; i < candidates.length; i++) {
      const d = Math.abs(seconds - candidates[i]);
      if (d < bestDist) { best = candidates[i]; bestDist = d; }
    }
    return clamp(Number(best.toFixed(6)), 0, state.duration);
  }

  // 量化函数（P1.2 轮 3）：把任意 sample 对齐到当前网格。
  // 用于钢琴卷帘拖动结束后强制对齐，以及将选区转换为歌词/休止时的边界吸附。
  function quantizeSample(sample) {
    const interval = snapIntervalSeconds();
    if (!interval || !state.sampleRateHz) return sample;
    const seconds = sample / state.sampleRateHz;
    const snapped = snapTime(seconds);
    return Math.round(snapped * state.sampleRateHz);
  }

  // ---- 分析 JSON 校验 ----------------------------------------------------------

  function validateAnalysis(candidate) {
    if (!candidate || typeof candidate !== "object") throw new Error("分析 JSON 顶层必须是对象。");
    if (candidate.schema_version !== ANALYSIS_SCHEMA) {
      throw new Error(`不支持的分析版本：${String(candidate.schema_version || "缺失")}；当前只接受 ${ANALYSIS_SCHEMA}。`);
    }
    const duration = Number(candidate.source_audio && candidate.source_audio.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("分析 JSON 缺少有效的音频时长。");
    const analysis = candidate.analysis;
    if (!analysis || typeof analysis !== "object") throw new Error("分析 JSON 缺少 analysis 对象。");
    const requiredArrays = [
      ["waveform", "bins"],
      ["short_time_energy", "bins"],
      ["tempo", "candidates"],
      ["key", "candidates"],
      ["chords", "windows"],
      ["sections", "boundaries"],
      ["sections", "regions"],
    ];
    requiredArrays.forEach(([layerName, fieldName]) => {
      const layer = analysis[layerName];
      if (!layer || typeof layer !== "object" || !Array.isArray(layer[fieldName])) {
        throw new Error(`分析 JSON 缺少 ${layerName}.${fieldName} 数组。`);
      }
    });
    const isFiniteNumber = value => typeof value === "number" && Number.isFinite(value);
    const validateInterval = (item, label, allowZeroLength = false) => {
      if (!item || typeof item !== "object" || !isFiniteNumber(item.start_seconds) || !isFiniteNumber(item.end_seconds)) {
        throw new Error(`${label} 包含无效时间。`);
      }
      if (item.start_seconds < 0 || item.end_seconds > duration + 1e-6 || (allowZeroLength ? item.end_seconds < item.start_seconds : item.end_seconds <= item.start_seconds)) {
        throw new Error(`${label} 的时间超出音频范围或顺序错误。`);
      }
    };
    analysis.waveform.bins.forEach((bin, index) => {
      validateInterval(bin, `waveform.bins[${index}]`);
      ["minimum", "maximum", "rms"].forEach(field => {
        if (!isFiniteNumber(bin[field])) throw new Error(`waveform.bins[${index}].${field} 不是有限数。`);
      });
    });
    analysis.short_time_energy.bins.forEach((bin, index) => {
      validateInterval(bin, `short_time_energy.bins[${index}]`);
      if (!isFiniteNumber(bin.rms) || !isFiniteNumber(bin.rms_dbfs)) throw new Error(`short_time_energy.bins[${index}] 含无效能量。`);
    });
    analysis.tempo.candidates.forEach((candidateItem, index) => {
      if (!candidateItem || !isFiniteNumber(candidateItem.bpm) || candidateItem.bpm <= 0 || candidateItem.bpm > 1000 ||
          !isFiniteNumber(candidateItem.first_beat_seconds) || candidateItem.first_beat_seconds < 0 || candidateItem.first_beat_seconds > duration) {
        throw new Error(`tempo.candidates[${index}] 无效。`);
      }
    });
    analysis.key.candidates.forEach((candidateItem, index) => {
      if (!candidateItem || typeof candidateItem.label !== "string" || !candidateItem.label.trim()) throw new Error(`key.candidates[${index}] 无效。`);
    });
    analysis.chords.windows.forEach((window, index) => {
      validateInterval(window, `chords.windows[${index}]`);
      if (!Array.isArray(window.candidates)) throw new Error(`chords.windows[${index}].candidates 不是数组。`);
      window.candidates.forEach((candidateItem, candidateIndex) => {
        if (!candidateItem || typeof candidateItem.label !== "string" || !candidateItem.label.trim()) {
          throw new Error(`chords.windows[${index}].candidates[${candidateIndex}] 无效。`);
        }
      });
    });
    analysis.sections.boundaries.forEach((boundary, index) => {
      if (!boundary || !isFiniteNumber(boundary.time_seconds) || boundary.time_seconds < 0 || boundary.time_seconds > duration) {
        throw new Error(`sections.boundaries[${index}] 无效。`);
      }
    });
    analysis.sections.regions.forEach((region, index) => validateInterval(region, `sections.regions[${index}]`));
    return candidate;
  }

  async function readJsonFile(file) {
    if (!file) throw new Error("没有选择文件。");
    if (file.size > 25 * 1024 * 1024) throw new Error("JSON 超过 25 MB，技术原型暂不载入。");
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      throw new Error(`JSON 无法解析：${error.message}`);
    }
    return parsed;
  }

  function resetEditingState() {
    state.selection = { start: 0, end: 0 };
    state.lyrics = [];
    state.rests = [];
    state.anchors.clear();
    state.chordOverrides = {};
    state.selectedChordKey = null;
    state.selectedLyricId = null;
    state.selectedRestId = null;
    state.nextLyricId = 1;
    state.nextRestId = 1;
    state.nextAnchorId = 1;
    // 清空 undo/redo 栈：新项目里旧历史无意义。
    editGraph.undoStack = [];
    editGraph.redoStack = [];
    updateUndoRedoButtons();
    // 锁定状态也是项目编辑历史的一部分，重置时一并清空。
    state.lockedFields = new Set();
    // stem 轨混音参数重置为默认；新项目里旧的混音参数无意义。
    state.stemTracks = defaultStemTracks();
    // P1.2 轮 4：试听模式重置为 edited；新项目里没有"原始/重合成"对比的必要。
    state.stemPreviewMode = "edited";
    if (elements.stemPreviewMode) elements.stemPreviewMode.value = "edited";
    // 音符候选清空；新项目里旧的音符无意义。
    state.notes = [];
    state.nextNoteId = 1;
    state.selectedNoteId = null;
    state.noteDrag = null;
    state.pianoRollMergeCandidateId = null;
    state.pianoRollStemId = "master";
    if (elements.pianoRollStemSelect) elements.pianoRollStemSelect.value = "master";
    updatePianoRollToolButtons();
    // P2：音节切分清空；新项目里旧的切分无意义。试听合成也强制停止。
    state.syllables = [];
    state.nextSyllableId = 1;
    state.selectedSyllableId = null;
    stopVocalPreview();
    if (elements.syllableInspector) elements.syllableInspector.hidden = true;
    if (elements.lockSyllableWrapper) elements.lockSyllableWrapper.hidden = true;
    if (elements.stopVocalPreviewButton) elements.stopVocalPreviewButton.hidden = true;
    elements.lyricText.value = "";
    elements.lyricLanguage.value = "zh";
    elements.chordInspector.hidden = true;
    elements.restInspector.hidden = true;
    if (elements.lockLyricWrapper) elements.lockLyricWrapper.hidden = true;
    if (elements.lockChordWrapper) elements.lockChordWrapper.hidden = true;
    if (elements.lockRestWrapper) elements.lockRestWrapper.hidden = true;
    elements.exactData.textContent = "选择和弦或歌词区域后显示。";
    renderStemMixer();
    applyStemMix();
  }

  function applyAnalysis(analysis, preserveEdits = false) {
    state.analysis = validateAnalysis(analysis);
    state.duration = Number(analysis.source_audio.duration_seconds);
    state.sampleRateHz = finiteNumber(analysis.source_audio.sample_rate_hz, 48000);
    state.tempoMap = buildTempoMap(state.analysis);
    if (!preserveEdits) resetEditingState();
    elements.workbench.hidden = false;
    elements.exportProjectButton.disabled = false;
    elements.selectionStart.max = String(state.duration);
    elements.selectionEnd.max = String(state.duration);
    elements.selectionStart.value = String(state.selection.start);
    elements.selectionEnd.value = String(state.selection.end);
    const tempo = analysis.analysis.tempo && analysis.analysis.tempo.candidates && analysis.analysis.tempo.candidates[0];
    const key = analysis.analysis.key && analysis.analysis.key.candidates && analysis.analysis.key.candidates[0];
    byId("summary-duration").textContent = `${state.duration.toFixed(3)} s`;
    byId("summary-tempo").textContent = tempo ? `${finiteNumber(tempo.bpm).toFixed(3)} BPM` : "不可用";
    byId("summary-key").textContent = key ? key.label : "不可用";
    byId("summary-analyzer").textContent = `${analysis.analyzer && analysis.analyzer.name || "unknown"} ${analysis.analyzer && analysis.analyzer.version || ""}`;
    setStatus(`已载入分析：${analysis.source_audio.filename || "未命名音频"}。和弦与段落是可修正候选。`, "success");
    renderAll();
    checkAudioAssociation();
  }

  // ---- 渲染辅助 ----------------------------------------------------------------

  function timelineWidth() {
    const viewport = Math.max(640, elements.timelineScroll.clientWidth - 145);
    return Math.max(viewport, state.duration * state.zoom);
  }

  function setTimelineGeometry() {
    if (!state.analysis) return;
    elements.timelineContent.style.width = `${timelineWidth() + 118}px`;
  }

  function percentAt(seconds) {
    return `${clamp(seconds / state.duration, 0, 1) * 100}%`;
  }

  function clearElement(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function renderRuler() {
    clearElement(elements.ruler);
    const width = timelineWidth();
    const targetSpacing = 86;
    const rawStep = state.duration / Math.max(1, Math.floor(width / targetSpacing));
    const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = candidates.find(value => value >= rawStep) || 120;
    for (let time = 0; time <= state.duration + 1e-6; time += step) {
      const tick = document.createElement("span");
      tick.className = "ruler-tick";
      tick.style.left = percentAt(time);
      const label = document.createElement("span");
      label.textContent = `${time.toFixed(step < 1 ? 1 : 0)}s`;
      tick.appendChild(label);
      elements.ruler.appendChild(tick);
    }
  }

  function makeBlock(className, label, start, end, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `timeline-block ${className}`;
    button.textContent = label;
    button.title = title;
    button.style.left = percentAt(start);
    button.style.width = percentAt(Math.max(0, end - start));
    return button;
  }

  function renderSections() {
    clearElement(elements.sectionsLane);
    const layer = state.analysis.analysis.sections;
    const regions = layer && Array.isArray(layer.regions) ? layer.regions : [];
    regions.forEach((region, index) => {
      const start = finiteNumber(region.start_seconds);
      const end = finiteNumber(region.end_seconds);
      const confidence = Number.isFinite(Number(region.confidence)) ? ` · 置信度 ${(Number(region.confidence) * 100).toFixed(0)}%` : "";
      const block = makeBlock("section-block", `段落候选 ${index + 1}`, start, end, `${start.toFixed(3)}–${end.toFixed(3)} 秒${confidence}`);
      block.addEventListener("click", () => setSelection(start, end));
      elements.sectionsLane.appendChild(block);
    });
  }

  function chordKey(window) {
    return `${finiteNumber(window.start_seconds).toFixed(6)}:${finiteNumber(window.end_seconds).toFixed(6)}`;
  }

  function topChord(window) {
    return window && Array.isArray(window.candidates) && window.candidates[0] ? window.candidates[0] : null;
  }

  function effectiveChordLabel(window) {
    const key = chordKey(window);
    const override = state.chordOverrides[key];
    const original = topChord(window);
    return override ? override.label : (original ? original.label : "?");
  }

  function renderChords() {
    clearElement(elements.chordsLane);
    const layer = state.analysis.analysis.chords;
    const windows = layer && Array.isArray(layer.windows) ? layer.windows : [];
    windows.forEach(window => {
      const start = finiteNumber(window.start_seconds);
      const end = finiteNumber(window.end_seconds);
      const candidate = topChord(window);
      const key = chordKey(window);
      const confidence = Number.isFinite(Number(window.confidence)) ? Number(window.confidence) : (candidate ? Number(candidate.confidence) : NaN);
      const titleConfidence = Number.isFinite(confidence) ? `${(confidence * 100).toFixed(1)}%` : "未提供";
      const block = makeBlock("chord-block", effectiveChordLabel(window), start, end, `${start.toFixed(3)}–${end.toFixed(3)} 秒 · 置信度 ${titleConfidence} · 点击修正`);
      if (state.chordOverrides[key]) block.classList.add("corrected");
      if (state.selectedChordKey === key) block.classList.add("selected");
      if (isLocked("chord", key)) block.classList.add("locked");
      block.addEventListener("click", () => selectChord(window));
      elements.chordsLane.appendChild(block);
    });
  }

  function selectChord(window) {
    const key = chordKey(window);
    const candidate = topChord(window);
    state.selectedChordKey = key;
    elements.chordInspector.hidden = false;
    elements.chordLabel.value = effectiveChordLabel(window);
    const confidence = Number.isFinite(Number(window.confidence)) ? Number(window.confidence) : (candidate ? Number(candidate.confidence) : NaN);
    const confidenceText = Number.isFinite(confidence) ? `${(confidence * 100).toFixed(1)}%` : "未提供";
    elements.chordDetail.textContent = `分析值：${candidate ? candidate.label : "无"} · ${finiteNumber(window.start_seconds).toFixed(3)}–${finiteNumber(window.end_seconds).toFixed(3)} 秒 · 置信度 ${confidenceText} · 来源 ${state.analysis.analysis.chords.source || "unknown"}`;
    elements.exactData.textContent = JSON.stringify({ source: state.analysis.analysis.chords.source, window, override: state.chordOverrides[key] || null, locked: isLocked("chord", key) }, null, 2);
    refreshLockToggle(elements.lockChordWrapper, elements.lockChordCheckbox, "chord", key);
    setSelection(finiteNumber(window.start_seconds), finiteNumber(window.end_seconds));
    renderChords();
  }

  function selectedChordWindow() {
    const windows = state.analysis && state.analysis.analysis.chords && state.analysis.analysis.chords.windows;
    return Array.isArray(windows) ? windows.find(window => chordKey(window) === state.selectedChordKey) : null;
  }

  // ---- 歌词 / 休止渲染 --------------------------------------------------------

  function renderLyrics() {
    clearElement(elements.lyricsLane);
    if (!state.lyrics.length && !state.rests.length) {
      elements.lyricsLane.appendChild(elements.lyricsEmpty);
      elements.lyricsEmpty.hidden = false;
      return;
    }
    // 合并 lyrics 与 rests，按 start sample 排序，渲染时按时间顺序处理空段。
    const combined = [];
    state.lyrics.forEach(region => combined.push({ kind: "lyric", region }));
    state.rests.forEach(region => combined.push({ kind: "rest", region }));
    combined.sort((a, b) => anchorStartSample(a.region) - anchorStartSample(b.region));

    const appendUnassigned = (startSeconds, endSeconds) => {
      if (endSeconds - startSeconds <= 1e-6) return;
      const gap = document.createElement("span");
      gap.className = "timeline-block rest-block unassigned-block";
      gap.textContent = "未分配";
      gap.title = `${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · 明确留白，不是渲染漏缝；可选中后转为休止`;
      gap.style.left = percentAt(startSeconds);
      gap.style.right = percentAt(state.duration - endSeconds);
      gap.dataset.unassignedStart = String(startSeconds);
      gap.dataset.unassignedEnd = String(endSeconds);
      gap.addEventListener("click", () => {
        setSelection(Number(gap.dataset.unassignedStart), Number(gap.dataset.unassignedEnd));
        selectUnassignedGap(Number(gap.dataset.unassignedStart), Number(gap.dataset.unassignedEnd));
      });
      elements.lyricsLane.appendChild(gap);
    };

    let cursorSample = 0;
    combined.forEach(({ kind, region }) => {
      const startSample = anchorStartSample(region);
      const endSample = anchorEndSample(region);
      const startSeconds = sampleToSeconds(startSample);
      const endSeconds = sampleToSeconds(endSample);
      appendUnassigned(sampleToSeconds(cursorSample), startSeconds);
      if (kind === "lyric") {
        const language = region.language === "ja" ? "日" : "中";
        const lockMarker = isLocked("lyric", region.id) ? " · 已锁定" : "";
        const block = makeBlock("lyric-block", `${language} · ${region.text}`, startSeconds, endSeconds, `${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · 点击编辑 · 拖动移动 · 边缘拉伸${lockMarker}`);
        block.style.removeProperty("width");
        block.style.right = percentAt(state.duration - endSeconds);
        if (state.selectedLyricId === region.id) block.classList.add("selected");
        if (isLocked("lyric", region.id)) block.classList.add("locked");
        // 用 pointerdown 替代 click，以便区分"点击编辑"和"拖动移动/拉伸"。
        block.addEventListener("pointerdown", event => beginLyricBlockDrag(event, region));
        elements.lyricsLane.appendChild(block);
      } else {
        const lockMarker = isLocked("rest", region.id) ? " · 已锁定" : "";
        const block = makeBlock("rest-block explicit-rest", "休止", startSeconds, endSeconds, `${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · 显式休止；点击编辑${lockMarker}`);
        block.style.removeProperty("width");
        block.style.right = percentAt(state.duration - endSeconds);
        if (state.selectedRestId === region.id) block.classList.add("selected");
        if (isLocked("rest", region.id)) block.classList.add("locked");
        block.addEventListener("click", () => editRest(region.id));
        elements.lyricsLane.appendChild(block);
      }
      cursorSample = Math.max(cursorSample, endSample);
    });
    appendUnassigned(sampleToSeconds(cursorSample), state.duration);

    renderSharedEdges();
  }

  // ---- 歌词块整体拖动与拉伸 ----------------------------------------------------
  // 行为：
  //   - pointerdown 在块左右 6 px 内 → stretch-start / stretch-end 模式，只移动一端 anchor
  //   - pointerdown 在块中间 → move 模式，整体移动 start/end anchor
  //   - 移动距离 < 4 px → 视为点击，进入编辑模式（保留原 editLyric 行为）
  //   - 若被移动的 anchor 与相邻 region 共享，先克隆一个新 anchor 给当前 region，
  //     保持邻居不动；这会让连续歌词区在单独拖动后产生小缝（用户预期）。
  //   - 不能跨越相邻 region 的另一端 anchor；吸附、Alt 绕过、Esc 取消、方向键微调都支持。
  function beginLyricBlockDrag(event, region) {
    if (!state.analysis || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetLeft = event.clientX - rect.left;
    const offsetRight = rect.right - event.clientX;
    const edgeTolerance = 8;
    let mode;
    if (offsetLeft <= edgeTolerance) mode = "stretch-start";
    else if (offsetRight <= edgeTolerance) mode = "stretch-end";
    else mode = "move";
    state.lyricDrag = {
      regionId: region.id,
      mode,
      startClientX: event.clientX,
      startStartSample: anchorStartSample(region),
      startEndSample: anchorEndSample(region),
      originalStartAnchorId: region.startAnchorId,
      originalEndAnchorId: region.endAnchorId,
      beganEdit: false,
      detachedStart: false,
      detachedEnd: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.addEventListener("pointermove", moveLyricBlock, true);
    document.addEventListener("pointerup", endLyricBlockDrag, true);
    document.addEventListener("pointercancel", cancelLyricBlockDrag, true);
  }

  // 如果 anchor 与其他 region 共享，克隆一个新 anchor 给当前 region，
  // 把当前 region 的对应 anchorId 切换到新克隆的 anchor，保持邻居不动。
  function detachAnchorIfShared(region, which) {
    const anchorId = which === "start" ? region.startAnchorId : region.endAnchorId;
    const shared = [...state.lyrics, ...state.rests].some(other => other.id !== region.id && (other.startAnchorId === anchorId || other.endAnchorId === anchorId));
    if (!shared) return false;
    const original = state.anchors.get(anchorId);
    const cloned = createAnchorAtSample(original.sample);
    if (which === "start") {
      region.startAnchorId = cloned.id;
      state.lyricDrag.detachedStart = true;
    } else {
      region.endAnchorId = cloned.id;
      state.lyricDrag.detachedEnd = true;
    }
    return true;
  }

  function moveLyricBlock(event) {
    if (!state.lyricDrag) return;
    if (Math.abs(event.clientX - state.lyricDrag.startClientX) < 4 && !state.lyricDrag.beganEdit) return;
    const region = state.lyrics.find(item => item.id === state.lyricDrag.regionId);
    if (!region) return;
    if (!state.lyricDrag.beganEdit) {
      editGraph.begin(state.lyricDrag.mode === "move" ? `拖动歌词 ${region.id}` : `拉伸歌词 ${region.id}`);
      state.lyricDrag.beganEdit = true;
      // 进入拖动模式前，按需克隆共享 anchor，使当前 region 独立移动。
      if (state.lyricDrag.mode === "move" || state.lyricDrag.mode === "stretch-start") {
        detachAnchorIfShared(region, "start");
      }
      if (state.lyricDrag.mode === "move" || state.lyricDrag.mode === "stretch-end") {
        detachAnchorIfShared(region, "end");
      }
    }
    event.preventDefault();
    event.stopPropagation();
    const pointerTime = snapTime(timeFromPointer(event), event.altKey);
    const pointerSample = secondsToSample(pointerTime);
    const minSample = 0;
    const maxSample = Math.round(state.duration * state.sampleRateHz);
    const minimum = event.altKey ? 1 : Math.max(1, Math.round((snapIntervalSeconds() || 0.001) * state.sampleRateHz));

    if (state.lyricDrag.mode === "move") {
      const durationSamples = state.lyricDrag.startEndSample - state.lyricDrag.startStartSample;
      // 限制不能跨越邻居的另一端 anchor
      const neighbors = [...state.lyrics, ...state.rests].filter(other => other.id !== region.id).sort((a, b) => anchorStartSample(a) - anchorStartSample(b));
      let lowerBound = minSample;
      let upperBound = maxSample;
      const previousNeighbor = neighbors.filter(other => anchorEndSample(other) <= state.lyricDrag.startStartSample).at(-1);
      if (previousNeighbor) lowerBound = anchorEndSample(previousNeighbor) + minimum;
      const nextNeighbor = neighbors.find(other => anchorStartSample(other) >= state.lyricDrag.startEndSample);
      if (nextNeighbor) upperBound = anchorStartSample(nextNeighbor) - minimum - durationSamples;
      const newStart = Math.max(lowerBound, Math.min(upperBound, pointerSample));
      moveAnchor(region.startAnchorId, newStart);
      moveAnchor(region.endAnchorId, newStart + durationSamples);
    } else if (state.lyricDrag.mode === "stretch-start") {
      const endSample = anchorEndSample(region);
      const newStart = Math.max(minSample, Math.min(endSample - minimum, pointerSample));
      moveAnchor(region.startAnchorId, newStart);
    } else if (state.lyricDrag.mode === "stretch-end") {
      const startSample = anchorStartSample(region);
      const newEnd = Math.max(startSample + minimum, Math.min(maxSample, pointerSample));
      moveAnchor(region.endAnchorId, newEnd);
    }
    setSelection(anchorStartSeconds(region), anchorEndSeconds(region), false);
    renderLyrics();
  }

  function endLyricBlockDrag(event) {
    if (!state.lyricDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const drag = state.lyricDrag;
    state.lyricDrag = null;
    document.removeEventListener("pointermove", moveLyricBlock, true);
    document.removeEventListener("pointerup", endLyricBlockDrag, true);
    document.removeEventListener("pointercancel", cancelLyricBlockDrag, true);
    if (!drag.beganEdit) {
      // 没真正拖动 → 视为点击，进入编辑
      editLyric(drag.regionId);
      return;
    }
    pruneAnchors();
    const region = state.lyrics.find(item => item.id === drag.regionId);
    if (region) {
      const startSeconds = anchorStartSeconds(region);
      const endSeconds = anchorEndSeconds(region);
      setStatus(`${drag.mode === "move" ? "歌词区域已移动到" : "歌词区域已拉伸到"} ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒。`, "success");
    }
  }

  function cancelLyricBlockDrag() {
    if (!state.lyricDrag) return;
    const drag = state.lyricDrag;
    state.lyricDrag = null;
    document.removeEventListener("pointermove", moveLyricBlock, true);
    document.removeEventListener("pointerup", endLyricBlockDrag, true);
    document.removeEventListener("pointercancel", cancelLyricBlockDrag, true);
    if (drag.beganEdit) {
      // 取消拖动：丢弃刚记录的撤销点
      editGraph.undoStack.pop();
      updateUndoRedoButtons();
    }
    // 恢复原始 anchor 引用（如果分离过）
    const region = state.lyrics.find(item => item.id === drag.regionId);
    if (region) {
      if (drag.detachedStart) region.startAnchorId = drag.originalStartAnchorId;
      if (drag.detachedEnd) region.endAnchorId = drag.originalEndAnchorId;
    }
    pruneAnchors();
    renderLyrics();
    setStatus("系统取消了歌词块拖动，已恢复原位置。", "success");
  }

  // 在相邻 lyric/rest 共享 anchor 的位置渲染一个可拖动的共享边手柄。
  function renderSharedEdges() {
    const combined = [];
    state.lyrics.forEach(region => combined.push({ kind: "lyric", region }));
    state.rests.forEach(region => combined.push({ kind: "rest", region }));
    combined.sort((a, b) => anchorStartSample(a.region) - anchorStartSample(b.region));
    for (let index = 1; index < combined.length; index += 1) {
      const previous = combined[index - 1].region;
      const current = combined[index].region;
      if (anchorEndSample(previous) === anchorStartSample(current)) {
        const anchorId = previous.endAnchorId;
        const seconds = sampleToSeconds(anchorEndSample(previous));
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "shared-edge-handle";
        handle.title = `共享边界 ${seconds.toFixed(3)} 秒 · 拖动会同时移动两侧区域`;
        handle.style.left = percentAt(seconds);
        handle.dataset.anchorId = anchorId;
        handle.addEventListener("pointerdown", event => beginEdgeDrag(event, anchorId));
        handle.addEventListener("keydown", event => nudgeEdge(event, anchorId));
        elements.lyricsLane.appendChild(handle);
      }
    }
  }

  function selectUnassignedGap(start, end) {
    state.selectedLyricId = null;
    state.selectedRestId = null;
    elements.restInspector.hidden = false;
    elements.restDetail.textContent = `未分配空段 ${start.toFixed(3)}–${end.toFixed(3)} 秒；可以转为显式休止，或保留作为留白。`;
    elements.convertRestButton.hidden = false;
    elements.deleteRestButton.hidden = true;
    elements.convertRestButton.onclick = () => convertSelectionToRest();
    hideLyricEditor();
    hideChordInspector();
    refreshLockToggle(elements.lockRestWrapper, elements.lockRestCheckbox, "rest", null);
    renderLyrics();
  }

  function editLyric(id) {
    const region = state.lyrics.find(item => item.id === id);
    if (!region) return;
    state.selectedLyricId = id;
    state.selectedRestId = null;
    elements.lyricLanguage.value = region.language;
    elements.lyricText.value = region.text;
    elements.cancelLyricEditButton.hidden = false;
    elements.deleteLyricButton.hidden = false;
    setSelection(anchorStartSeconds(region), anchorEndSeconds(region));
    elements.exactData.textContent = JSON.stringify({
      id: region.id,
      language: region.language,
      text: region.text,
      locked: isLocked("lyric", region.id),
      start_anchor: state.anchors.get(region.startAnchorId),
      end_anchor: state.anchors.get(region.endAnchorId),
    }, null, 2);
    hideRestInspector();
    hideChordInspector();
    refreshLockToggle(elements.lockLyricWrapper, elements.lockLyricCheckbox, "lyric", id);
    // P2：若该歌词区域没有 syllable，先派生默认切分；然后显示 syllable inspector。
    const hasSyllables = state.syllables.some(s => s.lyricId === id);
    if (!hasSyllables) {
      resplitSyllablesForRegion(region);
    }
    selectLyricForSyllableEdit(region);
    renderLyrics();
  }

  function editRest(id) {
    const rest = state.rests.find(item => item.id === id);
    if (!rest) return;
    state.selectedRestId = id;
    state.selectedLyricId = null;
    elements.restInspector.hidden = false;
    elements.deleteRestButton.hidden = false;
    elements.convertRestButton.hidden = true;
    const startSeconds = anchorStartSeconds(rest);
    const endSeconds = anchorEndSeconds(rest);
    elements.restDetail.textContent = `显式休止 ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒；删除后会恢复为未分配空段。`;
    elements.deleteRestButton.onclick = () => deleteRest(rest.id);
    setSelection(startSeconds, endSeconds);
    elements.exactData.textContent = JSON.stringify({
      id: rest.id,
      kind: rest.kind,
      locked: isLocked("rest", rest.id),
      start_anchor: state.anchors.get(rest.startAnchorId),
      end_anchor: state.anchors.get(rest.endAnchorId),
    }, null, 2);
    hideLyricEditor();
    hideChordInspector();
    refreshLockToggle(elements.lockRestWrapper, elements.lockRestCheckbox, "rest", id);
    renderLyrics();
  }

  function endLyricEdit(clearText = false) {
    state.selectedLyricId = null;
    elements.cancelLyricEditButton.hidden = true;
    elements.deleteLyricButton.hidden = true;
    if (clearText) elements.lyricText.value = "";
    refreshLockToggle(elements.lockLyricWrapper, elements.lockLyricCheckbox, "lyric", null);
    // P2：退出歌词编辑时隐藏 syllable inspector 并清除选中。
    state.selectedSyllableId = null;
    if (elements.syllableInspector) elements.syllableInspector.hidden = true;
    refreshLockToggle(elements.lockSyllableWrapper, elements.lockSyllableCheckbox, "syllable", null);
    renderLyrics();
  }

  function hideLyricEditor() {
    elements.cancelLyricEditButton.hidden = true;
    elements.deleteLyricButton.hidden = true;
    elements.lyricText.value = "";
    refreshLockToggle(elements.lockLyricWrapper, elements.lockLyricCheckbox, "lyric", null);
    // P2：隐藏 syllable inspector。
    if (elements.syllableInspector) elements.syllableInspector.hidden = true;
  }

  function hideRestInspector() {
    elements.restInspector.hidden = true;
    refreshLockToggle(elements.lockRestWrapper, elements.lockRestCheckbox, "rest", null);
  }

  function hideChordInspector() {
    elements.chordInspector.hidden = true;
    refreshLockToggle(elements.lockChordWrapper, elements.lockChordCheckbox, "chord", null);
  }

  function setSelection(start, end, announce = true, useSnap = false, bypassSnap = false) {
    if (!state.analysis) return;
    let safeStart = clamp(finiteNumber(start), 0, state.duration);
    let safeEnd = clamp(finiteNumber(end), 0, state.duration);
    if (useSnap) {
      safeStart = snapTime(safeStart, bypassSnap);
      safeEnd = snapTime(safeEnd, bypassSnap);
    }
    if (safeStart > safeEnd) [safeStart, safeEnd] = [safeEnd, safeStart];
    state.selection = { start: safeStart, end: safeEnd };
    elements.selectionStart.value = safeStart.toFixed(3);
    elements.selectionEnd.value = safeEnd.toFixed(3);
    renderSelection();
    if (announce && safeEnd > safeStart) setStatus(`选区：${safeStart.toFixed(3)}–${safeEnd.toFixed(3)} 秒。`, "success");
  }

  function renderSelection() {
    const { start, end } = state.selection;
    if (!state.analysis || end <= start) {
      elements.selectionOverlay.hidden = true;
      elements.selectionSummary.textContent = "尚未选择区域。";
      return;
    }
    elements.selectionOverlay.hidden = false;
    elements.selectionOverlay.style.left = percentAt(start);
    elements.selectionOverlay.style.width = percentAt(end - start);
    elements.selectionStartHandle.title = `开始 ${start.toFixed(3)} 秒；拖动或方向键调整`;
    elements.selectionEndHandle.title = `结束 ${end.toFixed(3)} 秒；拖动或方向键调整`;
    const chordLabels = (state.analysis.analysis.chords.windows || [])
      .filter(window => finiteNumber(window.end_seconds) > start && finiteNumber(window.start_seconds) < end)
      .map(window => effectiveChordLabel(window));
    elements.selectionSummary.textContent = `选区 ${start.toFixed(3)}–${end.toFixed(3)} 秒 · ${(end - start).toFixed(3)} 秒 · 和弦候选 ${chordLabels.join(" → ") || "无"}`;
  }

  function canvasColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      surface: style.getPropertyValue("--surface-soft").trim(),
      border: style.getPropertyValue("--border").trim(),
      accent: style.getPropertyValue("--accent").trim(),
      violet: style.getPropertyValue("--violet").trim(),
      muted: style.getPropertyValue("--muted").trim(),
    };
  }

  function renderCanvas() {
    if (!state.analysis) return;
    const rect = elements.waveformLane.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    elements.canvas.width = Math.round(width * dpr);
    elements.canvas.height = Math.round(height * dpr);
    const context = elements.canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = canvasColors();
    context.fillStyle = colors.surface;
    context.fillRect(0, 0, width, height);

    if (state.layers.beats) {
      const tempo = state.analysis.analysis.tempo && state.analysis.analysis.tempo.candidates && state.analysis.analysis.tempo.candidates[0];
      if (tempo && finiteNumber(tempo.bpm) > 0) {
        const step = 60 / finiteNumber(tempo.bpm);
        const first = finiteNumber(tempo.first_beat_seconds);
        context.strokeStyle = colors.border;
        context.lineWidth = 1;
        const estimatedLineCount = Math.max(0, Math.floor((state.duration - first) / step) + 1);
        const maximumLines = Math.min(10000, Math.max(1, Math.floor(width / 2)));
        const stride = Math.max(1, Math.ceil(estimatedLineCount / maximumLines));
        for (let index = 0; index < estimatedLineCount; index += stride) {
          const time = first + index * step;
          const x = time / state.duration * width;
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, height);
          context.stroke();
        }
      }
    }

    if (state.layers.waveform) {
      const bins = state.analysis.analysis.waveform.bins || [];
      context.strokeStyle = colors.accent;
      context.lineWidth = Math.max(1, width / Math.max(1, bins.length) * 0.58);
      bins.forEach(bin => {
        const x = finiteNumber(bin.start_seconds) / state.duration * width;
        const minimum = clamp(finiteNumber(bin.minimum), -1, 1);
        const maximum = clamp(finiteNumber(bin.maximum), -1, 1);
        context.beginPath();
        context.moveTo(x, height * (0.5 - maximum * 0.44));
        context.lineTo(x, height * (0.5 - minimum * 0.44));
        context.stroke();
      });
    }

    if (state.layers.energy) {
      const bins = state.analysis.analysis.short_time_energy.bins || [];
      const usable = bins.filter(bin => finiteNumber(bin.rms_dbfs, -120) > -119.9);
      if (usable.length) {
        context.strokeStyle = colors.violet;
        context.lineWidth = 2;
        context.beginPath();
        usable.forEach((bin, index) => {
          const x = ((finiteNumber(bin.start_seconds) + finiteNumber(bin.end_seconds)) / 2) / state.duration * width;
          const normalized = clamp((finiteNumber(bin.rms_dbfs, -120) + 60) / 60, 0, 1);
          const y = height - 8 - normalized * height * 0.34;
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        });
        context.stroke();
      }
    }
  }

  function renderLayerVisibility() {
    document.querySelector('[data-track="sections"]').hidden = !state.layers.sections;
    document.querySelector('[data-track="chords"]').hidden = !state.layers.chords;
  }

  // ---- Stem 混音器渲染 --------------------------------------------------------
  // 每轨显示：名字、角色徽章、Mute/Solo 按钮、Gain 滑块、Pan 滑块、数值。
  // master 标记为"主输出"，其他标记为"占位 stem"，提示用户未接入分离后端。
  // 渲染只更新数值与按钮状态，控件本身（input/button）不重建，避免拖动时丢失焦点。
  function renderStemMixer() {
    if (!elements.stemMixer) return;
    const container = elements.stemMixer;
    if (container.children.length !== state.stemTracks.length) {
      clearElement(container);
      state.stemTracks.forEach(track => container.appendChild(buildStemRow(track)));
    }
    state.stemTracks.forEach((track, index) => {
      const row = container.children[index];
      if (!row) return;
      row.dataset.trackId = track.id;
      const { muted } = stemEffectiveState(track);
      const muteButton = row.querySelector('[data-stem-control="mute"]');
      const soloButton = row.querySelector('[data-stem-control="solo"]');
      const gainInput = row.querySelector('[data-stem-control="gain"]');
      const panInput = row.querySelector('[data-stem-control="pan"]');
      const gainValue = row.querySelector('[data-stem-readout="gain"]');
      const panValue = row.querySelector('[data-stem-readout="pan"]');
      const statusBadge = row.querySelector('[data-stem-readout="status"]');
      if (muteButton) {
        muteButton.setAttribute("aria-pressed", String(track.mute));
        muteButton.classList.toggle("active", track.mute);
        muteButton.textContent = track.mute ? "已静音" : "静音";
      }
      if (soloButton) {
        soloButton.setAttribute("aria-pressed", String(track.solo));
        soloButton.classList.toggle("active", track.solo);
        soloButton.textContent = track.solo ? "独奏中" : "独奏";
      }
      if (gainInput) gainInput.value = String(track.gain);
      if (panInput) panInput.value = String(track.pan);
      if (gainValue) gainValue.textContent = `${(track.gain * 100).toFixed(0)}%`;
      if (panValue) {
        const percent = Math.round(track.pan * 100);
        if (percent === 0) panValue.textContent = "中";
        else if (percent < 0) panValue.textContent = `L ${Math.abs(percent)}`;
        else panValue.textContent = `R ${percent}`;
      }
      if (statusBadge) {
        if (track.source === "main") {
          statusBadge.textContent = muted ? "主输出 · 静音" : "主输出";
        } else {
          statusBadge.textContent = muted ? "占位 · 静音" : "占位 stem";
        }
      }
      row.classList.toggle("muted", muted);
      row.classList.toggle("soloed", track.solo);
    });
  }

  function buildStemRow(track) {
    const row = document.createElement("div");
    row.className = "stem-row";
    row.dataset.trackId = track.id;
    if (track.source === "main") row.classList.add("stem-master");
    else row.classList.add("stem-placeholder");

    const header = document.createElement("div");
    header.className = "stem-header";
    const name = document.createElement("span");
    name.className = "stem-name";
    name.textContent = track.name;
    const role = document.createElement("span");
    role.className = "stem-role";
    role.textContent = track.role;
    header.appendChild(name);
    header.appendChild(role);
    row.appendChild(header);

    const controls = document.createElement("div");
    controls.className = "stem-controls";

    const muteButton = document.createElement("button");
    muteButton.type = "button";
    muteButton.dataset.stemControl = "mute";
    muteButton.setAttribute("aria-pressed", String(track.mute));
    muteButton.textContent = track.mute ? "已静音" : "静音";
    controls.appendChild(muteButton);

    const soloButton = document.createElement("button");
    soloButton.type = "button";
    soloButton.dataset.stemControl = "solo";
    soloButton.setAttribute("aria-pressed", String(track.solo));
    soloButton.textContent = track.solo ? "独奏中" : "独奏";
    controls.appendChild(soloButton);

    const gainLabel = document.createElement("label");
    gainLabel.className = "stem-slider";
    const gainCaption = document.createElement("span");
    gainCaption.className = "stem-caption";
    gainCaption.textContent = "音量";
    const gainInput = document.createElement("input");
    gainInput.type = "range";
    gainInput.min = "0";
    gainInput.max = "1.5";
    gainInput.step = "0.01";
    gainInput.value = String(track.gain);
    gainInput.dataset.stemControl = "gain";
    const gainValue = document.createElement("span");
    gainValue.className = "stem-value";
    gainValue.dataset.stemReadout = "gain";
    gainValue.textContent = `${(track.gain * 100).toFixed(0)}%`;
    gainLabel.appendChild(gainCaption);
    gainLabel.appendChild(gainInput);
    gainLabel.appendChild(gainValue);
    controls.appendChild(gainLabel);

    const panLabel = document.createElement("label");
    panLabel.className = "stem-slider";
    const panCaption = document.createElement("span");
    panCaption.className = "stem-caption";
    panCaption.textContent = "声像";
    const panInput = document.createElement("input");
    panInput.type = "range";
    panInput.min = "-1";
    panInput.max = "1";
    panInput.step = "0.01";
    panInput.value = String(track.pan);
    panInput.dataset.stemControl = "pan";
    const panValue = document.createElement("span");
    panValue.className = "stem-value";
    panValue.dataset.stemReadout = "pan";
    const panPercent = Math.round(track.pan * 100);
    panValue.textContent = panPercent === 0 ? "中" : (panPercent < 0 ? `L ${Math.abs(panPercent)}` : `R ${panPercent}`);
    panLabel.appendChild(panCaption);
    panLabel.appendChild(panInput);
    panLabel.appendChild(panValue);
    controls.appendChild(panLabel);

    // P1.2 轮 4：非破坏混音参数。trim 是首尾裁切秒数；fade 是淡入淡出秒数。
    // 在所有 stem 上都呈现参数 UI（占位 stem 也保存参数，等接入分离后端时复用）。
    const trimGroup = document.createElement("div");
    trimGroup.className = "stem-number-group";
    const trimStartLabel = document.createElement("label");
    trimStartLabel.className = "stem-number";
    const trimStartCaption = document.createElement("span");
    trimStartCaption.textContent = "裁切起（秒）";
    trimStartLabel.appendChild(trimStartCaption);
    const trimStartInput = document.createElement("input");
    trimStartInput.type = "number";
    trimStartInput.min = "0";
    trimStartInput.step = "0.01";
    trimStartInput.value = String(track.trimStartSeconds);
    trimStartInput.dataset.stemControl = "trimStartSeconds";
    trimStartLabel.appendChild(trimStartInput);
    trimGroup.appendChild(trimStartLabel);
    const trimEndLabel = document.createElement("label");
    trimEndLabel.className = "stem-number";
    const trimEndCaption = document.createElement("span");
    trimEndCaption.textContent = "裁切止（秒）";
    trimEndLabel.appendChild(trimEndCaption);
    const trimEndInput = document.createElement("input");
    trimEndInput.type = "number";
    trimEndInput.min = "0";
    trimEndInput.step = "0.01";
    trimEndInput.value = String(track.trimEndSeconds);
    trimEndInput.dataset.stemControl = "trimEndSeconds";
    trimEndLabel.appendChild(trimEndInput);
    trimGroup.appendChild(trimEndLabel);
    controls.appendChild(trimGroup);

    const fadeGroup = document.createElement("div");
    fadeGroup.className = "stem-number-group";
    const fadeInLabel = document.createElement("label");
    fadeInLabel.className = "stem-number";
    const fadeInCaption = document.createElement("span");
    fadeInCaption.textContent = "淡入（秒）";
    fadeInLabel.appendChild(fadeInCaption);
    const fadeInInput = document.createElement("input");
    fadeInInput.type = "number";
    fadeInInput.min = "0";
    fadeInInput.step = "0.01";
    fadeInInput.value = String(track.fadeInSeconds);
    fadeInInput.dataset.stemControl = "fadeInSeconds";
    fadeInLabel.appendChild(fadeInInput);
    fadeGroup.appendChild(fadeInLabel);
    const fadeOutLabel = document.createElement("label");
    fadeOutLabel.className = "stem-number";
    const fadeOutCaption = document.createElement("span");
    fadeOutCaption.textContent = "淡出（秒）";
    fadeOutLabel.appendChild(fadeOutCaption);
    const fadeOutInput = document.createElement("input");
    fadeOutInput.type = "number";
    fadeOutInput.min = "0";
    fadeOutInput.step = "0.01";
    fadeOutInput.value = String(track.fadeOutSeconds);
    fadeOutInput.dataset.stemControl = "fadeOutSeconds";
    fadeOutLabel.appendChild(fadeOutInput);
    fadeGroup.appendChild(fadeOutLabel);
    controls.appendChild(fadeGroup);

    const status = document.createElement("span");
    status.className = "stem-status";
    status.dataset.stemReadout = "status";
    status.textContent = track.source === "main" ? "主输出" : "占位 stem";
    controls.appendChild(status);

    row.appendChild(controls);
    return row;
  }

  // 用户操作 stem 控件时统一入口：先记录撤销点，再更新数据，再应用混音与渲染。
  function updateStemField(trackId, field, value) {
    const track = state.stemTracks.find(item => item.id === trackId);
    if (!track) return;
    const oldValue = track[field];
    if (oldValue === value) return;
    editGraph.begin(`调整 stem ${track.name} 的 ${field}`);
    track[field] = value;
    applyStemMix();
    renderStemMixer();
    setStatus(`已调整 ${track.name} 的 ${field}：${formatStemFieldValue(field, value)}。`, "success");
  }

  function formatStemFieldValue(field, value) {
    if (field === "mute" || field === "solo") return value ? "开" : "关";
    if (field === "gain") return `${Math.round(value * 100)}%`;
    if (field === "pan") {
      const percent = Math.round(value * 100);
      return percent === 0 ? "中" : (percent < 0 ? `L ${Math.abs(percent)}` : `R ${percent}`);
    }
    if (field === "trimStartSeconds" || field === "trimEndSeconds" || field === "fadeInSeconds" || field === "fadeOutSeconds") {
      return `${value.toFixed(3)} 秒`;
    }
    return String(value);
  }

  // ---- NoteEvent 数据模型（P1.2 轮 2）-----------------------------------------
  // 每个 note 引用 start/end anchor（与歌词/休止共享时间模型），
  // 浮点 pitch（60 = C4），velocity 0..1，confidence 0..1，
  // source 标注来源（manual / transcription / generation）。
  // 第一版所有音符都是用户手工创建或后续从转录后端导入；这里只负责 CRUD 与渲染。

  function createNote(stemId, startSample, endSample, pitch, velocity = 0.8, source = "manual") {
    if (!state.tempoMap) return null;
    const safeStart = Math.max(0, Math.min(Math.round(startSample), Math.round(state.duration * state.sampleRateHz)));
    const safeEnd = Math.max(safeStart + 1, Math.min(Math.round(endSample), Math.round(state.duration * state.sampleRateHz)));
    const safePitch = clamp(Math.round(pitch), PIANO_ROLL_MIN_PITCH, PIANO_ROLL_MAX_PITCH);
    const startAnchor = findAnchorBySample(safeStart) || createAnchorAtSample(safeStart);
    const endAnchor = findAnchorBySample(safeEnd) || createAnchorAtSample(safeEnd);
    let identifier;
    do {
      identifier = `note-${state.nextNoteId++}`;
    } while (state.notes.some(note => note.id === identifier));
    const note = {
      id: identifier,
      stemId: stemId || "master",
      startAnchorId: startAnchor.id,
      endAnchorId: endAnchor.id,
      pitch: safePitch,
      velocity: clamp(velocity, 0, 1),
      confidence: source === "manual" ? 1 : 0,
      source,
    };
    state.notes.push(note);
    return note;
  }

  function deleteNote(id) {
    const note = state.notes.find(item => item.id === id);
    if (!note) return;
    editGraph.begin(`删除音符 ${id}`);
    state.notes = state.notes.filter(item => item.id !== id);
    if (state.selectedNoteId === id) state.selectedNoteId = null;
    if (state.pianoRollMergeCandidateId === id) state.pianoRollMergeCandidateId = null;
    pruneAnchors();
    renderPianoRoll();
    updatePianoRollToolButtons();
    setStatus(`已删除音符 ${id}。`, "success");
  }

  // 选中音符；additive=true 时把当前 click 视为"合并候选"选择（Shift 修饰）。
  function selectNote(id, additive = false) {
    if (additive && state.selectedNoteId && id !== state.selectedNoteId) {
      state.pianoRollMergeCandidateId = id;
    } else {
      state.selectedNoteId = id;
      if (!additive) state.pianoRollMergeCandidateId = null;
    }
    const note = state.notes.find(item => item.id === id);
    if (note) {
      const startSeconds = anchorStartSeconds(note);
      const endSeconds = anchorEndSeconds(note);
      setSelection(startSeconds, endSeconds, false);
      setStatus(`已选中音符 ${id}：${midiToNoteName(note.pitch)} · ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒。`, "success");
    }
    renderPianoRoll();
    updatePianoRollToolButtons();
  }

  function splitSelectedNote() {
    if (!state.selectedNoteId) return;
    const note = state.notes.find(item => item.id === state.selectedNoteId);
    if (!note) return;
    const startSample = anchorStartSample(note);
    const endSample = anchorEndSample(note);
    const midSample = Math.round((startSample + endSample) / 2);
    if (endSample - startSample < 2) {
      setStatus("音符太短，无法拆分。", "error");
      return;
    }
    editGraph.begin(`拆分音符 ${note.id}`);
    // 把当前音符的 end 缩到中点，再创建一个新音符从中点到原 end。
    const midAnchor = findAnchorBySample(midSample) || createAnchorAtSample(midSample);
    note.endAnchorId = midAnchor.id;
    const newNote = createNote(note.stemId, midSample, endSample, note.pitch, note.velocity, note.source);
    state.selectedNoteId = newNote ? newNote.id : note.id;
    state.pianoRollMergeCandidateId = null;
    pruneAnchors();
    renderPianoRoll();
    updatePianoRollToolButtons();
    setStatus(`已拆分音符 ${note.id} → ${note.id} + ${newNote ? newNote.id : "?"}。`, "success");
  }

  function mergeSelectedNotes() {
    if (!state.selectedNoteId || !state.pianoRollMergeCandidateId) return;
    if (state.selectedNoteId === state.pianoRollMergeCandidateId) return;
    const a = state.notes.find(item => item.id === state.selectedNoteId);
    const b = state.notes.find(item => item.id === state.pianoRollMergeCandidateId);
    if (!a || !b) return;
    if (a.pitch !== b.pitch) {
      setStatus("只有音高相同的音符才能合并。", "error");
      return;
    }
    let first, second;
    if (anchorStartSample(a) < anchorStartSample(b)) {
      first = a; second = b;
    } else {
      first = b; second = a;
    }
    if (Math.abs(anchorEndSample(first) - anchorStartSample(second)) > Math.round(ANCHOR_TOLERANCE_SECONDS * state.sampleRateHz)) {
      setStatus("只有时间相邻的音符才能合并。", "error");
      return;
    }
    editGraph.begin(`合并音符 ${first.id} 与 ${second.id}`);
    first.endAnchorId = second.endAnchorId;
    state.notes = state.notes.filter(item => item.id !== second.id);
    state.selectedNoteId = first.id;
    state.pianoRollMergeCandidateId = null;
    pruneAnchors();
    renderPianoRoll();
    updatePianoRollToolButtons();
    setStatus(`已合并音符 → ${first.id}。`, "success");
  }

  // 量化选中音符（P1.2 轮 3）：把起止 sample 对齐到当前 snap 网格。
  // 网格关闭时不做任何改动；调用前先 detach 共享 anchor，保持邻居不动。
  function quantizeSelectedNote() {
    if (!state.selectedNoteId) return;
    const note = state.notes.find(item => item.id === state.selectedNoteId);
    if (!note) return;
    if (!snapIntervalSeconds()) {
      setStatus("吸附网格已关闭，无法量化；请先选择 1 拍 / 1/2 拍 / 1/4 拍 / 1/8 拍 / 三连音之一。", "error");
      return;
    }
    const startSample = anchorStartSample(note);
    const endSample = anchorEndSample(note);
    const newStartSample = quantizeSample(startSample);
    const newEndSample = Math.max(newStartSample + 1, quantizeSample(endSample));
    if (newStartSample === startSample && newEndSample === endSample) {
      setStatus(`音符 ${note.id} 已在网格上，无需量化。`, "success");
      return;
    }
    editGraph.begin(`量化音符 ${note.id}`);
    detachNoteAnchorIfShared(note, "start");
    detachNoteAnchorIfShared(note, "end");
    moveAnchor(note.startAnchorId, newStartSample);
    moveAnchor(note.endAnchorId, newEndSample);
    pruneAnchors();
    renderPianoRoll();
    updatePianoRollToolButtons();
    setStatus(`已量化音符 ${note.id} → ${anchorStartSeconds(note).toFixed(3)}–${anchorEndSeconds(note).toFixed(3)} 秒。`, "success");
  }

  // 钢琴卷帘工具按钮可用性：拆分需要选中；合并需要选中 + 候选；量化与删除需要选中。
  function updatePianoRollToolButtons() {
    const hasSelection = Boolean(state.selectedNoteId);
    const hasMergeCandidate = Boolean(state.pianoRollMergeCandidateId) && state.pianoRollMergeCandidateId !== state.selectedNoteId;
    if (elements.splitNoteButton) elements.splitNoteButton.disabled = !hasSelection;
    if (elements.mergeNoteButton) elements.mergeNoteButton.disabled = !(hasSelection && hasMergeCandidate);
    if (elements.quantizeNoteButton) elements.quantizeNoteButton.disabled = !hasSelection;
    if (elements.deleteNoteButton) elements.deleteNoteButton.disabled = !hasSelection;
  }

  // ---- 钢琴卷帘渲染 -----------------------------------------------------------
  // 横向是时间（与时间轴共用 timelineWidth），纵向是音高（C2..C7，60 半音）。
  // canvas 渲染音高网格（黑白键、C 标记），DOM 渲染音符块（便于拖动交互）。
  function renderPianoRoll() {
    if (!elements.pianoRollContent) return;
    const width = Math.max(timelineWidth(), 640);
    elements.pianoRollContent.style.width = `${width}px`;
    const height = (PIANO_ROLL_MAX_PITCH - PIANO_ROLL_MIN_PITCH + 1) * PIANO_ROLL_ROW_HEIGHT;
    elements.pianoRollContent.style.height = `${height}px`;
    drawPianoRollCanvas(width, height);
    // 重建音符块（保留 canvas，清空 grid 后重建）
    const grid = elements.pianoRollGrid;
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    state.notes.forEach(note => {
      const block = buildNoteBlock(note);
      if (block) grid.appendChild(block);
    });
    // 同步播放头
    if (state.audioUrl && state.analysis) {
      const playhead = document.createElement("div");
      playhead.className = "piano-roll-playhead";
      playhead.style.left = percentAt(elements.audio.currentTime);
      grid.appendChild(playhead);
    }
  }

  function drawPianoRollCanvas(width, height) {
    const canvas = elements.pianoRollCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(document.documentElement);
    const surface = style.getPropertyValue("--surface-soft").trim() || "#f8f9fc";
    const border = style.getPropertyValue("--border").trim() || "#d7dce5";
    const muted = style.getPropertyValue("--muted").trim() || "#667085";
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, width, height);
    for (let midi = PIANO_ROLL_MIN_PITCH; midi <= PIANO_ROLL_MAX_PITCH; midi += 1) {
      const y = (PIANO_ROLL_MAX_PITCH - midi) * PIANO_ROLL_ROW_HEIGHT;
      if (isBlackKey(midi)) {
        ctx.fillStyle = "rgba(0,0,0,0.06)";
        ctx.fillRect(0, y, width, PIANO_ROLL_ROW_HEIGHT);
      }
      if (midi % 12 === 0) {
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + PIANO_ROLL_ROW_HEIGHT);
        ctx.lineTo(width, y + PIANO_ROLL_ROW_HEIGHT);
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(midiToNoteName(midi), 4, y + PIANO_ROLL_ROW_HEIGHT - 3);
      }
    }
    if (state.analysis && state.duration > 0) {
      // P1.2 轮 3：垂直网格按当前 snap 网格绘制（含附点与 Swing）。
      // 无 snap 时回退到固定秒数网格；有 snap 时按网格点画，swing 偏移的奇数点用更浅色。
      const interval = snapIntervalSeconds();
      const tempo = topTempoCandidate();
      ctx.lineWidth = 1;
      if (interval > 0 && tempo) {
        const origin = finiteNumber(tempo.first_beat_seconds);
        const totalGrids = Math.ceil((state.duration - origin) / interval) + 2;
        for (let i = -1; i <= totalGrids; i += 1) {
          const baseTime = origin + i * interval;
          if (baseTime < -0.001 || baseTime > state.duration + 0.001) continue;
          const swingOffset = swingOffsetForIndex(i, interval);
          const time = baseTime + swingOffset;
          if (time < -0.001 || time > state.duration + 0.001) continue;
          const x = (time / state.duration) * width;
          // 偶数（含 0）= 强线，奇数 + 无 swing = 中等线，奇数 + swing = 浅线
          const isStrong = i % 2 === 0;
          const isSwung = swingOffset > 0;
          ctx.strokeStyle = isStrong ? border : (isSwung ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.28)");
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      } else {
        const targetSpacing = 86;
        const rawStep = state.duration / Math.max(1, Math.floor(width / targetSpacing));
        const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
        const step = candidates.find(value => value >= rawStep) || 120;
        ctx.strokeStyle = border;
        for (let time = 0; time <= state.duration + 1e-6; time += step) {
          const x = (time / state.duration) * width;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      }
    }
  }

  function buildNoteBlock(note) {
    const startSample = anchorStartSample(note);
    const endSample = anchorEndSample(note);
    const startSeconds = sampleToSeconds(startSample);
    const endSeconds = sampleToSeconds(endSample);
    if (endSeconds <= startSeconds) return null;
    const block = document.createElement("button");
    block.type = "button";
    block.className = "piano-roll-note";
    block.dataset.noteId = note.id;
    block.textContent = midiToNoteName(note.pitch);
    block.title = `${note.id} · ${midiToNoteName(note.pitch)} · ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · velocity ${(note.velocity * 100).toFixed(0)}% · 来源 ${note.source}`;
    block.style.left = percentAt(startSeconds);
    block.style.width = percentAt(Math.max(0, endSeconds - startSeconds));
    block.style.top = `${(PIANO_ROLL_MAX_PITCH - note.pitch) * PIANO_ROLL_ROW_HEIGHT}px`;
    block.style.height = `${PIANO_ROLL_ROW_HEIGHT - 1}px`;
    if (state.selectedNoteId === note.id) block.classList.add("selected");
    if (state.pianoRollMergeCandidateId === note.id) block.classList.add("merge-candidate");
    if (note.source === "transcription") block.classList.add("source-transcription");
    else if (note.source === "generation") block.classList.add("source-generation");
    block.addEventListener("pointerdown", event => beginNoteDrag(event, note));
    return block;
  }

  // ---- 钢琴卷帘交互 -----------------------------------------------------------
  // 行为：
  //   - 在空白区域 pointerdown + 拖动 → 创建新音符（吸附起止）
  //   - 在音符上 pointerdown 中间 → move 模式（整体移动）
  //   - 在音符上 pointerdown 左 8px → stretch-start
  //   - 在音符上 pointerdown 右 8px → stretch-end
  //   - 移动距离 < 4px 视为点击 → 选中（Shift 则设为合并候选）
  //   - 若被移动的 anchor 与其他对象共享，先克隆一个新 anchor 给当前音符。
  function beginNoteDrag(event, note) {
    if (!state.analysis || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetLeft = event.clientX - rect.left;
    const offsetRight = rect.right - event.clientX;
    const edgeTolerance = 8;
    let mode;
    if (offsetLeft <= edgeTolerance) mode = "stretch-start";
    else if (offsetRight <= edgeTolerance) mode = "stretch-end";
    else mode = "move";
    state.noteDrag = {
      noteId: note.id,
      mode,
      startClientX: event.clientX,
      startStartSample: anchorStartSample(note),
      startEndSample: anchorEndSample(note),
      startPitch: note.pitch,
      originalStartAnchorId: note.startAnchorId,
      originalEndAnchorId: note.endAnchorId,
      beganEdit: false,
      detachedStart: false,
      detachedEnd: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.addEventListener("pointermove", moveNote, true);
    document.addEventListener("pointerup", endNoteDrag, true);
    document.addEventListener("pointercancel", cancelNoteDrag, true);
  }

  function detachNoteAnchorIfShared(note, which) {
    const anchorId = which === "start" ? note.startAnchorId : note.endAnchorId;
    const sharedByNote = state.notes.some(other => other.id !== note.id && (other.startAnchorId === anchorId || other.endAnchorId === anchorId));
    const sharedByLyric = state.lyrics.some(r => r.startAnchorId === anchorId || r.endAnchorId === anchorId);
    const sharedByRest = state.rests.some(r => r.startAnchorId === anchorId || r.endAnchorId === anchorId);
    if (!sharedByNote && !sharedByLyric && !sharedByRest) return false;
    const original = state.anchors.get(anchorId);
    if (!original) return false;
    const cloned = createAnchorAtSample(original.sample);
    if (which === "start") {
      note.startAnchorId = cloned.id;
      state.noteDrag.detachedStart = true;
    } else {
      note.endAnchorId = cloned.id;
      state.noteDrag.detachedEnd = true;
    }
    return true;
  }

  function moveNote(event) {
    if (!state.noteDrag) return;
    if (state.noteDrag.mode === "create") return; // create 模式由 moveNoteCreate 处理
    if (Math.abs(event.clientX - state.noteDrag.startClientX) < 4 && !state.noteDrag.beganEdit) return;
    const note = state.notes.find(item => item.id === state.noteDrag.noteId);
    if (!note) return;
    if (!state.noteDrag.beganEdit) {
      editGraph.begin(state.noteDrag.mode === "move" ? `拖动音符 ${note.id}` : `拉伸音符 ${note.id}`);
      state.noteDrag.beganEdit = true;
      if (state.noteDrag.mode === "move" || state.noteDrag.mode === "stretch-start") {
        detachNoteAnchorIfShared(note, "start");
      }
      if (state.noteDrag.mode === "move" || state.noteDrag.mode === "stretch-end") {
        detachNoteAnchorIfShared(note, "end");
      }
    }
    event.preventDefault();
    event.stopPropagation();
    const pointerTime = snapTime(timeFromPianoPointer(event), event.altKey);
    const pointerSample = secondsToSample(pointerTime);
    const minSample = 0;
    const maxSample = Math.round(state.duration * state.sampleRateHz);
    const minimum = event.altKey ? 1 : Math.max(1, Math.round((snapIntervalSeconds() || 0.001) * state.sampleRateHz));
    if (state.noteDrag.mode === "move") {
      const durationSamples = state.noteDrag.startEndSample - state.noteDrag.startStartSample;
      const newStart = Math.max(minSample, Math.min(maxSample - durationSamples, pointerSample - Math.round(durationSamples / 2)));
      moveAnchor(note.startAnchorId, newStart);
      moveAnchor(note.endAnchorId, newStart + durationSamples);
    } else if (state.noteDrag.mode === "stretch-start") {
      const endSample = anchorEndSample(note);
      const newStart = Math.max(minSample, Math.min(endSample - minimum, pointerSample));
      moveAnchor(note.startAnchorId, newStart);
    } else if (state.noteDrag.mode === "stretch-end") {
      const startSample = anchorStartSample(note);
      const newEnd = Math.max(startSample + minimum, Math.min(maxSample, pointerSample));
      moveAnchor(note.endAnchorId, newEnd);
    }
    setSelection(anchorStartSeconds(note), anchorEndSeconds(note), false);
    renderPianoRoll();
  }

  function endNoteDrag(event) {
    if (!state.noteDrag) return;
    if (state.noteDrag.mode === "create") return;
    event.preventDefault();
    event.stopPropagation();
    const drag = state.noteDrag;
    state.noteDrag = null;
    document.removeEventListener("pointermove", moveNote, true);
    document.removeEventListener("pointerup", endNoteDrag, true);
    document.removeEventListener("pointercancel", cancelNoteDrag, true);
    if (!drag.beganEdit) {
      // 视为点击：选中音符（Shift 则设为合并候选）
      selectNote(drag.noteId, event.shiftKey);
      return;
    }
    pruneAnchors();
    const note = state.notes.find(item => item.id === drag.noteId);
    if (note) {
      setStatus(`${drag.mode === "move" ? "音符已移动到" : "音符已拉伸到"} ${anchorStartSeconds(note).toFixed(3)}–${anchorEndSeconds(note).toFixed(3)} 秒。`, "success");
    }
  }

  function cancelNoteDrag() {
    if (!state.noteDrag) return;
    if (state.noteDrag.mode === "create") return;
    const drag = state.noteDrag;
    state.noteDrag = null;
    document.removeEventListener("pointermove", moveNote, true);
    document.removeEventListener("pointerup", endNoteDrag, true);
    document.removeEventListener("pointercancel", cancelNoteDrag, true);
    if (drag.beganEdit) {
      editGraph.undoStack.pop();
      updateUndoRedoButtons();
    }
    const note = state.notes.find(item => item.id === drag.noteId);
    if (note) {
      if (drag.detachedStart) note.startAnchorId = drag.originalStartAnchorId;
      if (drag.detachedEnd) note.endAnchorId = drag.originalEndAnchorId;
    }
    pruneAnchors();
    renderPianoRoll();
    setStatus("系统取消了音符拖动，已恢复原位置。", "success");
  }

  // 钢琴卷帘空白处 pointerdown + 拖动 = 创建新音符。
  function beginNoteCreate(event) {
    if (!state.analysis || event.button !== 0) return;
    // 只在 grid 本体或 canvas（透明区域）响应，避免点音符也触发
    if (event.target !== elements.pianoRollGrid && event.target !== elements.pianoRollCanvas) return;
    event.preventDefault();
    event.stopPropagation();
    const startTime = snapTime(timeFromPianoPointer(event), event.altKey);
    const pitch = pitchFromPianoPointer(event);
    state.noteDrag = {
      noteId: null,
      mode: "create",
      startClientX: event.clientX,
      startTime,
      startPitch: pitch,
      currentEnd: startTime,
      beganEdit: false,
    };
    document.addEventListener("pointermove", moveNoteCreate, true);
    document.addEventListener("pointerup", endNoteCreate, true);
    document.addEventListener("pointercancel", cancelNoteCreate, true);
  }

  function moveNoteCreate(event) {
    if (!state.noteDrag || state.noteDrag.mode !== "create") return;
    event.preventDefault();
    const endTime = snapTime(timeFromPianoPointer(event), event.altKey);
    state.noteDrag.currentEnd = endTime;
    const existing = document.getElementById("piano-roll-note-preview");
    if (existing) existing.remove();
    const preview = document.createElement("div");
    preview.id = "piano-roll-note-preview";
    preview.className = "piano-roll-note preview";
    const startSec = Math.min(state.noteDrag.startTime, endTime);
    const endSec = Math.max(state.noteDrag.startTime, endTime);
    preview.style.left = percentAt(startSec);
    preview.style.width = percentAt(Math.max(0, endSec - startSec));
    preview.style.top = `${(PIANO_ROLL_MAX_PITCH - state.noteDrag.startPitch) * PIANO_ROLL_ROW_HEIGHT}px`;
    preview.style.height = `${PIANO_ROLL_ROW_HEIGHT - 1}px`;
    elements.pianoRollGrid.appendChild(preview);
  }

  function endNoteCreate(event) {
    if (!state.noteDrag || state.noteDrag.mode !== "create") return;
    event.preventDefault();
    const drag = state.noteDrag;
    state.noteDrag = null;
    document.removeEventListener("pointermove", moveNoteCreate, true);
    document.removeEventListener("pointerup", endNoteCreate, true);
    document.removeEventListener("pointercancel", cancelNoteCreate, true);
    const preview = document.getElementById("piano-roll-note-preview");
    if (preview) preview.remove();
    const startSec = Math.min(drag.startTime, drag.currentEnd);
    const endSec = Math.max(drag.startTime, drag.currentEnd);
    if (endSec - startSec < 0.02) {
      setStatus("音符太短，未创建。", "error");
      return;
    }
    editGraph.begin("新建音符");
    const note = createNote(state.pianoRollStemId, secondsToSample(startSec), secondsToSample(endSec), drag.startPitch);
    if (note) {
      state.selectedNoteId = note.id;
      state.pianoRollMergeCandidateId = null;
      renderPianoRoll();
      updatePianoRollToolButtons();
      setStatus(`已创建音符 ${note.id}：${midiToNoteName(note.pitch)} · ${startSec.toFixed(3)}–${endSec.toFixed(3)} 秒。`, "success");
    }
  }

  function cancelNoteCreate() {
    if (!state.noteDrag || state.noteDrag.mode !== "create") return;
    state.noteDrag = null;
    document.removeEventListener("pointermove", moveNoteCreate, true);
    document.removeEventListener("pointerup", endNoteCreate, true);
    document.removeEventListener("pointercancel", cancelNoteCreate, true);
    const preview = document.getElementById("piano-roll-note-preview");
    if (preview) preview.remove();
  }

  function timeFromPianoPointer(event) {
    const rect = elements.pianoRollContent.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / Math.max(1, rect.width) * state.duration, 0, state.duration);
  }

  function pitchFromPianoPointer(event) {
    const rect = elements.pianoRollContent.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const rowIndex = Math.floor(y / PIANO_ROLL_ROW_HEIGHT);
    const pitch = PIANO_ROLL_MAX_PITCH - rowIndex;
    return clamp(pitch, PIANO_ROLL_MIN_PITCH, PIANO_ROLL_MAX_PITCH);
  }

  function renderAll() {
    if (!state.analysis) return;
    setTimelineGeometry();
    renderRuler();
    renderSections();
    renderChords();
    renderLyrics();
    renderCanvas();
    renderSelection();
    renderLayerVisibility();
    renderStemMixer();
    applyStemMix();
    renderPianoRoll();
    updatePianoRollToolButtons();
    // P2：渲染 syllable inspector（若选中了歌词区域）。
    if (state.selectedLyricId) {
      const region = state.lyrics.find(r => r.id === state.selectedLyricId);
      if (region) selectLyricForSyllableEdit(region);
    } else if (elements.syllableInspector) {
      elements.syllableInspector.hidden = true;
    }
    updateTransport();
  }

  function timeFromPointer(event) {
    const rect = elements.waveformLane.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / Math.max(1, rect.width) * state.duration, 0, state.duration);
  }

  function updateTransport() {
    const current = finiteNumber(elements.audio.currentTime);
    elements.playTime.textContent = `${formatTime(current)} / ${formatTime(state.duration)}`;
    if (state.audioUrl) {
      elements.playhead.hidden = false;
      elements.playhead.style.left = percentAt(current);
      // 播放时自动滚动跟随播放头，避免播放头跑出视口右侧。
      // 用户最近 1.5 秒内手动滚动过则暂停自动跟随，让用户能自由定位。
      if (!elements.audio.paused && state.analysis) {
        autoScrollToPlayhead(current);
      }
    } else {
      elements.playhead.hidden = true;
    }
    elements.playButton.textContent = elements.audio.paused ? "播放" : "暂停";
    // 同步钢琴卷帘播放头：renderPianoRoll 重建 grid 时会创建初始 playhead div，
    // 这里只更新它的 left，避免每帧重建 DOM。
    if (elements.pianoRollGrid) {
      const pianoPlayhead = elements.pianoRollGrid.querySelector(".piano-roll-playhead");
      if (pianoPlayhead) {
        if (state.audioUrl && state.analysis) {
          pianoPlayhead.style.left = percentAt(current);
          pianoPlayhead.style.display = "";
        } else {
          pianoPlayhead.style.display = "none";
        }
      }
    }
  }

  // 自动滚动策略：
  //   - 时间轴内容未溢出视口时不动作；
  //   - 播放头进入视口右 18% 区域时，把 scrollLeft 推到"播放头位于视口 18% 处"；
  //   - 播放头落在视口左侧之外时，向前追赶到"播放头位于视口 10% 处"；
  //   - 用户最近 1.5 秒内手动滚动过则跳过，避免抢走用户的主动定位。
  function autoScrollToPlayhead(currentTime) {
    const scroll = elements.timelineScroll;
    const contentWidth = elements.timelineContent.offsetWidth;
    const viewportWidth = scroll.clientWidth;
    if (!contentWidth || contentWidth <= viewportWidth) return;
    if (state.manualScrollAt && performance.now() - state.manualScrollAt < 1500) return;
    const playheadPx = (currentTime / state.duration) * contentWidth;
    const viewportLeft = scroll.scrollLeft;
    const viewportRight = viewportLeft + viewportWidth;
    const rightThreshold = viewportLeft + viewportWidth * 0.82;
    let target = null;
    if (playheadPx > rightThreshold) {
      target = playheadPx - viewportWidth * 0.18;
    } else if (playheadPx < viewportLeft) {
      target = playheadPx - viewportWidth * 0.10;
    }
    if (target === null) return;
    const clamped = Math.max(0, Math.min(contentWidth - viewportWidth, target));
    if (Math.abs(scroll.scrollLeft - clamped) < 1) return;
    // 标记为程序滚动，让 scroll 事件知道不要更新 manualScrollAt。
    state.programmaticScroll = true;
    scroll.scrollLeft = clamped;
    // 同步重置标记，下一次用户滚动事件到来时再正常记录。
    setTimeout(() => { state.programmaticScroll = false; }, 0);
  }

  // ---- 音频关联 ----------------------------------------------------------------

  async function handleAudioFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".wav")) {
      setStatus("当前技术原型只接受 WAV 音频。", "error");
      return;
    }
    if (file.size > 1024 * 1024 * 1024) {
      setStatus("WAV 超过 1 GB，当前技术原型拒绝载入。", "error");
      return;
    }
    releaseAudioUrl();
    state.audioUrl = bridge.createObjectUrl(file);
    state.audioFileName = file.name;
    state.audioDuration = null;
    state.audioSha256 = null;
    state.audioHashSkipped = false;
    elements.audio.src = state.audioUrl;
    elements.audioName.textContent = file.name;
    elements.playButton.disabled = false;
    elements.stopButton.disabled = false;
    setStatus(`已关联本地 WAV：${file.name}，正在核对时长和 SHA-256。`, "success");
    elements.audio.load();
    const urlAtStart = state.audioUrl;
    if (globalThis.crypto && crypto.subtle && file.size <= 256 * 1024 * 1024) {
      try {
        const fileHash = await bridge.sha256(file);
        if (state.audioUrl !== urlAtStart) return;
        state.audioSha256 = fileHash;
        checkAudioAssociation();
      } catch (error) {
        if (state.audioUrl === urlAtStart) setStatus(`WAV 已关联，但浏览器无法计算 SHA-256：${error.message}`, "error");
      }
    } else {
      state.audioHashSkipped = true;
      setStatus("WAV 已关联；文件超过 256 MB 或浏览器缺少 Web Crypto，本轮只核对时长，未核对 SHA-256。", "error");
      checkAudioAssociation();
    }
  }

  function releaseAudioUrl() {
    elements.audio.pause();
    elements.audio.removeAttribute("src");
    elements.audio.load();
    if (state.audioUrl) bridge.revokeObjectUrl(state.audioUrl);
    state.audioUrl = null;
    state.audioFileName = null;
    state.audioDuration = null;
    state.audioSha256 = null;
    state.audioHashSkipped = false;
    elements.playButton.disabled = true;
    elements.stopButton.disabled = true;
    elements.audioName.textContent = "尚未关联 WAV";
  }

  function checkAudioAssociation() {
    if (!state.audioUrl || !state.analysis) return;
    const problems = [];
    if (Number.isFinite(state.audioDuration) && Math.abs(state.audioDuration - state.duration) > 0.25) {
      problems.push(`WAV 时长 ${state.audioDuration.toFixed(3)} 秒与分析时长 ${state.duration.toFixed(3)} 秒不一致`);
    }
    const expectedHash = String(state.analysis.source_audio.sha256 || "").toLowerCase();
    if (expectedHash && state.audioSha256 && expectedHash !== state.audioSha256) problems.push("WAV SHA-256 与分析源文件不一致");
    if (problems.length) {
      setStatus(`音频关联警告：${problems.join("；")}。`, "error");
    } else if (Number.isFinite(state.audioDuration) && (!expectedHash || state.audioSha256)) {
      setStatus(`WAV 已关联并通过${expectedHash ? "时长与 SHA-256" : "时长"}核对。`, "success");
    } else if (Number.isFinite(state.audioDuration) && state.audioHashSkipped) {
      setStatus("WAV 时长与分析一致；SHA-256 未核对，不能确认它就是分析源文件。", "error");
    }
  }

  // ---- 歌词区域 / 休止创建与编辑 ----------------------------------------------

  // 把当前选区保存为歌词区域。在连续模式下，相邻歌词共享 anchor：
  //   previous.endAnchorId === new.startAnchorId
  //   new.endAnchorId === next.startAnchorId
  // 这是数据层的边界共享，移动 anchor 会同时改变两侧，从根上消除漏缝。
  function saveLyricRegion() {
    if (!state.analysis) return;
    let { start: startSeconds, end: endSeconds } = state.selection;
    const text = elements.lyricText.value.trim();
    const language = elements.lyricLanguage.value;
    if (!(endSeconds > startSeconds)) {
      setStatus("请先建立有效选区；结束时间必须大于开始时间。", "error");
      return;
    }
    if (!text) {
      setStatus("歌词不能为空。", "error");
      return;
    }
    if (!new Set(["zh", "ja"]).has(language)) {
      setStatus("首版只支持中文和日文歌词。", "error");
      return;
    }

    const existing = state.selectedLyricId ? state.lyrics.find(region => region.id === state.selectedLyricId) : null;
    const otherRegions = state.lyrics.filter(region => !existing || region.id !== existing.id).sort((a, b) => anchorStartSample(a) - anchorStartSample(b));
    const tolerance = Math.max(0.08, snapIntervalSeconds() * 1.05);

    // 1) 编辑现有歌词：保留原 anchor，只移动它们到新位置；
    //    若新位置与相邻区域产生共享边界，复用相邻 anchor。
    if (existing) {
      let linkedPrevious = null;
      let linkedNext = null;
      if (state.continuousLyrics) {
        linkedPrevious = otherRegions.filter(region => Math.abs(anchorEndSeconds(region) - anchorStartSeconds(existing)) <= tolerance).at(-1) || null;
        linkedNext = otherRegions.find(region => Math.abs(anchorStartSeconds(region) - anchorEndSeconds(existing)) <= tolerance) || null;
      }
      // 检查不与未参与共享的区域重叠
      const ignoredIds = new Set([existing.id, linkedPrevious && linkedPrevious.id, linkedNext && linkedNext.id].filter(Boolean));
      const overlap = state.lyrics.find(region => !ignoredIds.has(region.id) && startSeconds < anchorEndSeconds(region) - 1e-6 && endSeconds > anchorStartSeconds(region) + 1e-6);
      if (overlap) {
        setStatus("歌词区域与已有区域重叠；请调整边界，或编辑已有区域。", "error");
        return;
      }
      if (linkedPrevious && startSeconds <= anchorStartSeconds(linkedPrevious)) {
        setStatus("边界调整会吞掉相邻歌词区域，请缩小移动范围。", "error");
        return;
      }
      if (linkedNext && endSeconds >= anchorEndSeconds(linkedNext)) {
        setStatus("边界调整会吞掉相邻歌词区域，请缩小移动范围。", "error");
        return;
      }
      editGraph.begin(existing ? `编辑歌词 ${existing.id}` : "新建歌词");
      // 复用或创建 start anchor
      let startAnchor;
      if (linkedPrevious) {
        startAnchor = state.anchors.get(linkedPrevious.endAnchorId);
      } else {
        startAnchor = findAnchorBySample(secondsToSample(startSeconds)) || createAnchorAtSample(secondsToSample(startSeconds));
      }
      // 复用或创建 end anchor
      let endAnchor;
      if (linkedNext) {
        endAnchor = state.anchors.get(linkedNext.startAnchorId);
      } else {
        endAnchor = findAnchorBySample(secondsToSample(endSeconds)) || createAnchorAtSample(secondsToSample(endSeconds));
      }
      moveAnchor(startAnchor.id, secondsToSample(startSeconds));
      moveAnchor(endAnchor.id, secondsToSample(endSeconds));
      existing.startAnchorId = startAnchor.id;
      existing.endAnchorId = endAnchor.id;
      existing.language = language;
      existing.text = text;
      pruneAnchors();
      // P2：歌词文本变化时重新派生 syllables（锁定的 readingOverride 会被保留）。
      resplitSyllablesForRegion(existing);
      setStatus("已更新歌词区域；与相邻区域共享的边界会一起移动。", "success");
      endLyricEdit(true);
      return;
    }

    // 2) 新建歌词区域
    if (state.continuousLyrics) {
      const previous = otherRegions.filter(region => Math.abs(anchorEndSeconds(region) - startSeconds) <= tolerance).at(-1) || null;
      const next = otherRegions.find(region => Math.abs(anchorStartSeconds(region) - endSeconds) <= tolerance) || null;
      if (previous && Math.abs(anchorEndSeconds(previous) - startSeconds) <= tolerance) startSeconds = anchorEndSeconds(previous);
      if (next && Math.abs(anchorStartSeconds(next) - endSeconds) <= tolerance) endSeconds = anchorStartSeconds(next);
    }
    if (!(endSeconds > startSeconds)) {
      setStatus("吸附后的歌词区域没有有效长度，请调整边界或关闭吸附。", "error");
      return;
    }
    const ignoredIds = new Set();
    const overlap = state.lyrics.find(region => !ignoredIds.has(region.id) && startSeconds < anchorEndSeconds(region) - 1e-6 && endSeconds > anchorStartSeconds(region) + 1e-6);
    if (overlap) {
      setStatus("歌词区域与已有区域重叠；请调整边界，或编辑已有区域。", "error");
      return;
    }

    let startAnchor;
    let endAnchor;
    if (state.continuousLyrics) {
      const previous = otherRegions.filter(region => Math.abs(anchorEndSeconds(region) - startSeconds) <= tolerance).at(-1) || null;
      const next = otherRegions.find(region => Math.abs(anchorStartSeconds(region) - endSeconds) <= tolerance) || null;
      if (previous) startAnchor = state.anchors.get(previous.endAnchorId);
      if (next) endAnchor = state.anchors.get(next.startAnchorId);
    }
    if (!startAnchor) startAnchor = findAnchorBySample(secondsToSample(startSeconds)) || createAnchorAtSample(secondsToSample(startSeconds));
    if (!endAnchor) endAnchor = findAnchorBySample(secondsToSample(endSeconds)) || createAnchorAtSample(secondsToSample(endSeconds));

    editGraph.begin("新建歌词");
    let identifier;
    do {
      identifier = `lyric-${state.nextLyricId++}`;
    } while (state.lyrics.some(region => region.id === identifier));
    state.lyrics.push({
      id: identifier,
      startAnchorId: startAnchor.id,
      endAnchorId: endAnchor.id,
      language,
      text,
    });
    // P2：为新歌词区域派生默认 syllables。
    const newRegion = state.lyrics[state.lyrics.length - 1];
    resplitSyllablesForRegion(newRegion);
    setStatus("已建立歌词区域；与相邻区域共享的边界会一起移动。", "success");
    endLyricEdit(true);
  }

  function deleteLyric() {
    if (!state.selectedLyricId) return;
    if (isLocked("lyric", state.selectedLyricId)) {
      setStatus("此歌词已锁定；请先在检查器取消锁定再删除。", "error");
      return;
    }
    editGraph.begin(`删除歌词 ${state.selectedLyricId}`);
    // P2：删除该歌词区域关联的所有 syllable（连同锁定状态）。
    const removedSyllableIds = state.syllables
      .filter(s => s.lyricId === state.selectedLyricId)
      .map(s => s.id);
    state.syllables = state.syllables.filter(s => s.lyricId !== state.selectedLyricId);
    removedSyllableIds.forEach(id => setLocked("syllable", id, false));
    state.lyrics = state.lyrics.filter(region => region.id !== state.selectedLyricId);
    // 锁定状态随对象一起清除，避免遗留无主锁定项。
    setLocked("lyric", state.selectedLyricId, false);
    pruneAnchors();
    endLyricEdit(true);
    setStatus("歌词区域已删除；引用的 anchor 已清理。", "success");
  }

  function convertSelectionToRest() {
    if (!state.analysis) return;
    const { start, end } = state.selection;
    if (!(end > start)) {
      setStatus("请先选择一段未分配区域再转为休止。", "error");
      return;
    }
    // 与现有 lyrics/rests 不能重叠
    const overlapLyric = state.lyrics.find(region => start < anchorEndSeconds(region) - 1e-6 && end > anchorStartSeconds(region) + 1e-6);
    if (overlapLyric) {
      setStatus("休止不能与已有歌词区域重叠。", "error");
      return;
    }
    const overlapRest = state.rests.find(rest => start < anchorEndSeconds(rest) - 1e-6 && end > anchorStartSeconds(rest) + 1e-6);
    if (overlapRest) {
      setStatus("休止不能与已有休止重叠。", "error");
      return;
    }
    // 复用相邻 anchor（与歌词区域相同规则）
    const tolerance = Math.max(0.08, snapIntervalSeconds() * 1.05);
    const previousLyric = state.lyrics.filter(region => Math.abs(anchorEndSeconds(region) - start) <= tolerance).at(-1) || null;
    const previousRest = state.rests.filter(rest => Math.abs(anchorEndSeconds(rest) - start) <= tolerance).at(-1) || null;
    const nextLyric = state.lyrics.find(region => Math.abs(anchorStartSeconds(region) - end) <= tolerance) || null;
    const nextRest = state.rests.find(rest => Math.abs(anchorStartSeconds(rest) - end) <= tolerance) || null;
    let startAnchor;
    let endAnchor;
    if (previousLyric) startAnchor = state.anchors.get(previousLyric.endAnchorId);
    else if (previousRest) startAnchor = state.anchors.get(previousRest.endAnchorId);
    if (nextLyric) endAnchor = state.anchors.get(nextLyric.startAnchorId);
    else if (nextRest) endAnchor = state.anchors.get(nextRest.startAnchorId);
    if (!startAnchor) startAnchor = findAnchorBySample(secondsToSample(start)) || createAnchorAtSample(secondsToSample(start));
    if (!endAnchor) endAnchor = findAnchorBySample(secondsToSample(end)) || createAnchorAtSample(secondsToSample(end));
    editGraph.begin("新建休止");
    let identifier;
    do {
      identifier = `rest-${state.nextRestId++}`;
    } while (state.rests.some(rest => rest.id === identifier));
    state.rests.push({
      id: identifier,
      startAnchorId: startAnchor.id,
      endAnchorId: endAnchor.id,
      kind: "rest",
    });
    setStatus(`已建立显式休止 ${start.toFixed(3)}–${end.toFixed(3)} 秒。`, "success");
    editRest(identifier);
  }

  function deleteRest(id) {
    if (isLocked("rest", id)) {
      setStatus("此休止已锁定；请先在检查器取消锁定再删除。", "error");
      return;
    }
    editGraph.begin(`删除休止 ${id}`);
    state.rests = state.rests.filter(rest => rest.id !== id);
    setLocked("rest", id, false);
    pruneAnchors();
    hideRestInspector();
    renderLyrics();
    setStatus("显式休止已删除，原区域恢复为未分配空段。", "success");
  }

  // ---- 共享边手柄：拖动 anchor 同时改变两侧 region ----------------------------

  function beginEdgeDrag(event, anchorId) {
    if (!state.analysis || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = state.anchors.get(anchorId);
    state.edgeDragging = {
      anchorId,
      startSample: anchor ? anchor.sample : 0,
      previousSample: anchor ? anchor.sample : 0,
      beganEdit: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveEdge(event) {
    if (!state.edgeDragging) return;
    event.preventDefault();
    event.stopPropagation();
    const time = snapTime(timeFromPointer(event), event.altKey);
    const newSample = secondsToSample(time);
    // 不允许跨越两侧 region 的另一端 anchor
    const consumers = [...state.lyrics, ...state.rests].filter(region => region.startAnchorId === state.edgeDragging.anchorId || region.endAnchorId === state.edgeDragging.anchorId);
    let minSample = 0;
    let maxSample = Math.round(state.duration * state.sampleRateHz);
    consumers.forEach(region => {
      if (region.startAnchorId === state.edgeDragging.anchorId) {
        const endSample = anchorEndSample(region);
        if (endSample < maxSample) maxSample = endSample;
      }
      if (region.endAnchorId === state.edgeDragging.anchorId) {
        const startSample = anchorStartSample(region);
        if (startSample > minSample) minSample = startSample;
      }
    });
    const minimum = event.altKey ? 1 : Math.max(1, Math.round((snapIntervalSeconds() || 0.001) * state.sampleRateHz));
    const clamped = Math.max(minSample + minimum, Math.min(maxSample - minimum, newSample));
    // 首次实际移动时记录撤销点（避免没移动也写一条 undo 记录）
    if (!state.edgeDragging.beganEdit && clamped !== state.edgeDragging.startSample) {
      editGraph.begin("拖动共享边界");
      state.edgeDragging.beganEdit = true;
    }
    moveAnchor(state.edgeDragging.anchorId, clamped);
    // 同步选区到正在编辑的 region（如果有）
    if (state.selectedLyricId) {
      const region = state.lyrics.find(item => item.id === state.selectedLyricId);
      if (region) setSelection(anchorStartSeconds(region), anchorEndSeconds(region), false);
    } else if (state.selectedRestId) {
      const rest = state.rests.find(item => item.id === state.selectedRestId);
      if (rest) setSelection(anchorStartSeconds(rest), anchorEndSeconds(rest), false);
    }
    renderLyrics();
  }

  function endEdgeDrag(event) {
    if (!state.edgeDragging) return;
    event.preventDefault();
    event.stopPropagation();
    const anchorId = state.edgeDragging.anchorId;
    const beganEdit = state.edgeDragging.beganEdit;
    state.edgeDragging = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (error) { /* pointer already released */ }
    const anchor = state.anchors.get(anchorId);
    if (anchor) {
      if (!beganEdit) {
        // 没真正移动，不报告"已移动"
      } else {
        setStatus(`共享边界已移动到 ${sampleToSeconds(anchor.sample).toFixed(3)} 秒。`, "success");
      }
    }
  }

  function cancelEdgeDrag() {
    if (!state.edgeDragging) return;
    const anchorId = state.edgeDragging.anchorId;
    const previous = state.edgeDragging.previousSample;
    const beganEdit = state.edgeDragging.beganEdit;
    state.edgeDragging = null;
    moveAnchor(anchorId, previous);
    if (beganEdit) {
      // 取消拖动：丢弃这次刚记录的撤销点，避免无效 undo 步骤。
      editGraph.undoStack.pop();
      updateUndoRedoButtons();
    }
    renderLyrics();
    setStatus("系统取消了共享边移动，已恢复原边界。", "success");
  }

  function nudgeEdge(event, anchorId) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.key === "ArrowRight" ? 1 : -1) * (snapIntervalSeconds() || 0.01);
    const anchor = state.anchors.get(anchorId);
    if (!anchor) return;
    editGraph.begin("微调共享边界");
    moveAnchor(anchorId, anchor.sample + secondsToSample(delta));
    renderLyrics();
    setStatus(`共享边界已微调到 ${sampleToSeconds(anchor.sample).toFixed(3)} 秒。`, "success");
  }

  // ---- 和弦修正 ----------------------------------------------------------------

  function saveChordOverride() {
    const window = selectedChordWindow();
    const label = elements.chordLabel.value.trim();
    if (!window || !label) {
      setStatus("请选择和弦候选并输入修正值。", "error");
      return;
    }
    editGraph.begin(`修正和弦 ${label}`);
    const key = chordKey(window);
    state.chordOverrides[key] = {
      label,
      original_label: topChord(window) ? topChord(window).label : null,
      start_seconds: finiteNumber(window.start_seconds),
      end_seconds: finiteNumber(window.end_seconds),
      status: "user-confirmed",
    };
    setStatus(`已把和弦候选修正为 ${label}；源分析值仍保留。`, "success");
    selectChord(window);
  }

  function restoreChord() {
    const window = selectedChordWindow();
    if (!window) return;
    const key = chordKey(window);
    if (isLocked("chord", key)) {
      setStatus("此和弦修正已锁定；请先在检查器取消锁定再恢复分析值。", "error");
      return;
    }
    editGraph.begin("恢复和弦");
    delete state.chordOverrides[key];
    setLocked("chord", key, false);
    elements.chordLabel.value = topChord(window) ? topChord(window).label : "";
    setStatus("已恢复原分析候选。", "success");
    selectChord(window);
  }

  // ---- 项目导入 / 导出 --------------------------------------------------------

  function serializeAnchors() {
    return Array.from(state.anchors.values()).map(anchor => ({
      id: anchor.id,
      sample: anchor.sample,
      tick: anchor.tick,
    }));
  }

  function exportProject() {
    if (!state.analysis) return;
    const project = {
      schema_version: PROJECT_SCHEMA,
      title: "Miku 歌姬解放计划 · 工作台原型项目",
      source_audio: {
        ...state.analysis.source_audio,
        local_file_name: state.audioFileName,
        relink_required_after_import: true,
      },
      analysis: state.analysis,
      tempo_map: {
        sample_rate_hz: state.tempoMap.sampleRateHz,
        ppq: state.tempoMap.ppq,
        bpm: state.tempoMap.bpm,
        first_beat_seconds: state.tempoMap.firstBeatSeconds,
        first_beat_sample: state.tempoMap.firstBeatSample,
        first_beat_tick: state.tempoMap.firstBeatTick,
      },
      anchors: serializeAnchors(),
      editing: {
        selection: state.selection,
        lyrics: state.lyrics.map(region => ({
          id: region.id,
          start_anchor_id: region.startAnchorId,
          end_anchor_id: region.endAnchorId,
          language: region.language,
          text: region.text,
        })),
        rests: state.rests.map(rest => ({
          id: rest.id,
          start_anchor_id: rest.startAnchorId,
          end_anchor_id: rest.endAnchorId,
          kind: rest.kind,
        })),
        chord_overrides: state.chordOverrides,
        locked_fields: serializeLockedFields(),
        // stem 轨混音参数（非破坏编辑）随项目持久化；占位 stem 也保存参数，
        // 后续接入分离后端时可以复用用户已有的混音设置。
        // P1.2 轮 4：trim/fade 字段一并持久化，重新打开项目后恢复 A/B 试听边界。
        stem_tracks: state.stemTracks.map(track => ({
          id: track.id,
          name: track.name,
          role: track.role,
          mute: track.mute,
          solo: track.solo,
          gain: track.gain,
          pan: track.pan,
          source: track.source,
          trim_start_seconds: finiteNumber(track.trimStartSeconds, 0),
          trim_end_seconds: finiteNumber(track.trimEndSeconds, 0),
          fade_in_seconds: finiteNumber(track.fadeInSeconds, 0),
          fade_out_seconds: finiteNumber(track.fadeOutSeconds, 0),
        })),
        // 音符候选（P1.2 轮 2 起）随项目持久化；引用 anchor 与 stem。
        notes: state.notes.map(note => ({
          id: note.id,
          stem_id: note.stemId,
          start_anchor_id: note.startAnchorId,
          end_anchor_id: note.endAnchorId,
          pitch: note.pitch,
          velocity: note.velocity,
          confidence: note.confidence,
          source: note.source,
        })),
        // P2：歌词音节切分随项目持久化；引用 lyric 与 anchor。
        // readingOverride 是用户覆盖的读音（空 = 用 defaultReading）。
        syllables: state.syllables.map(syllable => ({
          id: syllable.id,
          lyric_id: syllable.lyricId,
          index: syllable.index,
          text: syllable.text,
          default_reading: syllable.defaultReading,
          reading_override: syllable.readingOverride || "",
          start_anchor_id: syllable.startAnchorId,
          end_anchor_id: syllable.endAnchorId,
        })),
        preferences: {
          snap_mode: state.snapMode,
          continuous_lyrics: state.continuousLyrics,
          dotted_snap: state.dottedSnap,
          swing_amount: state.swingAmount,
          // P1.2 轮 4：试听模式（edited / original）随项目持久化。
          stem_preview_mode: state.stemPreviewMode,
        },
      },
    };
    bridge.downloadJson("miku-workbench-project.json", project);
    setStatus("项目已导出。音频本体未写入项目，请在重新打开后手动关联。", "success");
  }

  function importAnchorsAndRegions(project, analysis) {
    // 重建 TempoMap 以便校验 anchor.tick 是否与 sample 一致；不一致时以 sample 为准。
    const tempoMap = buildTempoMap(analysis);
    state.tempoMap = tempoMap;
    state.sampleRateHz = tempoMap.sampleRateHz;

    const anchors = Array.isArray(project.anchors) ? project.anchors : [];
    state.anchors.clear();
    let maxAnchorNumber = 0;
    anchors.forEach(entry => {
      if (!entry || typeof entry.id !== "string" || !entry.id) throw new Error(`anchor 条目缺少 id。`);
      if (state.anchors.has(entry.id)) throw new Error(`anchor ID 重复：${entry.id}。`);
      const sample = Math.max(0, Math.min(Math.round(finiteNumber(entry.sample)), Math.round(state.duration * state.sampleRateHz)));
      const anchor = { id: entry.id, sample, tick: sampleToTick(sample) };
      // 写入的 tick 与重算的 tick 不一致时以 sample 为权威；只记录不抛错。
      state.anchors.set(entry.id, anchor);
      const match = /^anchor-(\d+)$/.exec(entry.id);
      if (match) maxAnchorNumber = Math.max(maxAnchorNumber, Number(match[1]));
    });
    state.nextAnchorId = Math.max(state.nextAnchorId, maxAnchorNumber + 1);

    const editing = project.editing || {};
    const seenLyricIds = new Set();
    let maximumLyricNumber = 0;
    const lyrics = Array.isArray(editing.lyrics) ? editing.lyrics.map((region, index) => {
      if (!region || typeof region !== "object") throw new Error(`歌词区域 ${index + 1} 无效。`);
      if (!new Set(["zh", "ja"]).has(region.language)) throw new Error(`歌词区域 ${index + 1} 使用不支持的语言；首版只接受 zh/ja。`);
      const startAnchorId = String(region.start_anchor_id || "");
      const endAnchorId = String(region.end_anchor_id || "");
      if (!state.anchors.has(startAnchorId) || !state.anchors.has(endAnchorId)) {
        throw new Error(`歌词区域 ${index + 1} 引用了不存在的 anchor。`);
      }
      if (startAnchorId === endAnchorId) throw new Error(`歌词区域 ${index + 1} 的起止 anchor 不能相同。`);
      if (!String(region.text || "").trim()) throw new Error(`歌词区域 ${index + 1} 的文本为空。`);
      const id = String(region.id || `lyric-${index + 1}`);
      if (seenLyricIds.has(id)) throw new Error(`歌词区域 ID 重复：${id}。`);
      seenLyricIds.add(id);
      const match = /^lyric-(\d+)$/.exec(id);
      if (match) maximumLyricNumber = Math.max(maximumLyricNumber, Number(match[1]));
      return {
        id,
        startAnchorId,
        endAnchorId,
        language: region.language,
        text: String(region.text).trim(),
      };
    }) : [];
    state.lyrics = lyrics;
    state.nextLyricId = Math.max(1, maximumLyricNumber + 1);

    const seenRestIds = new Set();
    let maximumRestNumber = 0;
    const rests = Array.isArray(editing.rests) ? editing.rests.map((rest, index) => {
      if (!rest || typeof rest !== "object") throw new Error(`休止 ${index + 1} 无效。`);
      if (rest.kind !== "rest") throw new Error(`休止 ${index + 1} 的 kind 不被支持；首版只接受 rest。`);
      const startAnchorId = String(rest.start_anchor_id || "");
      const endAnchorId = String(rest.end_anchor_id || "");
      if (!state.anchors.has(startAnchorId) || !state.anchors.has(endAnchorId)) {
        throw new Error(`休止 ${index + 1} 引用了不存在的 anchor。`);
      }
      if (startAnchorId === endAnchorId) throw new Error(`休止 ${index + 1} 的起止 anchor 不能相同。`);
      const id = String(rest.id || `rest-${index + 1}`);
      if (seenRestIds.has(id)) throw new Error(`休止 ID 重复：${id}。`);
      seenRestIds.add(id);
      const match = /^rest-(\d+)$/.exec(id);
      if (match) maximumRestNumber = Math.max(maximumRestNumber, Number(match[1]));
      return { id, startAnchorId, endAnchorId, kind: "rest" };
    }) : [];
    state.rests = rests;
    state.nextRestId = Math.max(1, maximumRestNumber + 1);

    // 同一主唱轨上的歌词区域不能重叠；和声请使用独立声部轨。
    const orderedLyrics = lyrics.slice().sort((a, b) => anchorStartSample(a) - anchorStartSample(b));
    for (let index = 1; index < orderedLyrics.length; index += 1) {
      if (anchorStartSample(orderedLyrics[index]) < anchorEndSample(orderedLyrics[index - 1]) - 1) {
        throw new Error("同一主唱轨上的歌词区域不能重叠；和声请使用独立声部轨。");
      }
    }
    // 休止也不能与歌词或其他休止重叠
    const allRegions = [...lyrics, ...rests];
    for (let outer = 0; outer < allRegions.length; outer += 1) {
      for (let inner = outer + 1; inner < allRegions.length; inner += 1) {
        const a = allRegions[outer];
        const b = allRegions[inner];
        const overlap = anchorStartSample(a) < anchorEndSample(b) - 1 && anchorEndSample(a) > anchorStartSample(b) + 1;
        if (overlap) throw new Error("歌词或休止区域之间存在重叠。");
      }
    }

    // 加载字段级锁定：只保留指向当前项目中仍存在的 lyric/rest/chord 的项。
    const rawLocked = Array.isArray(editing.locked_fields) ? editing.locked_fields : [];
    const validLyricIds = new Set(lyrics.map(region => region.id));
    const validRestIds = new Set(rests.map(rest => rest.id));
    const validChordKeys = new Set(analysis.analysis.chords.windows.map(window => chordKey(window)));
    const lockedFields = new Set();
    rawLocked.forEach(entry => {
      if (typeof entry !== "string") return;
      // chordKey 本身含 ":"，所以这里只在第一个冒号处分割。
      const colonIndex = entry.indexOf(":");
      if (colonIndex < 0) return;
      const type = entry.slice(0, colonIndex);
      const id = entry.slice(colonIndex + 1);
      if (!type || !id) return;
      if (type === "lyric" && validLyricIds.has(id)) lockedFields.add(entry);
      else if (type === "rest" && validRestIds.has(id)) lockedFields.add(entry);
      else if (type === "chord" && validChordKeys.has(id)) lockedFields.add(entry);
      // 静默丢弃指向已删除对象的锁定项，不抛错。
    });
    state.lockedFields = lockedFields;

    // 加载 stem 轨混音参数；缺失或损坏时回退到默认 stem 集，保证向前兼容。
    // 0.2.0 项目早期版本可能没有 stem_tracks 字段；这种情况视为新建项目。
    // P1.2 轮 4：trim/fade 字段也一并加载并 clamp 到 0..duration；早期版本缺失时回退到 0。
    const rawStemTracks = Array.isArray(editing.stem_tracks) ? editing.stem_tracks : [];
    const validStemIds = new Set(["master", "drums", "bass", "other"]);
    const durationUpper = Math.max(0, state.duration);
    const loadedStemTracks = rawStemTracks
      .filter(track => track && typeof track === "object" && typeof track.id === "string" && validStemIds.has(track.id))
      .map(track => ({
        id: track.id,
        name: typeof track.name === "string" && track.name.trim() ? track.name.trim() : track.id,
        role: typeof track.role === "string" ? track.role : track.id,
        mute: Boolean(track.mute),
        solo: Boolean(track.solo),
        gain: clamp(finiteNumber(track.gain, 1.0), 0, 1.5),
        pan: clamp(finiteNumber(track.pan, 0), -1, 1),
        source: track.source === "main" ? "main" : "placeholder",
        // P1.2 轮 4：trim/fade 字段向前兼容；旧项目缺失或字段非有限数时回退到 0。
        // trim_end_seconds = 0 在 stemEffectiveTrimRange 中表示"不裁切，到音频结尾"。
        trimStartSeconds: clamp(finiteNumber(track.trim_start_seconds, 0), 0, durationUpper),
        trimEndSeconds: clamp(finiteNumber(track.trim_end_seconds, 0), 0, durationUpper),
        fadeInSeconds: Math.max(0, finiteNumber(track.fade_in_seconds, 0)),
        fadeOutSeconds: Math.max(0, finiteNumber(track.fade_out_seconds, 0)),
      }));
    // 必须存在 master 轨；缺失时整套回退到默认。
    state.stemTracks = loadedStemTracks.some(track => track.id === "master")
      ? loadedStemTracks
      : defaultStemTracks();

    // P1.2 轮 4：加载偏好集合（snap/continuous/dotted/swing/stem_preview_mode）。
    // 此前 0.2.0 项目导入时偏好未恢复，这里一并补齐。
    const importedPreferences = editing.preferences && typeof editing.preferences === "object" ? editing.preferences : {};
    if (new Set(["beat", "half-beat", "quarter-beat", "eighth-beat", "triplet-half", "triplet-quarter", "none"]).has(importedPreferences.snap_mode)) {
      state.snapMode = importedPreferences.snap_mode;
    }
    state.continuousLyrics = importedPreferences.continuous_lyrics !== false;
    state.dottedSnap = importedPreferences.dotted_snap === true;
    const importedSwing = Number(importedPreferences.swing_amount);
    state.swingAmount = Number.isFinite(importedSwing) ? Math.max(0, Math.min(0.7, importedSwing)) : 0;
    state.stemPreviewMode = importedPreferences.stem_preview_mode === "original" ? "original" : "edited";
    if (elements.snapGrid) elements.snapGrid.value = state.snapMode;
    if (elements.continuousLyrics) elements.continuousLyrics.checked = state.continuousLyrics;
    if (elements.dottedSnap) elements.dottedSnap.checked = state.dottedSnap;
    if (elements.swingAmount) elements.swingAmount.value = String(state.swingAmount);
    if (elements.stemPreviewMode) elements.stemPreviewMode.value = state.stemPreviewMode;

    // 加载音符候选（P1.2 轮 2 起）。0.2.0 早期项目可能没有 notes 字段；这种情况视为没有音符。
    const rawNotes = Array.isArray(editing.notes) ? editing.notes : [];
    const validStemIdsForNotes = new Set(state.stemTracks.map(track => track.id));
    const seenNoteIds = new Set();
    let maximumNoteNumber = 0;
    const notes = rawNotes.map((entry, index) => {
      if (!entry || typeof entry !== "object") throw new Error(`音符 ${index + 1} 无效。`);
      const id = String(entry.id || `note-${index + 1}`);
      if (seenNoteIds.has(id)) throw new Error(`音符 ID 重复：${id}。`);
      seenNoteIds.add(id);
      const startAnchorId = String(entry.start_anchor_id || "");
      const endAnchorId = String(entry.end_anchor_id || "");
      if (!state.anchors.has(startAnchorId) || !state.anchors.has(endAnchorId)) {
        throw new Error(`音符 ${id} 引用了不存在的 anchor。`);
      }
      if (startAnchorId === endAnchorId) throw new Error(`音符 ${id} 的起止 anchor 不能相同。`);
      const stemId = validStemIdsForNotes.has(entry.stem_id) ? entry.stem_id : "master";
      const match = /^note-(\d+)$/.exec(id);
      if (match) maximumNoteNumber = Math.max(maximumNoteNumber, Number(match[1]));
      return {
        id,
        stemId,
        startAnchorId,
        endAnchorId,
        pitch: clamp(Math.round(finiteNumber(entry.pitch, 60)), PIANO_ROLL_MIN_PITCH, PIANO_ROLL_MAX_PITCH),
        velocity: clamp(finiteNumber(entry.velocity, 0.8), 0, 1),
        confidence: clamp(finiteNumber(entry.confidence, 0), 0, 1),
        source: ["manual", "transcription", "generation"].includes(entry.source) ? entry.source : "manual",
      };
    });
    state.notes = notes;
    state.nextNoteId = Math.max(1, maximumNoteNumber + 1);
    state.selectedNoteId = null;
    state.pianoRollMergeCandidateId = null;

    // P2：加载歌词音节切分（0.3.0 项目）。0.2.0 项目缺失 syllables 字段时，
    // 为已有歌词区域派生默认 syllables（迁移到 0.3.0）。
    const rawSyllables = Array.isArray(editing.syllables) ? editing.syllables : [];
    const validLyricIdsForSyllable = new Set(state.lyrics.map(region => region.id));
    const seenSyllableIds = new Set();
    let maximumSyllableNumber = 0;
    const loadedSyllables = rawSyllables.map((entry, index) => {
      if (!entry || typeof entry !== "object") throw new Error(`音节 ${index + 1} 无效。`);
      const id = String(entry.id || `syllable-${index + 1}`);
      if (seenSyllableIds.has(id)) throw new Error(`音节 ID 重复：${id}。`);
      seenSyllableIds.add(id);
      const lyricId = String(entry.lyric_id || "");
      if (!validLyricIdsForSyllable.has(lyricId)) {
        throw new Error(`音节 ${id} 引用了不存在的歌词区域。`);
      }
      const startAnchorId = String(entry.start_anchor_id || "");
      const endAnchorId = String(entry.end_anchor_id || "");
      if (!state.anchors.has(startAnchorId) || !state.anchors.has(endAnchorId)) {
        throw new Error(`音节 ${id} 引用了不存在的 anchor。`);
      }
      const match = /^syllable-(\d+)$/.exec(id);
      if (match) maximumSyllableNumber = Math.max(maximumSyllableNumber, Number(match[1]));
      return {
        id,
        lyricId,
        index: clamp(Math.round(finiteNumber(entry.index, 0)), 0, 1024),
        text: String(entry.text || ""),
        defaultReading: String(entry.default_reading || ""),
        readingOverride: typeof entry.reading_override === "string" ? entry.reading_override : "",
        startAnchorId,
        endAnchorId,
      };
    });
    state.syllables = loadedSyllables;
    state.nextSyllableId = Math.max(1, maximumSyllableNumber + 1);
    state.selectedSyllableId = null;
    // P2：补全 syllable 锁定验证。locked_fields 在 syllables 加载前先做了 lyric/rest/chord 验证，
    // syllable 锁定项此时还没被加入；这里基于已加载的 syllables 补上。
    const validSyllableIds = new Set(state.syllables.map(s => s.id));
    rawLocked.forEach(entry => {
      if (typeof entry !== "string") return;
      const colonIndex = entry.indexOf(":");
      if (colonIndex < 0) return;
      const type = entry.slice(0, colonIndex);
      const id = entry.slice(colonIndex + 1);
      if (type === "syllable" && validSyllableIds.has(id)) {
        state.lockedFields.add(entry);
      }
    });
    // 0.2.0 项目没有 syllables 字段：为所有歌词区域派生默认 syllables。
    // 这是 0.2.0 → 0.3.0 的自动迁移（不记 undo，是导入的一部分）。
    // 0.3.0 项目正常情况下 syllables 与 lyrics 同步；若因数据损坏导致 syllables 为空但 lyrics 存在，
    // 也派生默认 syllables 作为恢复措施。
    if (!rawSyllables.length && state.lyrics.length) {
      deriveDefaultSyllablesForAllLyrics();
    }
  }

  // 把 0.1.0 项目的秒数边界迁移到 0.2.0 的 anchor 表。
  // 相邻歌词（previous.end ≈ next.start within tolerance）共享同一个 anchor。
  function migrateLegacyProject(project, analysis) {
    const editing = project.editing || {};
    const legacyLyrics = Array.isArray(editing.lyrics) ? editing.lyrics : [];
    const sampleRateHz = finiteNumber(analysis.source_audio.sample_rate_hz, 48000);
    state.sampleRateHz = sampleRateHz;
    state.tempoMap = buildTempoMap(analysis);

    const tolerance = 0.005;
    const sortedLegacy = legacyLyrics
      .map((region, index) => ({
        id: String(region.id || `lyric-${index + 1}`),
        language: region.language,
        text: String(region.text || "").trim(),
        startSeconds: clamp(finiteNumber(region.start), 0, analysis.source_audio.duration_seconds),
        endSeconds: clamp(finiteNumber(region.end), 0, analysis.source_audio.duration_seconds),
      }))
      .filter(region => region.endSeconds > region.startSeconds && region.text)
      .sort((a, b) => a.startSeconds - b.startSeconds);

    state.anchors.clear();
    state.lyrics = [];
    state.rests = [];
    state.nextAnchorId = 1;
    state.nextLyricId = 1;
    state.nextRestId = 1;
    // 0.1.0 项目没有锁定字段概念；迁移时清空，避免上一项目的锁定残留。
    state.lockedFields = new Set();
    // 0.1.0 项目没有 stem_tracks 字段；迁移时回退到默认 stem 集。
    state.stemTracks = defaultStemTracks();
    // P1.2 轮 4：0.1.0 项目没有 stem_preview_mode 字段；迁移时回退到 edited。
    state.stemPreviewMode = "edited";
    if (elements.stemPreviewMode) elements.stemPreviewMode.value = "edited";
    // 0.1.0 项目没有 notes 字段；迁移时清空音符候选。
    state.notes = [];
    state.nextNoteId = 1;
    state.selectedNoteId = null;
    state.pianoRollMergeCandidateId = null;
    state.pianoRollStemId = "master";
    if (elements.pianoRollStemSelect) elements.pianoRollStemSelect.value = "master";
    // P2：0.1.0 项目没有 syllables 字段；迁移时清空，待歌词区域建立后再派生。
    state.syllables = [];
    state.nextSyllableId = 1;
    state.selectedSyllableId = null;

    let previousEndAnchorId = null;
    sortedLegacy.forEach((legacy, index) => {
      let startAnchorId;
      if (previousEndAnchorId) {
        const previousEnd = sampleToSeconds(state.anchors.get(previousEndAnchorId).sample);
        if (Math.abs(previousEnd - legacy.startSeconds) <= tolerance) {
          startAnchorId = previousEndAnchorId;
        }
      }
      if (!startAnchorId) {
        const existing = findAnchorBySample(secondsToSample(legacy.startSeconds));
        const anchor = existing || createAnchorAtSample(secondsToSample(legacy.startSeconds));
        startAnchorId = anchor.id;
      }
      const existingEnd = findAnchorBySample(secondsToSample(legacy.endSeconds));
      const endAnchor = existingEnd || createAnchorAtSample(secondsToSample(legacy.endSeconds));
      state.lyrics.push({
        id: legacy.id,
        startAnchorId,
        endAnchorId: endAnchor.id,
        language: legacy.language,
        text: legacy.text,
      });
      previousEndAnchorId = endAnchor.id;
      const match = /^lyric-(\d+)$/.exec(legacy.id);
      if (match) state.nextLyricId = Math.max(state.nextLyricId, Number(match[1]) + 1);
    });

    const rawOverrides = editing.chord_overrides === undefined ? {} : editing.chord_overrides;
    if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) throw new Error("和弦修正层必须是对象。");
    const validChordKeys = new Set(analysis.analysis.chords.windows.map(window => chordKey(window)));
    const overrides = {};
    Object.entries(rawOverrides).forEach(([key, override]) => {
      if (!validChordKeys.has(key) || !override || typeof override !== "object" || typeof override.label !== "string" || !override.label.trim()) {
        throw new Error(`和弦修正 ${key} 无效或不属于当前分析。`);
      }
      if (!Number.isFinite(Number(override.start_seconds)) || !Number.isFinite(Number(override.end_seconds)) || override.status !== "user-confirmed") {
        throw new Error(`和弦修正 ${key} 的时间或状态无效。`);
      }
      overrides[key] = { ...override, label: override.label.trim() };
    });
    state.chordOverrides = overrides;

    const preferences = editing.preferences && typeof editing.preferences === "object" ? editing.preferences : {};
    // P1.2 轮 3：偏好集合扩展，接受新网格与 swing 设置；旧版项目缺失时回退默认。
    if (new Set(["beat", "half-beat", "quarter-beat", "eighth-beat", "triplet-half", "triplet-quarter", "none"]).has(preferences.snap_mode)) {
      state.snapMode = preferences.snap_mode;
    }
    state.continuousLyrics = preferences.continuous_lyrics !== false;
    state.dottedSnap = preferences.dotted_snap === true;
    const swingValue = Number(preferences.swing_amount);
    state.swingAmount = Number.isFinite(swingValue) ? Math.max(0, Math.min(0.7, swingValue)) : 0;
    elements.snapGrid.value = state.snapMode;
    elements.continuousLyrics.checked = state.continuousLyrics;
    if (elements.dottedSnap) elements.dottedSnap.checked = state.dottedSnap;
    if (elements.swingAmount) elements.swingAmount.value = String(state.swingAmount);
    // P2：0.1.0 → 0.3.0 迁移时为已建立的歌词区域派生默认 syllables。
    if (state.lyrics.length) {
      deriveDefaultSyllablesForAllLyrics();
    }
    const selection = editing.selection || {};
    return { selection };
  }

  async function importProject(file) {
    const candidate = await readJsonFile(file);
    // P2：支持 0.3.0（当前）、0.2.0（自动迁移派生 syllables）、0.1.0（深度迁移）。
    if (candidate.schema_version !== PROJECT_SCHEMA
        && candidate.schema_version !== PROJECT_SCHEMA_LEGACY
        && candidate.schema_version !== PROJECT_SCHEMA_LEGACY_020) {
      throw new Error(`不支持的项目版本：${String(candidate.schema_version || "缺失")}。`);
    }
    const analysis = validateAnalysis(candidate.analysis);
    releaseAudioUrl();
    applyAnalysis(analysis, false);

    if (candidate.schema_version === PROJECT_SCHEMA_LEGACY) {
      // 0.1.0 项目：把秒数边界迁移到共享 anchor 模型，并派生默认 syllables。
      const { selection } = migrateLegacyProject(candidate, analysis);
      setSelection(finiteNumber(selection.start), finiteNumber(selection.end), false);
      setStatus("已导入 0.1.0 项目并迁移到 0.3.0 共享 anchor + syllable 模型；请重新选择本地 WAV 才能播放。", "success");
    } else if (candidate.schema_version === PROJECT_SCHEMA_LEGACY_020) {
      // 0.2.0 项目：直接加载 anchor 与 region，并为已有歌词派生默认 syllables。
      // 注意 importAnchorsAndRegions 内部已处理 editing.preferences 与 syllables 派生，这里只取 selection。
      importAnchorsAndRegions(candidate, analysis);
      const editing = candidate.editing || {};
      const selection = editing.selection || {};
      setSelection(finiteNumber(selection.start), finiteNumber(selection.end), false);
      setStatus("已导入 0.2.0 项目并迁移到 0.3.0；已为歌词区域派生默认音节切分，请重新选择本地 WAV 才能播放。", "success");
    } else {
      // 0.3.0 项目：直接加载 anchor 与 region + syllables。
      // 注意 importAnchorsAndRegions 内部已处理 editing.preferences，这里只取 selection。
      importAnchorsAndRegions(candidate, analysis);
      const editing = candidate.editing || {};
      const selection = editing.selection || {};
      setSelection(finiteNumber(selection.start), finiteNumber(selection.end), false);
      setStatus("项目已导入；分析和编辑状态已恢复，请重新选择本地 WAV 才能播放。", "success");
    }

    elements.audioName.textContent = candidate.source_audio && candidate.source_audio.local_file_name ? `${candidate.source_audio.local_file_name}（需要重新关联）` : "需要重新关联 WAV";
    renderAll();
  }

  // ---- 事件绑定 ---------------------------------------------------------------

  elements.analysisFile.addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const candidate = validateAnalysis(await readJsonFile(file));
      applyAnalysis(candidate);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      event.target.value = "";
    }
  });

  elements.audioFile.addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (file) await handleAudioFile(file);
    event.target.value = "";
  });

  elements.importProjectButton.addEventListener("click", () => elements.projectFile.click());
  elements.projectFile.addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      await importProject(file);
    } catch (error) {
      setStatus(`项目导入失败：${error.message}`, "error");
    } finally {
      event.target.value = "";
    }
  });
  elements.exportProjectButton.addEventListener("click", exportProject);
  if (elements.undoButton) elements.undoButton.addEventListener("click", () => { editGraph.undo(); renderAll(); });
  if (elements.redoButton) elements.redoButton.addEventListener("click", () => { editGraph.redo(); renderAll(); });
  updateUndoRedoButtons();

  async function togglePlayback() {
    if (!state.audioUrl) return;
    // 首次播放时初始化 Web Audio API 节点图，让 stem 混音参数真实生效。
    // AudioContext 必须在用户手势中创建/恢复，所以放在这里而不是模块加载时。
    setupAudioGraph();
    resumeAudioContext();
    try {
      if (elements.audio.paused) {
        // P1.2 轮 4：播放起点受 master stem 的 trimStart 影响（仅 edited 模式）。
        const master = state.stemTracks.find(track => track.id === "master");
        const { start: trimStart, end: trimEnd } = master ? stemEffectiveTrimRange(master) : { start: 0, end: state.duration };
        const selectionStart = state.selection.end > state.selection.start ? state.selection.start : null;
        const baseStart = elements.audio.ended || elements.audio.currentTime >= state.duration - 0.01;
        if (baseStart) {
          // 重新开始播放：优先用选区起点，否则用 trimStart（edited 模式）或 0。
          const target = selectionStart !== null ? selectionStart : trimStart;
          if (target >= trimStart && target < trimEnd) {
            elements.audio.currentTime = target;
          } else {
            elements.audio.currentTime = trimStart;
          }
        } else if (elements.audio.currentTime < trimStart - 0.01 || elements.audio.currentTime > trimEnd + 0.05) {
          // 当前播放头在 trim 范围外，重置到 trimStart。
          elements.audio.currentTime = trimStart;
        }
        await elements.audio.play();
        applyMasterFadeEnvelope();
      } else elements.audio.pause();
      updateTransport();
    } catch (error) {
      setStatus(`音频播放失败：${error.message}`, "error");
    }
  }
  elements.playButton.addEventListener("click", togglePlayback);
  elements.stopButton.addEventListener("click", () => {
    elements.audio.pause();
    elements.audio.currentTime = state.selection.end > state.selection.start ? state.selection.start : 0;
    updateTransport();
  });
  elements.audio.addEventListener("timeupdate", () => {
    updateTransport();
    enforceMasterTrimBoundary();
    applyMasterFadeEnvelope();
  });
  elements.audio.addEventListener("play", updateTransport);
  elements.audio.addEventListener("pause", updateTransport);
  elements.audio.addEventListener("ended", updateTransport);
  elements.audio.addEventListener("seeked", () => {
    applyMasterFadeEnvelope();
    enforceMasterTrimBoundary();
  });
  elements.audio.addEventListener("error", () => setStatus("浏览器无法解码这个 WAV，请检查编码和文件完整性。", "error"));
  elements.audio.addEventListener("loadedmetadata", () => {
    state.audioDuration = Number.isFinite(elements.audio.duration) ? elements.audio.duration : null;
    checkAudioAssociation();
    updateTransport();
  });

  elements.waveformLane.addEventListener("pointerdown", event => {
    if (!state.analysis || event.button !== 0) return;
    const anchor = snapTime(timeFromPointer(event), event.altKey);
    state.dragging = { anchor, clientX: event.clientX, moved: false, previous: { ...state.selection } };
    elements.waveformLane.setPointerCapture(event.pointerId);
  });
  elements.waveformLane.addEventListener("pointermove", event => {
    if (!state.dragging) return;
    if (Math.abs(event.clientX - state.dragging.clientX) < 3 && !state.dragging.moved) return;
    state.dragging.moved = true;
    setSelection(state.dragging.anchor, timeFromPointer(event), false, true, event.altKey);
  });
  elements.waveformLane.addEventListener("pointerup", event => {
    if (!state.dragging) return;
    if (state.dragging.moved) {
      setSelection(state.dragging.anchor, timeFromPointer(event), true, true, event.altKey);
    } else {
      const targetTime = timeFromPointer(event);
      setSelection(state.dragging.previous.start, state.dragging.previous.end, false);
      if (state.audioUrl) {
        elements.audio.currentTime = targetTime;
        updateTransport();
        setStatus(`播放头已定位到 ${targetTime.toFixed(3)} 秒。`, "success");
      } else {
        setStatus("已定位时间；关联 WAV 后可以从这里播放。", "success");
      }
    }
    state.dragging = null;
    elements.waveformLane.releasePointerCapture(event.pointerId);
  });
  elements.waveformLane.addEventListener("pointercancel", () => {
    if (!state.dragging) return;
    const previous = state.dragging.previous;
    state.dragging = null;
    setSelection(previous.start, previous.end, false);
    setStatus("系统取消了框选，已恢复原选区。", "success");
  });
  elements.waveformLane.addEventListener("keydown", event => {
    if (!state.analysis || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const delta = (event.key === "ArrowRight" ? 1 : -1) * (snapIntervalSeconds() || 0.1);
    const length = state.selection.end > state.selection.start ? state.selection.end - state.selection.start : (snapIntervalSeconds() || 0.5);
    if (event.shiftKey) {
      setSelection(state.selection.start, clamp(state.selection.end + delta, state.selection.start + 0.001, state.duration), true, true);
    } else {
      const start = clamp(state.selection.start + delta, 0, state.duration - length);
      setSelection(start, start + length, true, true);
    }
  });

  function beginHandleDrag(event, edge) {
    event.preventDefault();
    event.stopPropagation();
    state.handleDragging = { edge, previous: { ...state.selection } };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveHandle(event) {
    if (!state.handleDragging) return;
    event.preventDefault();
    event.stopPropagation();
    const time = snapTime(timeFromPointer(event), event.altKey);
    const minimum = event.altKey ? 0.001 : (snapIntervalSeconds() || 0.001);
    if (state.handleDragging.edge === "start") {
      setSelection(Math.min(time, state.selection.end - minimum), state.selection.end, false, true, event.altKey);
    } else {
      setSelection(state.selection.start, Math.max(time, state.selection.start + minimum), false, true, event.altKey);
    }
  }

  function endHandleDrag(event) {
    if (!state.handleDragging) return;
    event.preventDefault();
    event.stopPropagation();
    state.handleDragging = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setStatus(`选区边界已调整为 ${state.selection.start.toFixed(3)}–${state.selection.end.toFixed(3)} 秒。`, "success");
  }

  function cancelHandleDrag() {
    if (!state.handleDragging) return;
    const previous = state.handleDragging.previous;
    state.handleDragging = null;
    setSelection(previous.start, previous.end, false);
    setStatus("系统取消了边缘调整，已恢复原选区。", "success");
  }

  function nudgeHandle(event, edge) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.key === "ArrowRight" ? 1 : -1) * (snapIntervalSeconds() || 0.01);
    const minimum = event.altKey ? 0.001 : (snapIntervalSeconds() || 0.001);
    if (edge === "start") setSelection(clamp(state.selection.start + delta, 0, state.selection.end - minimum), state.selection.end, true, true);
    else setSelection(state.selection.start, clamp(state.selection.end + delta, state.selection.start + minimum, state.duration), true, true);
  }

  [
    [elements.selectionStartHandle, "start"],
    [elements.selectionEndHandle, "end"],
  ].forEach(([handle, edge]) => {
    handle.addEventListener("pointerdown", event => beginHandleDrag(event, edge));
    handle.addEventListener("pointermove", moveHandle);
    handle.addEventListener("pointerup", endHandleDrag);
    handle.addEventListener("pointercancel", cancelHandleDrag);
    handle.addEventListener("keydown", event => nudgeHandle(event, edge));
  });

  // 共享边手柄的全局 pointermove/up/cancel 路由（在 beginEdgeDrag 中已 setPointerCapture）。
  document.addEventListener("pointermove", moveEdge, true);
  document.addEventListener("pointerup", endEdgeDrag, true);
  document.addEventListener("pointercancel", cancelEdgeDrag, true);

  function applyNumericSelection() {
    const start = Number(elements.selectionStart.value);
    const end = Number(elements.selectionEnd.value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > state.duration || end <= start) {
      setStatus("精确选区尚未生效：请保证 0 ≤ 开始 < 结束 ≤ 音频时长。", "error");
      return;
    }
    setSelection(start, end);
  }
  elements.selectionStart.addEventListener("change", applyNumericSelection);
  elements.selectionEnd.addEventListener("change", applyNumericSelection);
  elements.saveLyricButton.addEventListener("click", saveLyricRegion);
  elements.cancelLyricEditButton.addEventListener("click", () => endLyricEdit(true));
  elements.deleteLyricButton.addEventListener("click", deleteLyric);
  elements.saveChordButton.addEventListener("click", saveChordOverride);
  elements.restoreChordButton.addEventListener("click", restoreChord);

  // 字段级锁定 toggle：用户主动勾选/取消即视为一次提交，记入撤销栈。
  if (elements.lockLyricCheckbox) {
    elements.lockLyricCheckbox.addEventListener("change", () => {
      if (!state.selectedLyricId) return;
      const id = state.selectedLyricId;
      editGraph.begin(`锁定歌词 ${id}`);
      setLocked("lyric", id, elements.lockLyricCheckbox.checked);
      renderLyrics();
      editLyric(id);
      setStatus(elements.lockLyricCheckbox.checked ? `已锁定歌词 ${id}；重生成不会覆盖此字段。` : `已取消锁定歌词 ${id}。`, "success");
    });
  }
  if (elements.lockRestCheckbox) {
    elements.lockRestCheckbox.addEventListener("change", () => {
      if (!state.selectedRestId) return;
      const id = state.selectedRestId;
      editGraph.begin(`锁定休止 ${id}`);
      setLocked("rest", id, elements.lockRestCheckbox.checked);
      renderLyrics();
      editRest(id);
      setStatus(elements.lockRestCheckbox.checked ? `已锁定休止 ${id}。` : `已取消锁定休止 ${id}。`, "success");
    });
  }
  if (elements.lockChordCheckbox) {
    elements.lockChordCheckbox.addEventListener("change", () => {
      const window = selectedChordWindow();
      if (!window) return;
      const key = chordKey(window);
      editGraph.begin(`锁定和弦 ${key}`);
      setLocked("chord", key, elements.lockChordCheckbox.checked);
      renderChords();
      selectChord(window);
      setStatus(elements.lockChordCheckbox.checked ? `已锁定和弦修正 ${key}。` : `已取消锁定和弦 ${key}。`, "success");
    });
  }

  // Stem 混音器事件委托：mute/solo 按钮点击、gain/pan 滑块输入。
  // 用事件委托避免每次 renderStemMixer 都重新绑定监听器（控件不重建，但事件委托更稳）。
  if (elements.stemMixer) {
    elements.stemMixer.addEventListener("click", event => {
      const button = event.target.closest('button[data-stem-control]');
      if (!button) return;
      const row = button.closest("[data-track-id]");
      if (!row) return;
      const trackId = row.dataset.trackId;
      const field = button.dataset.stemControl;
      if (field === "mute" || field === "solo") {
        const track = state.stemTracks.find(item => item.id === trackId);
        if (!track) return;
        updateStemField(trackId, field, !track[field]);
      }
    });
    // input 事件用 change 提交（拖动结束才记撤销点），input 事件只实时更新音频。
    // 这样拖动 gain 滑块不会每个像素都写一条 undo。
    // P1.2 轮 4：trim/fade 字段也通过同一委托处理；trim/fade 字段在 master stem 上实时生效。
    const numberFieldClamps = {
      gain: v => clamp(v, 0, 1.5),
      pan: v => clamp(v, -1, 1),
      trimStartSeconds: v => Math.max(0, v),
      trimEndSeconds: v => Math.max(0, v),
      fadeInSeconds: v => Math.max(0, v),
      fadeOutSeconds: v => Math.max(0, v),
    };
    elements.stemMixer.addEventListener("input", event => {
      const input = event.target.closest('input[data-stem-control]');
      if (!input) return;
      const row = input.closest("[data-track-id]");
      if (!row) return;
      const trackId = row.dataset.trackId;
      const field = input.dataset.stemControl;
      if (!(field in numberFieldClamps)) return;
      const track = state.stemTracks.find(item => item.id === trackId);
      if (!track) return;
      const value = numberFieldClamps[field](Number(input.value));
      if (!Number.isFinite(value)) return;
      // 拖动过程中直接改值并应用混音，但不记 undo（change 事件再提交）
      track[field] = value;
      applyStemMix();
      applyMasterFadeEnvelope();
      // 只更新数值显示，不重建控件
      const gainValue = row.querySelector('[data-stem-readout="gain"]');
      const panValue = row.querySelector('[data-stem-readout="pan"]');
      const statusBadge = row.querySelector('[data-stem-readout="status"]');
      if (field === "gain" && gainValue) gainValue.textContent = `${Math.round(value * 100)}%`;
      if (field === "pan" && panValue) {
        const percent = Math.round(value * 100);
        panValue.textContent = percent === 0 ? "中" : (percent < 0 ? `L ${Math.abs(percent)}` : `R ${percent}`);
      }
      if (statusBadge) {
        const { muted } = stemEffectiveState(track);
        if (track.source === "main") statusBadge.textContent = muted ? "主输出 · 静音" : "主输出";
        else statusBadge.textContent = muted ? "占位 · 静音" : "占位 stem";
      }
    });
    elements.stemMixer.addEventListener("change", event => {
      const input = event.target.closest('input[data-stem-control]');
      if (!input) return;
      const row = input.closest("[data-track-id]");
      if (!row) return;
      const trackId = row.dataset.trackId;
      const field = input.dataset.stemControl;
      if (!(field in numberFieldClamps)) return;
      const value = numberFieldClamps[field](Number(input.value));
      if (!Number.isFinite(value)) return;
      // 拖动结束才记 undo：把当前值视为"新值"，但数据已经改过，所以直接 begin + 保留值。
      const track = state.stemTracks.find(item => item.id === trackId);
      if (!track) return;
      if (track[field] === value) return;
      editGraph.begin(`调整 stem ${track.name} 的 ${field}`);
      track[field] = value;
      applyStemMix();
      applyMasterFadeEnvelope();
      renderStemMixer();
      setStatus(`已调整 ${track.name} 的 ${field}：${formatStemFieldValue(field, value)}。`, "success");
    });
  }

  // 钢琴卷帘事件绑定：目标 stem 选择、拆分/合并/删除按钮、空白处创建音符。
  if (elements.pianoRollStemSelect) {
    elements.pianoRollStemSelect.addEventListener("change", event => {
      state.pianoRollStemId = event.target.value;
      setStatus(`钢琴卷帘目标 stem 已切换为：${state.pianoRollStemId}。`, "success");
    });
  }
  if (elements.splitNoteButton) elements.splitNoteButton.addEventListener("click", splitSelectedNote);
  if (elements.mergeNoteButton) elements.mergeNoteButton.addEventListener("click", mergeSelectedNotes);
  if (elements.quantizeNoteButton) elements.quantizeNoteButton.addEventListener("click", quantizeSelectedNote);
  if (elements.deleteNoteButton) elements.deleteNoteButton.addEventListener("click", () => {
    if (state.selectedNoteId) deleteNote(state.selectedNoteId);
  });
  if (elements.pianoRollGrid) {
    elements.pianoRollGrid.addEventListener("pointerdown", beginNoteCreate);
  }
  // 钢琴卷帘也响应 Ctrl/Cmd + 滚轮缩放（与时间轴同步）。
  if (elements.pianoRollScroll) {
    elements.pianoRollScroll.addEventListener("wheel", event => {
      if (!state.analysis || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const delta = -Math.sign(event.deltaY) * 4;
      const minZoom = Number(elements.zoomRange.min);
      const maxZoom = Number(elements.zoomRange.max);
      const newZoom = clamp(state.zoom + delta, minZoom, maxZoom);
      if (newZoom === state.zoom) return;
      state.zoom = newZoom;
      elements.zoomRange.value = String(state.zoom);
      renderAll();
    }, { passive: false });
  }
  // Esc 取消钢琴卷帘拖动/创建。
  // 删除键删除选中音符（在非文本输入区域）。
  // 这些快捷键在文档级 keydown 中统一处理，避免重复绑定。

  elements.zoomRange.addEventListener("input", event => {
    if (!state.analysis) {
      state.zoom = Number(event.target.value);
      return;
    }
    // 缩放锚点：保持"视口中心对应的时间点"在缩放后仍位于视口中心。
    // 这样用户在时间轴中部缩放时不会丢失当前位置感。
    const scroll = elements.timelineScroll;
    const prevContentWidth = elements.timelineContent.offsetWidth || 1;
    const viewportWidth = scroll.clientWidth;
    const centerPx = scroll.scrollLeft + viewportWidth / 2;
    const centerTime = (centerPx / prevContentWidth) * state.duration;
    state.zoom = Number(event.target.value);
    renderAll();
    const newContentWidth = elements.timelineContent.offsetWidth || 1;
    const newCenterPx = (centerTime / state.duration) * newContentWidth;
    scroll.scrollLeft = Math.max(0, Math.min(Math.max(0, newContentWidth - viewportWidth), newCenterPx - viewportWidth / 2));
  });

  // Ctrl/Cmd + 滚轮在时间轴上缩放，以鼠标位置为锚点。
  // 这是 DAW 类编辑器的常见手感：鼠标指向哪里，缩放就以哪里为定点。
  elements.timelineScroll.addEventListener("wheel", event => {
    if (!state.analysis || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const scroll = elements.timelineScroll;
    const rect = scroll.getBoundingClientRect();
    const pointerOffsetX = event.clientX - rect.left;  // 视口内 X
    const prevContentWidth = elements.timelineContent.offsetWidth || 1;
    const pointerAbsolutePx = scroll.scrollLeft + pointerOffsetX;
    const pointerTime = (pointerAbsolutePx / prevContentWidth) * state.duration;
    const minZoom = Number(elements.zoomRange.min);
    const maxZoom = Number(elements.zoomRange.max);
    const delta = -Math.sign(event.deltaY) * 4;
    const newZoom = clamp(state.zoom + delta, minZoom, maxZoom);
    if (newZoom === state.zoom) return;
    state.zoom = newZoom;
    elements.zoomRange.value = String(state.zoom);
    renderAll();
    // 缩放后调整 scrollLeft，使"鼠标位置对应的时间点"仍位于鼠标视口 X 处。
    const newContentWidth = elements.timelineContent.offsetWidth || 1;
    const newPointerAbsolutePx = (pointerTime / state.duration) * newContentWidth;
    scroll.scrollLeft = Math.max(0, Math.min(Math.max(0, newContentWidth - scroll.clientWidth), newPointerAbsolutePx - pointerOffsetX));
  }, { passive: false });

  // 用户主动滚动时间轴时记录时间戳，让自动跟随暂停 1.5 秒。
  // 区分用户滚动与程序滚动：autoScrollToPlayhead 修改 scrollLeft 时会置 programmaticScroll=true。
  elements.timelineScroll.addEventListener("scroll", () => {
    if (state.programmaticScroll) return;
    state.manualScrollAt = performance.now();
  });
  elements.snapGrid.addEventListener("change", event => {
    state.snapMode = event.target.value;
    if (state.selection.end > state.selection.start) setSelection(state.selection.start, state.selection.end, true, true);
    else setStatus(`吸附已切换为：${event.target.options[event.target.selectedIndex].textContent}。`, "success");
  });
  if (elements.dottedSnap) {
    elements.dottedSnap.addEventListener("change", event => {
      state.dottedSnap = event.target.checked;
      const swingNote = state.swingAmount ? "（与 Swing 叠加）" : "";
      setStatus(state.dottedSnap ? `附点已开启：网格拉长 1.5 倍${swingNote}。` : "附点已关闭。", "success");
    });
  }
  if (elements.swingAmount) {
    elements.swingAmount.addEventListener("input", event => {
      state.swingAmount = Number(event.target.value);
    });
    elements.swingAmount.addEventListener("change", event => {
      const value = Number(event.target.value);
      const percent = Math.round(value * 100);
      setStatus(value === 0 ? "Swing 已关闭：直八分。" : `Swing 已设置为 ${percent}%。`, "success");
    });
  }
  elements.continuousLyrics.addEventListener("change", event => {
    state.continuousLyrics = event.target.checked;
    setStatus(state.continuousLyrics ? "连续歌词区已开启：相邻区域共享边界，移动会同步两侧。" : "连续歌词区已关闭：允许显式休止和空白。", "success");
  });
  // P1.2 轮 4：A/B 试听模式切换。edited 应用 trim/fade；original 忽略非破坏参数，只保留 gain/pan/mute/solo。
  // 切换时立即重新应用混音与包络，让用户听到差异；不记 undo（试听模式不属于编辑操作）。
  if (elements.stemPreviewMode) {
    elements.stemPreviewMode.addEventListener("change", event => {
      state.stemPreviewMode = event.target.value === "original" ? "original" : "edited";
      applyStemMix();
      applyMasterFadeEnvelope();
      enforceMasterTrimBoundary();
      setStatus(state.stemPreviewMode === "original"
        ? "已切换到原始试听：忽略裁切与淡入淡出，只保留 gain/pan/mute/solo。"
        : "已切换到编辑后试听：应用裁切与淡入淡出参数。", "success");
    });
  }
  document.querySelectorAll("[data-layer]").forEach(input => input.addEventListener("change", () => {
    state.layers[input.dataset.layer] = input.checked;
    renderLayerVisibility();
    renderCanvas();
  }));

  document.addEventListener("keydown", event => {
    // 撤销/重做快捷键：Ctrl+Z 撤销，Ctrl+Shift+Z 或 Ctrl+Y 重做
    // 在文本输入框中不拦截，让浏览器原生文本编辑正常工作。
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "z" || event.key === "Z" || event.key === "y" || event.key === "Y")) {
      const target = event.target;
      const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
      if (editingText) return;
      const isRedo = event.shiftKey || event.key === "y" || event.key === "Y";
      event.preventDefault();
      const handled = isRedo ? editGraph.redo() : editGraph.undo();
      if (handled) renderAll();
      return;
    }
    if (event.key === "Escape") {
      if (state.handleDragging) {
        const previous = state.handleDragging.previous;
        state.handleDragging = null;
        setSelection(previous.start, previous.end, false);
        setStatus("已取消边缘调整。", "success");
      } else if (state.edgeDragging) {
        cancelEdgeDrag();
      } else if (state.dragging) {
        const previous = state.dragging.previous;
        state.dragging = null;
        setSelection(previous.start, previous.end, false);
        setStatus("已取消框选。", "success");
      } else if (state.lyricDrag) {
        cancelLyricDrag();
      } else if (state.noteDrag) {
        if (state.noteDrag.mode === "create") cancelNoteCreate();
        else cancelNoteDrag();
      }
      return;
    }
    // Delete / Backspace 删除选中音符（非文本输入区域）
    if ((event.key === "Delete" || event.key === "Backspace") && state.selectedNoteId) {
      const target = event.target;
      const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
      if (!editingText) {
        event.preventDefault();
        deleteNote(state.selectedNoteId);
        return;
      }
    }
    if (event.code !== "Space" || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
    if (editingText || !state.audioUrl) return;
    event.preventDefault();
    togglePlayback();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 80);
  });
  window.addEventListener("pagehide", () => {
    releaseAudioUrl();
    bridge.revokeAllObjectUrls();
    // P2：页面关闭时停止试听合成，避免悬挂的 OscillatorNode。
    stopVocalPreview();
  });

  // ==== P2：歌词音节切分 ===================================================
  // 设计：
  //   - splitLyricToSyllables(region) 把一个 LyricRegion 切分为多个 syllable。
  //   - 中文按字切分；日文按假名音节切分（含拗音合并、促音/拨音单独、长音延续）。
  //   - 时间在 [startAnchorId, endAnchorId] 区间内按 syllable 数量等分；
  //     每等分点创建或复用 anchor（共享边界规则）。
  //   - 切分修改进入 editGraph 撤销/重做栈；锁定字段不被重新切分覆盖。
  //   - 切分后用户可在 UI 中编辑 readingOverride（读音纠正）。

  // 判断字符是否为中文/日文的有效歌词字符（跳过空格、标点、换行）。
  function isLyricTextChar(char) {
    if (!char) return false;
    // 跳过 ASCII 空白与标点
    const code = char.charCodeAt(0);
    if (code <= 0x0020) return false;          // 空白控制字符
    if (code >= 0x3000 && code <= 0x303F) return false; // CJK 标点
    if (code === 0x30FB || code === 0xFF65) return false; // 中点
    if (code === 0xFF0C) return false;          // 全角逗号
    if (code === 0x3001 || code === 0x3002) return false; // 、。
    if (code === 0xFF01 || code === 0xFF1F) return false; // ！？
    if (code === 0xFF1A || code === 0xFF1B) return false; // ：；
    return true;
  }

  // 把一个 LyricRegion 切分为 syllable 数组（不写入 state，只返回切分结果）。
  // 调用者负责把结果合并进 state.syllables 并记录 undo。
  function splitLyricToSyllables(region) {
    if (!region || !region.text) return [];
    if (region.language === "zh") return splitChineseLyric(region);
    if (region.language === "ja") return splitJapaneseLyric(region);
    return [];
  }

  // 中文切分：每个汉字 = 一个 syllable。defaultReading 查 PINYIN_TABLE。
  function splitChineseLyric(region) {
    const text = String(region.text || "");
    const result = [];
    let index = 0;
    for (const char of text) {
      if (!isLyricTextChar(char)) continue;
      const defaultReading = Object.prototype.hasOwnProperty.call(PINYIN_TABLE, char) ? PINYIN_TABLE[char] : "";
      result.push({
        lyricId: region.id,
        index,
        text: char,
        defaultReading,
        readingOverride: "",
      });
      index += 1;
    }
    return result;
  }

  // 日文切分：按假名音节切分。
  //   - 拗音（き+ゃ → きゃ）合并为一个 syllable
  //   - 促音「っ」单独成 syllable，defaultReading = "cl"
  //   - 拨音「ん」单独成 syllable，defaultReading = "n"
  //   - 长音「ー」延续前一个 syllable（不单独成 syllable）
  //   - defaultReading 查 KANA_ROMAJI_TABLE
  function splitJapaneseLyric(region) {
    const text = String(region.text || "");
    const result = [];
    let index = 0;
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i];
      if (!isLyricTextChar(char)) continue;
      // 长音「ー」：不单独成 syllable，跳过（前一个 syllable 的时长会通过 anchor 分配自然延续）
      if (char === "ー") {
        // 若有前一个 syllable，不做任何事（时间分配时它会自动延伸到下一个分点）
        continue;
      }
      // 拗音检测：当前假名 + 下一假名（ゃ/ゅ/ょ）能否合并
      const next = chars[i + 1];
      let syllableText = char;
      if (next && KANA_YOON_SUFFIXES.has(next)) {
        const combined = char + next;
        if (Object.prototype.hasOwnProperty.call(KANA_ROMAJI_TABLE, combined)) {
          syllableText = combined;
          i += 1; // 跳过已合并的拗音后缀
        }
      }
      const defaultReading = Object.prototype.hasOwnProperty.call(KANA_ROMAJI_TABLE, syllableText)
        ? KANA_ROMAJI_TABLE[syllableText]
        : "";
      result.push({
        lyricId: region.id,
        index,
        text: syllableText,
        defaultReading,
        readingOverride: "",
      });
      index += 1;
    }
    return result;
  }

  // 为 syllable 列表分配 anchor（在 LyricRegion 的 [startAnchorId, endAnchorId] 区间内等分）。
  // 共享边界规则：与现有 anchor 在 ANCHOR_TOLERANCE_SECONDS 内则复用。
  // 返回带 id/startAnchorId/endAnchorId 的完整 syllable 对象数组（未写入 state）。
  function allocateSyllableAnchors(region, rawSyllables) {
    if (!region || !rawSyllables.length) return [];
    const startSample = anchorStartSample(region);
    const endSample = anchorEndSample(region);
    const totalSamples = Math.max(1, endSample - startSample);
    const count = rawSyllables.length;
    const result = [];
    for (let i = 0; i < count; i += 1) {
      const startFrac = i / count;
      const endFrac = (i + 1) / count;
      const startSamplePoint = Math.round(startSample + totalSamples * startFrac);
      const endSamplePoint = Math.round(startSample + totalSamples * endFrac);
      const startAnchor = (i === 0)
        ? state.anchors.get(region.startAnchorId)
        : (findAnchorBySample(startSamplePoint) || createAnchorAtSample(startSamplePoint));
      const endAnchor = (i === count - 1)
        ? state.anchors.get(region.endAnchorId)
        : (findAnchorBySample(endSamplePoint) || createAnchorAtSample(endSamplePoint));
      let identifier;
      do {
        identifier = `syllable-${state.nextSyllableId++}`;
      } while (state.syllables.some(s => s.id === identifier));
      result.push({
        id: identifier,
        lyricId: region.id,
        index: rawSyllables[i].index,
        text: rawSyllables[i].text,
        defaultReading: rawSyllables[i].defaultReading,
        readingOverride: rawSyllables[i].readingOverride || "",
        startAnchorId: startAnchor ? startAnchor.id : region.startAnchorId,
        endAnchorId: endAnchor ? endAnchor.id : region.endAnchorId,
      });
    }
    return result;
  }

  // 为指定 LyricRegion 重新切分 syllables（删除旧的、派生新的、分配 anchor）。
  // 锁定的 syllable 不会被覆盖（保留原 readingOverride）。
  // 调用者负责 editGraph.begin / renderAll。
  function resplitSyllablesForRegion(region) {
    if (!region) return;
    // 收集锁定的旧 syllable（按 index 保留 readingOverride）
    const oldSyllables = state.syllables.filter(s => s.lyricId === region.id);
    const lockedOverrides = new Map();
    oldSyllables.forEach(s => {
      if (isLocked("syllable", s.id) && s.readingOverride) {
        lockedOverrides.set(s.index, { override: s.readingOverride, oldId: s.id });
      }
    });
    // 删除旧的 syllable（连同锁定状态）
    state.syllables = state.syllables.filter(s => s.lyricId !== region.id);
    oldSyllables.forEach(s => setLocked("syllable", s.id, false));
    // 派生新的 syllable
    const rawSyllables = splitLyricToSyllables(region);
    const newSyllables = allocateSyllableAnchors(region, rawSyllables);
    // 恢复锁定的 readingOverride（按 index 匹配）
    newSyllables.forEach(s => {
      if (lockedOverrides.has(s.index)) {
        s.readingOverride = lockedOverrides.get(s.index).override;
        setLocked("syllable", s.id, true);
      }
    });
    state.syllables.push(...newSyllables);
    pruneAnchors();
  }

  // 为所有 LyricRegion 派生默认 syllables（用于 0.2.0 → 0.3.0 迁移）。
  // 不记录 undo（迁移是导入的一部分，不是用户操作）。
  function deriveDefaultSyllablesForAllLyrics() {
    state.syllables = [];
    state.nextSyllableId = 1;
    state.lyrics.forEach(region => {
      const rawSyllables = splitLyricToSyllables(region);
      const newSyllables = allocateSyllableAnchors(region, rawSyllables);
      state.syllables.push(...newSyllables);
    });
  }

  // 选中一个 LyricRegion，在 inspector 中显示其 syllable 列表。
  function selectLyricForSyllableEdit(region) {
    if (!region) {
      if (elements.syllableInspector) elements.syllableInspector.hidden = true;
      return;
    }
    if (elements.syllableInspector) elements.syllableInspector.hidden = false;
    renderSyllableInspector(region);
  }

  // 渲染 syllable inspector：显示每个 syllable 的字/假名 + 读音输入框。
  function renderSyllableInspector(region) {
    if (!elements.syllableList || !elements.syllableDetail) return;
    clearElement(elements.syllableList);
    if (!region) {
      elements.syllableDetail.textContent = "请先选择一个歌词区域。";
      return;
    }
    const syllables = state.syllables.filter(s => s.lyricId === region.id).sort((a, b) => a.index - b.index);
    const startSeconds = anchorStartSeconds(region);
    const endSeconds = anchorEndSeconds(region);
    elements.syllableDetail.textContent = `歌词区域 ${region.id} · ${region.language === "zh" ? "中文" : "日文"} · ${startSeconds.toFixed(3)}–${endSeconds.toFixed(3)} 秒 · ${syllables.length} 个音节`;
    syllables.forEach(syllable => {
      const row = document.createElement("div");
      row.className = "syllable-row";
      row.dataset.syllableId = syllable.id;
      row.setAttribute("role", "listitem");
      const indexSpan = document.createElement("span");
      indexSpan.className = "syllable-index";
      indexSpan.textContent = String(syllable.index + 1);
      const textSpan = document.createElement("span");
      textSpan.className = "syllable-text";
      textSpan.textContent = syllable.text || "?";
      const readingInput = document.createElement("input");
      readingInput.type = "text";
      readingInput.className = "syllable-reading";
      readingInput.value = syllable.readingOverride || syllable.defaultReading || "";
      readingInput.placeholder = syllable.defaultReading || "未识别";
      readingInput.dataset.syllableField = "readingOverride";
      readingInput.dataset.syllableId = syllable.id;
      if (!syllable.defaultReading) {
        const warn = document.createElement("span");
        warn.className = "syllable-warn";
        warn.textContent = "未识别";
        row.appendChild(indexSpan);
        row.appendChild(textSpan);
        row.appendChild(readingInput);
        row.appendChild(warn);
      } else {
        row.appendChild(indexSpan);
        row.appendChild(textSpan);
        row.appendChild(readingInput);
      }
      if (state.vocalPreview.active) {
        const activeId = state.vocalPreview.activeSyllableId;
        if (activeId === syllable.id) row.classList.add("preview-active");
      }
      elements.syllableList.appendChild(row);
    });
    refreshLockToggle(elements.lockSyllableWrapper, elements.lockSyllableCheckbox, "syllable", state.selectedSyllableId);
  }

  // 更新单个 syllable 的 readingOverride（用户在输入框中编辑）。
  function updateSyllableReading(syllableId, value) {
    const syllable = state.syllables.find(s => s.id === syllableId);
    if (!syllable) return;
    if (syllable.readingOverride === value) return;
    editGraph.begin(`修改读音 ${syllableId}`);
    syllable.readingOverride = value;
    setStatus(`已更新音节 ${syllableId} 的读音。`, "success");
  }

  // 选中单个 syllable（点击行）。
  function selectSyllable(syllableId) {
    state.selectedSyllableId = syllableId;
    const syllable = state.syllables.find(s => s.id === syllableId);
    if (syllable) {
      const region = state.lyrics.find(r => r.id === syllable.lyricId);
      if (region) renderSyllableInspector(region);
    }
    refreshLockToggle(elements.lockSyllableWrapper, elements.lockSyllableCheckbox, "syllable", syllableId);
  }

  // ==== P2：试听合成（OscillatorNode）=======================================
  // 设计：
  //   - 非破坏：用临时 OscillatorNode 发声，不修改任何持久化数据。
  //   - 收集与当前选中 LyricRegion 时间范围重叠的 NoteEvent（按 startAnchorId 排序）。
  //   - 对每个 NoteEvent，找到 startSample 落在其范围内的 syllable。
  //   - 用 OscillatorNode 按音高发声，duration = NoteEvent 时长。
  //   - sine wave + gain envelope（attack 0.02s, release 0.08s, gain 0.15）。
  //   - 可选：在 UI 高亮当前发声的 syllable。

  // 确保 audioGraph 已初始化（用于试听合成；不依赖 audio 元素）。
  function ensureAudioContextForPreview() {
    if (audioGraph.context) return audioGraph.context;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      audioGraph.context = new Ctor();
      audioGraph.ready = true;
      return audioGraph.context;
    } catch (error) {
      setStatus(`Web Audio API 初始化失败，无法试听：${error.message}`, "error");
      return null;
    }
  }

  // MIDI 音高 → 频率（Hz）。A4 (69) = 440 Hz。
  function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // 开始试听歌声草案。
  function startVocalPreview() {
    if (state.vocalPreview.active) {
      stopVocalPreview();
      return;
    }
    if (!state.analysis) {
      setStatus("请先导入分析 JSON。", "error");
      return;
    }
    // 确定目标 LyricRegion：优先使用当前选中的歌词区域。
    const region = state.selectedLyricId
      ? state.lyrics.find(r => r.id === state.selectedLyricId)
      : state.lyrics[0];
    if (!region) {
      setStatus("请先建立至少一个歌词区域。", "error");
      return;
    }
    // 若该 region 没有 syllable，先派生。
    const hasSyllables = state.syllables.some(s => s.lyricId === region.id);
    if (!hasSyllables) {
      resplitSyllablesForRegion(region);
      renderSyllableInspector(region);
    }
    const ctx = ensureAudioContextForPreview();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => { /* 静默 */ });

    // 收集与 LyricRegion 时间范围重叠的 NoteEvent。
    const regionStartSample = anchorStartSample(region);
    const regionEndSample = anchorEndSample(region);
    const targetStemId = state.pianoRollStemId || "master";
    const candidateNotes = state.notes
      .filter(n => n.stemId === targetStemId || targetStemId === "master")
      .filter(n => {
        const ns = anchorStartSample(n);
        const ne = anchorEndSample(n);
        return ne > regionStartSample && ns < regionEndSample;
      })
      .sort((a, b) => anchorStartSample(a) - anchorStartSample(b));
    if (!candidateNotes.length) {
      setStatus(`当前 stem（${targetStemId}）在歌词区域范围内没有音符；请先在钢琴卷帘创建音符。`, "error");
      return;
    }

    // 收集该 region 的 syllable（按 index 排序）。
    const syllables = state.syllables
      .filter(s => s.lyricId === region.id)
      .sort((a, b) => a.index - b.index);
    if (!syllables.length) {
      setStatus("歌词区域没有可发音的音节。", "error");
      return;
    }

    // 配置试听参数。
    const timbre = state.vocalPreviewTimbre;
    const oscillators = [];
    const scheduleIds = [];
    const startAt = ctx.currentTime + 0.05;
    state.vocalPreview.active = true;
    state.vocalPreview.startAt = startAt;
    state.vocalPreview.activeSyllableId = null;
    if (elements.vocalPreviewButton) elements.vocalPreviewButton.hidden = true;
    if (elements.stopVocalPreviewButton) elements.stopVocalPreviewButton.hidden = false;

    // 为每个 NoteEvent 调度一个 OscillatorNode + GainNode 包络。
    candidateNotes.forEach(note => {
      const noteStartSample = anchorStartSample(note);
      const noteEndSample = anchorEndSample(note);
      const noteStartSec = noteStartSample / state.sampleRateHz;
      const noteEndSec = noteEndSample / state.sampleRateHz;
      const duration = Math.max(0.05, noteEndSec - noteStartSec);
      // 找到 startSample 落在 NoteEvent 范围内的 syllable。
      const syllable = syllables.find(s => {
        const ss = anchorStartSample(s);
        return ss >= noteStartSample - 1 && ss < noteEndSample - 1;
      }) || syllables[0];
      const offset = Math.max(0, noteStartSec - (startAt - ctx.currentTime));
      const scheduleId = setTimeout(() => {
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = timbre.waveform;
          osc.frequency.value = midiToFrequency(note.pitch);
          osc.connect(gain);
          gain.connect(ctx.destination);
          const startCtxTime = ctx.currentTime + 0.001;
          const attack = Math.max(0.001, timbre.attack);
          const release = Math.max(0.001, timbre.release);
          const sustainEnd = startCtxTime + duration;
          const releaseEnd = sustainEnd + release;
          gain.gain.setValueAtTime(0, startCtxTime);
          gain.gain.linearRampToValueAtTime(timbre.gain, startCtxTime + attack);
          gain.gain.setValueAtTime(timbre.gain, sustainEnd);
          gain.gain.linearRampToValueAtTime(0, releaseEnd);
          osc.start(startCtxTime);
          osc.stop(releaseEnd + 0.01);
          oscillators.push(osc);
          // 高亮当前发声的 syllable。
          if (syllable) {
            state.vocalPreview.activeSyllableId = syllable.id;
            const row = elements.syllableList && elements.syllableList.querySelector(`[data-syllable-id="${syllable.id}"]`);
            if (row) {
              elements.syllableList.querySelectorAll(".syllable-row.preview-active").forEach(r => r.classList.remove("preview-active"));
              row.classList.add("preview-active");
            }
          }
          // 自动停止：所有音符播放完毕后。
          osc.onended = () => {
            const idx = oscillators.indexOf(osc);
            if (idx >= 0) oscillators.splice(idx, 1);
            if (oscillators.length === 0 && scheduleIds.length === 0) {
              stopVocalPreview();
            }
          };
        } catch (error) {
          setStatus(`试听合成出错：${error.message}`, "error");
          stopVocalPreview();
        }
      }, Math.max(0, offset * 1000));
      scheduleIds.push(scheduleId);
    });
    state.vocalPreview.oscillators = oscillators;
    state.vocalPreview.scheduleIds = scheduleIds;
    setStatus(`试听歌声草案：${candidateNotes.length} 个音符 · ${syllables.length} 个音节 · ${timbre.waveform}。`, "success");
  }

  // 停止试听合成。
  function stopVocalPreview() {
    if (!state.vocalPreview) return;
    // 清除未触发的调度。
    if (state.vocalPreview.scheduleIds) {
      state.vocalPreview.scheduleIds.forEach(id => clearTimeout(id));
      state.vocalPreview.scheduleIds = [];
    }
    // 停止所有正在发声的 OscillatorNode。
    if (state.vocalPreview.oscillators) {
      state.vocalPreview.oscillators.forEach(osc => {
        try { osc.stop(); } catch (e) { /* 已停止 */ }
        try { osc.disconnect(); } catch (e) { /* 已断开 */ }
      });
      state.vocalPreview.oscillators = [];
    }
    state.vocalPreview.active = false;
    state.vocalPreview.activeSyllableId = null;
    if (elements.vocalPreviewButton) elements.vocalPreviewButton.hidden = false;
    if (elements.stopVocalPreviewButton) elements.stopVocalPreviewButton.hidden = true;
    // 清除高亮。
    if (elements.syllableList) {
      elements.syllableList.querySelectorAll(".syllable-row.preview-active").forEach(r => r.classList.remove("preview-active"));
    }
  }

  // ==== P2：事件绑定 ========================================================

  // 试听按钮：点击开始/停止。
  if (elements.vocalPreviewButton) {
    elements.vocalPreviewButton.addEventListener("click", () => {
      if (state.vocalPreview.active) {
        stopVocalPreview();
        setStatus("已停止试听。", "success");
      } else {
        startVocalPreview();
      }
    });
  }
  if (elements.stopVocalPreviewButton) {
    elements.stopVocalPreviewButton.addEventListener("click", () => {
      stopVocalPreview();
      setStatus("已停止试听。", "success");
    });
  }
  // 音色选择：实时更新 vocalPreviewTimbre（不进入 undo，因为是临时参数）。
  if (elements.vocalTimbreWaveform) {
    elements.vocalTimbreWaveform.addEventListener("change", event => {
      const value = event.target.value;
      if (["sine", "triangle", "square", "sawtooth"].includes(value)) {
        state.vocalPreviewTimbre.waveform = value;
      }
    });
  }
  // 重新切分按钮：为当前选中的 LyricRegion 重新派生 syllables。
  if (elements.resplitSyllablesButton) {
    elements.resplitSyllablesButton.addEventListener("click", () => {
      const region = state.selectedLyricId
        ? state.lyrics.find(r => r.id === state.selectedLyricId)
        : state.lyrics[0];
      if (!region) {
        setStatus("请先选择一个歌词区域。", "error");
        return;
      }
      editGraph.begin(`重新切分 ${region.id}`);
      resplitSyllablesForRegion(region);
      renderSyllableInspector(region);
      setStatus(`已重新切分歌词区域 ${region.id}。`, "success");
    });
  }
  // 音节读音输入：change 事件提交 undo。
  if (elements.syllableList) {
    elements.syllableList.addEventListener("change", event => {
      const input = event.target.closest('input[data-syllable-field="readingOverride"]');
      if (!input) return;
      const syllableId = input.dataset.syllableId;
      if (!syllableId) return;
      updateSyllableReading(syllableId, input.value.trim());
    });
    // 点击行选中 syllable。
    elements.syllableList.addEventListener("click", event => {
      const row = event.target.closest("[data-syllable-id]");
      if (!row) return;
      selectSyllable(row.dataset.syllableId);
    });
  }
  // 锁定 syllable 读音。
  if (elements.lockSyllableCheckbox) {
    elements.lockSyllableCheckbox.addEventListener("change", () => {
      const id = state.selectedSyllableId;
      if (!id) return;
      editGraph.begin(`锁定读音 ${id}`);
      setLocked("syllable", id, elements.lockSyllableCheckbox.checked);
      setStatus(elements.lockSyllableCheckbox.checked ? `已锁定音节 ${id}。` : `已解锁音节 ${id}。`, "success");
    });
  }
})();
