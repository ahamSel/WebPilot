import { deleteAllRuns, deleteRun, listRuns } from "./recorder";
import {
    deleteAllThreadRecords,
    deleteThreadRecord,
    normalizeThreadId,
    readThread,
    reconcileThreadAfterRunDelete,
    type ThreadSummary,
} from "./threads";

export interface DeleteRunResult {
    runId: string;
    deletedRun: boolean;
    thread: ThreadSummary | null;
}

export interface DeleteThreadResult {
    threadId: string;
    deletedThread: boolean;
    deletedRuns: number;
}

export interface ClearHistoryResult {
    deletedRuns: number;
    deletedThreads: number;
}

export async function deleteHistoryRun(runId: string): Promise<DeleteRunResult> {
    const deleted = await deleteRun(runId);
    const thread = await reconcileThreadAfterRunDelete(deleted.threadId);
    return {
        runId: deleted.runId,
        deletedRun: deleted.deleted,
        thread,
    };
}

export async function deleteHistoryThread(threadId: string): Promise<DeleteThreadResult> {
    const safeThreadId = normalizeThreadId(threadId);
    const thread = await readThread(safeThreadId);
    const runs = await listRuns(10_000, { threadId: safeThreadId });

    let deletedRuns = 0;
    for (const run of runs) {
        const deleted = await deleteRun(run.runId);
        if (deleted.deleted) deletedRuns += 1;
    }

    const deletedThread = await deleteThreadRecord(safeThreadId);
    return {
        threadId: safeThreadId,
        deletedThread: Boolean(thread || deletedThread.deleted),
        deletedRuns,
    };
}

export async function clearHistory(): Promise<ClearHistoryResult> {
    const runs = await deleteAllRuns();
    const threads = await deleteAllThreadRecords();
    return {
        deletedRuns: runs.deletedRuns,
        deletedThreads: threads.deletedThreads,
    };
}
