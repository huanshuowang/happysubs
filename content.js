// Content script. Platform-independent half of the extension.
//
// Everything that knows about a specific site lives in platform.js, which
// loads first and hands us an adapter. The adapter finds the <video>, finds
// the overlay anchor, and pushes caption cues at us; from there the flow is
// the same on every platform.
//
// Primary path — whole-track preload:
//   The adapter delivers a full track's cues at once (YouTube by intercepting
//   the player's own /api/timedtext response, Vimeo by fetching the .vtt).
//   We merge cues that were split mid-clause, batch-translate the entire track
//   upfront, and render synchronously against video.currentTime — no lag.
//
// Fallback path — DOM observation:
//   If cues never arrive (format change, expired URL, captions rendered from a
//   source we can't read), we watch the rendered caption text and translate on
//   the fly with a small debounce.

(() => {
  const DEBUG = true;
  const log = (...a) => { if (DEBUG) console.log("[YDS]", ...a); };

  let P = null;   // platform adapter, created in boot()

  const STATE = {
    platform: null,
    videoId: null,
    settings: {
      enabled: true,
      secondLang: ydsDefaultSecondLang(),
      bottomOffset: 5,      // % from the bottom of the video
      fontSize: 20,
      // The TRANSLATION's size and colour. Light pink rather than white so the
      // two languages are told apart at a glance.
      color: "#f7c9c8",
      // …and the original's, which are its own. Off by default because the two
      // lines genuinely differ: the original is the line you check what you
      // heard against, so it stays plain white and a little smaller, and the
      // translation is the one being read. Turning unifyStyles on locks the
      // original to whatever the translation is set to.
      unifyStyles: false,
      sourceColor: "#ffffff",
      sourceFontSize: 18,
      background: "rgba(0,0,0,0.6)",
      // Translation provider: "google" | "claude" | "openai" | "gemini" | "deepseek".
      // Google is free/anonymous; the others need the user's own API key.
      translationProvider: "google",
      uiLang: "auto",          // panel language: "auto" | "zh" | "en"
      // Off by default the overlay rides along with the player's own caption
      // strip: no native captions, no second language. Turning this on detaches
      // it, so the translation shows on its own with the player's CC closed.
      // Share of the player the overlay may use, as a percentage. Only applies
      // when there is no native caption line to match — see matchNativeCaptionWidth.
      captionWidth: 80,
      // How the translation is drawn:
      //   "inline"   part of the player's own caption — cloned from the line it
      //              drew, so it inherits the font and the size the player
      //              scales with the window, and moves because it is the same
      //              element tree. YouTube only; elsewhere it falls back to
      //              the box below.
      //   "floating" our own box at the viewer's chosen height, draggable.
      subtitleMode: "inline",
      // Draw both languages ourselves on every video, including ones that have
      // their own captions.
      //
      // On by default. Injecting the translation into the player's caption
      // sounded tidier, but it put the two languages at the mercy of the
      // player: the box is only as wide as the English, so a longer Chinese
      // line wraps into a tall block; the player re-creates the caption on
      // every cue, so our line flickers; and none of the appearance settings
      // reach it, because the font and size are the player's. Drawing it
      // ourselves is the look this extension is for. The switch stays for
      // anyone who prefers the player's own caption.
      takeoverCaptions: true,
      translationOnly: false,
      // "manual" — only the popup's button starts a paid translation
      // "ask"    — offer it on each video (the default: a paid key that is
      //            never offered is a key the viewer wonders about)
      // "always" — use it on every video without asking
      paidApiMode: "ask",
      models: {},          // { claude?, openai?, gemini?, deepseek? } — see DEFAULT_MODELS
      apiKeys: {}           // { claude?: string, openai?: string, gemini?: string, deepseek?: string }
    }
  };

  let overlayEl = null;
  let currentRenderedText = "";
  // null until the first draw, then true/false for "is it inside the player's
  // own caption right now" — so a switch between the two is noticed once
  // rather than re-done on every frame.
  let drawnInline = null;
  let lastPlayerHeight = 0;
  const translationCache = new Map();
  let cacheKeyLang = "";

  // Cues we render from. Two independent sources with priority:
  //   preCuesNative — pulled from a native second-language track (highest quality)
  //   preCuesTranslated — Google-translated from the source track (fallback)
  // Render always prefers native if it has any cues.
  let preCuesNative = [];
  let preCuesTranslated = [];
  let sourceCuesCache = null;   // raw source cues, kept for re-translation on lang change
  // Auto-generated tracks only: the sentences assembled out of those fragments.
  // [{ startIdx, endIdx, text, start, end }], indices into sourceCuesCache.
  // Null for a human-authored track, where a cue is already a sentence and the
  // translator is given the cues themselves.
  let sentenceGroups = null;
  const seenTrackKeys = new Set(); // dedupe timedtext responses by cue-count+first-start
  let translationStatus = {
    mode: "idle",
    provider: "",
    requestedProvider: "",
    cueCount: 0,
    totalCount: 0,
    translatedCount: 0,
    error: "",
    updatedAt: Date.now()
  };

  function setTranslationStatus(next) {
    translationStatus = { ...translationStatus, ...next, updatedAt: Date.now() };
    log("translation status:", translationStatus);
    // Until this existed the only sign that an AI translation was running was
    // the subtitle not changing for fifteen seconds, which reads as broken.
    try { renderToast(); } catch {}
  }
  const paidApiDecisions = new Map(); // key -> "approved" | "declined"
  let paidApiPromptEl = null;

  // Caption tracks the platform says exist on this video.
  let availableTracks = [];       // [{languageCode, kind, name}]
  let trackRequested = false; // don't ask the player for a track more than once per video
  let sourceRequestAttempts = 0; // translation-only asks are retried once, then we stop
  // Which track the text we are translating came from, so a machine transcript
  // can be upgraded to a human one but never the other way round.
  let sourceLang = "";
  let sourceIsAsr = false;
  let betterSourceRequested = false;

  // Aborts any in-flight LLM/Google Translate calls when we get a better
  // source of cues (native track), a video change, or a settings change.
  // Prevents burning API tokens on translations we're about to discard.
  let translateAbortController = null;
  let translateGeneration = 0;
  function abortInflightTranslation(reason) {
    translateGeneration++;
    if (translateAbortController) {
      log(`abort in-flight translation: ${reason}`);
      translateAbortController.abort();
      translateAbortController = null;
    }
  }

  // Fallback path state.
  let lastNativeText = "";
  let translateTimer = null;
  let pendingText = "";

  // Adapters start before settings finish loading — on YouTube the fetch patch
  // has to be in place at document_start or we miss the caption request. Park
  // anything that arrives in that window and replay it once we know the user's
  // target language, so we never translate into the default one by accident.
  let settingsLoaded = false;
  const pendingTrackLists = [];
  const pendingIngests = [];

  function drainPending() {
    settingsLoaded = true;
    const lists = pendingTrackLists.splice(0);
    const ingests = pendingIngests.splice(0);
    for (const list of lists) handleTrackList(list);
    for (const payload of ingests) ingestCues(payload);
  }

  // ---------- settings ----------
  // The translation used to be white, and white is what everyone who installed
  // before today has stored. A new default only reaches a fresh install, so the
  // pink would never have shown up for anyone already using it.
  //
  // Moved once, and recorded, so that choosing white afterwards sticks: the
  // value being migrated is the old default, not a decision anyone made.
  // Every colour this has defaulted to, newest last. A stored value that is one
  // of them was never chosen by anyone — it is just an older default — so it
  // moves on to the current one. Anything else is the viewer's own pick and is
  // left alone. The version number is what lets a second move happen: the first
  // pink turned out too dark on a bright shot.
  const SUPERSEDED_COLORS = ["#ffffff", "#ffc9ce", "#ffdbe2"];
  const COLOR_MIGRATION = 3;

  function migrateTranslationColor(stored) {
    if ((stored.translationColorMoved | 0) >= COLOR_MIGRATION) return null;
    const moved = { ...stored, translationColorMoved: COLOR_MIGRATION };
    if (!stored.color || SUPERSEDED_COLORS.includes(String(stored.color).toLowerCase())) {
      moved.color = STATE.settings.color;
    }
    return moved;
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(["ydsSettings"], (r) => {
        const stored = (r && r.ydsSettings) || null;
        if (stored) {
          const moved = migrateTranslationColor(stored);
          Object.assign(STATE.settings, moved || stored);
          // Write it back so the popup's colour well agrees with the video.
          if (moved) {
            try { chrome.storage.sync.set({ ydsSettings: moved }); } catch {}
          }
        }
        resolve();
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.ydsSettings) return;
    const prev = { ...STATE.settings };
    Object.assign(STATE.settings, changes.ydsSettings.newValue || {});
    if (typeof ydsSetUiLang === "function") ydsSetUiLang(STATE.settings.uiLang);

    // Disabling is an immediate teardown, not merely a promise that the next
    // caption tick will choose not to draw. In particular, an inline line lives
    // in the player's DOM and a live-recognition callback can arrive between
    // frames; both used to survive after the checkbox was cleared.
    if (!STATE.settings.enabled) {
      closePaidApiPrompt();
      if (live.active) stopLive();
      clearRenderedSubtitles();
      return;
    }

    applyOverlayStyles();
    // Width is decided at render time, so nudge the current line to re-measure.
    if (prev.captionWidth !== STATE.settings.captionWidth && currentRenderedText) {
      renderOverlay(currentRenderedText);
    }

    const langChanged = prev.secondLang !== STATE.settings.secondLang;
    const providerChanged = prev.translationProvider !== STATE.settings.translationProvider;
    const translationOnlyChanged = prev.translationOnly !== STATE.settings.translationOnly;
    const keysChanged = JSON.stringify(prev.apiKeys || {}) !== JSON.stringify(STATE.settings.apiKeys || {});

    if (langChanged) {
      abortInflightTranslation("target language changed");
      closePaidApiPrompt();
      setTranslationStatus({
        mode: "idle",
        provider: "",
        requestedProvider: "",
        cueCount: 0,
        error: ""
      });
      // Full reset — new target language means different native track possible.
      translationCache.clear();
      cacheKeyLang = STATE.settings.secondLang;
      preCuesNative = [];
      preCuesTranslated = [];
      trackRequested = false;
      currentRenderedText = "";
      lastNativeText = "";
      // The new target language may be a track we already pulled and filed as
      // source text, so let the adapter fetch it again.
      if (P && P.forgetLoadedCues) P.forgetLoadedCues();
      maybeRequestTrack();
    }

    // Any change to translation config: retranslate from cached source if we
    // aren't already showing a higher-priority native track.
    if ((langChanged || providerChanged || keysChanged)
        && sourceCuesCache
        && STATE.settings.secondLang
        && !preCuesNative.length) {
      preCuesTranslated = [];
      const tl = toGoogleLang(STATE.settings.secondLang);
      translateSourceNow(tl, chooseSourceTranslationProvider(), "settings changed");
      maybeAskForPaidApi(translationUnits(), tl, "settings changed");
    }

    // Switching translation-only on with the player's captions closed means we
    // now need a track the player was never going to fetch — ask for it.
    if (translationOnlyChanged && STATE.settings.translationOnly && !sourceCuesCache && !preCuesNative.length) {
      trackRequested = false;
      maybeRequestTrack();
    }
  });

  // ---------- track list handler ----------
  function handleTrackList(tracks) {
    if (!settingsLoaded) { pendingTrackLists.push(tracks || []); return; }
    availableTracks = tracks || [];
    log("track list:", availableTracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(", ") || "(none)");
    maybeRequestTrack();

    const provider = chooseSourceTranslationProvider();
    if (provider !== "google" && sourceCuesCache && !preCuesNative.length) {
      preCuesTranslated = [];
      translateSourceNow(toGoogleLang(STATE.settings.secondLang), provider, "native unavailable after track list");
    } else if (sourceCuesCache && !preCuesNative.length) {
      maybeAskForPaidApi(translationUnits(), toGoogleLang(STATE.settings.secondLang), "native unavailable after track list");
    }
  }

  function isCcOn() {
    // Returns true / false / null (player not ready yet).
    return P ? P.isCcOn() : null;
  }

  // Best track to translate FROM when the player would never fetch one on its
  // own — translation-only mode, where there is no viewer choice to respect.
  //
  // Order: human-authored in the original language, then any human-authored,
  // then machine transcription. Human text beats a machine transcript even at
  // the cost of relaying through a third language, but among human tracks the
  // original language wins because it costs nothing.
  //
  // The machine track is what tells us the original language: players only
  // auto-generate captions for the language actually being spoken, so its
  // language code is the audio's, even when we go on to translate from
  // something else.
  function pickSourceTrack() {
    const human = availableTracks.filter(t => t.kind !== "asr");
    const machine = availableTracks.find(t => t.kind === "asr") || null;
    const originalLang = machine ? machine.languageCode : "";

    if (originalLang) {
      const humanOriginal = human.find(t => langMatches(originalLang, t.languageCode));
      if (humanOriginal) return humanOriginal;
    }
    return human[0] || machine || availableTracks[0] || null;
  }

  // We ask the player for a track once per video. An advert can swallow that
  // one request: it goes out while the player is showing the ad, nothing comes
  // back, and the flag stays set — so the video then plays to the end with no
  // subtitle and only a reload brings it back. (Captions are also closed during
  // an ad, so the request can instead be deferred and then never retried.)
  //
  // So: having asked, check that something actually arrived, and ask again if
  // it did not. Bounded, and it stops the moment any cues land.
  const TRACK_RETRY_MS = 8000;
  const MAX_TRACK_RETRIES = 5;
  let trackRetries = 0;
  let trackRetryTimer = null;

  function haveCues() {
    return !!(preCuesNative.length || (sourceCuesCache && sourceCuesCache.length));
  }

  function watchForSilentTrack() {
    clearTimeout(trackRetryTimer);
    if (trackRetries >= MAX_TRACK_RETRIES) return;
    trackRetryTimer = setTimeout(() => {
      if (haveCues() || tornDown) return;
      if (!STATE.settings.enabled || !STATE.settings.secondLang) return;
      if (!availableTracks.length) return;
      trackRetries++;
      log(`no cues ${TRACK_RETRY_MS}ms after asking (an ad, probably) — asking again, ${trackRetries}/${MAX_TRACK_RETRIES}`);
      trackRequested = false;
      maybeRequestTrack();
    }, TRACK_RETRY_MS);
  }

  function maybeRequestTrack() {
    if (trackRequested) { watchForSilentTrack(); return; }
    if (!P) return;
    if (!STATE.settings.enabled || !STATE.settings.secondLang) return;
    if (!availableTracks.length) return;

    const cc = isCcOn();
    const target = getNativeTargetTrack();

    if (target) {
      // On YouTube, pulling another language means asking the player to swap
      // tracks, which flashes captions on and off if CC is currently closed —
      // so wait until the user turns CC on themselves and retry then. Vimeo
      // hands us a URL per track, so there is nothing to wait for. In
      // translation-only mode we go ahead regardless: the swap is hidden, and
      // the player's captions are put back the way we found them.
      if (P.requiresCcForTracks && cc !== true && !STATE.settings.translationOnly) {
        log(`CC is ${cc === false ? "off" : "unknown"}, deferring track request`);
        watchForSilentTrack();
        return;
      }
      trackRequested = true;
      log(`requesting native target track: ${target.languageCode} (${target.name})`);
      P.requestTrack(target);
      watchForSilentTrack();
      return;
    }

    log(`no native track for ${STATE.settings.secondLang}, will translate`);

    // Nothing in the target language, so we have to translate something. With
    // the player's captions closed it never fetches a track by itself, so in
    // translation-only mode ask for one outright — otherwise there is nothing
    // on screen at all.
    if (STATE.settings.translationOnly && P.requiresCcForTracks && cc !== true && !sourceCuesCache) {
      const source = pickSourceTrack();
      if (source) {
        trackRequested = true;
        sourceRequestAttempts++;
        log(`translation-only: requesting source track ${source.languageCode} with CC closed (attempt ${sourceRequestAttempts})`);
        P.requestTrack(source);
        // The player can be too early in its own startup to answer. Give it one
        // more go before we leave the viewer staring at nothing.
        if (sourceRequestAttempts < 2) {
          setTimeout(() => {
            if (!sourceCuesCache && !preCuesNative.length && STATE.settings.translationOnly) {
              trackRequested = false;
              maybeRequestTrack();
            }
          }, 5000);
        }
      }
    }
  }

  function langMatches(target, candidate) {
    if (!target || !candidate) return false;
    const t = String(target).toLowerCase();
    const c = String(candidate).toLowerCase();
    if (t === c) return true;
    // Chinese script variants: don't cross-match Simplified vs Traditional.
    const simplified = new Set(["zh", "zh-hans", "zh-cn", "zh-sg"]);
    const traditional = new Set(["zh-hant", "zh-tw", "zh-hk", "zh-mo"]);
    if (t.startsWith("zh") || c.startsWith("zh")) {
      if (simplified.has(t) && simplified.has(c)) return true;
      if (traditional.has(t) && traditional.has(c)) return true;
      return false;
    }
    // Other languages: coarse match on base language code.
    return t.split("-")[0] === c.split("-")[0];
  }

  function getNativeTargetTrack() {
    if (!STATE.settings.secondLang) return null;
    return availableTracks.find(t => t.kind !== "asr" && langMatches(STATE.settings.secondLang, t.languageCode)) || null;
  }

  function selectedTranslationProvider() {
    return STATE.settings.translationProvider || "google";
  }

  function providerDisplayName(provider) {
    const names = {
      google: "Google Translate",
      claude: "Claude",
      openai: "OpenAI",
      gemini: "Gemini",
      deepseek: "DeepSeek"
    };
    return names[provider] || provider || "API";
  }

  function paidDecisionKey(provider) {
    return [STATE.videoId || "", STATE.settings.secondLang || "", provider || ""].join("|");
  }

  function isPaidProvider(provider) {
    return provider && provider !== "google";
  }

  function chooseSourceTranslationProvider() {
    const provider = selectedTranslationProvider();
    if (provider === "google") return "google";

    // Paid providers are only allowed after the platform's track list proves
    // that no native target-language track exists. Until then, use free Google as
    // a disposable warm cache while the native-track request races.
    if (!availableTracks.length || getNativeTargetTrack()) return "google";
    return paidApiDecisions.get(paidDecisionKey(provider)) === "approved" ? provider : "google";
  }

  let paidAskRetryTimer = null;

  function clearPaidAskRetry() {
    if (paidAskRetryTimer) { clearTimeout(paidAskRetryTimer); paidAskRetryTimer = null; }
  }

  function maybeAskForPaidApi(cues, tl, reason) {
    const provider = selectedTranslationProvider();
    if (!isPaidProvider(provider)) return;
    if (getNativeTargetTrack() || preCuesNative.length) return;

    // The track list is what proves no native target-language track exists, so
    // we would rather have it before spending the viewer's money. But on some
    // videos it never arrives at all, and the old code simply returned — which
    // is why a paid provider could sit there selected and never once be
    // offered. Wait a beat for the list, then decide without it: the cues are
    // already loaded, so there is no native track in play either way.
    if (!availableTracks.length) {
      if (!paidAskRetryTimer) {
        paidAskRetryTimer = setTimeout(() => {
          paidAskRetryTimer = null;
          if (!preCuesNative.length) maybeAskForPaidApi(cues, tl, `${reason} (no track list)`);
        }, 2500);
      }
      return;
    }
    clearPaidAskRetry();

    const key = paidDecisionKey(provider);
    const decision = paidApiDecisions.get(key);
    if (decision === "approved") {
      if (translationStatus.provider !== provider || translationStatus.mode !== "translating") {
        translateSourceNow(tl, provider, `${reason} (user approved paid API)`);
      }
      return;
    }
    if (decision === "declined" || paidApiPromptEl) return;

    const apiKey = (STATE.settings.apiKeys || {})[provider];
    if (!apiKey) {
      setTranslationStatus({
        mode: "need_api_key",
        provider: "google",
        requestedProvider: provider,
        cueCount: preCuesTranslated.length,
        totalCount: cues.length,
        translatedCount: preCuesTranslated.length,
        error: `${providerDisplayName(provider)} API key not set`
      });
      return;
    }

    setTranslationStatus({
      mode: "awaiting_paid_confirmation",
      provider: "google",
      requestedProvider: provider,
      cueCount: preCuesTranslated.length,
      totalCount: cues.length,
      translatedCount: preCuesTranslated.length,
      error: ""
    });
    const mode = STATE.settings.paidApiMode || "ask";
    // "always" means the viewer has already answered this question once and for
    // all; asking again every video is the thing they turned off.
    if (mode === "always") { approvePaidApiForCurrentVideo(`${reason} (always use paid API)`); return; }
    if (mode !== "ask") return;              // "manual": the popup button only
    showPaidApiPrompt(provider, () => {
      closePaidApiPrompt();
      approvePaidApiForCurrentVideo(reason);
    }, () => {
      paidApiDecisions.set(key, "declined");
      closePaidApiPrompt();
      setTranslationStatus({
        mode: "fallback",
        provider: "google",
        requestedProvider: provider,
        cueCount: preCuesTranslated.length,
        totalCount: cues.length,
        translatedCount: preCuesTranslated.length,
        declined: true,
        error: ydsT("paidDeclined")
      });
    });
  }

  function closePaidApiPrompt() {
    if (paidApiPromptEl) paidApiPromptEl.remove();
    paidApiPromptEl = null;
  }

  function showPaidApiPrompt(provider, onApprove, onDecline) {
    closePaidApiPrompt();
    const name = providerDisplayName(provider);
    const root = document.createElement("div");
    root.className = "yds-paid-api-confirm";
    root.innerHTML = `
      <div class="yds-paid-api-card">
        <div class="yds-paid-api-title">${ydsT("paidPromptTitle", { name })}</div>
        <div class="yds-paid-api-body">${ydsT("paidPromptBody", { name })}</div>
        <div class="yds-paid-api-actions">
          <button type="button" class="yds-paid-api-free">${ydsT("paidPromptFree")}</button>
          <button type="button" class="yds-paid-api-use">${ydsT("paidPromptUse", { name })}</button>
        </div>
      </div>`;
    root.querySelector(".yds-paid-api-use").addEventListener("click", onApprove);
    root.querySelector(".yds-paid-api-free").addEventListener("click", onDecline);
    document.documentElement.appendChild(root);
    paidApiPromptEl = root;
  }

  async function refreshApiKeysFromStorage() {
    const stored = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
    if (stored.apiKeys) STATE.settings.apiKeys = stored.apiKeys;
    if (stored.models) STATE.settings.models = stored.models;
  }

  function approvePaidApiForCurrentVideo(reason = "popup approval") {
    const provider = selectedTranslationProvider();
    if (!isPaidProvider(provider)) return { ok: false, error: ydsT("notPaidProvider") };
    if (!sourceCuesCache || preCuesNative.length) return { ok: false, error: ydsT("noSourceCues") };
    const apiKey = (STATE.settings.apiKeys || {})[provider];
    if (!apiKey) {
      setTranslationStatus({ mode: "need_api_key", requestedProvider: provider });
      return { ok: false, error: `${providerDisplayName(provider)} API key not set` };
    }

    const key = paidDecisionKey(provider);
    paidApiDecisions.set(key, "approved");
    closePaidApiPrompt();
    preCuesTranslated = [];
    translateSourceNow(toGoogleLang(STATE.settings.secondLang), provider, `${reason} (user approved paid API)`);
    return { ok: true, provider };
  }

  // ---------- cue ingestion ----------
  //
  // Every platform funnels into here: one track's worth of cues, plus what
  // language they are and whether they are already the language the user asked
  // for. Called by the adapter via ctx.ingest.
  function ingestCues(payload) {
    if (!settingsLoaded) { pendingIngests.push(payload); return; }
    const { cues: rawCues, lang: trackLang = "", isAsr = false, key = "" } = payload || {};
    if (!STATE.settings.enabled || !STATE.settings.secondLang) return;
    if (!rawCues || !rawCues.length) return;

    // The adapter passes a hint, but recompute against the settings we have
    // now — the payload may have been parked before those settings loaded.
    const isNativeTarget = trackLang
      ? (!isAsr && langMatches(STATE.settings.secondLang, trackLang))
      : !!payload.isNativeTarget;

    // Dedupe: the same track can arrive more than once (YouTube re-fetches it
    // after a track swap; Vimeo re-publishes its config on a fresh signature).
    // One exception — a track we already saw as *source* text becomes worth
    // re-reading once the user switches their target language to it.
    const dedupeKey = key
      || `${trackLang}|${isAsr ? "asr" : "sub"}|${rawCues.length}|${rawCues[0].start.toFixed(3)}|${rawCues[rawCues.length - 1].end.toFixed(3)}`;
    const nowWantedAsNative = isNativeTarget && !preCuesNative.length;
    if (seenTrackKeys.has(dedupeKey) && !nowWantedAsNative) return;
    seenTrackKeys.add(dedupeKey);

    if (isNativeTarget) {
      // Native second-language track — use directly, no merge / no translate.
      abortInflightTranslation(`native ${trackLang} loaded`);
      preCuesNative = rawCues.map(c => ({ start: c.start, end: c.end, text: stripUnwantedPunctuation(c.text) }));
      preCuesTranslated = [];
      setTranslationStatus({
        mode: "native",
        provider: "native",
        requestedProvider: "",
        cueCount: preCuesNative.length,
        totalCount: preCuesNative.length,
        translatedCount: preCuesNative.length,
        error: ""
      });
      log(`ingest: NATIVE ${trackLang} track, ${preCuesNative.length} cues (no translation needed)`);
      return;
    }

    // Don't fall back down. Once we're translating a human-authored track, a
    // machine transcript of the same language arriving later (the player
    // re-fetching what the viewer actually has selected, say) must not replace
    // it — that would silently undo the upgrade below.
    if (sourceCuesCache && !sourceIsAsr && isAsr && langMatches(sourceLang || trackLang, trackLang)) {
      log(`ingest: keeping the human-authored ${sourceLang} source, ignoring the machine one`);
      return;
    }

    // Source-language track → translate to the target language. The two kinds
    // of track are prepared differently, and for the same reason: what is on
    // screen has to be the thing we translated.
    //
    // A human-authored cue is taken exactly as the author wrote it — one cue
    // in, one cue out. Its translation is then shown for precisely as long as
    // the player shows that line, which is what "part of the player's subtitle"
    // has to mean. Merging even two of them shifted our boundaries off the
    // player's, and the Chinese under the caption was then a line behind the
    // English above it.
    //
    // A machine transcript has no authored boundaries to respect: its events
    // are rolling timing fragments, so they are de-rolled for display and
    // assembled into sentences for the translator.
    const asrEnglish = isAsr && langMatches("en", trackLang);
    const sourceCues = asrEnglish ? buildAsrDisplayCues(rawCues) : clampOverlappingCues(rawCues);
    sourceCuesCache = sourceCues;
    sentenceGroups = asrEnglish ? buildAsrSentenceGroups(sourceCues) : null;
    sourceLang = trackLang;
    sourceIsAsr = isAsr;
    log(`ingest: ${rawCues.length} raw → ${sourceCues.length} source cues`
        + (sentenceGroups ? ` in ${sentenceGroups.length} sentences` : "")
        + ` (${trackLang || "?"}${isAsr ? ", asr" : ""})`);

    // The player handed us machine transcription, but the video also carries a
    // human-authored track in the same language — ask for that instead. Same
    // words on screen either way, better text to translate from. Staying inside
    // one language is the point: swapping to a different language would leave
    // the caption strip and the translation talking about different things.
    if (isAsr && !betterSourceRequested && P && trackLang) {
      const better = availableTracks.find(t => t.kind !== "asr" && langMatches(trackLang, t.languageCode));
      if (better) {
        betterSourceRequested = true;
        log(`ingest: upgrading source from ${trackLang}(asr) to the human ${better.languageCode} track`);
        P.requestTrack(better);
        // Carry on translating the machine text meanwhile, so the viewer isn't
        // left with a blank overlay while the better track is on its way.
      }
    }

    // If a native target track has already been loaded, skip translating — the
    // native one is higher quality. We still cache source in case the user
    // later switches to a language with no native track available.
    if (preCuesNative.length) {
      log("ingest: already have native cues, skipping translation");
      return;
    }

    const tl = toGoogleLang(STATE.settings.secondLang);
    // Kick off translation, but also retry the native-track request: on YouTube,
    // cues arriving means CC just turned on, so a request we deferred earlier
    // can go through now.
    maybeRequestTrack();
    translateSourceNow(tl, chooseSourceTranslationProvider(), "source captions loaded");
    maybeAskForPaidApi(translationUnits(), tl, "source captions loaded");
  }

  // ---------- cue post-processing ----------
  function coalesceIdenticalCues(cues) {
    // Players emit the same caption text as multiple overlapping events
    // (continuation / shadow cues). Merge back-to-back cues with
    // identical text into a single longer cue so we don't render the same
    // line twice at overlapping timestamps.
    if (cues.length < 2) return cues;
    const out = [{ ...cues[0] }];
    for (let i = 1; i < cues.length; i++) {
      const prev = out[out.length - 1];
      const c = cues[i];
      if (prev.text === c.text && c.start <= prev.end + 0.1) {
        prev.end = Math.max(prev.end, c.end);
      } else {
        out.push({ ...c });
      }
    }
    return out;
  }

  // Auto-generated captions arrive as timing fragments, not as sentences, and
  // the two jobs done with them want opposite things.
  //
  //   What is DRAWN stays at fragment granularity, so the original line moves
  //   with the voice — the same rhythm the player itself uses.
  //   What is TRANSLATED is the assembled sentence, because a fragment cut
  //   mid-clause does not survive translation: word order and word sense need
  //   the whole sentence.
  //
  // These used to be one thing: the sentence timeline replaced the fragment
  // one, and the sentence was also what went on screen. A whole sentence then
  // appeared at once and sat there — which reads as the subtitle lagging behind
  // the speech — and any re-fetch of the track regrouped the fragments
  // differently, so the same words came back a second time with more added.
  //
  // Now every fragment of a sentence carries that sentence's translation: the
  // lower line holds still while the upper one advances.
  function buildAsrDisplayCues(rawCues) {
    const pieces = rawCues.flatMap(splitAsrCueAtSentenceBoundaries);
    return clampOverlappingCues(coalesceIdenticalCues(derollAsrFragments(pieces)),
                                joinAsrFragments);
  }

  // A rolling transcript re-sends what is already on screen with the next few
  // words appended: "…the difference between issue trees", then "…the
  // difference between issue trees and conceptual frameworks". The player
  // redraws that as one line growing in place. Drawn as separate cues it reads
  // as the same sentence said twice, the second time longer — which is exactly
  // what it looked like. Keep only what each fragment actually adds.
  function derollAsrFragments(cues) {
    const out = [];
    for (const c of cues) {
      const prev = out[out.length - 1];
      if (!prev) { out.push({ ...c }); continue; }
      const added = wordsAddedTo(prev.text, c.text);
      if (added === null) { out.push({ ...c }); continue; }
      // Nothing new at all: the same words again, so just keep them up longer.
      if (!added) { prev.end = Math.max(prev.end, c.end); continue; }
      out.push({ ...c, text: added });
    }
    return out;
  }

  // "" when `next` only repeats `prev`, the words `next` adds when it carries
  // the same speech forward, and null when the two are unrelated and both
  // should stand on their own.
  //
  // Two shapes of repetition, because a rolling transcript produces both: the
  // whole previous line comes back with more added ("A B" then "A B C"), and
  // the next event opens with the last word or two of the one before it
  // ("creativity questions" then "questions or ideas").
  function wordsAddedTo(prev, next) {
    const fold = (s) => String(s || "").toLocaleLowerCase()
      .replace(/[\u2019']/g, "'")
      .replace(/[^\p{L}\p{N}' ]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    const a = fold(prev);
    const b = fold(next);
    if (!a || !b) return null;
    if (a === b) return "";

    // Word counts, not string offsets: folding dropped the punctuation, so an
    // index into the folded text does not point at the same place in the
    // original that has to be sliced.
    const aw = a.split(" ");
    const bw = b.split(" ");
    const keepFrom = (n) => String(next).trim().split(/\s+/).slice(n).join(" ").trim();

    if (b.startsWith(a + " ")) return keepFrom(aw.length);

    const max = Math.min(8, aw.length, bw.length);
    for (let n = max; n > 0; n--) {
      if (aw.slice(-n).join(" ") === bw.slice(0, n).join(" ")) {
        return n === bw.length ? "" : keepFrom(n);
      }
    }
    return null;
  }

  // findCuesAt returns every cue live at the moment asked about, so cues that
  // overlap in time stack up into one line. Auto-caption events overlap by
  // design — each stays "on" well past the start of the next, which is how the
  // player draws two rolling lines — so ours end where the next one begins.
  //
  // Two events at the SAME instant are a different thing and must not be
  // clamped: ending the first where the second begins leaves it zero-length,
  // and it disappears. A rolling transcript sends several events per timestamp,
  // so this quietly ate the opening words of sentence after sentence — on a
  // real video, most of the transcript. They are one caption, and `joinInstant`
  // says how the caller wants them put back together.
  function clampOverlappingCues(cues, joinInstant) {
    const join = joinInstant || ((a, b) => `${a}\n${b}`);
    const out = [];
    for (const c of cues) {
      const prev = out[out.length - 1];
      if (prev && c.start <= prev.start) {
        prev.text = join(prev.text, c.text);
        prev.end = Math.max(prev.end, c.end);
        if ("ydsBoundaryAfter" in c) prev.ydsBoundaryAfter = c.ydsBoundaryAfter;
        continue;
      }
      if (prev && prev.end > c.start) prev.end = c.start;
      out.push({ ...c });
    }
    return out.filter(c => c.end > c.start);
  }

  // Assemble those fragments into sentences for the translator. The result
  // indexes back into the fragment list rather than replacing it: the
  // fragments are still what goes on screen.
  //
  // The caps are looser than they were when this also produced the displayed
  // line — a sentence no longer has to fit on one row, it only has to be a
  // sensible unit to translate — but they are still caps, because one runaway
  // group would hold the whole translation up behind a single request.
  function buildAsrSentenceGroups(cues) {
    const SENTENCE_END = /[.!?…]["'\u2019\u201d)\]\u300d\u300f）]*\s*$/;
    const NON_SPEECH = /^\s*[\[(][^\])]{1,40}[\])]\s*$/;
    // Broadcast practice, roughly: two rows of about forty characters, up to
    // seven seconds. These were nearly twice as generous, and the result filled
    // a third of the picture — two rows of English over two of Chinese — for
    // long enough that the video underneath was the thing being covered up.
    const MAX_GAP = 0.9;
    const MAX_DURATION = 7;
    const MAX_CHARS = 84;
    const MAX_CUES = 6;

    const groups = [];
    let cur = null;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (!cur) {
        cur = { startIdx: i, endIdx: i, text: c.text, start: c.start, end: c.end };
        continue;
      }
      const joined = joinAsrFragments(cur.text, c.text);
      const canMerge = !cues[i - 1].ydsBoundaryAfter
        && !SENTENCE_END.test(cur.text)
        && !NON_SPEECH.test(cur.text)
        && !NON_SPEECH.test(c.text)
        && c.start - cur.end <= MAX_GAP
        && c.end - cur.start <= MAX_DURATION
        && joined.length <= MAX_CHARS
        && (cur.endIdx - cur.startIdx + 1) < MAX_CUES;

      if (canMerge) {
        cur.text = joined;
        cur.end = Math.max(cur.end, c.end);
        cur.endIdx = i;
      } else {
        groups.push(cur);
        cur = { startIdx: i, endIdx: i, text: c.text, start: c.start, end: c.end };
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // What goes to the translator: one entry per sentence on an auto-generated
  // track, the cues themselves on a human-authored one.
  function translationUnits() {
    return sentenceGroups
      ? sentenceGroups.map(g => ({ start: g.start, end: g.end, text: g.text }))
      : (sourceCuesCache || []);
  }

  // …and how its answer comes back out as something renderable: one cue per
  // fragment, every fragment of a sentence carrying that sentence's
  // translation. Consecutive fragments therefore hand the renderer the same
  // string, which it already treats as "nothing changed" — so the lower line
  // is not even repainted while the upper one moves.
  function expandGroupTranslations(translatedGroups) {
    const groups = sentenceGroups;
    const frags = sourceCuesCache;
    if (!groups || !frags) return translatedGroups;
    const byStart = new Map(groups.map(g => [g.start, g]));
    const out = [];
    for (const tg of translatedGroups) {
      const g = byStart.get(tg.start);
      if (!g) { out.push(tg); continue; }
      for (let i = g.startIdx; i <= g.endIdx && i < frags.length; i++) {
        out.push({ start: frags[i].start, end: frags[i].end, text: tg.text, failed: tg.failed });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // Every retranslation goes through here, so none of them can forget that an
  // auto-generated track is translated by the sentence and drawn by the
  // fragment.
  function translateSourceNow(tl, provider, reason) {
    return startCuesTranslation(translationUnits(), tl, provider, reason,
                                sentenceGroups ? expandGroupTranslations : null);
  }

  // Sentence segmentation is done before translation. Intl.Segmenter handles
  // abbreviations better than a bare period regex; the fallback keeps the same
  // behaviour on older Chromium builds. A very long sentence is then divided at
  // a clause/word boundary so each bilingual row can stay on one 65%-wide line.
  function splitAsrCueAtSentenceBoundaries(cue) {
    const text = String(cue.text || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    let sentences = [];
    try {
      const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
      sentences = [...segmenter.segment(text)].map(part => part.segment.trim()).filter(Boolean);
    } catch {
      sentences = text.match(/[^.!?…]+(?:[.!?…]+["'’”)\]]*|$)/g)?.map(s => s.trim()).filter(Boolean) || [text];
    }

    const chunks = [];
    for (const sentence of sentences) chunks.push(...splitLongCaptionText(sentence, 68));
    const totalWeight = chunks.reduce((sum, chunk) => sum + chunk.length, 0) || 1;
    const duration = Math.max(0, cue.end - cue.start);
    let elapsedWeight = 0;
    return chunks.map((chunk, index) => {
      const start = cue.start + duration * (elapsedWeight / totalWeight);
      elapsedWeight += chunk.length;
      const end = index === chunks.length - 1
        ? cue.end
        : cue.start + duration * (elapsedWeight / totalWeight);
      return {
        ...cue,
        start,
        end,
        text: chunk,
        // Every chunk except an unfinished final fragment is a deliberate visual
        // boundary and must not be merged straight back into the next chunk.
        ydsBoundaryAfter: index < chunks.length - 1 || /[.!?…]["'’”)\]]*$/.test(chunk)
      };
    });
  }

  function splitLongCaptionText(text, limit) {
    const result = [];
    let rest = text.trim();
    while (rest.length > limit) {
      const windowText = rest.slice(0, limit + 1);
      let cut = -1;
      // Prefer a clause boundary in the latter half, then the last whole word.
      for (const match of windowText.matchAll(/[,;:—–]\s+/g)) {
        if (match.index >= Math.floor(limit * 0.45)) cut = match.index + match[0].length - 1;
      }
      if (cut < 0 && rest.length <= limit * 2) {
        // No clause mark: make two balanced, readable rows instead of leaving a
        // tiny tail such as "way." as its own subtitle.
        const middle = Math.floor(rest.length / 2);
        const after = rest.indexOf(" ", middle);
        const before = rest.lastIndexOf(" ", middle);
        cut = after >= 0 && after - middle <= middle - before ? after : before;
      }
      if (cut < 0) cut = windowText.lastIndexOf(" ", limit);
      if (cut < Math.floor(limit * 0.45)) cut = limit;
      result.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) result.push(rest);
    return result;
  }

  // Rolling ASR can repeat the beginning of the previous event or overlap by a
  // few words. Join at the largest common word boundary so the bilingual box
  // never reads "captions captions" after sentence grouping.
  function joinAsrFragments(left, right) {
    const a = String(left || "").replace(/\s+/g, " ").trim();
    const b = String(right || "").replace(/\s+/g, " ").trim();
    if (!a) return b;
    if (!b) return a;

    const fold = (s) => s.toLocaleLowerCase()
      .replace(/^["'‘“(\[]+|["'’”)\],.!?;:…]+$/g, "");
    const af = fold(a);
    const bf = fold(b);
    if (bf.startsWith(af)) return b;
    if (af.endsWith(bf)) return a;

    const aw = a.split(" ");
    const bw = b.split(" ");
    const max = Math.min(8, aw.length, bw.length);
    for (let n = max; n > 0; n--) {
      const tail = aw.slice(-n).map(fold).join(" ");
      const head = bw.slice(0, n).map(fold).join(" ");
      if (tail && tail === head) return [...aw, ...bw.slice(n)].join(" ");
    }
    return `${a} ${b}`;
  }

  function stripUnwantedPunctuation(text) {
    if (!text) return text;
    // Strip all periods (Chinese 。 and English .) — keep ! ? ！ ？ , 、 …
    // Preserve decimals like "3.14" by only removing English periods that
    // are not sandwiched between two digits.
    return text
      .replace(/。/g, "")
      .replace(/(?<![0-9])\.|\.(?![0-9])/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  // ---------- Translation providers ----------
  //
  // Public entry points: translateText / translateBatch — they dispatch to
  // the chosen provider (Google / Claude / OpenAI / Gemini) and fall back to
  // Google if the LLM call fails.

  function toGoogleLang(code) {
    // Google Translate uses zh-CN / zh-TW etc., the players use zh-Hans / zh-Hant.
    const map = { "zh-hans": "zh-CN", "zh-hant": "zh-TW", "iw": "he", "jw": "jv" };
    const k = (code || "").toLowerCase();
    return map[k] || code;
  }

  // Human-readable names for prompt-driven LLM providers. Falls back to the
  // BCP-47 code so obscure languages still work (just less prettily).
  const LANG_NAMES = {
    "zh-cn": "Simplified Chinese", "zh-hans": "Simplified Chinese",
    "zh-tw": "Traditional Chinese", "zh-hant": "Traditional Chinese",
    "en": "English", "ja": "Japanese", "ko": "Korean",
    "es": "Spanish", "fr": "French", "de": "German", "it": "Italian",
    "pt": "Portuguese", "ru": "Russian", "ar": "Arabic", "hi": "Hindi",
    "th": "Thai", "vi": "Vietnamese", "id": "Indonesian", "ms": "Malay",
    "tr": "Turkish", "nl": "Dutch", "pl": "Polish", "sv": "Swedish",
    "no": "Norwegian", "da": "Danish", "fi": "Finnish", "cs": "Czech",
    "el": "Greek", "he": "Hebrew", "uk": "Ukrainian", "ro": "Romanian",
    "hu": "Hungarian", "bg": "Bulgarian", "fa": "Persian", "ur": "Urdu",
    "bn": "Bengali", "ta": "Tamil", "te": "Telugu"
  };
  function langNameForPrompt(code) {
    const k = (code || "").toLowerCase();
    return LANG_NAMES[k] || code;
  }

  function buildLLMPrompt(texts, tl) {
    const name = langNameForPrompt(tl);
    const taggedCaptions = texts.map((text, i) => `[${i + 1}] ${text}`).join("\n");
    return `Translate each of these ${texts.length} YouTube captions to ${name}. Keep one output item for every input item.

Rules:
- Keep translations concise (subtitle-length, not formal writing)
- Preserve tone: questions, exclamations, humor, sarcasm
- Use natural spoken language
- Do NOT add trailing periods (。 or .); keep ! ? , ，
- Do NOT merge, split, omit, or reorder any caption
- Output ONLY ${texts.length} numbered lines in this exact format: [1] translation

Captions:
${taggedCaptions}

Translations:`;
  }

  function parseLLMOutput(text, expectedCount) {
    let lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    const tagged = new Map();
    for (const line of lines) {
      const m = /^\[?(\d+)\]?\s*[.)：:\-]?\s*(.+)$/.exec(line);
      if (!m) continue;
      const idx = Number(m[1]);
      if (idx >= 1 && idx <= expectedCount && m[2].trim()) {
        tagged.set(idx, m[2].trim());
      }
    }
    if (tagged.size === expectedCount) {
      return Array.from({ length: expectedCount }, (_, i) => tagged.get(i + 1));
    }

    if (lines.length === expectedCount) return lines;
    // Sometimes LLMs prefix "1. " / "1)" / "1:" despite instructions.
    const stripped = lines
      .map(l => l.replace(/^[\d]+[.\):\-]\s*/, "").trim())
      .filter(l => l.length > 0);
    if (stripped.length === expectedCount) return stripped;
    throw new Error(`LLM returned ${lines.length} lines, expected ${expectedCount}`);
  }

  // Which model each paid provider calls. The viewer picks one in the popup;
  // these are only the fallbacks for a setting that was never touched.
  const DEFAULT_MODELS = {
    claude: "claude-haiku-4-5",
    openai: "gpt-6-luna",
    gemini: "gemini-3.5-flash-lite",
    deepseek: "deepseek-flash"
  };
  const modelFor = (provider) =>
    (STATE.settings.models || {})[provider] || DEFAULT_MODELS[provider];

  // ----- Google Translate (free, anonymous) -----
  //
  // Two ways into the same translation backend, rate-limited separately:
  //
  //   clients5.google.com  ?client=dict-chrome-ex   one q= per string, one
  //                                                 translation back per string
  //   translate.googleapis.com  ?client=gtx         one blob, split by delimiter
  //
  // gtx throttles hard. Measured: 24 batched requests in under three seconds —
  // what a five-minute video asks for — came back 429 across the board, and the
  // block then covered every request from that IP, five-character ones included,
  // for over nine minutes. dict-chrome-ex took twenty of the same batches back to
  // back without one rejection while gtx was still refusing. So dict-chrome-ex
  // leads and gtx is the spare, and neither is asked twice without a pause.
  //
  // Failure is no longer silent. Returning the source text as if it were the
  // translation is what made a throttled request look like "the second half of
  // this video is in English" instead of "translation stopped working".

  function sleepMs(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); },
                               { once: true });
    });
  }

  async function googleJson(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Repeated q= comes back as [["译文","en"], ...], one row per string, in order.
  async function translateBatchDictChrome(texts, tl, signal) {
    const params = new URLSearchParams();
    params.set("client", "dict-chrome-ex");
    params.set("sl", "auto");
    params.set("tl", tl);
    for (const t of texts) params.append("q", t);
    const data = await googleJson("https://clients5.google.com/translate_a/t?" + params, signal);
    const rows = Array.isArray(data) && Array.isArray(data[0]) ? data : [data];
    if (rows.length !== texts.length) {
      throw new Error(`dict-chrome-ex returned ${rows.length} rows, expected ${texts.length}`);
    }
    return rows.map((r, i) => (typeof r[0] === "string" && r[0].trim() ? r[0].trim() : texts[i]));
  }

  // The older endpoint: everything in one q=, pulled apart again by a marker the
  // translator leaves alone. A mismatch now throws rather than firing one request
  // per line — that storm was the fastest way to earn a 429.
  async function translateBatchGtx(texts, tl, signal) {
    const DELIM = "\n\n888777\n\n";
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", tl);
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", texts.join(DELIM));
    const data = await googleJson(url.toString(), signal);
    const combined = (data[0] || []).map(seg => seg[0] || "").join("");
    const parts = combined.split(/\n*\s*888777\s*\n*/);
    if (parts.length !== texts.length) {
      throw new Error(`gtx split into ${parts.length} parts, expected ${texts.length}`);
    }
    return parts.map((s, i) => s.trim() || texts[i]);
  }

  const GOOGLE_LANES = [
    { name: "dict-chrome-ex", run: translateBatchDictChrome },
    { name: "gtx", run: translateBatchGtx }
  ];
  const GOOGLE_RETRY_MS = [0, 2000, 5000];

  async function translateBatchGoogle(texts, tl, signal) {
    let lastErr;
    for (const wait of GOOGLE_RETRY_MS) {
      if (wait) await sleepMs(wait, signal);
      for (const lane of GOOGLE_LANES) {
        try {
          return await lane.run(texts, tl, signal);
        } catch (e) {
          if (signal?.aborted) throw e;
          lastErr = e;
          log(`google lane ${lane.name} failed:`, e.message);
        }
      }
    }
    throw lastErr || new Error("Google translation failed");
  }

  async function translateTextGoogle(text, tl, signal) {
    const [out] = await translateBatchGoogle([text], tl, signal);
    return out || text;
  }

  // ----- Claude (Anthropic) -----
  async function translateBatchClaude(texts, tl, apiKey, signal) {
    const prompt = buildLLMPrompt(texts, tl);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: modelFor("claude"),
        // Sonnet 5.5 and Opus 5.5 think by default and cannot be told not to,
        // and thinking spends from this same budget — 4096 ran out before the
        // translation was written. Haiku 4.5, the default, does not think.
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }]
      }),
      signal
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    return parseLLMOutput(content, texts.length);
  }

  // ----- OpenAI -----
  async function translateBatchOpenAI(texts, tl, apiKey, signal) {
    const prompt = buildLLMPrompt(texts, tl);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelFor("openai"),
        messages: [{ role: "user", content: prompt }],
        // No temperature: the GPT-6 family accepts only the default and 400s on
        // anything else. Effort "none" keeps a subtitle batch from being
        // reasoned over at the medium default — slower and dearer for no gain.
        reasoning_effort: "none"
      }),
      signal
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return parseLLMOutput(content, texts.length);
  }

  // ----- Google Gemini -----
  async function translateBatchGemini(texts, tl, apiKey, signal) {
    const prompt = buildLLMPrompt(texts, tl);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelFor("gemini"))}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Google asks for the default temperature on Gemini 3 — lowering it is
        // what makes these models loop. Thinking level "low" is their own
        // advice for high-throughput work like this; Flash would otherwise
        // think at "high" on every batch.
        generationConfig: {
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: "low" }
        }
      }),
      signal
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseLLMOutput(content, texts.length);
  }

  // ----- DeepSeek -----
  async function translateBatchDeepSeek(texts, tl, apiKey, signal) {
    const prompt = buildLLMPrompt(texts, tl);
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelFor("deepseek"),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        // On by default, at high effort — a chain of thought before every
        // subtitle batch, billed and waited for.
        thinking: { type: "disabled" }
      }),
      signal
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return parseLLMOutput(content, texts.length);
  }

  // ----- Dispatch layer -----
  async function translateBatch(texts, tl, options = {}) {
    const provider = options.provider || STATE.settings.translationProvider || "google";
    const signal = options.signal;
    const key = (STATE.settings.apiKeys || {})[provider];
    try {
      if (provider === "claude") {
        if (!key) throw new Error("Claude API key not set");
        const out = await translateBatchClaude(texts, tl, key, signal);
        options.markProviderUsed?.("claude", provider, "");
        return out;
      }
      if (provider === "openai") {
        if (!key) throw new Error("OpenAI API key not set");
        const out = await translateBatchOpenAI(texts, tl, key, signal);
        options.markProviderUsed?.("openai", provider, "");
        return out;
      }
      if (provider === "gemini") {
        if (!key) throw new Error("Gemini API key not set");
        const out = await translateBatchGemini(texts, tl, key, signal);
        options.markProviderUsed?.("gemini", provider, "");
        return out;
      }
      if (provider === "deepseek") {
        if (!key) throw new Error("DeepSeek API key not set");
        const out = await translateBatchDeepSeek(texts, tl, key, signal);
        options.markProviderUsed?.("deepseek", provider, "");
        return out;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      options.markProviderUsed?.("google", provider, e.message || String(e));
      log(`translateBatch (${provider}) failed, falling back to Google:`, e.message);
    }
    const out = await translateBatchGoogle(texts, tl, signal);
    options.markProviderUsed?.("google", provider === "google" ? "google" : provider, "");
    return out;
  }

  async function translateText(text, tl) {
    // For single-string calls (fallback DOM-observation path) just wrap batch.
    // Simpler than maintaining a separate single-string prompt per provider.
    const [out] = await translateBatch([text], tl);
    return out || text;
  }

  async function translateCuesProgressive(cues, tl, onPartial, options = {}) {
    const MAX_CHARS = 1200;
    const batches = [];
    let cur = [], curLen = 0;

    for (const c of cues) {
      const len = c.text.length + 4;
      if (curLen + len > MAX_CHARS && cur.length) {
        batches.push(cur);
        cur = []; curLen = 0;
      }
      cur.push(c);
      curLen += len;
    }
    if (cur.length) batches.push(cur);

    const result = new Array(cues.length);
    const indexOf = new Map(cues.map((c, i) => [c, i]));
    let done = 0;

    // Two, not four. The free endpoints are rate-limited per IP, and four
    // workers hitting them at once is what turns a long video into a 429.
    const CONCURRENCY = 2;
    let nextBatch = 0;
    async function worker() {
      while (true) {
        const b = nextBatch++;
        if (b >= batches.length) return;
        const batch = batches[b];
        if (options.signal?.aborted || preCuesNative.length) return;
        let translated;
        let failedLine = "";
        // Each cue contributes one entry per line it should keep. They go into
        // the same request, so preserving the break costs no extra round trip.
        const parts = batch.map(c => splitCueLines(c.text));
        const flat = [];
        for (const p of parts) flat.push(...p);
        try {
          translated = await translateBatch(flat, tl, options);
        } catch (e) {
          if (options.signal?.aborted) return;
          // Falling back to the source language is what made a throttled request
          // look like "the rest of this video is in English". The viewer is
          // watching the caption line, not the popup, so the caption line is
          // where this has to be said — and it has to name the way out.
          log("batch failed:", e.message);
          options.onBatchFailed?.(batch.length, e.message || String(e));
          failedLine = ydsT("cueTranslateFailed");
        }
        if (options.signal?.aborted || preCuesNative.length) return;
        let k = 0;
        for (let i = 0; i < batch.length; i++) {
          const orig = batch[i];
          const src = parts[i];
          // The notice is not a translation: it keeps its own punctuation, and
          // it is said once for the cue rather than once per line.
          const t = failedLine || src
            .map((line, j) => stripUnwantedPunctuation(translated[k + j] || line))
            .join("\n");
          k += src.length;
          result[indexOf.get(orig)] = {
            start: orig.start, end: orig.end, text: t, failed: !!failedLine
          };
        }
        done += batch.length;
        // Publish a sorted, defined-only partial snapshot.
        const partial = result.filter(Boolean).sort((a, b) => a.start - b.start);
        onPartial(partial);
        log(`translate progress: ${done}/${cues.length}`);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  // A line break inside one cue means one of two things, and they want
  // opposite treatment.
  //
  //   Two speakers  "So overall, good for us." / "Yeah."
  //                 Separate utterances, usually drawn in separate colours.
  //                 Translating them as one run yields a single line that reads
  //                 as one person saying both — and can only take one colour.
  //
  //   One sentence  "Well, folks," / "if you want to see..."
  //                 Broken purely for width. Translating the halves apart gives
  //                 two fragments that do not compose back into the sentence.
  //
  // What separates them is how the earlier line ends: a finished utterance
  // closes on terminal punctuation, a wrapped one breaks mid-clause.
  const TERMINAL_END = /(?:[.!?…]|[。！？…]|[—–])["'\u2019\u201d)\]\u300d\u300f\uff09]?$/;

  function splitCueLines(text) {
    const parts = String(text == null ? "" : text).split("\n")
      .map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return parts.length ? parts : [""];
    for (let i = 0; i < parts.length - 1; i++) {
      if (!TERMINAL_END.test(parts[i])) return [parts.join(" ")];
    }
    return parts;
  }

  async function startCuesTranslation(cues, tl, provider, reason, expand) {
    abortInflightTranslation(`start ${reason}`);
    const controller = new AbortController();
    translateAbortController = controller;
    const generation = translateGeneration;
    let providerUsed = "";
    let fallbackError = "";
    let untranslatedCount = 0;
    let batchError = "";
    setTranslationStatus({
      mode: "translating",
      provider,
      requestedProvider: provider,
      cueCount: cues.length,
      totalCount: cues.length,
      translatedCount: 0,
      error: ""
    });
    log(`translation start (${provider}): ${reason}`);
    try {
      await translateCuesProgressive(cues, tl, (translatedSoFar) => {
        if (generation !== translateGeneration || controller.signal.aborted || preCuesNative.length) return;
        preCuesTranslated = expand ? expand(translatedSoFar) : translatedSoFar;
        setTranslationStatus({
          mode: "translating",
          provider: providerUsed || provider,
          requestedProvider: provider,
          cueCount: cues.length,
          totalCount: cues.length,
          translatedCount: translatedSoFar.length,
          error: fallbackError
        });
      }, {
        provider,
        signal: controller.signal,
        onBatchFailed: (count, error) => {
          untranslatedCount += count;
          batchError = batchError || error;
        },
        markProviderUsed: (used, requested, error) => {
          providerUsed = used || providerUsed;
          fallbackError = error || fallbackError;
          if (generation === translateGeneration && !controller.signal.aborted && !preCuesNative.length) {
            setTranslationStatus({
              mode: used === requested ? "translating" : "fallback",
              provider: used,
              requestedProvider: requested,
              cueCount: cues.length,
              totalCount: cues.length,
              translatedCount: preCuesTranslated.length,
              error: fallbackError
            });
          }
        }
      });
      if (generation === translateGeneration && !controller.signal.aborted && !preCuesNative.length) {
        // "partial" outranks "fallback": which engine ran matters less than the
        // fact that part of this video is still in its original language.
        const mode = untranslatedCount ? "partial"
                   : (providerUsed && providerUsed !== provider) ? "fallback"
                   : "translated";
        setTranslationStatus({
          mode,
          provider: providerUsed || provider,
          requestedProvider: provider,
          cueCount: preCuesTranslated.length,
          totalCount: cues.length,
          translatedCount: preCuesTranslated.length,
          untranslatedCount,
          error: batchError || fallbackError
        });
        log(`intercept: pre-translated ${preCuesTranslated.length} cues via ${providerUsed || provider}` +
            (untranslatedCount ? `, ${untranslatedCount} left untranslated` : ""));
      } else {
        log(`translation discarded (${provider}): ${reason}`);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setTranslationStatus({
          mode: "error",
          provider,
          requestedProvider: provider,
          cueCount: preCuesTranslated.length,
          totalCount: cues.length,
          translatedCount: preCuesTranslated.length,
          error: e?.message || String(e)
        });
        log(`translation failed (${provider})`, e);
      }
    } finally {
      if (translateAbortController === controller) translateAbortController = null;
    }
  }


  // ---------- live transcription ----------
  //
  // A caption source with no timeline. Text arrives as "the sentence being
  // spoken right now", refreshed several times a second, then finalised. We
  // keep the last finished sentence plus the one in progress, and translate
  // both — the finished one once, the in-progress one on a throttle so a
  // sentence being revised mid-flight doesn't fire a request per keystroke.
  //
  // Translation here always goes through Google, never a paid provider, even
  // when one is configured. A partial retranslates roughly once a second for as
  // long as someone is talking; billing that to an LLM API would be a nasty
  // surprise on an hour-long video. Track translation, which runs once over a
  // fixed set of lines, is where the paid providers earn their keep.
  const LIVE_DISPLAY_CHARS = 90;    // trim the visible line; CSS clips the rest
  const LIVE_HIDE_MS = 4000;        // fade out after this much silence
  const LIVE_PAUSE_HOLD_MS = 8000;  // …but hold it longer once the video is paused
  const LIVE_PARTIAL_MS = 900;      // retranslate the sentence in progress this often

  const live = {
    active: false,
    status: "stopped",
    detail: "",
    textBuf: "",         // last finished sentence, with a trailing space
    partial: "",         // sentence in progress
    transBuf: "",        // its translation
    transPartial: "",
    hideTimer: null,
    partialTimer: null,
    partialLastAt: 0,
    pendingPartial: "",
    partialToken: 0,
    finalChain: Promise.resolve(),   // keeps finals in order
    gen: 0,              // bumped on stop / seek / video change to void in-flight work
    cache: new Map(),
    transcript: [],      // finished sentences, for export — see recordLiveCue
    transcriptEnd: 0     // where the last one ended, so the next can start there
  };

  // Keep the tail, but don't start mid-word: if there's a space near the cut,
  // start after it instead.
  function tailTrim(text, max) {
    if (text.length <= max) return text;
    const tail = text.slice(-max);
    const sp = tail.search(/\s/);
    return sp >= 0 && sp < 24 ? tail.slice(sp + 1) : tail;
  }

  let liveSourceShown = false;

  function liveRender() {
    if (!live.active || !STATE.settings.enabled) return;
    const heard = (live.textBuf + live.partial).trim();
    const translated = (live.transBuf + live.transPartial).trim();
    liveSourceShown = !!heard;
    renderSourceLine(heard ? tailTrim(heard, LIVE_DISPLAY_CHARS) : "");
    renderOverlay(translated ? tailTrim(translated, LIVE_DISPLAY_CHARS) : "");
    if (heard || translated) {
      if (overlayEl) overlayEl.classList.add("yds-live-visible");
      clearTimeout(live.hideTimer);
      live.hideTimer = setTimeout(() => {
        if (overlayEl) overlayEl.classList.remove("yds-live-visible");
      }, LIVE_HIDE_MS);
    }
  }

  async function liveTranslate(text) {
    const key = `${STATE.settings.secondLang}\n${text}`;
    if (live.cache.has(key)) return live.cache.get(key);
    const out = await translateTextGoogle(text, toGoogleLang(STATE.settings.secondLang));
    const clean = stripUnwantedPunctuation(out || "");
    if (live.cache.size > 500) live.cache.clear();
    live.cache.set(key, clean);
    return clean;
  }

  // Finals go through a promise chain so two of them can't land out of order.
  function queueFinalTranslation(text) {
    if (!STATE.settings.secondLang) return;
    live.transPartial = "";
    live.pendingPartial = "";
    live.partialToken++;                 // void any partial translation in flight
    clearTimeout(live.partialTimer);
    live.partialTimer = null;
    const gen = live.gen;
    // Where this sentence sits in the video. The recogniser reports no times,
    // so a finished sentence is taken to run from the end of the previous one
    // to now — close enough to seek by, which is what an exported file is for.
    const video = P && P.getVideoEl();
    const endAt = video ? video.currentTime : 0;
    const startAt = Math.min(live.transcriptEnd, endAt);
    live.transcriptEnd = endAt;

    live.finalChain = live.finalChain.then(async () => {
      try {
        const out = await liveTranslate(text);
        if (gen !== live.gen) return;
        live.transBuf = out + " ";
        recordLiveCue(startAt, endAt, text, out);
        liveRender();
      } catch (e) {
        log("live translation failed:", e?.message || e);
        if (gen === live.gen) {
          live.transBuf = ydsT("cueTranslateFailed") + " ";
          recordLiveCue(startAt, endAt, text, "");
          liveRender();
        }
      }
    });
  }

  // Everything the recogniser has finished this session, so a transcript can be
  // exported afterwards. Nothing else reads it; it is capped so a long stream
  // cannot grow without bound.
  const LIVE_TRANSCRIPT_MAX = 4000;
  function recordLiveCue(start, end, source, translation) {
    if (!source) return;
    live.transcript.push({ start, end, text: translation || "", source });
    if (live.transcript.length > LIVE_TRANSCRIPT_MAX) live.transcript.shift();
  }

  // Throttle, NOT debounce. While someone is speaking the recogniser refreshes
  // the sentence several times a second; a debounce timer would keep being
  // pushed back and the translation would not appear until they paused. The
  // first partial opens a window; later ones only update what gets sent when
  // that window closes.
  function queuePartialTranslation(text) {
    if (!STATE.settings.secondLang) return;
    live.pendingPartial = text;
    if (live.partialTimer) return;       // a window is already queued
    const wait = Math.max(0, LIVE_PARTIAL_MS - (Date.now() - live.partialLastAt));
    live.partialTimer = setTimeout(async () => {
      live.partialTimer = null;
      live.partialLastAt = Date.now();
      const current = live.pendingPartial;
      if (!current) return;              // the sentence finalised meanwhile
      const token = ++live.partialToken;
      const gen = live.gen;
      try {
        const out = await liveTranslate(current);
        if (token !== live.partialToken || gen !== live.gen) return;
        live.transPartial = out;
        liveRender();
      } catch {}
    }, wait);
  }

  function liveOnText(text, isFinal) {
    if (!live.active) return;
    if (isFinal) {
      // Keep only the newest finished sentence, or the line grows without end.
      live.textBuf = text + " ";
      live.partial = "";
      queueFinalTranslation(text);
    } else {
      live.partial = text;
      queuePartialTranslation(text);
    }
    liveRender();
  }

  function liveClearText() {
    live.textBuf = live.partial = live.transBuf = live.transPartial = "";
    live.pendingPartial = "";
    clearTimeout(live.partialTimer);
    live.partialTimer = null;
    live.partialToken++;
  }

  function liveOnStatus(status, detail) {
    live.status = status;
    live.detail = detail || "";
    log(`live: ${status}${detail ? " — " + detail : ""}`);
  }

  async function startLive() {
    if (!P) return { ok: false, error: "no-platform" };
    if (live.active) return { ok: true };
    const video = P.getVideoEl();
    if (!video) return { ok: false, error: "no-video" };
    const res = await window.YDS_LIVE.start(video, { onText: liveOnText, onStatus: liveOnStatus });
    if (!res.ok) {
      liveOnStatus("unavailable", res.detail || res.error);
      return res;
    }
    live.active = true;
    live.gen++;
    applyOverlayStyles();
    return { ok: true };
  }

  function stopLive() {
    if (!live.active && live.status === "stopped") return { ok: true };
    live.active = false;
    live.gen++;
    applyOverlayStyles();
    // Force the render loop to repaint from the track rather than skip it as
    // unchanged — the overlay currently holds live text, not currentRenderedText.
    currentRenderedText = "";
    clearTimeout(live.hideTimer);
    clearTimeout(live.partialTimer);
    liveClearText();
    if (overlayEl) overlayEl.classList.remove("yds-live-visible");
    window.YDS_LIVE.stop();
    renderSourceLine("");
    renderOverlay("");
    return { ok: true };
  }

  // Pausing to read is the one moment a viewer wants the line to stay put.
  //
  // Subtitle tracks handle this by themselves: the timeline stops, so the cue
  // under the playhead keeps rendering for as long as the video is paused.
  // Live text has no timeline — it is only ever "the last thing heard" — so
  // without this it fades on the ordinary silence timeout a few seconds after
  // the audio stops, which is exactly when someone paused to read it.
  function watchPlayback() {
    const ours = (e) => e.target instanceof HTMLMediaElement
                     && (!P || P.getVideoEl() === e.target);
    const holdFor = (ms) => {
      clearTimeout(live.hideTimer);
      live.hideTimer = setTimeout(() => {
        if (overlayEl) overlayEl.classList.remove("yds-live-visible");
      }, ms);
    };
    document.addEventListener("pause", (e) => {
      if (live.active && ours(e)) holdFor(LIVE_PAUSE_HOLD_MS);
    }, true);
    document.addEventListener("play", (e) => {
      if (live.active && ours(e)) holdFor(LIVE_HIDE_MS);
    }, true);
  }

  // A seek makes the recogniser's buffered audio meaningless.
  function watchSeeks() {
    document.addEventListener("seeking", (e) => {
      if (!live.active) return;
      if (!(e.target instanceof HTMLMediaElement)) return;
      live.gen++;
      liveClearText();
      window.YDS_LIVE.reset();
      liveRender();
    }, true);
  }

  // ---------- render loop (uses preCues if available) ----------
  function findCuesAt(cues, t) {
    // Return all cues active at time t, joined by newline. Dedupe by text so
    // overlapping identical entries don't render twice (belt-and-suspenders
    // over coalesceIdenticalCues, which handles adjacent-in-time duplicates).
    const seen = new Set();
    const active = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (t >= c.start && t < c.end) {
        if (!seen.has(c.text)) {
          seen.add(c.text);
          active.push(c.text);
        }
      } else if (c.start > t) break;
    }
    return active.join("\n");
  }

  // Whether the overlay is allowed on screen at all right now.
  //
  // The default is to follow the player: the second language is meant to sit
  // under the original, so closing the player's captions hides both. Users who
  // only want the translation turn on translationOnly, which cuts that tie.
  //
  // A null from isCcOn() means we genuinely could not read the player's caption
  // state, and we stay hidden. Showing on a maybe is the wrong default here —
  // it puts a subtitle on screen the viewer never asked for, which is the one
  // thing this setting exists to prevent. Both adapters have a second signal
  // behind the button, so null should be rare; if it does happen the escape
  // hatch is the translation-only switch.
  function overlayAllowed() {
    if (STATE.settings.translationOnly) return true;
    return isCcOn() === true;
  }

  // Reloading an unpacked extension does not stop the copies of this script
  // already injected into open tabs. Their chrome.runtime connection is cut —
  // the popup can no longer reach them, settings changes never arrive — but the
  // render loop keeps running and keeps painting subtitles. Switching the
  // extension off then appears to do nothing, because the thing still drawing
  // is not listening to anyone.
  //
  // A synchronous runtime API call throws once that context is invalid, so the
  // orphan can notice and clear up after itself instead of haunting the page.
  // Two signals, because either one alone can miss. chrome.runtime.id goes
  // undefined the moment the context is severed, and that is the only signal
  // available when the page is holding a stub of the API. A call into a real
  // runtime method throws "Extension context invalidated", which catches the
  // case where the object survives with its id still attached. Neither is
  // special-cased for tests: an id that is gone means gone, everywhere.
  function extensionStillConnected() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return false;
      if (typeof chrome.runtime.getManifest === "function") chrome.runtime.getManifest();
      return true;
    } catch { return false; }
  }

  let tornDown = false;
  function tearDown(why) {
    if (tornDown) return;
    tornDown = true;
    log("shutting down:", why);
    try { clearInline(); } catch {}
    try { hideNativeCaption(false); } catch {}   // give the player its caption back
    try { if (captionObserver) captionObserver.disconnect(); } catch {}
    // The attach timer re-attaches that observer, which pumps the overlay back
    // into existence — removing the node without stopping the timer just puts
    // the ghost on a delay.
    try { if (attachTimer) { clearInterval(attachTimer); attachTimer = null; } } catch {}
    try { if (overlayEl) overlayEl.remove(); } catch {}
    overlayEl = null;
    removeToast();
    clearPaidAskRetry();
  }

  function renderTick() {
    if (!extensionStillConnected()) {
      // No further frames: this copy is over.
      tearDown("the extension was reloaded or disabled — this page needs a refresh");
      return;
    }
    const video = P ? P.getVideoEl() : null;
    // Native cues always win over translated ones.
    const cues = preCuesNative.length ? preCuesNative : preCuesTranslated;
    // Live transcription owns the overlay whenever it is running, and drives it
    // from its own events rather than from here.
    //
    // A subtitle track is the better source — it is exact where a recogniser
    // guesses — so nothing ever switches to live on its own. But turning live on
    // is an explicit act, and it used to be silently ignored on any video that
    // had a track: the audio was captured, the socket connected, and the screen
    // never changed. Whoever pressed the button gets what they asked for; the
    // track is still in memory and comes straight back when they stop.
    if (!STATE.settings.enabled) {
      const overlayVisible = overlayEl && overlayEl.style.display !== "none";
      if (currentRenderedText || drawnInline || hiddenNodes.size || overlayVisible) {
        clearRenderedSubtitles();
      }
      requestAnimationFrame(renderTick);
      return;
    }

    if (live.active) {
      requestAnimationFrame(renderTick);
      return;
    }
    // Decided once per frame, and held for as long as the transcript is loaded
    // rather than per cue: the player's rolling caption does not stop between
    // our cues, so toggling it with them would make it flash in the gaps.
    const takeover = takeoverActive();
    hideNativeCaption(takeover && overlayAllowed());

    if (video && cues.length && overlayAllowed()) {
      const text = findCuesAt(cues, video.currentTime);
      const displayText = alignWithNativeLineBreaks(text);
      const changed = displayText !== currentRenderedText;
      currentRenderedText = displayText;
      // Inline lives inside a window the player rebuilds on every cue, taking
      // our line with it, so it is re-asserted every frame rather than only
      // when our own text changes.
      if (takeover) {
        noteInline("");   // reported below as takeover rather than inline
        // Both languages, ours to lay out: the original comes from the cues the
        // translation was made from, so the two lines are always the same cue.
        if (drawnInline) { clearInline(); drawnInline = false; }
        renderSourceLine(sourceTextAt(video.currentTime));
        matchNativeFont();
        if (changed || (overlayEl && overlayEl.style.display === "none")) {
          renderOverlay(displayText);
        }
      } else if (drawInline(text)) {
        renderSourceLine("");
        if (drawnInline !== true) { hideOverlayEl(); drawnInline = true; }
      } else {
        // Not taken over: the player is showing the original itself, so our box
        // carries the translation alone. Without this the upper line kept
        // whatever takeover last put there.
        renderSourceLine("");
        if (drawnInline !== false) { clearInline(); drawnInline = false; }
        if (changed || (overlayEl && overlayEl.style.display === "none")) {
          renderOverlay(displayText);
        }
      }
    } else if (currentRenderedText) {
      currentRenderedText = "";
      if (drawnInline) { clearInline(); drawnInline = false; }
      renderSourceLine("");
      renderOverlay("");
    }
    // Resizing the player changes no setting, so the font size has nothing
    // else to hang off — and fullscreen is exactly when it matters.
    if (currentRenderedText && !drawnInline) trackPlayerSize();
    requestAnimationFrame(renderTick);
  }

  // ---------- DOM observation fallback ----------
  let captionObserver = null;
  let attachTimer = null;

  function currentNativeText() {
    return currentNativeLines().join(" ").replace(/\s+/g, " ").trim();
  }

  function currentNativeLines() {
    return P ? P.nativeLines() : [];
  }

  function normalizeForLineMatch(text) {
    return (text || "").replace(/\s+/g, "");
  }

  function alignWithNativeLineBreaks(text) {
    // Nothing to line up with once we have taken the caption over: the player's
    // strip is hidden, and on a rolling transcript it is rewritten several
    // times a second — following it re-wrapped our text on every frame.
    if (takeoverActive()) return String(text).replace(/\n+/g, " ");
    const nativeLines = currentNativeLines();
    if (nativeLines.length < 2) return text.replace(/\n+/g, " ");
    const nativeText = nativeLines.join("");
    if (normalizeForLineMatch(nativeText) !== normalizeForLineMatch(text)) return text.replace(/\n+/g, " ");
    return nativeLines.join("\n");
  }

  function attachCaptionObserver() {
    const target = (P && P.observeTarget()) || document.body;
    if (!target) return;
    if (captionObserver) { try { captionObserver.disconnect(); } catch {} }
    captionObserver = new MutationObserver(() => {
      rehideNativeNow();
      reassertInlineNow();
      pumpFromNative(false);
    });
    captionObserver.observe(target, { childList: true, subtree: true, characterData: true });
    log("caption observer attached");
  }

  function scheduleAttach() {
    if (attachTimer) return;
    attachTimer = setInterval(() => {
      if (P && P.observeTarget()) {
        clearInterval(attachTimer);
        attachTimer = null;
        attachCaptionObserver();
      }
    }, 500);
  }

  async function pumpFromNative(force) {
    if (!STATE.settings.enabled || !STATE.settings.secondLang) return;
    // If we're already rendering from any pre-loaded cues, skip the fallback.
    if (preCuesNative.length || preCuesTranslated.length) return;

    const text = currentNativeText();
    if (!force && text === lastNativeText) return;
    lastNativeText = text;

    if (!text) {
      currentRenderedText = "";
      renderOverlay("");
      return;
    }

    const lang = STATE.settings.secondLang;
    if (cacheKeyLang !== lang) {
      translationCache.clear();
      cacheKeyLang = lang;
    }

    if (translationCache.has(text)) {
      currentRenderedText = translationCache.get(text);
      renderOverlay(currentRenderedText);
      return;
    }

    pendingText = text;
    if (translateTimer) clearTimeout(translateTimer);
    translateTimer = setTimeout(async () => {
      translateTimer = null;
      const t = pendingText;
      if (!t || t !== lastNativeText || preCuesNative.length || preCuesTranslated.length) return;
      if (translationCache.has(t)) {
        currentRenderedText = translationCache.get(t);
        renderOverlay(currentRenderedText);
        return;
      }
      try {
        const raw = await translateText(t, toGoogleLang(lang));
        const translated = stripUnwantedPunctuation(raw);
        translationCache.set(t, translated);
        if (lastNativeText === t && !preCuesNative.length && !preCuesTranslated.length) {
          currentRenderedText = translated;
          renderOverlay(translated);
        }
      } catch (e) { log("translate failed", e); }
    }, 250);
  }

  // ---------- overlay ----------
  function getVideoContainer() {
    return P ? P.getContainer() : null;
  }

  // ---------- translation status toast ----------
  //
  // An AI translation of a long video takes ten to twenty seconds before the
  // first cue changes. With nothing on screen that is indistinguishable from
  // the extension having failed, which is what people reported. This says what
  // is happening, in the player, where they are already looking.
  let toastEl = null;
  let toastHideTimer = null;
  // "Finished" is only worth saying if we said "working" first. A free Google
  // translation lands before anyone looks up, and announcing it on every video
  // would be the extension talking about itself.
  let toastAnnouncedWork = false;

  function ensureToast() {
    if (tornDown) return null;
    const container = getVideoContainer();
    if (!container) return null;
    if (toastEl && toastEl.isConnected && toastEl.parentElement === container) return toastEl;
    if (toastEl) toastEl.remove();
    toastEl = document.createElement("div");
    toastEl.className = "yds-toast";
    // Top centre, clear of the subtitle at the bottom and of the player's own
    // controls — and it never takes a click away from the video.
    toastEl.setAttribute("aria-live", "polite");
    container.appendChild(toastEl);
    return toastEl;
  }

  function hideToast() {
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
    if (toastEl) toastEl.classList.remove("yds-toast-on");
  }

  function removeToast() {
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
    try { if (toastEl) toastEl.remove(); } catch {}
    toastEl = null;
  }

  // What each status looks like to someone watching a video. Returns null for
  // the states that need no narration — a finished free translation is just the
  // subtitle working, and saying so would be noise on every video.
  function toastFor(st) {
    if (!STATE.settings.enabled) return null;
    // Which engine is actually running, not which one was asked for — a free
    // warm pass under a paid selection used to report the paid provider's name,
    // and then its own ("google"), which read as the extension ignoring the
    // choice. It is not ignoring it; it is translating for free while the paid
    // one waits for an answer, and the toast now says exactly that.
    const name = providerDisplayName(st.provider || st.requestedProvider || "");
    const chosen = selectedTranslationProvider();
    const pendingPaid = isPaidProvider(chosen)
      && st.provider === "google"
      && paidApiDecisions.get(paidDecisionKey(chosen)) !== "approved"
      ? providerDisplayName(chosen) : "";
    switch (st.mode) {
      case "translating": {
        // Nothing paid in play — this is the free engine doing its job, and it
        // finishes before anyone looks up.
        if (!pendingPaid && !isPaidProvider(st.provider)) return null;
        toastAnnouncedWork = true;
        const done = st.translatedCount || 0;
        const total = st.totalCount || 0;
        const count = total ? ` ${done}/${total}` : "";
        // The provider the viewer chose leads, because that is the one they are
        // waiting on; what is running right now follows it.
        const head = pendingPaid ? `${ydsT("toastPendingPaid", { name: pendingPaid })} · ` : "";
        return { kind: "busy", text: head + ydsT("toastTranslating", { name }) + count, sticky: true };
      }
      case "need_api_key":
        return { kind: "warn",
                 text: ydsT("toastNoKey", { name: providerDisplayName(st.requestedProvider || chosen) }),
                 sticky: true };
      case "awaiting_paid_confirmation":
        // The confirmation card says this already when it is up.
        return paidApiPromptEl ? null
          : { kind: "warn",
              text: ydsT("toastAwaiting", { name: providerDisplayName(st.requestedProvider || chosen) }),
              sticky: true };
      case "error":
        return { kind: "error", text: ydsT("toastFailed", { name }) + (st.error ? ` — ${st.error}` : ""), sticky: true };
      case "fallback":
        if (st.declined) return null;      // the viewer chose this; not news
        return { kind: "warn", text: ydsT("toastFellBack", { name }), sticky: false };
      case "partial":
        return { kind: "warn",
                 text: ydsT("toastPartial", { n: st.untranslatedCount || 0 }), sticky: true };
      case "translated": {
        if (!toastAnnouncedWork) return null;
        toastAnnouncedWork = false;
        return { kind: "ok", text: ydsT("toastDone", { name, n: st.cueCount || 0 }), sticky: false };
      }
      default:
        return null;
    }
  }

  function renderToast() {
    const spec = toastFor(translationStatus);
    if (!spec) { hideToast(); return; }
    const el = ensureToast();
    if (!el) return;
    el.className = `yds-toast yds-toast-${spec.kind} yds-toast-on`;
    el.textContent = spec.text;
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
    // Anything the viewer may need to act on stays; anything that is just good
    // news gets out of the way.
    if (!spec.sticky) toastHideTimer = setTimeout(hideToast, 2600);
  }

  function ensureOverlay() {
    // Once this copy has shut down it must never build the overlay again. Any
    // stray callback that still reaches a render would otherwise put the
    // subtitle back on a page the extension no longer controls.
    if (tornDown) return null;
    const container = getVideoContainer();
    if (!container) return null;
    if (overlayEl && overlayEl.isConnected && overlayEl.parentElement === container) return overlayEl;
    if (overlayEl) overlayEl.remove();
    overlayEl = document.createElement("div");
    overlayEl.id = "yt-dual-sub-overlay";
    overlayEl.className = "yds-overlay";
    // Two lines, each wrapped in a clip. Normally only the lower one is used:
    // the original is already on screen in the player's own caption strip and we
    // sit under it. Live transcription has no strip to sit under — the
    // recognised speech IS the original — so it fills the upper line too.
    //
    // The clip/wrap nesting only matters in live mode, where it pins the box to
    // two lines and scrolls older text off the top. For a subtitle track the
    // extra elements are inert.
    // Both languages share this layout wrapper. Live mode paints the wrapper;
    // finished subtitle tracks paint each text row separately, so their dark
    // backgrounds hug the words instead of spanning the positioned overlay.
    const box = document.createElement("div");
    box.className = "yds-live-box";
    overlayEl.appendChild(box);
    const makeLine = (cls) => {
      const clip = document.createElement("div");
      clip.className = "yds-clip";
      const wrap = document.createElement("div");
      wrap.className = "yds-wrap";
      const line = document.createElement("span");
      line.className = `yds-line ${cls}`;
      wrap.appendChild(line);
      clip.appendChild(wrap);
      box.appendChild(clip);
      return line;
    };
    const sourceEl = makeLine("yds-source");
    sourceEl.closest(".yds-clip").style.display = "none";
    makeLine("yds-text");
    container.appendChild(overlayEl);
    attachDragUI();
    applyOverlayStyles();
    // A rebuild mid-drag (player swapped the container out from under us) would
    // otherwise drop the dashed outline that shows the drag is live.
    if (dragging) overlayEl.classList.add("yds-dragging");
    return overlayEl;
  }

  // The whole drag interaction is one window-level capture-phase controller,
  // installed once. Two Vimeo facts force this shape:
  //
  //   1. `.vp-target` is a full-bleed mouse-capture layer sitting *after*
  //      `.vp-video-wrapper` under `.player`, so pointer events over the video
  //      never reach the overlay's own container — a listener there sees
  //      nothing and the handle would never appear.
  //   2. The player toggles play/pause from a listener we can't outrank by
  //      bubbling, so grabbing the handle also paused the video.
  //
  // Capture on window is the earliest point in the propagation path, so we get
  // every event first and can keep the player out of the ones that are ours.
  // nearOverlay() is pure geometry, so none of this is Vimeo-specific — it
  // behaves the same on YouTube.
  let dragging = false;
  let dragWatcherInstalled = false;
  let dragStartY = 0;
  let dragStartOffset = 0;
  let dragContainerH = 1;
  let swallowNextClick = false;

  function nearOverlay(x, y) {
    if (!overlayEl || !overlayEl.isConnected || overlayEl.style.display === "none") return false;
    const b = overlayEl.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return false;
    // Expand hit area vertically so the small handle is easy to reach.
    return x >= b.left - 30 && x <= b.right + 30 && y >= b.top - 34 && y <= b.bottom + 20;
  }

  function isDragHandle(e) {
    const t = e.target;
    if (t && t.classList && t.classList.contains("yds-drag-handle")) return true;
    // Fall back to geometry. A player can float a transparent capture layer
    // above everything (Vimeo's .vp-target, YouTube's chrome), which makes
    // e.target something else entirely even though the pointer is on our
    // handle. Hit-testing by rect doesn't care what is painted on top.
    const h = overlayEl && overlayEl.querySelector(".yds-drag-handle");
    if (!h || !h.isConnected) return false;
    const b = h.getBoundingClientRect();
    if (!b.width || !b.height) return false;
    return e.clientX >= b.left && e.clientX <= b.right
        && e.clientY >= b.top && e.clientY <= b.bottom;
  }

  function setHandleVisible(visible) {
    const h = overlayEl && overlayEl.querySelector(".yds-drag-handle");
    if (h) h.classList.toggle("yds-drag-visible", visible);
  }

  function ensureDragWatcher() {
    if (dragWatcherInstalled) return;
    dragWatcherInstalled = true;

    window.addEventListener("mousemove", (e) => {
      if (!dragging) {
        setHandleVisible(nearOverlay(e.clientX, e.clientY));
        return;
      }
      // preventDefault stops text selection mid-drag. We deliberately do NOT
      // stopPropagation here: starving every other mousemove listener on the
      // page breaks player UI (control bars, hover states) for no gain — the
      // click swallow below is what keeps the player from reacting.
      e.preventDefault();
      // Mouse moves DOWN in screen → subtitle should move DOWN (bottom % decreases).
      const deltaPct = -((e.clientY - dragStartY) / dragContainerH) * 100;
      STATE.settings.bottomOffset = Math.max(0, Math.min(maxBottomOffset(), dragStartOffset + deltaPct));
      applyOverlayStyles();
    }, true);

    window.addEventListener("mousedown", (e) => {
      if (!isDragHandle(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const container = getVideoContainer();
      dragging = true;
      dragStartY = e.clientY;
      dragStartOffset = Number(STATE.settings.bottomOffset) || 0;
      dragContainerH = (container && container.getBoundingClientRect().height) || 1;
      // Dragging used to pin the style to "floating". It no longer does: the
      // box is ours and freely placed in both styles now, so there is nothing
      // to protect against — and silently rewriting the style meant one drag
      // turned off the behaviour the viewer had chosen.
      if (overlayEl) overlayEl.classList.add("yds-dragging");
      setHandleVisible(true);
    }, true);

    window.addEventListener("mouseup", (e) => {
      if (!dragging) return;
      e.stopPropagation();
      dragging = false;
      // The click generated by this mouseup can land anywhere, including off
      // the handle — swallow that one too so it doesn't reach the player.
      swallowNextClick = true;
      if (overlayEl) overlayEl.classList.remove("yds-dragging");
      // Persist the rounded value.
      const val = Math.round(Number(STATE.settings.bottomOffset) || 0);
      chrome.storage.sync.get(["ydsSettings"], (r) => {
        const merged = { ...(r && r.ydsSettings ? r.ydsSettings : {}), bottomOffset: val };
        chrome.storage.sync.set({ ydsSettings: merged });
      });
    }, true);

    for (const type of ["pointerdown", "pointerup"]) {
      window.addEventListener(type, (e) => {
        // stopPropagation only — preventDefault() on pointerdown would suppress
        // the compatibility mousedown that starts the drag.
        if (isDragHandle(e) || dragging) e.stopPropagation();
      }, true);
    }

    for (const type of ["click", "dblclick"]) {
      window.addEventListener(type, (e) => {
        if (!isDragHandle(e) && !swallowNextClick) return;
        swallowNextClick = false;
        e.preventDefault();
        e.stopPropagation();
      }, true);
    }

    // Deliberately no "mouseleave" listener: it does not bubble, but a capture
    // listener on window still fires for every element the pointer exits, so
    // it hid the handle constantly on dense player DOMs. mousemove above
    // already hides the handle whenever the pointer isn't near the overlay;
    // this only covers the pointer leaving the window entirely.
    document.addEventListener("mouseout", (e) => {
      if (!dragging && !e.relatedTarget) setHandleVisible(false);
    });
  }

  function attachDragUI() {
    // Handle: small draggable pill above the overlay. All of its behaviour
    // lives in the window-level watcher above.
    const handle = document.createElement("div");
    handle.className = "yds-drag-handle";
    handle.textContent = "↕";
    handle.title = ydsT("dragHint");
    overlayEl.appendChild(handle);
    ensureDragWatcher();
  }

  function applyOverlayStyles() {
    if (!overlayEl) return;
    const s = STATE.settings;
    overlayEl.style.color = s.color;
    overlayEl.style.fontSize = `${scaledFontSize()}px`;
    overlayEl.style.setProperty("--yds-caption-bg", s.background);
    // The original line's own size and colour. Handed to CSS as variables
    // rather than written on the element, because the element is rebuilt and
    // the stylesheet is where the rest of its look already lives. Locked to the
    // translation's when the viewer asked for one set of settings.
    // Never fall back to the TRANSLATION's size. scaledFontSize() does exactly
    // that when handed nothing, which meant a missing sourceFontSize quietly
    // locked the two together: the original could not be changed, and changing
    // the translation dragged it along. A proportion of it is the right
    // fallback — that is what the original was before it had a size of its own.
    const srcBase = s.unifyStyles
      ? Number(s.fontSize) || 20
      : (Number(s.sourceFontSize) || Math.round((Number(s.fontSize) || 20) * 0.86));
    const srcSize = scaledFontSize(srcBase);
    // A plate's height comes from the font's own ascent and descent, not from
    // the line-height — and CJK faces are the taller of the two by about a
    // quarter of a line. One padding therefore cannot suit both: tuned so the
    // English rows of one sentence touch, the Chinese rows overlapped by 5px;
    // tuned for Chinese, English opened a 6px gap. We know which language each
    // line is, so the padding follows the script.
    overlayEl.classList.toggle("yds-text-cjk", isCjkLang(s.secondLang));
    overlayEl.classList.toggle("yds-source-cjk", isCjkLang(sourceLang));
    const srcColor = s.unifyStyles ? s.color : (s.sourceColor || "#ffffff");
    overlayEl.style.setProperty("--yds-source-size", `${srcSize}px`);
    overlayEl.style.setProperty("--yds-source-color", srcColor);
    // And written straight onto the line as well, which is what actually makes
    // it take effect. The stylesheet is injected by the manifest, and Chrome
    // keeps the copy it already parsed until the extension itself is reloaded —
    // so a page refresh can leave new JS running against an OLD overlay.css.
    // That is not theoretical: it was measured on a live page, the variable set
    // to 17px while the line still computed 16.34px, which is the 0.86em the
    // old rule hard-coded. An inline style outranks any stylesheet, new or
    // stale, so the setting cannot be stranded behind a cached file again.
    const sourceLine = overlayEl.querySelector(".yds-source");
    if (sourceLine) {
      sourceLine.style.fontSize = `${srcSize}px`;
      sourceLine.style.color = srcColor;
    }
    // In live mode the background belongs to the text, not to the box, and the
    // width is fixed rather than measured — both handed to CSS as variables.
    overlayEl.classList.toggle("yds-live", live.active);
    // Both languages in one box: live has always needed it, and takeover draws
    // the same shape.
    overlayEl.classList.toggle("yds-pair", live.active || takeoverActive());
    overlayEl.classList.toggle("yds-takeover", !live.active && takeoverActive());
    if (live.active || takeoverActive()) {
      const pct = Math.max(20, Math.min(100, Number(s.captionWidth) || 80));
      overlayEl.style.setProperty("--yds-live-width", `${pct}%`);
      overlayEl.style.setProperty("--yds-live-bg", s.background);
      overlayEl.style.background = "";
      overlayEl.style.width = "";
    } else {
      // Track captions paint a small background on each language row. Painting
      // the sized overlay itself creates the wide grey slab seen in the report.
      overlayEl.style.background = "";
    }
    positionOverlay();
  }

  // ---------- drawing into the player's own caption ----------

  // Why the translation is not being drawn inside the player's caption, or ""
  // when it is. Naming the reason out loud costs nothing, and turns "it still
  // looks like a separate layer" into one line in the console.
  function inlineBlockedBecause() {
    if (!P) return "no platform adapter yet";
    if (typeof P.renderInline !== "function") {
      return `${P.id} has no inline renderer — this is probably an older build of the extension; `
           + `reload it on chrome://extensions and refresh the page`;
    }
    if (live.active) return "live transcription is running, and it always draws in the overlay";
    if (STATE.settings.subtitleMode !== "inline") {
      return `subtitle style is "${STATE.settings.subtitleMode}", not "inline"`;
    }
    // Injecting into an auto-generated caption pairs two different things. The
    // player's line there is a rolling fragment, rewritten several times a
    // second; ours is the translation of the whole sentence that fragment is
    // part of. Sitting one under the other they disagree about how much is
    // being said, and our line is torn out and re-inserted on every rewrite.
    // A machine transcript gets the box instead: the player keeps its rolling
    // original, and the translated sentence sits under it in one steady place.
    if (sourceIsAsr) {
      return "the track is auto-generated: its caption line is a rolling fragment, "
           + "not the sentence we translate, so the translation goes in the box";
    }
    return "";
  }

  function inlineAvailable() {
    return !inlineBlockedBecause();
  }

  // "Part of the player's subtitle" normally means exactly that: the
  // translation is injected into the player's own caption element, so it
  // inherits the player's font and moves with it — see drawInline.
  //
  // Drawing both languages ourselves, with the player's own caption hidden.
  //
  // On an auto-generated track this is the point of the extension: YouTube's
  // own line is a rolling fragment that re-wraps several times a second, which
  // is unpleasant to read and is not the unit we translate. We already assemble
  // those fragments into sentences to translate them — drawing that sentence is
  // strictly better than letting the rolling line stand.
  //
  // The first attempt at this failed for a reason worth recording: the original
  // was drawn at FRAGMENT granularity while the translation under it was the
  // whole sentence, so the two lines carried different amounts of text (six
  // words of English above three wrapped rows of Chinese) and the box resized
  // on every beat of the speech. Both lines are the sentence now — see
  // sourceTextAt — so they always agree and the box holds still for as long as
  // the sentence does.
  //
  // A video with its own written captions is left alone by default: those lines
  // are the author's, and the translation belongs under them rather than in
  // place of them. takeoverCaptions is for viewers who want our box everywhere.
  function takeoverActive() {
    return STATE.settings.subtitleMode === "inline"
        && !live.active
        && (sourceIsAsr || !!STATE.settings.takeoverCaptions)
        && !!(P && sourceCuesCache && sourceCuesCache.length);
  }

  // The original, as the viewer should read it: the assembled sentence on an
  // auto-generated track, the author's own cue on a written one. Never the
  // rolling fragment — that is a timing artefact, not a line of subtitle.
  function sourceTextAt(t) {
    // A video that ships its own track in the target language is authored on a
    // timeline of its own, and nothing we built from the source lines up with
    // it: one of its cues can span several of our sentences. Drawn side by
    // side, the translation then carried two sentences' worth while the
    // original showed one, which reads as the translation having doubled.
    //
    // Whichever cue is on screen is the unit, so the original is whatever the
    // source says across that same stretch of time.
    if (preCuesNative.length) {
      const cue = preCuesNative.find(c => t >= c.start && t < c.end);
      return cue ? sourceTextWithin(sourceCuesCache || [], cue) : "";
    }
    if (sentenceGroups) {
      for (const g of sentenceGroups) {
        if (t >= g.start && t < g.end) return g.text;
      }
      return "";
    }
    return findCuesAt(sourceCuesCache, t).replace(/\n+/g, " ");
  }

  // Hiding the player's own caption while we draw both languages ourselves.
  //
  // Done on the elements the adapter reads, with an inline style, rather than
  // through a class and a selector for the container: the container selector
  // was a guess, it missed, and the player's caption stayed on screen under
  // ours. These elements are the ones the text is read from, so they are the
  // ones that are visible. The players rebuild them constantly, which is why
  // this runs every frame instead of once — and why the restore has to be
  // by hand rather than by removing a class from a node that no longer exists.
  const HIDDEN_MARK = "ydsHidden";
  const hiddenNodes = new Set();

  function showNativeAgain() {
    for (const el of hiddenNodes) {
      if (el.dataset && el.dataset[HIDDEN_MARK]) {
        el.style.visibility = "";
        delete el.dataset[HIDDEN_MARK];
      }
    }
    hiddenNodes.clear();
  }

  function hideNativeCaption(on) {
    if (!on) { if (hiddenNodes.size) showNativeAgain(); return; }
    const els = (P && typeof P.captionEls === "function") ? P.captionEls() : [];
    const seen = new Set();
    for (const el of els) {
      seen.add(el);
      if (!el.dataset[HIDDEN_MARK]) {
        el.dataset[HIDDEN_MARK] = "1";
        // visibility, not opacity: an opacity-0 element still takes part in
        // the player's own layout decisions, and still shows a background in
        // some skins.
        el.style.visibility = "hidden";
        hiddenNodes.add(el);
      }
    }
    // Elements the player has since replaced are no longer ours to restore.
    for (const el of [...hiddenNodes]) if (!el.isConnected) hiddenNodes.delete(el);
  }

  // One line per change of reason: this is called every frame.
  let lastInlineNote = null;
  function noteInline(reason) {
    const note = reason ? `inline off: ${reason}`
      : takeoverActive()
        ? "takeover: both languages drawn by us, the player's caption hidden"
        : "inline on: the translation is part of the player's own caption";
    if (lastInlineNote === note) return;
    lastInlineNote = note;
    log(note);
  }

  // Returns true when the translation ended up inside the player's caption.
  //
  // Takes the unflattened text: findCuesAt joins simultaneous cues with a
  // newline, and when two people are talking those are their separate lines.
  // The overlay flattens them into one line, which is right for a box of our
  // own; inside the player's caption they stay separate, so each one can sit
  // under its speaker's line and take that speaker's colour.
  function drawInline(text) {
    if (!text) return false;
    const blocked = inlineBlockedBecause();
    if (blocked) { noteInline(blocked); return false; }
    const lines = String(text).split("\n").map(t => t.trim()).filter(Boolean);
    if (!lines.length) return false;
    let ok = false;
    try { ok = P.renderInline(lines) === true; }
    catch (e) { noteInline(`the adapter threw: ${e && e.message}`); return false; }
    if (ok) lastInlineLines = lines;
    noteInline(ok ? "" : "the player is drawing no caption line to clone");
    return ok;
  }

  // What we last put inside the player's caption, so it can be put straight
  // back when the player throws its caption away and builds another one.
  let lastInlineLines = null;

  // The player rebuilds its caption window whenever the control bar appears or
  // goes away — it lifts the captions clear of the bar — and that takes our
  // line with it. Waiting for the next animation frame to notice leaves one
  // painted frame with the original on screen and the translation missing,
  // which is a visible blink every time the mouse moves over the video.
  //
  // A MutationObserver callback runs before the browser paints, so putting the
  // line back from here closes the gap entirely rather than shortening it.
  function reassertInlineNow() {
    if (drawnInline !== true || !lastInlineLines) return;
    if (inlineBlockedBecause()) return;
    try { P.renderInline(lastInlineLines); } catch {}
  }

  // Same problem, other way round. In takeover we hide the player's caption by
  // setting visibility on the elements it drew — and it draws new ones for
  // every cue. Hiding them on the next animation frame leaves one painted
  // frame in which the player's own original is on screen under ours: on an
  // auto-generated track the line is rewritten constantly and it goes
  // unnoticed, but on an authored track that is one visible flash per subtitle.
  // Hiding from the observer, before paint, means they are never seen at all.
  function rehideNativeNow() {
    if (!takeoverActive() || !overlayAllowed()) return;
    try { hideNativeCaption(true); } catch {}
  }

  function clearInline() {
    try { if (P && typeof P.clearInline === "function") P.clearInline(); } catch {}
  }

  // Clear every place we can draw and restore anything we hid. This deliberately
  // does not create an overlay when one never existed.
  function clearRenderedSubtitles() {
    currentRenderedText = "";
    clearInline();
    drawnInline = false;
    hideNativeCaption(false);
    if (!overlayEl) return;
    for (const selector of [".yds-source", ".yds-text"]) {
      const line = overlayEl.querySelector(selector);
      if (!line) continue;
      line.textContent = "";
      const clip = line.closest(".yds-clip");
      if (clip) clip.style.display = "none";
    }
    overlayEl.classList.remove("yds-live-visible", "yds-dragging");
    overlayEl.style.display = "none";
  }

  function hideOverlayEl() {
    if (overlayEl) overlayEl.style.display = "none";
  }

  // In takeover the upper line is the video's own words, so it is set in the
  // player's own caption face: read off the element the player is drawing into,
  // which is still measurable while hidden. Only the family is taken — the size
  // is the viewer's setting, and the colour is ours.
  let lastNativeFont = "";
  function matchNativeFont() {
    if (!overlayEl) return;
    const sourceLine = overlayEl.querySelector(".yds-source");
    if (!sourceLine) return;
    let family = "";
    if (takeoverActive() && P && typeof P.captionEls === "function") {
      const el = P.captionEls()[0];
      if (el) family = getComputedStyle(el).fontFamily || "";
    }
    if (family === lastNativeFont) return;
    lastNativeFont = family;
    sourceLine.style.fontFamily = family;
  }

  // The player scales its own captions with its size — that is why a fixed
  // pixel size reads correctly in a window and far too small in fullscreen.
  // Scale the viewer's chosen size the same way, against a reference height.
  // Inline mode needs none of this: it inherits whatever the player computed.
  const FONT_REF_H = 480;
  const CJK_LANG = /^(zh|ja|ko)/i;
  function isCjkLang(code) {
    return CJK_LANG.test(String(code || "").trim());
  }

  function scaledFontSize(px) {
    const base = Number(px != null ? px : STATE.settings.fontSize) || 20;
    const container = getVideoContainer();
    const h = container ? container.getBoundingClientRect().height : 0;
    if (!h) return base;
    // Sub-linear, and capped. Scaling straight off the player's height meant
    // fullscreen multiplied the text by about two and a half — the subtitle
    // then covered a band of picture rather than sitting under it. A caption
    // does need to grow with the picture, just not in proportion to it.
    const scale = Math.pow(h / FONT_REF_H, 0.6);
    return Math.round(base * Math.max(0.8, Math.min(2, scale)));
  }

  // Where the overlay sits, in one of two modes.
  //
  // Following — parked just under the player's own caption strip so the two
  // read as one block. The strip is not at a fixed height: it grows upward on a
  // second line and lifts when the control bar appears, so this is recomputed
  // from the live rect rather than set once.
  //
  // Fixed — the viewer's own height, used when there is nothing to follow
  // (translation-only with captions closed, live transcription) or when they
  // have dragged the overlay somewhere themselves.
  function positionOverlay() {
    if (!overlayEl) return;
    const offset = Math.max(0, Math.min(maxBottomOffset(), Number(STATE.settings.bottomOffset) || 0));
    overlayEl.style.bottom = `${offset}%`;
    overlayEl.style.top = "auto";
  }

  // `bottom: 95%` only constrains the bottom edge; a two-row subtitle can still
  // extend well above the video. Account for the overlay's actual height so its
  // dashed drag boundary stops exactly at the top edge of the player.
  //
  // And for the handle, which lives 22px ABOVE the box and is the only thing
  // there is to grab. Stopping the box's own top edge at the player's top put
  // the handle outside the player, where the mouse can no longer reach it: the
  // subtitle went up and could not be brought back down. The real ceiling is
  // the handle.
  const DRAG_HANDLE_RESERVE = 24;   // 22px above the box, plus the outline

  function maxBottomOffset() {
    const container = getVideoContainer();
    if (!container || !overlayEl) return 95;
    const containerH = container.getBoundingClientRect().height;
    const overlayH = overlayEl.getBoundingClientRect().height;
    if (!containerH || !overlayH) return 95;
    return Math.max(0, Math.min(95,
      ((containerH - overlayH - DRAG_HANDLE_RESERVE) / containerH) * 100));
  }

  // Entering fullscreen changes no setting, so nothing else would re-apply the
  // font size — and that is exactly when a fixed size looks wrong.
  function trackPlayerSize() {
    const container = getVideoContainer();
    const h = container ? Math.round(container.getBoundingClientRect().height) : 0;
    if (!h || h === lastPlayerHeight) return;
    lastPlayerHeight = h;
    applyOverlayStyles();
    if (currentRenderedText) renderOverlay(currentRenderedText);
  }

  function renderOverlay(text) {
    const el = ensureOverlay();
    if (!el) return;
    const textEl = el.querySelector(".yds-text");
    const sourceEl = el.querySelector(".yds-source");
    const sourceShown = sourceEl && sourceEl.style.display !== "none" && sourceEl.textContent;
    if (!STATE.settings.enabled || (!text && !sourceShown)) {
      el.style.display = "none";
      if (textEl) textEl.textContent = "";
      return;
    }
    el.style.display = "";
    if (textEl) {
      textEl.textContent = text || "";
      const clip = textEl.closest(".yds-clip");
      if (clip) clip.style.display = text ? "" : "none";
      // Live mode is a stream, not a line: its width is fixed by CSS and its
      // height is clipped, so neither measurement applies. Running them here
      // would also be ruinous — the orphan check builds a Range per character,
      // several times a second, for as long as someone is talking.
      if (text && !live.active) {
        matchNativeCaptionWidth();
        avoidOrphanCaptionLine(textEl, text);
      }
    }
    positionOverlay();
  }

  // The upper line: what is being said, as heard by the local recogniser.
  // Only live transcription uses it.
  function renderSourceLine(text) {
    const el = ensureOverlay();
    if (!el) return;
    const sourceEl = el.querySelector(".yds-source");
    if (!sourceEl) return;
    const clip = sourceEl.closest(".yds-clip");
    if (!STATE.settings.enabled || !text) {
      if (clip) clip.style.display = "none";
      sourceEl.textContent = "";
      return;
    }
    if (clip) clip.style.display = "";
    sourceEl.textContent = text;
    el.style.display = "";
    // Outside live mode the box is sized to its content, and with only the
    // upper line filled it would otherwise keep whatever width the lower line
    // last asked for.
    if (!live.active) matchNativeCaptionWidth();
    positionOverlay();
  }

  // Wrap the translation at roughly the width the player is using for its own
  // caption line, so the two read as a matched pair instead of the translation
  // folding onto an extra line while the original still fits.
  //
  // This has to set `width`, not `max-width`. The overlay is an absolutely
  // positioned shrink-to-fit box, and the browser picks a used width well under
  // max-width — measured on a 32-character line: 320px/3 lines under a 378px
  // max-width, but 2 lines when the width is set outright.
  //
  // Bounded on both sides. Never wider than the text actually needs, so a short
  // line still hugs its text instead of sitting in a wide empty bar; never
  // narrower than 30% of the video, so a stray native fragment ("So,") can't
  // squeeze the translation into a column.
  function matchNativeCaptionWidth() {
    if (!overlayEl) return;
    const textEl = overlayEl.querySelector(".yds-text");
    const container = getVideoContainer();
    const containerW = container ? container.getBoundingClientRect().width : 0;
    if (!textEl || !containerW) {
      overlayEl.style.width = "";      // fall back to the stylesheet's max-width
      return;
    }

    const cs = getComputedStyle(overlayEl);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);

    // A constantly rewritten strip is not something to match a width against.
    // Measured on a rolling auto-caption it changes several times a second, our
    // box follows it, the translation re-wraps, and the number of rows changes
    // — and because the box is anchored by its bottom edge, every change in the
    // row count moves its top. That is the subtitle "appearing in the middle
    // and flicking down".
    //
    // This used to be guarded on takeover alone, which covered it while
    // auto-generated tracks were taken over. They are not any more: they are
    // drawn in this box with the player's rolling line still on screen above,
    // which is precisely the case the guard was written for. So it asks about
    // the track, not about which renderer is in use.
    const rollingSource = takeoverActive() || sourceIsAsr;
    const nativeWidth = rollingSource ? 0
      : (P && P.nativeCaptionWidth ? P.nativeCaptionWidth() : 0);
    // The viewer's chosen share of the player, and the ceiling for everything
    // below. This was hard-coded at 65% while the slider goes to 100, so the
    // top third of it did nothing: set to 95%, the subtitle still wrapped at 65.
    const widthPct = Math.max(20, Math.min(100, Number(STATE.settings.captionWidth) || 80));
    const maxCaptionWidth = Math.max(1, containerW * (widthPct / 100) - pad);

    // Two ways to decide how wide to wrap, and which one applies depends on
    // whether there is an original on screen to line up with.
    let target;
    if (nativeWidth) {
      // Match the player's own caption line, clamped so a stray fragment
      // ("So,") can't squeeze us into a column.
      target = Math.min(Math.max(nativeWidth, containerW * 0.3), maxCaptionWidth);
    } else {
      // Nothing to match — live transcription, or translation-only with the
      // player's captions closed. Fall back to the viewer's chosen share of the
      // player. This matters when the picture itself is pillarboxed (4:3 footage
      // in a 16:9 player): filling the player would push text past the image.
      target = maxCaptionWidth;
    }

    // Measure both lines: live transcription often has the original up before
    // its translation arrives, and sizing off an empty lower line would collapse
    // the box and then jump when the translation lands.
    //
    // Including the original is also what keeps it on ONE row: the box is only
    // ever as wide as the widest line it was measured against, and the original
    // is usually the longer of the two.
    //
    // This was switched off for takeover at one point, because back then the
    // original was drawn a fragment at a time and the box breathed in and out
    // with it — measured at 384px, then 48px, then 324px inside one sentence.
    // Both lines are the whole sentence now and change together, so there is
    // nothing left to jitter against.
    const sourceEl = overlayEl.querySelector(".yds-source");
    const sizeToSourceToo = sourceEl && sourceEl.style.display !== "none";
    const needed = Math.max(
      measureUnwrappedWidth(textEl),
      sizeToSourceToo ? measureUnwrappedWidth(sourceEl) : 0
    );
    if (!needed) { overlayEl.style.width = ""; return; }
    // Chrome reports content-box widths through `width`; add the padding back
    // when the page has put the element in border-box.
    const extra = cs.boxSizing === "border-box" ? pad : 0;
    // Rounded UP, and with a pixel to spare. The measurement is of the text
    // plus its plate, so rounding down leaves the line a fraction narrower than
    // it needs and it wraps — at which point box-decoration-break gives the
    // second row its own padding and the box is wider than if we had just let
    // it be. A pixel of slack is cheaper than that.
    overlayEl.style.width = `${Math.ceil(Math.min(needed, target) + extra) + 1}px`;
  }

  // Width this line would take unwrapped, plate included.
  //
  // The plate's padding has to come from the line being measured, not from
  // whichever line was found first: it is set in em, and the original line is
  // 0.86em, so reading one and applying it to the other left the translation a
  // few pixels short of its own width — and a sentence that fit wrapped anyway.
  function measureUnwrappedWidth(textEl) {
    const cs = getComputedStyle(textEl);
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
    probe.style.font = cs.font;
    probe.textContent = (textEl.textContent || "").replace(/\n/g, " ");
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    if (!w) return 0;
    return w + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  }

  function lineLengthsForTextNode(textNode) {
    const rows = [];
    const text = textNode.nodeValue || "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") continue;
      const range = document.createRange();
      range.setStart(textNode, i);
      range.setEnd(textNode, i + 1);
      const rect = range.getBoundingClientRect();
      range.detach();
      if (!rect.width || !rect.height) continue;
      let row = rows.find(r => Math.abs(r.top - rect.top) < 6);
      if (!row) {
        row = { top: rect.top, chars: 0 };
        rows.push(row);
      }
      row.chars++;
    }
    return rows.sort((a, b) => a.top - b.top).map(r => r.chars);
  }

  function splitBalancedText(text) {
    const compact = text.replace(/\s*\n+\s*/g, "").trim();
    if (compact.length < 8) return text;
    const target = Math.floor(compact.length / 2);
    const forbiddenStart = /[，。！？、；：,.!?;:）】”’]/;
    let best = target;
    for (let offset = 0; offset <= 4; offset++) {
      for (const idx of [target + offset, target - offset]) {
        if (idx <= 2 || idx >= compact.length - 2) continue;
        if (forbiddenStart.test(compact[idx])) continue;
        best = idx;
        offset = 99;
        break;
      }
    }
    return `${compact.slice(0, best)}\n${compact.slice(best)}`;
  }

  function avoidOrphanCaptionLine(textEl, originalText) {
    if (!originalText || originalText.includes("\n")) return;
    const textNode = textEl.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
    const lines = lineLengthsForTextNode(textNode);
    if (lines.length !== 2) return;
    const last = lines[lines.length - 1];
    const first = lines[0];
    if (last > 2 || first < 8) return;

    const balanced = splitBalancedText(originalText);
    if (balanced !== originalText) textEl.textContent = balanced;
  }

  // ---------- SPA nav handling ----------
  function watchUrlChanges(tryAttach) {
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Landing page → video page is a URL change with no page load, so this
        // is where a session that started with nothing to do comes alive.
        if (tryAttach) tryAttach();
        const newVid = P ? P.getVideoId() : null;
        if (newVid !== STATE.videoId) {
          abortInflightTranslation("video changed");
          closePaidApiPrompt();
          clearPaidAskRetry();   // a late track list for the previous video
          setTranslationStatus({
            mode: "idle",
            provider: "",
            requestedProvider: "",
            cueCount: 0,
            error: ""
          });
          STATE.videoId = newVid;
          preCuesNative = [];
          preCuesTranslated = [];
          sourceCuesCache = null;
          sentenceGroups = null;
          lastInlineLines = null;
          availableTracks = [];
          trackRequested = false;
          trackRetries = 0;
          clearTimeout(trackRetryTimer);
          sourceRequestAttempts = 0;
          sourceLang = "";
          sourceIsAsr = false;
          betterSourceRequested = false;
          seenTrackKeys.clear();
          translationCache.clear();
          lastNativeText = "";
          currentRenderedText = "";
          if (P) P.reset();
          stopLive();
          renderOverlay("");
        }
      }
    }).observe(document, { subtree: true, childList: true });
  }

  // ---------- messaging with popup ----------
  // ---------- keyboard shortcuts ----------

  // The two switches are flipped through storage rather than in STATE, so the
  // popup and every other tab see the change the same way they would if it had
  // been clicked — the onChanged listener above does the rest.
  function toggleSetting(key) {
    chrome.storage.sync.get(["ydsSettings"], (r) => {
      const cur = (r && r.ydsSettings) || {};
      chrome.storage.sync.set({ ydsSettings: { ...cur, [key]: !cur[key] } });
    });
  }

  function handleCommand(command) {
    if (command === "toggle-subtitles") toggleSetting("enabled");
  }

  // ---------- subtitle export ----------

  // SRT wants hours:minutes:seconds,milliseconds — comma, not a full stop.
  function srtTime(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const sec = Math.floor(ms / 1000) % 60;
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms % 1000, 3)}`;
  }

  // The cues to export, each carrying both languages where we have both.
  //
  // Three sources, in the order they take precedence on screen: a live session,
  // a track we translated, and a track that was already in the target language.
  // Source text comes from sourceCuesCache, which holds the untranslated cues
  // the translation was made from — index for index, because the translated
  // array is built from it in order.
  function exportableCues() {
    if (live.transcript.length) return live.transcript.slice();
    // An auto-generated track is drawn one fragment at a time, and every
    // fragment of a sentence carries that sentence's translation. Exporting
    // that as it stands would repeat the same Chinese line four times under
    // four pieces of one English sentence. A subtitle file wants the sentence:
    // it is the unit that was translated, and it is what reads back.
    if (sentenceGroups && preCuesTranslated.length) {
      const byStart = new Map(preCuesTranslated.map(c => [c.start, c.text]));
      return sentenceGroups
        .map(g => ({ start: g.start, end: g.end, text: byStart.get(g.start) || "", source: g.text }))
        .filter(c => c.text);
    }
    if (preCuesTranslated.length) {
      const src = sourceCuesCache || [];
      return preCuesTranslated.map((c, i) => ({
        start: c.start, end: c.end, text: c.text,
        source: (src[i] && src[i].text) || ""
      }));
    }
    // The video carries its own track in the target language, so nothing was
    // translated. The original is still available whenever the source-language
    // track was loaded too — it is what the player is showing above our line —
    // and pairing them by time is what makes a bilingual export bilingual.
    // Without this, asking for both languages quietly saved only the Chinese.
    const src = sourceCuesCache || [];
    return preCuesNative.map(c => ({
      start: c.start, end: c.end, text: c.text, source: sourceTextWithin(src, c)
    }));
  }

  // Everything the source track says while `cue` is on screen. A native target
  // track and the original are authored separately, so their cue boundaries do
  // not line up and there is no index to pair them by — overlap in time is the
  // only thing the two have in common.
  function sourceTextWithin(src, cue) {
    if (!src.length) return "";
    const parts = [];
    for (const c of src) {
      if (c.end <= cue.start) continue;
      if (c.start >= cue.end) break;
      const text = String(c.text || "").replace(/\n+/g, " ").trim();
      if (text && !parts.includes(text)) parts.push(text);
    }
    return parts.join(" ");
  }

  // kind: "bilingual" | "original" | "translation"
  function buildSrt(kind) {
    const cues = exportableCues();
    const blocks = [];
    for (const c of cues) {
      const original = (c.source || "").trim();
      const translated = (c.text || "").trim();
      let body;
      if (kind === "original") body = original || translated;
      else if (kind === "translation") body = translated || original;
      else body = [original, translated].filter(Boolean).join("\n");
      if (!body) continue;
      blocks.push(`${blocks.length + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${body}`);
    }
    return blocks.join("\n\n") + (blocks.length ? "\n" : "");
  }

  // Safe on every filesystem, and still recognisable.
  // "<title>-<channel>-<video id>-<languages>.srt", with any part the page
  // would not tell us simply left out. The id stays in because a title and a
  // channel are not unique — two lessons in a series share both — and it is
  // what lets a saved file be matched back to the video it came from.
  function exportFilename(kind) {
    const ask = (name) => {
      try { return (P && typeof P[name] === "function") ? String(P[name]() || "") : ""; }
      catch { return ""; }
    };
    const parts = [
      safeFilenamePart(ask("videoTitle"), 80),
      safeFilenamePart(ask("videoAuthor"), 40),
      safeFilenamePart((P && P.getVideoId()) || "", 40),
      exportLangTag(kind)
    ].filter(Boolean);
    // Nothing identifying came back — keep the old shape rather than saving a
    // file called "CN+EN.srt".
    if (parts.length < 2) parts.unshift(STATE.platform || "happysubs");
    return `${parts.join("-")}.srt`;
  }

  // Which languages are in the file: "CN+EN" for both, "CN" for the
  // translation alone, "EN" for the original alone. The tag is the language
  // actually involved rather than a fixed word, so a Japanese video exported
  // to Korean does not come back labelled "bilingual".
  function exportLangTag(kind) {
    const target = shortLangTag(STATE.settings.secondLang) || "TRANS";
    const source = shortLangTag(sourceLang) || "ORIG";
    if (kind === "translation") return target;
    if (kind === "original") return source;
    return `${target}+${source}`;
  }

  function shortLangTag(code) {
    const c = String(code || "").trim().toLowerCase();
    if (!c) return "";
    // zh is the one that needs more than its primary subtag: Hans and Hant are
    // different files, and labelling both "ZH" defeats the point of the tag.
    if (c.startsWith("zh")) return /hant|tw|hk|mo/.test(c) ? "TW" : "CN";
    return c.split(/[-_]/)[0].toUpperCase();
  }

  // Filenames are handed straight to the browser's downloader, which treats a
  // slash as a path. Anything that could steer it, or that Windows refuses,
  // becomes a space; the rest of the title is left alone so the file still
  // reads like the video it came from.
  function safeFilenamePart(text, limit) {
    return String(text || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .slice(0, limit)
      .trim();
  }

  function saveFile(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // With all_frames on, this script also runs in the player's helper frames.
    // Staying silent there lets the frame that actually holds the video answer
    // the popup — sendMessage takes the first reply it gets.
    if (!P) return;
    if (msg?.type === "YDS_COMMAND") {
      handleCommand(msg.command);
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "YDS_GET_SRT") {
      const kind = msg.kind || "bilingual";
      const srt = buildSrt(kind);
      const count = exportableCues().length;
      const from = live.transcript.length ? "live"
                 : preCuesTranslated.length ? "translated" : "native";
      // The download is started here, in the page, rather than in the popup.
      // A blob URL belongs to the document that made it, and the popup's
      // document is destroyed the moment it loses focus — which is exactly what
      // clicking a download link does. The URL died with it and nothing was
      // saved. This page is not going anywhere.
      const filename = exportFilename(kind);
      if (srt) saveFile(filename, srt);
      // The name goes back as well: the popup never sees the file, and this is
      // the only way a test can check what was actually saved.
      sendResponse({ ok: !!srt, cueCount: count, from, filename });
      return true;
    }
    if (msg?.type === "YDS_GET_INFO") {
      sendResponse({
        platform: STATE.platform,
        videoId: P ? P.getVideoId() : null,
        tracks: availableTracks,
        translations: [],
        settings: STATE.settings,
        nativeCaptionText: currentNativeText(),
        // Which of the two ways of drawing this video gets. The appearance
        // sliders style our own box, so they are worth showing only when the
        // box is what the viewer is looking at.
        sourceIsAsr,
        drawnInOwnBox: !inlineAvailable() || takeoverActive(),
        // Whether the ORIGINAL is ours to draw as well. In "translation only"
        // the box carries one language, so the original's size and colour have
        // nothing to act on and the panel should not offer them.
        drawsSourceLine: live.active || takeoverActive(),
        translationStatus,
        preCuesLoaded: preCuesNative.length + preCuesTranslated.length,
        usingNativeTrack: preCuesNative.length > 0,
        live: { active: live.active, status: live.status, detail: live.detail }
      });
      return true;
    }
    if (msg?.type === "YDS_APPROVE_PAID_API") {
      // Read the key straight from storage first: the popup may have saved it
      // microseconds ago and our storage.onChanged may not have run yet.
      refreshApiKeysFromStorage()
        .then(() => sendResponse(approvePaidApiForCurrentVideo("popup approval")))
        .catch(() => sendResponse(approvePaidApiForCurrentVideo("popup approval")));
      return true;   // async
    }
    if (msg?.type === "YDS_LIVE_START") {
      startLive().then(sendResponse);
      return true;   // async
    }
    if (msg?.type === "YDS_LIVE_STOP") {
      sendResponse(stopLive());
      return true;
    }
  });

  // ---------- boot ----------
  (async function boot() {
    const platformId = window.YDS_PLATFORMS && window.YDS_PLATFORMS.detect();
    if (!platformId) return;

    const ctx = {
      log,
      settings: () => STATE.settings,
      langMatches,
      coalesce: coalesceIdenticalCues,
      onTrackList: handleTrackList,
      ingest: ingestCues
    };

    // Attaching is deliberately retryable. These sites are single-page apps: the
    // viewer often lands on a home or listing page — where there is no video and
    // nothing for us to do — and clicks through to a video without a page load.
    // Deciding once at document_start and giving up would leave the extension
    // dead for the rest of the session, which is exactly what it used to do.
    function tryAttach() {
      if (P) return true;
      const candidate = window.YDS_PLATFORMS.create(platformId, ctx);
      // Also weeds out the player's helper frames, since we run in all frames.
      if (!candidate || !candidate.looksLikeVideoPage()) return false;
      P = candidate;
      STATE.platform = platformId;
      P.start();          // page-world hooks go in first, before settings load
      STATE.videoId = P.getVideoId();
      scheduleAttach();
      watchSeeks();
      watchPlayback();
      requestAnimationFrame(renderTick);
      log("attached", { platform: platformId, videoId: STATE.videoId });
      return true;
    }

    tryAttach();

    await loadSettings();
    if (typeof ydsSetUiLang === "function") ydsSetUiLang(STATE.settings.uiLang);
    cacheKeyLang = STATE.settings.secondLang;
    if (P) STATE.videoId = P.getVideoId();
    drainPending();

    watchUrlChanges(tryAttach);
    log("booted", { platform: platformId, attached: !!P, secondLang: STATE.settings.secondLang });
  })();
})();
