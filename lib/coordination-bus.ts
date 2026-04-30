/**
 * Coordination Bus — In-memory event bus for parallel sub-agent coordination.
 *
 * Since all sub-agents run in the same Node.js process, a simple
 * EventEmitter-based bus works. No IPC, no sockets.
 *
 * Sub-agents poll shouldStop() before each tool dispatch — if true,
 * finalize gracefully with whatever data they have so far.
 */

import { EventEmitter } from "node:events";

export interface SubAgentProgress {
    label: string;       // "sub-0", "sub-1"
    site: string;        // target domain
    step: number;
    status: "running" | "done" | "error" | "cancelled";
    result?: string;     // populated on "done"
    lastUrl?: string;
    timestamp: string;
}

export interface CoordinationBus {
    reportProgress(update: SubAgentProgress): void;
    onProgress(handler: (update: SubAgentProgress) => void): void;
    shouldStop(label: string): boolean;
    cancelAgent(label: string, reason: string): void;
    cancelAll(reason: string): void;
    getProgressSnapshot(): Map<string, SubAgentProgress>;
    destroy(): void;
}

export function createCoordinationBus(): CoordinationBus {
    const emitter = new EventEmitter();
    const progress = new Map<string, SubAgentProgress>();
    const cancelled = new Set<string>();
    let allCancelled = false;

    return {
        reportProgress(update: SubAgentProgress) {
            progress.set(update.label, update);
            emitter.emit("progress", update);
        },

        onProgress(handler: (update: SubAgentProgress) => void) {
            emitter.on("progress", handler);
        },

        shouldStop(label: string): boolean {
            return allCancelled || cancelled.has(label);
        },

        cancelAgent(label: string, reason: string) {
            cancelled.add(label);
            const existing = progress.get(label);
            if (existing && existing.status === "running") {
                existing.status = "cancelled";
                existing.timestamp = new Date().toISOString();
                emitter.emit("progress", existing);
            }
        },

        cancelAll(reason: string) {
            allCancelled = true;
            for (const [label, entry] of progress) {
                if (entry.status === "running") {
                    entry.status = "cancelled";
                    entry.timestamp = new Date().toISOString();
                    emitter.emit("progress", entry);
                }
            }
        },

        getProgressSnapshot(): Map<string, SubAgentProgress> {
            return new Map(progress);
        },

        destroy() {
            emitter.removeAllListeners();
            progress.clear();
            cancelled.clear();
        },
    };
}
