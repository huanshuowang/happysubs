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
