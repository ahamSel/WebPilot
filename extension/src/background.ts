/// <reference types="chrome" />

import { startDevBridge } from "./dev-bridge";
import { Engine } from "./engine";
import { PANEL_PORT_PREFIX } from "./protocol";

declare const __DEV_BRIDGE__: boolean;

const engine = new Engine();

/**
 * Every tab gets its own side panel (and its own conversation): clicking the
 * toolbar button or pressing the shortcut opens the panel for the current tab
 * only. Both calls stay synchronous so they run inside the user gesture.
 */
function openPanel(tabId: number) {
    chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
    // Earlier versions opened one shared panel on click; per-tab panels are opened here instead.
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
    if (tab.id !== undefined) openPanel(tab.id);
});

chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(PANEL_PORT_PREFIX)) return;
    const tabId = Number(port.name.slice(PANEL_PORT_PREFIX.length));
    if (Number.isInteger(tabId)) engine.connect(port, tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    engine.dispose(tabId);
});

if (__DEV_BRIDGE__) startDevBridge(engine);
