/// <reference types="chrome" />

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { CdpBrowser } from "../../lib/cdp/driver";
import { TaskCancelledError, runTask, type TaskEvent } from "../../lib/core/run-task";
import { DebuggerTransport, isRestrictedUrl } from "./debugger-transport";
import { connectOpenRouter } from "./openrouter-auth";
import { loadSettings, modelConfigFor, saveSettings, type ExtensionSettings } from "./settings";

interface LogStep {
    lane: "jev" | "llm" | "note";
    label: string;
    detail?: string;
    atMs: number;
}

interface Turn {
    id: number;
    user: string;
    answer?: string;
    error?: string;
    steps: LogStep[];
    startedAt: number;
    finishedAt?: number;
    mode?: "chat" | "fast" | "planner";
    stats?: { jevCalls: number; llmCalls: number };
}

interface PendingConfirm {
    action: string;
    url: string;
    resolve: (allowed: boolean) => void;
}

const EXAMPLES = [
    { text: "Summarize this page", note: "Reads the tab you have open" },
    { text: "Find some recent tents for sale on Kijiji", note: "Searches and compares listings" },
    { text: "What's trending on Hacker News right now?", note: "Opens the site and reads the front page" },
];

const ACTION_LABELS: Record<string, string> = {
    click: "click",
    type: "type",
    scroll_down: "scroll down",
    scroll_up: "scroll up",
    back: "go back",
    navigate: "open",
    scroll: "scroll",
    wait: "wait",
};

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * The tab WebPilot works in: the active tab of this window. When the panel page
 * itself is open as a tab (e.g. in tests), the most recently used web tab instead.
 */
async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && !tab.url?.startsWith(chrome.runtime.getURL(""))) return tab;
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs
        .filter((candidate) => /^https?:/i.test(candidate.url || ""))
        .sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0))[0];
}

function Logo() {
    return <img src="icons/32x32.png" alt="" />;
}

function SendIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
    );
}

function StopIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
        </svg>
    );
}

function GearIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
    );
}

function BackIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
        </svg>
    );
}

function FlightLog({ turn, live }: { turn: Turn; live: boolean }) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(timer);
    }, [live]);
    const elapsed = (turn.finishedAt ?? now) - turn.startedAt;
    if (!turn.steps.length && !live) return null;
    return (
        <div className={`log${live ? " live" : ""}`} aria-live="polite">
            <div className="log-head">
                <span>{live ? "Flying" : turn.mode === "fast" ? "Fast mode" : turn.mode === "planner" ? "Planner" : "Log"}</span>
                <span className="clock">{seconds(elapsed)}</span>
            </div>
            {turn.steps.map((step, index) => (
                <div key={index} className={`step ${step.lane}`}>
                    <span className="lane">{step.lane === "note" ? "··" : step.lane.toUpperCase()}</span>
                    <span className="what">
                        <b>{step.label}</b>
                        {step.detail ? ` ${step.detail}` : ""}
                    </span>
                    <span className="at">{seconds(step.atMs)}</span>
                </div>
            ))}
            {!live && turn.stats && (
                <div className="log-summary">
                    {turn.stats.jevCalls} Jev decision{turn.stats.jevCalls === 1 ? "" : "s"} · {turn.stats.llmCalls} LLM call{turn.stats.llmCalls === 1 ? "" : "s"}
                </div>
            )}
        </div>
    );
}

function ConfirmCard({ pending }: { pending: PendingConfirm }) {
    return (
        <div className="confirm" role="alertdialog" aria-label="Confirm action">
            <h3>Hold on — this can&apos;t be undone</h3>
            <p>
                WebPilot wants to click <span className="action">{pending.action}</span> on {hostOf(pending.url)}.
            </p>
            <div className="row">
                <button className="btn primary" onClick={() => pending.resolve(true)}>Allow</button>
                <button className="btn" onClick={() => pending.resolve(false)}>Cancel</button>
            </div>
        </div>
    );
}

function Settings({ settings, onChange, onClose }: { settings: ExtensionSettings; onChange: (next: ExtensionSettings) => void; onClose: () => void }) {
    const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
    const [connecting, setConnecting] = useState(false);

    const connect = async () => {
        setConnecting(true);
        setStatus(null);
        try {
            const key = await connectOpenRouter();
            onChange({ ...settings, apiKey: key });
            setStatus({ tone: "ok", text: "Connected to OpenRouter." });
        } catch (error) {
            setStatus({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setConnecting(false);
        }
    };

    return (
        <div className="settings">
            <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
                <button className="icon-button" onClick={onClose} aria-label="Back"><BackIcon /></button>
                <h2 style={{ margin: 0 }}>Settings</h2>
            </div>

            <div className="section">
                <span className="label">OpenRouter</span>
                <button className="btn primary block" onClick={connect} disabled={connecting}>
                    {connecting ? "Waiting for OpenRouter…" : settings.apiKey ? "Reconnect OpenRouter" : "Connect OpenRouter"}
                </button>
                <p className="help">One account for Gemini, Claude, GPT and Jev. You approve a key for WebPilot on openrouter.ai and can revoke it there.</p>
                <div className="or">or paste a key</div>
                <input
                    className="input"
                    type="password"
                    placeholder="sk-or-…"
                    value={settings.apiKey}
                    onChange={(event) => onChange({ ...settings, apiKey: event.target.value.trim() })}
                    aria-label="OpenRouter API key"
                />
                {status && <p className={`status-line ${status.tone}`}>{status.text}</p>}
            </div>

            <div className="section">
                <label className="label" htmlFor="model">Model</label>
                <input
                    id="model"
                    className="input"
                    value={settings.navModel}
                    onChange={(event) => onChange({ ...settings, navModel: event.target.value.trim() })}
                    spellCheck={false}
                />
                <p className="help">Any OpenRouter model id with tool calling, e.g. google/gemini-3.8-flash.</p>
            </div>

            <div className="section">
                <div className="toggle" role="switch" aria-checked={settings.fastMode} tabIndex={0}
                    onClick={() => onChange({ ...settings, fastMode: !settings.fastMode })}
                    onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); onChange({ ...settings, fastMode: !settings.fastMode }); } }}>
                    <span className={`switch${settings.fastMode ? " on" : ""}`} />
                    <span>
                        <b>Fast mode (Jev)</b>
                        <span className="help" style={{ display: "block", margin: "2px 0 0" }}>
                            Jev picks each click in about 0.3s; the model only writes text and answers. Falls back to the model when unsure.
                        </span>
                    </span>
                </div>
            </div>

            <div className="privacy">
                WebPilot reads and acts on the tab you ask it to, using Chrome&apos;s debugging bar while it works. Page text is sent to OpenRouter
                (and, in fast mode, to TypeSafe for Jev). It asks before anything irreversible, like buying, sending or deleting.
            </div>
        </div>
    );
}

function App() {
    const [settings, setSettings] = useState<ExtensionSettings | null>(null);
    const [view, setView] = useState<"chat" | "settings">("chat");
    const [turns, setTurns] = useState<Turn[]>([]);
    const [input, setInput] = useState("");
    const [running, setRunning] = useState(false);
    const [pending, setPending] = useState<PendingConfirm | null>(null);
    const [tabTitle, setTabTitle] = useState("");
    const controllerRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const nextId = useRef(1);

    useEffect(() => {
        loadSettings().then(setSettings);
        const refresh = () => activeTab().then((tab) => setTabTitle(tab?.title || ""));
        refresh();
        chrome.tabs.onActivated.addListener(refresh);
        chrome.tabs.onUpdated.addListener(refresh);
        return () => {
            chrome.tabs.onActivated.removeListener(refresh);
            chrome.tabs.onUpdated.removeListener(refresh);
        };
    }, []);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [turns, pending]);

    const updateSettings = (next: ExtensionSettings) => {
        setSettings(next);
        saveSettings(next);
    };

    const updateTurn = (id: number, patch: (turn: Turn) => Turn) => {
        setTurns((current) => current.map((turn) => (turn.id === id ? patch(turn) : turn)));
    };

    const run = useCallback(async (goal: string) => {
        if (!settings || !goal.trim() || running) return;
        if (!settings.apiKey) {
            setView("settings");
            return;
        }
        const id = nextId.current++;
        const startedAt = Date.now();
        const history = turns.filter((turn) => turn.answer).map((turn) => ({ user: turn.user, assistant: turn.answer! }));
        setTurns((current) => [...current, { id, user: goal.trim(), steps: [], startedAt }]);
        setInput("");
        setRunning(true);
        const controller = new AbortController();
        controllerRef.current = controller;
        const addStep = (step: Omit<LogStep, "atMs">) => updateTurn(id, (turn) => ({ ...turn, steps: [...turn.steps, { ...step, atMs: Date.now() - startedAt }] }));

        let transport: DebuggerTransport | null = null;
        try {
            const tab = await activeTab();
            if (!tab?.id || isRestrictedUrl(tab.url)) {
                throw new Error("Open a regular web page in this tab first. Chrome doesn't let extensions control its own pages or the Web Store.");
            }
            transport = await DebuggerTransport.attach(tab.id);
            const result = await runTask({
                goal: goal.trim(),
                config: modelConfigFor(settings),
                browser: new CdpBrowser(transport),
                history,
                signal: controller.signal,
                confirm: (action, url) => new Promise<boolean>((resolve) => {
                    setPending({
                        action,
                        url,
                        resolve: (allowed) => {
                            setPending(null);
                            addStep({ lane: "note", label: allowed ? "allowed" : "cancelled", detail: action });
                            resolve(allowed);
                        },
                    });
                }),
                onEvent: (event: TaskEvent) => {
                    if (event.type === "step") {
                        addStep({ lane: event.source, label: ACTION_LABELS[event.action] || event.action, detail: event.detail ? event.detail.slice(0, 120) : undefined });
                    } else if (event.type === "handoff") {
                        addStep({ lane: "note", label: "handing to the model", detail: event.reason });
                    } else if (event.type === "status") {
                        addStep({ lane: "note", label: event.message.toLowerCase() });
                    }
                },
            });
            updateTurn(id, (turn) => ({ ...turn, answer: result.answer, mode: result.mode, finishedAt: Date.now(), stats: { jevCalls: result.jevCalls, llmCalls: result.llmCalls } }));
        } catch (error) {
            const message = error instanceof TaskCancelledError ? "Stopped." : error instanceof Error ? error.message : String(error);
            updateTurn(id, (turn) => ({ ...turn, error: message, finishedAt: Date.now() }));
        } finally {
            await transport?.detach();
            controllerRef.current = null;
            setPending(null);
            setRunning(false);
        }
    }, [settings, running, turns]);

    const stop = () => {
        controllerRef.current?.abort();
        pending?.resolve(false);
    };

    if (!settings) return null;
    if (view === "settings") {
        return (
            <div className="app">
                <Settings settings={settings} onChange={updateSettings} onClose={() => setView("chat")} />
            </div>
        );
    }

    return (
        <div className="app">
            <header className="header">
                <div className="brand"><Logo />WebPilot</div>
                <div className={`target${running ? " locked" : ""}`} title={tabTitle}>
                    <span className="reticle" />
                    <span>{tabTitle || "No tab"}</span>
                </div>
                <button className="icon-button" onClick={() => setView("settings")} aria-label="Settings"><GearIcon /></button>
            </header>

            <div className="scroll" ref={scrollRef}>
                {!turns.length && (
                    <div className="empty">
                        <h1>Where to?</h1>
                        <p className="sub">Ask about this page or anything on the web. WebPilot works in your current tab and asks before anything irreversible.</p>
                        {EXAMPLES.map((example, index) => (
                            <button key={example.text} className="prompt" style={{ animationDelay: `${80 + index * 60}ms` }} onClick={() => run(example.text)}>
                                {example.text}
                                <small>{example.note}</small>
                            </button>
                        ))}
                        {!settings.apiKey && (
                            <button className="btn primary block" style={{ marginTop: 10 }} onClick={() => setView("settings")}>Connect OpenRouter to start</button>
                        )}
                    </div>
                )}
                {turns.map((turn) => {
                    const live = running && !turn.finishedAt;
                    return (
                        <div className="turn" key={turn.id}>
                            <div className="user-bubble">{turn.user}</div>
                            <FlightLog turn={turn} live={live} />
                            {live && pending && <ConfirmCard pending={pending} />}
                            {turn.answer && (
                                <div className="answer">
                                    <ReactMarkdown components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{turn.answer}</ReactMarkdown>
                                </div>
                            )}
                            {turn.error && <div className="answer error">{turn.error}</div>}
                        </div>
                    );
                })}
            </div>

            <div className="composer">
                <form className="field-wrap" onSubmit={(event) => { event.preventDefault(); run(input); }}>
                    <textarea
                        rows={1}
                        value={input}
                        placeholder={running ? "Working…" : "Ask WebPilot to do something"}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                run(input);
                            }
                        }}
                        disabled={running}
                        aria-label="Message"
                    />
                    {running ? (
                        <button type="button" className="send stop" onClick={stop} aria-label="Stop"><StopIcon /></button>
                    ) : (
                        <button type="submit" className="send" disabled={!input.trim()} aria-label="Send"><SendIcon /></button>
                    )}
                </form>
                <div className="hint">
                    <span>{settings.fastMode ? <span className="mode">⚡ Fast mode</span> : "Model mode"}</span>
                    <span>{settings.navModel.split("/").pop()}</span>
                </div>
            </div>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<App />);
