/// <reference types="chrome" />

import { STALE_PAGE_MESSAGE } from "../../lib/cdp/driver";
import { axTreeToSnapshot } from "../../lib/cdp/snapshot";
import type { TaskBrowser } from "../../lib/core/run-task";
import { clickElement, pressKeyInPage, readPageText, snapshotPage, typeIntoElement, waitForQuiet } from "./page-scripts";

/** Refs from page-script snapshots; distinct from the debugger's `b` refs. */
export const DOM_REF_PREFIX = "d";

const MAX_NODES = 6000;
const NAVIGATION_START_WINDOW_MS = 150;
const LOAD_TIMEOUT_MS = 12_000;
const QUIET_MS = 200;
const MAX_QUIET_WAIT_MS = 1500;
const SETTLE_MS = 150;

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function refId(ref: string): number {
    const match = ref.match(/^d(\d+)$/);
    if (!match) throw new Error(`Unknown element ref "${ref}". Take a new snapshot.`);
    return Number(match[1]);
}

/**
 * Drives a tab with scripts injected into the page (`chrome.scripting`), for
 * pages `chrome.debugger` can't attach to: most often because another
 * extension (a password manager, Grammarly...) has put its own frame into the
 * page, which Chrome treats as off limits to other extensions' debuggers, or
 * because another tool is already debugging the tab.
 *
 * Snapshots are built from the visible DOM in the same format as the debugger's
 * accessibility-tree snapshots. Input is synthetic DOM events, which nearly all
 * sites accept; the debugger driver stays the default because its input is real.
 * Cross-origin frames are not read.
 */
export class DomBrowser implements TaskBrowser {
    /** The URL of the last snapshot, to catch navigations that happen after it. */
    private snapshotUrl = "";

    constructor(public readonly tabId: number) {}

    /** Refuses refs from a snapshot of a page that is being left (see CdpBrowser). */
    private async ensureSnapshotCurrent() {
        const tab = await chrome.tabs.get(this.tabId);
        if (tab.status !== "loading" && (!this.snapshotUrl || tab.url === this.snapshotUrl)) return;
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        while (Date.now() < deadline && (await chrome.tabs.get(this.tabId)).status === "loading") await sleep(50);
        await sleep(SETTLE_MS);
        throw new Error(STALE_PAGE_MESSAGE);
    }

    private async exec<Args extends unknown[], Result>(func: (...args: Args) => Result, args: Args, world: "ISOLATED" | "MAIN" = "ISOLATED"): Promise<Awaited<Result>> {
        let results: Array<{ result?: unknown }>;
        try {
            results = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, func, args, world } as chrome.scripting.ScriptInjection<Args, Result>);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/Cannot access|permission/i.test(message)) throw new Error("WebPilot can't access this page.");
            throw error;
        }
        if (!results?.length) throw new Error("Could not run in the page.");
        return results[0].result as Awaited<Result>;
    }

    /** Runs an action, then waits for a navigation it starts to load, or for the DOM to settle. */
    private async withSettle(action: () => Promise<void>): Promise<void> {
        let loading = false;
        let complete = false;
        const listener = (tabId: number, change: { status?: string }) => {
            if (tabId !== this.tabId) return;
            if (change.status === "loading") {
                loading = true;
                complete = false;
            }
            if (change.status === "complete") complete = true;
        };
        chrome.tabs.onUpdated.addListener(listener);
        try {
            await action();
            // A navigation discards the page mid-wait; don't wait on it longer than the cap.
            if (!loading) await Promise.race([this.exec(waitForQuiet, [QUIET_MS, MAX_QUIET_WAIT_MS]).catch(() => undefined), sleep(MAX_QUIET_WAIT_MS + 300)]);
            const windowEnd = Date.now() + NAVIGATION_START_WINDOW_MS;
            while (!loading && Date.now() < windowEnd) await sleep(30);
            if (loading) {
                const deadline = Date.now() + LOAD_TIMEOUT_MS;
                while (!complete && Date.now() < deadline) await sleep(50);
                await sleep(SETTLE_MS);
            }
        } finally {
            chrome.tabs.onUpdated.removeListener(listener);
        }
    }

    async pageInfo(): Promise<{ url: string; title: string }> {
        const tab = await chrome.tabs.get(this.tabId);
        return { url: tab.url || "", title: tab.title || "" };
    }

    async snapshot(): Promise<string> {
        const page = await this.exec(snapshotPage, [MAX_NODES]);
        this.snapshotUrl = page.url;
        return axTreeToSnapshot(page.nodes, page, { refPrefix: DOM_REF_PREFIX });
    }

    async click(ref: string): Promise<string> {
        const id = refId(ref);
        await this.ensureSnapshotCurrent();
        await this.withSettle(async () => {
            const result = await this.exec(clickElement, [id]);
            if (!result.ok) throw new Error(result.error);
        });
        return "";
    }

    async type(ref: string, _element: string, text: string, submit: boolean): Promise<string> {
        const id = refId(ref);
        await this.ensureSnapshotCurrent();
        await this.withSettle(async () => {
            const result = await this.exec(typeIntoElement, [id, text]);
            if (!result.ok) throw new Error(result.error);
            if (submit) await this.exec(pressKeyInPage, ["Enter"], "MAIN");
        });
        return "";
    }

    async pressKey(key: string): Promise<string> {
        await this.withSettle(async () => {
            const result = await this.exec(pressKeyInPage, [key], "MAIN");
            if (!result.ok) throw new Error(result.error);
        });
        return "";
    }

    async back(): Promise<string> {
        await this.withSettle(() => chrome.tabs.goBack(this.tabId).catch(() => undefined));
        return "";
    }

    async navigate(url: string): Promise<string> {
        await this.withSettle(async () => {
            await chrome.tabs.update(this.tabId, { url });
        });
        const tab = await chrome.tabs.get(this.tabId);
        // Still waiting on the site to respond at all.
        if (tab.status === "loading" && tab.pendingUrl) throw new Error(`${url} is not responding.`);
        return "";
    }

    async pageText(maxChars = 12_000): Promise<string> {
        return await this.exec(readPageText, [Math.max(0, Math.floor(maxChars))]);
    }
}
