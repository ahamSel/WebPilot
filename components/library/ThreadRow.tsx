"use client";

interface ThreadRowProps {
  threadId: string;
  title: string;
  runCount: number;
  lastResult?: string;
  updatedAt: string;
  isActive: boolean;
  onClick: () => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ThreadRow({
  title,
  runCount,
  lastResult,
  updatedAt,
  isActive,
  onClick,
}: ThreadRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full min-w-0 border-b border-wp-border px-3 py-2.5 text-left transition-colors hover:bg-wp-surface-raised ${
        isActive ? "border-l-2 border-l-wp-accent bg-wp-accent-muted/30" : ""
      }`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-wp-text">{title}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-wp-text-secondary">{runCount} {runCount === 1 ? "run" : "runs"}</span>
          <span className="text-[11px] text-wp-text-secondary">{timeAgo(updatedAt)}</span>
        </div>
      </div>
      {lastResult && (
        <p className="mt-0.5 min-w-0 truncate text-[11px] text-wp-text-secondary">{lastResult}</p>
      )}
    </button>
  );
}
