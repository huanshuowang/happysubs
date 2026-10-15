// Runs in the page's main world.
//
// Two jobs:
//   1) Patch fetch / XMLHttpRequest so we forward YouTube's timedtext responses
//      to the content script (only YouTube's own request carries a valid PoT
//      token — direct fetches from us return empty).
//   2) Read ytInitialPlayerResponse to publish the available caption tracks,
//      and expose a bridge that lets content.js ask YouTube's player to load
//      a specific track (so we can intercept a native second-language track
//      even when the user's CC is set to a different language).
(function () {
  if (window.__ydsInjected) return;
  window.__ydsInjected = true;

  // ---- report helper ----
  function report(url, text) {
    if (!text || typeof text !== "string") return;
    if (text.length < 5) return;
    try {
      window.dispatchEvent(new CustomEvent("YDS_TIMEDTEXT", { detail: { url: String(url), text } }));
    } catch {}
  }

  // ---- fetch patch ----
  try {
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        const p = origFetch.apply(this, arguments);
        try {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          if (url.includes("/api/timedtext")) {
            p.then(res => {
              try {
                const clone = res.clone();
                clone.text().then(t => report(url, t)).catch(() => {});
              } catch {}
            }).catch(() => {});
          }
        } catch {}
        return p;
      };
    }
  } catch {}

  // ---- XMLHttpRequest patch ----
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ydsUrl = String(url || "");
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.__ydsUrl && this.__ydsUrl.includes("/api/timedtext")) {
        this.addEventListener("load", () => {
          try {
            const t = this.responseType === "" || this.responseType === "text"
              ? this.responseText
              : (typeof this.response === "string" ? this.response : "");
            report(this.__ydsUrl, t);
          } catch {}
        });
      }
      return origSend.apply(this, arguments);
    };
  } catch {}

  // ---- track list from ytInitialPlayerResponse ----
  //
  // An embedded player (/embed/ on youtube.com or youtube-nocookie.com, inside
  // someone else's page) has no ytInitialPlayerResponse, and often no video id
  // in its URL either — the host page picks the video through the iframe API.
  // The player object holds the same response once it has loaded the video,
  // which in an embed is usually not until the first play.
  const isEmbed = /^\/embed\//.test(location.pathname);
  let lastSignature = "";

  function publishTracks(onlyIfChanged) {
    try {
      const player = document.querySelector("#movie_player");
      let r = window.ytInitialPlayerResponse;
      if (isEmbed && player && typeof player.getPlayerResponse === "function") {
        try { r = player.getPlayerResponse() || r; } catch {}
      }
      const rawTracks = (r && r.captions
        && r.captions.playerCaptionsTracklistRenderer
        && r.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      const tracks = rawTracks.map(t => ({
        languageCode: t.languageCode || "",
        kind: t.kind || "",
        name: (t.name && (t.name.simpleText || (t.name.runs || []).map(x => x.text).join(""))) || t.languageCode || ""
      }));
      let videoId = (r && r.videoDetails && r.videoDetails.videoId) || null;
      if (!videoId && isEmbed && player && typeof player.getVideoData === "function") {
        try { videoId = player.getVideoData().video_id || null; } catch {}
      }
      const signature = `${videoId}|${tracks.map(t => `${t.languageCode}:${t.kind}`).join(",")}`;
      if (onlyIfChanged && signature === lastSignature) return;
      lastSignature = signature;
      window.dispatchEvent(new CustomEvent("YDS_TRACK_LIST", { detail: { videoId, tracks } }));
    } catch {}
  }

  publishTracks();
  setTimeout(publishTracks, 500);
  setTimeout(publishTracks, 1500);
  // No navigation to hook in an embed: the video arrives on first play, or
  // changes when the host page loads another through the iframe API.
  if (isEmbed) setInterval(() => publishTracks(true), 2000);

  // ---- caption on/off, from the player rather than its button ----
  // The content script reads CC state off .ytp-subtitles-button, but the newer
  // embed UI moves CC to the top bar with different markup, and "can't tell"
  // keeps the overlay hidden. The player always knows: a current track with a
  // language means captions are showing. Left on <html> for the content script,
  // which shares the DOM but not our JS world.
  function publishCcState() {
    try {
      const player = document.querySelector("#movie_player");
      if (!player || typeof player.getOption !== "function") return;
      let track = null;
      try { track = player.getOption("captions", "track"); } catch {}
      const on = track && track.languageCode ? "1" : "0";
      if (document.documentElement.dataset.ydsCc !== on) document.documentElement.dataset.ydsCc = on;
    } catch {}
  }
  setInterval(publishCcState, 500);

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(publishTracks, 500);
      setTimeout(publishTracks, 1500);
    }
  }).observe(document, { subtree: true, childList: true });

  // ---- bridge to YouTube player's caption API ----
  // YouTube stores the caption choice — including "auto-translate to X" — and
  // reapplies it to the next video, and the next. We set one of those once, by
  // asking for a track the video did not have (see the guard below), and from
  // then on every auto-captioned video arrived pre-translated by YouTube with
  // our own translation drawn over the top.
  //
  // YouTube also switches it on by itself: with the account language set to
  // English, a Thai video opens as "Thai (auto-generated) >> English". Every
  // caption request then carries tlang=, which we never use as a source — so
  // the viewer got YouTube's English and no bilingual subtitle at all until
  // they turned the translation off by hand.
  //
  // So any auto-translation is cleared, whatever language it is into: what
  // this extension draws is always the original plus the viewer's language.
  // Once per video — the player keeps the same original track, minus the
  // translation, and choosing it again from the player's own menu sticks.
  const clearedFor = new Set();

  window.addEventListener("YDS_CLEAR_AUTO_TRANSLATE", (e) => {
    const player = document.querySelector("#movie_player");
    if (!player || typeof player.getOption !== "function") return;

    let id = "";
    try { id = String(player.getVideoData && player.getVideoData().video_id || ""); } catch {}
    if (clearedFor.has(id)) return;

    let track = null;
    try { track = player.getOption("captions", "track"); } catch {}
    if (!track) return;
    const translating = String(track.translationLanguage
      && (track.translationLanguage.languageCode || track.translationLanguage) || "").toLowerCase();
    if (!translating) return;

    clearedFor.add(id);
    try {
      const plain = { ...track };
      delete plain.translationLanguage;
      player.setOption("captions", "track", plain);
    } catch {}
  });

  // Content script dispatches YDS_LOAD_NATIVE_TRACK with { languageCode }.
  // We ask the player to load that track briefly (which triggers YouTube's own
  // fetch, which we intercept above), then restore the user's original CC.
  window.addEventListener("YDS_LOAD_NATIVE_TRACK", async (e) => {
    const langCode = e.detail && e.detail.languageCode;
    if (!langCode) return;
    const player = document.querySelector("#movie_player");
    if (!player || typeof player.setOption !== "function") return;

    // Only ask for a track the video actually has. Asked for one it does not,
    // YouTube satisfies the request with its OWN auto-translation — the menu
    // lands on "English (auto-generated) >> Chinese (Simplified)" and stays
    // there, because the restore below puts back a track that is no longer what
    // the player considers current. The viewer is then left with YouTube
    // translating for them, which is the one thing this extension exists to
    // replace. We can translate it ourselves; we cannot un-latch that menu.
    try {
      const list = player.getOption("captions", "tracklist") || [];
      const has = list.some(t => t && String(t.languageCode || "").toLowerCase()
                                   === String(langCode).toLowerCase());
      if (!has) return;
    } catch {}

    let originalTrack = null;
    try { originalTrack = player.getOption("captions", "track"); } catch {}
    const ccWasOff = !originalTrack || !originalTrack.languageCode;

    // Hide YouTube's native caption strip while we're swapping tracks so the
    // user doesn't see a flash of the wrong language.
    document.body.classList.add("yds-suppressing-native");

    try {
      // With captions closed the module isn't loaded, and setOption alone is a
      // no-op: measured on a live player, it flips the CC button on but fires
      // no timedtext request at all. loadModule first and the request goes out
      // (as an XHR), paused or playing.
      if (ccWasOff) {
        try { player.loadModule("captions"); } catch {}
      }
      player.setOption("captions", "track", { languageCode: langCode });
      // Give YouTube time to fetch the new track (our interceptor catches it).
      // A little longer when we had to load the module from cold, so we don't
      // unload it out from under an in-flight request.
      await new Promise(r => setTimeout(r, ccWasOff ? 1600 : 900));
    } catch {}

    // Restore whatever the user had before.
    try {
      if (!ccWasOff) {
        // Without translationLanguage spelled out as empty, a translation the
        // player picked up during the swap survives the restore.
        player.setOption("captions", "track",
                         { ...originalTrack, translationLanguage: undefined });
      } else {
        try { player.unloadModule("captions"); } catch {}
      }
    } catch {}

    setTimeout(() => document.body.classList.remove("yds-suppressing-native"), 250);
  });
})();
