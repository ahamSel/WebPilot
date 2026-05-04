"use client";

import { Badge } from "@/components/ui/Badge";
import type { RunSummary } from "@/stores/agent";
import { Trash2 } from "lucide-react";

interface RunListProps {
  runs: RunSummary[];
  onSelect: (runId: string) => void;
  onDelete?: (runId: string) => void;
  deletingRunId?: string | null;
}

const statusConfig: Record<string, { icon: string; tone: "success" | "error" | "warning" | "accent" | "neutral" }> = {
  done: { icon: "\u2713", tone: "success" },
  error: { icon: "\u2717", tone: "error" },
  stopped: { icon: "\u2717", tone: "error" },
  paused: { icon: "\u23F8", tone: "warning" },
  running: { icon: "\u25CF", tone: "accent" },
};

function formatDuration(start: string, end?: string): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  return `${Math.round(ms / 1000)}s`;
}

export function RunList({ runs, onSelect, onDelete, deletingRunId }: RunListProps) {
  return (
    <div className="min-w-0 space-y-1">
      {runs.map((run) => {
        const cfg = statusConfig[run.status] || statusConfig.done;
        return (
          <div
            key={run.runId}
            className="w-full min-w-0 rounded-[var(--wp-radius-md)] border border-wp-border bg-wp-surface px-3 py-2 text-left transition-colors hover:bg-wp-surface-raised"
          >
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => onSelect(run.runId)}
                aria-label={`Open run: ${run.userGoal || run.goal}`}
                className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none focus:ring-2 focus:ring-wp-accent/40"
              >
                <Badge tone={cfg.tone}>{cfg.icon} {run.status}</Badge>
                <span className="min-w-0 flex-1 truncate text-[13px] text-wp-text">{run.goal}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-wp-text-secondary">
                  {formatDuration(run.startedAt, run.finishedAt)}
                </span>
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(run.runId)}
                  aria-label={`Delete run: ${run.userGoal || run.goal}`}
                  title="Delete run"
                  disabled={deletingRunId === run.runId}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--wp-radius-sm)] text-wp-text-secondary transition-colors hover:bg-wp-error/10 hover:text-wp-error focus:outline-none focus:ring-2 focus:ring-wp-accent/40 disabled:pointer-events-none disabled:opacity-40"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
