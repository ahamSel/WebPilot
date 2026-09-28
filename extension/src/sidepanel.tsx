/// <reference types="chrome" />

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { connectOpenRouter } from "./openrouter-auth";
import { PANEL_PORT_PREFIX, type ConversationSummary, type EngineMessage, type PanelMessage, type PendingConfirm, type SessionState, type Turn } from "./protocol";
import { loadSettings, saveSettings, type ExtensionSettings } from "./settings";

const EXAMPLES = [
    { text: "Summarize this page", note: "Reads the tab you have open" },
    { text: "Find some recent tents for sale on Kijiji", note: "Searches and compares listings" },
    { text: "What's trending on Hacker News right now?", note: "Opens the site and reads the front page" },
];

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

/** The tab this panel belongs to: from the panel URL, or the active tab as a fallback. */
async function panelTabId(): Promise<number | undefined> {
    const fromUrl = Number(new URLSearchParams(location.search).get("tabId"));
    if (Number.isInteger(fromUrl) && fromUrl > 0) return fromUrl;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
}

function HistoryIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5M12 7v5l3 2" />
        </svg>
    );
}

function TrashIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
        </svg>
    );
}

function relativeTime(timestamp: number): string {
    const minutes = Math.round((Date.now() - timestamp) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return days < 7 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
}

function History({ items, currentId, onOpen, onDelete, onClearAll, onClose }: {
    items: ConversationSummary[] | null;
    currentId?: string;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
    onClearAll: () => void;
    onClose: () => void;
}) {
    return (
        <div className="settings">
            <div className="row" style={{ alignItems: "center", marginBottom: 12 }}>
                <button className="icon-button" onClick={onClose} aria-label="Back"><BackIcon /></button>
                <h2 style={{ margin: 0, flex: 1 }}>History</h2>
                {!!items?.length && <button className="btn" onClick={onClearAll}>Clear all</button>}
            </div>
            {items === null && <p className="help">Loading…</p>}
            {items?.length === 0 && <p className="help">No conversations yet. They are saved on this device only.</p>}
            {items?.map((item) => (
                <div key={item.id} className={`history-item${item.id === currentId ? " current" : ""}`}>
                    <button className="history-open" onClick={() => onOpen(item.id)}>
                        <span className="history-title">{item.title || "Untitled"}</span>
                        <small>{relativeTime(item.updatedAt)} · {item.turnCount} message{item.turnCount === 1 ? "" : "s"}{item.id === currentId ? " · open here" : ""}</small>
                    </button>
                    <button className="icon-button" onClick={() => onDelete(item.id)} aria-label={`Delete ${item.title}`}><TrashIcon /></button>
                </div>
            ))}
            {!!items?.length && <p className="help">Saved on this device only. Opening one continues it in this tab; WebPilot remembers what it did.</p>}
        </div>
    );
}

function ClearIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
        </svg>
    );
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

function ThumbIcon({ down }: { down?: boolean }) {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={down ? { transform: "scaleY(-1)" } : undefined}>
            <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 4-7a2.5 2.5 0 0 1 3 2.6L13.5 10H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 21H7" />
        </svg>
    );
}

/**
 * Thumbs up/down and an optional note on an answer. Saved locally with the
 * conversation and its trace, so problems can be looked into later.
 */
function Feedback({ turn, onSend }: { turn: Turn; onSend: (rating: "up" | "down" | undefined, note?: string) => void }) {
    const [writing, setWriting] = useState(false);
    const [note, setNote] = useState("");
    const rating = turn.feedback?.rating;
    const save = () => {
        if (note.trim()) onSend(undefined, note.trim());
        setNote("");
        setWriting(false);
    };
    return (
        <div className="feedback">
            <div className="feedback-row">
                <button className={`icon-button small${rating === "up" ? " on up" : ""}`} aria-label="Good answer" aria-pressed={rating === "up"} onClick={() => onSend("up")}>
                    <ThumbIcon />
                </button>
                <button
                    className={`icon-button small${rating === "down" ? " on down" : ""}`}
                    aria-label="Something was off"
                    aria-pressed={rating === "down"}
                    onClick={() => {
                        onSend("down");
                        setWriting(true);
                    }}
                >
                    <ThumbIcon down />
                </button>
                {!writing && <button className="link-button" onClick={() => setWriting(true)}>{turn.feedback?.note ? "Add to note" : "Add a note"}</button>}
            </div>
            {turn.feedback?.note && <div className="feedback-note">{turn.feedback.note}</div>}
            {writing && (
                <form className="feedback-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
                    <input
                        autoFocus
                        value={note}
                        placeholder="What was off, or what would be better?"
                        onChange={(event) => setNote(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Escape") setWriting(false); }}
                    />
                    <button className="btn" type="submit">Save</button>
                </form>
            )}
        </div>
    );
}

function ConfirmCard({ pending, onAnswer }: { pending: PendingConfirm; onAnswer: (allowed: boolean) => void }) {
    const signIn = /\bto sign in\b/.test(pending.action);
    return (
        <div className="confirm" role="alertdialog" aria-label="Confirm action">
            <h3>{signIn ? "Hold on — sign in?" : "Hold on — this can\u2019t be undone"}</h3>
            <p>
                WebPilot wants to click <span className="action">{pending.action}</span> on {hostOf(pending.url)}.
            </p>
            <div className="row">
                <button className="btn primary" onClick={() => onAnswer(true)}>Allow</button>
                <button className="btn" onClick={() => onAnswer(false)}>Cancel</button>
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
    const [view, setView] = useState<"chat" | "settings" | "history">("chat");
    const [history, setHistory] = useState<ConversationSummary[] | null>(null);
    const [tabId, setTabId] = useState<number | null>(null);
    const [tabTitle, setTabTitle] = useState("");
    const [session, setSession] = useState<SessionState | null>(null);
    const [input, setInput] = useState("");
    const portRef = useRef<chrome.runtime.Port | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        loadSettings().then(setSettings);
        panelTabId().then((id) => setTabId(id ?? null));
    }, []);

    // Connect to this tab's session in the background engine; reconnect if the
    // service worker restarts.
    useEffect(() => {
        if (tabId === null) return;
        let disposed = false;
        const connect = () => {
            if (disposed) return;
            const port = chrome.runtime.connect({ name: `${PANEL_PORT_PREFIX}${tabId}` });
            port.onMessage.addListener((message: EngineMessage) => {
                if (message.type === "state") setSession(message.state);
                if (message.type === "history") setHistory(message.items);
            });
            port.onDisconnect.addListener(() => {
                portRef.current = null;
                setTimeout(connect, 300);
            });
            portRef.current = port;
        };
        connect();
        const refreshTitle = () => chrome.tabs.get(tabId).then((tab) => setTabTitle(tab.title || "")).catch(() => {});
        refreshTitle();
        const onUpdated = (updatedId: number) => {
            if (updatedId === tabId) refreshTitle();
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        return () => {
            disposed = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            portRef.current?.disconnect();
        };
    }, [tabId]);

    const running = !!session?.running;
    const turns: Turn[] = session?.turns || [];

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [session]);

    // Ready to type as soon as the panel opens and after each answer.
    useEffect(() => {
        if (!running && view === "chat") inputRef.current?.focus();
    }, [running, view, settings]);

    const send = (message: PanelMessage) => portRef.current?.postMessage(message);

    const run = (goal: string) => {
        // "/feedback ..." (or "/fb ...") notes something about the last answer without running a task.
        const feedbackNote = goal.trim().match(/^\/(?:feedback|fb)\b\s*([\s\S]*)$/i);
        if (feedbackNote) {
            if (feedbackNote[1].trim()) send({ type: "feedback", note: feedbackNote[1].trim() });
            setInput("");
            return;
        }
        if (!settings || !goal.trim() || running) return;
        if (!settings.apiKey) {
            setView("settings");
            return;
        }
        send({ type: "run", goal: goal.trim() });
        setInput("");
    };

    const updateSettings = (next: ExtensionSettings) => {
        setSettings(next);
        saveSettings(next);
    };

    if (!settings) return null;
    if (view === "history") {
        return (
            <div className="app">
                <History
                    items={history}
                    currentId={session?.conversationId}
                    onOpen={(conversationId) => {
                        send({ type: "open", conversationId });
                        setView("chat");
                    }}
                    onDelete={(conversationId) => send({ type: "delete", conversationId })}
                    onClearAll={() => send({ type: "clear-history" })}
                    onClose={() => setView("chat")}
                />
            </div>
        );
    }
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
                    <span>{tabTitle || "This tab"}</span>
                </div>
                {turns.length > 0 && !running && (
                    <button className="icon-button" onClick={() => send({ type: "clear" })} aria-label="New conversation" title="New conversation"><ClearIcon /></button>
                )}
                {!running && (
                    <button className="icon-button" onClick={() => { setHistory(null); send({ type: "history" }); setView("history"); }} aria-label="History" title="History"><HistoryIcon /></button>
                )}
                <button className="icon-button" onClick={() => setView("settings")} aria-label="Settings"><GearIcon /></button>
            </header>

            <div className="scroll" ref={scrollRef}>
                {!turns.length && (
                    <div className="empty">
                        <h1>Where to?</h1>
                        <p className="sub">Ask about this page or anything on the web. WebPilot works in this tab and asks before anything irreversible.</p>
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
                    const text = turn.answer || turn.streaming;
                    return (
                        <div className="turn" key={turn.id}>
                            <div className="user-bubble">{turn.user}</div>
                            <FlightLog turn={turn} live={live} />
                            {live && session?.pending && (
                                <ConfirmCard pending={session.pending} onAnswer={(allowed) => send({ type: "confirm", id: session.pending!.id, allowed })} />
                            )}
                            {text && (
                                <div className={`answer${turn.answer ? "" : " streaming"}`}>
                                    <ReactMarkdown components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{text}</ReactMarkdown>
                                </div>
                            )}
                            {turn.error && <div className="answer error">{turn.error}</div>}
                            {turn.finishedAt && (turn.answer || turn.error) && (
                                <Feedback turn={turn} onSend={(rating, note) => send({ type: "feedback", turnId: turn.id, rating, note })} />
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="composer">
                <form className="field-wrap" onSubmit={(event) => { event.preventDefault(); run(input); }}>
                    <textarea
                        ref={inputRef}
                        rows={1}
                        value={input}
                        placeholder={running ? "Working…" : "Ask WebPilot to do something"}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                run(input);
                            }
                            if (event.key === "Escape" && running) send({ type: "stop" });
                        }}
                        disabled={running}
                        aria-label="Message"
                    />
                    {running ? (
                        <button type="button" className="send stop" onClick={() => send({ type: "stop" })} aria-label="Stop"><StopIcon /></button>
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
