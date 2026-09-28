/// <reference types="chrome" />

/**
 * Local conversation history: each conversation (including the hidden browser
 * memory of its turns) is stored in chrome.storage.local, on this device only,
 * never synced. An index lists them for the History view; only the most recent
 * MAX_CONVERSATIONS are kept.
 */

import type { Conversation, ConversationSummary } from "./protocol";

const INDEX_KEY = "webpilot.conversations";
const CONVERSATION_PREFIX = "webpilot.conversation.";
const MAX_CONVERSATIONS = 100;
const TITLE_LENGTH = 70;

export function newConversationId(): string {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function listConversations(): Promise<ConversationSummary[]> {
    const index = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] as ConversationSummary[] | undefined;
    return (index || []).slice().sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function loadConversation(id: string): Promise<Conversation | null> {
    const key = `${CONVERSATION_PREFIX}${id}`;
    return ((await chrome.storage.local.get(key))[key] as Conversation | undefined) || null;
}

export async function saveConversation(conversation: Conversation): Promise<void> {
    if (!conversation.turns.length) return;
    const title = conversation.turns[0].user.replace(/\s+/g, " ").slice(0, TITLE_LENGTH);
    const saved: Conversation = { ...conversation, title, turns: conversation.turns.map((turn) => ({ ...turn, streaming: undefined })) };
    const summary: ConversationSummary = { id: saved.id, title, updatedAt: saved.updatedAt, turnCount: saved.turns.length };
    const index = [summary, ...(await listConversations()).filter((item) => item.id !== saved.id)];
    const dropped = index.slice(MAX_CONVERSATIONS);
    await chrome.storage.local.set({ [`${CONVERSATION_PREFIX}${saved.id}`]: saved, [INDEX_KEY]: index.slice(0, MAX_CONVERSATIONS) });
    if (dropped.length) await chrome.storage.local.remove(dropped.map((item) => `${CONVERSATION_PREFIX}${item.id}`));
}

export async function deleteConversation(id: string): Promise<void> {
    const index = (await listConversations()).filter((item) => item.id !== id);
    await chrome.storage.local.set({ [INDEX_KEY]: index });
    await chrome.storage.local.remove(`${CONVERSATION_PREFIX}${id}`);
}

export async function clearConversations(): Promise<void> {
    const index = await listConversations();
    await chrome.storage.local.remove([INDEX_KEY, ...index.map((item) => `${CONVERSATION_PREFIX}${item.id}`)]);
}
