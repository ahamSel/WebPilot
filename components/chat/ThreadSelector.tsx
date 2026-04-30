"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useThreadStore } from "@/stores/thread";

export function ThreadSelector() {
  const threads = useThreadStore((s) => s.threads);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const setActiveThread = useThreadStore((s) => s.setActiveThread);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const hydrate = useThreadStore((s) => s.hydrate);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    hydrate();
    fetchThreads();
  }, [hydrate, fetchThreads]);

  const activeThread = threads.find((t) => t.threadId === activeThreadId);
  const label = activeThread?.title ?? "New thread";

  return (
    <div className="relative flex min-w-0 max-w-full cursor-pointer items-center justify-center gap-1">
      <button
        type="button"
        aria-label={`Current thread: ${label}`}
        onClick={() => selectRef.current?.showPicker?.()}
        onMouseDown={() => setOpen(true)}
        className="flex min-w-0 max-w-full items-center gap-1 text-xs text-wp-text-secondary transition-colors hover:text-wp-text"
      >
        <span className="min-w-0 max-w-[220px] truncate">{label}</span>
        <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <select
        ref={selectRef}
        aria-label="Select thread"
        value={activeThreadId || ""}
        onChange={(e) => {
          setActiveThread(e.target.value || null);
          setOpen(false);
        }}
        onBlur={() => setOpen(false)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        <option value="">New thread</option>
        {threads.map((t) => (
          <option key={t.threadId} value={t.threadId}>
            {t.title} ({t.runCount})
          </option>
        ))}
      </select>
    </div>
  );
}
