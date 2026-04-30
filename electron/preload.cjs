const { contextBridge, ipcRenderer } = require("electron");
const DESKTOP_COMMAND_CHANNEL = "desktop:app-command";

// macOS: 36px compact bar (12px above + 12px button + 12px below). Win/Linux: 40px overlay.
const TITLEBAR_HEIGHT = process.platform === "darwin" ? 36 : 40;

contextBridge.exposeInMainWorld("webPilotDesktop", {
    platform: process.platform,
    titlebarHeight: TITLEBAR_HEIGHT,
    getShellInfo: () => ipcRenderer.invoke("desktop:get-shell-info"),
    getAgentState: () => ipcRenderer.invoke("desktop:agent:get-state"),
    postAgentAction: (payload) => ipcRenderer.invoke("desktop:agent:post-action", payload),
    listRuns: () => ipcRenderer.invoke("desktop:runs:list"),
    getRun: (runId) => ipcRenderer.invoke("desktop:runs:get", runId),
    getRunArtifact: (runId, artifactName) => ipcRenderer.invoke("desktop:runs:get-artifact", runId, artifactName),
    listThreads: (limit) => ipcRenderer.invoke("desktop:threads:list", limit),
    getThread: (threadId) => ipcRenderer.invoke("desktop:threads:get", threadId),
    getSettings: () => ipcRenderer.invoke("desktop:settings:get"),
    saveSettings: (payload) => ipcRenderer.invoke("desktop:settings:save", payload),
    listBrowsers: () => ipcRenderer.invoke("desktop:browsers:list"),
    openHomeWindow: () => ipcRenderer.invoke("desktop:window:show-home"),
    openLibraryWindow: () => ipcRenderer.invoke("desktop:window:open-library"),
    openActivityWindow: () => ipcRenderer.invoke("desktop:window:open-activity"),
    openRunWindow: (runId) => ipcRenderer.invoke("desktop:window:open-run", runId),
    openSettingsWindow: () => ipcRenderer.invoke("desktop:window:open-settings"),
    onAppCommand: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on(DESKTOP_COMMAND_CHANNEL, listener);
        return () => ipcRenderer.removeListener(DESKTOP_COMMAND_CHANNEL, listener);
    },
    copyText: (text) => ipcRenderer.invoke("desktop:clipboard:write-text", text),
});
