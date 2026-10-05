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
      step3Body: "Both appear together, one line at a time. Change the language any time from the toolbar icon.",
      pickLabel: "Translate subtitles into",
      pickSaved: "✓ Saved",
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
      step3Body: "原文和译文合成一条，一句一换。以后想换语言，点工具栏图标就行。",
      pickLabel: "字幕翻译成",
      pickSaved: "✓ 已保存",
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
    },
    "zh-Hant": {
      pageTitle: "HappySubs 已安裝",
      eyebrow: "已安裝",
      headline: "裝好了。<br>在 YouTube 上，先<em>開啟 CC</em>。",
      lede: "HappySubs 翻譯的是影片內建的字幕。Vimeo 和 B⁠站 上什麼都不用開。",
      demoAlt: "示範：工具列裡的 HappySubs 圖示，然後點下播放器的 CC，字幕以兩種語言出現。",
      demoBadge: "示範",
      step1Title: "固定到工具列",
      step1Body: "點位址列右邊的拼圖圖示，再點 HappySubs 旁邊的圖釘。",
      step2Title: "開啟影片，點 CC",
      step2Body: "在播放器右下角。<strong>安裝前就開著的影片頁，要先重新整理一次。</strong>",
      step3Title: "雙語字幕出現",
      step3Body: "原文和譯文合成一條，一句一換。以後想換語言，點工具列圖示就行。",
      pickLabel: "字幕翻譯成",
      pickSaved: "✓ 已儲存",
      tryIt: "開啟一個影片試試",
      tryNote: "一個帶人工字幕的 TED 演講",
      tipsTitle: "幾個順手的功能",
      tipLive: "影片完全沒有字幕？<a href=\"https://huanshuowang.com/happysubs/#live\" target=\"_blank\" rel=\"noopener\">即時聽譯</a>可以邊播邊寫出來。",
      tipShortcut: "{key} 隨時開關第二語言，不用開啟彈出視窗。",
      tipOnly: "在彈出視窗裡開啟<strong>「僅顯示翻譯字幕」</strong>，不開 CC 也能只看譯文。",
      tipDrag: "滑鼠碰到字幕會浮出把手，<strong>按住就能上下拖</strong>，全螢幕也行。",
      tipSrt: "正在看的字幕可以匯出成 <strong>.srt</strong>，雙語、僅原文、僅譯文都行。",
      footerNote: "免費、開源，不收集任何使用資料。",
      linkSite: "官網",
      linkPrivacy: "隱私政策"
    },
    ja: {
      pageTitle: "HappySubs へようこそ",
      eyebrow: "インストール完了",
      headline: "準備完了。<br>YouTubeでは<em>CCをオン</em>に。",
      lede: "HappySubs は動画にもともとある字幕を翻訳します。Vimeo と Bilibili では何もオンにする必要はありません。",
      demoAlt: "デモ：ツールバーの HappySubs アイコン、続いてプレーヤーの CC ボタンをクリックすると、字幕が2言語で表示されます。",
      demoBadge: "デモ",
      step1Title: "ツールバーに固定",
      step1Body: "アドレスバー右のパズルのアイコンをクリックし、HappySubs の横のピンを押します。",
      step2Title: "動画を開いて CC をクリック",
      step2Body: "プレーヤーの右下にあります。<strong>インストール前から開いていた動画ページは再読み込みしてください。</strong>",
      step3Title: "2言語が表示されます",
      step3Body: "原文と訳文が1つの字幕になり、一文ずつ切り替わります。言語はツールバーのアイコンからいつでも変えられます。",
      pickLabel: "字幕の翻訳先",
      pickSaved: "✓ 保存しました",
      tryIt: "動画で試してみる",
      tryNote: "人が作った字幕付きの TED トーク",
      tipsTitle: "知っておくと便利",
      tipLive: "字幕がまったくない動画は？ <a href=\"https://huanshuowang.com/happysubs/#live\" target=\"_blank\" rel=\"noopener\">リアルタイム文字起こし</a>で、再生しながら字幕を作れます。",
      tipShortcut: "{key} で、ポップアップを開かずに第2言語をオン/オフ。",
      tipOnly: "ポップアップで<strong>訳文のみ表示</strong>をオンにすると、CC をオフにしたまま訳文だけを読めます。",
      tipDrag: "字幕にマウスを乗せるとハンドルが出ます。<strong>ドラッグ</strong>して上下に動かせます（全画面でも）。",
      tipSrt: "見ている字幕を <strong>.srt</strong> でダウンロード。2言語でも、どちらか一方でも。",
      footerNote: "無料・オープンソース・利用データの収集なし。",
      linkSite: "ウェブサイト",
      linkPrivacy: "プライバシー"
    },
    vi: {
      pageTitle: "Chào mừng đến với HappySubs",
      eyebrow: "Đã cài đặt",
      headline: "Xong rồi.<br>Hãy <em>bật CC</em> trên YouTube.",
      lede: "HappySubs dịch phụ đề có sẵn của video. Trên Vimeo và Bilibili thì không cần bật gì cả.",
      demoAlt: "Minh họa: biểu tượng HappySubs trên thanh công cụ, sau đó bấm nút CC của trình phát, phụ đề hiện ra bằng hai ngôn ngữ.",
      demoBadge: "MINH HỌA",
      step1Title: "Ghim lên thanh công cụ",
      step1Body: "Bấm biểu tượng mảnh ghép cạnh thanh địa chỉ, rồi bấm ghim bên cạnh HappySubs.",
      step2Title: "Mở video, bấm CC",
      step2Body: "Ở góc dưới bên phải trình phát. <strong>Hãy tải lại các trang video đã mở từ trước khi cài.</strong>",
      step3Title: "Hiện cả hai ngôn ngữ",
      step3Body: "Bản gốc và bản dịch hiện cùng nhau, đổi theo từng câu. Có thể đổi ngôn ngữ bất cứ lúc nào từ biểu tượng trên thanh công cụ.",
      pickLabel: "Dịch phụ đề sang",
      pickSaved: "✓ Đã lưu",
      tryIt: "Thử trên một video",
      tryNote: "Một bài nói TED có phụ đề do người làm",
      tipsTitle: "Mẹo hữu ích",
      tipLive: "Video không có phụ đề nào? <a href=\"https://huanshuowang.com/happysubs/#live\" target=\"_blank\" rel=\"noopener\">Phụ đề trực tiếp</a> sẽ viết ra trong lúc phát.",
      tipShortcut: "{key} để bật/tắt ngôn ngữ thứ hai mà không cần mở cửa sổ tiện ích.",
      tipOnly: "Bật <strong>Chỉ hiện bản dịch</strong> trong cửa sổ tiện ích để chỉ đọc bản dịch khi đang tắt CC.",
      tipDrag: "Di chuột lên phụ đề sẽ hiện tay cầm — <strong>kéo</strong> lên hoặc xuống, kể cả khi toàn màn hình.",
      tipSrt: "Tải phụ đề đang xem dưới dạng <strong>.srt</strong>, song ngữ hoặc một ngôn ngữ.",
      footerNote: "Miễn phí, mã nguồn mở, không thu thập dữ liệu sử dụng.",
      linkSite: "Trang web",
      linkPrivacy: "Quyền riêng tư"
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
    document.documentElement.lang = { zh: "zh-CN", "zh-Hant": "zh-Hant", ja: "ja", vi: "vi" }[uiLang] || "en";
    document.title = t.pageTitle;
    for (const el of document.querySelectorAll("[data-t]")) el.textContent = t[el.dataset.t];
    // Only this file's own constants ever go through innerHTML.
    for (const el of document.querySelectorAll("[data-html]")) el.innerHTML = t[el.dataset.html];
    for (const el of document.querySelectorAll("[data-aria]")) el.setAttribute("aria-label", t[el.dataset.aria]);

    const key = isMac() ? "<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>S</kbd>" : "<kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>S</kbd>";
    document.getElementById("tipShortcut").innerHTML = t.tipShortcut.replace("{key}", key);

    showDemo(secondLang);
    buildPicker(document.getElementById("secondLang"), secondLang);

    document.getElementById("pageLang").value = uiLang;
  }

  function showDemo(secondLang) {
    const [src, tr] = demoLines(secondLang);
    document.getElementById("demoSrc").textContent = src;
    document.getElementById("demoTr").textContent = tr;
  }

  // The same two lists the popup offers (languages.js): the common languages,
  // then all of them. Option names are each language's own, so only the group
  // headings follow the page's language.
  function buildPicker(select, value) {
    const T = typeof ydsT === "function" ? ydsT : (k) => k;
    select.replaceChildren();
    const seen = new Set();
    const group = (label, list) => {
      const g = document.createElement("optgroup");
      g.label = label;
      for (const [code, name] of list) {
        if (seen.has(code)) continue;
        seen.add(code);
        const o = document.createElement("option");
        o.value = code;
        o.textContent = `${name} (${code})`;
        g.appendChild(o);
      }
      select.appendChild(g);
    };
    group(T("groupCommon"), globalThis.YDS_COMMON_LANGS || []);
    group(T("groupAll"), globalThis.YDS_ALL_LANGS || []);
    // A language set elsewhere that neither list has (a regional variant
    // picked from a video's own tracks, say) is still shown as chosen.
    if (value && !seen.has(value)) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = value;
      select.prepend(o);
    }
    select.value = value;
  }

  // Settings written here are the extension's own, merged into what is
  // stored, so the popup and every open video see them at once.
  function saveSetting(change) {
    try {
      chrome.storage.sync.get(["ydsSettings"], (r) => {
        const cur = (r && r.ydsSettings) || {};
        chrome.storage.sync.set({ ydsSettings: { ...cur, ...change } });
      });
    } catch {}
  }

  storedSettings().then((s) => {
    const uiLang = typeof ydsSetUiLang === "function" ? ydsSetUiLang(s.uiLang) : "en";
    let secondLang = s.secondLang || (typeof ydsDefaultSecondLang === "function" ? ydsDefaultSecondLang() : "zh-Hans");
    let current = STRINGS[uiLang] ? uiLang : "en";
    fill(STRINGS[current], current, secondLang);

    // The switch here is the panel's own language setting, not just this
    // page's: someone who flips it on their first screen wants the popup in
    // that language too, and would otherwise have to find the setting again.
    document.getElementById("pageLang").addEventListener("change", (e) => {
      current = STRINGS[e.target.value] ? e.target.value : "en";
      if (typeof ydsSetUiLang === "function") ydsSetUiLang(current);
      fill(STRINGS[current], current, secondLang);
      saveSetting({ uiLang: current });
    });

    // Saved the moment it is picked: there is no "done" to press, and the
    // demo beside it switches to the chosen language as proof.
    let savedTimer = null;
    document.getElementById("secondLang").addEventListener("change", (e) => {
      secondLang = e.target.value;
      saveSetting({ secondLang });
      showDemo(secondLang);
      const saved = document.getElementById("pickSaved");
      saved.classList.add("on");
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => saved.classList.remove("on"), 1800);
    });
  });
})();
