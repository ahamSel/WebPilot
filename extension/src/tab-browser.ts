/// <reference types="chrome" />

import { CdpBrowser } from "../../lib/cdp/driver";
import type { TaskBrowser } from "../../lib/core/run-task";
import { DebuggerTransport, isRestrictedUrl } from "./debugger-transport";

const TAB_LOAD_TIMEOUT_MS = 15_000;

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
 * The browser for one tab, attached to `chrome.debugger` only when a task first
 * needs to read or act on the page. Until then (and for chat-only replies) the
 * tab is untouched and Chrome shows no debugging bar.
 *
 * Chrome forbids debugging its own pages (New Tab, chrome://, the Web Store), but
 * the tabs API may still navigate them, so a task that starts on one is moved to
 * its website first and controlled from there.
 */
export class TabBrowser implements TaskBrowser {
    private transport: DebuggerTransport | null = null;
    private cdp: CdpBrowser | null = null;

    constructor(public readonly tabId: number) {}

    private async tab(): Promise<chrome.tabs.Tab> {
        return await chrome.tabs.get(this.tabId);
    }

    private async attached(): Promise<CdpBrowser> {
        if (this.cdp) return this.cdp;
        const tab = await this.tab();
        if (isRestrictedUrl(tab.url)) {
            throw new Error("This tab shows a Chrome page that extensions can't control. Mention a website to open, or switch to a regular web page.");
        }
        this.transport = await DebuggerTransport.attach(this.tabId);
        this.cdp = new CdpBrowser(this.transport);
        return this.cdp;
    }

    async pageInfo(): Promise<{ url: string; title: string }> {
        if (this.cdp) return this.cdp.pageInfo();
        const tab = await this.tab();
        return { url: tab.url || "", title: tab.title || "" };
    }

    async navigate(url: string): Promise<string> {
        if (!this.cdp && isRestrictedUrl((await this.tab()).url)) {
            await chrome.tabs.update(this.tabId, { url });
            await waitForTabLoad(this.tabId);
            await this.attached();
            return "";
        }
        return (await this.attached()).navigate(url);
    }

    async snapshot(): Promise<string> {
        return (await this.attached()).snapshot();
    }

    async click(ref: string): Promise<string> {
        return (await this.attached()).click(ref);
    }

    async type(ref: string, element: string, text: string, submit: boolean): Promise<string> {
        return (await this.attached()).type(ref, element, text, submit);
    }

    async pressKey(key: string): Promise<string> {
        return (await this.attached()).pressKey(key);
    }

    async back(): Promise<string> {
        return (await this.attached()).back();
    }

    async pageText(maxChars?: number): Promise<string> {
        return (await this.attached()).pageText(maxChars);
    }

    async detach(): Promise<void> {
        await this.transport?.detach();
        this.transport = null;
        this.cdp = null;
    }
}
