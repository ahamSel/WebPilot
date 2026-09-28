/// <reference types="chrome" />

/**
 * Dev-only bridge: lets the scenario harness (scripts/extension-bridge.ts) run
 * tasks in the real browser the extension is installed in. Only dev builds
 * (`npm run extension:build:dev`) include it; release builds compile it out.
 *
 * The extension long-polls http://127.0.0.1:4466 and accepts a command only if
 * the response carries the random secret generated for this build, so another
 * local process cannot drive the user's browser. Each task runs in a new window
 * that is closed afterwards, leaving the user's own tabs alone.
 */

import type { TaskEvent } from "../../lib/core/run-task";
import type { Engine } from "./engine";

declare const __DEV_BRIDGE_TOKEN__: string;

const BRIDGE_URL = "http://127.0.0.1:4466";
const RETRY_MS = 3000;

interface RunCommand {
    id: string;
    type: "run";
    goal: string;
    url?: string;
    confirm?: "allow" | "deny";
    fastMode?: boolean;
    keepOpen?: boolean;
}

type Command = RunCommand | { id: string; type: "reload" } | { id: string; type: "ping" };

function browserName(): string {
    const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData?.brands || [];
    const names = brands.map((brand) => brand.brand.toLowerCase());
    if (names.some((name) => name.includes("edge"))) return "edge";
    if (names.some((name) => name.includes("brave"))) return "brave";
    if (names.some((name) => name.includes("opera"))) return "opera";
    if (names.some((name) => name.includes("google chrome"))) return "chrome";
    return "chromium";
}

async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${BRIDGE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webpilot-bridge": __DEV_BRIDGE_TOKEN__ },
        body: JSON.stringify(body),
    });
}

function waitForTabComplete(tabId: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(done, 15_000);
        function done() {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }
        function listener(updatedId: number, change: { status?: string }) {
            if (updatedId === tabId && change.status === "complete") done();
        }
        chrome.tabs.onUpdated.addListener(listener);
    });
}

async function runCommand(engine: Engine, command: RunCommand) {
    const window = await chrome.windows.create({ url: command.url || "about:blank", focused: false, width: 1280, height: 860 });
    const tabId = window?.tabs?.[0]?.id;
    if (tabId === undefined) {
        await post("/bridge/result", { id: command.id, error: "Could not open a test window." });
        return;
    }
    if (command.url) await waitForTabComplete(tabId);
    const started = Date.now();
    try {
        const turn = await engine.run(tabId, command.goal, {
            overrides: typeof command.fastMode === "boolean" ? { fastMode: command.fastMode } : undefined,
            // The task reports the confirmation itself (a "confirm" event); just answer it.
            confirm: async () => command.confirm === "allow",
            onEvent: (event: TaskEvent) => {
                if (event.type === "answer-delta") return;
                post("/bridge/event", { id: command.id, event }).catch(() => {});
            },
        });
        await post("/bridge/result", {
            id: command.id,
            answer: turn.answer || "",
            error: turn.error,
            mode: turn.mode,
            stats: turn.stats,
            steps: turn.steps.length,
            durationMs: Date.now() - started,
        });
    } catch (error) {
        await post("/bridge/result", { id: command.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
        if (!command.keepOpen && window?.id !== undefined) await chrome.windows.remove(window.id).catch(() => {});
    }
}

let polling = false;

async function pollLoop(engine: Engine) {
    if (polling) return;
    polling = true;
    const client = browserName();
    try {
        for (;;) {
            let response: Response;
            try {
                response = await fetch(`${BRIDGE_URL}/bridge/next?client=${client}`, { headers: { "x-webpilot-bridge": __DEV_BRIDGE_TOKEN__ } });
            } catch {
                await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
                continue;
            }
            // Only trust a server that knows this build's secret.
            if (response.status !== 200 || response.headers.get("x-webpilot-bridge") !== __DEV_BRIDGE_TOKEN__) {
                await response.body?.cancel().catch(() => {});
                if (response.status !== 204) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
                continue;
            }
            const command = await response.json() as Command;
            if (command.type === "ping") {
                await post("/bridge/result", { id: command.id, client, version: chrome.runtime.getManifest().version }).catch(() => {});
            } else if (command.type === "reload") {
                await post("/bridge/result", { id: command.id, reloading: true }).catch(() => {});
                chrome.runtime.reload();
            } else if (command.type === "run") {
                runCommand(engine, command).catch(() => {});
            }
        }
    } finally {
        polling = false;
    }
}

export function startDevBridge(engine: Engine) {
    pollLoop(engine);
    // The service worker is suspended when idle; the alarm wakes it to resume polling.
    chrome.alarms.create("webpilot-dev-bridge", { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "webpilot-dev-bridge") pollLoop(engine);
    });
}
