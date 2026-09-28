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
import { listConversations, loadConversation } from "./conversations";
import type { Engine } from "./engine";

declare const __DEV_BRIDGE_TOKEN__: string;
declare const __DEV_BUILD_ID__: string;

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
    /** Follow-up messages sent after the first answer, in the same tab and conversation. */
    followUps?: string[];
}

type Command = RunCommand
    | { id: string; type: "reload" }
    | { id: string; type: "ping" }
    | { id: string; type: "targets"; url: string }
    | { id: string; type: "last"; index?: number }
    | { id: string; type: "feedback"; limit?: number };

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
    let answerStarted = false;
    const hooks = {
        overrides: typeof command.fastMode === "boolean" ? { fastMode: command.fastMode } : undefined,
        // The task reports the confirmation itself (a "confirm" event); just answer it.
        confirm: async () => command.confirm === "allow",
        onEvent: (event: TaskEvent) => {
            if (event.type === "answer-delta") {
                // Only when the answer starts showing, for timing.
                if (answerStarted) return;
                answerStarted = true;
                post("/bridge/event", { id: command.id, event: { type: "answer-start" } }).catch(() => {});
                return;
            }
            if (event.type === "answer-reset") answerStarted = false;
            post("/bridge/event", { id: command.id, event }).catch(() => {});
        },
    };
    const started = Date.now();
    try {
        const turns = [];
        for (const message of [command.goal, ...(command.followUps || [])]) {
            if (turns.length) post("/bridge/event", { id: command.id, event: { type: "status", message: `Follow-up: ${message}` } }).catch(() => {});
            const turnStarted = Date.now();
            answerStarted = false;
            const turn = await engine.run(tabId, message, hooks);
            turns.push({ user: message, answer: turn.answer || "", error: turn.error, mode: turn.mode, stats: turn.stats, durationMs: Date.now() - turnStarted });
        }
        const last = turns[turns.length - 1];
        await post("/bridge/result", {
            id: command.id,
            answer: last.answer,
            error: last.error,
            mode: last.mode,
            stats: last.stats,
            steps: turns.length,
            durationMs: Date.now() - started,
            ...(turns.length > 1 ? { turns } : {}),
        });
    } catch (error) {
        await post("/bridge/result", { id: command.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
        if (!command.keepOpen && window?.id !== undefined) await chrome.windows.remove(window.id).catch(() => {});
    }
}

/**
 * Opens `url` in a new window and reports the debug targets that appeared with
 * it (frames, workers), to see what stops chrome.debugger on a page.
 */
async function targetsCommand(command: { id: string; url: string }) {
    const key = (target: chrome.debugger.TargetInfo) => `${target.type} ${target.id}`;
    const before = new Set((await chrome.debugger.getTargets()).map(key));
    const window = await chrome.windows.create({ url: command.url, focused: false, width: 1280, height: 860 });
    const tabId = window?.tabs?.[0]?.id;
    try {
        if (tabId !== undefined) await waitForTabComplete(tabId);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const targets = (await chrome.debugger.getTargets())
            .filter((target) => !before.has(key(target)) || target.tabId === tabId)
            .map(({ type, url, title, attached, tabId: targetTab, extensionId }) => ({ type, url: url.slice(0, 160), title, attached, tabId: targetTab, extensionId }));
        let attachError = "";
        if (tabId !== undefined) {
            try {
                await chrome.debugger.attach({ tabId }, "1.3");
                await chrome.debugger.detach({ tabId });
            } catch (error) {
                attachError = error instanceof Error ? error.message : String(error);
            }
        }
        await post("/bridge/result", { id: command.id, targets, attachError });
    } finally {
        if (window?.id !== undefined) await chrome.windows.remove(window.id).catch(() => {});
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
                await post("/bridge/result", { id: command.id, client, version: chrome.runtime.getManifest().version, build: __DEV_BUILD_ID__ }).catch(() => {});
            } else if (command.type === "reload") {
                await post("/bridge/result", { id: command.id, reloading: true }).catch(() => {});
                chrome.runtime.reload();
            } else if (command.type === "run") {
                runCommand(engine, command).catch(() => {});
            } else if (command.type === "last") {
                // The user's most recent conversations, to debug a run they did by hand.
                const summaries = await listConversations();
                const summary = summaries[command.index || 0];
                const conversation = summary ? await loadConversation(summary.id) : null;
                await post("/bridge/result", { id: command.id, recent: summaries.slice(0, 5), conversation }).catch(() => {});
            } else if (command.type === "feedback") {
                // Answers the user rated or commented on, newest first, with their traces
                // and the turns just before them for context.
                const items = [];
                for (const summary of await listConversations()) {
                    const conversation = await loadConversation(summary.id);
                    for (const [index, turn] of (conversation?.turns || []).entries()) {
                        if (!turn.feedback) continue;
                        const earlier = conversation!.turns.slice(Math.max(0, index - 2), index).map((item) => ({ user: item.user, answer: item.answer?.slice(0, 400), error: item.error }));
                        items.push({ conversationId: summary.id, conversationTitle: summary.title, earlier, turn });
                    }
                }
                items.sort((left, right) => (right.turn.feedback?.at || 0) - (left.turn.feedback?.at || 0));
                await post("/bridge/result", { id: command.id, items: items.slice(0, command.limit || 20) }).catch(() => {});
            } else if (command.type === "targets") {
                targetsCommand(command).catch((error) => post("/bridge/result", { id: command.id, error: String(error) }).catch(() => {}));
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
