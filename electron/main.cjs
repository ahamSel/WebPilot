const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell, utilityProcess } = require("electron");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const DEFAULT_PORT = Number(process.env.ELECTRON_PORT || 3210);
const DEV_URL = process.env.ELECTRON_RENDERER_URL || "";
const isDev = Boolean(DEV_URL);

const IS_MAC = process.platform === "darwin";
const TRAFFIC_LIGHT_POSITION = { x: 14, y: 12 };
const TITLEBAR_HEIGHT = IS_MAC ? 36 : 40; // compact macOS bar, 40px Win/Linux

let mainWindow = null;
let nextServerProcess = null;
let shuttingDown = false;
let desktopRuntimeModules = null;
let desktopRuntimeLoadError = null;
let desktopRuntimeFallbackWarned = false;

const GEMINI_PROVIDER = "gemini";
const OPENAI_PROVIDER = "openai";
const OLLAMA_PROVIDER = "ollama";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const DESKTOP_COMMAND_CHANNEL = "desktop:app-command";

function rendererUrl() {
    if (DEV_URL) return DEV_URL;
    return `http://127.0.0.1:${DEFAULT_PORT}`;
}

function routeUrl(routePath = "/") {
    return new URL(routePath, rendererUrl()).toString();
}

function appIconPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, "icon.png");
    }
    return path.join(app.getAppPath(), "assets", "app-icon", "icon.png");
}

function sendDesktopCommand(window, command, payload = {}) {
    if (!window || window.isDestroyed()) return;
    window.webContents.send(DESKTOP_COMMAND_CHANNEL, { command, payload });
}

function getFocusedCommandWindow() {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
        return mainWindow;
    }
    return null;
}

async function callLocalApi(pathname, options = {}) {
    const method = options.method || "GET";
    const url = new URL(pathname, rendererUrl());

    if (options.query && typeof options.query === "object") {
        for (const [key, value] of Object.entries(options.query)) {
            if (value === undefined || value === null || value === "") continue;
            url.searchParams.set(key, String(value));
        }
    }

    const response = await fetch(url, {
        method,
        headers: options.body ? { "Content-Type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = typeof json.error === "string" ? json.error : `${method} ${pathname} failed`;
        throw new Error(message);
    }
    return json;
}

function waitForUrl(url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const poll = () => {
            const req = http.get(url, (res) => {
                res.resume();
                resolve();
            });
            req.on("error", () => {
                if (Date.now() - start >= timeoutMs) {
                    reject(new Error(`Timed out waiting for ${url}`));
                    return;
                }
                setTimeout(poll, 300);
            });
        };

        poll();
    });
}

function standaloneServerPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, "standalone", "server.js");
    }
    return path.join(app.getAppPath(), ".next", "standalone", "server.js");
}

function desktopDataEnv() {
    const dataRoot = path.join(app.getPath("userData"), "runtime");
    return {
        ELECTRON_DESKTOP: "1",
        RUN_STORE_DIR: path.join(dataRoot, "agent_runs"),
        THREAD_STORE_DIR: path.join(dataRoot, "agent_threads"),
    };
}

function bundledPlaywrightBrowsersPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, "playwright-browsers");
    }
    return path.join(app.getAppPath(), ".playwright-browsers");
}

function normalizeProvider(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "openai" || normalized === "openai-compatible" || normalized === "openai_compatible") {
        return OPENAI_PROVIDER;
    }
    if (normalized === "ollama") {
        return OLLAMA_PROVIDER;
    }
    return GEMINI_PROVIDER;
}

function defaultBaseUrlForProvider(provider) {
    if (provider === OPENAI_PROVIDER) return OPENAI_BASE_URL;
    if (provider === OLLAMA_PROVIDER) return OLLAMA_BASE_URL;
    return "";
}

function defaultModelsForProvider(provider) {
    if (provider === GEMINI_PROVIDER) {
        return {
            navModel: "gemini-2.5-flash",
            synthModel: "gemini-2.5-pro",
            reviewModel: "gemini-2.5-pro",
        };
    }
    if (provider === OPENAI_PROVIDER) {
        return {
            navModel: "gpt-5-mini",
            synthModel: "gpt-5.2",
            reviewModel: "gpt-5.2",
        };
    }
    return {
        navModel: "",
        synthModel: "",
        reviewModel: "",
    };
}

function boolFromInput(value, fallback) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
        if (normalized === "0" || normalized === "false" || normalized === "no") return false;
    }
    return fallback;
}

function cleanBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
}

const DEFAULT_BROWSER_SETTINGS = {
    mode: "managed",
    browserName: "chromium",
    channel: "",
    userDataDir: "",
    cdpEndpoint: "",
    executablePath: "",
    isolated: false,
    headless: false,
};

const VALID_BROWSER_MODES = new Set(["managed", "channel", "cdp", "custom"]);
const VALID_BROWSER_NAMES = new Set(["chromium", "firefox", "webkit"]);
const VALID_BROWSER_CHANNELS = new Set([
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

function cleanString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function sanitizeBrowserSettings(value) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const requestedMode = cleanString(input.mode);
    const mode = VALID_BROWSER_MODES.has(requestedMode) ? requestedMode : DEFAULT_BROWSER_SETTINGS.mode;
    const requestedName = cleanString(input.browserName);
    const browserName = VALID_BROWSER_NAMES.has(requestedName) ? requestedName : DEFAULT_BROWSER_SETTINGS.browserName;
    const requestedChannel = cleanString(input.channel);
    const channel = VALID_BROWSER_CHANNELS.has(requestedChannel) ? requestedChannel : "";

    return {
        mode,
        browserName: mode === "channel" ? "chromium" : browserName,
        channel: mode === "channel" ? channel : "",
        userDataDir: mode === "cdp" ? "" : cleanString(input.userDataDir),
        cdpEndpoint: mode === "cdp" ? cleanString(input.cdpEndpoint) : "",
        executablePath: mode === "custom" ? cleanString(input.executablePath) : "",
        isolated: mode === "cdp" ? false : boolFromInput(input.isolated, DEFAULT_BROWSER_SETTINGS.isolated),
        headless: boolFromInput(input.headless, DEFAULT_BROWSER_SETTINGS.headless),
    };
}

function pathExists(filePath) {
    try {
        return !!filePath && fsSync.existsSync(filePath);
    } catch {
        return false;
    }
}

function firstExisting(paths) {
    return paths.find((candidate) => pathExists(candidate)) || "";
}

function readJsonFile(filePath) {
    try {
        return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
}

function readTextFile(filePath) {
    try {
        return fsSync.readFileSync(filePath, "utf8");
    } catch {
        return "";
    }
}

function homePath(...parts) {
    const home = os.homedir();
    return home ? path.join(home, ...parts) : "";
}

function addBrowserOption(browsers, option) {
    if (browsers.some((browser) => browser.id === option.id)) return;
    browsers.push(option);
}

function scanChromiumProfiles(profiles, browserId, browserLabel, userDataDir) {
    if (!pathExists(userDataDir)) return;

    const localState = readJsonFile(path.join(userDataDir, "Local State"));
    const infoByProfile = localState?.profile?.info_cache && typeof localState.profile.info_cache === "object"
        ? localState.profile.info_cache
        : {};
    const profileDirs = new Set(Object.keys(infoByProfile));

    if (!profileDirs.size) {
        try {
            for (const entry of fsSync.readdirSync(userDataDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                if (entry.name === "Default" || /^Profile \d+$/i.test(entry.name)) {
                    profileDirs.add(entry.name);
                }
            }
        } catch {
            // ignore unreadable browser profile roots
        }
    }

    for (const profileDir of Array.from(profileDirs).sort()) {
        const profilePath = path.join(userDataDir, profileDir);
        if (!pathExists(profilePath)) continue;
        const info = infoByProfile[profileDir] || {};
        const name = cleanString(info.name) || cleanString(info.gaia_name) || cleanString(info.user_name) || profileDir;
        profiles.push({
            browserId,
            browserLabel,
            profileId: `${browserId}:${profileDir}`,
            name,
            userDataDir,
            profilePath,
            usableForDirectLaunch: false,
        });
    }
}

function parseIniSections(text) {
    const sections = [];
    let current = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(";") || line.startsWith("#")) continue;
        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            current = { section: sectionMatch[1] };
            sections.push(current);
            continue;
        }
        if (!current) continue;
        const equalsIndex = line.indexOf("=");
        if (equalsIndex === -1) continue;
        current[line.slice(0, equalsIndex).trim()] = line.slice(equalsIndex + 1).trim();
    }
    return sections;
}

function scanFirefoxProfiles(profiles, browserId, browserLabel, firefoxRoot) {
    const profilesIni = path.join(firefoxRoot, "profiles.ini");
    const text = readTextFile(profilesIni);
    if (!text) return;

    for (const section of parseIniSections(text)) {
        if (!String(section.section || "").toLowerCase().startsWith("profile")) continue;
        const profilePathValue = cleanString(section.Path);
        if (!profilePathValue) continue;
        const profilePath = section.IsRelative === "1"
            ? path.join(firefoxRoot, profilePathValue)
            : profilePathValue;
        if (!pathExists(profilePath)) continue;
        const name = cleanString(section.Name) || path.basename(profilePath);
        profiles.push({
            browserId,
            browserLabel,
            profileId: `${browserId}:${name}:${profilePath}`,
            name,
            userDataDir: firefoxRoot,
            profilePath,
            usableForDirectLaunch: false,
        });
    }
}

function browserDiscoveryTargets() {
    const home = os.homedir();
    const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
    const roamingAppData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";

    if (process.platform === "darwin") {
        return [
            {
                id: "chrome",
                label: "Google Chrome",
                kind: "channel",
                channel: "chrome",
                browserName: "chromium",
                executablePaths: [
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                    homePath("Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "Google", "Chrome")],
                profileScanner: "chromium",
            },
            {
                id: "chrome-beta",
                label: "Google Chrome Beta",
                kind: "channel",
                channel: "chrome-beta",
                browserName: "chromium",
                executablePaths: [
                    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
                    homePath("Applications", "Google Chrome Beta.app", "Contents", "MacOS", "Google Chrome Beta"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "Google", "Chrome Beta")],
                profileScanner: "chromium",
            },
            {
                id: "chrome-dev",
                label: "Google Chrome Dev",
                kind: "channel",
                channel: "chrome-dev",
                browserName: "chromium",
                executablePaths: [
                    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
                    homePath("Applications", "Google Chrome Dev.app", "Contents", "MacOS", "Google Chrome Dev"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "Google", "Chrome Dev")],
                profileScanner: "chromium",
            },
            {
                id: "chrome-canary",
                label: "Google Chrome Canary",
                kind: "channel",
                channel: "chrome-canary",
                browserName: "chromium",
                executablePaths: [
                    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
                    homePath("Applications", "Google Chrome Canary.app", "Contents", "MacOS", "Google Chrome Canary"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "Google", "Chrome Canary")],
                profileScanner: "chromium",
            },
            {
                id: "msedge",
                label: "Microsoft Edge",
                kind: "channel",
                channel: "msedge",
                browserName: "chromium",
                executablePaths: [
                    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                    homePath("Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "Microsoft Edge")],
                profileScanner: "chromium",
            },
            {
                id: "msedge-beta",
                label: "Microsoft Edge Beta",
                kind: "channel",
                channel: "msedge-beta",
                browserName: "chromium",
                executablePaths: [
                    "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
                    homePath("Applications", "Microsoft Edge Beta.app", "Contents", "MacOS", "Microsoft Edge Beta"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "Microsoft Edge Beta")],
                profileScanner: "chromium",
            },
            {
                id: "msedge-dev",
                label: "Microsoft Edge Dev",
                kind: "channel",
                channel: "msedge-dev",
                browserName: "chromium",
                executablePaths: [
                    "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
                    homePath("Applications", "Microsoft Edge Dev.app", "Contents", "MacOS", "Microsoft Edge Dev"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "Microsoft Edge Dev")],
                profileScanner: "chromium",
            },
            {
                id: "msedge-canary",
                label: "Microsoft Edge Canary",
                kind: "channel",
                channel: "msedge-canary",
                browserName: "chromium",
                executablePaths: [
                    "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
                    homePath("Applications", "Microsoft Edge Canary.app", "Contents", "MacOS", "Microsoft Edge Canary"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "Microsoft Edge Canary")],
                profileScanner: "chromium",
            },
            {
                id: "brave",
                label: "Brave Browser",
                kind: "custom",
                browserName: "chromium",
                executablePaths: [
                    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                    homePath("Applications", "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "BraveSoftware", "Brave-Browser")],
                profileScanner: "chromium",
            },
            {
                id: "firefox",
                label: "Mozilla Firefox",
                kind: "custom",
                browserName: "firefox",
                executablePaths: [
                    "/Applications/Firefox.app/Contents/MacOS/firefox",
                    homePath("Applications", "Firefox.app", "Contents", "MacOS", "firefox"),
                ],
                userDataDirs: [homePath("Library", "Application Support", "Firefox")],
                profileScanner: "firefox",
            },
        ];
    }

    if (process.platform === "win32") {
        return [
            {
                id: "chrome",
                label: "Google Chrome",
                kind: "channel",
                channel: "chrome",
                browserName: "chromium",
                executablePaths: [
                    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
                    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
                    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
                ],
                userDataDirs: [path.join(localAppData, "Google", "Chrome", "User Data")],
                profileScanner: "chromium",
            },
            {
                id: "msedge",
                label: "Microsoft Edge",
                kind: "channel",
                channel: "msedge",
                browserName: "chromium",
                executablePaths: [
                    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
                    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
                    path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
                ],
                userDataDirs: [path.join(localAppData, "Microsoft", "Edge", "User Data")],
                profileScanner: "chromium",
            },
            {
                id: "brave",
                label: "Brave Browser",
                kind: "custom",
                browserName: "chromium",
                executablePaths: [
                    path.join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                    path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                    path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                ],
                userDataDirs: [path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data")],
                profileScanner: "chromium",
            },
            {
                id: "firefox",
                label: "Mozilla Firefox",
                kind: "custom",
                browserName: "firefox",
                executablePaths: [
                    path.join(programFiles, "Mozilla Firefox", "firefox.exe"),
                    path.join(programFilesX86, "Mozilla Firefox", "firefox.exe"),
                    path.join(localAppData, "Mozilla Firefox", "firefox.exe"),
                ],
                userDataDirs: [path.join(roamingAppData, "Mozilla", "Firefox")],
                profileScanner: "firefox",
            },
        ];
    }

    return [
        {
            id: "chrome",
            label: "Google Chrome",
            kind: "channel",
            channel: "chrome",
            browserName: "chromium",
            executablePaths: [
                "/usr/bin/google-chrome",
                "/usr/bin/google-chrome-stable",
                "/opt/google/chrome/chrome",
            ],
            userDataDirs: [homePath(".config", "google-chrome")],
            profileScanner: "chromium",
        },
        {
            id: "msedge",
            label: "Microsoft Edge",
            kind: "channel",
            channel: "msedge",
            browserName: "chromium",
            executablePaths: [
                "/usr/bin/microsoft-edge",
                "/usr/bin/microsoft-edge-stable",
                "/opt/microsoft/msedge/microsoft-edge",
            ],
            userDataDirs: [homePath(".config", "microsoft-edge")],
            profileScanner: "chromium",
        },
        {
            id: "brave",
            label: "Brave Browser",
            kind: "custom",
            browserName: "chromium",
            executablePaths: [
                "/usr/bin/brave-browser",
                "/usr/bin/brave",
                "/snap/bin/brave",
            ],
            userDataDirs: [homePath(".config", "BraveSoftware", "Brave-Browser")],
            profileScanner: "chromium",
        },
        {
            id: "firefox",
            label: "Mozilla Firefox",
            kind: "custom",
            browserName: "firefox",
            executablePaths: [
                "/usr/bin/firefox",
                "/usr/bin/firefox-esr",
                "/snap/bin/firefox",
            ],
            userDataDirs: [homePath(".mozilla", "firefox")],
            profileScanner: "firefox",
        },
    ];
}

function listDesktopBrowsers() {
    const browsers = [];
    const profiles = [];
    addBrowserOption(browsers, {
        id: "managed-chromium",
        label: "WebPilot Chromium",
        kind: "managed",
        available: true,
    });

    for (const target of browserDiscoveryTargets()) {
        const executablePath = firstExisting(target.executablePaths || []);
        const userDataDir = firstExisting(target.userDataDirs || []);
        addBrowserOption(browsers, {
            id: target.id,
            label: target.label,
            kind: target.kind,
            available: Boolean(executablePath),
            channel: target.channel,
            executablePath,
        });

        if (target.profileScanner === "chromium") {
            scanChromiumProfiles(profiles, target.id, target.label, userDataDir);
        }
        if (target.profileScanner === "firefox") {
            scanFirefoxProfiles(profiles, target.id, target.label, userDataDir);
        }
    }

    return {
        platform: process.platform,
        defaultUserDataDir: path.join(desktopRuntimeRootDir(), "browser-profile"),
        browsers,
        profiles,
    };
}

function runtimeSettingsDefaults() {
    const provider = normalizeProvider(
        process.env.MODEL_PROVIDER ||
        process.env.OPENAI_COMPAT_PROVIDER ||
        (process.env.MODEL_BASE_URL || process.env.OPENAI_COMPAT_BASE_URL ? OPENAI_PROVIDER : GEMINI_PROVIDER)
    );
    const providerDefaults = defaultModelsForProvider(provider);
    const navModel = String(
        process.env.MODEL_NAV_MODEL ||
        process.env.GEMINI_NAV_MODEL ||
        process.env.MODEL_MODEL ||
        process.env.GEMINI_MODEL ||
        providerDefaults.navModel
    ).trim();
    const synthModel = String(
        process.env.MODEL_SYNTH_MODEL ||
        process.env.GEMINI_SYNTH_MODEL ||
        providerDefaults.synthModel ||
        navModel
    ).trim();
    const reviewModel = String(
        process.env.MODEL_REVIEW_MODEL ||
        process.env.GEMINI_REVIEW_MODEL ||
        providerDefaults.reviewModel ||
        synthModel
    ).trim();

    return {
        provider,
        apiKey: "",
        baseUrl: cleanBaseUrl(
            process.env.MODEL_BASE_URL ||
            process.env.OPENAI_COMPAT_BASE_URL ||
            defaultBaseUrlForProvider(provider)
        ),
        navModel,
        synthModel,
        reviewModel,
        synthEnabled: boolFromInput(
            process.env.MODEL_SYNTH_ENABLED ?? process.env.GEMINI_SYNTH_ENABLED,
            true
        ),
        browser: sanitizeBrowserSettings(),
    };
}

function sanitizeRuntimeSettings(value) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const defaults = runtimeSettingsDefaults();
    const provider = normalizeProvider(input.provider || defaults.provider);
    const providerDefaults = defaultModelsForProvider(provider);
    return {
        provider,
        apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : defaults.apiKey,
        baseUrl: typeof input.baseUrl === "string" ? cleanBaseUrl(input.baseUrl) : defaultBaseUrlForProvider(provider),
        navModel: typeof input.navModel === "string" && input.navModel.trim() ? input.navModel.trim() : providerDefaults.navModel,
        synthModel: typeof input.synthModel === "string" && input.synthModel.trim() ? input.synthModel.trim() : providerDefaults.synthModel,
        reviewModel: typeof input.reviewModel === "string" && input.reviewModel.trim() ? input.reviewModel.trim() : providerDefaults.reviewModel,
        synthEnabled: boolFromInput(input.synthEnabled, defaults.synthEnabled),
        browser: sanitizeBrowserSettings(input.browser),
    };
}

function resolvedDesktopDataEnv() {
    const defaults = desktopDataEnv();
    return {
        ELECTRON_DESKTOP: process.env.ELECTRON_DESKTOP || defaults.ELECTRON_DESKTOP,
        RUN_STORE_DIR: process.env.RUN_STORE_DIR || defaults.RUN_STORE_DIR,
        THREAD_STORE_DIR: process.env.THREAD_STORE_DIR || defaults.THREAD_STORE_DIR,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || bundledPlaywrightBrowsersPath(),
        PLAYWRIGHT_SKIP_BROWSER_GC: process.env.PLAYWRIGHT_SKIP_BROWSER_GC || "1",
    };
}

function applyDesktopRuntimeEnv() {
    const env = resolvedDesktopDataEnv();
    for (const [key, value] of Object.entries(env)) {
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}

function desktopRuntimeRootDir() {
    const env = resolvedDesktopDataEnv();
    return path.dirname(env.RUN_STORE_DIR);
}

function desktopSettingsFile() {
    return path.join(desktopRuntimeRootDir(), "settings.json");
}

async function readDesktopRuntimeSettings() {
    applyDesktopRuntimeEnv();
    const raw = await fs.readFile(desktopSettingsFile(), "utf8").catch(() => null);
    if (!raw) return runtimeSettingsDefaults();
    try {
        return sanitizeRuntimeSettings(JSON.parse(raw));
    } catch {
        return runtimeSettingsDefaults();
    }
}

async function writeDesktopRuntimeSettings(settings) {
    applyDesktopRuntimeEnv();
    const next = sanitizeRuntimeSettings(settings);
    await ensureDir(desktopRuntimeRootDir());
    await fs.writeFile(desktopSettingsFile(), JSON.stringify(next, null, 2), "utf8");
    return next;
}

class DesktopRuntimeUnavailableError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = "DesktopRuntimeUnavailableError";
        this.cause = cause;
    }
}

function runtimeModulePath(relativePath) {
    if (app.isPackaged) {
        const standalonePath = path.join(process.resourcesPath, "standalone", relativePath);
        if (fsSync.existsSync(standalonePath)) {
            return standalonePath;
        }
    }
    return path.join(app.getAppPath(), relativePath);
}

function compiledRuntimeModulePath(relativePath) {
    if (!app.isPackaged) return "";
    const parsed = path.parse(relativePath);
    const compiledPath = path.join(process.resourcesPath, "standalone", "desktop-runtime", `${parsed.name}.js`);
    return fsSync.existsSync(compiledPath) ? compiledPath : "";
}

let packagedTsHookRegistered = false;
let packagedNodePathsRegistered = false;

function registerPackagedNodeModulePaths() {
    if (packagedNodePathsRegistered || !app.isPackaged) return;
    const Module = require("node:module");
    const candidates = [
        path.join(app.getAppPath(), "node_modules"),
        path.join(process.resourcesPath, "app.asar", "node_modules"),
        path.join(process.resourcesPath, "standalone", "node_modules"),
        path.join(process.resourcesPath, "standalone", ".next", "node_modules"),
        path.join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
    ];
    const existing = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
    process.env.NODE_PATH = [...candidates, ...existing]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join(path.delimiter);
    Module._initPaths();
    packagedNodePathsRegistered = true;
}

function packagedRuntimeRootDir() {
    const standaloneRoot = path.join(process.resourcesPath, "standalone");
    if (fsSync.existsSync(standaloneRoot)) {
        return standaloneRoot;
    }
    return app.getAppPath();
}

function resolveRuntimeSourceCandidate(basePath) {
    const extension = path.extname(basePath);
    const candidates = extension
        ? [basePath]
        : [
            basePath,
            `${basePath}.ts`,
            `${basePath}.tsx`,
            path.join(basePath, "index.ts"),
            path.join(basePath, "index.tsx"),
        ];
    return candidates.find((candidate) => fsSync.existsSync(candidate)) || "";
}

function resolvePackagedRuntimeRequest(request, parent) {
    if (typeof request !== "string") return "";
    if (request.startsWith("@/")) {
        return resolveRuntimeSourceCandidate(path.join(packagedRuntimeRootDir(), request.slice(2)));
    }
    if (!request.startsWith("./") && !request.startsWith("../")) return "";
    const parentDir = parent?.filename ? path.dirname(parent.filename) : packagedRuntimeRootDir();
    return resolveRuntimeSourceCandidate(path.resolve(parentDir, request));
}

function registerPackagedTsHook() {
    if (packagedTsHookRegistered) return;

    const esbuild = require("esbuild");
    const Module = require("node:module");
    const originalResolveFilename = Module._resolveFilename;
    const loaders = {
        ".ts": "ts",
        ".tsx": "tsx",
    };

    Module._resolveFilename = function resolvePackagedRuntimeFilename(request, parent, isMain, options) {
        const runtimeSourcePath = resolvePackagedRuntimeRequest(request, parent);
        if (runtimeSourcePath) {
            return originalResolveFilename.call(this, runtimeSourcePath, parent, isMain, options);
        }
        return originalResolveFilename.call(this, request, parent, isMain, options);
    };

    for (const [extension, loader] of Object.entries(loaders)) {
        Module._extensions[extension] = function compileRuntimeTs(module, filename) {
            const source = fsSync.readFileSync(filename, "utf8");
            const result = esbuild.transformSync(source, {
                loader,
                format: "cjs",
                platform: "node",
                target: "node20",
                sourcemap: "inline",
                tsconfigRaw: {
                    compilerOptions: {
                        esModuleInterop: true,
                        jsx: "react-jsx",
                    },
                },
            });
            module._compile(result.code, filename);
        };
    }

    packagedTsHookRegistered = true;
}

function requireRuntimeModule(relativePath) {
    if (app.isPackaged) {
        registerPackagedNodeModulePaths();
        const compiledPath = compiledRuntimeModulePath(relativePath);
        if (compiledPath) {
            return require(compiledPath);
        }
        const modulePath = runtimeModulePath(relativePath);
        registerPackagedTsHook();
        return require(modulePath);
    }
    const modulePath = runtimeModulePath(relativePath);
    return tsxRequire(modulePath, __filename);
}

function loadDesktopRuntimeModules() {
    applyDesktopRuntimeEnv();
    if (desktopRuntimeModules) return desktopRuntimeModules;
    if (desktopRuntimeLoadError) {
        throw new DesktopRuntimeUnavailableError(desktopRuntimeLoadError.message, desktopRuntimeLoadError);
    }

    try {
        desktopRuntimeModules = {
            agent: requireRuntimeModule("lib/agent.ts"),
            recorder: requireRuntimeModule("lib/recorder.ts"),
            threads: requireRuntimeModule("lib/threads.ts"),
        };
        return desktopRuntimeModules;
    } catch (error) {
        desktopRuntimeLoadError = error instanceof Error ? error : new Error(String(error));
        throw new DesktopRuntimeUnavailableError(desktopRuntimeLoadError.message, desktopRuntimeLoadError);
    }
}

function runtimeLoadStatus() {
    try {
        loadDesktopRuntimeModules();
        return {
            transport: "direct",
            error: null,
        };
    } catch (error) {
        if (error instanceof DesktopRuntimeUnavailableError) {
            return {
                transport: "http-fallback",
                error: error.message,
            };
        }
        throw error;
    }
}

async function withDesktopRuntime(_label, directHandler, fallbackHandler) {
    try {
        const modules = loadDesktopRuntimeModules();
        return await directHandler(modules);
    } catch (error) {
        if (!(error instanceof DesktopRuntimeUnavailableError)) {
            throw error;
        }
        if (!desktopRuntimeFallbackWarned) {
            console.warn("[desktop-runtime] Falling back to local HTTP bridge:", error.message);
            desktopRuntimeFallbackWarned = true;
        }
        return fallbackHandler();
    }
}

function normalizeActionPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {};
    }
    return payload;
}

async function handleAgentGetState() {
    return withDesktopRuntime(
        "agent:get-state",
        async ({ agent }) => {
            const state = agent.getAgentState();
            return {
                ...state,
                logs: state.logs?.slice(-50) || [],
            };
        },
        () => callLocalApi("/api/agent")
    );
}

async function handleAgentAction(payload) {
    return withDesktopRuntime(
        "agent:post-action",
        async ({ agent }) => {
            const body = normalizeActionPayload(payload);
            const action = typeof body.action === "string" ? body.action : "";
            const goal = typeof body.goal === "string" ? body.goal : "";
            const threadId = typeof body.threadId === "string" ? body.threadId : null;
            const runtime = body.runtime && typeof body.runtime === "object" && !Array.isArray(body.runtime)
                ? body.runtime
                : {};

            if (action === "start") {
                const started = await agent.startAgent(goal, runtime, { threadId });
                return { ok: true, ...started };
            }
            if (action === "pause") {
                agent.requestPause();
                return { ok: true };
            }
            if (action === "resume") {
                agent.resumeFromPause();
                return { ok: true };
            }
            if (action === "stop") {
                agent.requestStop();
                return { ok: true };
            }
            throw new Error("Unknown action");
        },
        () => callLocalApi("/api/agent", { method: "POST", body: payload })
    );
}

async function handleRunsList() {
    return withDesktopRuntime(
        "runs:list",
        async ({ recorder }) => ({
            runs: await recorder.listRuns(30),
        }),
        () => callLocalApi("/api/runs")
    );
}

async function handleRunGet(runId) {
    return withDesktopRuntime(
        "runs:get",
        async ({ recorder }) => {
            const run = await recorder.getRunDetail(String(runId || ""));
            if (!run) {
                throw new Error("Run not found");
            }
            return { run };
        },
        () => callLocalApi(`/api/runs/${encodeURIComponent(String(runId || ""))}`)
    );
}

async function handleRunArtifactGet(runId, artifactName) {
    const safeRunId = String(runId || "");
    const safeArtifactName = String(artifactName || "");
    return withDesktopRuntime(
        "runs:get-artifact",
        async ({ recorder }) => {
            const artifact = await recorder.getRunArtifactDetail(safeRunId, safeArtifactName);
            if (!artifact) {
                throw new Error("Artifact not found");
            }
            return { artifact };
        },
        () => callLocalApi(
            `/api/runs/${encodeURIComponent(safeRunId)}/artifacts/${encodeURIComponent(safeArtifactName)}`
        )
    );
}

async function handleThreadsList(limit) {
    return withDesktopRuntime(
        "threads:list",
        async ({ threads }) => ({
            threads: await threads.listThreads(Number(limit) || 20),
        }),
        () => callLocalApi("/api/threads", { query: { limit } })
    );
}

async function handleThreadGet(threadId) {
    return withDesktopRuntime(
        "threads:get",
        async ({ threads }) => {
            const thread = await threads.getThreadDetail(String(threadId || ""));
            if (!thread) {
                throw new Error("Thread not found");
            }
            return { thread };
        },
        () => callLocalApi("/api/threads", { query: { threadId } })
    );
}

async function handleSettingsGet() {
    return {
        runtime: await readDesktopRuntimeSettings(),
    };
}

async function handleSettingsSave(payload) {
    const body = normalizeActionPayload(payload);
    return {
        runtime: await writeDesktopRuntimeSettings(body.runtime),
    };
}

async function startBundledNextServer() {
    if (isDev || nextServerProcess) return;

    const serverPath = standaloneServerPath();
    nextServerProcess = utilityProcess.fork(serverPath, [], {
        env: {
            ...process.env,
            ...resolvedDesktopDataEnv(),
            HOSTNAME: "127.0.0.1",
            PORT: String(DEFAULT_PORT),
        },
        serviceName: "webpilot-server",
    });

    nextServerProcess.on("exit", (code) => {
        if (!shuttingDown && code !== 0) {
            dialog.showErrorBox("WebPilot server stopped", `The bundled Next server exited with code ${code ?? "unknown"}.`);
        }
        nextServerProcess = null;
    });

    await waitForUrl(rendererUrl(), 30000);
}

async function createMainWindow() {
    if (!isDev) {
        await startBundledNextServer();
    }

    mainWindow = new BrowserWindow({
        width: 1320,
        height: 920,
        minWidth: 1080,
        minHeight: 760,
        backgroundColor: "#0C0C0E",
        titleBarStyle: IS_MAC ? "hiddenInset" : "hidden",
        ...(IS_MAC
            ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION }
            : {
                titleBarOverlay: {
                    color: "#0C0C0E",
                    symbolColor: "#A1A1AA",
                    height: TITLEBAR_HEIGHT,
                },
            }),
        autoHideMenuBar: true,
        title: "WebPilot",
        icon: appIconPath(),
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    await mainWindow.loadURL(routeUrl("/"));

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });

    if (process.env.ELECTRON_DEBUG === "1") {
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

async function ensureMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        await createMainWindow();
    }
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
}

async function focusMainWindowAndSend(command, payload = {}) {
    const window = await ensureMainWindow();
    sendDesktopCommand(window, command, payload);
    return { ok: true };
}

async function focusWindowAndSend(command, payload = {}) {
    const focusedWindow = getFocusedCommandWindow();
    if (focusedWindow) {
        sendDesktopCommand(focusedWindow, command, payload);
        focusedWindow.show();
        focusedWindow.focus();
        return { ok: true };
    }
    return focusMainWindowAndSend(command, payload);
}

async function triggerAgentAction(action) {
    await handleAgentAction({ action });
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
    }
    return { ok: true };
}

function withDialogError(label, handler) {
    return async () => {
        try {
            await handler();
        } catch (error) {
            dialog.showErrorBox(
                `WebPilot ${label} failed`,
                error instanceof Error ? error.message : String(error)
            );
        }
    };
}

function buildApplicationMenu() {
    const template = [
        ...(process.platform === "darwin"
            ? [{
                label: app.name,
                submenu: [
                    { role: "about" },
                    { type: "separator" },
                    { role: "services" },
                    { type: "separator" },
                    { role: "hide" },
                    { role: "hideOthers" },
                    { role: "unhide" },
                    { type: "separator" },
                    { role: "quit" },
                ],
            }]
            : []),
        { role: "editMenu" },
        {
            label: "File",
            submenu: [
                {
                    label: "Command Palette",
                    accelerator: "CmdOrCtrl+K",
                    click: withDialogError("command palette", () => focusWindowAndSend("open-command-palette")),
                },
                { type: "separator" },
                {
                    label: "New Thread",
                    accelerator: "CmdOrCtrl+N",
                    click: withDialogError("new thread", () => focusMainWindowAndSend("new-thread")),
                },
                {
                    label: "Focus Task Box",
                    accelerator: "CmdOrCtrl+L",
                    click: withDialogError("focus task", () => focusMainWindowAndSend("focus-task")),
                },
                {
                    label: "Open Settings",
                    accelerator: "CmdOrCtrl+,",
                    click: withDialogError("open settings", async () => {
                        const win = await ensureMainWindow();
                        sendDesktopCommand(win, "navigate", { view: "settings" });
                    }),
                },
                { type: "separator" },
                {
                    label: "Open Library",
                    accelerator: "CmdOrCtrl+2",
                    click: withDialogError("open library", async () => {
                        const win = await ensureMainWindow();
                        sendDesktopCommand(win, "navigate", { view: "library" });
                    }),
                },
                {
                    label: "Open Activity",
                    accelerator: "CmdOrCtrl+3",
                    click: withDialogError("open activity", async () => {
                        const win = await ensureMainWindow();
                        sendDesktopCommand(win, "navigate", { view: "activity" });
                    }),
                },
                {
                    label: "Show Home",
                    accelerator: "CmdOrCtrl+1",
                    click: withDialogError("show home", async () => {
                        const win = await ensureMainWindow();
                        sendDesktopCommand(win, "navigate", { view: "home" });
                    }),
                },
            ],
        },
        {
            label: "Run",
            submenu: [
                {
                    label: "Pause",
                    accelerator: "CmdOrCtrl+Shift+P",
                    click: withDialogError("pause", () => triggerAgentAction("pause")),
                },
                {
                    label: "Resume",
                    accelerator: "CmdOrCtrl+Shift+R",
                    click: withDialogError("resume", () => triggerAgentAction("resume")),
                },
                {
                    label: "Stop",
                    accelerator: "CmdOrCtrl+Shift+S",
                    click: withDialogError("stop", () => triggerAgentAction("stop")),
                },
            ],
        },
        {
            label: "View",
            submenu: [
                { role: "reload" },
                { role: "forceReload" },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
            ],
        },
        {
            label: "Window",
            submenu: [
                { role: "minimize" },
                { role: "close" },
                ...(process.platform === "darwin"
                    ? [{ role: "front" }, { type: "separator" }, { role: "window" }]
                    : []),
            ],
        },
    ];

    return Menu.buildFromTemplate(template);
}

function stopBundledNextServer() {
    shuttingDown = true;
    if (nextServerProcess) {
        nextServerProcess.kill();
        nextServerProcess = null;
    }
}

app.whenReady().then(async () => {
    applyDesktopRuntimeEnv();
    Menu.setApplicationMenu(buildApplicationMenu());
    ipcMain.handle("desktop:get-shell-info", () => {
        const runtime = runtimeLoadStatus();
        return {
            platform: process.platform,
            isPackaged: app.isPackaged,
            rendererUrl: rendererUrl(),
            runtimeTransport: runtime.transport,
            runtimeError: runtime.error,
        };
    });
    ipcMain.handle("desktop:agent:get-state", () => handleAgentGetState());
    ipcMain.handle("desktop:agent:post-action", (_event, payload) => handleAgentAction(payload));
    ipcMain.handle("desktop:runs:list", () => handleRunsList());
    ipcMain.handle("desktop:runs:get", (_event, runId) => handleRunGet(runId));
    ipcMain.handle("desktop:runs:get-artifact", (_event, runId, artifactName) => handleRunArtifactGet(runId, artifactName));
    ipcMain.handle("desktop:threads:list", (_event, limit) => handleThreadsList(limit));
    ipcMain.handle("desktop:threads:get", (_event, threadId) => handleThreadGet(threadId));
    ipcMain.handle("desktop:settings:get", () => handleSettingsGet());
    ipcMain.handle("desktop:settings:save", (_event, payload) => handleSettingsSave(payload));
    ipcMain.handle("desktop:browsers:list", () => listDesktopBrowsers());
    ipcMain.handle("desktop:window:show-home", async () => {
        const win = await ensureMainWindow();
        sendDesktopCommand(win, "navigate", { view: "home" });
        return { ok: true };
    });
    ipcMain.handle("desktop:window:open-library", async () => {
        const win = await ensureMainWindow();
        sendDesktopCommand(win, "navigate", { view: "library" });
        return { ok: true };
    });
    ipcMain.handle("desktop:window:open-activity", async () => {
        const win = await ensureMainWindow();
        sendDesktopCommand(win, "navigate", { view: "activity" });
        return { ok: true };
    });
    ipcMain.handle("desktop:window:open-run", async (_event, runId) => {
        const win = await ensureMainWindow();
        sendDesktopCommand(win, "navigate", { view: "activity", runId });
        return { ok: true };
    });
    ipcMain.handle("desktop:window:open-settings", async () => {
        const win = await ensureMainWindow();
        sendDesktopCommand(win, "navigate", { view: "settings" });
        return { ok: true };
    });
    ipcMain.handle("desktop:clipboard:write-text", (_event, text) => {
        clipboard.writeText(String(text || ""));
        return { ok: true };
    });

    try {
        await createMainWindow();
    } catch (error) {
        dialog.showErrorBox(
            "Failed to start WebPilot desktop",
            error instanceof Error ? error.message : String(error)
        );
        app.quit();
    }

    app.on("activate", async () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            await ensureMainWindow();
        }
    });
});

app.on("before-quit", () => {
    stopBundledNextServer();
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        stopBundledNextServer();
        app.quit();
    }
});
