/** Messages and state shared by the background engine, side panels and the dev bridge. */

import type { TaskMemory } from "../../lib/core/run-task";

export interface LogStep {
    lane: "jev" | "llm" | "note";
    label: string;
    detail?: string;
    atMs: number;
}

/** One entry of a turn's technical trace, kept locally for troubleshooting; never shown in the chat. */
export interface TraceEntry {
    atMs: number;
    kind: string;
    data?: Record<string, unknown>;
}

/** What the user thought of an answer. */
export interface TurnFeedback {
    rating?: "up" | "down";
    note?: string;
    at: number;
}

export interface Turn {
    id: string;
    user: string;
    /** Final answer. */
    answer?: string;
    /** Answer text streaming in while the task runs. */
    streaming?: string;
    error?: string;
    steps: LogStep[];
    startedAt: number;
    finishedAt?: number;
    mode?: "chat" | "fast" | "planner";
    stats?: { jevCalls: number; llmCalls: number };
    /** Hidden browser state for follow-ups; never shown in the chat. */
    memory?: TaskMemory;
    /** Saved with the conversation, not sent to panels. */
    trace?: TraceEntry[];
    feedback?: TurnFeedback;
}

/** A saved conversation, stored locally in chrome.storage.local. */
export interface Conversation {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    turns: Turn[];
}

export interface ConversationSummary {
    id: string;
    title: string;
    updatedAt: number;
    turnCount: number;
}

export interface PendingConfirm {
    id: string;
    action: string;
    url: string;
}

/** Everything one tab's panel shows. */
export interface SessionState {
    tabId: number;
    conversationId: string;
    turns: Turn[];
    running: boolean;
    pending: PendingConfirm | null;
}

export type PanelMessage =
    | { type: "run"; goal: string }
    | { type: "stop" }
    | { type: "confirm"; id: string; allowed: boolean }
    /** Start a new conversation in this tab. */
    | { type: "clear" }
    | { type: "history" }
    | { type: "open"; conversationId: string }
    | { type: "delete"; conversationId: string }
    | { type: "clear-history" }
    /** Feedback on an answer (the latest one when no turnId); notes add up. */
    | { type: "feedback"; turnId?: string; rating?: "up" | "down"; note?: string };

export type EngineMessage =
    | { type: "state"; state: SessionState }
    | { type: "history"; items: ConversationSummary[] };

/** Panels connect with chrome.runtime.connect({ name: PANEL_PORT_PREFIX + tabId }). */
export const PANEL_PORT_PREFIX = "webpilot-panel:";
