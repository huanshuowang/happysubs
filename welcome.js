// The welcome page, opened once by background.js after a fresh install.
//
// Its strings live here rather than in i18n.js: that file is injected into
// every video page, and these are read exactly once. i18n.js is still loaded,
// for the one thing that has to agree with the popup — which language the
// panel speaks.

(() => {
  const STRINGS = {
    en: {
      pageTitle: "Welcome to HappySubs",
      eyebrow: "Installed",
      headline: "You're set.<br>On YouTube, <em>turn on CC</em> first.",
      lede: "HappySubs translates the captions a video already has. On Vimeo and Bilibili there's nothing to switch on.",
      demoAlt: "Demo: the HappySubs icon in the toolbar, then a click on the player's CC button, and the subtitle appears in two languages.",
      demoBadge: "DEMO",
      step1Title: "Pin it to the toolbar",
      step1Body: "Click the puzzle-piece icon by the address bar, then the pin next to HappySubs.",
      step2Title: "Open a video, click CC",
      step2Body: "Bottom right of the player. <strong>Refresh any video page that was already open.</strong>",
      step3Title: "Both languages appear",
      step3Body: "The second language is <strong>{lang}</strong>. Click the toolbar icon to change it.",
      step3BodyNoLang: "Click the toolbar icon to change the second language.",
      tryIt: "Try it on a video",
      tryNote: "A TED talk with human-made captions",
      tipsTitle: "Worth knowing",
      tipLive: "No captions on a video at all? <a href=\"https://huanshuowang.com/happysubs/#live\" target=\"_blank\" rel=\"noopener\">Live transcription</a> writes them as it plays.",
      tipShortcut: "{key} turns the second language on and off without opening the popup.",
      tipOnly: "Turn on <strong>Translation only</strong> in the popup to read just the translation, with CC off.",
      tipDrag: "Hover over the subtitle and a handle appears — <strong>drag it</strong> up or down, full screen included.",
      tipSrt: "Download what you're watching as an <strong>.srt</strong>, in both languages or either one.",
      footerNote: "Free, open source, and no usage data collected.",
      linkSite: "Website",
      linkPrivacy: "Privacy"
    },
    zh: {
      pageTitle: "HappySubs 已安装",
      eyebrow: "已安装",
      headline: "装好了。<br>在 YouTube 上，先<em>打开 CC</em>。",
      lede: "HappySubs 翻译的是视频自带的字幕。Vimeo 和 B\u2060站 上什么都不用开。",
      demoAlt: "演示：工具栏里的 HappySubs 图标，然后点下播放器的 CC，字幕以两种语言出现。",
      demoBadge: "演示",
      step1Title: "固定到工具栏",
      step1Body: "点地址栏右边的拼图图标，再点 HappySubs 旁边的图钉。",
      step2Title: "打开视频，点 CC",
      step2Body: "在播放器右下角。<strong>安装前就开着的视频页，要先刷新一次。</strong>",
      step3Title: "双语字幕出现",
      step3Body: "第二语言是<strong>{lang}</strong>，点工具栏图标可以换。",
      step3BodyNoLang: "点工具栏图标可以换第二语言。",
      tryIt: "打开一个视频试试",
      tryNote: "一个带人工字幕的 TED 演讲",
      tipsTitle: "几个顺手的功能",
      tipLive: "视频完全没有字幕？<a href=\"https://huanshuowang.com/happysubs/#live\" target=\"_blank\" rel=\"noopener\">实时听译</a>可以边播边写出来。",
      tipShortcut: "{key} 随时开关第二语言，不用打开弹窗。",
      tipOnly: "在弹窗里打开<strong>「仅显示翻译字幕」</strong>，不开 CC 也能只看译文。",
      tipDrag: "鼠标碰到字幕会浮出把手，<strong>按住就能上下拖</strong>，全屏也行。",
      tipSrt: "正在看的字幕可以导出成 <strong>.srt</strong>，双语、仅原文、仅译文都行。",
      footerNote: "免费、开源，不收集任何使用数据。",
      linkSite: "官网",
      linkPrivacy: "隐私政策"
    }
  };

  // The demo's subtitle, in the language this install will actually translate
  // into — the first thing a new user sees should be their own language.
  const ORIGINAL = "Learning a language is easier when you can see both.";
  const DEMO_LINES = {
    "zh-Hans": "能同时看到两种语言，学起来就容易多了。",
    "zh-Hant": "能同時看到兩種語言，學起來就容易多了。",
    ja: "両方の言語が見えると、語学はずっと楽になる。",
    ko: "두 언어를 함께 보면 언어 공부가 훨씬 쉬워져요.",
    es: "Aprender un idioma es más fácil cuando ves los dos.",
    fr: "Apprendre une langue est plus facile quand on voit les deux.",
    de: "Eine Sprache lernt sich leichter, wenn man beide sieht.",
    pt: "Aprender um idioma é mais fácil quando você vê os dois.",
    it: "Imparare una lingua è più facile quando le vedi entrambe.",
    ru: "Учить язык гораздо проще, когда видишь оба.",
    vi: "Học ngoại ngữ dễ hơn nhiều khi bạn thấy cả hai.",
    id: "Belajar bahasa jauh lebih mudah kalau kamu bisa melihat keduanya."
  };

  function demoLines(target) {
    const t = String(target || "").toLowerCase();
    // Translating into English: the demo runs the other way round.
    if (t.startsWith("en")) return [DEMO_LINES["zh-Hans"], ORIGINAL];
    const key = t.startsWith("zh") ? (/hant|tw|hk|mo/.test(t) ? "zh-Hant" : "zh-Hans") : t.split("-")[0];
    return [ORIGINAL, DEMO_LINES[key] || DEMO_LINES["zh-Hans"]];
  }

  function languageName(code, uiLang) {
    try {
      const names = new Intl.DisplayNames([uiLang === "zh" ? "zh-Hans" : "en"], { type: "language" });
      return names.of(code) || "";
    } catch { return ""; }
  }

  function isMac() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    return /mac/i.test(p);
  }

  // Opened as a file or from the site while testing, there is no extension
  // storage to read — the defaults are what a fresh install has anyway.
  function storedSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(["ydsSettings"], (r) => resolve((r && r.ydsSettings) || {}));
      } catch { resolve({}); }
    });
  }

  function fill(t, uiLang, secondLang) {
    document.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
    document.title = t.pageTitle;
    for (const el of document.querySelectorAll("[data-t]")) el.textContent = t[el.dataset.t];
    // Only this file's own constants ever go through innerHTML.
    for (const el of document.querySelectorAll("[data-html]")) el.innerHTML = t[el.dataset.html];
    for (const el of document.querySelectorAll("[data-aria]")) el.setAttribute("aria-label", t[el.dataset.aria]);

    const name = languageName(secondLang, uiLang);
    document.getElementById("step3Body").innerHTML = name
      ? t.step3Body.replace("{lang}", name)
      : t.step3BodyNoLang;

    const key = isMac() ? "<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>S</kbd>" : "<kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>S</kbd>";
    document.getElementById("tipShortcut").innerHTML = t.tipShortcut.replace("{key}", key);

    const [src, tr] = demoLines(secondLang);
    document.getElementById("demoSrc").textContent = src;
    document.getElementById("demoTr").textContent = tr;

    // Names the language it switches to, in that language.
    const toggle = document.getElementById("langToggle");
    toggle.textContent = uiLang === "zh" ? "EN" : "中";
    toggle.setAttribute("aria-label", uiLang === "zh" ? "Switch to English" : "切换到中文");
  }

  // The switch here is the panel's own language setting, not just this page's:
  // someone who flips it on their first screen wants the popup in that
  // language too, and would otherwise have to find the setting to do it again.
  function saveUiLang(lang) {
    try {
      chrome.storage.sync.get(["ydsSettings"], (r) => {
        const cur = (r && r.ydsSettings) || {};
        chrome.storage.sync.set({ ydsSettings: { ...cur, uiLang: lang } });
      });
    } catch {}
  }

  storedSettings().then((s) => {
    const uiLang = typeof ydsSetUiLang === "function" ? ydsSetUiLang(s.uiLang) : "en";
    const secondLang = s.secondLang || (typeof ydsDefaultSecondLang === "function" ? ydsDefaultSecondLang() : "zh-Hans");
    let current = uiLang === "zh" ? "zh" : "en";
    fill(STRINGS[current], current, secondLang);

    document.getElementById("langToggle").addEventListener("click", () => {
      current = current === "zh" ? "en" : "zh";
      if (typeof ydsSetUiLang === "function") ydsSetUiLang(current);
      fill(STRINGS[current], current, secondLang);
      saveUiLang(current);
    });
  });
})();
