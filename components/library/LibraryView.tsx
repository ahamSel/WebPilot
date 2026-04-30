"use client";

import { useEffect, useState } from "react";
import { useThreadStore } from "@/stores/thread";
import { useUIStore } from "@/stores/ui";
import { ThreadRow } from "./ThreadRow";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export function LibraryView() {
  const threads = useThreadStore((s) => s.threads);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const setActiveThread = useThreadStore((s) => s.setActiveThread);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const setView = useUIStore((s) => s.setView);
  const [search, setSearch] = useState("");

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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="wp-titlebar flex min-w-0 shrink-0 items-center justify-between gap-3 border-b border-wp-border px-4 py-3">
        <h1 className="min-w-0 truncate text-lg font-semibold text-wp-text">Library</h1>
        <Button size="sm" onClick={handleNewThread}>
          + New Thread
        </Button>
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
    </div>
  );
}
