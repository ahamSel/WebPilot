"use client";

import { useRef, useEffect } from "react";
import { ThreadSelector } from "./ThreadSelector";
import { ChatMessage } from "./ChatMessage";
import { InputBar } from "./InputBar";
import { useAgentStore } from "@/stores/agent";
import { useThreadStore } from "@/stores/thread";
import { useUIStore } from "@/stores/ui";

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.round((end - start) / 1000);
  return `${seconds}s`;
}

export function ChatView() {
  const agentState = useAgentStore((s) => s.state);
  const runs = useAgentStore((s) => s.runs);
  const activeThread = useThreadStore((s) => s.activeThread);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const fetchActiveThread = useThreadStore((s) => s.fetchActiveThread);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const displayMode = useUIStore((s) => s.displayMode);
  const toggleDisplayMode = useUIStore((s) => s.toggleDisplayMode);
  const scrollRef = useRef<HTMLDivElement>(null);

  const status = agentState?.status || "idle";
  const isActive = status === "running" || status === "paused";
  const liveThreadId = agentState?.threadId || null;
  const liveRunId = agentState?.runDir?.split(/[\\/]/).pop() || null;
  const completedLiveBelongsToActiveThread =
    !!activeThreadId && !!liveThreadId && activeThreadId === liveThreadId;
  const showCompletedLiveRun =
    completedLiveBelongsToActiveThread &&
    (status === "done" || status === "stopped" || status === "error") &&
    !!agentState &&
    (!!agentState.finalResult || !!agentState.lastError);
  const visibleThreadRuns = (activeThread?.runs || []).filter((run) => {
    return !showCompletedLiveRun || !liveRunId || run.runId !== liveRunId;
  });

  // Auto-scroll to bottom when new steps arrive
  useEffect(() => {
    if (scrollRef.current && isActive) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [agentState?.step, isActive]);

  useEffect(() => {
    if (!activeThreadId) return;
    fetchActiveThread();
    fetchThreads();
  }, [activeThreadId, agentState?.finishedAt, runs.length, fetchActiveThread, fetchThreads]);

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

      {/* Chat area */}
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Prior thread turns */}
        {visibleThreadRuns.map((run) => (
          <div key={run.runId} className="space-y-3">
            <ChatMessage role="user" content={run.userGoal || run.goal} />
            <ChatMessage
              role="agent"
              content={run.finalResult || undefined}
              error={run.lastError || undefined}
              status={run.status}
            />
          </div>
        ))}

        {/* Current live run */}
        {isActive && agentState && (
          <div className="space-y-3">
            {agentState.currentGoal && (
              <ChatMessage role="user" content={agentState.currentGoal} />
            )}
            <ChatMessage
              role="agent"
              status={status}
              stepCount={agentState.step}
              recentSteps={agentState.logs
                .filter((l) => l.level === "info")
                .map((l) => ({ action: l.action, timestamp: l.timestamp }))}
              intervention={agentState.intervention || undefined}
              duration={formatDuration(agentState.startedAt)}
            />
          </div>
        )}

        {/* Completed current run */}
        {showCompletedLiveRun && (
          <div className="space-y-3">
            {agentState.currentGoal && (
              <ChatMessage role="user" content={agentState.currentGoal} />
            )}
            <ChatMessage
              role="agent"
              status={status}
              stepCount={agentState.step}
              content={agentState.finalResult || undefined}
              error={agentState.lastError || undefined}
              duration={formatDuration(agentState.startedAt, agentState.finishedAt)}
            />
          </div>
        )}

        {/* Empty state */}
        {!isActive && !showCompletedLiveRun && !visibleThreadRuns.length && (
          <div className="flex items-center justify-center h-full text-wp-text-secondary text-sm">
            What would you like to do?
          </div>
        )}
      </div>

      <InputBar />
    </div>
  );
}
