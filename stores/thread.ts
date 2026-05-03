import { create } from "zustand";
import { listThreadsClient, getThreadClient } from "@/lib/desktop-client";
import type { RunSummary } from "@/stores/agent";

/* ── Domain types (match existing app/page.tsx shapes) ── */

export interface ThreadSummary {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunId?: string;
  lastStatus?: string;
  lastUserGoal?: string;
  lastFinalResult?: string;
}

export interface ThreadDetail extends ThreadSummary {
  runs: RunSummary[];
}

/* ── Store ── */

const ACTIVE_THREAD_STORAGE_KEY = "webpilot.active-thread.v1";

function readStoredActiveThread(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_THREAD_STORAGE_KEY) || null;
}

interface ThreadStore {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  activeThread: ThreadDetail | null;
  loading: boolean;

  hydrate: () => void;
  fetchThreads: () => Promise<void>;
  setActiveThread: (threadId: string | null) => void;
  fetchActiveThread: () => Promise<void>;
}

export const useThreadStore = create<ThreadStore>((set, get) => ({
  threads: [],
  activeThreadId: null,
  activeThread: null,
  loading: false,

  hydrate: () => {
    const stored = readStoredActiveThread();
    if (stored && !get().activeThreadId) {
      set({ activeThreadId: stored });
      get().fetchActiveThread();
    }
  },

  fetchThreads: async () => {
    try {
      const data = await listThreadsClient();
      const threads = Array.isArray(data) ? data : data?.threads ?? [];
      set({ threads: threads as ThreadSummary[] });
    } catch (err) {
      console.error("[thread-store] fetchThreads error:", err);
    }
  },

  setActiveThread: (threadId) => {
    if (threadId) {
      localStorage.setItem(ACTIVE_THREAD_STORAGE_KEY, threadId);
    } else {
      localStorage.removeItem(ACTIVE_THREAD_STORAGE_KEY);
    }
    set({ activeThreadId: threadId, activeThread: null });
    if (threadId) {
      get().fetchActiveThread();
    }
  },

  fetchActiveThread: async () => {
    const { activeThreadId } = get();
    if (!activeThreadId) return;

    set({ loading: true });
    try {
      const data = await getThreadClient(activeThreadId);
      const thread = data?.thread ?? data;
      set({ activeThread: thread as ThreadDetail, loading: false });
    } catch {
      // Thread no longer exists (stale localStorage) — clear it
      localStorage.removeItem(ACTIVE_THREAD_STORAGE_KEY);
      set({ activeThreadId: null, activeThread: null, loading: false });
    }
  },
}));
