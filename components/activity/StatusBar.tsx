"use client";

import { Badge } from "@/components/ui/Badge";
import { useAgentStore } from "@/stores/agent";

export function StatusBar() {
  const state = useAgentStore((s) => s.state);
  if (!state) return null;

  const status = state.status;
  const tone =
    status === "running" ? "accent" :
    status === "done" ? "success" :
    status === "paused" ? "warning" :
    status === "error" || state.lastError ? "error" : "neutral";

  const borderColor =
    tone === "accent" ? "border-l-wp-accent" :
    tone === "success" ? "border-l-wp-success" :
    tone === "warning" ? "border-l-wp-warning" :
    tone === "error" ? "border-l-wp-error" : "border-l-wp-border";

  const elapsed = state.startedAt
    ? Math.round(((state.finishedAt ? new Date(state.finishedAt).getTime() : Date.now()) - new Date(state.startedAt).getTime()) / 1000)
    : null;

  const infoCount = state.logs.filter((l) => l.level === "info").length;
  const warnCount = state.logs.filter((l) => l.level === "warn").length;
  const errorCount = state.logs.filter((l) => l.level === "error").length;

  return (
    <div className={`bg-wp-surface border border-wp-border border-l-2 ${borderColor} rounded-[var(--wp-radius-md)] px-3 py-2`}>
      <div className="flex items-center gap-2 text-xs">
        <Badge tone={tone}>{status}</Badge>
        <span className="text-wp-text-secondary">
          Step {state.step}
          {elapsed != null && <> · {elapsed}s</>}
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-2 text-[11px] text-wp-text-secondary">
          {infoCount > 0 && <span>{infoCount} actions</span>}
          {warnCount > 0 && <span className="text-wp-warning">{warnCount} warn</span>}
          {errorCount > 0 && <span className="text-wp-error">{errorCount} errors</span>}
        </span>
      </div>
      {state.lastAction && status === "running" && (
        <div className="text-[11px] text-wp-text-secondary mt-1 truncate">
          Last: {state.lastAction}
        </div>
      )}
    </div>
  );
}
