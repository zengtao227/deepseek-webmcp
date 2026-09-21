async function enableActionOpen() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onInstalled.addListener(() => {
  void enableActionOpen();
});

chrome.runtime.onStartup.addListener(() => {
  void enableActionOpen();
});

void enableActionOpen();
