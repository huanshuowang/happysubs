// Shared i18n for the popup, the options page and the content script.
//
// By default the UI language follows the browser: any zh-* locale gets Chinese,
// everything else gets English. The options page can override that, so callers
// pass the stored preference to ydsSetUiLang() once their settings have loaded.
// ydsT() is always read lazily, so switching the language later just works —
// re-render and every string comes back in the new language.

(() => {
  function rawUiLang() {
    try {
      const l = chrome?.i18n?.getUILanguage?.();
      if (l) return l;
    } catch {}
    try { return navigator.language || ""; } catch {}
    return "";
  }

  function autoLang() {
    return /^zh/i.test(rawUiLang()) ? "zh" : "en";
  }

  let YDS_LANG = autoLang();

  // pref: "auto" | "zh" | "en" (anything unrecognised falls back to auto).
  function ydsSetUiLang(pref) {
    YDS_LANG = (pref === "zh" || pref === "en") ? pref : autoLang();
    globalThis.ydsUiLang = YDS_LANG;
    return YDS_LANG;
  }

  // Default second-subtitle language guessed from the browser UI language,
  // used before the user picks one themselves.
  // The language to translate INTO on a fresh install: the browser's own
  // language, because that is what its owner reads.
  //
  // English is the exception, and deliberately so. Most of what people watch
  // with this is in English, so an English-locale browser would default to
  // translating English into English — a new user sees nothing happen and has
  // no reason to think the extension works at all. Those installs start on
  // Simplified Chinese instead, which is who this was built for; everyone else
  // keeps their own language, and the picker is the first control in the popup.
  function ydsDefaultSecondLang() {
    const l = rawUiLang().toLowerCase();
    if (l.startsWith("zh")) return /tw|hk|mo|hant/.test(l) ? "zh-Hant" : "zh-Hans";
    if (l.startsWith("en") || !l) return "zh-Hans";
    return l.split("-")[0];
  }

  const MESSAGES = {
    en: {
      appTitle: "HappySubs",
      enable: "Enable",
      secondLanguage: "2nd language",
      translationSource: "Translator",
      providerGoogle: "Google Translate (free)",
      providerClaude: "Claude",
      providerOpenai: "OpenAI",
      providerGemini: "Google Gemini",
      providerDeepseek: "DeepSeek",
      providerNative: "Video's own subtitles",
      providerUnknown: "Unknown",
      pasteHere: "Paste here",
      keyStateTitle: "API Key status",
      keySavedTitle: "API Key saved",
      keyMissingTitle: "No API Key yet",
      edit: "Edit",
      done: "Done",
      getKeyLink: "Get {name} key →",
      usePaidApiBtn: "Translate this video with {name} API",
      usePaidApiBtnGeneric: "Translate this video with the selected API",
      askEachVideo: "Ask on every video whether to use the paid API",
      tabTranslate: "Translate",
      tabLive: "Live transcribe",
      liveStart: "Start live transcription",
      liveStop: "Stop live transcription",
      liveIdle: "Recognition runs only on this computer, and needs a local program installed.",
      liveConnecting: "Connecting to the local recogniser…",
      liveListening: "Listening. Captions appear as people speak.",
      statusLiveRunning: "Live transcription is running — these captions come from the recogniser on your machine, not from a subtitle track.",
      liveUnavailable: "Port 8765 has no recogniser. Install it, start it, then press start again.",
      liveNoVideo: "No video found on this page.",
      liveCaptureFailed: "Could not tap this video's audio. Press play first, then start transcription.",
      liveSetupLink: "Setup guide →",
      liveHasTrack: "This video has a subtitle track too — more accurate. Stop live captions to get it back.",
      optionsTitle: "HappySubs settings",
      interfaceSection: "Interface",
      interfaceLanguage: "Panel language",
      langAuto: "Follow the browser",
      langZh: "中文",
      langEn: "English",
      langNote: "Applies to the popup, this page and the prompts drawn on the video.",
      behaviourSection: "Default behaviour",
      behaviourNote: "These are the same switches as in the popup — they are remembered across videos and browser restarts, so whatever you set here is how every video starts.",
      openPopupNote: "Second language, translator and API keys live in the toolbar popup.",
      saved: "Saved",
      translationOnly: "Translation only (no need to turn on captions)",
      subtitleMode: "Subtitle style",
      model: "Model",
      paidPolicy: "Paid API",
      paidPolicyAsk: "ask me on every video",
      paidPolicyAlways: "use it on every video",
      paidPolicyManual: "only when I press the button",
      paidPolicyOnAsk: "You'll be asked on each video.",
      paidPolicyOnAlways: "Every video will be translated with the paid API.",
      paidPolicyOnManual: "Nothing paid runs until you press the button.",
      toastTranslating: "Translating with {name}…",
      toastPendingPaid: "{name} standing by",
      errKeyRejected: "{name} rejected the API key — check it in the popup, or paste a new one",
      errNoCredit: "{name} says the account has no credit left",
      errRateLimited: "{name} is rate-limiting these requests — try again shortly",
      errProviderDown: "{name} is not responding right now — try again shortly",
      errBadRequest: "{name} refused the request — if you typed a model name, check it",
      toastDone: "Translated · {name} · {n} lines",
      toastFailed: "{name} translation failed",
      toastNoKey: "No {name} API key — add one in the extension popup",
      toastNeedsReload: "No subtitles loaded for this video yet — reload the page and try again",
      toastAwaiting: "Press “Translate this video” in the popup to use {name}",
      toastFellBack: "Fell back to {name}",
      toastPartial: "{n} lines could not be translated",
      modelCustomOption: "Custom…",
      modelList: "List",
      modelCustomHint: "not listed? pick Custom… and type it in",
      exportSrt: "Export subtitles",
      srtBilingual: "Both languages",
      srtOriginal: "Original only",
      srtTranslation: "Translation only",
      srtDownload: "Download",
      srtEmpty: "Nothing to export yet — no subtitles have been loaded for this video.",
      srtSavedLive: "Saved {n} lines from the live transcript.",
      srtSaved: "Saved {n} subtitle lines.",
      openSettings: "Settings",
      back: "Back",
      appearanceSection: "Subtitle appearance",
      modeInline: "Both languages",
      modeNote: "Both languages: a video with its own captions follows the player; only an auto-captioned one gets its bilingual subtitle drawn by the extension.",
      resetAppearance: "Reset appearance",
      takeoverCaptions: "Always draw both languages myself",
      appearanceNote: "On this video the translation is going inside the player's own caption, so it takes the player's font and size and nothing here applies. Choose \u201cTranslation only\u201d above to put it in our own box instead.",
      takeoverNote: "On: the extension takes over the original and the translation on every video, and you can style them in Settings.",
      takeoverNoteOn: "Every video now shows the extension's own bilingual subtitle.",
      unifyStyles: "One set of settings for both languages",
      styleSourceHead: "Original",
      styleTargetHead: "Translation",
      modeFloating: "Translation only",
      statusTranslationOnly: "Translation-only mode: the second language shows on its own, with the player's captions closed.",
      statusTranslationOnlyNeedsCc: "Translation-only mode is on, but no subtitles have been picked up yet. Click CC once in the player, then turn it back off — the extension keeps the track and shows the translation on its own.",
      verticalPosition: "Vertical position",
      captionWidth: "Subtitle width",
      fontSizePx: "Font size (px)",
      textColor: "Text color",
      bgOpacity: "Background transparency",
      loadingInfo: "Fetching subtitle info for the current video…",

      offSecondSub: "— Second subtitle off —",
      groupNative: "This video's native subtitles",
      asrSuffix: " · auto-generated",
      groupAutoTranslate: "Auto-translate",
      groupCommon: "Common",
      groupAll: "All languages",

      statusNoTab: "Open a video on YouTube, Vimeo or Bilibili to use this extension.",
      statusNoComm: "Can't reach this page yet. If you clicked through from a listing page, open the video in a new tab or refresh the {platform} tab.",
      statusNative: "Now showing this video's native {lang} subtitles (no translation API used).",
      statusNativeFallbackLang: "target-language",
      statusDone: "Translated · {name} · {count} lines",
      statusTranslating: "Translating subtitles with the {name} API{progress}…",
      progressFmt: " ({done}/{total})",
      statusCancelledFallback: "Now using Google Translate ({name} API was cancelled).",
      cueTranslateFailed: "⚠️ Translation failed (the free endpoint is rate-limiting) — pick another translator in the extension popup, or reload to retry.",
      statusPartial: "{name} translated {done} lines, but {missing} could not be translated — the free endpoint is rate-limiting. Those lines stay in the original language; reload to try again.{error}",
      statusFallback: "Now using Google Translate (fell back after {name} failed). {error}",
      errorPrefix: "Error: ",
      statusAwaiting: "Awaiting confirmation: this video will only use the {name} API after you click the button above. Until then, free Google Translate is used.",
      statusNeedKey: "{name} needs an API Key. Free Google Translate is used until you add one.",
      statusError: "{name} translation failed: {error}",
      unknownError: "unknown error",
      statusDetected: "{platform} subtitles detected. Pick a translator and add a key; the page will retranslate automatically. Translation hasn't finished yet.",
      statusTurnOnCC: "Turn on captions with the CC button in the YouTube player first; the extension will translate and overlay a second language automatically.",
      statusVimeoReading: "Reading Vimeo's subtitle track. Hit CC in the player if you also want the original on screen.",
      statusBilibiliReading: "Reading Bilibili's subtitle track. Turn on subtitles in the player if you also want the original on screen.",
      statusBilibiliNoTrack: "This video has no subtitle track. Bilibili only lists tracks for signed-in viewers — if you are signed in, the video genuinely has none, and live transcription is the way to caption it.",

      statusLangSwitched: "Target language changed. The page is re-checking native subtitles or retranslating…",
      statusProviderSwitched: "Switched to {name}. The paid API won't be called until you confirm.",
      askOn: "On: each new video will ask whether to use the paid API.",
      askOff: "Off: the paid API is only called after you click the translate button.",
      statusStartingPaid: "Starting {name} API translation for this video…",
      statusPaidFailed: "Couldn't start the paid API. Make sure captions are on, then refresh and try again.",
      keySaved: "{name} API Key saved. It is only called after you click the button above.",
      keyCleared: "{name} API Key cleared.",
      initFailed: "Initialization failed: ",

      paidPromptTitle: "Use the {name} API for this video?",
      paidPromptBody: "This calls your {name} key and may incur costs. If you cancel, this video keeps using free Google Translate.",
      paidPromptFree: "Use free Google",
      paidPromptUse: "Use {name} API",
      paidDeclined: "Paid API declined; this video uses free Google Translate",
      notPaidProvider: "The selected translator is not a paid API",
      noSourceCues: "This video has no translatable source subtitles, or native subtitles are already in use",
      dragHint: "Drag up/down to move the subtitles",

      rateTitle: "Enjoying HappySubs?",
      rateBody: "I'm an independent developer. If you like this extension, please help me by leaving a rating in the store, so more people can find HappySubs. Thank you for your support.",
      rateYes: "Rate it",
      rateNo: "No thanks",
      rateLast: "(This will be the last time I ask.)",
      rateBanner: "Enjoying HappySubs? Leave a rating.",

      shortcutHint: "{key} turns the second language on and off",
      shortcutUnset: "No keyboard shortcut set.",
      shortcutSet: "Set one"
    },
    zh: {
      appTitle: "HappySubs",
      enable: "启用",
      secondLanguage: "第二语言",
      translationSource: "翻译源",
      providerGoogle: "Google Translate（免费）",
      providerClaude: "Claude",
      providerOpenai: "OpenAI",
      providerGemini: "Google Gemini",
      providerDeepseek: "DeepSeek",
      providerNative: "视频自带字幕",
      providerUnknown: "未知",
      pasteHere: "粘贴到这里",
      keyStateTitle: "API Key 状态",
      keySavedTitle: "已保存 API Key",
      keyMissingTitle: "尚未填写 API Key",
      edit: "编辑",
      done: "完成",
      getKeyLink: "获取 {name} key →",
      usePaidApiBtn: "本视频使用 {name} API 翻译",
      usePaidApiBtnGeneric: "本视频使用所选 API 翻译",
      askEachVideo: "每次打开视频自动询问是否使用付费 API",
      tabTranslate: "直接翻译",
      tabLive: "实时听译",
      liveStart: "开启实时听译",
      liveStop: "关闭实时听译",
      liveIdle: "识别仅在本机运行，需要安装本地插件。",
      liveConnecting: "正在连接本地识别服务…",
      liveListening: "已连接，说话时会出字幕。",
      statusLiveRunning: "实时听译进行中——画面上的字幕来自本机识别，不是视频自带的字幕轨。",
      liveUnavailable: "8765 端口没有识别服务。装好并启动后再点开启。",
      liveNoVideo: "这个页面上没找到视频。",
      liveCaptureFailed: "抓不到这个视频的音频。先点一下播放，再开启听译。",
      liveSetupLink: "安装说明 →",
      liveHasTrack: "这个视频有字幕轨，比识别准。关掉听译即可切回。",
      optionsTitle: "HappySubs 设置",
      interfaceSection: "界面",
      interfaceLanguage: "面板语言",
      langAuto: "跟随浏览器",
      langZh: "中文",
      langEn: "English",
      langNote: "作用于插件弹窗、本页面，以及视频上弹出的提示。",
      behaviourSection: "默认行为",
      behaviourNote: "这两个开关和弹窗里是同一个——设置会跨视频、跨重启保留，所以在这里设成什么，每个视频打开时就是什么。",
      openPopupNote: "第二语言、翻译源和 API Key 在工具栏弹窗里设置。",
      saved: "已保存",
      translationOnly: "仅显示翻译字幕（不用开原生字幕）",
      subtitleMode: "字幕样式",
      model: "模型",
      paidPolicy: "付费 API",
      paidPolicyAsk: "每个视频都问我",
      paidPolicyAlways: "所有视频都用它",
      paidPolicyManual: "只在我点按钮时",
      paidPolicyOnAsk: "之后每个视频都会问你一次。",
      paidPolicyOnAlways: "之后所有视频都会用付费 API 翻译。",
      paidPolicyOnManual: "不点按钮就不会调用付费 API。",
      toastTranslating: "正在用 {name} 翻译…",
      toastPendingPaid: "{name} 准备翻译",
      errKeyRejected: "{name} 拒绝了这个 API Key —— 在弹窗里检查一下，或者换一个",
      errNoCredit: "{name} 说这个账号余额不足",
      errRateLimited: "{name} 正在限流 —— 过一会儿再试",
      errProviderDown: "{name} 暂时没有响应 —— 过一会儿再试",
      errBadRequest: "{name} 拒绝了这次请求 —— 如果模型名是手填的，检查一下拼写",
      toastDone: "翻译完成 · {name} · {n} 条",
      toastFailed: "{name} 翻译失败",
      toastNoKey: "没有 {name} 的 API Key —— 在插件弹窗里填一个",
      toastNeedsReload: "还没拿到这个视频的字幕 —— 刷新页面后再试",
      toastAwaiting: "在弹窗里点「本视频使用所选 API 翻译」即可用 {name}",
      toastFellBack: "已回退到 {name}",
      toastPartial: "有 {n} 条没能翻译出来",
      modelCustomOption: "自定义…",
      modelList: "列表",
      modelCustomHint: "列表里没有的模型，选「自定义…」自己填",
      exportSrt: "导出字幕",
      srtBilingual: "双语",
      srtOriginal: "仅原文",
      srtTranslation: "仅译文",
      srtDownload: "下载",
      srtEmpty: "还没有可导出的内容——这个视频还没取到字幕。",
      srtSavedLive: "已保存实时听译的 {n} 行。",
      srtSaved: "已保存 {n} 行字幕。",
      openSettings: "设置",
      back: "返回",
      appearanceSection: "字幕外观",
      modeInline: "双语字幕",
      modeNote: "双语字幕：自带字幕的视频跟随播放器，只有自动生成字幕的视频由插件生成双语字幕。",
      resetAppearance: "恢复默认外观",
      takeoverCaptions: "所有视频都由插件画双语",
      appearanceNote: "这个视频的译文是加进播放器自己的字幕里的，字体和大小都跟着播放器走，所以这里设什么都没用。把上面的字幕样式改成「仅显示译文」，译文就会放进插件自己的框里，这些设置才生效。",
      takeoverNote: "打开后，所有视频字幕均由插件接管原文和译文，可在设置中自定义样式。",
      takeoverNoteOn: "所有视频均显示插件样式双语字幕。",
      unifyStyles: "原文和译文用同一套",
      styleSourceHead: "原文",
      styleTargetHead: "译文",
      modeFloating: "仅显示译文",
      statusTranslationOnly: "仅翻译模式：不开播放器字幕也会单独显示第二语言。",
      statusTranslationOnlyNeedsCc: "仅翻译模式已开启，但还没取到字幕。在播放器里点一下 CC 再关掉即可——扩展会留着这份字幕，之后单独显示译文。",
      verticalPosition: "垂直位置",
      captionWidth: "字幕宽度",
      fontSizePx: "字号 (px)",
      textColor: "文字颜色",
      bgOpacity: "背景透明度",
      loadingInfo: "正在获取当前视频的字幕信息…",

      offSecondSub: "— 关闭第二字幕 —",
      groupNative: "该视频原生字幕",
      asrSuffix: " · 自动生成",
      groupAutoTranslate: "自动翻译",
      groupCommon: "常用",
      groupAll: "全部语言",

      statusNoTab: "打开 YouTube、Vimeo 或 B 站上的视频页面即可使用。",
      statusNoComm: "还连不上这个页面。如果你是从列表页点进来的，刷新一下 {platform} 页面（或在新标签页打开视频）即可。",
      statusNative: "当前使用：视频自带 {lang} 字幕（未调用翻译 API）。",
      statusNativeFallbackLang: "目标语言",
      statusDone: "已翻译 · {name} · {count} 条", 
      statusTranslating: "正在调用：{name} API 翻译字幕{progress}…",
      progressFmt: "（{done}/{total}）",
      statusCancelledFallback: "当前使用：Google Translate（已取消 {name} API）。",
      cueTranslateFailed: "⚠️ 翻译失败（免费接口在限流）——请在插件里换一个翻译源，或刷新页面重试。",
      statusPartial: "{name} 翻好了 {done} 条，还有 {missing} 条没翻出来——免费接口在限流。这些行暂时保持原文，刷新页面可以重试。{error}",
      statusFallback: "当前使用：Google Translate（{name} 调用失败后回退）。{error}",
      errorPrefix: "错误：",
      statusAwaiting: "等待确认：点击上方按钮后，本视频才会使用 {name} API。未确认前使用免费 Google Translate。",
      statusNeedKey: "{name} 需要 API Key。未填写前会使用免费 Google Translate。",
      statusError: "{name} 翻译失败：{error}",
      unknownError: "未知错误",
      statusDetected: "已检测到 {platform} 字幕。选择翻译源并填写 key 后，页面会自动重新翻译；当前还没有完成翻译。",
      statusTurnOnCC: "请先点开 YouTube 播放器右下角的 CC 按钮开启原生字幕，扩展会自动翻译并叠加第二种语言。",
      statusVimeoReading: "正在读取 Vimeo 字幕轨。想同时看到原文，点一下播放器的 CC 就行。",
      statusBilibiliReading: "正在读取 B 站字幕轨。想同时看到原文，在播放器里打开字幕即可。",
      statusBilibiliNoTrack: "这个视频没有字幕轨。B 站只对登录用户返回字幕列表——如果你已登录，那就是真的没有，用实时听译来出字幕。",

      statusLangSwitched: "已切换目标语言。页面正在重新检测 native 字幕或翻译…",
      statusProviderSwitched: "已切换为 {name}。未点击确认前不会调用付费 API。",
      askOn: "已开启：每次打开视频会自动询问是否使用付费 API。",
      askOff: "已关闭：付费 API 只会在你点击“本视频使用所选 API 翻译”后调用。",
      statusStartingPaid: "正在为本视频启动 {name} API 翻译…",
      statusPaidFailed: "无法启动付费 API。请确认页面已打开字幕并刷新后重试。",
      keySaved: "已保存 {name} API Key。需要点击上方按钮才会调用。",
      keyCleared: "{name} API Key 已清空。",
      initFailed: "初始化失败：",

      paidPromptTitle: "是否为本视频使用 {name} API？",
      paidPromptBody: "这会调用你的 {name} Key，可能产生费用。取消后本视频会继续使用免费的 Google Translate。",
      paidPromptFree: "用免费 Google",
      paidPromptUse: "使用 {name} API",
      paidDeclined: "用户取消了付费 API，本视频使用免费 Google Translate",
      notPaidProvider: "当前翻译源不是付费 API",
      noSourceCues: "当前视频没有可翻译的源字幕，或已经使用 native 字幕",
      dragHint: "上下拖动调整字幕位置",

      rateTitle: "HappySubs 用着还顺手吗？",
      rateBody: "我是一个独立开发者。如果你喜欢这个插件，请帮助我在应用商店留个评分，让更多人找到 HappySubs。感谢你的支持。",
      rateYes: "去评分",
      rateNo: "不了，谢谢",
      rateLast: "（这会是我最后一次询问）",
      rateBanner: "用得顺手的话，给个评分吧",

      shortcutHint: "{key} 随时开关第二语言",
      shortcutUnset: "还没有设置快捷键。",
      shortcutSet: "去设置"
    }
  };

  function ydsT(key, subs) {
    let msg = MESSAGES[YDS_LANG][key] ?? MESSAGES.en[key] ?? key;
    if (subs) {
      for (const [k, v] of Object.entries(subs)) {
        msg = msg.split(`{${k}}`).join(String(v));
      }
    }
    return msg;
  }

  globalThis.ydsT = ydsT;
  globalThis.ydsUiLang = YDS_LANG;
  globalThis.ydsSetUiLang = ydsSetUiLang;
  globalThis.ydsDefaultSecondLang = ydsDefaultSecondLang;
})();
