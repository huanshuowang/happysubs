// Popup: reads current tab's caption info, lets the user pick a second
// language and adjust overlay styling. Persists to chrome.storage.sync.

const DEFAULTS = {
  enabled: true,
  secondLang: ydsDefaultSecondLang(),
  bottomOffset: 5,
  captionWidth: 80,
  fontSize: 20,
  color: "#f7c9c8",
  unifyStyles: false,
  sourceColor: "#ffffff",
  sourceFontSize: 18,
  // Set once by the page when it moves an old white setting to the new pink,
  // so that picking white afterwards is respected — see migrateTranslationColor.
  translationColorMoved: 0,
  background: "rgba(0,0,0,0.6)",
  translationProvider: "google",
  uiLang: "auto",
  subtitleMode: "inline",
  takeoverCaptions: true,
  translationOnly: false,
  paidApiMode: "ask",
  apiKeys: {}
};

// Where users go to grab a key for each provider.
const KEY_LINKS = {
  claude: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/app/apikey",
  deepseek: "https://platform.deepseek.com/api_keys"
};

const KEY_PLACEHOLDERS = {
  claude: "sk-ant-...",
  openai: "sk-...",
  gemini: "AIza...",
  deepseek: "sk-..."
};

// A shortlist of what each paid provider can be pointed at — not the whole
// catalogue. Providers ship new models faster than this popup does, so the
// picker's last entry opens a field for any other model name they accept. The
// first entry is the default, and it must match DEFAULT_MODELS in content.js —
// that is the fallback the page uses when this setting was never touched, or
// was cleared.
const PROVIDER_MODELS = {
  claude: [
    ["claude-haiku-4-5",  "Haiku 4.5"],
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-opus-5-5",   "Opus 5.5"]
  ],
  openai: [
    ["gpt-6-luna",  "GPT-6 Luna"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-astra", "GPT-6 Astra"]
  ],
  gemini: [
    ["gemini-3.5-flash-lite", "3.5 Flash-Lite"],
    ["gemini-3.8-flash",      "3.8 Flash"]
  ],
  deepseek: [
    ["deepseek-flash",  "Flash"],
    ["deepseek-v4-pro", "V4 Pro"]
  ]
};

const PROVIDER_NAMES = {
  google: "Google Translate",
  claude: "Claude",
  openai: "OpenAI",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  get native() { return ydsT("providerNative"); }
};

// Swap static popup text to the active UI language (see ydsSetUiLang).
function localizeStaticDom() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = ydsT(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    const t = ydsT(el.dataset.i18nTitle);
    el.title = t;
    el.setAttribute("aria-label", t);
  }
  document.title = ydsT("appTitle");
  $("apiKey").placeholder = ydsT("pasteHere");
  $("apiKeyState").title = ydsT("keyStateTitle");
  $("editApiKey").textContent = ydsT("edit");
}

let activeTabId = null;
let apiKeySaveTimer = null;
let statusPollTimer = null;
let apiKeyEditing = false;
// The last model picked from the list, so leaving the custom field comes back
// to it rather than to the provider's default.
let lastListModel = "";

const $ = (id) => document.getElementById(id);

// The overlay keeps its background as a colour string and only the opacity is
// editable, so the two are converted at the edge rather than stored twice.
// The slider is labelled "transparency", so that is what it shows: drag right
// and the plate gets lighter. What is stored is the opacity, because that is
// what rgba() wants — the two are opposites, and the slider used to show the
// opacity under the transparency label, so dragging towards "more transparent"
// made the subtitle darker.
function bgToTransparency(bg) {
  const m = /rgba?\([^)]*,\s*([0-9.]+)\s*\)/.exec(bg || "");
  const opacity = m ? parseFloat(m[1]) : 0.6;
  return Math.round((1 - opacity) * 100);
}
function transparencyToBg(t) {
  const opacity = 1 - Math.max(0, Math.min(100, t)) / 100;
  return `rgba(0,0,0,${opacity.toFixed(2)})`;
}

const SUPPORTED_URL = /^https?:\/\/(www\.youtube\.com|(player\.)?vimeo\.com|www\.bilibili\.com)\//;

// Info from the last probe in getActiveSupportedTab, so we don't message the
// page twice on open.
let probedInfo = null;

async function getActiveSupportedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  activeTabUrl = tab.url || "";
  if (tab.url && SUPPORTED_URL.test(tab.url)) return tab;
  // A YouTube/Vimeo player embedded in someone else's page — a course site, a
  // blog. The tab's own URL is not ours, but the content script is alive in the
  // player's frame and answers, so ask before giving up.
  probedInfo = await askContent(tab.id);
  return probedInfo && probedInfo.videoId ? tab : null;
}

// The content script reports which adapter booted; fall back to YouTube so a
// page we can't reach still reads sensibly.
const PLATFORM_NAMES = { youtube: "YouTube", vimeo: "Vimeo", bilibili: "Bilibili" };

// The tab we last found, so a name is still available when the page never
// answered — which is exactly when we most need to name it, since "refresh the
// YouTube page" on a Bilibili tab is worse than saying nothing.
let activeTabUrl = "";

function platformFromUrl(url) {
  if (/^https?:\/\/(www\.)?bilibili\.com\//.test(url || "")) return "bilibili";
  if (/^https?:\/\/(player\.)?vimeo\.com\//.test(url || "")) return "vimeo";
  if (/^https?:\/\/(www\.)?youtube\.com\//.test(url || "")) return "youtube";
  return "";
}

function platformName(info) {
  const id = (info && info.platform) || platformFromUrl(activeTabUrl);
  return PLATFORM_NAMES[id] || "YouTube";
}

async function askContent(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "YDS_GET_INFO" }, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else { noteVideoInfo(resp); resolve(resp || null); }
      });
    } catch { resolve(null); }
  });
}

// Every answer from the page passes through here, so the appearance sliders
// follow the video the popup is actually open over rather than the last one.
function noteVideoInfo(info) {
  if (!info) return;
  let changed = false;
  if (typeof info.sourceIsAsr === "boolean" && currentIsAsr !== info.sourceIsAsr) {
    currentIsAsr = info.sourceIsAsr;
    changed = true;
  }
  if (typeof info.drawnInOwnBox === "boolean" && currentOwnBox !== info.drawnInOwnBox) {
    currentOwnBox = info.drawnInOwnBox;
    changed = true;
  }
  if (typeof info.drawsSourceLine === "boolean" && currentDrawsSource !== info.drawsSourceLine) {
    currentDrawsSource = info.drawsSourceLine;
    changed = true;
  }
  if (!changed) return;
  try { applyAppearanceUI(); } catch { /* before the DOM is wired */ }
}

async function sendContent(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp || null);
      });
    } catch { resolve(null); }
  });
}

function populateLanguages(info) {
  const sel = $("lang");
  sel.innerHTML = "";

  const seen = new Set();
  const add = (code, label) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = label;
    sel.appendChild(opt);
  };

  add("", ydsT("offSecondSub"));

  // Native tracks on this video first.
  if (info?.tracks?.length) {
    const group = document.createElement("optgroup");
    group.label = ydsT("groupNative");
    sel.appendChild(group);
    for (const t of info.tracks) {
      const opt = document.createElement("option");
      opt.value = t.languageCode;
      opt.textContent = `${t.name} (${t.languageCode})${t.kind === "asr" ? ydsT("asrSuffix") : ""}`;
      group.appendChild(opt);
      seen.add(t.languageCode);
    }
  }

  // Auto-translation targets.
  if (info?.translations?.length) {
    const group = document.createElement("optgroup");
    group.label = ydsT("groupAutoTranslate");
    sel.appendChild(group);
    for (const t of info.translations) {
      if (seen.has(t.languageCode)) continue;
      const opt = document.createElement("option");
      opt.value = t.languageCode;
      opt.textContent = `${t.languageName} (${t.languageCode})`;
      group.appendChild(opt);
      seen.add(t.languageCode);
    }
  }

  // Common fallbacks so the picker isn't empty on non-video pages.
  const commons = [
    ["zh-Hans", "中文（简体）"],
    ["zh-Hant", "中文（繁體）"],
    ["en", "English"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["es", "Español"],
    ["fr", "Français"],
    ["de", "Deutsch"]
  ];
  const commonGroup = document.createElement("optgroup");
  commonGroup.label = ydsT("groupCommon");
  sel.appendChild(commonGroup);
  for (const [c, n] of commons) {
    if (seen.has(c)) continue;
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = `${n} (${c})`;
    commonGroup.appendChild(opt);
    seen.add(c);
  }

  // Full Google Translate language list.
  const allGroup = document.createElement("optgroup");
  allGroup.label = ydsT("groupAll");
  sel.appendChild(allGroup);
  for (const [c, n] of ALL_LANGS) {
    if (seen.has(c)) continue;
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = `${n} (${c})`;
    allGroup.appendChild(opt);
    seen.add(c);
  }
}

// Google Translate supported languages. Local name + English name for
// recognition. Codes are the ones Google Translate accepts (a few — zh-Hans,
// zh-Hant, iw, jw — are remapped in content.js's toGoogleLang).
const ALL_LANGS = [
  ["af", "Afrikaans"],
  ["sq", "Shqip · Albanian"],
  ["am", "አማርኛ · Amharic"],
  ["ar", "العربية · Arabic"],
  ["hy", "Հայերեն · Armenian"],
  ["as", "অসমীয়া · Assamese"],
  ["ay", "Aymar · Aymara"],
  ["az", "Azərbaycan · Azerbaijani"],
  ["bm", "Bamanankan · Bambara"],
  ["eu", "Euskara · Basque"],
  ["be", "Беларуская · Belarusian"],
  ["bn", "বাংলা · Bengali"],
  ["bho", "भोजपुरी · Bhojpuri"],
  ["bs", "Bosanski · Bosnian"],
  ["bg", "Български · Bulgarian"],
  ["ca", "Català · Catalan"],
  ["ceb", "Cebuano"],
  ["ny", "Chichewa"],
  ["co", "Corsu · Corsican"],
  ["hr", "Hrvatski · Croatian"],
  ["cs", "Čeština · Czech"],
  ["da", "Dansk · Danish"],
  ["dv", "ދިވެހި · Dhivehi"],
  ["doi", "डोगरी · Dogri"],
  ["nl", "Nederlands · Dutch"],
  ["eo", "Esperanto"],
  ["et", "Eesti · Estonian"],
  ["ee", "Eʋegbe · Ewe"],
  ["fil", "Filipino / Tagalog"],
  ["fi", "Suomi · Finnish"],
  ["fy", "Frysk · Frisian"],
  ["gl", "Galego · Galician"],
  ["ka", "ქართული · Georgian"],
  ["el", "Ελληνικά · Greek"],
  ["gn", "Avañe'ẽ · Guarani"],
  ["gu", "ગુજરાતી · Gujarati"],
  ["ht", "Kreyòl · Haitian Creole"],
  ["ha", "Hausa"],
  ["haw", "ʻŌlelo Hawaiʻi · Hawaiian"],
  ["he", "עברית · Hebrew"],
  ["hi", "हिन्दी · Hindi"],
  ["hmn", "Hmoob · Hmong"],
  ["hu", "Magyar · Hungarian"],
  ["is", "Íslenska · Icelandic"],
  ["ig", "Igbo"],
  ["ilo", "Ilokano · Ilocano"],
  ["id", "Bahasa Indonesia · Indonesian"],
  ["ga", "Gaeilge · Irish"],
  ["it", "Italiano · Italian"],
  ["jv", "Basa Jawa · Javanese"],
  ["kn", "ಕನ್ನಡ · Kannada"],
  ["kk", "Қазақша · Kazakh"],
  ["km", "ខ្មែរ · Khmer"],
  ["rw", "Kinyarwanda"],
  ["gom", "कोंकणी · Konkani"],
  ["kri", "Krio"],
  ["ku", "Kurdî · Kurdish (Kurmanji)"],
  ["ckb", "کوردی · Kurdish (Sorani)"],
  ["ky", "Кыргызча · Kyrgyz"],
  ["lo", "ລາວ · Lao"],
  ["la", "Latina · Latin"],
  ["lv", "Latviešu · Latvian"],
  ["ln", "Lingála · Lingala"],
  ["lt", "Lietuvių · Lithuanian"],
  ["lg", "Luganda"],
  ["lb", "Lëtzebuergesch · Luxembourgish"],
  ["mk", "Македонски · Macedonian"],
  ["mai", "मैथिली · Maithili"],
  ["mg", "Malagasy"],
  ["ms", "Bahasa Melayu · Malay"],
  ["ml", "മലയാളം · Malayalam"],
  ["mt", "Malti · Maltese"],
  ["mi", "Māori"],
  ["mr", "मराठी · Marathi"],
  ["mni-Mtei", "ꯃꯤꯇꯩ ꯂꯣꯟ · Meiteilon"],
  ["lus", "Mizo"],
  ["mn", "Монгол · Mongolian"],
  ["my", "မြန်မာ · Myanmar (Burmese)"],
  ["ne", "नेपाली · Nepali"],
  ["no", "Norsk · Norwegian"],
  ["or", "ଓଡ଼ିଆ · Odia (Oriya)"],
  ["om", "Afaan Oromoo · Oromo"],
  ["ps", "پښتو · Pashto"],
  ["fa", "فارسی · Persian"],
  ["pl", "Polski · Polish"],
  ["pt", "Português · Portuguese"],
  ["pa", "ਪੰਜਾਬੀ · Punjabi"],
  ["qu", "Runa Simi · Quechua"],
  ["ro", "Română · Romanian"],
  ["ru", "Русский · Russian"],
  ["sm", "Gagana Samoa · Samoan"],
  ["sa", "संस्कृतम् · Sanskrit"],
  ["gd", "Gàidhlig · Scots Gaelic"],
  ["nso", "Sepedi"],
  ["sr", "Српски · Serbian"],
  ["st", "Sesotho"],
  ["sn", "Shona"],
  ["sd", "سنڌي · Sindhi"],
  ["si", "සිංහල · Sinhala"],
  ["sk", "Slovenčina · Slovak"],
  ["sl", "Slovenščina · Slovenian"],
  ["so", "Soomaali · Somali"],
  ["su", "Basa Sunda · Sundanese"],
  ["sw", "Kiswahili · Swahili"],
  ["sv", "Svenska · Swedish"],
  ["tg", "Тоҷикӣ · Tajik"],
  ["ta", "தமிழ் · Tamil"],
  ["tt", "Татарча · Tatar"],
  ["te", "తెలుగు · Telugu"],
  ["th", "ไทย · Thai"],
  ["ti", "ትግርኛ · Tigrinya"],
  ["ts", "Xitsonga · Tsonga"],
  ["tr", "Türkçe · Turkish"],
  ["tk", "Türkmen · Turkmen"],
  ["ak", "Twi (Akan)"],
  ["uk", "Українська · Ukrainian"],
  ["ur", "اردو · Urdu"],
  ["ug", "ئۇيغۇرچە · Uyghur"],
  ["uz", "Oʻzbek · Uzbek"],
  ["vi", "Tiếng Việt · Vietnamese"],
  ["cy", "Cymraeg · Welsh"],
  ["xh", "isiXhosa · Xhosa"],
  ["yi", "ייִדיש · Yiddish"],
  ["yo", "Yorùbá · Yoruba"],
  ["zu", "isiZulu · Zulu"]
];

async function save(partial) {
  const cur = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
  const merged = { ...DEFAULTS, ...cur, ...partial };
  await chrome.storage.sync.set({ ydsSettings: merged });
}

// Update just the API key for the currently selected provider.
async function saveApiKey(provider, value) {
  const cur = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
  const apiKeys = { ...(cur.apiKeys || {}) };
  if (value) apiKeys[provider] = value;
  else delete apiKeys[provider];
  await chrome.storage.sync.set({ ydsSettings: { ...DEFAULTS, ...cur, apiKeys } });
}

function applyProviderUI(settings) {
  const p = $("provider").value;
  const needsKey = p !== "google";
  fillModelOptions(p, settings);
  $("modelRow").style.display = needsKey ? "" : "none";
  $("modelHelp").style.display = needsKey ? "" : "none";
  $("apiKeyRow").style.display = needsKey ? "" : "none";
  $("apiKeyHelp").style.display = needsKey ? "" : "none";
  $("paidControls").style.display = needsKey ? "block" : "none";
  $("askPaidRow").style.display = needsKey ? "flex" : "none";
  $("paidApiMode").value = settings.paidApiMode || "ask";
  $("translationOnly").checked = !!settings.translationOnly;
  if (needsKey) {
    const keys = settings.apiKeys || {};
    const key = keys[p] || "";
    $("apiKey").value = key;
    $("apiKey").placeholder = KEY_PLACEHOLDERS[p] || ydsT("pasteHere");
    $("apiKeyLink").href = KEY_LINKS[p] || "#";
    $("apiKeyLink").textContent = ydsT("getKeyLink", { name: PROVIDER_NAMES[p] || p });
    $("usePaidApi").textContent = ydsT("usePaidApiBtn", { name: providerName(p) });
    setApiKeyEditing(!key);
    updateApiKeyState(!!key);
  }
}

function setApiKeyEditing(editing) {
  apiKeyEditing = editing;
  const input = $("apiKey");
  input.disabled = !editing && !!input.value;
  $("editApiKey").textContent = editing ? ydsT("done") : ydsT("edit");
  if (editing) setTimeout(() => input.focus(), 0);
}

function updateApiKeyState(hasKey) {
  const el = $("apiKeyState");
  el.textContent = hasKey ? "✓" : "!";
  el.className = `keyState ${hasKey ? "ok" : "missing"}`;
  el.title = hasKey ? ydsT("keySavedTitle") : ydsT("keyMissingTitle");
}

function providerName(provider) {
  return PROVIDER_NAMES[provider] || provider || ydsT("providerUnknown");
}

// The list changes with the provider, so it is rebuilt rather than filtered.
// A model this shortlist has never heard of — one the viewer typed in — comes
// back as the custom field holding it, not as a silent snap to the default.
function fillModelOptions(provider, settings) {
  const list = PROVIDER_MODELS[provider];
  const sel = $("model");
  sel.innerHTML = "";
  if (!list) { showModelCustom(false); return; }
  for (const [id, label] of list) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = label;
    sel.appendChild(o);
  }
  const custom = document.createElement("option");
  custom.value = CUSTOM_MODEL;
  custom.textContent = ydsT("modelCustomOption");
  sel.appendChild(custom);

  const chosen = ((settings && settings.models) || {})[provider] || list[0][0];
  const known = list.some(([id]) => id === chosen);
  lastListModel = known ? chosen : list[0][0];
  sel.value = known ? chosen : CUSTOM_MODEL;
  $("modelCustom").value = known ? "" : chosen;
  $("modelCustom").placeholder = list[0][0];
  showModelCustom(!known);
}

// The sentinel the picker's last entry carries. It is never stored.
const CUSTOM_MODEL = "__custom__";

function showModelCustom(on) {
  $("model").hidden = on;
  $("modelCustomWrap").hidden = !on;
}

// The default for a provider, used when the custom field is left empty.
function defaultModelFor(provider) {
  const list = PROVIDER_MODELS[provider];
  return list ? list[0][0] : "";
}

async function saveModel(provider, model) {
  const cur = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
  await save({ models: { ...(cur.models || {}), [provider]: model } });
  $("status").textContent = ydsT("statusProviderSwitched", { name: providerName(provider) });
  refreshStatusSeries();
}

// Leaving the custom field empty is how you get back to the list, rather than
// a way to send the provider an empty model name.
function backToModelList(provider) {
  const back = lastListModel || defaultModelFor(provider);
  $("model").value = back;
  $("modelCustom").value = "";
  showModelCustom(false);
  return saveModel(provider, back);
}

function statusTextFor(info, tab) {
  if (!tab) return ydsT("statusNoTab");
  if (!info || !info.videoId) return ydsT("statusNoComm", { platform: platformName(info) });

  // Live transcription owns the overlay while it runs, so every message below
  // would be describing a subtitle track the viewer isn't looking at — saying
  // "no subtitles picked up yet" while captions are visibly on screen.
  if (info.live && info.live.active) {
    if (info.live.status === "connecting") return ydsT("liveConnecting");
    if (info.live.status === "listening") return ydsT("statusLiveRunning");
    return ydsT("liveUnavailable");
  }

  const st = info.translationStatus || {};
  if (st.mode === "native" || info.usingNativeTrack) {
    return ydsT("statusNative", { lang: $("lang").value || ydsT("statusNativeFallbackLang") });
  }
  if (st.mode === "translated") {
    return ydsT("statusDone", { name: providerName(st.provider), count: st.cueCount || 0 });
  }
  if (st.mode === "translating") {
    const done = st.translatedCount || 0;
    const total = st.totalCount || st.cueCount || 0;
    const progress = total ? ydsT("progressFmt", { done, total }) : "";
    return ydsT("statusTranslating", { name: providerName(st.provider), progress });
  }
  if (st.mode === "partial") {
    return ydsT("statusPartial", {
      name: providerName(st.provider),
      done: st.translatedCount || 0,
      missing: st.untranslatedCount || 0,
      error: st.error ? ydsT("errorPrefix") + st.error : ""
    });
  }
  if (st.mode === "fallback") {
    if (st.declined || (st.error || "").startsWith("用户取消")) {
      return ydsT("statusCancelledFallback", { name: providerName(st.requestedProvider) });
    }
    return ydsT("statusFallback", {
      name: providerName(st.requestedProvider),
      error: st.error ? ydsT("errorPrefix") + st.error : ""
    });
  }
  if (st.mode === "awaiting_paid_confirmation") {
    return ydsT("statusAwaiting", { name: providerName(st.requestedProvider) });
  }
  if (st.mode === "need_api_key") {
    return ydsT("statusNeedKey", { name: providerName(st.requestedProvider) });
  }
  if (st.mode === "error") {
    return ydsT("statusError", {
      name: providerName(st.requestedProvider || st.provider),
      error: st.error || ydsT("unknownError")
    });
  }
  if (info.nativeCaptionText) {
    return ydsT("statusDetected", { platform: platformName(info) });
  }
  // In translation-only mode the CC prompt would be wrong — that's the whole
  // point of the mode. But if we still have no subtitles, say so plainly and
  // give the one workaround that always works.
  if ($("translationOnly").checked) {
    return info.preCuesLoaded ? ydsT("statusTranslationOnly") : ydsT("statusTranslationOnlyNeedsCc");
  }
  // Vimeo and Bilibili hand us the track without the player's help, so their
  // caption switch is optional — but on Bilibili "no track" is common enough
  // to be worth naming, along with the sign-in caveat behind it.
  if (info.platform === "bilibili") {
    return (info.tracks && info.tracks.length)
      ? ydsT("statusBilibiliReading")
      : ydsT("statusBilibiliNoTrack");
  }
  if (info.platform === "vimeo") return ydsT("statusVimeoReading");
  return ydsT("statusTurnOnCC");
}

async function refreshStatusSoon(delay = 900) {
  if (!activeTabId) return;
  setTimeout(async () => {
    const info = await askContent(activeTabId);
    $("status").textContent = statusTextFor(info, { id: activeTabId });
  }, delay);
}

function refreshStatusSeries() {
  refreshStatusSoon(900);
  refreshStatusSoon(2500);
  refreshStatusSoon(6000);
}

function startStatusPolling() {
  if (!activeTabId || statusPollTimer) return;
  statusPollTimer = setInterval(async () => {
    const info = await askContent(activeTabId);
    $("status").textContent = statusTextFor(info, { id: activeTabId });
    const mode = info?.translationStatus?.mode;
    if (mode && mode !== "translating" && mode !== "awaiting_paid_confirmation") {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }, 1000);
}


// ---------- tabs + live transcription ----------

const SETUP_URL = "https://huanshuowang.com/happysubs/#live";

// The gear doubles as the way back: there is nowhere else to put a back
// button in a popup this narrow, and one control for one toggle is clearer
// than two that look alike.
// Whether live transcription is running right now. It decides, along with the
// subtitle style, whether the appearance sliders have anything to act on.
let liveRunning = false;
// Whether the video behind the popup is running on an auto-generated track.
// Null until the page has answered — treated as "not auto" so the sliders do
// not flash into view and back out again while the answer is on its way.
let currentIsAsr = false;
// What the PAGE says about this video: is our own subtitle box what is drawing,
// or is the translation going inside the player's caption? Null until it
// answers. Guessing this from the track kind was wrong often enough to matter —
// a video with only a target-language track has no source cues, so takeover
// cannot engage and the translation is injected whatever the switches say.
let currentOwnBox = null;
// …and whether the ORIGINAL is one of the lines it draws. "Translation only"
// draws one language, so the original's rows would be settings for something
// that is not on screen.
let currentDrawsSource = null;

// The sliders style our own subtitle box, so they are shown exactly when that
// box is what the viewer is looking at:
//
//   "separate layer"  — always; the box is how every subtitle is drawn.
//   "part of the player's subtitle" — only while live transcription runs.
//     A recogniser is used precisely because the player has no captions, so
//     there is nothing to become part of and live always falls back to the box.
//     That is easy to miss, and it is why hiding these on the style alone left
//     no way to resize live captions.
function applyAppearanceUI() {
  const inline = $("subtitleMode").value === "inline";
  // The sliders style our own box, so they are shown exactly when that box is
  // what is drawing this video. In inline mode that is: live transcription
  // (there is no player caption to join), an auto-generated track (its rolling
  // line is not the sentence we translate, so the translation goes in the box),
  // and takeover. What is left — a video with its own written captions — has
  // the translation injected into the player's caption, where the font, the
  // size and the colour are the player's and these sliders would do nothing.
  // The page's own answer wins. These sliders style our box, and only the page
  // knows whether that box is what is on screen — on a video that carries a
  // target-language track but no source cues, nothing can take the caption
  // over, so the translation is injected into the player's and none of this
  // applies however the switches are set. Guessing led to a panel full of
  // controls that quietly did nothing.
  const ownBox = currentOwnBox !== null
    ? (currentOwnBox || liveRunning)
    : (!inline || liveRunning || currentIsAsr || $("takeoverCaptions").checked);
  $("appearanceControls").hidden = !ownBox;
  $("appearanceNote").hidden = ownBox;
  applyStyleSplitUI();
  // Drawing both languages ourselves is a choice only inside inline mode:
  // "separate layer" already leaves the player's original alone by definition.
  $("takeoverRow").hidden = !inline;
  $("takeoverNote").hidden = !inline;
  // Off, the note says what the switch would do; on, it says what is happening.
  // A note that still explains the choice after it has been made reads as if
  // nothing took effect.
  $("takeoverNote").textContent =
    ydsT($("takeoverCaptions").checked ? "takeoverNoteOn" : "takeoverNote");
}

// One set of size/colour, or one per language. The original's rows only exist
// when they can differ; the headings only appear then too, because with a
// single set there is nothing for them to tell apart.
// These two settings change WHICH renderer draws, and the panel now takes that
// answer from the page. Without re-asking, it keeps showing the answer from
// before the change — picking "translation only" left the appearance section
// empty, still reporting that the translation was going inside the player's
// caption. The page needs a moment to apply the setting first.
let rendererRefreshTimer = null;
function refreshRendererSoon(ms = 260) {
  clearTimeout(rendererRefreshTimer);
  rendererRefreshTimer = setTimeout(async () => {
    if (activeTabId) await askContent(activeTabId);   // noteVideoInfo does the rest
  }, ms);
}

function applyStyleSplitUI() {
  // Does the original appear in our box at all? In "translation only" it does
  // not, so there is nothing for its size and colour to change — and with one
  // language on screen there is nothing to unify either, which leaves the
  // translation's own rows standing alone without headings.
  const drawsSource = currentDrawsSource !== null
    ? currentDrawsSource
    : $("subtitleMode").value === "inline";
  const split = drawsSource && !$("unifyStyles").checked;
  $("unifyStylesRow").hidden = !drawsSource;
  for (const id of ["sourceStyleHead", "sourceFontRow", "sourceColorRow", "targetStyleHead"]) {
    $(id).hidden = !split;
  }
}

function showSettings(on) {
  $("settingsView").hidden = !on;
  $("mainView").hidden = on;
  // The status line reports on the video behind the popup, which settings has
  // nothing to do with.
  $("status").hidden = on;
  const gear = $("openSettings");
  gear.textContent = on ? "\u2190" : "\u2699";
  const label = ydsT(on ? "back" : "openSettings");
  gear.title = label;
  gear.setAttribute("aria-label", label);
}

function selectTab(which) {
  const live = which === "live";
  $("tabLive").setAttribute("aria-selected", String(live));
  $("tabTranslate").setAttribute("aria-selected", String(!live));
  $("panelLive").hidden = !live;
  $("panelTranslate").hidden = live;
  try { localStorage.setItem("yds-popup-tab", which); } catch {}
}

// The live panel says one of three things: what the feature is (before you
// start), how it is going (once running), or what went wrong — with the setup
// link attached whenever the answer is "the recogniser isn't there".
function renderLivePanel(info) {
  const st = (info && info.live) || { active: false, status: "stopped" };
  if (liveRunning !== !!st.active) {
    liveRunning = !!st.active;
    applyAppearanceUI();
  }
  const running = !!st.active;
  $("liveToggle").textContent = ydsT(running ? "liveStop" : "liveStart");

  let msg;
  let showSetup = false;
  if (!running) {
    msg = ydsT("liveIdle");
    showSetup = true;
  } else if (st.status === "connecting") {
    msg = ydsT("liveConnecting");
  } else if (st.status === "listening") {
    msg = ydsT("liveListening");
    // Worth saying: a track was found, so the transcription is sitting idle.
    if (info && info.preCuesLoaded) msg += " " + ydsT("liveHasTrack");
  } else {
    msg = ydsT("liveUnavailable");
    showSetup = true;
  }

  const el = $("liveStatus");
  el.textContent = msg;
  if (showSetup) {
    el.appendChild(document.createTextNode(" "));
    const a = document.createElement("a");
    a.href = SETUP_URL;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = ydsT("liveSetupLink");
    el.appendChild(a);
  }
}

const LIVE_ERRORS = {
  "no-video": "liveNoVideo",
  "capture-failed": "liveCaptureFailed",
  "no-platform": "liveNoVideo"
};

async function toggleLive(info) {
  if (!activeTabId) return;
  const running = !!(info && info.live && info.live.active);
  const res = await sendContent(activeTabId, { type: running ? "YDS_LIVE_STOP" : "YDS_LIVE_START" });
  if (res && res.ok === false) {
    $("liveStatus").textContent = ydsT(LIVE_ERRORS[res.error] || "liveUnavailable");
    return;
  }
  // Give the socket a moment to land on connected-or-not before re-reading.
  setTimeout(async () => {
    const fresh = await askContent(activeTabId);
    renderLivePanel(fresh);
  }, 600);
  renderLivePanel({ live: { active: !running, status: running ? "stopped" : "connecting" } });
}

async function init() {
  const stored = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
  const settings = { ...DEFAULTS, ...stored };

  // Panel language before anything is painted. Localizing first and reading the
  // setting afterwards would flash the browser-default language on every open.
  ydsSetUiLang(settings.uiLang);
  localizeStaticDom();

  $("enabled").checked = !!settings.enabled;
  $("uiLang").value = settings.uiLang || "auto";
  $("subtitleMode").value = settings.subtitleMode || "inline";
  $("takeoverCaptions").checked = !!settings.takeoverCaptions;
  $("bottomOffset").value = settings.bottomOffset;
  $("bottomOffsetVal").textContent = `${settings.bottomOffset}%`;
  $("captionWidth").value = settings.captionWidth;
  $("captionWidthVal").textContent = `${settings.captionWidth}%`;
  $("fontSize").value = settings.fontSize;
  $("color").value = settings.color;
  $("unifyStyles").checked = !!settings.unifyStyles;
  $("sourceColor").value = settings.sourceColor || "#ffffff";
  $("sourceFontSize").value = settings.sourceFontSize;
  applyStyleSplitUI();
  $("bgAlpha").value = bgToTransparency(settings.background);
  $("bgAlphaVal").textContent = `${bgToTransparency(settings.background)}%`;
  applyAppearanceUI();
  $("provider").value = settings.translationProvider || "google";
  $("paidApiMode").value = settings.paidApiMode || "ask";
  applyProviderUI(settings);

  const tab = await getActiveSupportedTab();
  activeTabId = tab ? tab.id : null;
  let info = probedInfo;
  if (tab && !info) info = await askContent(tab.id);

  populateLanguages(info);
  $("lang").value = settings.secondLang || "";

  if (!tab) {
    $("videoInfo").textContent = "";
  } else if (info && info.videoId) {
    $("videoInfo").textContent = info.videoId;
  }
  $("status").textContent = statusTextFor(info, tab);
  renderLivePanel(info);
  let savedTab = "translate";
  try { savedTab = localStorage.getItem("yds-popup-tab") || "translate"; } catch {}
  selectTab(savedTab);
  if (info?.translationStatus?.mode === "translating") startStatusPolling();

  $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
  $("tabTranslate").addEventListener("click", () => selectTab("translate"));
  $("tabLive").addEventListener("click", () => selectTab("live"));
  $("liveToggle").addEventListener("click", async () => {
    const fresh = activeTabId ? await askContent(activeTabId) : null;
    toggleLive(fresh);
  });

  $("translationOnly").addEventListener("change", async (e) => {
    await save({ translationOnly: e.target.checked });
    refreshStatusSoon(300);
  });
  $("lang").addEventListener("change", async (e) => {
    await save({ secondLang: e.target.value });
    $("status").textContent = ydsT("statusLangSwitched");
    refreshStatusSeries();
    startStatusPolling();
  });
  // Settings are a second view of this popup, not a separate page: everything
  // here changes what is on screen behind it, and a tab would hide the video.
  $("openSettings").addEventListener("click", () => showSettings($("settingsView").hidden));

  // The page does the saving, not this popup: a blob URL dies with the document
  // that created it, and a popup is destroyed as soon as it loses focus — which
  // is what clicking a download link causes. chrome.downloads would avoid that
  // too, but it is a permission in the install prompt for one button.
  $("downloadSrt").addEventListener("click", async () => {
    const tab = await getActiveSupportedTab();
    if (!tab) { $("status").textContent = ydsT("statusNoTab"); return; }
    const kind = $("srtKind").value;
    const res = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "YDS_GET_SRT", kind }, (r) => {
        if (chrome.runtime.lastError) resolve(null); else resolve(r);
      });
    });
    if (!res || !res.ok) { $("status").textContent = ydsT("srtEmpty"); return; }
    $("status").textContent = ydsT(res.from === "live" ? "srtSavedLive" : "srtSaved",
                                   { n: res.cueCount });
  });

  $("uiLang").addEventListener("change", async (e) => {
    const value = e.target.value;
    await save({ uiLang: value });
    ydsSetUiLang(value);
    localizeStaticDom();
    // Re-rendering the static text wipes the gear's own state back to its
    // default glyph, and puts the takeover note back to its "off" wording, so
    // both are restored here.
    showSettings(!$("settingsView").hidden);
    applyAppearanceUI();
  });

  $("subtitleMode").addEventListener("change", (e) => {
    save({ subtitleMode: e.target.value });
    applyAppearanceUI();
    refreshRendererSoon();
  });
  // Back to how it looked out of the box. Appearance only — the language, the
  // translator and the API keys are not "appearance" and losing them to a
  // button in this section would be a nasty surprise.
  $("resetAppearance").addEventListener("click", async () => {
    const fields = ["bottomOffset", "captionWidth", "fontSize", "color", "background",
                    "unifyStyles", "sourceColor", "sourceFontSize"];
    const fresh = {};
    for (const k of fields) fresh[k] = DEFAULTS[k];
    await save(fresh);
    $("bottomOffset").value = fresh.bottomOffset;
    $("bottomOffsetVal").textContent = `${fresh.bottomOffset}%`;
    $("captionWidth").value = fresh.captionWidth;
    $("captionWidthVal").textContent = `${fresh.captionWidth}%`;
    $("fontSize").value = fresh.fontSize;
    $("color").value = fresh.color;
    $("bgAlpha").value = bgToTransparency(fresh.background);
    $("bgAlphaVal").textContent = `${bgToTransparency(fresh.background)}%`;
    $("unifyStyles").checked = !!fresh.unifyStyles;
    $("sourceColor").value = fresh.sourceColor;
    $("sourceFontSize").value = fresh.sourceFontSize;
    applyStyleSplitUI();
  });

  $("takeoverCaptions").addEventListener("change", (e) => {
    save({ takeoverCaptions: e.target.checked });
    refreshRendererSoon();
    // Turning this on means we draw the box, so the appearance sliders start
    // applying — they have to appear with it, not on the next popup open.
    applyAppearanceUI();
  });
  $("captionWidth").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    $("captionWidthVal").textContent = `${v}%`;
    save({ captionWidth: v });
  });
  $("bottomOffset").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    $("bottomOffsetVal").textContent = `${v}%`;
    save({ bottomOffset: v });
  });
  // "input", not "change": a number field only fires change on blur, and
  // closing the popup destroys the document without ever blurring it — so a
  // size typed and then dismissed was silently thrown away. The sliders have
  // always used input; these two were the odd ones out.
  $("fontSize").addEventListener("input",
    (e) => save({ fontSize: parseInt(e.target.value, 10) || DEFAULTS.fontSize }));
  $("color").addEventListener("change", (e) => save({ color: e.target.value }));
  $("sourceFontSize").addEventListener("input",
    (e) => save({ sourceFontSize: parseInt(e.target.value, 10) || DEFAULTS.sourceFontSize }));
  $("sourceColor").addEventListener("change", (e) => save({ sourceColor: e.target.value }));
  $("unifyStyles").addEventListener("change", (e) => {
    save({ unifyStyles: e.target.checked });
    applyStyleSplitUI();
  });
  $("bgAlpha").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    $("bgAlphaVal").textContent = `${v}%`;
    save({ background: transparencyToBg(v) });
  });

  $("model").addEventListener("change", async (e) => {
    const provider = $("provider").value;
    // Nothing is stored for the sentinel itself — the field below it decides.
    if (e.target.value === CUSTOM_MODEL) {
      showModelCustom(true);
      $("modelCustom").value = "";
      $("modelCustom").focus();
      return;
    }
    lastListModel = e.target.value;
    await saveModel(provider, e.target.value);
  });

  $("modelCustom").addEventListener("change", async (e) => {
    const provider = $("provider").value;
    const typed = (e.target.value || "").trim();
    if (!typed) return backToModelList(provider);
    e.target.value = typed;
    await saveModel(provider, typed);
  });
  // Picking "custom" and then clicking away without typing leaves no change
  // event behind, so the empty field is caught on the way out too.
  $("modelCustom").addEventListener("blur", () => {
    if (!$("modelCustomWrap").hidden && !$("modelCustom").value.trim()) {
      backToModelList($("provider").value);
    }
  });
  $("modelUseList").addEventListener("click", () => backToModelList($("provider").value));

  $("provider").addEventListener("change", async (e) => {
    await save({ translationProvider: e.target.value });
    const cur = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
    applyProviderUI({ ...DEFAULTS, ...cur });
    $("status").textContent = ydsT("statusProviderSwitched", { name: providerName(e.target.value) });
    refreshStatusSeries();
    startStatusPolling();
  });
  $("paidApiMode").addEventListener("change", async (e) => {
    await save({ paidApiMode: e.target.value });
    $("status").textContent = ydsT(
      e.target.value === "always" ? "paidPolicyOnAlways"
      : e.target.value === "manual" ? "paidPolicyOnManual"
      : "paidPolicyOnAsk");
  });
  $("usePaidApi").addEventListener("click", async () => {
    if (!activeTabId) return;
    const provider = $("provider").value;
    // The key field saves on a debounce. Pasting a key and pressing this
    // straight away used to send the request before the key was stored, and the
    // page answered "API key not set" — the button appeared to do nothing.
    if (apiKeySaveTimer) {
      clearTimeout(apiKeySaveTimer);
      apiKeySaveTimer = null;
      await saveApiKey(provider, $("apiKey").value.trim());
    }
    $("status").textContent = ydsT("statusStartingPaid", { name: providerName(provider) });
    const resp = await sendContent(activeTabId, { type: "YDS_APPROVE_PAID_API" });
    if (!resp?.ok) {
      $("status").textContent = resp?.error || ydsT("statusPaidFailed");
      return;
    }
    refreshStatusSeries();
    startStatusPolling();
  });
  $("editApiKey").addEventListener("click", async () => {
    if (apiKeyEditing) {
      const value = $("apiKey").value.trim();
      await saveApiKey($("provider").value, value);
      updateApiKeyState(!!value);
      setApiKeyEditing(false);
      $("status").textContent = value
        ? ydsT("keySaved", { name: providerName($("provider").value) })
        : ydsT("keyCleared", { name: providerName($("provider").value) });
    } else {
      setApiKeyEditing(true);
    }
  });
  $("apiKey").addEventListener("click", () => {
    if ($("apiKey").disabled) setApiKeyEditing(true);
  });
  $("apiKey").addEventListener("input", (e) => {
    updateApiKeyState(!!e.target.value.trim());
    if (apiKeySaveTimer) clearTimeout(apiKeySaveTimer);
    apiKeySaveTimer = setTimeout(async () => {
      await saveApiKey($("provider").value, e.target.value.trim());
      $("status").textContent = ydsT("keySaved", { name: providerName($("provider").value) });
    }, 500);
  });
  $("apiKey").addEventListener("change", async (e) => {
    if (apiKeySaveTimer) clearTimeout(apiKeySaveTimer);
    const value = e.target.value.trim();
    await saveApiKey($("provider").value, value);
    updateApiKeyState(!!value);
    $("status").textContent = value
      ? ydsT("keySaved", { name: providerName($("provider").value) })
      : ydsT("keyCleared", { name: providerName($("provider").value) });
  });
}

init().catch((err) => {
  $("status").textContent = ydsT("initFailed") + (err?.message || err);
});
