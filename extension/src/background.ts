/// <reference types="chrome" />

// The toolbar button opens WebPilot in the side panel. The agent itself runs in
// the side panel page, which stays alive while it is open (MV3 service workers
// are suspended when idle, so they cannot host a long-running task).
chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
