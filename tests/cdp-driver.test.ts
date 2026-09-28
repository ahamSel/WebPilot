import test from "node:test";
import assert from "node:assert/strict";
import { CdpBrowser, STALE_PAGE_MESSAGE, type CdpTransport } from "../lib/cdp/driver";

/** A CDP connection to a one-button page; `emit` plays browser events. */
function fakeTab() {
    const sent: string[] = [];
    const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
    const transport: CdpTransport = {
        async send<T>(method: string): Promise<T> {
            sent.push(method);
            const replies: Record<string, unknown> = {
                "Page.getFrameTree": { frameTree: { frame: { id: "main" } } },
                "Accessibility.getFullAXTree": {
                    nodes: [
                        { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
                        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Search" }, backendDOMNodeId: 5, childIds: [] },
                    ],
                },
                "Runtime.evaluate": { result: { value: { url: "https://shop.example/", title: "Shop" } } },
                "DOM.getBoxModel": { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } },
            };
            return (replies[method] || {}) as T;
        },
        onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const emit = (method: string, params: Record<string, unknown> = {}) => {
        for (const listener of listeners) listener(method, params);
    };
    return { browser: new CdpBrowser(transport), sent, emit };
}

test("a click on a page that started navigating after the snapshot waits and asks for a new snapshot", async () => {
    const { browser, sent, emit } = fakeTab();
    await browser.snapshot();
    // The site navigates on its own (e.g. a search submitting after its suggestions load).
    emit("Page.frameStartedLoading", { frameId: "main" });
    setTimeout(() => emit("Page.frameStoppedLoading", { frameId: "main" }), 100);

    const started = Date.now();
    await assert.rejects(browser.click("b5"), new RegExp(STALE_PAGE_MESSAGE.replace(/\./g, "\\.")));
    assert.ok(Date.now() - started >= 100, "waited for the new page to load");
    assert.ok(!sent.includes("Input.dispatchMouseEvent"), "nothing was clicked on the page being left");

    // After a fresh snapshot the same kind of click goes through.
    await browser.snapshot();
    await browser.click("b5");
    assert.ok(sent.includes("Input.dispatchMouseEvent"));
});

test("subframe loads and same-document navigations don't hold up clicks", async () => {
    const { browser, sent, emit } = fakeTab();
    await browser.snapshot();
    emit("Page.frameStartedLoading", { frameId: "ad-frame" });
    emit("Page.navigatedWithinDocument", { frameId: "main", url: "https://shop.example/#reviews" });
    await browser.click("b5");
    assert.ok(sent.includes("Input.dispatchMouseEvent"));
});

test("a navigation request that never loads a new document expires quickly", async () => {
    const { browser, emit } = fakeTab();
    await browser.snapshot();
    emit("Page.frameRequestedNavigation", { frameId: "main", disposition: "currentTab", reason: "anchorClick", url: "https://shop.example/#top" });
    emit("Page.navigatedWithinDocument", { frameId: "main", url: "https://shop.example/#top" });
    const started = Date.now();
    // The page did change after the snapshot, so a fresh look is still asked for, without waiting on a load.
    await assert.rejects(browser.click("b5"), /Take a new snapshot/);
    assert.ok(Date.now() - started < 1000);
});
