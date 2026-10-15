// Tab-audio capture for live transcription.
//
// live.js normally taps the <video> with captureStream(), but Chrome refuses
// that for media it considers cross-origin — a local file opened as file://,
// or a site that serves its video from another domain. chrome.tabCapture has
// no such limit, but its stream can only be consumed in an extension page, so
// the capture lives here, in an offscreen document the service worker opens.
//
// Same job as live.js otherwise: 16 kHz mono PCM to the local recognizer over
// the loopback WebSocket, text back out. Text and status go to the service
// worker, which hands them to the tab they belong to.
//
// Capturing a tab silences it for the user, so the stream is also played back
// through an ordinary AudioContext — the viewer keeps hearing the video.

const WS_URL = "ws://127.0.0.1:8765";
const RECONNECT_MS = 3000;
const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;

let cur = null;   // { tabId, stream, playCtx, recCtx, processor, ws, reconnectTimer }

function emit(tabId, event) {
  chrome.runtime.sendMessage({ type: "YDS_TABCAP_EVENT", tabId, event }).catch(() => {});
}

function floatTo16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
}

function connect(c) {
  if (cur !== c) return;
  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    emit(c.tabId, { kind: "status", status: "unavailable" });
    return;
  }
  ws.onopen = () => emit(c.tabId, { kind: "status", status: "listening" });
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg && msg.type === "hello") {
        emit(c.tabId, { kind: "hello", hello: msg });
        return;
      }
      if (msg && typeof msg.text === "string") {
        emit(c.tabId, { kind: "text", text: msg.text, final: !!msg.final });
      }
    } catch {}
  };
  ws.onclose = () => {
    if (c.ws === ws) c.ws = null;
    if (cur !== c) return;
    emit(c.tabId, { kind: "status", status: "unavailable" });
    c.reconnectTimer = setTimeout(() => connect(c), RECONNECT_MS);
  };
  ws.onerror = () => ws.close();
  c.ws = ws;
}

async function start(streamId, tabId) {
  stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false
  });

  // Playback at the tab's own rate, so what the viewer hears is untouched.
  const playCtx = new AudioContext();
  playCtx.createMediaStreamSource(stream).connect(playCtx.destination);

  // Recognition at 16 kHz; the browser resamples. Same silent-sink trick as
  // live.js: a ScriptProcessor only runs while connected to a destination.
  const recCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = recCtx.createMediaStreamSource(stream);
  const processor = recCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
  const mute = recCtx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(recCtx.destination);

  const c = { tabId, stream, playCtx, recCtx, processor, ws: null, reconnectTimer: null };
  processor.onaudioprocess = (e) => {
    if (c.ws && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(floatTo16(e.inputBuffer.getChannelData(0)).buffer);
    }
  };
  // The tab closed or navigated away: the capture ends on its own.
  for (const t of stream.getAudioTracks()) {
    t.addEventListener("ended", () => {
      if (cur === c) {
        emit(c.tabId, { kind: "status", status: "stopped" });
        stop();
      }
    });
  }
  cur = c;
  emit(tabId, { kind: "status", status: "connecting" });
  connect(c);
}

function stop() {
  const c = cur;
  cur = null;
  if (!c) return;
  clearTimeout(c.reconnectTimer);
  if (c.ws) { try { c.ws.close(); } catch {} }
  c.processor.onaudioprocess = null;
  for (const t of c.stream.getTracks()) { try { t.stop(); } catch {} }
  c.playCtx.close().catch(() => {});
  c.recCtx.close().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "start") {
    start(msg.streamId, msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "stop") {
    if (!msg.tabId || (cur && cur.tabId === msg.tabId)) stop();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "reset") {
    if (cur && cur.tabId === msg.tabId && cur.ws && cur.ws.readyState === WebSocket.OPEN) {
      cur.ws.send(JSON.stringify({ type: "reset" }));
    }
    sendResponse({ ok: true });
  }
});
