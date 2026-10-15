// Live transcription client.
//
// The other caption sources in this extension are *tracks*: a whole timed file,
// fetched once, translated up front. This one is nothing like that. It taps the
// video's audio, streams it to a recognizer running on the viewer's own machine,
// and gets text back a fraction of a second later — no timestamps, just "here is
// the sentence being spoken right now" and "that sentence is finished".
//
// It exists for videos that have no captions at all, which on Bilibili is most
// of them. Nothing leaves the machine: the recognizer is a local process the
// viewer installs and runs, reached over a loopback WebSocket. With that process
// not running this whole module is inert and says so.
//
// Kept apart from platform.js on purpose — this cares only that there is a
// <video> with audio, not which site it came from.

(() => {
  const WS_URL = "ws://127.0.0.1:8765";
  const RECONNECT_MS = 3000;
  const SAMPLE_RATE = 16000;   // what the recognizer expects; the browser resamples for us
  const BUFFER_SIZE = 4096;

  const state = {
    running: false,
    ws: null,
    audioCtx: null,
    nodes: null,
    reconnectTimer: null,
    // Tab mode: the audio comes from chrome.tabCapture in the extension's
    // offscreen document (see offscreen.js), which also owns the socket. We
    // only relay start/stop/reset and receive text.
    tabMode: false,
    handlers: {}
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "YDS_TABCAP_EVENT" || !state.tabMode || !state.running) return;
    const ev = msg.event || {};
    if (ev.kind === "text" && state.handlers.onText) state.handlers.onText(ev.text, !!ev.final);
    if (ev.kind === "hello" && state.handlers.onHello) state.handlers.onHello(ev.hello);
    if (ev.kind === "status") emitStatus(ev.status);
  });

  function emitStatus(status, detail) {
    if (state.handlers.onStatus) state.handlers.onStatus(status, detail || "");
  }

  function floatTo16(f32) {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return i16;
  }

  async function startCapture(video) {
    // Pinning the context to 16 kHz makes the browser do the resampling, so the
    // recognizer gets exactly the rate it wants without any work on our side.
    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await audioCtx.resume();
    const stream = video.captureStream();
    const source = audioCtx.createMediaStreamSource(stream);
    // A ScriptProcessor only fires while it is connected to the destination, so
    // it goes through a silent gain node — otherwise the tap would double the
    // audio the viewer hears.
    const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(audioCtx.destination);
    processor.onaudioprocess = (e) => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(floatTo16(e.inputBuffer.getChannelData(0)).buffer);
      }
    };
    state.audioCtx = audioCtx;
    state.nodes = { source, processor, mute };
  }

  function stopCapture() {
    if (state.nodes) {
      state.nodes.processor.onaudioprocess = null;
      try {
        state.nodes.source.disconnect();
        state.nodes.processor.disconnect();
        state.nodes.mute.disconnect();
      } catch {}
    }
    if (state.audioCtx) state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
    state.nodes = null;
  }

  function connect() {
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      emitStatus("unavailable");
      return;
    }
    ws.onopen = () => emitStatus("listening");
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg && msg.type === "hello") {
          if (state.handlers.onHello) state.handlers.onHello(msg);
          return;
        }
        if (msg && typeof msg.text === "string" && state.handlers.onText) {
          state.handlers.onText(msg.text, !!msg.final);
        }
      } catch {}
    };
    ws.onclose = () => {
      state.ws = null;
      if (!state.running) return;
      // Nothing distinguishes "never started" from "died" at this level, and
      // either way the fix is the same, so one message covers both.
      emitStatus("unavailable");
      state.reconnectTimer = setTimeout(connect, RECONNECT_MS);
    };
    ws.onerror = () => ws.close();
    state.ws = ws;
  }

  window.YDS_LIVE = {
    isRunning: () => state.running,

    // handlers: { onText(text, isFinal), onStatus(status, detail) }
    // status is one of: connecting | listening | unavailable | stopped
    async start(video, handlers, opts) {
      if (state.running) return { ok: true };
      state.handlers = handlers || {};
      if (opts && opts.tabAudio) {
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: "YDS_TABCAP_START" });
        } catch (err) {
          res = { ok: false, error: err && err.message };
        }
        if (!res || !res.ok) {
          return { ok: false, error: "capture-failed", detail: res && res.error };
        }
        state.tabMode = true;
        state.running = true;
        emitStatus("connecting");
        return { ok: true };
      }
      if (!video) return { ok: false, error: "no-video" };
      try {
        await startCapture(video);
      } catch (err) {
        stopCapture();
        // Media Chrome counts as cross-origin (file://, another domain's CDN),
        // or DRM. The popup answers this by retrying in tab mode.
        return { ok: false, error: "capture-failed", detail: err && err.message };
      }
      state.running = true;
      emitStatus("connecting");
      connect();
      return { ok: true };
    },

    stop() {
      state.running = false;
      if (state.tabMode) {
        state.tabMode = false;
        chrome.runtime.sendMessage({ type: "YDS_TABCAP_STOP" }).catch(() => {});
        emitStatus("stopped");
        return;
      }
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      if (state.ws) {
        try { state.ws.close(); } catch {}
        state.ws = null;
      }
      stopCapture();
      emitStatus("stopped");
    },

    // Tell the recognizer to drop the sentence it is part-way through: after a
    // seek or a video change, its buffered audio no longer relates to anything.
    reset() {
      if (state.tabMode) {
        chrome.runtime.sendMessage({ type: "YDS_TABCAP_RESET" }).catch(() => {});
        return;
      }
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "reset" }));
      }
    }
  };
})();
