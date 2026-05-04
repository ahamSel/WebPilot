import fs from "node:fs/promises";
import path from "node:path";
import { listRuns, type RunSummary } from "./recorder";

const THREAD_ROOT = process.env.THREAD_STORE_DIR || "agent_threads";
const THREAD_HISTORY_LIMIT = 6;

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

export interface ThreadContextSummary {
    thread: ThreadSummary;
    turns: RunSummary[];
    contextText: string;
}

async function ensureDir(dir: string) {
    await fs.mkdir(dir, { recursive: true });
}

function nowIso() {
    return new Date().toISOString();
}

function threadDir(threadId: string) {
    return path.join(THREAD_ROOT, threadId);
}

function threadFile(threadId: string) {
    return path.join(threadDir(threadId), "thread.json");
}

export function normalizeThreadId(threadId: string): string {
    const trimmed = String(threadId || "").trim();
    if (!trimmed) {
        throw new Error("threadId required");
    }
    const safe = path.basename(trimmed);
    if (safe !== trimmed || !/^thread_[A-Za-z0-9_-]+$/.test(safe)) {
        throw new Error("Invalid threadId");
    }
    return safe;
}

function compactText(value: string, max: number) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function buildThreadTitle(goal: string) {
    return compactText(goal, 72) || "New thread";
}

async function writeThread(summary: ThreadSummary) {
    await ensureDir(threadDir(summary.threadId));
    await fs.writeFile(threadFile(summary.threadId), JSON.stringify(summary, null, 2), "utf8");
}

export async function readThread(threadId: string): Promise<ThreadSummary | null> {
    if (!threadId) return null;
    const safeThreadId = normalizeThreadId(threadId);
    const raw = await fs.readFile(threadFile(safeThreadId), "utf8").catch(() => null);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as ThreadSummary;
    } catch {
        return null;
    }
}

export async function deleteThreadRecord(threadId: string): Promise<{ threadId: string; deleted: boolean }> {
    const safeThreadId = normalizeThreadId(threadId);
    const dir = threadDir(safeThreadId);
    const stats = await fs.stat(dir).catch(() => null);
    await fs.rm(dir, { recursive: true, force: true });
    return { threadId: safeThreadId, deleted: Boolean(stats) };
}

export async function deleteAllThreadRecords(): Promise<{ deletedThreads: number }> {
    const entries = await fs.readdir(THREAD_ROOT).catch(() => []);
    let deletedThreads = 0;
    for (const entry of entries) {
        let safeThreadId: string;
        try {
            safeThreadId = normalizeThreadId(entry);
        } catch {
            continue;
        }
        const dir = threadDir(safeThreadId);
        const stats = await fs.stat(dir).catch(() => null);
        if (!stats?.isDirectory()) continue;
        await fs.rm(dir, { recursive: true, force: true });
        deletedThreads += 1;
    }
    return { deletedThreads };
}

export async function reconcileThreadAfterRunDelete(threadId?: string): Promise<ThreadSummary | null> {
    if (!threadId) return null;
    const safeThreadId = normalizeThreadId(threadId);
    const thread = await readThread(safeThreadId);
    if (!thread) return null;

    const runs = await listRuns(10_000, { threadId: safeThreadId });
    if (runs.length === 0) {
        await deleteThreadRecord(safeThreadId);
        return null;
    }

    const latest = runs[0];
    const next: ThreadSummary = {
        ...thread,
        updatedAt: latest.finishedAt || latest.startedAt || nowIso(),
        runCount: runs.length,
        lastRunId: latest.runId,
        lastStatus: latest.status,
        lastUserGoal: compactText(latest.userGoal || latest.goal || "", 240) || undefined,
        lastFinalResult: compactText(latest.finalResult || "", 320) || undefined,
    };
    await writeThread(next);
    return next;
}

export async function ensureThread(threadId: string | null | undefined, initialGoal: string): Promise<{ thread: ThreadSummary; created: boolean }> {
    if (threadId) {
        const existing = await readThread(threadId);
        if (existing) return { thread: existing, created: false };
    }

    const createdAt = nowIso();
    const summary: ThreadSummary = {
        threadId: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: buildThreadTitle(initialGoal),
        createdAt,
        updatedAt: createdAt,
        runCount: 0,
        lastStatus: "idle",
        lastUserGoal: compactText(initialGoal, 240) || undefined,
    };
    await writeThread(summary);
    return { thread: summary, created: true };
}

export async function updateThreadOnRunStart(threadId: string, updates: { runId: string; userGoal: string }) {
    const thread = await readThread(threadId);
    if (!thread) return;
    const next: ThreadSummary = {
        ...thread,
        title: thread.runCount > 0 ? thread.title : buildThreadTitle(updates.userGoal),
        updatedAt: nowIso(),
        runCount: thread.lastRunId === updates.runId ? thread.runCount : thread.runCount + 1,
        lastRunId: updates.runId,
        lastStatus: "running",
        lastUserGoal: compactText(updates.userGoal, 240) || undefined,
    };
    await writeThread(next);
}

export async function updateThreadOnRunFinish(threadId: string, updates: {
    runId: string;
    status: string;
    userGoal: string;
    finalResult?: string;
}) {
    const thread = await readThread(threadId);
    if (!thread) return;
    const next: ThreadSummary = {
        ...thread,
        updatedAt: nowIso(),
        lastRunId: updates.runId,
        lastStatus: updates.status,
        lastUserGoal: compactText(updates.userGoal, 240) || undefined,
        lastFinalResult: compactText(updates.finalResult || "", 320) || undefined,
    };
    await writeThread(next);
}

export async function listThreads(limit: number = 20): Promise<ThreadSummary[]> {
    const entries = await fs.readdir(THREAD_ROOT).catch(() => []);
    const threads: ThreadSummary[] = [];
    for (const entry of entries) {
        const thread = await readThread(entry).catch(() => null);
        if (thread) threads.push(thread);
    }
    threads.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return threads.slice(0, limit);
}

export async function getThreadDetail(threadId: string, limit: number = 30): Promise<ThreadDetail | null> {
    const thread = await readThread(threadId);
    if (!thread) return null;
    const runs = await listRuns(limit, { threadId });
    runs.sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
    return {
        ...thread,
        runs,
    };
}

export async function buildThreadContext(threadId: string): Promise<ThreadContextSummary | null> {
    const detail = await getThreadDetail(threadId, 60);
    if (!detail) return null;
    const turns = detail.runs
        .filter((run) => run.status !== "running")
        .slice(-THREAD_HISTORY_LIMIT);

    const contextText = turns
        .map((run, index) => {
            const userGoal = compactText(run.userGoal || run.goal || "", 320);
            const assistantText = compactText(
                run.finalResult || run.lastError || (run.status === "stopped" ? "Run stopped before completion." : ""),
                420
            );
            const outcomeLabel =
                run.status === "done" ? "Assistant answer" :
                run.status === "stopped" ? "Assistant partial answer" :
                run.status === "error" ? "Assistant error" :
                "Assistant status";
            return [
                `Turn ${index + 1} user request: ${userGoal || "No user request recorded."}`,
                `${outcomeLabel}: ${assistantText || run.status}`,
            ].join("\n");
        })
        .join("\n\n");

    return {
        thread: detail,
        turns,
        contextText,
    };
}
