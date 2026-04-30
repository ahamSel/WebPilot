"use client";

import { useState, ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import {
  Globe,
  MousePointer,
  Keyboard,
  ArrowUpDown,
  Eye,
  Clock,
  Check,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface StepCardProps {
  step: number;
  action: string;
  duration?: number;
  source?: "llm";
  details?: unknown;
  ok?: boolean;
  error?: string;
  level?: "debug" | "info" | "warn" | "error";
}

const ACTION_ICONS: Record<string, ReactNode> = {
  navigate: <Globe size={12} />,
  click: <MousePointer size={12} />,
  type: <Keyboard size={12} />,
  scroll: <ArrowUpDown size={12} />,
  observe: <Eye size={12} />,
  wait: <Clock size={12} />,
  finish: <Check size={12} />,
};

function iconFor(action: string): ReactNode {
  const lower = action.toLowerCase();
  for (const [key, icon] of Object.entries(ACTION_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return <span>&middot;</span>;
}

function actionCategory(action: string): string {
  const lower = action.toLowerCase();
  if (lower.includes("navigate")) return "navigate";
  if (lower.includes("click")) return "click";
  if (lower.includes("type") || lower.includes("fill")) return "type";
  if (lower.includes("observe") || lower.includes("snapshot")) return "observe";
  if (lower.includes("finish")) return "finish";
  return "action";
}

const borderColors: Record<string, string> = {
  navigate: "border-l-wp-accent",
  click: "border-l-wp-accent",
  type: "border-l-wp-accent",
  observe: "border-l-wp-info",
  finish: "border-l-wp-success",
  action: "border-l-wp-border",
};

export function StepCard({ step, action, duration, source, details, error, level }: StepCardProps) {
  const [expanded, setExpanded] = useState(false);
  const category = actionCategory(action);

  return (
    <div
      className={`min-w-0 bg-wp-surface border border-wp-border border-l-2 ${borderColors[category]} rounded-[var(--wp-radius-md)] hover:bg-wp-surface-raised transition-colors ${level === "debug" ? "opacity-50" : ""}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
      >
        <span className="w-5 shrink-0 text-center text-xs">{iconFor(action)}</span>
        <span className="w-10 shrink-0 text-[11px] tabular-nums text-wp-text-secondary">
          #{step}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-wp-text">{action}</span>
        {source && <Badge tone="neutral">{source}</Badge>}
        {level === "warn" && <Badge tone="warning">warn</Badge>}
        {(level === "error" || error) && <Badge tone="error">error</Badge>}
        {duration != null && (
          <span className="shrink-0 text-[11px] tabular-nums text-wp-text-secondary">
            {(duration / 1000).toFixed(1)}s
          </span>
        )}
        <span className="shrink-0 text-wp-text-secondary">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {expanded && details != null && (
        <div className="mt-0 min-w-0 border-t border-wp-border px-3 pb-2">
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-wp-text-secondary">
            {typeof details === "string" ? details : JSON.stringify(details, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
