import { create } from "zustand";
import {
  clearHistoryClient,
  deleteRunClient,
  getAgentStateClient,
  listRunsClient,
} from "@/lib/desktop-client";
import type { ModelProvider } from "@/lib/runtime-provider-presets";

/* ── Domain types (match existing app/page.tsx shapes) ── */

interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  action: string;
  details?: unknown;
  duration?: number;
}

interface RuntimeSummary {
  provider: ModelProvider;
  model: string;
  navModel: string;
  synthModel: string;
  reviewModel: string;
  synthEnabled: boolean;
  baseUrl?: string;
  hasApiKey: boolean;
}

export interface AgentState {
  status: string;
  step: number;
  currentGoal?: string;
  lastAction: string;
  lastError: string;
  finalResult: string;
  intervention: string;
  logs: LogEntry[];
  runDir?: string;
  startedAt?: string;
  finishedAt?: string;
  threadId?: string | null;
  threadTitle?: string | null;
  runtime?: RuntimeSummary | null;
}

export interface RunSummary {
  runId: string;
  goal: string;
  userGoal?: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  finalResult?: string;
  lastError?: string;
  runDir: string;
  threadId?: string;
  threadTurn?: number;
}

/* ── Store ── */

interface AgentStore {
  state: AgentState | null;
  runs: RunSummary[];
  polling: boolean;
  connectionError: boolean;

  fetchState: () => Promise<void>;
  fetchRuns: () => Promise<void>;
  deleteRun: (runId: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

let stateTimer: ReturnType<typeof setInterval> | null = null;
let runsTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
const FAILURE_THRESHOLD = 3;

export const useAgentStore = create<AgentStore>((set, get) => ({
  state: null,
  runs: [],
  polling: false,
  connectionError: false,

  fetchState: async () => {
    try {
      const data = await getAgentStateClient();
      consecutiveFailures = 0;
      set({ state: data as AgentState, connectionError: false });
    } catch (err) {
      consecutiveFailures++;
      console.error("[agent-store] fetchState error:", err);
      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        set({ connectionError: true });
      }
    }
  },

  fetchRuns: async () => {
    try {
      const data = await listRunsClient();
      const runs = Array.isArray(data) ? data : data?.runs ?? [];
      set({ runs: runs as RunSummary[] });
    } catch (err) {
      console.error("[agent-store] fetchRuns error:", err);
    }
  },

  deleteRun: async (runId) => {
    await deleteRunClient(runId);
    set((s) => ({ runs: s.runs.filter((run) => run.runId !== runId) }));
    await get().fetchRuns();
  },

  clearHistory: async () => {
    await clearHistoryClient();
    set({ runs: [] });
  },

  startPolling: () => {
    if (get().polling) return;
    set({ polling: true });

    const { fetchState, fetchRuns } = get();

    // Kick off initial fetches
    fetchState();
    fetchRuns();

    // Set up intervals
    stateTimer = setInterval(() => get().fetchState(), 1_000);
    runsTimer = setInterval(() => get().fetchRuns(), 5_000);
  },

  stopPolling: () => {
    if (stateTimer) { clearInterval(stateTimer); stateTimer = null; }
    if (runsTimer) { clearInterval(runsTimer); runsTimer = null; }
    set({ polling: false });
  },
}));
