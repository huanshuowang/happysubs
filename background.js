// The only reason this service worker exists: chrome.commands events are
// delivered to the extension, not to a page, so something has to be listening
// and pass them to the tab the viewer is looking at. It holds no state and
// wakes only when a shortcut is pressed.
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) return;
  // A tab without our content script (a settings page, a PDF) simply has no
  // receiver; swallowing that is the whole error handling this needs.
  chrome.tabs.sendMessage(tab.id, { type: "YDS_COMMAND", command }, () => {
    void chrome.runtime.lastError;
  });
});
