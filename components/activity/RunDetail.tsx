"use client";

import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { getRunDetailClient } from "@/lib/desktop-client";
import { StepCard } from "./StepCard";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

interface RunStep {
  step: number;
  name: string;
  source?: "llm";
  args?: unknown;
  ok: boolean;
  error?: string;
  durationMs?: number;
  timestamp: string;
}

interface RunDetailData {
  runId: string;
  goal: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  finalResult?: string;
  lastError?: string;
  steps: RunStep[];
}

interface RunDetailProps {
  runId: string;
  onBack: () => void;
}

export function RunDetail({ runId, onBack }: RunDetailProps) {
  const [data, setData] = useState<RunDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);
  const [failedOnly, setFailedOnly] = useState(false);

  useEffect(() => {
    getRunDetailClient(runId)
      .then((d) => {
        const run = (d as { run?: RunDetailData })?.run ?? d;
        setData(run as RunDetailData);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load run"));
  }, [runId]);

  if (error) {
    return (
      <div className="p-4">
        <Button variant="ghost" size="sm" onClick={onBack}>&larr; Back</Button>
        <div className="mt-4 px-3 py-2 bg-wp-error/10 border border-wp-error/20 rounded-[var(--wp-radius-sm)] text-sm text-wp-error">
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-4 text-wp-text-secondary text-sm">Loading run...</div>
    );
  }

  const steps = data.steps || [];
  const failedCount = steps.filter((step) => step.ok === false || step.error).length;
  const visibleSteps = (newestFirst ? [...steps].reverse() : [...steps]).filter((step) => {
    if (!failedOnly) return true;
    return step.ok === false || !!step.error;
  });
  const statusTone =
    data.status === "done" ? "success" :
    data.status === "paused" ? "warning" :
    data.status === "running" ? "accent" :
    data.status === "error" || data.status === "stopped" ? "error" :
    "neutral";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="wp-titlebar flex min-w-0 shrink-0 items-center gap-2 border-b border-wp-border px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          &larr; Back
        </Button>
        <span className="flex-1 text-[13px] font-medium text-wp-text truncate">
          {data.goal}
        </span>
        <Badge tone={statusTone}>{data.status}</Badge>
      </div>

      {/* Summary */}
      <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-wp-border px-4 py-3 text-[11px] text-wp-text-secondary">
        <span>{steps.length} steps</span>
        {failedCount > 0 && <span>{failedCount} failed</span>}
        {data.durationMs && <span>{(data.durationMs / 1000).toFixed(1)}s</span>}
        <span>{new Date(data.startedAt).toLocaleString()}</span>
      </div>

      {/* Error */}
      {data.lastError && (
        <div className="mx-4 mt-3 min-w-0 shrink-0 rounded-[var(--wp-radius-md)] border border-wp-error/20 bg-wp-error/10 px-3 py-2">
          <div className="wp-prose wp-prose-error break-words text-[12px] text-wp-error/90">
            <Markdown>{data.lastError}</Markdown>
          </div>
        </div>
      )}

      {/* Result */}
      {data.finalResult && (
        <div className="mx-4 mt-3 min-w-0 shrink-0 rounded-[var(--wp-radius-md)] border border-wp-border border-l-2 border-l-wp-accent bg-wp-surface px-3 py-3">
          <div className="wp-prose text-[13px] text-wp-text">
            <Markdown>{data.finalResult}</Markdown>
          </div>
        </div>
      )}

      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 px-4 pt-3 text-[11px] text-wp-text-secondary">
        <span className="mr-auto">
          Showing {visibleSteps.length} of {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setNewestFirst((value) => !value)}
        >
          {newestFirst ? "Newest first" : "Oldest first"}
        </Button>
        <Button
          variant={failedOnly ? "primary" : "ghost"}
          size="sm"
          onClick={() => setFailedOnly((value) => !value)}
          disabled={failedCount === 0}
        >
          Failed only
        </Button>
      </div>

      {/* Steps */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {visibleSteps.map((step) => (
          <StepCard
            key={step.step}
            step={step.step}
            action={step.name}
            duration={step.durationMs}
            source={step.source === "llm" ? "llm" : undefined}
            details={step.args}
            ok={step.ok}
            error={step.error}
          />
        ))}
        {visibleSteps.length === 0 && (
          <div className="rounded-[var(--wp-radius-md)] border border-dashed border-wp-border px-3 py-6 text-center text-sm text-wp-text-secondary">
            No matching steps.
          </div>
        )}
      </div>
    </div>
  );
}
