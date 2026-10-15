// Platform adapters.
//
// Loaded before content.js in the same isolated world, so content.js just
// reads window.YDS_PLATFORMS off this file.
//
// content.js owns everything platform-independent: cue merging, the five
// translation providers, the paid-API confirmation flow, the overlay and its
// drag UI, the render loop. An adapter only has to answer four questions:
//
//   Where is the <video>?          getVideoEl()
//   Where do I hang the overlay?   getContainer()
//   What caption tracks exist?     start() -> ctx.onTrackList(tracks)
//   Give me a track's cues.        start() / requestTrack() -> ctx.ingest(...)
//
// The two platforms get cues in opposite ways:
//
//   YouTube — passive. Third-party fetches of /api/timedtext come back empty
//   (PoT token check), so inject-youtube.js patches fetch/XHR in the main world
//   and we take whatever the player itself downloads. To read a *different*
//   language we have to ask the player to swap tracks and catch the request.
//
//   Vimeo — active. Caption tracks are ordinary <track> elements pointing at
//   signed .vtt files on captions.vimeo.com, and those fetch fine cross-origin.
//   We can pull any language on demand, so there is no swap dance and no need
//   for the user to turn CC on first.
//
// ---------------------------------------------------------------------------
// Adapter contract
//
//   id                      "youtube" | "vimeo"
//   looksLikeVideoPage()    bool — cheap bail-out for frames with no player
//   getVideoId()            string | null
//   videoTitle()            string — "" when the page does not say (optional)
//   videoAuthor()           string — channel/uploader, "" when unknown (optional)
//   getVideoEl()            HTMLVideoElement | null
//   getContainer()          Element | null — overlay parent, must be positioned
//   isCcOn()                true | false | null (player not ready)
//   requiresCcForTracks     bool — gate track loading on the CC button?
//   nativeLines()           string[] — rendered native caption lines
//   nativeCaptionWidth()    px width of the widest rendered caption line, 0 if none
//   nativeCaptionBox()      viewport rect covering the rendered caption, null if none
//   observeTarget()         Element | null — MutationObserver root for fallback
//   start()                 begin track discovery
//   requestTrack(t)         load this specific track (t from onTrackList)
//   reset()                 forget per-video state
//
// ctx, handed to each factory by content.js:
//
//   ctx.log(...)            debug logger
//   ctx.settings()          live STATE.settings
//   ctx.langMatches(a, b)   BCP-47 comparison, Hans/Hant aware
//   ctx.coalesce(cues)      merge adjacent duplicate cues
//   ctx.onTrackList(tracks) [{languageCode, kind, name}] — kind "asr" = machine
//   ctx.ingest(payload)     {cues, lang, isAsr, isNativeTarget, key}
// ---------------------------------------------------------------------------

(() => {
  // ---------- shared helpers ----------

  // Whatever the page says this video is called and who made it. Used for the
  // exported subtitle's filename, so "missing" is not an error — the filename
  // just leaves that part out.
  function metaContent(...selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const value = el && (el.getAttribute("content") || el.textContent || "");
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return "";
  }

  function injectPageScript(file, id) {
    if (document.getElementById(id)) return;
    const s = document.createElement("script");
    s.id = id;
    s.src = chrome.runtime.getURL(file);
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  }

  // Widest rendered line among these nodes, in CSS px. content.js uses it to
  // wrap the translation at about the same width the player wraps its own
  // caption, so the two lines stack up as a matched pair.
  function widestLineWidth(nodes) {
    let width = 0;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (r.width > width && r.height) width = r.width;
    }
    return width;
  }

  // Union of the rendered caption lines, in viewport coordinates, or null when
  // nothing is on screen. content.js parks the translation just under `bottom`
  // so the two read as one block instead of floating at a fixed height while
  // the player's own strip moves with the number of lines it is showing.
  // Viewport coordinates, not container-relative: only content.js knows which
  // element it hung the overlay on, so it does the conversion.
  function captionBox(nodes) {
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
    }
    return bottom > -Infinity ? { top, bottom, left, right } : null;
  }

  // ---------- drawing into the player's own caption ----------
  //
  // The translation is added as one more line inside the player's own caption,
  // cloned from a line the player just drew. Cloning rather than building means
  // it arrives with that player's classes and inline styles, so it inherits the
  // font, the size the player scales with the window, the background and the
  // speaker colour — and it moves with the caption because it *is* part of the
  // caption rather than a second layer tracking it.
  //
  // One line per cue matters when two people are talking: the player draws
  // their lines in different colours, and a single merged translation line
  // would both run the sentences together and pick only one of the colours.
  //
  // Everything a player has in common ends up here; an adapter supplies only
  // `models()`, the lines that player is drawing right now.

  const INLINE_ATTR = "data-yds-inline";
  // Everything that reads "what is the player showing" has to skip our line,
  // or the translation gets read back as if it were more original text.
  const notOurs = (n) => !n.closest(`[${INLINE_ATTR}]`);

  // A cloned line can hold several styled runs. Keep the first chain so there
  // is exactly one place to write, and one colour rather than a blend.
  function pruneToSingleChain(el) {
    let node = el;
    while (node.children.length) {
      for (let i = node.children.length - 1; i >= 1; i--) node.children[i].remove();
      node = node.children[0];
    }
  }

  function deepestTextHost(el) {
    let node = el;
    while (node.children.length === 1) node = node.children[0];
    return node;
  }

  // A player whose caption lines are inline boxes — Vimeo draws each one as a
  // span — would put our copy *beside* the original instead of under it, and
  // the two languages run together on one line. Forcing a block makes it a
  // second line; fit-content and auto margins keep it hugging its own text and
  // centred, the way the player's own second line looks, rather than stretching
  // a background bar across the whole caption area.
  function startsOnItsOwnLine(clone, model) {
    const display = getComputedStyle(model).display;
    if (!/^inline/.test(display)) return;
    clone.style.display = "block";
    clone.style.width = "fit-content";
    clone.style.marginLeft = "auto";
    clone.style.marginRight = "auto";
  }

  function makeInlineRenderer(models) {
    function clear() {
      for (const el of document.querySelectorAll(`[${INLINE_ATTR}]`)) el.remove();
    }

    // Returns false when there is nothing to attach to, and the caller falls
    // back to the floating overlay.
    function render(lines) {
      const texts = (Array.isArray(lines) ? lines : [lines])
        .map(t => String(t == null ? "" : t).trim())
        .filter(Boolean);
      if (!texts.length) { clear(); return false; }

      const own = models();
      if (!own.length || !own[0].parentElement) { clear(); return false; }
      const host = own[0].parentElement;

      const mine = Array.from(host.querySelectorAll(`[${INLINE_ATTR}]`));
      // The player rebuilds its caption on every cue, taking our lines with it,
      // so a count that no longer matches is the normal case, not an error.
      if (mine.length !== texts.length) {
        clear();
        for (let i = 0; i < texts.length; i++) {
          // As many translations as original lines means they pair up one to
          // one, and each can take its speaker's colour. Otherwise one sentence
          // has been wrapped across several lines, and every translation
          // follows the last of them.
          const model = texts.length === own.length ? own[i] : own[own.length - 1];
          const clone = model.cloneNode(true);
          clone.setAttribute(INLINE_ATTR, String(i));
          pruneToSingleChain(clone);
          startsOnItsOwnLine(clone, model);
          host.appendChild(clone);
        }
      }

      const ours = Array.from(host.querySelectorAll(`[${INLINE_ATTR}]`));

      // The translation belongs after everything the player is saying. Rolling
      // auto-captions append a new original line *after* ours as the words come
      // in, which leaves the translation sandwiched between two lines of
      // original — on screen the two languages interleave. Re-appending puts
      // ours back at the end; it is skipped when they are already last, because
      // this runs on every frame.
      const last = ours[ours.length - 1];
      if (last && last.nextElementSibling) {
        for (const el of ours) host.appendChild(el);
      }

      for (let i = 0; i < ours.length && i < texts.length; i++) {
        // Write into the deepest node rather than the line itself: the player
        // hangs the speaker colour on a span nested inside, and assigning to
        // the outer element's textContent would delete it along with the colour.
        const slot = deepestTextHost(ours[i]);
        if (slot.textContent !== texts[i]) slot.textContent = texts[i];
      }
      return true;
    }

    return { render, clear };
  }

  // Strip caption markup that no translator should ever see: karaoke
  // timestamps, <v Speaker> / <c.classname> / <i> tags, HTML entities.
  // Collapse runs of spaces and tabs, but keep line breaks. In captions written
  // by hand a break is usually a change of speaker, drawn in that speaker's
  // colour — flattening it is what made two people's sentences arrive as one
  // run of text with no way left to tell them apart.
  function normalizeCueWhitespace(s) {
    return String(s == null ? "" : s)
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n+ */g, "\n")
      .trim();
  }

  // ">>" is the broadcast convention for a change of speaker, and ">>>" for a
  // change of topic. It means nothing to someone reading subtitles under a
  // video, and it does not stay put: it goes to the translator as if it were
  // words and comes back sitting in front of the Chinese line too, so the
  // viewer sees it twice. Stripped where cue text is born, so the overlay, the
  // translation and the exported SRT all agree.
  function stripSpeakerMarks(text) {
    return String(text || "").replace(/(^|\s)>{2,}\s*/g, "$1").trim();
  }

  function cleanCueText(s) {
    const out = String(s || "")
      .replace(/<\d{2}:\d{2}[0-9:.]*>/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/gi, "&");
    return stripSpeakerMarks(normalizeCueWhitespace(out));
  }

  // =========================================================================
  // YouTube
  // =========================================================================

  function createYouTube(ctx) {
    // An embedded player inside another site's page. Its URL may carry the id
    // (/embed/<id>) or nothing at all, when the host page picks the video
    // through the iframe API — then only the player knows, and inject-youtube.js
    // tells us with the track list.
    const isEmbed = /^\/embed\//.test(location.pathname);
    let playerVideoId = null;

    function videoIdFromUrl() {
      const m = /[?&]v=([^&]+)/.exec(location.search);
      if (m) return m[1];
      if (!isEmbed) return null;
      // What the player says it is playing wins over the URL: the host page
      // can load another video into the same frame.
      const e = /^\/embed\/([\w-]{11})/.exec(location.pathname);
      return playerVideoId || (e && e[1]) || null;
    }

    // An embed's video is whatever the host page last loaded into it. When
    // that changes, the previous video's cues must go — they used to stay on
    // screen over the new one, because no URL changed to say so.
    function noteEmbedVideo(id) {
      if (!isEmbed || !id || id === playerVideoId) return;
      const before = videoIdFromUrl();
      playerVideoId = id;
      if (before && before !== id) ctx.videoChanged();
      else ctx.adoptVideoId();
    }

    // How long after its last word a cue may stay up. Enough to finish reading
    // it, not so long that it sits there over the next person speaking.
    const WORD_TAIL_S = 1.2;

    function parseJson3(data) {
      const cues = [];
      const events = data?.events || [];
      for (const ev of events) {
        if (!ev.segs) continue;
        const dur = (ev.dDurationMs || 0) / 1000;
        if (dur <= 0) continue;
        const start = (ev.tStartMs || 0) / 1000;
        // A line break inside a cue arrives as its own segment whose utf8 is
        // "\n". It has to survive: it is how the author marked a second speaker.
        const text = stripSpeakerMarks(
          normalizeCueWhitespace(ev.segs.map(s => s.utf8 || "").join("")));
        if (!text) continue;

        // dDurationMs is the ROLLING WINDOW, not the speech. On an
        // auto-generated track it routinely runs well past the words — the
        // first event of a video is the worst of them, claiming seven seconds
        // for a one-line sentence while the speaker has long since moved on.
        // Taken at face value it holds the opening subtitle on screen over the
        // next two sentences, which reads as the whole track lagging.
        //
        // The words themselves carry the answer: each one has a tOffsetMs from
        // the event's start, so the last of them says when this event's speech
        // actually ends. Blank segments ("\n") can carry an offset too and
        // would put it back where it was, so only real words count. A manual
        // track has no per-word offsets at all and keeps its own duration.
        let lastOff = 0;
        for (const seg of ev.segs) {
          if (seg && typeof seg.utf8 === "string" && seg.utf8.trim()
              && typeof seg.tOffsetMs === "number") {
            lastOff = seg.tOffsetMs / 1000;
          }
        }
        const end = lastOff > 0
          ? start + Math.min(dur, lastOff + WORD_TAIL_S)
          : start + dur;
        cues.push({ start, end, text });
      }
      cues.sort((a, b) => a.start - b.start);
      return ctx.coalesce(cues);
    }

    function parseSrv3(xml) {
      const cues = [];
      try {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        doc.querySelectorAll("p").forEach(p => {
          const t = parseInt(p.getAttribute("t") || "0", 10);
          const d = parseInt(p.getAttribute("d") || "0", 10);
          if (d <= 0) return;
          const text = stripSpeakerMarks(normalizeCueWhitespace(p.textContent || ""));
          if (!text) return;
          cues.push({ start: t / 1000, end: (t + d) / 1000, text });
        });
        cues.sort((a, b) => a.start - b.start);
      } catch {}
      return ctx.coalesce(cues);
    }

    function parseCaptions(raw) {
      const trimmed = (raw || "").trim();
      if (!trimmed) return [];
      if (trimmed[0] === "{") {
        try { return parseJson3(JSON.parse(trimmed)); }
        catch { return []; }
      }
      if (trimmed[0] === "<") return parseSrv3(trimmed);
      return [];
    }

    function onTimedText(e) {
      const detail = e.detail || {};
      const url = detail.url || "";
      const text = detail.text || "";

      // Skip YouTube's own auto-translated tracks; we prefer either a real
      // native track OR our own translation.
      if (/[?&]tlang=/.test(url)) {
        ctx.log("intercept: skipping tlang track");
        // The player is auto-translating, so the original never reaches us.
        // Ask it to drop the translation; it then fetches the plain track,
        // which is the one we can use. This is also the moment that matters:
        // the translation often only kicks in when CC is switched on, well
        // after the track list (the other trigger) was published.
        const s = ctx.settings() || {};
        if (s.enabled && s.secondLang) {
          window.dispatchEvent(new CustomEvent("YDS_CLEAR_AUTO_TRANSLATE", {
            detail: { languageCode: s.secondLang }
          }));
        }
        return;
      }

      // YouTube prefetches captions for autoplay / hover-preview videos.
      // Only accept the track whose v= matches the video the user is watching.
      const vMatch = /[?&]v=([^&]+)/.exec(url);
      const trackVideoId = vMatch ? vMatch[1] : null;
      // An embed never prefetches for other videos, so a caption request for
      // a different id means the host page switched video — often seen here
      // first, before the track list catches up.
      if (isEmbed && trackVideoId) noteEmbedVideo(trackVideoId);
      const pageVideoId = videoIdFromUrl();
      if (trackVideoId && pageVideoId && trackVideoId !== pageVideoId) {
        ctx.log("intercept: skipping track for other video", trackVideoId, "current", pageVideoId);
        return;
      }

      const langMatch = /[?&]lang=([^&]+)/.exec(url);
      const trackLang = langMatch ? decodeURIComponent(langMatch[1]) : "";
      const isAsr = /[?&]kind=asr/.test(url);

      const cues = parseCaptions(text);
      if (!cues.length) return;

      ctx.ingest({
        cues,
        lang: trackLang,
        isAsr,
        isNativeTarget: !isAsr && !!trackLang && ctx.langMatches(ctx.settings().secondLang, trackLang),
        key: `${trackLang}|${isAsr ? "asr" : "sub"}|${cues.length}|${cues[0].start.toFixed(3)}|${cues[cues.length - 1].end.toFixed(3)}`
      });
    }

    function ytCaptionNodes() {
      return Array.from(document.querySelectorAll(
        ".ytp-caption-window-container .caption-visual-line, .ytp-caption-window-container .ytp-caption-segment"
      )).filter(notOurs);
    }

    // The lines YouTube is drawing right now, in visual order and sharing a
    // parent. Several caption windows can be on screen at once — a positioned
    // watermark as well as the dialogue — and the dialogue is the last of them.
    function ytInlineModels() {
      let models = [];
      for (const win of document.querySelectorAll(".ytp-caption-window-container .caption-window")) {
        const usable = Array.from(win.querySelectorAll(".caption-visual-line"))
          .filter(notOurs)
          .filter(l => (l.textContent || "").trim());
        if (usable.length) models = usable;
      }
      return models;
    }

    const { render: ytRenderInline, clear: ytClearInline } = makeInlineRenderer(ytInlineModels);

    function nativeLines() {
      const captionWindows = Array.from(document.querySelectorAll(".ytp-caption-window-container .caption-window"));
      for (const win of captionWindows) {
        // Visual lines win when YouTube provides them. Asking for both them and
        // the segments nested inside them counted every line twice — invisible
        // on a one-line caption, which takes a different path below, and
        // doubling every line the moment a caption had two.
        let lineNodes = Array.from(win.querySelectorAll(".caption-visual-line")).filter(notOurs);
        if (!lineNodes.length) {
          // No line wrappers: the segments are the lines, and several of them
          // side by side make up one row. That is what the grouping below is for.
          lineNodes = Array.from(win.querySelectorAll(".ytp-caption-segment")).filter(notOurs);
        }
        if (!lineNodes.length) continue;
        const rows = [];
        for (const node of lineNodes) {
          const text = (node.textContent || "").replace(/\s+/g, " ").trim();
          const rect = node.getBoundingClientRect();
          if (!text || !rect.width || !rect.height) continue;
          const row = rows.find(r => Math.abs(r.top - rect.top) < 8);
          if (row) {
            row.parts.push({ text, left: rect.left });
            row.top = Math.min(row.top, rect.top);
          } else {
            rows.push({ top: rect.top, parts: [{ text, left: rect.left }] });
          }
        }
        const lines = rows
          .sort((a, b) => a.top - b.top)
          .map(r => r.parts.sort((a, b) => a.left - b.left).map(p => p.text).join(" ").replace(/\s+/g, " ").trim())
          .filter(Boolean);
        if (lines.length > 1) return lines;
      }

      const visualLines = Array.from(document.querySelectorAll(".captions-text .caption-visual-line"))
        .filter(notOurs)
        .map(n => (n.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (visualLines.length) return visualLines;

      const segments = Array.from(document.querySelectorAll(".ytp-caption-segment"))
        .filter(notOurs)
        .map(n => ({ text: (n.textContent || "").trim(), rect: n.getBoundingClientRect() }))
        .filter(s => s.text && s.rect.width && s.rect.height)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

      if (segments.length) {
        const rows = [];
        for (const seg of segments) {
          const row = rows.find(r => Math.abs(r.top - seg.rect.top) < 6);
          if (row) row.parts.push(seg);
          else rows.push({ top: seg.rect.top, parts: [seg] });
        }
        return rows
          .sort((a, b) => a.top - b.top)
          .map(r => r.parts.sort((a, b) => a.rect.left - b.rect.left).map(p => p.text).join(" ").replace(/\s+/g, " ").trim())
          .filter(Boolean);
      }

      for (const sel of [".ytp-caption-window-container .caption-window", ".ytp-caption-window-container"]) {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length) {
          const text = Array.from(nodes).map(n => n.textContent || "").join(" ").replace(/\s+/g, " ").trim();
          if (text) return [text];
        }
      }
      return [];
    }

    return {
      id: "youtube",
      requiresCcForTracks: true,
      // We run in every youtube.com frame now (for embeds), and youtube.com
      // has frames of its own — only the top page and players count.
      looksLikeVideoPage: () => window.top === window || isEmbed,
      getVideoId: videoIdFromUrl,
      videoTitle: () => metaContent(
        "ytd-watch-metadata h1 yt-formatted-string",
        "h1.ytd-watch-metadata",
        'meta[name="title"]',
        'meta[property="og:title"]',
        ".ytp-title-link"
      ),
      videoAuthor: () => metaContent(
        "ytd-video-owner-renderer ytd-channel-name a",
        "#owner #channel-name a",
        'span[itemprop="author"] link[itemprop="name"]',
        'link[itemprop="name"]'
      ),
      getVideoEl: () => document.querySelector("video.html5-main-video"),
      getContainer: () => document.querySelector("#movie_player") || document.querySelector(".html5-video-container"),
      isCcOn() {
        const btn = document.querySelector(".ytp-subtitles-button");
        if (btn && btn.hasAttribute("aria-pressed")) return btn.getAttribute("aria-pressed") === "true";
        // No button we recognise (the newer embed UI): the player's own answer,
        // published by inject-youtube.js.
        const fromPlayer = document.documentElement.dataset.ydsCc;
        if (fromPlayer === "1") return true;
        if (fromPlayer === "0") return false;
        return null;
      },
      nativeLines,
      // How much of the bottom of the player the controls cover right now, in
      // pixels, and 0 while they are hidden. The player lifts its own caption
      // clear of them; a subtitle we draw has to do the same, or it sits on the
      // progress bar every time someone pauses. The progress bar overhangs the
      // control strip by a few pixels, so the higher of the two tops counts.
      controlsInset() {
        const player = document.querySelector("#movie_player");
        if (!player || player.classList.contains("ytp-autohide")) return 0;
        const bar = player.querySelector(".ytp-chrome-bottom");
        if (!bar || getComputedStyle(bar).opacity === "0") return 0;
        const playerRect = player.getBoundingClientRect();
        let top = bar.getBoundingClientRect().top;
        const progress = bar.querySelector(".ytp-progress-bar-container");
        if (progress) top = Math.min(top, progress.getBoundingClientRect().top);
        return Math.max(0, playerRect.bottom - top);
      },
      nativeCaptionWidth: () => widestLineWidth(ytCaptionNodes()),
      nativeCaptionBox: () => captionBox(ytCaptionNodes()),
      // What to hide when we draw the caption ourselves. Deliberately the same
      // elements nativeLines reads: a separate selector for the container is a
      // guess, and a guess that misses leaves the player's caption on screen
      // underneath ours. These are known to be the right ones because the text
      // read out of them is correct.
      captionEls: ytCaptionNodes,
      renderInline: ytRenderInline,
      clearInline: ytClearInline,
      observeTarget: () => document.querySelector("#movie_player"),
      start() {
        injectPageScript("inject-youtube.js", "yds-inject-youtube");
        window.addEventListener("YDS_TRACK_LIST", (e) => {
          if (e.detail && e.detail.videoId) noteEmbedVideo(e.detail.videoId);
          ctx.onTrackList((e.detail && e.detail.tracks) || []);
          // YouTube remembers the caption choice across videos, so an
          // auto-translation left switched on keeps coming back on every video
          // after it — which is how one bad track request turned into "it
          // translated for me again". Ours is the same language, drawn better,
          // and two of them is never what anyone wanted. Cleared once per
          // video: re-choose it from the player's menu and it stays.
          const want = (ctx.settings() || {}).secondLang || "";
          if (want) {
            window.dispatchEvent(new CustomEvent("YDS_CLEAR_AUTO_TRANSLATE", {
              detail: { languageCode: want }
            }));
          }
        });
        window.addEventListener("YDS_TIMEDTEXT", onTimedText);
      },
      requestTrack(track) {
        window.dispatchEvent(new CustomEvent("YDS_LOAD_NATIVE_TRACK", {
          detail: { languageCode: track.languageCode }
        }));
      },
      // Nothing memoised on this side — every request goes back to the player.
      forgetLoadedCues() {},
      reset() {}
    };
  }

  // =========================================================================
  // Vimeo
  // =========================================================================

  function createVimeo(ctx) {
    let tracks = [];            // [{languageCode, kind, name, url, rawLang}]
    let configTracks = [];      // from playerConfig, published by inject-vimeo.js
    let lastSignature = "";
    let pollTimer = null;
    let probingTextTrack = false;   // true while cuesFromTextTrack owns a track mode
    const loadedKeys = new Set();

    // "en-x-autogen" is Vimeo's marker for a machine transcript.
    function normLang(code) {
      return String(code || "").replace(/-x-autogen$/i, "").trim();
    }
    function isMachine(rawLang, provenance) {
      return /-x-autogen$/i.test(rawLang || "") || provenance === "ai_generated";
    }

    function videoEl() {
      return document.querySelector(".vp-video video") || document.querySelector("video");
    }

    // ----- WebVTT -----

    function vttTime(s) {
      const parts = String(s).trim().replace(",", ".").split(":").map(Number);
      if (parts.some(n => Number.isNaN(n))) return NaN;
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return parts[0];
    }

    function parseVtt(raw) {
      const cues = [];
      const blocks = String(raw || "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
      for (const block of blocks) {
        const lines = block.split("\n").filter(l => l.trim() !== "");
        if (!lines.length) continue;
        if (/^﻿?WEBVTT/.test(lines[0])) continue;
        if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
        // An optional cue identifier can precede the timing line.
        let i = lines[0].includes("-->") ? 0 : 1;
        if (i >= lines.length || !lines[i].includes("-->")) continue;
        const m = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[i]);
        if (!m) continue;
        const start = vttTime(m[1]);
        const end = vttTime(m[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const text = cleanCueText(lines.slice(i + 1).join(" "));
        if (!text) continue;
        cues.push({ start, end, text });
      }
      cues.sort((a, b) => a.start - b.start);
      return ctx.coalesce(cues);
    }

    // ----- track discovery -----

    function domTracks() {
      const out = [];
      document.querySelectorAll("track").forEach(t => {
        const url = t.src || t.getAttribute("src") || "";
        const rawLang = t.srclang || t.getAttribute("srclang") || "";
        if (!url && !rawLang) return;
        out.push({
          url,
          rawLang,
          languageCode: normLang(rawLang),
          kind: isMachine(rawLang, "") ? "asr" : "",
          name: t.label || rawLang || ""
        });
      });
      return out;
    }

    function refreshTracks() {
      const merged = new Map();
      // playerConfig first — it is the authoritative list. DOM <track> elements
      // fill in on vimeo.com watch pages, where playerConfig isn't exposed.
      for (const t of [...configTracks, ...domTracks()]) {
        if (!t.languageCode) continue;
        const key = `${t.languageCode}|${t.kind}`;
        const prev = merged.get(key);
        if (!prev) merged.set(key, t);
        else if (!prev.url && t.url) merged.set(key, { ...prev, url: t.url });
      }
      const next = [...merged.values()];
      const signature = next.map(t => `${t.languageCode}|${t.kind}|${t.url ? 1 : 0}`).join(",");
      if (signature === lastSignature) return;
      lastSignature = signature;
      tracks = next;
      ctx.log("vimeo: tracks →", tracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(", ") || "(none)");
      ctx.onTrackList(tracks.map(t => ({ languageCode: t.languageCode, kind: t.kind, name: t.name })));
      loadSourceTrack();
    }

    // The track the viewer is actually watching, which becomes our source text:
    // whatever text track the player has switched on, else the config default,
    // else the first one we know about.
    function pickSourceTrack() {
      const v = videoEl();
      if (v && v.textTracks) {
        for (const tt of v.textTracks) {
          if (tt.mode === "disabled") continue;
          const match = tracks.find(t => t.languageCode === normLang(tt.language));
          if (match) return match;
        }
      }
      return tracks.find(t => t.isDefault) || tracks[0] || null;
    }

    function loadSourceTrack() {
      const track = pickSourceTrack();
      if (track) loadTrack(track, "source track");
    }

    // ----- cue loading -----

    async function fetchCues(track) {
      if (track.url) {
        try {
          const res = await fetch(track.url, { credentials: "omit" });
          if (res.ok) {
            const cues = parseVtt(await res.text());
            if (cues.length) return cues;
          }
          ctx.log("vimeo: vtt fetch returned", res.status, "- trying textTracks");
        } catch (e) {
          ctx.log("vimeo: vtt fetch failed, trying textTracks", e);
        }
      }
      return cuesFromTextTrack(track);
    }

    // Fallback for when the signed .vtt URL is expired or unreachable: let the
    // browser parse the track for us. Vimeo draws its own caption strip from a
    // track it keeps at mode "hidden", so nudging a disabled track to "hidden"
    // never puts text on screen — we still restore the original mode after.
    function cuesFromTextTrack(track) {
      return new Promise((resolve) => {
        const v = videoEl();
        if (!v || !v.textTracks || !v.textTracks.length) return resolve([]);
        const tt = Array.from(v.textTracks).find(t => normLang(t.language) === track.languageCode);
        if (!tt) return resolve([]);

        const originalMode = tt.mode;
        probingTextTrack = true;
        if (tt.mode === "disabled") tt.mode = "hidden";

        let waited = 0;
        const iv = setInterval(() => {
          const list = tt.cues ? Array.from(tt.cues) : [];
          waited += 200;
          if (!list.length && waited < 6000) return;
          clearInterval(iv);
          if (originalMode === "disabled" && tt.mode !== "disabled") tt.mode = "disabled";
          probingTextTrack = false;
          resolve(ctx.coalesce(
            list
              .map(c => ({ start: c.startTime, end: c.endTime, text: cleanCueText(c.text || "") }))
              .filter(c => c.text && c.end > c.start)
              .sort((a, b) => a.start - b.start)
          ));
        }, 200);
      });
    }

    async function loadTrack(track, reason) {
      const key = `${track.languageCode}|${track.kind}`;
      if (loadedKeys.has(key)) return;
      loadedKeys.add(key);
      const cues = await fetchCues(track);
      if (!cues.length) {
        loadedKeys.delete(key);   // let a later attempt retry
        ctx.log(`vimeo: no cues for ${track.languageCode} (${reason})`);
        return;
      }
      ctx.log(`vimeo: ${cues.length} cues for ${track.languageCode} (${reason})`);
      ctx.ingest({
        cues,
        lang: track.languageCode,
        isAsr: track.kind === "asr",
        isNativeTarget: track.kind !== "asr" && ctx.langMatches(ctx.settings().secondLang, track.languageCode),
        key: `${key}|${cues.length}|${cues[0].start.toFixed(3)}`
      });
    }

    // One definition of "a line", used by everything that reads or writes the
    // caption strip. Three separate notions of it is how the inline renderer
    // ended up cloning a different element from the one nativeLines counted.
    //
    // The real markup nests, and the useful styling is spread across the
    // levels — the font and size sit on .vp-captions, the background on the
    // window span inside it:
    //
    //   div.vp-captions  style="font-size:14px; font-family:…; color:…"
    //     span.CaptionsRenderer_module_captionsWindow  style="background-color:…"
    //       … the lines …
    //
    // So walking down through single-child wrappers is not an optimisation, it
    // is the only way to reach the level where the lines actually are. Class
    // names are no help: every one of them is hashed per build.
    const hasText = (el) => !!(el.textContent || "").trim();
    const hasOwnText = (el) =>
      Array.from(el.childNodes).some(n => n.nodeType === 3 && (n.textContent || "").trim());

    function vimeoLineEls() {
      const cap = document.querySelector(".vp-captions");
      if (!cap) return [];

      // Down to the box that holds the lines. Descend past a lone child only
      // while that child is itself a container — an element with element
      // children. A lone child that holds only text is already the line, and
      // stepping into it would make us clone the span inside a line instead of
      // the line itself.
      let box = cap;
      for (let depth = 0; depth < 6; depth++) {
        const kids = Array.from(box.children).filter(notOurs);
        if (kids.length !== 1 || hasOwnText(box)) break;
        if (!Array.from(kids[0].children).some(hasText)) break;
        box = kids[0];
      }

      const lines = Array.from(box.children).filter(notOurs).filter(hasText);
      if (lines.length) return lines;
      // The box writes its text directly: it is the line, and a clone of it
      // beside it carries the background the player put there.
      return hasText(box) && notOurs(box) ? [box] : [];
    }

    // For measuring: the lines if there are any, else the strip itself — a
    // strip holding nothing but our own line measures as nothing.
    function vimeoCaptionNodes() {
      const lines = vimeoLineEls();
      if (lines.length) return lines;
      const cap = document.querySelector(".vp-captions");
      return cap && notOurs(cap) && (cap.textContent || "").trim() ? [cap] : [];
    }

    const { render: vimeoRenderInline, clear: vimeoClearInline } =
      makeInlineRenderer(vimeoLineEls);

    function nativeLines() {
      const lines = vimeoLineEls()
        .map(n => (n.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (lines.length) return lines;
      // The strip renders text directly, with no line elements to read. Take
      // its text minus anything we put there.
      const cap = document.querySelector(".vp-captions");
      if (!cap) return [];
      const ours = Array.from(cap.querySelectorAll(`[${INLINE_ATTR}]`));
      const text = Array.from(cap.childNodes)
        .filter(n => !ours.some(o => o === n || o.contains(n)))
        .map(n => n.textContent || "").join(" ")
        .replace(/\s+/g, " ").trim();
      return text ? [text] : [];
    }

    return {
      id: "vimeo",
      // Vimeo hands us signed .vtt URLs, so we never need the viewer to turn
      // CC on before we can pull a track.
      requiresCcForTracks: false,
      looksLikeVideoPage() {
        // Skips helper frames like player.vimeo.com/static/proxy.html.
        return /^\/(video\/)?\d{6,}/.test(location.pathname)
            || /\/(?:channels|groups|album|showcase)\/[^/]+\/(?:videos\/)?\d{6,}/.test(location.pathname)
            || !!document.querySelector(".vp-video-wrapper, .player.js-player");
      },
      getVideoId() {
        // vimeo.com/859881652/37578b4a4e, player.vimeo.com/video/859881652,
        // vimeo.com/channels/staffpicks/859881652 — take the first long number.
        const seg = location.pathname.split("/").find(s => /^\d{6,}$/.test(s));
        return seg || null;
      },
      videoTitle: () => metaContent(
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
        "h1"
      ),
      videoAuthor: () => metaContent(
        '[data-test-id="ownership-owner-name"]',
        'meta[name="author"]',
        'link[itemprop="name"]'
      ),
      getVideoEl: videoEl,
      getContainer() {
        return document.querySelector(".vp-video-wrapper")
            || document.querySelector(".player.js-player")
            || document.querySelector(".player");
      },
      isCcOn() {
        const btn = document.querySelector("#cc-control-bar-button, [data-cc-button], button.cc");
        if (btn && btn.hasAttribute("aria-pressed")) return btn.getAttribute("aria-pressed") === "true";
        // No control bar to read — an embed configured without controls, or a
        // markup change. The player's own track state says the same thing:
        // measured on a live player, captions closed leaves every track
        // "disabled", and opening them puts the active one at "hidden"
        // (Vimeo draws the strip itself rather than letting the browser do it).
        if (probingTextTrack) return null;      // we moved a mode ourselves; don't read it
        const v = videoEl();
        if (v && v.textTracks && v.textTracks.length) {
          return Array.from(v.textTracks).some(t => t.mode !== "disabled");
        }
        return null;
      },
      nativeLines,
      nativeCaptionWidth: () => widestLineWidth(vimeoCaptionNodes()),
      nativeCaptionBox: () => captionBox(vimeoCaptionNodes()),
      captionEls: vimeoCaptionNodes,
      renderInline: vimeoRenderInline,
      clearInline: vimeoClearInline,
      observeTarget() {
        return document.querySelector(".vp-video-wrapper") || document.querySelector(".player");
      },
      start() {
        injectPageScript("inject-vimeo.js", "yds-inject-vimeo");
        window.addEventListener("YDS_VIMEO_TRACKS", (e) => {
          const list = (e.detail && e.detail.tracks) || [];
          configTracks = list.map(t => ({
            url: t.url || "",
            rawLang: t.lang || "",
            languageCode: normLang(t.lang),
            kind: isMachine(t.lang, t.provenance) ? "asr" : "",
            name: t.label || t.lang || "",
            isDefault: !!t.isDefault
          }));
          refreshTracks();
        });
        // The <track> elements appear once the player boots, and the viewer can
        // switch tracks at any time, so keep looking. The check is one cheap
        // querySelectorAll per second.
        refreshTracks();
        if (!pollTimer) pollTimer = setInterval(refreshTracks, 1000);
      },
      requestTrack(plain) {
        const track = tracks.find(t => t.languageCode === plain.languageCode && t.kind === plain.kind);
        if (track) loadTrack(track, "native target requested");
      },
      // Target language changed: drop the "already fetched" memo so a track we
      // pulled as source text can be pulled again as the target. Keeps the
      // track list, so the next poll re-offers it within a second.
      forgetLoadedCues() {
        loadedKeys.clear();
        lastSignature = "";
      },
      reset() {
        tracks = [];
        configTracks = [];
        lastSignature = "";
        loadedKeys.clear();
      }
    };
  }

  // =========================================================================

  // =========================================================================
  // Bilibili
  // =========================================================================
  //
  // A third way of getting captions, different again from the other two.
  // Bilibili publishes a per-video subtitle index through its own web API
  // rather than putting <track> elements in the page or making the player
  // fetch anything we could intercept, so we ask the API directly and then
  // fetch the track's JSON. Both calls need the viewer's cookies, which is why
  // they run here in the content script rather than anywhere else.
  //
  // Note the subtitle index is usually empty for logged-out viewers — that is
  // the site's behaviour, not a failure on our side. A video with no track at
  // all is exactly the case live transcription exists for.

  function createBilibili(ctx) {
    let tracks = [];          // [{languageCode, kind, name, url}]
    let lastSignature = "";
    let loadTimer = null;
    const loadedKeys = new Set();

    function videoEl() {
      return document.querySelector("#bilibili-player video")
          || document.querySelector(".bpx-player-video-wrap video")
          || document.querySelector("video");
    }

    // BV id plus the part number, so multi-part videos count as separate videos.
    function videoKey() {
      const params = new URL(location.href).searchParams;
      // A BV id is the identity when there is one; otherwise fall back to
      // whatever the URL does identify, so bangumi and festival pages still
      // count as distinct videos rather than as "no video at all".
      const bv = (location.pathname.match(/\/video\/(BV\w+|av\d+)/) || [])[1]
              || (location.pathname.match(/\/bangumi\/play\/(\w+)/) || [])[1]
              || params.get("bvid")
              || (/\/(festival|list)\//.test(location.pathname) ? location.pathname : null);
      if (!bv) return null;
      const p = params.get("p");
      return p && p !== "1" ? `${bv}#p${p}` : bv;
    }

    async function json(url) {
      const r = await fetch(url, { credentials: "include" });
      return r.json();
    }

    // Two hops: the view endpoint gives the cid for this part, the player
    // endpoint gives that part's subtitle list.
    async function fetchTracks() {
      // The subtitle API is keyed by BV id. Bangumi and festival pages don't
      // expose one in the path, so there are no tracks to look up — live
      // transcription is the answer there.
      const bv = (location.pathname.match(/\/video\/(BV\w+)/) || [])[1]
              || new URL(location.href).searchParams.get("bvid");
      if (!bv) return [];
      const view = await json(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
      let cid = view && view.data && view.data.cid;
      const part = Number(new URL(location.href).searchParams.get("p")) || 1;
      const pages = view && view.data && view.data.pages;
      if (pages && pages[part - 1]) cid = pages[part - 1].cid;
      if (!cid) return [];

      const player = await json(`https://api.bilibili.com/x/player/v2?bvid=${bv}&cid=${cid}`);
      const subs = (player && player.data && player.data.subtitle && player.data.subtitle.subtitles) || [];
      return subs.map(sub => {
        let url = String(sub.subtitle_url || "");
        if (url.startsWith("//")) url = "https:" + url;
        url = url.replace(/^http:/, "https:");
        const lan = String(sub.lan || "");
        return {
          url,
          // "ai-zh" marks machine transcription; strip the prefix but keep the
          // rest of the code ("zh-CN", "en-US") so Hans/Hant still separate.
          languageCode: lan.replace(/^ai-/, ""),
          kind: /^ai-/.test(lan) ? "asr" : "",
          name: String(sub.lan_doc || lan)
        };
      }).filter(t => t.url && t.languageCode);
    }

    async function refreshTracks() {
      let next = [];
      try {
        next = await fetchTracks();
      } catch (e) {
        ctx.log("bilibili: subtitle index unavailable", e);
        return;
      }
      const signature = next.map(t => `${t.languageCode}|${t.kind}`).join(",");
      if (signature === lastSignature) return;
      lastSignature = signature;
      tracks = next;
      ctx.log("bilibili: tracks →", tracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(", ") || "(none)");
      ctx.onTrackList(tracks.map(t => ({ languageCode: t.languageCode, kind: t.kind, name: t.name })));
    }

    async function loadTrack(track, reason) {
      const key = `${track.languageCode}|${track.kind}`;
      if (loadedKeys.has(key)) return;
      loadedKeys.add(key);
      let data;
      try {
        data = await json(track.url);
      } catch (e) {
        loadedKeys.delete(key);
        ctx.log(`bilibili: could not fetch ${track.languageCode}`, e);
        return;
      }
      // Bilibili's format: { body: [{ from, to, content }] }, times in seconds.
      const cues = ((data && data.body) || [])
        .map(c => ({
          start: Number(c.from) || 0,
          end: Number(c.to) || 0,
          text: cleanCueText(c.content || "")
        }))
        .filter(c => c.text && c.end > c.start)
        .sort((a, b) => a.start - b.start);
      if (!cues.length) {
        loadedKeys.delete(key);
        return;
      }
      ctx.log(`bilibili: ${cues.length} cues for ${track.languageCode} (${reason})`);
      ctx.ingest({
        cues: ctx.coalesce(cues),
        lang: track.languageCode,
        isAsr: track.kind === "asr",
        key: `${key}|${cues.length}|${cues[0].start.toFixed(3)}`
      });
    }

    // Bilibili renders the caption as one block; the inner spans are the
    // individual lines when it has split them.
    function biliCaptionNodes() {
      const el = subtitleEl();
      if (!el) return [];
      const inner = el.querySelectorAll("span, div");
      return inner.length ? inner : [el];
    }

    function subtitleEl() {
      return document.querySelector(".bpx-player-subtitle-panel-wrap")
          || document.querySelector(".bpx-player-subtitle-wrap")
          || document.querySelector(".bilibili-player-video-subtitle");
    }

    return {
      id: "bilibili",
      // We pull tracks straight from the API, so the player's own subtitle
      // switch has no say in whether we can get them.
      requiresCcForTracks: false,
      looksLikeVideoPage() {
        // /video/BV… is the common one, but the same player also serves
        // bangumi episodes, festival pages and playlist views.
        return /\/video\/(BV\w+|av\d+)/.test(location.pathname)
            || /\/(bangumi\/play|festival|list)\//.test(location.pathname);
      },
      getVideoId: videoKey,
      videoTitle: () => metaContent(
        "h1.video-title",
        ".video-title",
        'meta[property="og:title"]',
        'meta[name="title"]'
      ),
      videoAuthor: () => metaContent(
        ".up-name",
        ".up-info--name",
        'meta[itemprop="author"]',
        'meta[name="author"]'
      ),
      getVideoEl: videoEl,
      getContainer() {
        const v = videoEl();
        if (!v) return null;
        return v.closest(".bpx-player-video-area")
            || v.closest("#bilibili-player")
            || v.parentElement;
      },
      isCcOn() {
        const el = subtitleEl();
        if (!el) return false;
        // The panel stays in the DOM with the switch off, so presence alone
        // proves nothing — go by whether it is actually showing anything.
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        return !!(el.innerText || "").trim();
      },
      nativeLines() {
        const el = subtitleEl();
        if (!el) return [];
        const text = (el.innerText || "").replace(/\s+/g, " ").trim();
        return text ? [text] : [];
      },
      nativeCaptionWidth: () => widestLineWidth(biliCaptionNodes()),
      nativeCaptionBox: () => captionBox(biliCaptionNodes()),
      captionEls: biliCaptionNodes,
      observeTarget() {
        return document.querySelector("#bilibili-player") || document.body;
      },
      start() {
        refreshTracks();
        // Bilibili is a SPA and the index only appears once the player boots;
        // a slow re-check also picks up a part switch on multi-part videos.
        if (!loadTimer) loadTimer = setInterval(refreshTracks, 3000);
      },
      requestTrack(plain) {
        const track = tracks.find(t => t.languageCode === plain.languageCode && t.kind === plain.kind);
        if (track) loadTrack(track, "requested");
      },
      forgetLoadedCues() {
        loadedKeys.clear();
        lastSignature = "";
      },
      reset() {
        tracks = [];
        lastSignature = "";
        loadedKeys.clear();
      }
    };
  }

  // ---------- Zoom (cloud recordings) ----------
  //
  // The recording player (*.zoom.us/rec/play/…, /rec/share/…) boots by asking
  // /nws/recording/1.0/play/info/<id> for everything about the clip, and that
  // JSON already carries the whole audio transcript as transcriptList —
  // [{ts, end_ts, text, username}] with "HH:MM:SS.mmm" times. The info id is
  // not the one in the page URL, so rather than derive it we read the URL the
  // player itself requested off the resource timing buffer, then fetch it
  // again with the viewer's cookies. No main-world patching needed.
  //
  // There is exactly one track: whatever the host's audio transcript is. A
  // recording without "Audio transcript" enabled has an empty list, which is
  // the case live transcription is for.

  function createZoom(ctx) {
    let infoUrl = "";
    let track = null;         // {languageCode, kind, name, cues}
    let pollTimer = null;
    let loaded = false;
    // The transcript as Zoom wrote it: one entry per paragraph of its side
    // panel, with who said it. Kept apart from the cues, which content.js
    // re-cuts into display-sized sentences and so loses both.
    let entries = [];         // [{start, end, text, speaker}]
    let entryTexts = new Set();
    let panelRoot = null;

    function videoEl() {
      return document.querySelector(".video-js video") || document.querySelector("video");
    }

    function videoKey() {
      const m = location.pathname.match(/\/rec\/(?:play|share)\/([^/?#]+)/);
      return m ? m[1] : null;
    }

    function findInfoUrl() {
      try {
        const hit = performance.getEntriesByType("resource")
          .map(e => e.name)
          .find(n => n.includes("/nws/recording/1.0/play/info/"));
        return hit || "";
      } catch {
        return "";
      }
    }

    function tsSeconds(s) {
      const m = String(s || "").match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return NaN;
      return (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }

    // Zoom does not say what language the transcript is in. It is English far
    // more often than not, so only switch away when the script says otherwise.
    function guessLang(cues) {
      const sample = cues.slice(0, 80).map(c => c.text).join("");
      const count = re => (sample.match(re) || []).length;
      const total = sample.replace(/\s/g, "").length || 1;
      if (count(/[぀-ヿ]/g) / total > 0.05) return "ja";
      if (count(/[가-힯]/g) / total > 0.2) return "ko";
      if (count(/[一-鿿]/g) / total > 0.2) return "zh";
      return "en";
    }

    async function loadInfo() {
      const url = findInfoUrl();
      if (!url || url === infoUrl) return;
      infoUrl = url;
      let data;
      try {
        const r = await fetch(url, { credentials: "include" });
        data = await r.json();
      } catch (e) {
        infoUrl = "";
        ctx.log("zoom: play/info unavailable", e);
        return;
      }
      const list = (data && data.result && data.result.transcriptList) || [];
      entries = list
        .map(x => ({
          start: tsSeconds(x.ts),
          end: tsSeconds(x.end_ts),
          text: normPanelText(x.text),
          speaker: String(x.username || "").trim()
        }))
        .filter(e => e.text && e.end > e.start)
        .sort((a, b) => a.start - b.start);
      // Who is speaking is written into the text, not the username field:
      // where the voice changes, Zoom starts the entry with "name: " (the
      // username field stayed on the recording's owner throughout a lecture
      // with three speakers). The label is the speaker from there until the
      // next one, and it is not something to show or translate as subtitle.
      let speaking = "";
      for (const e of entries) {
        const m = SPEAKER_LABEL.exec(e.text);
        if (m) {
          speaking = m[1].trim();
          e.spoken = e.text.slice(m[0].length).trim();
        } else {
          e.spoken = e.text;
        }
        if (speaking) e.speaker = speaking;
      }
      // The panel may show a paragraph with or without its label.
      entryTexts = new Set();
      for (const e of entries) { entryTexts.add(e.text); entryTexts.add(e.spoken); }
      panelRoot = null;
      const cues = entries
        .map(e => ({ start: e.start, end: e.end, text: cleanCueText(e.spoken) }))
        .filter(c => c.text);
      if (!cues.length) {
        ctx.log("zoom: no audio transcript on this recording");
        ctx.onTrackList([]);
        return;
      }
      const languageCode = guessLang(cues);
      track = { languageCode, kind: "asr", name: "Audio transcript", cues };
      loaded = false;
      ctx.log(`zoom: ${cues.length} transcript cues (${languageCode})`);
      ctx.onTrackList([{ languageCode, kind: "asr", name: track.name }]);
      // content.js only asks for a track when it is already in the target
      // language. The transcript is the only source there is, so hand it over
      // now, the way Vimeo does with its source track.
      ingestTrack("transcript");
    }

    // "Robertas Gabrys: ", "irwin: ", "workshop@iu.edu: " — up to three
    // words with no sentence punctuation, then a colon, at the very start.
    const SPEAKER_LABEL = /^([^\s:,.!?…]+(?: [^\s:,.!?…]+){0,2}): (?=\S)/;

    function normPanelText(s) {
      return String(s || "").replace(/\s+/g, " ").trim();
    }

    // The paragraphs of Zoom's "Audio Transcript" panel. Found by their text,
    // not Zoom's class names, which are build hashes and change without notice:
    // an element whose own text is exactly one transcript entry is a paragraph.
    // The first full-page scan settles on the panel's root, and later scans
    // stay inside it.
    function panelParagraphs() {
      if (!entryTexts.size) return [];
      const scope = (panelRoot && panelRoot.isConnected) ? panelRoot : document.body;
      const found = [];
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || seen.has(el) || el.closest(".yds-overlay, .yds-panel-tr, .yds-panel-hint, video")) continue;
        seen.add(el);
        const text = normPanelText(ownPanelText(el));
        if (text && entryTexts.has(text)) found.push({ el, text });
      }
      if (scope === document.body && found.length >= 2) {
        // Lowest element holding the first two paragraphs: the panel's list.
        let root = found[0].el.parentElement;
        while (root && !root.contains(found[1].el)) root = root.parentElement;
        panelRoot = root || null;
      }
      return found;
    }

    // The paragraph's text without the translation line content.js puts
    // inside it — otherwise a paragraph stops matching the moment it has one.
    function ownPanelText(el) {
      let out = "";
      for (const n of el.childNodes) {
        if (n.nodeType === 1 && (n.classList.contains("yds-panel-tr") || n.classList.contains("yds-panel-hint"))) continue;
        out += n.textContent;
      }
      return out;
    }

    function speakerAt(t) {
      let lo = 0, hi = entries.length - 1, hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].start <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return hit >= 0 ? entries[hit].speaker : "";
    }

    function ingestTrack(reason) {
      if (!track || loaded) return;
      loaded = true;
      ctx.log(`zoom: ingest ${track.cues.length} cues (${reason})`);
      ctx.ingest({
        cues: ctx.coalesce(track.cues),
        lang: track.languageCode,
        isAsr: true,
        key: `zoom|${track.languageCode}|${track.cues.length}|${track.cues[0].start.toFixed(3)}`
      });
    }

    // Video.js draws captions into .vjs-text-track-display; Zoom's own CC
    // overlay lives inside the same player box under its own class names.
    function zoomCaptionNodes() {
      const root = videoEl() && videoEl().closest(".video-js");
      if (!root) return [];
      const nodes = root.querySelectorAll(
        ".vjs-text-track-display .vjs-text-track-cue > div, [class*='caption'] span, [class*='subtitle'] span"
      );
      return [...nodes].filter(n => (n.innerText || "").trim() && !n.closest(".vjs-modal-dialog"));
    }

    return {
      id: "zoom",
      // The transcript arrives with the page, CC button or not.
      requiresCcForTracks: false,
      looksLikeVideoPage: () => /\/rec\/(play|share)\//.test(location.pathname),
      getVideoId: videoKey,
      // The tab title is "<topic> - Zoom".
      videoTitle: () => document.title.replace(/\s*-\s*Zoom\s*$/i, "").trim(),
      videoAuthor: () => "",
      getVideoEl: videoEl,
      getContainer() {
        const v = videoEl();
        if (!v) return null;
        return v.closest(".video-js") || v.parentElement;
      },
      isCcOn() {
        return zoomCaptionNodes().length > 0;
      },
      nativeLines() {
        return zoomCaptionNodes()
          .map(n => (n.innerText || "").replace(/\s+/g, " ").trim())
          .filter(Boolean);
      },
      // Zoom's control bar is video.js's own, floating over the bottom of the
      // picture; video.js fades it out (opacity 0) while playing untouched.
      controlsInset() {
        const v = videoEl();
        const root = v && v.closest(".video-js");
        if (!root) return 0;
        const bar = root.querySelector(".vjs-control-bar");
        if (!bar) return 0;
        const cs = getComputedStyle(bar);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return 0;
        let top = bar.getBoundingClientRect().top;
        const progress = bar.querySelector(".vjs-progress-control");
        if (progress) top = Math.min(top, progress.getBoundingClientRect().top);
        return Math.max(0, root.getBoundingClientRect().bottom - top);
      },
      nativeCaptionWidth: () => widestLineWidth(zoomCaptionNodes()),
      nativeCaptionBox: () => captionBox(zoomCaptionNodes()),
      captionEls: zoomCaptionNodes,
      // Optional extras content.js uses when an adapter has them: who is
      // speaking at a time (for the exported transcript), and the side panel's
      // paragraphs (to put a translation under each).
      speakerAt,
      transcriptPanelItems: panelParagraphs,
      observeTarget() {
        const v = videoEl();
        return (v && v.closest(".video-js")) || document.body;
      },
      start() {
        loadInfo();
        if (!pollTimer) pollTimer = setInterval(loadInfo, 1500);
      },
      requestTrack(plain) {
        if (track && plain.languageCode === track.languageCode) ingestTrack("requested");
      },
      forgetLoadedCues() {
        loaded = false;
      },
      reset() {
        infoUrl = "";
        track = null;
        loaded = false;
        entries = [];
        entryTexts = new Set();
        panelRoot = null;
      }
    };
  }

  // ---------- any other page ----------
  //
  // Not declared in the manifest: the popup injects us through activeTab when
  // the viewer opens it on a page with a <video> that no adapter above claims —
  // a course site, a news player, a local .mp4 opened as file://.
  //
  // Captions, when the page has them, come from the standard place: the
  // video's TextTrack list, fed by <track> elements or added by the player in
  // script. Coursera, edX, TED and most news and course players use it. The
  // browser has already fetched and parsed the file, so we read cues straight
  // off the track — no URL, no CORS, no format to parse. Players that draw
  // captions from their own data without a TextTrack are not covered; live
  // transcription is the answer there, as it is for a page with no captions.
  //
  // "Somewhere to draw" is the hard part. A strange page's video has no known
  // positioned wrapper, and Chrome's own file viewer puts the <video> straight
  // in a flex-centred <body>. Rather than restyle someone else's DOM we lay a
  // fixed, click-through box exactly over the video and keep it there.
  //

  function createGeneric(ctx) {
    let stage = null;
    let follow = 0;
    let current = null;
    let trackTimer = null;
    let lastSignature = "";
    const loadedKeys = new Set();
    // Tracks we switched from "disabled" to "hidden" ourselves, to get their
    // cues loaded. Their mode says nothing about whether the viewer wants
    // captions, so isCcOn ignores them.
    const ourHidden = new WeakSet();
    let cuesHidden = false;

    function captionTracks(v) {
      if (!v || !v.textTracks) return [];
      return [...v.textTracks].filter(t => t.kind === "subtitles" || t.kind === "captions");
    }

    function plain(t) {
      return { languageCode: t.language || "", kind: "", name: t.label || t.language || "" };
    }

    // The one the viewer is watching beats the page's default. With neither
    // — the site's captions are off, and we are reading a track by ourselves
    // — it has to be a guess at the language being spoken: the page's own
    // language, then English, then whatever is first. Never the viewer's
    // target language: that one is a translation to show, not a source.
    function sourceTrack(v) {
      const list = captionTracks(v);
      if (!list.length) return null;
      const els = v ? [...v.querySelectorAll("track")] : [];
      const defaultTrack = (els.find(e => e.default) || {}).track;
      const showing = list.find(t => t.mode === "showing");
      if (showing) return showing;
      if (defaultTrack && list.includes(defaultTrack)) return defaultTrack;
      const target = (ctx.settings() || {}).secondLang || "";
      const usable = list.filter(t => !(t.language && ctx.langMatches(target, t.language)));
      const pool = usable.length ? usable : list;
      const pageLang = (document.documentElement.lang || "").split("-")[0].toLowerCase();
      const byLang = (code) => code && pool.find(t => (t.language || "").toLowerCase().split("-")[0] === code);
      return byLang(pageLang) || byLang("en") || pool[0];
    }

    // A disabled track never loads its cues; hidden loads them without
    // drawing. Cues can also still be on their way, so poll briefly.
    async function cuesOf(t) {
      if (t.mode === "disabled") {
        t.mode = "hidden";
        ourHidden.add(t);
      }
      for (let i = 0; i < 20 && !(t.cues && t.cues.length); i++) {
        await new Promise(r => setTimeout(r, 250));
      }
      return t.cues ? [...t.cues] : [];
    }

    async function loadTrack(t, reason) {
      const key = `${t.language}|${t.label}|${t.cues ? t.cues.length : 0}`;
      if (loadedKeys.has(key)) return;
      loadedKeys.add(key);
      const raw = await cuesOf(t);
      const cues = raw
        .map(c => ({
          start: c.startTime,
          end: c.endTime,
          // VTTCue.text keeps markup (<i>, <c.color>, voice tags); the
          // shared cleaner strips it the same way it does for other sites.
          text: cleanCueText(c.text || "")
        }))
        .filter(c => c.text && c.end > c.start)
        .sort((a, b) => a.start - b.start);
      if (!cues.length) {
        loadedKeys.delete(key);
        return;
      }
      const lang = t.language || "";
      ctx.log(`generic: ${cues.length} cues from track ${lang || "(no lang)"} (${reason})`);
      ctx.ingest({
        cues: ctx.coalesce(cues),
        lang,
        isAsr: false,
        isNativeTarget: !!lang && ctx.langMatches(ctx.settings().secondLang, lang),
        key: `generic|${lang}|${cues.length}|${cues[0].start.toFixed(3)}`
      });
    }

    function refreshTracks() {
      const v = videoEl();
      const list = captionTracks(v);
      const signature = list.map(t => `${t.language}|${t.label}`).join(",");
      if (signature !== lastSignature) {
        lastSignature = signature;
        ctx.log("generic: tracks →", signature || "(none)");
        ctx.onTrackList(list.map(plain));
      }
      // content.js only asks for a track already in the target language, so
      // the source is ours to load — the same arrangement as Vimeo.
      const src = sourceTrack(v);
      if (src) loadTrack(src, "source");
    }

    // The video worth subtitling: one that is playing beats one that is not,
    // then the biggest on screen. Re-picked every frame, so starting a second
    // video on the page moves the subtitle to it.
    function videoEl() {
      const vids = [...document.querySelectorAll("video")].filter(v => {
        const r = v.getBoundingClientRect();
        return r.width > 80 && r.height > 60;
      });
      if (!vids.length) return null;
      const score = v => {
        const r = v.getBoundingClientRect();
        return (v.paused ? 0 : 1e9) + r.width * r.height;
      };
      return vids.sort((a, b) => score(b) - score(a))[0];
    }

    // The box is a manual popover, which puts it in the browser's top layer.
    // That is what keeps the subtitle visible in fullscreen: a fullscreen
    // element hides everything outside itself except other top-layer
    // elements, and a <video> cannot have children to draw inside it. The top
    // layer stacks in the order things entered it, so the box is re-shown
    // after every fullscreen change to sit above the new fullscreen element.
    function raiseStage() {
      if (!stage || typeof stage.showPopover !== "function") return;
      try { if (stage.matches(":popover-open")) stage.hidePopover(); } catch {}
      try { stage.showPopover(); } catch {}
    }

    function ensureStage() {
      if (stage && stage.isConnected) return stage;
      stage = document.createElement("div");
      stage.id = "yds-generic-stage";
      stage.setAttribute("popover", "manual");
      // The browser's popover defaults (centred, bordered, opaque, clipped)
      // are all undone here; what is left is a transparent positioning box.
      stage.style.cssText =
        "position:fixed;left:0;top:0;right:auto;bottom:auto;width:0;height:0;" +
        "margin:0;padding:0;border:0;background:transparent;color:inherit;" +
        "pointer-events:none;z-index:2147483646;overflow:visible;";
      (document.body || document.documentElement).appendChild(stage);
      raiseStage();
      document.addEventListener("fullscreenchange", raiseStage);
      return stage;
    }

    function track() {
      follow = requestAnimationFrame(track);
      const v = videoEl();
      if (!v || !stage) return;
      current = v;
      const r = v.getBoundingClientRect();
      const s = stage.style;
      const next = [r.left, r.top, r.width, r.height].map(n => `${Math.round(n)}px`);
      if (s.left !== next[0]) s.left = next[0];
      if (s.top !== next[1]) s.top = next[1];
      if (s.width !== next[2]) s.width = next[2];
      if (s.height !== next[3]) s.height = next[3];
    }

    return {
      id: "generic",
      requiresCcForTracks: false,
      looksLikeVideoPage: () => !!document.querySelector("video"),
      // Per page, not per video: there is no id to read, and the URL is what
      // separates one local file from the next.
      getVideoId: () => location.href.split("#")[0],
      videoTitle() {
        const t = document.title || "";
        if (t) return t;
        // file:// viewer: the title is empty, the file name is the identity.
        return decodeURIComponent(location.pathname.split("/").pop() || "");
      },
      videoAuthor: () => "",
      getVideoEl: () => current || videoEl(),
      getContainer() {
        if (!videoEl()) return null;
        return ensureStage();
      },
      // "On" whenever the video has a caption track at all. Elsewhere the
      // overlay follows the player's CC button, so that closing captions
      // closes ours too. Here there is no button we know how to read or
      // press, and the viewer turned the extension on for this page by hand:
      // making them also find the site's own caption menu before anything
      // shows was a second step with no purpose. We can load the track
      // ourselves, so we do, and the extension's own switch is the off.
      isCcOn() {
        return captionTracks(current || videoEl()).length > 0;
      },
      nativeLines() {
        const t = captionTracks(current || videoEl()).find(x => x.mode === "showing");
        if (!t || !t.activeCues) return [];
        return [...t.activeCues].map(c => cleanCueText(c.text || "")).filter(Boolean);
      },
      nativeCaptionWidth: () => 0,
      nativeCaptionBox: () => null,
      captionEls: () => [],
      // The browser draws <track> captions itself, outside the DOM, so there
      // is no element to hide; ::cue is the one handle on them (overlay.css).
      hideNativeCues(on) {
        const v = current || videoEl();
        if (!v || cuesHidden === on) return;
        cuesHidden = on;
        v.classList.toggle("yds-hide-cues", on);
      },
      observeTarget: () => document.body,
      start() {
        ensureStage();
        if (!follow) track();
        refreshTracks();
        // Players add their tracks after metadata loads, or on first play.
        if (!trackTimer) trackTimer = setInterval(refreshTracks, 2000);
      },
      requestTrack(want) {
        const t = captionTracks(current || videoEl())
          .find(x => x.language === want.languageCode && (x.label || x.language) === want.name)
          || captionTracks(current || videoEl()).find(x => x.language === want.languageCode);
        if (t) loadTrack(t, "requested");
      },
      forgetLoadedCues() {
        loadedKeys.clear();
        lastSignature = "";
      },
      reset() {
        current = null;
        loadedKeys.clear();
        lastSignature = "";
      }
    };
  }

  // =========================================================================

  window.YDS_PLATFORMS = {
    detect() {
      const h = location.hostname;
      if (/(^|\.)youtube(-nocookie)?\.com$/.test(h)) return "youtube";
      if (/(^|\.)vimeo\.com$/.test(h)) return "vimeo";
      if (/(^|\.)bilibili\.com$/.test(h)) return "bilibili";
      // Only recordings: the rest of zoom.us (the web client, the dashboard)
      // has nothing for the Zoom adapter and falls through to generic.
      if (/(^|\.)zoom\.us$/.test(h) && /\/rec\/(play|share)\//.test(location.pathname)) return "zoom";
      // Set by the popup right before it injects us through activeTab. Last,
      // so a site we know but have not been granted yet (Zoom, before the
      // viewer allows it) still gets its own adapter when injected by hand.
      if (window.YDS_FORCE_GENERIC) return "generic";
      return null;
    },
    create(id, ctx) {
      if (id === "youtube") return createYouTube(ctx);
      if (id === "vimeo") return createVimeo(ctx);
      if (id === "bilibili") return createBilibili(ctx);
      if (id === "zoom") return createZoom(ctx);
      if (id === "generic") return createGeneric(ctx);
      return null;
    }
  };
})();
