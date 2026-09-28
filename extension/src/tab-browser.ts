/// <reference types="chrome" />

import { CdpBrowser } from "../../lib/cdp/driver";
import type { TaskBrowser } from "../../lib/core/run-task";
import { DebuggerTransport, isDebuggerBlocked, isRestrictedUrl } from "./debugger-transport";
import { DomBrowser } from "./dom-browser";

const TAB_LOAD_TIMEOUT_MS = 15_000;
/** A site that hasn't started responding by then is treated as down. */
const COMMIT_TIMEOUT_MS = 8_000;
const RESTRICTED_MESSAGE = "This tab shows a Chrome page that extensions can't control. Mention a website to open, or switch to a regular web page.";
const CANCELLED_MESSAGE = "Browser control was cancelled from Chrome's debugging bar.";

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once the tab finishes loading (or after a timeout). */
function waitForTabLoad(tabId: number): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        };
        const listener = (updatedId: number, change: { status?: string }) => {
            if (updatedId === tabId && change.status === "complete") done();
        };
        const timer = setTimeout(done, TAB_LOAD_TIMEOUT_MS);
        chrome.tabs.onUpdated.addListener(listener);
    });
}

/**
 * Waits for a navigation away from a Chrome page to commit (the site starts
 * responding), then for it to load. Returns false if the site never responds.
 */
async function waitForSite(tabId: number): Promise<boolean> {
    const deadline = Date.now() + COMMIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return false;
        if (!isRestrictedUrl(tab.url)) {
            if (tab.status === "loading") await waitForTabLoad(tabId);
            return true;
        }
        await sleep(100);
    }
    return false;
}

type Driver = CdpBrowser | DomBrowser;

/**
 * The browser for one tab during a task.
 *
 * It uses `chrome.debugger` (real input, Chrome's accessibility tree), attached
 * only when the task first needs the page; until then (and for chat-only replies)
 * the tab is untouched and Chrome shows no debugging bar.
 *
 * Chrome refuses the debugger on some pages it otherwise allows extensions on,
 * most often because another extension (a password manager like LastPass, or
 * Grammarly) has put its own frame into the page, and it detaches the debugger
 * when such a frame appears later. Those pages are driven with page scripts
 * instead (DomBrowser). Each navigation tries the debugger again.
 *
 * Chrome forbids both on its own pages (New Tab, chrome://, the Web Store), but
 * the tabs API may still navigate them, so a task that starts on one is moved
 * to its website first and controlled from there.
 */
export class TabBrowser implements TaskBrowser {
    private transport: DebuggerTransport | null = null;
    private cdp: CdpBrowser | null = null;
    private dom: DomBrowser | null = null;
    private noticed = false;

    /** `onNotice` reports a switch to page scripts, once per task. */
    constructor(public readonly tabId: number, private readonly onNotice?: (message: string) => void) {}

    private async tab(): Promise<chrome.tabs.Tab> {
        try {
            return await chrome.tabs.get(this.tabId);
        } catch {
            throw new Error("The tab was closed.");
        }
    }

    private async dropTransport() {
        await this.transport?.detach();
        this.transport = null;
        this.cdp = null;
    }

    private async driver(): Promise<Driver> {
        if (this.dom) return this.dom;
        if (this.cdp && !this.transport?.detachedReason) return this.cdp;
        if (this.transport?.detachedReason === "canceled_by_user") throw new Error(CANCELLED_MESSAGE);
        await this.dropTransport();
        const tab = await this.tab();
        if (isRestrictedUrl(tab.url)) throw new Error(RESTRICTED_MESSAGE);
        if (tab.status === "loading") await waitForTabLoad(this.tabId);
        try {
            this.transport = await DebuggerTransport.attach(this.tabId);
            this.cdp = new CdpBrowser(this.transport);
            return this.cdp;
        } catch (error) {
            if (!isDebuggerBlocked(error)) throw error;
            this.dom = new DomBrowser(this.tabId);
            if (!this.noticed) {
                this.noticed = true;
                this.onNotice?.(/Another debugger/i.test(String(error))
                    ? "Another tool is debugging this tab, so WebPilot is using page scripts"
                    : "Another extension's frame blocks the debugger here, so WebPilot is using page scripts");
            }
            return this.dom;
        }
    }

    /**
     * Runs an operation on the current driver. If Chrome detaches the debugger
     * during it (usually another extension's frame appearing), a read is redone
     * with the next driver; an action whose input already reached the page is
     * treated as done, and the next snapshot shows its result.
     */
    private async run<T>(operation: (driver: Driver) => Promise<T>, changesPage: boolean, fallback: T): Promise<T> {
        const driver = await this.driver();
        const transport = this.transport;
        const actionsBefore = transport?.actionsSent ?? 0;
        try {
            return await operation(driver);
        } catch (error) {
            if (driver !== this.cdp || !transport) throw error;
            // The detach event can trail the failed command slightly.
            if (!transport.detachedReason) await sleep(50);
            const lostControl = transport.detachedReason || (/not attached|detached while/i.test(String(error)) ? "target_closed" : null);
            if (!lostControl || lostControl === "canceled_by_user") throw error;
            transport.detachedReason = lostControl;
            if (changesPage && transport.actionsSent > actionsBefore) {
                const tab = await this.tab();
                if (tab.status === "loading") await waitForTabLoad(this.tabId);
                return fallback;
            }
            return operation(await this.driver());
        }
    }

    async pageInfo(): Promise<{ url: string; title: string }> {
        if (this.cdp && !this.transport?.detachedReason) return this.cdp.pageInfo();
        const tab = await this.tab();
        return { url: tab.url || "", title: tab.title || "" };
    }

    async navigate(url: string): Promise<string> {
        if (!this.cdp && !this.dom && isRestrictedUrl((await this.tab()).url)) {
            await chrome.tabs.update(this.tabId, { url });
            if (!await waitForSite(this.tabId)) throw new Error(`${url} is not responding.`);
            await this.driver();
            return "";
        }
        const result = await this.run((driver) => driver.navigate(url), true, "");
        // A new page may allow the debugger again.
        this.dom = null;
        return result;
    }

    async snapshot(): Promise<string> {
        return this.run((driver) => driver.snapshot(), false, "");
    }

    async click(ref: string): Promise<string> {
        return this.run((driver) => driver.click(ref), true, "");
    }

    async type(ref: string, element: string, text: string, submit: boolean): Promise<string> {
        return this.run((driver) => driver.type(ref, element, text, submit), true, "");
    }

    async pressKey(key: string): Promise<string> {
        return this.run((driver) => driver.pressKey(key), true, "");
    }

    async back(): Promise<string> {
        return this.run((driver) => driver.back(), true, "");
    }

    async pageText(maxChars?: number): Promise<string> {
        return this.run((driver) => driver.pageText(maxChars), false, "");
    }

    async detach(): Promise<void> {
        await this.dropTransport();
        this.dom = null;
    }
}
