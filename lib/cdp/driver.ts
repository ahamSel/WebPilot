/**
 * Browser driver over the Chrome DevTools Protocol.
 *
 * Works with any CDP transport: `chrome.debugger` in the browser extension, or a
 * Playwright `CDPSession` in Node (used by tests). It implements the same
 * `FastModeBrowser` interface as the Playwright MCP adapter, and its snapshots
 * use the same text format, so fast mode and the page parser are shared.
 *
 * Input is sent as real mouse/keyboard events (Input.dispatch*), which pages
 * treat like user input, unlike synthetic DOM events from a content script.
 */

import type { FastModeBrowser } from "../jev/fast-mode";
import { axTreeToSnapshot, backendNodeForRef, type AXNode } from "./snapshot";

export interface CdpTransport {
    send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    /** Subscribes to CDP events; returns an unsubscribe function. */
    onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
}

const NAVIGATION_START_WINDOW_MS = 400;
const LOAD_TIMEOUT_MS = 12_000;
const SETTLE_MS = 250;
/** How long past DOMContentLoaded to wait for the load event. */
export const AFTER_DOM_READY_MS = 2500;
/** How long a navigation request may take to start loading before it's treated as same-document. */
const NAVIGATION_REQUEST_GRACE_MS = 1500;
const NAVIGATE_RESPONSE_TIMEOUT_MS = 10_000;

const KEY_CODES: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
    PageDown: { code: "PageDown", keyCode: 34 },
    PageUp: { code: "PageUp", keyCode: 33 },
    Escape: { code: "Escape", keyCode: 27 },
    Tab: { code: "Tab", keyCode: 9 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
};

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown when refs from the last snapshot would act on a page that has since changed. */
export const STALE_PAGE_MESSAGE = "The page changed since the last snapshot. Take a new snapshot.";

export class CdpBrowser implements FastModeBrowser {
    private enabled = false;
    private mainFrameId: string | null = null;
    /** The main frame is loading a new document. */
    private loading = false;
    /** When the page asked to navigate; a request that never starts loading (same-document) expires. */
    private navigationRequestedAt = 0;
    /** The main frame started navigating after the last snapshot, so its refs may point at the old page. */
    private navigatedSinceSnapshot = false;

    constructor(private transport: CdpTransport) {}

    private async enable() {
        if (this.enabled) return;
        await this.transport.send("Page.enable");
        await this.transport.send("DOM.enable");
        await this.transport.send("Accessibility.enable");
        const { frameTree } = await this.transport.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
        this.mainFrameId = frameTree.frame.id;
        // Sites often navigate a moment after an action (a search that submits
        // after its suggestions load). Tracking it lets clicks and typing refuse
        // refs from a snapshot of the page being left.
        this.transport.onEvent((method, params) => {
            const frameId = typeof params.frameId === "string" ? params.frameId : undefined;
            const frame = (params.frame || {}) as { id?: string; parentId?: string };
            const main = frameId === undefined || frameId === this.mainFrameId;
            if (method === "Page.frameRequestedNavigation" && main && params.disposition === "currentTab") {
                this.navigationRequestedAt = Date.now();
                this.navigatedSinceSnapshot = true;
            } else if (method === "Page.frameStartedLoading" && main) {
                this.loading = true;
                this.navigatedSinceSnapshot = true;
            } else if (method === "Page.frameNavigated" && !frame.parentId) {
                if (frame.id) this.mainFrameId = frame.id;
                this.navigatedSinceSnapshot = true;
            } else if (method === "Page.navigatedWithinDocument" && main) {
                this.navigationRequestedAt = 0;
            } else if ((method === "Page.frameStoppedLoading" && main) || method === "Page.loadEventFired" || method === "Inspector.detached") {
                this.loading = false;
                this.navigationRequestedAt = 0;
            }
        });
        this.enabled = true;
    }

    /**
     * Before acting on a ref: if the page navigated since the snapshot the ref
     * came from, wait for the new page and ask for a fresh snapshot instead of
     * clicking on (or typing into) the page being left.
     */
    private async ensureSnapshotCurrent() {
        if (!this.navigatedSinceSnapshot) return;
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        const pending = () => this.loading || (this.navigationRequestedAt > 0 && Date.now() - this.navigationRequestedAt < NAVIGATION_REQUEST_GRACE_MS);
        while (pending() && Date.now() < deadline) await sleep(50);
        await sleep(SETTLE_MS);
        throw new Error(STALE_PAGE_MESSAGE);
    }

    async pageInfo(): Promise<{ url: string; title: string }> {
        const { result } = await this.transport.send<{ result: { value?: { url: string; title: string } } }>("Runtime.evaluate", {
            expression: "({ url: location.href, title: document.title })",
            returnByValue: true,
        });
        return result.value || { url: "", title: "" };
    }

    async snapshot(): Promise<string> {
        await this.enable();
        this.navigatedSinceSnapshot = false;
        const [{ nodes }, page] = await Promise.all([
            this.transport.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree"),
            this.pageInfo(),
        ]);
        return axTreeToSnapshot(nodes, page);
    }

    /**
     * Runs an action and waits for any navigation it starts to finish loading;
     * otherwise waits briefly for the page to settle.
     */
    private async withSettle(action: () => Promise<void>): Promise<void> {
        await this.enable();
        let navigating = false;
        let loaded = false;
        let domReadyAt = 0;
        const unsubscribe = this.transport.onEvent((method, params) => {
            const frame = (params.frame || {}) as { parentId?: string };
            const main = params.frameId === undefined || params.frameId === this.mainFrameId;
            if ((method === "Page.frameStartedLoading" && main) || (method === "Page.frameNavigated" && !frame.parentId)) navigating = true;
            if (method === "Page.domContentEventFired") domReadyAt = Date.now();
            if (method === "Page.loadEventFired" || (method === "Page.frameStoppedLoading" && main)) loaded = true;
            // The debugger was detached: nothing more will arrive.
            if (method === "Inspector.detached") navigating = loaded = true;
        });
        try {
            await action();
            const windowEnd = Date.now() + NAVIGATION_START_WINDOW_MS;
            while (!navigating && Date.now() < windowEnd) await sleep(50);
            if (navigating) {
                // Heavy sites keep loading ads and trackers long after the page is
                // usable: once its DOM is ready, give the full load only a little longer.
                const deadline = Date.now() + LOAD_TIMEOUT_MS;
                while (!loaded && Date.now() < deadline && !(domReadyAt && Date.now() - domReadyAt > AFTER_DOM_READY_MS)) await sleep(50);
            }
            await sleep(SETTLE_MS);
        } finally {
            unsubscribe();
        }
    }

    private async resolve(ref: string): Promise<number> {
        const backendNodeId = backendNodeForRef(ref);
        if (backendNodeId === null) throw new Error(`Unknown element ref "${ref}". Take a new snapshot.`);
        return backendNodeId;
    }

    private async center(backendNodeId: number): Promise<{ x: number; y: number } | null> {
        try {
            await this.transport.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
            const { model } = await this.transport.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId });
            const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
            return { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4 };
        } catch {
            return null;
        }
    }

    private async callOn(backendNodeId: number, functionDeclaration: string) {
        const { object } = await this.transport.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId });
        if (!object.objectId) throw new Error("Element is no longer in the page. Take a new snapshot.");
        await this.transport.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration, awaitPromise: true });
    }

    async click(ref: string): Promise<string> {
        const backendNodeId = await this.resolve(ref);
        await this.enable();
        await this.ensureSnapshotCurrent();
        await this.withSettle(async () => {
            const point = await this.center(backendNodeId);
            if (!point) {
                // No layout box (hidden or zero-size): fall back to a DOM click.
                await this.callOn(backendNodeId, "function () { this.click(); }");
                return;
            }
            const base = { x: point.x, y: point.y, button: "left" as const, clickCount: 1 };
            await this.transport.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
            await this.transport.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
            await this.transport.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
        });
        return "";
    }

    async type(ref: string, _element: string, text: string, submit: boolean): Promise<string> {
        const backendNodeId = await this.resolve(ref);
        await this.enable();
        await this.ensureSnapshotCurrent();
        await this.withSettle(async () => {
            await this.transport.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
            await this.transport.send("DOM.focus", { backendNodeId });
            // Replace existing content: select it, then insert over the selection.
            await this.callOn(backendNodeId, `function () {
                if (typeof this.select === "function") { this.select(); return; }
                const range = document.createRange();
                range.selectNodeContents(this);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }`);
            await this.transport.send("Input.insertText", { text });
            if (submit) await this.dispatchKey("Enter");
        });
        return "";
    }

    private async dispatchKey(key: string) {
        const spec = KEY_CODES[key];
        if (!spec) throw new Error(`Unsupported key "${key}".`);
        const common = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
        await this.transport.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...common, ...(spec.text ? { text: spec.text } : {}) });
        await this.transport.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    }

    async pressKey(key: string): Promise<string> {
        await this.withSettle(() => this.dispatchKey(key));
        return "";
    }

    async back(): Promise<string> {
        await this.withSettle(async () => {
            const { currentIndex, entries } = await this.transport.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory");
            if (currentIndex > 0) await this.transport.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id });
        });
        return "";
    }

    async navigate(url: string): Promise<string> {
        await this.withSettle(async () => {
            // Page.navigate resolves once the site responds; a dead host can take a minute to fail.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${url} is not responding.`)), NAVIGATE_RESPONSE_TIMEOUT_MS);
            });
            try {
                const result = await Promise.race([this.transport.send<{ errorText?: string }>("Page.navigate", { url }), timeout]);
                if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
            } finally {
                clearTimeout(timer);
            }
        });
        return "";
    }

    /** Visible text of the page, for final answers and reviews. */
    async pageText(maxChars = 12_000): Promise<string> {
        const { result } = await this.transport.send<{ result: { value?: string } }>("Runtime.evaluate", {
            expression: `(document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, ${Math.max(0, Math.floor(maxChars))})`,
            returnByValue: true,
        });
        return result.value || "";
    }
}
