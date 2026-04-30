"use client";

import { useState } from "react";
import Markdown from "react-markdown";
import { ChevronDown } from "lucide-react";
import { StepChip } from "./StepChip";

interface LogEntry {
  action: string;
  timestamp: string;
}

interface ChatMessageProps {
  role: "user" | "agent";
  content?: string;
  status?: string;
  stepCount?: number;
  recentSteps?: LogEntry[];
  duration?: string;
  error?: string;
  intervention?: string;
}

function ErrorBlock({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = error.length > 200;

  return (
    <div className="mt-1.5 bg-wp-error/10 border border-wp-error/20 rounded-[var(--wp-radius-sm)] overflow-hidden">
      <div
        className={`px-2.5 py-2 text-[12px] text-wp-error/90 font-mono whitespace-pre-wrap break-all overflow-x-auto ${
          !expanded && isLong ? "max-h-24 overflow-hidden" : ""
        }`}
      >
        {error}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-center gap-1 py-1 text-[11px] text-wp-error/70 hover:text-wp-error border-t border-wp-error/20 transition-colors"
        >
          {expanded ? "Show less" : "Show full error"}
          <ChevronDown size={12} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      )}
    </div>
  );
}

export function ChatMessage({
  role,
  content,
  status,
  stepCount,
  recentSteps,
  duration,
  error,
  intervention,
}: ChatMessageProps) {
  if (role === "user") {
    return (
      <div className="flex min-w-0 flex-col items-end gap-1">
        <div className="min-w-0 max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-wp-accent px-3.5 py-2 text-[13px] text-white">
          {content}
        </div>
      </div>
    );
  }

  const isDone = status === "done" || status === "stopped";
  const isError = !!error;
  const isPaused = status === "paused" || !!intervention;
  const isRunning = status === "running";

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div className="min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-bl-sm border border-wp-border bg-wp-surface px-3.5 py-2.5">
        {/* Running state: step counter + recent chips */}
        {isRunning && (
          <>
            <div className="flex min-w-0 items-center gap-2 text-xs text-wp-accent">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-wp-accent animate-pulse" />
              <span className="min-w-0 truncate">{stepCount ?? 0} steps completed</span>
            </div>
            {recentSteps && recentSteps.length > 0 && (
              <div className="mt-1.5 flex min-w-0 flex-col gap-0.5">
                {recentSteps.slice(-3).map((s, i) => (
                  <StepChip
                    key={i}
                    action={s.action}
                    active={i === recentSteps.slice(-3).length - 1}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* Paused / intervention */}
        {isPaused && (
          <div className="flex min-w-0 items-center gap-2 text-xs text-wp-warning">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-wp-warning" />
            <span className="shrink-0">Needs attention</span>
            {intervention && (
              <span className="min-w-0 truncate text-wp-text-secondary">&mdash; {intervention}</span>
            )}
          </div>
        )}

        {/* Error header */}
        {isError && (
          <div className="mb-1.5 flex min-w-0 items-center gap-2 text-xs text-wp-error">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-wp-error" />
            <span className="min-w-0 truncate">Error{stepCount ? ` \u00B7 ${stepCount} steps` : ""}{duration ? ` \u00B7 ${duration}` : ""}</span>
          </div>
        )}

        {/* Done header */}
        {isDone && !isError && (
          <div className="mb-1.5 flex min-w-0 items-center gap-2 text-xs text-wp-success">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-wp-success" />
            <span className="min-w-0 truncate">Done{stepCount ? ` \u00B7 ${stepCount} steps` : ""}{duration ? ` \u00B7 ${duration}` : ""}</span>
          </div>
        )}

        {/* Final content — rendered as markdown */}
        {content && (
          <div className="wp-prose text-[13px] text-wp-text">
            <Markdown>{content}</Markdown>
          </div>
        )}

        {/* Error message — expandable */}
        {error && <ErrorBlock error={error} />}
      </div>
    </div>
  );
}
