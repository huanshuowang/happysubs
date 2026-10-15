// The service worker does three small things, none of which can happen in a
// page: it opens the welcome page on a fresh install, it tells Chrome where the
// uninstall survey lives (and in which language), and it relays the keyboard
// shortcut. It holds no state and makes no network requests.

// The same rule the popup uses for which language the panel speaks.
importScripts("i18n.js");

// Opened by Chrome itself after the extension is removed — the extension is
// gone by then, so it has to be a page on the site. Nothing is sent unless the
// person fills in the form there.
const UNINSTALL_SURVEY = "https://huanshuowang.com/happysubs/uninstall.html";

// The survey opens in whichever language the panel was in, so it carries that
// along with the version being removed. Chrome remembers the address, so it
// only needs setting again when one of the two changes.
async function registerUninstallSurvey() {
  let pref = "auto";
  try {
    pref = ((await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {}).uiLang || "auto";
  } catch {}
  const lang = ydsSetUiLang(pref);
  const version = chrome.runtime.getManifest().version;
  chrome.runtime.setUninstallURL(`${UNINSTALL_SURVEY}?v=${version}&lang=${lang}`);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.ydsSettings) return;
  const before = (changes.ydsSettings.oldValue || {}).uiLang;
  const after = (changes.ydsSettings.newValue || {}).uiLang;
  if (before !== after) registerUninstallSurvey();
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Re-registered on every install and update, so the version the survey
  // reports is the one that was actually removed.
  registerUninstallSurvey();

  // A first install only. On YouTube nothing appears until the player's own
  // captions are on, and a new user who opens a video and sees nothing has no
  // reason to think the extension works — the welcome page says what to press.
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});

// Once, for people arriving at 2.2.0 from an earlier version. The sites added
// in 2.2.0 are optional permissions (see "sites the viewer opts into" below),
// so that the update does not disable the extension for them — and an
// optional permission nobody is told about is a feature nobody gets. This
// page is where the offer is made, along with what else is new.
//
// The plan is to make those sites required in a later version: Chrome does
// not disable an extension for a user who has already granted the permission
// (extensions/docs/permissions.md), so everyone who says yes here is unaffected
// by that change, and new installs then get everything in one go.
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason !== chrome.runtime.OnInstalledReason.UPDATE || !previousVersion) return;
  const [major, minor] = previousVersion.split(".").map(Number);
  if (major > 2 || (major === 2 && minor >= 2)) return;
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html?new=2.2.0") });
});

// chrome.commands events are delivered to the extension, not to a page, so
// something has to be listening and pass them to the tab the viewer is looking
// at. It wakes only when a shortcut is pressed.
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) return;
  // A tab without our content script (a settings page, a PDF) simply has no
  // receiver; swallowing that is the whole error handling this needs.
  chrome.tabs.sendMessage(tab.id, { type: "YDS_COMMAND", command }, () => {
    void chrome.runtime.lastError;
  });
});

// ---------- tab-audio capture for live transcription ----------
//
// When a page's <video> refuses captureStream() — a local file, a cross-origin
// stream — live.js asks us for the tab's audio instead. chrome.tabCapture is an
// optional permission (its install warning would be out of all proportion for
// a fallback), granted from the popup the first time it is needed. The stream
// id has to be consumed in an extension page, so the capture itself runs in an
// offscreen document; we fetch the id, open the document, and relay text from
// it back to the tab.

let capturedTabId = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio for live transcription"
  });
}

async function startTabCapture(tabId) {
  if (!chrome.tabCapture) return { ok: false, error: "no-permission" };
  // The same tab twice in a row: Chrome refuses a second capture of a tab it
  // is already capturing, so stop the first one.
  if (capturedTabId !== null) await stopTabCapture(capturedTabId);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId, tabId });
  if (res && res.ok) capturedTabId = tabId;
  return res || { ok: false, error: "offscreen-silent" };
}

async function stopTabCapture(tabId) {
  if (capturedTabId === null || (tabId && tabId !== capturedTabId)) return;
  capturedTabId = null;
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "stop", tabId });
  } catch {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === "YDS_TABCAP_START" && tabId) {
    startTabCapture(tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "YDS_TABCAP_STOP" && tabId) {
    stopTabCapture(tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "YDS_TABCAP_RESET" && tabId) {
    chrome.runtime.sendMessage({ target: "offscreen", type: "reset", tabId }).catch(() => {});
    return;
  }
  // From the offscreen document, for whichever tab it is capturing.
  if (msg.type === "YDS_TABCAP_EVENT" && msg.tabId) {
    if (msg.event && msg.event.kind === "status" && msg.event.status === "stopped"
        && capturedTabId === msg.tabId) {
      capturedTabId = null;
    }
    chrome.tabs.sendMessage(msg.tabId, msg, () => void chrome.runtime.lastError);
  }
});

// Navigating away or closing the tab ends the page, not the capture.
chrome.tabs.onRemoved.addListener((tabId) => { stopTabCapture(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && tabId === capturedTabId) stopTabCapture(tabId);
});

// ---------- sites the viewer opts into ----------
//
// Adding a site to the manifest's content_scripts widens the install warning,
// and Chrome disables the extension for every existing user until they accept
// it. So sites added after launch are optional host permissions instead: the
// popup asks the first time it is opened there, and once granted the same
// scripts are registered here to run automatically — exactly what a manifest
// entry would have done, minus the forced re-approval.
const SITE_SCRIPTS = ["i18n.js", "platform.js", "live.js", "content.js"];
const OPTIONAL_SITES = [
  {
    id: "yds-zoom",
    origins: ["https://*.zoom.us/*"],
    matches: ["https://*.zoom.us/rec/*"],
    allFrames: false
  },
  {
    // The privacy-enhanced YouTube embed, always inside someone else's page.
    id: "yds-youtube-nocookie",
    origins: ["*://www.youtube-nocookie.com/*"],
    matches: ["*://www.youtube-nocookie.com/*"],
    allFrames: true
  }
];

// Any other site, one at a time: "always run on coursera.org", granted from
// the popup on that site. The manifest lists *://*/* as an OPTIONAL host
// pattern only so that such a single-site request is allowed; the extension
// never asks for the whole pattern. Each granted site gets the generic
// adapter, registered under an id made from its host.
const USER_SITE_PREFIX = "yds-site-";
const USER_SITE_ORIGIN = /^https?:\/\/[^*/]+\/\*$/;

async function syncUserSites(registered) {
  const fixed = new Set([
    ...(chrome.runtime.getManifest().host_permissions || []),
    ...OPTIONAL_SITES.flatMap(s => s.origins)
  ]);
  const granted = ((await chrome.permissions.getAll()).origins || [])
    .filter(o => USER_SITE_ORIGIN.test(o) && !fixed.has(o));
  const wanted = new Map(granted.map(o => {
    const host = o.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
    return [USER_SITE_PREFIX + host.replace(/[^a-z0-9.-]/gi, "_"), o];
  }));
  for (const [id, origin] of wanted) {
    if (registered.has(id)) continue;
    try {
      await chrome.scripting.registerContentScripts([{
        id,
        matches: [origin],
        js: ["generic-flag.js", ...SITE_SCRIPTS],
        css: ["overlay.css"],
        runAt: "document_idle",
        allFrames: false
      }]);
    } catch {}
  }
  const stale = [...registered].filter(id => id.startsWith(USER_SITE_PREFIX) && !wanted.has(id));
  if (stale.length) {
    try { await chrome.scripting.unregisterContentScripts({ ids: stale }); } catch {}
  }
}

async function syncOptionalSites() {
  let registered;
  try {
    registered = new Set((await chrome.scripting.getRegisteredContentScripts()).map(s => s.id));
  } catch {
    return;
  }
  await syncUserSites(registered);
  for (const site of OPTIONAL_SITES) {
    const granted = await chrome.permissions.contains({ origins: site.origins });
    try {
      if (granted && !registered.has(site.id)) {
        await chrome.scripting.registerContentScripts([{
          id: site.id,
          matches: site.matches,
          js: SITE_SCRIPTS,
          css: ["overlay.css"],
          runAt: "document_start",
          allFrames: site.allFrames
        }]);
      } else if (!granted && registered.has(site.id)) {
        await chrome.scripting.unregisterContentScripts({ ids: [site.id] });
      }
    } catch {}
  }
}

chrome.runtime.onInstalled.addListener(syncOptionalSites);
chrome.runtime.onStartup.addListener(syncOptionalSites);
chrome.permissions.onRemoved.addListener(syncOptionalSites);
chrome.permissions.onAdded.addListener(async (added) => {
  await syncOptionalSites();
  // An embedded player only gets our script on its next load, and the popup
  // that asked has usually been closed by the permission dialog — so the
  // reload happens here. Granted from the welcome page there is no player
  // to reload.
  const origins = (added && added.origins) || [];
  if (origins.some(o => o.includes("youtube-nocookie.com"))) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.id && !(tab.url || "").startsWith(chrome.runtime.getURL(""))) chrome.tabs.reload(tab.id);
  }
});
