/// <reference types="chrome" />

/**
 * The task engine, running in the extension's background service worker.
 *
 * Each tab has its own session: the conversation it shows, at most one running
 * task and any pending confirmation. Tasks keep running when the panel is closed
 * or the user switches tabs; panels are views that connect over a port.
 * Conversations (with each turn's hidden browser memory) are saved locally
 * (conversations.ts) so they can be reopened from History and continued; which
 * conversation a tab shows is kept in chrome.storage.session.
 */

import { TaskCancelledError, TaskFailedError, runTask, type TaskEvent } from "../../lib/core/run-task";
import { loadSettings, modelConfigFor, type ExtensionSettings } from "./settings";
import { clearConversations, deleteConversation, listConversations, loadConversation, newConversationId, saveConversation } from "./conversations";
import type { EngineMessage, LogStep, PanelMessage, SessionState, TraceEntry, Turn } from "./protocol";
import { TabBrowser } from "./tab-browser";

const TAB_KEY_PREFIX = "webpilot.tab.";
const KEEPALIVE_MS = 20_000;
const BROADCAST_THROTTLE_MS = 60;
const TRACE_LIMIT = 400;
const TRACE_TEXT_LIMIT = 400;

/** Trace data, with long strings shortened so conversations stay small. */
function compact(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return value.length > TRACE_TEXT_LIMIT ? `${value.slice(0, TRACE_TEXT_LIMIT)}…` : value;
    if (Array.isArray(value)) return depth > 3 ? `[${value.length} items]` : value.slice(0, 20).map((item) => compact(item, depth + 1));
    if (value && typeof value === "object") {
        if (depth > 3) return "{…}";
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item, depth + 1)]));
    }
    return value;
}

function browserName(): string {
    const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string; version: string }> } }).userAgentData?.brands || [];
    const brand = brands.find((item) => !/not.?a.?brand|chromium/i.test(item.brand)) || brands.find((item) => /chromium/i.test(item.brand));
    return brand ? `${brand.brand} ${brand.version}` : navigator.userAgent;
}

const ACTION_LABELS: Record<string, string> = {
    click: "click",
    type: "type",
    scroll_down: "scroll down",
    scroll_up: "scroll up",
    back: "go back",
    navigate: "open",
    delegate: "hand to Jev",
    scroll: "scroll",
    wait: "wait",
};

export interface RunHooks {
    /** Overrides asking the user (the dev bridge answers confirmations itself). */
    confirm?: (action: string, url: string) => Promise<boolean>;
    onEvent?: (event: TaskEvent) => void;
    /** Per-run settings overrides (the dev bridge compares fast mode on and off). */
    overrides?: Partial<ExtensionSettings>;
}

interface Session {
    state: SessionState;
    createdAt: number;
    controller?: AbortController;
    confirmResolve?: (allowed: boolean) => void;
    broadcastTimer?: ReturnType<typeof setTimeout>;
}

function newId(): string {
    return Math.random().toString(36).slice(2, 10);
}

export class Engine {
    private sessions = new Map<number, Session>();
    private ports = new Map<number, Set<chrome.runtime.Port>>();
    private keepalive: ReturnType<typeof setInterval> | null = null;

    private async session(tabId: number): Promise<Session> {
        const existing = this.sessions.get(tabId);
        if (existing) return existing;
        const key = `${TAB_KEY_PREFIX}${tabId}`;
        const conversationId = (await chrome.storage.session.get(key))[key] as string | undefined;
        const conversation = conversationId ? await loadConversation(conversationId) : null;
        const created = this.sessionFor(tabId, conversation?.id || newConversationId(), conversation?.turns || [], conversation?.createdAt);
        this.sessions.set(tabId, created);
        return created;
    }

    private sessionFor(tabId: number, conversationId: string, turns: Turn[], createdAt = Date.now()): Session {
        // A turn without an end was cut off by a service-worker restart.
        const settled = turns.map((turn) => (turn.finishedAt ? turn : { ...turn, streaming: undefined, error: turn.error || "Interrupted.", finishedAt: Date.now() }));
        chrome.storage.session.set({ [`${TAB_KEY_PREFIX}${tabId}`]: conversationId }).catch(() => {});
        return { state: { tabId, conversationId, turns: settled, running: false, pending: null }, createdAt };
    }

    private persist(session: Session) {
        saveConversation({
            id: session.state.conversationId,
            title: "",
            createdAt: session.createdAt,
            updatedAt: Date.now(),
            turns: session.state.turns,
        }).catch(() => {});
    }

    private async sendHistory(tabId: number) {
        const items = await listConversations();
        const message: EngineMessage = { type: "history", items };
        for (const port of this.ports.get(tabId) || []) {
            try {
                port.postMessage(message);
            } catch {
                // The panel went away.
            }
        }
    }

    private broadcast(session: Session, immediate = false) {
        const send = () => {
            session.broadcastTimer = undefined;
            // Traces stay in the background and in storage; panels don't need them.
            const state = { ...session.state, turns: session.state.turns.map(({ trace: _trace, ...turn }) => turn) };
            const message: EngineMessage = { type: "state", state };
            for (const port of this.ports.get(session.state.tabId) || []) {
                try {
                    port.postMessage(message);
                } catch {
                    // The panel went away; onDisconnect cleans up.
                }
            }
        };
        if (immediate) {
            if (session.broadcastTimer) clearTimeout(session.broadcastTimer);
            send();
        } else if (!session.broadcastTimer) {
            session.broadcastTimer = setTimeout(send, BROADCAST_THROTTLE_MS);
        }
    }

    private updateKeepalive() {
        const running = [...this.sessions.values()].some((session) => session.state.running);
        if (running && !this.keepalive) {
            // Extension API calls reset the service worker's idle timer while a task runs.
            this.keepalive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), KEEPALIVE_MS);
        } else if (!running && this.keepalive) {
            clearInterval(this.keepalive);
            this.keepalive = null;
        }
    }

    async connect(port: chrome.runtime.Port, tabId: number) {
        const ports = this.ports.get(tabId) || new Set<chrome.runtime.Port>();
        ports.add(port);
        this.ports.set(tabId, ports);
        port.onDisconnect.addListener(() => ports.delete(port));
        port.onMessage.addListener((message: PanelMessage) => this.handle(tabId, message));
        this.broadcast(await this.session(tabId), true);
    }

    private async handle(tabId: number, message: PanelMessage) {
        if (message.type === "run") this.run(tabId, message.goal).catch(() => {});
        if (message.type === "stop") await this.stop(tabId);
        if (message.type === "confirm") await this.resolveConfirm(tabId, message.id, message.allowed);
        if (message.type === "clear") await this.clear(tabId);
        if (message.type === "history") await this.sendHistory(tabId);
        if (message.type === "open") await this.open(tabId, message.conversationId);
        if (message.type === "delete") {
            await deleteConversation(message.conversationId);
            await this.sendHistory(tabId);
        }
        if (message.type === "feedback") await this.feedback(tabId, message);
        if (message.type === "clear-history") {
            await clearConversations();
            await this.sendHistory(tabId);
        }
    }

    async run(tabId: number, goal: string, hooks: RunHooks = {}): Promise<Turn> {
        const session = await this.session(tabId);
        if (session.state.running) throw new Error("A task is already running in this tab.");
        const settings = { ...(await loadSettings()), ...hooks.overrides };
        const turn: Turn = { id: newId(), user: goal.trim(), steps: [], startedAt: Date.now() };
        // Unfinished turns are kept too, so "no, it's on Gmail" or "try again" can pick them up.
        const history = session.state.turns.filter((item) => item.answer || item.error).map((item) => ({
            user: item.user,
            assistant: item.answer || (item.error === "Stopped." ? "(Stopped by the user before finishing.)" : `(This request did not finish: ${item.error})`),
            memory: item.memory,
        }));
        session.state = { ...session.state, turns: [...session.state.turns, turn], running: true };
        session.controller = new AbortController();
        this.updateKeepalive();
        this.broadcast(session, true);
        this.persist(session);

        const update = (patch: (current: Turn) => Turn, immediate = false) => {
            session.state = {
                ...session.state,
                turns: session.state.turns.map((item) => (item.id === turn.id ? patch(item) : item)),
            };
            this.broadcast(session, immediate);
        };
        const addStep = (step: Omit<LogStep, "atMs">) => update((current) => ({ ...current, steps: [...current.steps, { ...step, atMs: Date.now() - turn.startedAt }] }));
        const trace: TraceEntry[] = [];
        const addTrace = (kind: string, data?: Record<string, unknown>) => {
            if (trace.length < TRACE_LIMIT) trace.push({ atMs: Date.now() - turn.startedAt, kind, data: data ? compact(data) as Record<string, unknown> : undefined });
        };
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        addTrace("run", {
            extension: chrome.runtime.getManifest().version,
            browser: browserName(),
            model: settings.navModel,
            fastMode: settings.fastMode,
            startUrl: tab?.url,
        });

        const browser = new TabBrowser(tabId, (message) => {
            hooks.onEvent?.({ type: "status", message });
            addStep({ lane: "note", label: message.toLowerCase() });
            addTrace("driver", { mode: "page-scripts", message });
        });
        try {
            if (!settings.apiKey) throw new Error("Connect OpenRouter in Settings first.");
            const result = await runTask({
                goal: turn.user,
                config: modelConfigFor(settings),
                browser,
                history,
                signal: session.controller.signal,
                confirm: (action, url) => new Promise<boolean>((resolve) => {
                    const id = newId();
                    session.state = { ...session.state, pending: { id, action, url } };
                    this.broadcast(session, true);
                    let settled = false;
                    const settle = (allowed: boolean) => {
                        if (settled) return;
                        settled = true;
                        session.confirmResolve = undefined;
                        session.state = { ...session.state, pending: null };
                        addStep({ lane: "note", label: allowed ? "allowed" : "cancelled", detail: action });
                        resolve(allowed);
                    };
                    session.confirmResolve = settle;
                    hooks.confirm?.(action, url).then(settle, () => settle(false));
                }),
                onTrace: addTrace,
                onEvent: (event) => {
                    hooks.onEvent?.(event);
                    if (event.type !== "answer-delta" && event.type !== "answer-reset") {
                        const { type, ...data } = event;
                        addTrace(type, type === "done" ? { mode: event.mode } : data);
                    }
                    if (event.type === "step") {
                        addStep({ lane: event.source, label: ACTION_LABELS[event.action] || event.action, detail: event.detail ? event.detail.slice(0, 140) : undefined });
                    } else if (event.type === "handoff") {
                        addStep({ lane: "note", label: "handing to the model", detail: event.reason });
                    } else if (event.type === "status") {
                        addStep({ lane: "note", label: event.message.toLowerCase() });
                    } else if (event.type === "answer-delta") {
                        update((current) => ({ ...current, streaming: (current.streaming || "") + event.text }));
                    } else if (event.type === "answer-reset") {
                        update((current) => ({ ...current, streaming: undefined }));
                    }
                },
            });
            addTrace("result", { mode: result.mode, steps: result.steps, jevCalls: result.jevCalls, llmCalls: result.llmCalls, durationMs: result.durationMs });
            update((current) => ({ ...current, streaming: undefined, answer: result.answer, mode: result.mode, memory: result.memory, finishedAt: Date.now(), stats: { jevCalls: result.jevCalls, llmCalls: result.llmCalls } }), true);
        } catch (error) {
            const message = error instanceof TaskCancelledError ? "Stopped." : error instanceof Error ? error.message : String(error);
            const memory = error instanceof TaskCancelledError || error instanceof TaskFailedError ? error.memory : undefined;
            addTrace("error", { name: error instanceof Error ? error.name : "Error", message, stack: error instanceof Error ? error.stack?.split("\n").slice(0, 6).join("\n") : undefined });
            update((current) => ({ ...current, streaming: undefined, error: message, memory, finishedAt: Date.now() }), true);
        } finally {
            await browser.detach();
            session.state = { ...session.state, turns: session.state.turns.map((item) => (item.id === turn.id ? { ...item, trace } : item)) };
            session.controller = undefined;
            session.confirmResolve = undefined;
            session.state = { ...session.state, running: false, pending: null };
            this.broadcast(session, true);
            this.persist(session);
            this.updateKeepalive();
        }
        return session.state.turns.find((item) => item.id === turn.id)!;
    }

    /** Saves feedback on an answer (the latest finished one by default). */
    async feedback(tabId: number, message: Extract<PanelMessage, { type: "feedback" }>) {
        const session = await this.session(tabId);
        const turns = session.state.turns;
        const target = message.turnId ? turns.find((item) => item.id === message.turnId) : [...turns].reverse().find((item) => item.finishedAt);
        if (!target) return;
        const note = [target.feedback?.note, message.note?.trim()].filter(Boolean).join("\n");
        const feedback = { rating: message.rating ?? target.feedback?.rating, note: note || undefined, at: Date.now() };
        session.state = { ...session.state, turns: turns.map((item) => (item.id === target.id ? { ...item, feedback } : item)) };
        this.broadcast(session, true);
        this.persist(session);
    }

    async stop(tabId: number) {
        const session = await this.session(tabId);
        session.controller?.abort();
        session.confirmResolve?.(false);
    }

    async resolveConfirm(tabId: number, id: string, allowed: boolean) {
        const session = await this.session(tabId);
        if (session.state.pending?.id === id) session.confirmResolve?.(allowed);
    }

    /** Starts a new conversation in the tab; the old one stays in History. */
    async clear(tabId: number) {
        const session = await this.session(tabId);
        if (session.state.running) return;
        const fresh = this.sessionFor(tabId, newConversationId(), []);
        this.sessions.set(tabId, fresh);
        this.broadcast(fresh, true);
    }

    /** Shows a saved conversation in the tab so it can be continued. */
    async open(tabId: number, conversationId: string) {
        const session = await this.session(tabId);
        if (session.state.running) return;
        const conversation = await loadConversation(conversationId);
        if (!conversation) return;
        const opened = this.sessionFor(tabId, conversation.id, conversation.turns, conversation.createdAt);
        this.sessions.set(tabId, opened);
        this.broadcast(opened, true);
    }

    /** The tab closed: stop its task. */
    async dispose(tabId: number) {
        const session = this.sessions.get(tabId);
        session?.controller?.abort();
        session?.confirmResolve?.(false);
        this.sessions.delete(tabId);
        this.ports.delete(tabId);
        // The conversation itself stays in History.
        await chrome.storage.session.remove(`${TAB_KEY_PREFIX}${tabId}`).catch(() => {});
    }
}
