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
      moreTitle: "Turn on auto",
      moreNote: "Turn on auto for these sites and subtitles appear as soon as they open.\nOr click the HappySubs icon whenever you need them.",
      moreZoomTitle: "Zoom recordings",
      moreZoomBody: "",
      moreEmbedTitle: "YouTube's privacy-enhanced player on other sites",
      moreEmbedBody: "",
      moreEnable: "Turn on auto",
      moreEnabled: "✓ Auto on",
      moreTurnOff: "Click to turn off",
      newEyebrow: "Updated to 2.2.0",
      langCardTitle: "Interface language",
      langCardBody: "繁體中文, 日本語 and Tiếng Việt added",
      newHeadline: "New: <em>Zoom recordings</em>,<br>and more YouTube on other sites.",
      newLede: "Turn on auto and subtitles appear as soon as the site opens.\nOr click the HappySubs icon whenever you need them.",
      logTitle: "What changed in 2.2.0",
      log1: "<strong>Zoom recordings</strong>: bilingual subtitles, a translated transcript panel, and a bilingual transcript export.",
      log2: "<strong>YouTube embedded in other sites</strong> now gets bilingual subtitles.",
      log3: "<strong>More sites</strong> such as Coursera.",
      log4: "<strong>Live transcription</strong>: more accurate, with punctuation; understands Japanese, Korean and Cantonese too; works on local video files. The translation appears a whole sentence at a time and stays put, and can use your own AI translator and key. Already installed the recogniser? Run the install command once more.",
      log5: "<strong>Interface languages</strong>: Traditional Chinese, Japanese and Vietnamese added.",
      log6: "When YouTube auto-translates captions, HappySubs switches back to the original.",
      headline: "You're set.<br>On YouTube, <em>turn on CC</em> first.",
      lede: "HappySubs translates the captions a video already has. On Vimeo, Bilibili and Zoom recordings there's nothing to switch on.",
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
      moreTitle: "开启自动启用",
      moreNote: "为以下网站打开自动启用，打开网站即出字幕。\n也可在需要时点击 HappySubs 图标，打开字幕。",
      moreZoomTitle: "Zoom 录像",
      moreZoomBody: "",
      moreEmbedTitle: "其他网站里的「隐私增强」YouTube 播放器",
      moreEmbedBody: "",
      moreEnable: "自动启用",
      moreEnabled: "✓ 已自动启用",
      moreTurnOff: "点击关闭",
      newEyebrow: "已更新到 2.2.0",
      langCardTitle: "界面语言",
      langCardBody: "新增繁體中文、日本語、Tiếng Việt",
      newHeadline: "新增：<em>Zoom 录像</em>，<br>和更多其他网站里的 YouTube。",
      newLede: "开启自动启用，打开网站即出字幕。\n也可在需要时点击 HappySubs 图标，打开字幕。",
      logTitle: "2.2.0 更新了什么",
      log1: "<strong>Zoom 录像</strong>：双语字幕、转录稿栏译文、导出双语文稿。",
      log2: "<strong>嵌在其他网站里的 YouTube</strong> 也有双语字幕了。",
      log3: "<strong>更多网站</strong>：支持 Coursera 等。",
      log4: "<strong>实时听译</strong>：识别更准、带标点；新增日语、韩语、粤语；本地视频也能用。译文整句出现、不再跳动，还可以单独选用 AI 翻译和 API Key。已经装过识别服务的，重新运行一次安装命令即可。",
      log5: "<strong>界面语言</strong>：新增繁体中文、日文、越南文。",
      log6: "YouTube 自动翻译字幕时，HappySubs 会换回原文。",
      headline: "装好了。<br>在 YouTube 上，先<em>打开 CC</em>。",
      lede: "HappySubs 翻译的是视频自带的字幕。Vimeo、B\u2060站 和 Zoom 录像上什么都不用开。",
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
      moreTitle: "開啟自動啟用",
      moreNote: "為以下網站打開自動啟用，打開網站即出字幕。\n也可在需要時點擊 HappySubs 圖示，打開字幕。",
      moreZoomTitle: "Zoom 錄影",
      moreZoomBody: "",
      moreEmbedTitle: "其他網站裡的「隱私強化」YouTube 播放器",
      moreEmbedBody: "",
      moreEnable: "自動啟用",
      moreEnabled: "✓ 已自動啟用",
      moreTurnOff: "點擊關閉",
      newEyebrow: "已更新到 2.2.0",
      langCardTitle: "介面語言",
      langCardBody: "新增繁體中文、日本語、Tiếng Việt",
      newHeadline: "新增：<em>Zoom 錄影</em>，<br>和更多其他網站裡的 YouTube。",
      newLede: "開啟自動啟用，打開網站即出字幕。\n也可在需要時點擊 HappySubs 圖示，打開字幕。",
      logTitle: "2.2.0 更新了什麼",
      log1: "<strong>Zoom 錄影</strong>：雙語字幕、逐字稿欄譯文、匯出雙語文稿。",
      log2: "<strong>嵌在其他網站裡的 YouTube</strong> 也有雙語字幕了。",
      log3: "<strong>更多網站</strong>：支援 Coursera 等。",
      log4: "<strong>即時聽譯</strong>：辨識更準、附標點；新增日語、韓語、粵語；本機影片也能用。譯文整句出現、不再跳動，還可以單獨選用 AI 翻譯和 API Key。已經裝過辨識服務的，重新執行一次安裝指令即可。",
      log5: "<strong>介面語言</strong>：新增繁體中文、日文、越南文。",
      log6: "YouTube 自動翻譯字幕時，HappySubs 會換回原文。",
      headline: "裝好了。<br>在 YouTube 上，先<em>開啟 CC</em>。",
      lede: "HappySubs 翻譯的是影片內建的字幕。Vimeo、B⁠站 和 Zoom 錄影上什麼都不用開。",
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
      moreTitle: "自動で有効にする",
      moreNote: "以下のサイトで自動を有効にすると、開くだけで字幕が出ます。\n必要なときに HappySubs のアイコンを押して表示することもできます。",
      moreZoomTitle: "Zoom の録画",
      moreZoomBody: "",
      moreEmbedTitle: "他サイトの「プライバシー強化」YouTube プレーヤー",
      moreEmbedBody: "",
      moreEnable: "自動で有効",
      moreEnabled: "✓ 自動で有効",
      moreTurnOff: "クリックでオフ",
      newEyebrow: "2.2.0 に更新",
      langCardTitle: "表示言語",
      langCardBody: "繁體中文・日本語・Tiếng Việt を追加",
      newHeadline: "新機能：<em>Zoom の録画</em>、<br>他サイト内の YouTube にも対応拡大。",
      newLede: "自動で有効にすると、サイトを開くだけで字幕が出ます。\n必要なときに HappySubs のアイコンを押して表示することもできます。",
      logTitle: "2.2.0 の変更点",
      log1: "<strong>Zoom の録画</strong>：二言語字幕、文字起こしパネルの翻訳、二言語文字起こしの書き出し。",
      log2: "<strong>他サイトに埋め込まれた YouTube</strong> でも二言語字幕が使えます。",
      log3: "<strong>対応サイトの追加</strong>：Coursera など。",
      log4: "<strong>リアルタイム文字起こし</strong>：認識の精度が上がり、句読点付きに。日本語・韓国語・広東語に対応し、ローカルの動画でも使えます。翻訳は1文ずつ表示されて途中で変わらず、AI 翻訳と API キーを個別に設定できます。認識プログラムを入れ済みの方は、インストールコマンドをもう一度実行してください。",
      log5: "<strong>表示言語</strong>：繁体字中国語、日本語、ベトナム語を追加。",
      log6: "YouTube が字幕を自動翻訳している場合は原文に戻します。",
      headline: "準備完了。<br>YouTubeでは<em>CCをオン</em>に。",
      lede: "HappySubs は動画にもともとある字幕を翻訳します。Vimeo、Bilibili、Zoom の録画では何もオンにする必要はありません。",
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
      moreTitle: "Bật tự động",
      moreNote: "Bật tự động cho các trang dưới đây để phụ đề hiện ngay khi mở.\nHoặc bấm biểu tượng HappySubs khi cần.",
      moreZoomTitle: "Bản ghi Zoom",
      moreZoomBody: "",
      moreEmbedTitle: "Trình phát YouTube bảo mật nâng cao trên trang khác",
      moreEmbedBody: "",
      moreEnable: "Tự động bật",
      moreEnabled: "✓ Đang tự bật",
      moreTurnOff: "Bấm để tắt",
      newEyebrow: "Đã cập nhật 2.2.0",
      langCardTitle: "Ngôn ngữ giao diện",
      langCardBody: "Thêm 繁體中文, 日本語 và Tiếng Việt",
      newHeadline: "Mới: <em>bản ghi Zoom</em>,<br>và thêm YouTube trên trang khác.",
      newLede: "Bật tự động để phụ đề hiện ngay khi mở trang.\nHoặc bấm biểu tượng HappySubs khi cần.",
      logTitle: "Có gì mới trong 2.2.0",
      log1: "<strong>Bản ghi Zoom</strong>: phụ đề song ngữ, bản dịch trong bảng chép lời, xuất bản chép lời song ngữ.",
      log2: "<strong>YouTube nhúng trên trang khác</strong> giờ có phụ đề song ngữ.",
      log3: "<strong>Thêm trang</strong> như Coursera.",
      log4: "<strong>Phụ đề trực tiếp</strong>: chính xác hơn, có dấu câu; nhận dạng thêm tiếng Nhật, tiếng Hàn, tiếng Quảng Đông; dùng được với tệp video trên máy. Bản dịch hiện cả câu và không đổi nữa, có thể chọn dịch bằng AI và API key riêng. Đã cài chương trình nhận dạng thì chạy lại lệnh cài đặt một lần.",
      log5: "<strong>Ngôn ngữ giao diện</strong>: thêm tiếng Trung phồn thể, tiếng Nhật và tiếng Việt.",
      log6: "Khi YouTube tự dịch phụ đề, HappySubs chuyển về bản gốc.",
      headline: "Xong rồi.<br>Hãy <em>bật CC</em> trên YouTube.",
      lede: "HappySubs dịch phụ đề có sẵn của video. Trên Vimeo, Bilibili và bản ghi Zoom thì không cần bật gì cả.",
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

    // Opened by an update, not an install: lead with what is new.
    if (WHATS_NEW) {
      document.querySelector("[data-t='eyebrow']").textContent = t.newEyebrow;
      document.querySelector("[data-html='headline']").innerHTML = t.newHeadline;
      document.querySelector("[data-t='lede']").textContent = t.newLede;
    }
    paintSiteButtons(t);

    const key = isMac() ? "<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>S</kbd>" : "<kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>S</kbd>";
    document.getElementById("tipShortcut").innerHTML = t.tipShortcut.replace("{key}", key);

    showDemo(secondLang);
    buildPicker(document.getElementById("secondLang"), secondLang);

    document.getElementById("pageLang").value = uiLang;
    document.getElementById("pageLang2").value = uiLang;
  }

  // Opened by an update rather than an install (background.js adds ?new=).
  const WHATS_NEW = new URLSearchParams(location.search).has("new");
  if (WHATS_NEW) document.body.classList.add("whatsnew");
  // The switches for the optional sites go in the headline column on both
  // versions of the page: they are the one thing here that needs a click.
  {
    const more = document.getElementById("more");
    const head = document.querySelector(".first .head");
    if (more && head) head.appendChild(more);
    // The language switch follows on the update page, under the box.
    const langRow = document.getElementById("langRow");
    if (WHATS_NEW && langRow && head) head.appendChild(langRow);
  }

  // The two sites that are optional permissions. A button rather than a
  // prompt on arrival: the request has to come from a click, and until it is
  // granted the extension cannot even tell the viewer is on that site.
  const SITE_ORIGINS = {
    zoom: ["https://*.zoom.us/*"],
    embed: ["*://www.youtube-nocookie.com/*"]
  };
  let siteStrings = null;

  async function paintSiteButtons(t) {
    if (t) siteStrings = t;
    for (const btn of document.querySelectorAll(".more-btn")) {
      let on = false;
      try { on = await chrome.permissions.contains({ origins: SITE_ORIGINS[btn.dataset.site] }); } catch {}
      btn.classList.toggle("on", on);
      btn.textContent = on ? siteStrings.moreEnabled : siteStrings.moreEnable;
      btn.title = on ? siteStrings.moreTurnOff : "";
    }
    // Draw the eye here while something is still off; once both are on there
    // is nothing left to ask for.
    const more = document.getElementById("more");
    if (more) more.classList.toggle("ask", [...document.querySelectorAll(".more-btn")].some(b => !b.classList.contains("on")));
  }

  // A switch, not a one-way door: what was granted here can be taken back
  // here, without a trip to Chrome's extension settings.
  for (const btn of document.querySelectorAll(".more-btn")) {
    btn.addEventListener("click", async () => {
      const origins = SITE_ORIGINS[btn.dataset.site];
      try {
        if (btn.classList.contains("on")) await chrome.permissions.remove({ origins });
        else await chrome.permissions.request({ origins });
      } catch {}
      paintSiteButtons();
    });
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
    const pickUiLang = (e) => {
      current = STRINGS[e.target.value] ? e.target.value : "en";
      if (typeof ydsSetUiLang === "function") ydsSetUiLang(current);
      fill(STRINGS[current], current, secondLang);
      saveSetting({ uiLang: current });
    };
    document.getElementById("pageLang").addEventListener("change", pickUiLang);
    // The same switch again on the update page, next to the news that there
    // are more languages to switch to.
    document.getElementById("pageLang2").addEventListener("change", pickUiLang);

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
