"use client";

import { useEffect, useState } from "react";
import { useAgentStore } from "@/stores/agent";
import { useThreadStore } from "@/stores/thread";
import { useUIStore } from "@/stores/ui";
import { ThreadRow } from "./ThreadRow";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function LibraryView() {
  const threads = useThreadStore((s) => s.threads);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const setActiveThread = useThreadStore((s) => s.setActiveThread);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const clearThreadState = useThreadStore((s) => s.clearThreadState);
  const fetchRuns = useAgentStore((s) => s.fetchRuns);
  const clearHistory = useAgentStore((s) => s.clearHistory);
  const setView = useUIStore((s) => s.setView);
  const addToast = useUIStore((s) => s.addToast);
  const [search, setSearch] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [pendingThreadDelete, setPendingThreadDelete] = useState<{ threadId: string; title: string } | null>(null);
  const [clearRequested, setClearRequested] = useState(false);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  const filtered = search
    ? threads.filter(
        (t) =>
          t.title.toLowerCase().includes(search.toLowerCase()) ||
          (t.lastFinalResult || "").toLowerCase().includes(search.toLowerCase())
      )
    : threads;

  function handleSelect(threadId: string) {
    setActiveThread(threadId);
    setView("home");
  }

  function handleNewThread() {
    setActiveThread(null);
    setView("home");
  }

  async function confirmDeleteThread() {
    if (!pendingThreadDelete) return;
    setDeletingId(pendingThreadDelete.threadId);
    try {
      await deleteThread(pendingThreadDelete.threadId);
      await fetchRuns();
      addToast("Thread deleted", "success");
      setPendingThreadDelete(null);
    } catch (err) {
      addToast(`Failed to delete thread: ${err instanceof Error ? err.message : "unknown error"}`, "error");
    } finally {
      setDeletingId(null);
    }
  }

  async function confirmClearHistory() {
    setClearing(true);
    try {
      await clearHistory();
      clearThreadState();
      addToast("History cleared", "success");
      setClearRequested(false);
    } catch (err) {
      addToast(`Failed to clear history: ${err instanceof Error ? err.message : "unknown error"}`, "error");
      await fetchThreads();
      await fetchRuns();
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="wp-titlebar flex min-w-0 shrink-0 items-center justify-between gap-3 border-b border-wp-border px-4 py-3">
        <h1 className="min-w-0 truncate text-lg font-semibold text-wp-text">Library</h1>
        <div className="flex shrink-0 items-center gap-2">
          {threads.length > 0 && (
            <Button variant="danger" size="sm" onClick={() => setClearRequested(true)} disabled={clearing}>
              Clear History
            </Button>
          )}
          <Button size="sm" onClick={handleNewThread}>
            + New Thread
          </Button>
        </div>
      </div>

      <div className="shrink-0 px-4 py-2">
        <Input
          placeholder="Search threads..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {filtered.length > 0 ? (
          filtered.map((t) => (
            <ThreadRow
              key={t.threadId}
              threadId={t.threadId}
              title={t.title}
              runCount={t.runCount}
              lastResult={t.lastFinalResult}
              updatedAt={t.updatedAt}
              isActive={t.threadId === activeThreadId}
              onClick={() => handleSelect(t.threadId)}
              onDelete={() => setPendingThreadDelete({ threadId: t.threadId, title: t.title })}
              deleteDisabled={deletingId === t.threadId || clearing}
            />
          ))
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-wp-text-secondary text-sm gap-2 px-4">
            <p>No threads yet.</p>
            <button type="button" onClick={handleNewThread} className="text-sm text-wp-accent hover:underline">
              Start a conversation from Home
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-wp-border px-4 py-2 text-[11px] text-wp-text-secondary">
        {filtered.length} thread{filtered.length !== 1 ? "s" : ""}
      </div>

      <ConfirmDialog
        open={Boolean(pendingThreadDelete)}
        title="Delete Thread"
        message={`Delete "${pendingThreadDelete?.title || "this thread"}" and its saved run artifacts? Settings, browser profiles, and opt-in cache data are not affected.`}
        confirmLabel="Delete"
        busy={Boolean(deletingId)}
        onConfirm={confirmDeleteThread}
        onCancel={() => setPendingThreadDelete(null)}
      />
      <ConfirmDialog
        open={clearRequested}
        title="Clear History"
        message="Delete all saved threads, runs, and run artifacts? Settings, browser profiles, and opt-in cache data are not affected."
        confirmLabel="Clear History"
        busy={clearing}
        onConfirm={confirmClearHistory}
        onCancel={() => setClearRequested(false)}
      />
    </div>
  );
}
