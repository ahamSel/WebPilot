import {
    defaultBaseUrlForProvider,
    defaultModelsForProvider,
    normalizeProvider,
    type ModelProvider,
    type OllamaDiscoveryResult,
} from "@/lib/runtime-provider-presets";
import {
    DEFAULT_BROWSER_RUNTIME_SETTINGS,
    sanitizeBrowserRuntimeSettings,
    type BrowserRuntimeSettings,
} from "@/lib/browser-runtime";

export type {
    BrowserChannel,
    BrowserMode,
    BrowserName,
    BrowserRuntimeSettings,
} from "@/lib/browser-runtime";

export interface DesktopShellInfo {
    platform: string;
    isPackaged: boolean;
    rendererUrl: string;
    runtimeTransport?: "direct" | "http-fallback";
    runtimeError?: string | null;
}

export interface RuntimeSettings {
    provider: ModelProvider;
    apiKey: string;
    baseUrl: string;
    navModel: string;
    synthModel: string;
    reviewModel: string;
    synthEnabled: boolean;
    browser: BrowserRuntimeSettings;
}

export interface BrowserDiscoveryBrowser {
    id: string;
    label: string;
    kind: "managed" | "channel" | "custom";
    available: boolean;
    browserName?: string;
    channel?: string;
    executablePath?: string;
}

export interface BrowserDiscoveryProfile {
    browserId: string;
    browserLabel: string;
    profileId: string;
    name: string;
    userDataDir: string;
    profilePath: string;
    usableForDirectLaunch: boolean;
}

export interface BrowserDiscoveryResult {
    platform: string;
    defaultUserDataDir?: string;
    browsers: BrowserDiscoveryBrowser[];
    profiles: BrowserDiscoveryProfile[];
}

export type DesktopAppCommand =
    | "new-thread"
    | "focus-task"
    | "open-command-palette"
    | "navigate";

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
    provider: "gemini",
    apiKey: "",
    baseUrl: defaultBaseUrlForProvider("gemini"),
    ...defaultModelsForProvider("gemini"),
    synthEnabled: true,
    browser: DEFAULT_BROWSER_RUNTIME_SETTINGS,
};

const LOCAL_RUNTIME_SETTINGS_KEY = "webpilot.runtime-settings.v1";

export interface DesktopBridge {
    getShellInfo: () => Promise<DesktopShellInfo>;
    getAgentState: () => Promise<any>;
    postAgentAction: (payload: Record<string, unknown>) => Promise<any>;
    listRuns: () => Promise<any>;
    getRun: (runId: string) => Promise<any>;
    getRunArtifact: (runId: string, artifactName: string) => Promise<any>;
    listThreads: (limit?: number) => Promise<any>;
    getThread: (threadId: string) => Promise<any>;
    getSettings: () => Promise<{ runtime?: Partial<RuntimeSettings> }>;
    saveSettings: (payload: { runtime: RuntimeSettings }) => Promise<{ runtime?: Partial<RuntimeSettings> }>;
    listBrowsers: () => Promise<BrowserDiscoveryResult>;
    openHomeWindow: () => Promise<{ ok?: boolean }>;
    openLibraryWindow: () => Promise<{ ok?: boolean }>;
    openActivityWindow: () => Promise<{ ok?: boolean }>;
    openRunWindow: (runId: string) => Promise<{ ok?: boolean }>;
    openSettingsWindow: () => Promise<{ ok?: boolean }>;
    onAppCommand: (callback: (payload: { command?: DesktopAppCommand; payload?: Record<string, unknown> }) => void) => () => void;
    copyText: (text: string) => Promise<any>;
}

function getDesktopBridge() {
    if (typeof window === "undefined") return null;
    const shellWindow = window as Window & { webPilotDesktop?: DesktopBridge };
    return shellWindow.webPilotDesktop || null;
}

function normalizeRuntimeSettings(value: unknown): RuntimeSettings {
    const input = value && typeof value === "object" && !Array.isArray(value)
        ? value as Partial<RuntimeSettings>
        : {};
    const provider = normalizeProvider(input.provider);
    const modelDefaults = defaultModelsForProvider(provider);
    return {
        provider,
        apiKey: typeof input.apiKey === "string" ? input.apiKey : DEFAULT_RUNTIME_SETTINGS.apiKey,
        baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : defaultBaseUrlForProvider(provider),
        navModel: typeof input.navModel === "string" && input.navModel.trim() ? input.navModel.trim() : modelDefaults.navModel,
        synthModel: typeof input.synthModel === "string" && input.synthModel.trim() ? input.synthModel.trim() : modelDefaults.synthModel,
        reviewModel: typeof input.reviewModel === "string" && input.reviewModel.trim() ? input.reviewModel.trim() : modelDefaults.reviewModel,
        synthEnabled: typeof input.synthEnabled === "boolean" ? input.synthEnabled : DEFAULT_RUNTIME_SETTINGS.synthEnabled,
        browser: sanitizeBrowserRuntimeSettings((input as { browser?: unknown }).browser),
    };
}

function readLocalRuntimeSettings(): RuntimeSettings {
    if (typeof window === "undefined") {
        return DEFAULT_RUNTIME_SETTINGS;
    }
    try {
        const raw = window.localStorage.getItem(LOCAL_RUNTIME_SETTINGS_KEY);
        if (!raw) return DEFAULT_RUNTIME_SETTINGS;
        return normalizeRuntimeSettings(JSON.parse(raw));
    } catch {
        return DEFAULT_RUNTIME_SETTINGS;
    }
}

function writeLocalRuntimeSettings(runtime: RuntimeSettings) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(LOCAL_RUNTIME_SETTINGS_KEY, JSON.stringify(runtime));
    } catch {
        // ignore storage failures in browser mode
    }
}

async function httpJson(pathname: string, init?: RequestInit) {
    const response = await fetch(pathname, init);
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = typeof json.error === "string" ? json.error : `${init?.method || "GET"} ${pathname} failed`;
        throw new Error(message);
    }
    return json;
}

export function isDesktopShell() {
    return !!getDesktopBridge();
}

export async function getDesktopShellInfo() {
    const bridge = getDesktopBridge();
    if (!bridge) return null;
    return bridge.getShellInfo();
}

export async function getAgentStateClient() {
    const bridge = getDesktopBridge();
    if (bridge) return bridge.getAgentState();
    return httpJson("/api/agent");
}

export async function postAgentActionClient(payload: Record<string, unknown>) {
    const bridge = getDesktopBridge();
    if (bridge) return bridge.postAgentAction(payload);
    return httpJson("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listRunsClient() {
    const bridge = getDesktopBridge();
    if (bridge) return bridge.listRuns();
    return httpJson("/api/runs");
}

export async function getRunDetailClient(runId: string) {
    const bridge = getDesktopBridge();
    if (bridge) return bridge.getRun(runId);
    return httpJson(`/api/runs/${encodeURIComponent(runId)}`);
}

export async function getRunArtifactClient(runId: string, artifactName: string) {
    const bridge = getDesktopBridge();
    if (bridge) return bridge.getRunArtifact(runId, artifactName);
    return httpJson(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}`);
}

export async function listThreadsClient(limit?: number) {
    const bridge = getDesktopBridge();
    if (bridge) return bridge.listThreads(limit);
    const search = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return httpJson(`/api/threads${search}`);
}

export async function getThreadClient(threadId: string) {
    const bridge = getDesktopBridge();
    if (bridge) return bridge.getThread(threadId);
    return httpJson(`/api/threads?threadId=${encodeURIComponent(threadId)}`);
}

export async function copyTextClient(text: string) {
    const bridge = getDesktopBridge();
    if (bridge) {
        await bridge.copyText(text);
        return;
    }
    await navigator.clipboard.writeText(text);
}

export async function openLibraryWindowClient(): Promise<boolean> {
    const bridge = getDesktopBridge();
    if (!bridge) return false;
    await bridge.openLibraryWindow();
    return true;
}

export async function openHomeWindowClient(): Promise<boolean> {
    const bridge = getDesktopBridge();
    if (!bridge) return false;
    await bridge.openHomeWindow();
    return true;
}

export async function openActivityWindowClient(): Promise<boolean> {
    const bridge = getDesktopBridge();
    if (!bridge) return false;
    await bridge.openActivityWindow();
    return true;
}

export async function openRunWindowClient(runId: string): Promise<boolean> {
    const bridge = getDesktopBridge();
    if (!bridge) return false;
    await bridge.openRunWindow(runId);
    return true;
}

export async function openSettingsWindowClient(): Promise<boolean> {
    const bridge = getDesktopBridge();
    if (!bridge) return false;
    await bridge.openSettingsWindow();
    return true;
}

export function subscribeToDesktopCommands(
    handler: (command: DesktopAppCommand, payload?: Record<string, unknown>) => void
): () => void {
    const bridge = getDesktopBridge();
    if (!bridge) return () => {};
    return bridge.onAppCommand((message) => {
        const command = message?.command;
        if (!command) return;
        handler(command, message.payload);
    });
}

export async function getRuntimeSettingsClient(): Promise<RuntimeSettings> {
    const bridge = getDesktopBridge();
    if (bridge) {
        const json = await bridge.getSettings();
        return normalizeRuntimeSettings(json?.runtime);
    }
    return readLocalRuntimeSettings();
}

export async function saveRuntimeSettingsClient(runtime: RuntimeSettings): Promise<RuntimeSettings> {
    const next = normalizeRuntimeSettings(runtime);
    const bridge = getDesktopBridge();
    if (bridge) {
        const json = await bridge.saveSettings({ runtime: next });
        return normalizeRuntimeSettings(json?.runtime);
    }
    writeLocalRuntimeSettings(next);
    return next;
}

export async function listBrowserOptionsClient(): Promise<BrowserDiscoveryResult> {
    const bridge = getDesktopBridge();
    if (bridge) return bridge.listBrowsers();
    return {
        platform: "web",
        defaultUserDataDir: "",
        browsers: [
            {
                id: "managed-chromium",
                label: "WebPilot Chromium",
                kind: "managed",
                available: true,
            },
        ],
        profiles: [],
    };
}

export async function getRuntimeProviderDiscoveryClient(provider: ModelProvider): Promise<{
    provider: ModelProvider;
    discovery?: OllamaDiscoveryResult;
}> {
    return httpJson(`/api/runtime/providers?provider=${encodeURIComponent(provider)}`);
}

export function buildRuntimeOverrides(runtime: RuntimeSettings): Record<string, unknown> {
    const provider = normalizeProvider(runtime.provider);
    const payload: Record<string, unknown> = {
        provider,
        navModel: runtime.navModel.trim(),
        synthModel: runtime.synthModel.trim(),
        reviewModel: runtime.reviewModel.trim(),
        synthEnabled: runtime.synthEnabled,
    };
    if (runtime.apiKey.trim()) {
        payload.apiKey = runtime.apiKey.trim();
    }
    payload.baseUrl = runtime.baseUrl.trim() || defaultBaseUrlForProvider(provider);
    payload.browser = sanitizeBrowserRuntimeSettings(runtime.browser);
    return payload;
}
