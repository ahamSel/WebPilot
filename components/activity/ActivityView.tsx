"use client";

import { useState } from "react";
import { useAgentStore } from "@/stores/agent";
import { useThreadStore } from "@/stores/thread";
import { useUIStore } from "@/stores/ui";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RunList } from "./RunList";
import { RunDetail } from "./RunDetail";
import { postAgentActionClient } from "@/lib/desktop-client";

export function ActivityView() {
  const agentState = useAgentStore((s) => s.state);
  const runs = useAgentStore((s) => s.runs);
  const deleteRun = useAgentStore((s) => s.deleteRun);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const setView = useUIStore((s) => s.setView);
  const addToast = useUIStore((s) => s.addToast);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [pendingRunDelete, setPendingRunDelete] = useState<{ runId: string; label: string } | null>(null);

  const status = agentState?.status || "idle";
  const isActive = status === "running" || status === "paused";

  if (selectedRunId) {
    return <RunDetail runId={selectedRunId} onBack={() => setSelectedRunId(null)} onDeleted={() => setSelectedRunId(null)} />;
  }

  function requestDeleteRun(runId: string) {
    const run = runs.find((item) => item.runId === runId);
    setPendingRunDelete({ runId, label: run?.userGoal || run?.goal || runId });
  }

  async function confirmDeleteRun() {
    if (!pendingRunDelete) return;
    setDeletingRunId(pendingRunDelete.runId);
    try {
      await deleteRun(pendingRunDelete.runId);
      await fetchThreads();
      addToast("Run deleted", "success");
      setPendingRunDelete(null);
    } catch (err) {
      addToast(`Failed to delete run: ${err instanceof Error ? err.message : "unknown error"}`, "error");
    } finally {
      setDeletingRunId(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="wp-titlebar flex min-w-0 shrink-0 items-center border-b border-wp-border px-4 py-3">
        <h1 className="min-w-0 truncate text-lg font-semibold text-wp-text">Activity</h1>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Live section */}
        {isActive && agentState && (
          <Card>
            <div className="flex min-w-0 items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-wp-accent animate-pulse" />
              <span className="flex-1 text-[13px] text-wp-text truncate">
                {agentState.currentGoal || "Running..."}
              </span>
              <Badge tone="accent">Step {agentState.step}</Badge>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setView("home")}>
                View in Chat
              </Button>
              <Button variant="danger" size="sm" onClick={async () => {
                try { await postAgentActionClient({ action: "stop" }); }
                catch (err) { addToast(`Failed to stop: ${err instanceof Error ? err.message : "unknown"}`, "error"); }
              }}>
                Stop
              </Button>
            </div>
          </Card>
        )}

        {/* Recent runs */}
        <div>
          <h3 className="text-xs font-medium text-wp-text-secondary uppercase tracking-wider mb-2">
            Recent Runs
          </h3>
          {runs.length > 0 ? (
            <RunList
              runs={runs}
              onSelect={setSelectedRunId}
              onDelete={requestDeleteRun}
              deletingRunId={deletingRunId}
            />
          ) : (
            <p className="text-sm text-wp-text-secondary">No runs yet.</p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingRunDelete)}
        title="Delete Run"
        message={`Delete this run and its saved artifacts? Settings, browser profiles, and opt-in cache data are not affected. ${pendingRunDelete?.label || ""}`}
        confirmLabel="Delete"
        busy={Boolean(deletingRunId)}
        onConfirm={confirmDeleteRun}
        onCancel={() => setPendingRunDelete(null)}
      />
    </div>
  );
}
