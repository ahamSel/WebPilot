export type BrowserMode = "managed" | "channel" | "cdp" | "custom";
export type BrowserName = "chromium" | "firefox" | "webkit";
export type BrowserChannel =
    | ""
    | "chrome"
    | "chrome-beta"
    | "chrome-dev"
    | "chrome-canary"
    | "msedge"
    | "msedge-beta"
    | "msedge-dev"
    | "msedge-canary";

export interface BrowserRuntimeSettings {
    mode: BrowserMode;
    browserName: BrowserName;
    channel: BrowserChannel;
    userDataDir: string;
    cdpEndpoint: string;
    executablePath: string;
    isolated: boolean;
    headless: boolean;
}

export interface BrowserRuntimeOverrides {
    mode?: string;
    browserName?: string;
    channel?: string;
    userDataDir?: string;
    cdpEndpoint?: string;
    executablePath?: string;
    isolated?: boolean;
    headless?: boolean;
}

export const DEFAULT_BROWSER_RUNTIME_SETTINGS: BrowserRuntimeSettings = {
    mode: "managed",
    browserName: "chromium",
    channel: "",
    userDataDir: "",
    cdpEndpoint: "",
    executablePath: "",
    isolated: false,
    headless: false,
};

const browserNames = new Set<BrowserName>(["chromium", "firefox", "webkit"]);
const browserModes = new Set<BrowserMode>(["managed", "channel", "cdp", "custom"]);
const browserChannels = new Set<BrowserChannel>([
    "",
    "chrome",
    "chrome-beta",
    "chrome-dev",
    "chrome-canary",
    "msedge",
    "msedge-beta",
    "msedge-dev",
    "msedge-canary",
]);

function cleanString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function boolFromInput(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
        if (normalized === "0" || normalized === "false" || normalized === "no") return false;
    }
    return fallback;
}

export function sanitizeBrowserRuntimeSettings(value: unknown): BrowserRuntimeSettings {
    const input = value && typeof value === "object" && !Array.isArray(value)
        ? value as BrowserRuntimeOverrides
        : {};

    const requestedMode = cleanString(input.mode) as BrowserMode;
    const mode = browserModes.has(requestedMode) ? requestedMode : DEFAULT_BROWSER_RUNTIME_SETTINGS.mode;
    const requestedName = cleanString(input.browserName) as BrowserName;
    const browserName = browserNames.has(requestedName) ? requestedName : DEFAULT_BROWSER_RUNTIME_SETTINGS.browserName;
    const requestedChannel = cleanString(input.channel) as BrowserChannel;
    const channel = browserChannels.has(requestedChannel) ? requestedChannel : "";

    return {
        mode,
        browserName: mode === "channel" ? "chromium" : browserName,
        channel: mode === "channel" ? channel : "",
        userDataDir: mode === "cdp" ? "" : cleanString(input.userDataDir),
        cdpEndpoint: mode === "cdp" ? cleanString(input.cdpEndpoint) : "",
        executablePath: mode === "custom" ? cleanString(input.executablePath) : "",
        isolated: mode === "cdp" ? false : boolFromInput(input.isolated, DEFAULT_BROWSER_RUNTIME_SETTINGS.isolated),
        headless: boolFromInput(input.headless, DEFAULT_BROWSER_RUNTIME_SETTINGS.headless),
    };
}

export function browserRuntimeLabel(settings: BrowserRuntimeSettings): string {
    if (settings.mode === "cdp") return "Running Chrome/Edge via CDP";
    if (settings.mode === "custom") return "Custom browser executable";
    if (settings.mode === "channel") {
        if (settings.channel.startsWith("msedge")) return "Microsoft Edge";
        if (settings.channel.startsWith("chrome")) return "Google Chrome";
        return "Chromium channel";
    }
    if (settings.browserName === "firefox") return "Playwright Firefox";
    if (settings.browserName === "webkit") return "Playwright WebKit";
    return "WebPilot Chromium";
}

export function browserRuntimeKey(settings: BrowserRuntimeSettings): string {
    return JSON.stringify(sanitizeBrowserRuntimeSettings(settings));
}
