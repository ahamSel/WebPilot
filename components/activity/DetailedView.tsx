"use client";

import { useRef, useEffect, useState } from "react";
import Markdown from "react-markdown";
import { ThreadSelector } from "@/components/chat/ThreadSelector";
import { InputBar } from "@/components/chat/InputBar";
import { StatusBar } from "./StatusBar";
import { StepCard } from "./StepCard";
import { Badge } from "@/components/ui/Badge";
import { useAgentStore } from "@/stores/agent";
import { useUIStore } from "@/stores/ui";
import { useThreadStore } from "@/stores/thread";
import { getRunDetailClient } from "@/lib/desktop-client";

interface HistoricalRun {
  runId: string;
  goal: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  finalResult?: string;
  lastError?: string;
  steps: { step: number; name: string; source?: string; args?: unknown; ok: boolean; error?: string; durationMs?: number; timestamp: string }[];
  logs?: { timestamp: string; level: string; action: string; details?: unknown; duration?: number }[];
  runtime?: { provider: string; navModel: string; synthModel: string; reviewModel: string; synthEnabled: boolean };
}

export function DetailedView() {
  const agentState = useAgentStore((s) => s.state);
  const displayMode = useUIStore((s) => s.displayMode);
  const toggleDisplayMode = useUIStore((s) => s.toggleDisplayMode);
  const activeThread = useThreadStore((s) => s.activeThread);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [historicalRun, setHistoricalRun] = useState<HistoricalRun | null>(null);
  const [runLoadError, setRunLoadError] = useState<string | null>(null);
  const [runSelection, setRunSelection] = useState<{ threadKey: string | null; index: number }>({
    threadKey: null,
    index: -1,
  }); // -1 = latest

  const status = agentState?.status || "idle";
  const isActive = status === "running" || status === "paused";
  const liveThreadId = agentState?.threadId || null;
  const completedLiveBelongsToActiveThread =
    !!activeThreadId && !!liveThreadId && activeThreadId === liveThreadId;
  const hasLiveData =
    isActive ||
    (completedLiveBelongsToActiveThread && (status === "done" || status === "stopped" || status === "error"));

  // Fetch historical run when idle and a thread is selected
  const runs = activeThread?.runs;
  const activeThreadKey = activeThread?.threadId || null;
  const storedSelectedRunIdx = runSelection.threadKey === activeThreadKey ? runSelection.index : -1;
  const selectedRunIdx =
    runs && storedSelectedRunIdx >= 0 && storedSelectedRunIdx < runs.length
      ? storedSelectedRunIdx
      : -1;
  const lastRunId = runs?.length ? runs[runs.length - 1].runId : null;
  const targetRunId = selectedRunIdx >= 0 && runs ? runs[selectedRunIdx]?.runId : lastRunId;
  const latestRun = runs?.length ? runs[runs.length - 1] : null;
  const historicalRunOptions = runs
    ? runs
        .map((run, index) => ({ run, index }))
        .filter(({ index }) => index !== runs.length - 1)
        .reverse()
    : [];

  useEffect(() => {
    if (hasLiveData || !targetRunId) {
      setHistoricalRun(null);
      setRunLoadError(null);
      return;
    }
    let cancelled = false;
    setRunLoadError(null);
    getRunDetailClient(targetRunId)
      .then((data) => {
        if (cancelled) return;
        const run = (data as { run?: HistoricalRun })?.run ?? data;
        setHistoricalRun(run as HistoricalRun);
      })
      .catch((err) => {
        if (cancelled) return;
        setRunLoadError(err?.message || "Failed to load run details");
      });
    return () => { cancelled = true; };
  }, [targetRunId, hasLiveData]);

  // Live data sources
  const liveLogs = agentState?.logs || [];
  const liveFilteredLogs = showDebug
    ? liveLogs
    : liveLogs.filter((l) => l.level === "info" || l.level === "warn" || l.level === "error");
  const liveDebugCount = liveLogs.length - liveLogs.filter((l) => l.level !== "debug").length;

  // Historical data sources
  const histLogs = historicalRun?.logs || [];
  const histFilteredLogs = showDebug
    ? histLogs
    : histLogs.filter((l) => l.level === "info" || l.level === "warn" || l.level === "error");
  const histDebugCount = histLogs.length - histLogs.filter((l) => l.level !== "debug").length;

  // Pick which data to display
  const usingLive = hasLiveData;
  const logs = usingLive ? liveFilteredLogs : histFilteredLogs;
  const debugCount = usingLive ? liveDebugCount : histDebugCount;
  const steps = historicalRun?.steps || [];
  const runtime = usingLive ? agentState?.runtime : historicalRun?.runtime;
  const finalResult = usingLive ? agentState?.finalResult : historicalRun?.finalResult;
  const lastError = usingLive ? agentState?.lastError : historicalRun?.lastError;
  const displayStatus = usingLive ? status : historicalRun?.status || "idle";
  const goal = usingLive ? agentState?.currentGoal : historicalRun?.goal;
  const hasContent = usingLive ? logs.length > 0 : (logs.length > 0 || steps.length > 0);

  useEffect(() => {
    if (scrollRef.current && isActive) {
      scrollRef.current.scrollTop = 0;
    }
  }, [agentState?.step, isActive]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Thread bar + mode toggle */}
      <div className="wp-titlebar grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-wp-border px-4 py-2">
        <div className="min-w-0" />
        <ThreadSelector />
        <div className="flex min-w-0 items-center justify-end">
          <div className="flex items-center bg-wp-surface-raised rounded-[var(--wp-radius-sm)] p-0.5">
            <button
              type="button"
              onClick={() => displayMode !== "simple" && toggleDisplayMode()}
              className={`px-2 py-0.5 text-[11px] rounded-[3px] transition-colors ${
                displayMode === "simple"
                  ? "bg-wp-accent text-white"
                  : "text-wp-text-secondary hover:text-wp-text"
              }`}
            >
              Simple
            </button>
            <button
              type="button"
              onClick={() => displayMode !== "detailed" && toggleDisplayMode()}
              className={`px-2 py-0.5 text-[11px] rounded-[3px] transition-colors ${
                displayMode === "detailed"
                  ? "bg-wp-accent text-white"
                  : "text-wp-text-secondary hover:text-wp-text"
              }`}
            >
              Detailed
            </button>
          </div>
        </div>
      </div>

      {/* Status bar — live only */}
      {hasLiveData && (
        <div className="px-4 pt-3">
          <StatusBar />
        </div>
      )}

      {/* Historical run selector */}
      {!hasLiveData && runs && runs.length > 1 && (
        <div className="flex min-w-0 shrink-0 items-center gap-2 px-4 pt-3">
          <span className="text-[11px] text-wp-text-secondary">Run:</span>
          <select
            value={selectedRunIdx}
            onChange={(e) => setRunSelection({ threadKey: activeThreadKey, index: Number(e.target.value) })}
            className="min-w-0 flex-1 max-w-xl text-[11px] bg-wp-surface border border-wp-border rounded-[var(--wp-radius-sm)] px-1.5 py-0.5 text-wp-text cursor-pointer"
            aria-label="Select historical run"
          >
            <option value={-1}>
              Latest: {latestRun?.userGoal || latestRun?.goal} ({latestRun?.status})
            </option>
            {historicalRunOptions.map(({ run, index }) => (
              <option key={run.runId} value={index}>
                {run.userGoal || run.goal} ({run.status})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Run load error */}
      {runLoadError && (
        <div className="mx-4 mt-3 bg-wp-error/10 border border-wp-error/20 rounded-[var(--wp-radius-md)] px-3 py-2 text-[12px] text-wp-error/90">
          {runLoadError}
        </div>
      )}

      {/* Historical run header */}
      {!hasLiveData && historicalRun && (
        <div className="mx-4 mt-3 bg-wp-surface border border-wp-border rounded-[var(--wp-radius-md)] px-3 py-2">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <Badge tone={displayStatus === "done" ? "success" : displayStatus === "error" ? "error" : "neutral"}>
              {displayStatus}
            </Badge>
            <span className="text-wp-text truncate flex-1">{goal}</span>
            {historicalRun.durationMs && (
              <span className="text-wp-text-secondary text-[11px]">{(historicalRun.durationMs / 1000).toFixed(1)}s</span>
            )}
            <span className="text-wp-text-secondary text-[11px]">{steps.length} steps</span>
          </div>
        </div>
      )}

      {/* Runtime info panel */}
      {runtime && (hasLiveData || historicalRun) && (
        <div className="mx-4 mt-2 flex min-w-0 shrink-0 flex-wrap gap-x-4 gap-y-1 text-[11px] text-wp-text-secondary">
          <span className="min-w-0 break-all"><span className="text-wp-text-secondary/60">Provider:</span> {runtime.provider}</span>
          <span className="min-w-0 break-all"><span className="text-wp-text-secondary/60">Nav:</span> {runtime.navModel}</span>
          {runtime.synthEnabled && (
            <span className="min-w-0 break-all"><span className="text-wp-text-secondary/60">Synth:</span> {runtime.synthModel}</span>
          )}
          <span className="min-w-0 break-all"><span className="text-wp-text-secondary/60">Review:</span> {runtime.reviewModel}</span>
        </div>
      )}

      {/* Card stream */}
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {/* Current goal — live only */}
        {isActive && agentState?.currentGoal && (
          <div className="mb-2 min-w-0 break-words px-1 text-[13px] text-wp-text-secondary">
            <span className="text-wp-text-secondary/60">Goal:</span> {agentState.currentGoal}
          </div>
        )}

        {/* Result card — markdown rendered */}
        {finalResult && (displayStatus === "done" || displayStatus === "stopped") && (
          <div className="bg-wp-surface border-l-2 border-l-wp-accent border border-wp-border rounded-[var(--wp-radius-md)] px-3 py-3 mb-3">
            <div className="wp-prose text-[13px] text-wp-text">
              <Markdown>{finalResult}</Markdown>
            </div>
          </div>
        )}

        {/* Error display */}
        {lastError && (
          <div className="mb-3 overflow-x-auto whitespace-pre-wrap break-all rounded-[var(--wp-radius-md)] border border-wp-error/20 bg-wp-error/10 px-3 py-2 font-mono text-[12px] text-wp-error/90">
            {lastError}
          </div>
        )}

        {/* Log filter toggle */}
        {(usingLive ? liveLogs.length > 0 : histLogs.length > 0) && debugCount > 0 && (
          <div className="flex items-center gap-2 pb-1">
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="text-[11px] text-wp-text-secondary hover:text-wp-text transition-colors"
            >
              {showDebug ? `Hide debug logs (${debugCount})` : `Show all logs (+${debugCount} debug)`}
            </button>
          </div>
        )}

        {/* Step cards from logs (live or historical) — newest first */}
        {logs.length > 0 && [...logs].reverse().map((log, i) => (
          <StepCard
            key={`log-${i}`}
            step={logs.length - i}
            action={log.action}
            duration={log.duration}
            details={log.details}
            level={log.level as "debug" | "info" | "warn" | "error"}
          />
        ))}

        {/* Step cards from historical run steps (when no logs available) */}
        {!usingLive && logs.length === 0 && steps.length > 0 && (
          [...steps].reverse().map((step, i) => (
            <StepCard
              key={`step-${i}`}
              step={steps.length - i}
              action={step.name}
              duration={step.durationMs}
              source={step.source === "llm" ? "llm" : undefined}
              details={step.args}
              ok={step.ok}
              error={step.error}
            />
          ))
        )}

        {/* Empty state */}
        {!hasContent && !hasLiveData && !historicalRun && (
          <div className="flex items-center justify-center h-full text-wp-text-secondary text-sm">
            No activity yet
          </div>
        )}
      </div>

      <InputBar />
    </div>
  );
}
