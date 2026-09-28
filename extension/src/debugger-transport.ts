/// <reference types="chrome" />

import type { CdpTransport } from "../../lib/cdp/driver";

const PROTOCOL_VERSION = "1.3";

/** Pages Chrome never lets extensions debug. */
export function isRestrictedUrl(url: string | undefined): boolean {
    if (!url) return true;
    return !/^https?:\/\//i.test(url)
        || /^https:\/\/chromewebstore\.google\.com\//i.test(url)
        || /^https:\/\/chrome\.google\.com\/webstore/i.test(url);
}

/**
 * CDP transport over `chrome.debugger` for one tab. While attached, Chrome shows
 * a "WebPilot started debugging this browser" bar; `detach()` removes it.
 */
export class DebuggerTransport implements CdpTransport {
    private listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
    private detachedReason: string | null = null;

    private readonly onEventHandler = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
        if (source.tabId !== this.tabId) return;
        for (const listener of this.listeners) listener(method, (params || {}) as Record<string, unknown>);
    };

    private readonly onDetachHandler = (source: chrome.debugger.Debuggee, reason: string) => {
        if (source.tabId === this.tabId) this.detachedReason = reason;
    };

    private constructor(public readonly tabId: number) {}

    static async attach(tabId: number): Promise<DebuggerTransport> {
        const transport = new DebuggerTransport(tabId);
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
        chrome.debugger.onEvent.addListener(transport.onEventHandler);
        chrome.debugger.onDetach.addListener(transport.onDetachHandler);
        return transport;
    }

    async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
        if (this.detachedReason) {
            throw new Error(this.detachedReason === "canceled_by_user"
                ? "Browser control was cancelled from Chrome's debugging bar."
                : `Lost control of the tab (${this.detachedReason}).`);
        }
        return await chrome.debugger.sendCommand({ tabId: this.tabId }, method, params) as T;
    }

    onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async detach(): Promise<void> {
        chrome.debugger.onEvent.removeListener(this.onEventHandler);
        chrome.debugger.onDetach.removeListener(this.onDetachHandler);
        this.listeners.clear();
        if (!this.detachedReason) await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
    }
}
