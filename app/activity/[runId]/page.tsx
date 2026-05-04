"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Markdown from "react-markdown";
import {
    copyTextClient,
    getDesktopShellInfo,
    getRunArtifactClient,
    getRunDetailClient,
    openActivityWindowClient,
    openHomeWindowClient,
    type DesktopShellInfo,
} from "@/lib/desktop-client";

interface RunLogEntry {
    timestamp: string;
    level: "debug" | "info" | "warn" | "error";
    action: string;
    details?: unknown;
    duration?: number;
}

interface RunStep {
    step: number;
    name: string;
    source?: "llm";
    args?: unknown;
    ok: boolean;
    error?: string;
    durationMs?: number;
    observationSnippet?: string;
    preUrl?: string;
    postUrl?: string;
    postTitle?: string;
    timestamp: string;
}

interface RunDetail {
    runId: string;
    runDir: string;
    goal: string;
    userGoal?: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    finalResult?: string;
    lastError?: string;
    model?: string;
    threadId?: string;
    threadTitle?: string;
    threadTurn?: number;
    plannerContext?: string;
    runtime?: Record<string, unknown>;
    performance?: Record<string, unknown>;
    threadContext?: string | null;
    logs: RunLogEntry[];
    steps: RunStep[];
    artifacts: string[];
}

interface RunArtifactDetail {
    runId: string;
    name: string;
    kind: "json" | "text" | "html" | "binary";
    mimeType: string;
    sizeBytes: number;
    modifiedAt?: string;
    step?: number;
    content: string;
    truncated: boolean;
    renderedHtml?: string | null;
}

function formatDate(timestamp?: string) {
    if (!timestamp) return "—";
    return new Date(timestamp).toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatTime(timestamp: string) {
    return new Date(timestamp).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function formatDurationMs(value?: number) {
    if (!value || value <= 0) return "—";
    if (value < 1000) return `${value}ms`;
    return `${(value / 1000).toFixed(1)}s`;
}

function formatValue(value: unknown) {
    if (value === null || value === undefined) return "—";
    if (typeof value === "number") {
        return Number.isFinite(value) ? value.toLocaleString("en-US") : String(value);
    }
    if (typeof value === "boolean") {
        return value ? "Yes" : "No";
    }
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function prettyJson(value: unknown) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

const PERFORMANCE_LABELS: Record<string, string> = {
    wallClockMs: "Wall clock",
    totalSteps: "Total steps",
    llmCallCount: "LLM calls",
    llmDurationMs: "LLM time",
    initialPlannerCalls: "Initial planner calls",
    loopPlannerCalls: "Loop planner calls",
    synthCallCount: "Synth calls",
    synthDurationMs: "Synth time",
    coordinatorCallCount: "Coordinator calls",
    coordinatorDurationMs: "Coordinator time",
};

function formatSize(sizeBytes?: number) {
    if (!sizeBytes || sizeBytes <= 0) return "—";
    if (sizeBytes < 1024) return `${sizeBytes} B`;
    if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactStepNumber(name: string) {
    const match = /^step(\d+)_/i.exec(name);
    if (!match) return undefined;
    return Number(match[1]);
}

function artifactLabel(name: string) {
    const normalized = name
        .replace(/^step\d+_/i, "")
        .replace(/\.[^.]+$/, "")
        .replace(/_/g, " ")
        .trim()
        .toLowerCase();
    if (!normalized) return name;
    if (normalized === "observe") return "Observe snapshot";
    if (normalized === "dom") return "DOM snapshot";
    return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

function groupArtifacts(artifactNames: string[]) {
    const runLevel: string[] = [];
    const steps = new Map<number, string[]>();

    for (const artifact of artifactNames) {
        const step = artifactStepNumber(artifact);
        if (typeof step !== "number") {
            runLevel.push(artifact);
            continue;
        }
        const list = steps.get(step) || [];
        list.push(artifact);
        steps.set(step, list);
    }

    return {
        runLevel,
        steps: Array.from(steps.entries()).sort((a, b) => a[0] - b[0]),
    };
}

function safeParseJson(value: string) {
    try {
        return JSON.parse(value) as Record<string, unknown>;
    } catch {
        return null;
    }
}

export default function RunDetailPage() {
    const params = useParams<{ runId: string }>();
    const router = useRouter();
    const [desktopShell, setDesktopShell] = useState<DesktopShellInfo | null>(null);
    const [run, setRun] = useState<RunDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [toast, setToast] = useState<string | null>(null);
    const [selectedArtifact, setSelectedArtifact] = useState("");
    const [artifactPreview, setArtifactPreview] = useState<RunArtifactDetail | null>(null);
    const [artifactLoading, setArtifactLoading] = useState(false);
    const [artifactError, setArtifactError] = useState("");

    const runIdParam = params?.runId;
    const runId = decodeURIComponent(Array.isArray(runIdParam) ? runIdParam[0] : runIdParam || "");

    useEffect(() => {
        getDesktopShellInfo()
            .then((info) => setDesktopShell(info))
            .catch((loadError) => console.error(loadError));
    }, []);

    useEffect(() => {
        if (!runId) {
            setError("Run not found.");
            setLoading(false);
            return;
        }

        let cancelled = false;

        const loadRun = async () => {
            try {
                const json = await getRunDetailClient(runId);
                if (cancelled) return;
                setRun((json?.run || null) as RunDetail | null);
                setError("");
            } catch (loadError) {
                if (cancelled) return;
                setError(loadError instanceof Error ? loadError.message : "Failed to load run.");
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        loadRun().catch((loadError) => console.error(loadError));

        return () => {
            cancelled = true;
        };
    }, [runId]);

    const runStatus = run?.status;

    useEffect(() => {
        if (!runId) return;
        if (!runStatus || !["running", "paused", "stopping"].includes(runStatus)) return;

        const intervalId = window.setInterval(async () => {
            try {
                const json = await getRunDetailClient(runId);
                setRun((json?.run || null) as RunDetail | null);
            } catch (loadError) {
                console.error(loadError);
            }
        }, 3000);

        return () => window.clearInterval(intervalId);
    }, [runId, runStatus]);

    useEffect(() => {
        if (!run?.artifacts?.length) {
            setSelectedArtifact("");
            setArtifactPreview(null);
            setArtifactError("");
            return;
        }

        setSelectedArtifact((current) => {
            if (current && run.artifacts.includes(current)) {
                return current;
            }
            return run.artifacts[0] || "";
        });
    }, [run?.artifacts]);

    useEffect(() => {
        if (!runId || !selectedArtifact) {
            setArtifactPreview(null);
            setArtifactError("");
            return;
        }

        let cancelled = false;
        setArtifactLoading(true);
        setArtifactError("");

        getRunArtifactClient(runId, selectedArtifact)
            .then((json) => {
                if (cancelled) return;
                setArtifactPreview((json?.artifact || null) as RunArtifactDetail | null);
            })
            .catch((loadError) => {
                if (cancelled) return;
                setArtifactPreview(null);
                setArtifactError(loadError instanceof Error ? loadError.message : "Failed to load artifact.");
            })
            .finally(() => {
                if (!cancelled) {
                    setArtifactLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [runId, selectedArtifact]);

    const openHome = async () => {
        const opened = await openHomeWindowClient();
        if (!opened) {
            router.push("/");
        }
    };

    const openActivity = async () => {
        const opened = await openActivityWindowClient();
        if (!opened) {
            router.push("/activity");
        }
    };

    const copyFinalResult = async () => {
        if (!run?.finalResult) return;
        await copyTextClient(run.finalResult);
        setToast("Copied the final result.");
        window.setTimeout(() => setToast(null), 3000);
    };

    const performanceEntries = Object.entries(run?.performance || {}).filter(([, value]) => value !== undefined && value !== null);
    const artifactGroups = groupArtifacts(run?.artifacts || []);
    const selectedArtifactJson = artifactPreview?.kind === "json" ? safeParseJson(artifactPreview.content) : null;

    const openArtifact = (artifactName: string) => {
        setSelectedArtifact(artifactName);
        const element = document.getElementById("artifact-preview");
        if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    };

    return (
        <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(125,211,252,0.18),_transparent_28%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_50%,_#f8fafc_100%)] text-slate-900">
            <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
                <div className="space-y-6">
                    <header className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                                <div className="rounded-full border border-slate-200 bg-white px-3 py-1">
                                    Run detail
                                </div>
                                {run && (
                                    <div className="rounded-full border border-slate-200 bg-white px-3 py-1">
                                        {run.status}
                                    </div>
                                )}
                                {desktopShell && (
                                    <div>
                                        Desktop app {desktopShell.isPackaged ? "packaged" : "dev"}
                                        {desktopShell.runtimeTransport === "direct" ? " · direct runtime" : ""}
                                        {desktopShell.runtimeTransport === "http-fallback" ? " · HTTP bridge" : ""}
                                    </div>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => openActivity().catch((loadError) => console.error(loadError))}
                                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                                >
                                    Show activity
                                </button>
                                <button
                                    type="button"
                                    onClick={() => openHome().catch((loadError) => console.error(loadError))}
                                    className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                                >
                                    Show home
                                </button>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                                {run?.userGoal || run?.goal || "Run detail"}
                            </h1>
                            <p className="max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
                                One run, end to end: summary, timing, step trace, and saved artifacts.
                            </p>
                        </div>
                    </header>

                    {loading && !run ? (
                        <section className="rounded-3xl border border-slate-200 bg-white/90 p-6 text-sm text-slate-500 shadow-[0_12px_40px_rgba(15,23,42,0.08)]">
                            Loading run details...
                        </section>
                    ) : null}

                    {error ? (
                        <section className="rounded-3xl border border-rose-200 bg-rose-50/90 p-6 text-sm text-rose-900 shadow-[0_12px_40px_rgba(244,63,94,0.08)]">
                            {error}
                        </section>
                    ) : null}

                    {run ? (
                        <>
                            <section className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-[0_12px_40px_rgba(15,23,42,0.08)]">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="space-y-2">
                                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Run ID</div>
                                        <div className="font-mono text-sm text-slate-700">{run.runId}</div>
                                        <div className="text-sm text-slate-500">
                                            Started {formatDate(run.startedAt)}
                                            {run.finishedAt ? ` · Finished ${formatDate(run.finishedAt)}` : ""}
                                        </div>
                                        {run.threadTitle && (
                                            <div className="text-sm text-slate-600">
                                                Thread: {run.threadTitle}
                                                {typeof run.threadTurn === "number" ? ` · turn ${run.threadTurn}` : ""}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            onClick={() => copyFinalResult().catch((loadError) => console.error(loadError))}
                                            disabled={!run.finalResult}
                                            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Copy result
                                        </button>
                                    </div>
                                </div>

                                <div className="mt-5 grid gap-3 md:grid-cols-4">
                                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Duration</div>
                                        <div className="mt-2 text-sm font-medium text-slate-900">{formatDurationMs(run.durationMs)}</div>
                                    </div>
                                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Steps</div>
                                        <div className="mt-2 text-sm font-medium text-slate-900">{run.steps.length}</div>
                                    </div>
                                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Logs</div>
                                        <div className="mt-2 text-sm font-medium text-slate-900">{run.logs.length}</div>
                                    </div>
                                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Artifacts</div>
                                        <div className="mt-2 text-sm font-medium text-slate-900">{run.artifacts.length}</div>
                                    </div>
                                </div>
                            </section>

                            <section className="grid gap-4 lg:grid-cols-2">
                                <div className="rounded-3xl border border-slate-200 bg-white/80 p-5 shadow-[0_12px_40px_rgba(15,23,42,0.06)]">
                                    <div className="text-sm font-medium text-slate-700">Runtime</div>
                                    <div className="mt-3 space-y-2 text-sm text-slate-600">
                                        <div>Model: {run.model || formatValue(run.runtime?.model)}</div>
                                        <div>Provider: {formatValue(run.runtime?.provider)}</div>
                                        <div>Planner: {formatValue(run.runtime?.navModel)}</div>
                                        <div>Synth: {formatValue(run.runtime?.synthEnabled)}</div>
                                    </div>
                                </div>

                                <div className="rounded-3xl border border-slate-200 bg-white/80 p-5 shadow-[0_12px_40px_rgba(15,23,42,0.06)]">
                                    <div className="text-sm font-medium text-slate-700">Performance</div>
                                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                                        {performanceEntries.slice(0, 6).map(([key, value]) => (
                                            <div key={key} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                                                <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500">
                                                    {PERFORMANCE_LABELS[key] || key}
                                                </div>
                                                <div className="mt-1 font-medium text-slate-900">
                                                    {key.endsWith("Ms") ? formatDurationMs(Number(value || 0)) : formatValue(value)}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </section>

                            {run.finalResult ? (
                                <section className="rounded-3xl border border-emerald-200 bg-emerald-50/80 p-5 shadow-[0_12px_40px_rgba(16,185,129,0.08)]">
                                    <div className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-700">Final result</div>
                                    <div className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-800">
                                        {run.finalResult}
                                    </div>
                                </section>
                            ) : null}

                            {run.lastError ? (
                                <section className="rounded-3xl border border-rose-200 bg-rose-50/80 p-5 shadow-[0_12px_40px_rgba(244,63,94,0.08)]">
                                    <div className="text-sm font-medium uppercase tracking-[0.18em] text-rose-700">Error</div>
                                    <div className="wp-prose wp-prose-error mt-3 text-sm leading-7 text-rose-900">
                                        <Markdown>{run.lastError}</Markdown>
                                    </div>
                                </section>
                            ) : null}

                            <section className="rounded-3xl border border-slate-200 bg-white/80 p-5 shadow-[0_12px_40px_rgba(15,23,42,0.06)]">
                                <div className="text-sm font-medium text-slate-700">Execution steps</div>
                                <div className="mt-4 space-y-3">
                                    {run.steps.length === 0 ? (
                                        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                                            No steps were recorded for this run.
                                        </div>
                                    ) : (
                                        run.steps.map((step) => (
                                            <div key={`${step.step}-${step.timestamp}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                                <div className="flex flex-wrap items-start justify-between gap-3">
                                                    <div>
                                                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">
                                                            Step {step.step}
                                                        </div>
                                                        <div className="mt-1 text-sm font-medium text-slate-900">
                                                            {step.name}
                                                            {step.source ? ` · ${step.source}` : ""}
                                                            {step.ok ? "" : " · failed"}
                                                        </div>
                                                        <div className="mt-1 text-xs text-slate-500">
                                                            {formatTime(step.timestamp)}
                                                            {step.durationMs ? ` · ${formatDurationMs(step.durationMs)}` : ""}
                                                        </div>
                                                    </div>
                                                    {step.postUrl && (
                                                        <div className="max-w-md truncate text-xs text-slate-500">
                                                            {step.postUrl}
                                                        </div>
                                                    )}
                                                </div>
                                                {run.artifacts.some((artifact) => artifactStepNumber(artifact) === step.step) ? (
                                                    <div className="mt-3 flex flex-wrap gap-2">
                                                        {run.artifacts
                                                            .filter((artifact) => artifactStepNumber(artifact) === step.step)
                                                            .map((artifact) => (
                                                                <button
                                                                    key={artifact}
                                                                    type="button"
                                                                    onClick={() => openArtifact(artifact)}
                                                                    className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                                                                        selectedArtifact === artifact
                                                                            ? "border-sky-300 bg-sky-50 text-sky-700"
                                                                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                                                                    }`}
                                                                >
                                                                    {artifactLabel(artifact)}
                                                                </button>
                                                            ))}
                                                    </div>
                                                ) : null}
                                                {step.observationSnippet ? (
                                                    <div className="mt-3 text-sm leading-6 text-slate-700">
                                                        {step.observationSnippet}
                                                    </div>
                                                ) : null}
                                                {step.error ? (
                                                    <div className="wp-prose wp-prose-error mt-3 text-sm text-rose-700">
                                                        <Markdown>{step.error}</Markdown>
                                                    </div>
                                                ) : null}
                                                {(step.args !== undefined || step.preUrl || step.postTitle) ? (
                                                    <details className="mt-3">
                                                        <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.15em] text-slate-500">
                                                            Step details
                                                        </summary>
                                                        <div className="mt-3 space-y-2 text-sm text-slate-600">
                                                            {step.preUrl ? <div>Before: {step.preUrl}</div> : null}
                                                            {step.postTitle ? <div>Title: {step.postTitle}</div> : null}
                                                            {step.args !== undefined ? (
                                                                <pre className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-3 text-xs text-slate-700">
                                                                    {prettyJson(step.args)}
                                                                </pre>
                                                            ) : null}
                                                        </div>
                                                    </details>
                                                ) : null}
                                            </div>
                                        ))
                                    )}
                                </div>
                            </section>

                            <section className="grid gap-4 xl:grid-cols-[1.4fr_0.9fr]">
                                <div className="rounded-3xl border border-slate-200 bg-white/80 shadow-[0_12px_40px_rgba(15,23,42,0.06)] overflow-hidden">
                                    <div className="border-b border-slate-200 px-4 py-3">
                                        <div className="text-sm font-medium text-slate-700">Session logs</div>
                                    </div>
                                    <div className="max-h-[520px] overflow-y-auto p-3 space-y-1 font-mono text-xs">
                                        {run.logs.length === 0 ? (
                                            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-slate-500">
                                                No logs recorded.
                                            </div>
                                        ) : (
                                            run.logs.map((log, index) => (
                                                <div key={`${log.timestamp}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className="text-slate-500">{formatTime(log.timestamp)}</span>
                                                        <span className="font-semibold uppercase text-slate-700">{log.level}</span>
                                                        <span className="font-medium text-slate-900">{log.action}</span>
                                                        {log.duration ? <span className="text-slate-500">({formatDurationMs(log.duration)})</span> : null}
                                                    </div>
                                                    {log.details !== undefined ? (
                                                        <div className="mt-2 whitespace-pre-wrap text-slate-600">{formatValue(log.details)}</div>
                                                    ) : null}
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <section className="rounded-3xl border border-slate-200 bg-white/80 p-5 shadow-[0_12px_40px_rgba(15,23,42,0.06)]">
                                        <div className="text-sm font-medium text-slate-700">Artifacts</div>
                                        <div className="mt-4 space-y-4">
                                            {run.artifacts.length === 0 ? (
                                                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                                                    No artifacts saved.
                                                </div>
                                            ) : (
                                                <>
                                                    {artifactGroups.runLevel.length > 0 ? (
                                                        <div className="space-y-2">
                                                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                                                Run level
                                                            </div>
                                                            <div className="flex flex-wrap gap-2">
                                                                {artifactGroups.runLevel.map((artifact) => (
                                                                    <button
                                                                        key={artifact}
                                                                        type="button"
                                                                        onClick={() => openArtifact(artifact)}
                                                                        className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                                                                            selectedArtifact === artifact
                                                                                ? "border-sky-300 bg-sky-50 text-sky-700"
                                                                                : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                                                                        }`}
                                                                    >
                                                                        {artifactLabel(artifact)}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    ) : null}

                                                    {artifactGroups.steps.map(([stepNumber, artifacts]) => (
                                                        <div key={stepNumber} className="space-y-2">
                                                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                                                Step {stepNumber}
                                                            </div>
                                                            <div className="flex flex-wrap gap-2">
                                                                {artifacts.map((artifact) => (
                                                                    <button
                                                                        key={artifact}
                                                                        type="button"
                                                                        onClick={() => openArtifact(artifact)}
                                                                        className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                                                                            selectedArtifact === artifact
                                                                                ? "border-sky-300 bg-sky-50 text-sky-700"
                                                                                : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                                                                        }`}
                                                                    >
                                                                        {artifactLabel(artifact)}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    ))}

                                                    <div
                                                        id="artifact-preview"
                                                        className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4"
                                                    >
                                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                                            <div>
                                                                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">
                                                                    Preview
                                                                </div>
                                                                <div className="mt-1 text-sm font-medium text-slate-900">
                                                                    {selectedArtifact || "Select an artifact"}
                                                                </div>
                                                            </div>
                                                            {artifactPreview ? (
                                                                <div className="text-right text-xs text-slate-500">
                                                                    <div>{artifactPreview.kind.toUpperCase()}</div>
                                                                    <div>{formatSize(artifactPreview.sizeBytes)}</div>
                                                                </div>
                                                            ) : null}
                                                        </div>

                                                        {artifactLoading ? (
                                                            <div className="mt-4 text-sm text-slate-500">Loading preview...</div>
                                                        ) : null}

                                                        {artifactError ? (
                                                            <div className="mt-4 text-sm text-rose-700">{artifactError}</div>
                                                        ) : null}

                                                        {artifactPreview ? (
                                                            <div className="mt-4 space-y-4">
                                                                <div className="grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
                                                                    <div>Type: {artifactPreview.mimeType}</div>
                                                                    <div>
                                                                        Updated: {artifactPreview.modifiedAt ? formatDate(artifactPreview.modifiedAt) : "—"}
                                                                    </div>
                                                                    <div>
                                                                        Step: {typeof artifactPreview.step === "number" ? artifactPreview.step : "Run"}
                                                                    </div>
                                                                    <div>
                                                                        Truncated: {artifactPreview.truncated ? "Yes" : "No"}
                                                                    </div>
                                                                </div>

                                                                {artifactPreview.kind === "json" && selectedArtifactJson ? (
                                                                    <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
                                                                        {typeof selectedArtifactJson.url === "string" ? (
                                                                            <div className="break-all">
                                                                                URL: {selectedArtifactJson.url}
                                                                            </div>
                                                                        ) : null}
                                                                        {typeof selectedArtifactJson.title === "string" ? (
                                                                            <div>Title: {selectedArtifactJson.title}</div>
                                                                        ) : null}
                                                                        {typeof selectedArtifactJson.text === "string" ? (
                                                                            <div className="text-slate-600">
                                                                                {selectedArtifactJson.text.slice(0, 260)}
                                                                                {selectedArtifactJson.text.length > 260 ? "..." : ""}
                                                                            </div>
                                                                        ) : null}
                                                                    </div>
                                                                ) : null}

                                                                {artifactPreview.kind === "html" && artifactPreview.renderedHtml ? (
                                                                    <div className="space-y-2">
                                                                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                                                            Rendered snapshot
                                                                        </div>
                                                                        <iframe
                                                                            title={`${artifactPreview.name} preview`}
                                                                            srcDoc={artifactPreview.renderedHtml}
                                                                            sandbox=""
                                                                            className="h-64 w-full rounded-2xl border border-slate-200 bg-white"
                                                                        />
                                                                    </div>
                                                                ) : null}

                                                                <div className="space-y-2">
                                                                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                                                        Source
                                                                    </div>
                                                                    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-2xl border border-slate-200 bg-white p-3 text-xs text-slate-700">
                                                                        {artifactPreview.content}
                                                                    </pre>
                                                                </div>
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </section>

                                    {run.threadContext ? (
                                        <section className="rounded-3xl border border-slate-200 bg-white/80 p-5 shadow-[0_12px_40px_rgba(15,23,42,0.06)]">
                                            <div className="text-sm font-medium text-slate-700">Thread context</div>
                                            <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                                                {run.threadContext}
                                            </pre>
                                        </section>
                                    ) : null}

                                </div>
                            </section>
                        </>
                    ) : null}
                </div>
            </div>

            {toast && (
                <div className="fixed bottom-6 right-6 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-lg shadow-slate-900/10">
                    {toast}
                </div>
            )}
        </div>
    );
}
