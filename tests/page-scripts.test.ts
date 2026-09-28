import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { axTreeToSnapshot } from "../lib/cdp/snapshot";
import { parsePage } from "../lib/jev/page";
import { clickElement, snapshotPage, typeIntoElement, type PageActionResult, type PageSnapshot } from "../extension/src/page-scripts";

const INBOX = `
<header><nav aria-label="Main"><a href="/inbox">Inbox</a> <a href="/sent">Sent</a></nav></header>
<main>
  <h1>Inbox</h1>
  <label for="q">Search mail</label><input id="q" type="search">
  <input type="password" value="hunter2" aria-label="Password">
  <div hidden><a href="/secret">Hidden link</a></div>
  <div style="display:none"><button>Invisible button</button></div>
  <div aria-hidden="true"><button>Decorative button</button></div>
  <table role="grid"><tr role="row" style="cursor:pointer"><td>Priya Nair</td><td> Relocation question</td></tr></table>
  <p>Hello <b>world</b></p>
  <button><img src="archive.png" alt="Archive"></button>
  <div id="host"></div>
</main>`;

/**
 * A jsdom page that runs the page scripts from their source text, as
 * chrome.scripting does, so any reference outside a function's body fails here.
 */
function page(html: string) {
    const dom = new JSDOM(`<!doctype html><html><head><title>Inbox</title></head><body>${html}</body></html>`, {
        url: "https://mail.example.com/inbox",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const window = dom.window as unknown as Window & { eval: (code: string) => unknown; __name?: unknown };
    // tsx's keepNames helper, which the extension's own build does not emit.
    window.__name = (fn: unknown) => fn;
    window.eval(`
        window.PointerEvent = window.PointerEvent || window.MouseEvent;
        Element.prototype.scrollIntoView = function () {};
        document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<button>Shadow button</button>";
    `);
    // Results come back serialized, as they do from chrome.scripting.
    const run = <T>(fn: (...args: never[]) => unknown, ...args: unknown[]): T => JSON.parse(String(window.eval(`JSON.stringify((${fn.toString()})(...${JSON.stringify(args)}))`))) as T;
    const snapshot = () => {
        const result = run<PageSnapshot>(snapshotPage, 6000);
        return axTreeToSnapshot(result.nodes, result, { refPrefix: "d" });
    };
    return { window, run, snapshot };
}

test("page-script snapshots read the visible page like the accessibility tree", () => {
    const { snapshot } = page(INBOX);
    const text = snapshot();

    assert.match(text, /- Page URL: https:\/\/mail\.example\.com\/inbox/);
    assert.match(text, /- navigation "Main":/);
    assert.match(text, /- link "Inbox" \[ref=d\d+\]/);
    assert.match(text, /- heading "Inbox" \[level=1\]/);
    assert.match(text, /- searchbox "Search mail" \[ref=d\d+\]/);
    assert.match(text, /- text: Hello world/);
    assert.match(text, /- button "Archive" \[ref=d\d+\]/);
    assert.match(text, /- button "Shadow button" \[ref=d\d+\]/, "open shadow roots are read");
    // Clickable rows without a control role (Gmail's inbox) get refs.
    assert.match(text, /- row "Priya Nair ?Relocation question" \[ref=d\d+\] \[clickable\]/);
    // Hidden content and password values never reach the model.
    assert.doesNotMatch(text, /Hidden link|Invisible button|Decorative button/);
    assert.doesNotMatch(text, /hunter2/);
    assert.match(text, /- textbox "Password" \[ref=d\d+\]: ••••••/);

    const parsed = parsePage(text);
    const row = parsed.elements.find((element) => element.role === "row");
    assert.equal(row?.kind, "click");
    assert.ok(parsed.elements.some((element) => element.kind === "type" && element.name === "Search mail"));
});

test("page-script refs stay stable across snapshots", () => {
    const { snapshot } = page(INBOX);
    const ref = (text: string) => text.match(/link "Inbox" \[ref=(d\d+)\]/)?.[1];
    assert.ok(ref(snapshot()));
    assert.equal(ref(snapshot()), ref(snapshot()));
});

test("page scripts click and type through refs", () => {
    const { window, run, snapshot } = page(INBOX);
    window.eval(`document.querySelector("tr").addEventListener("click", () => { window.opened = "relocation"; })`);
    window.eval(`document.getElementById("q").addEventListener("input", () => { window.inputs = (window.inputs || 0) + 1; })`);
    const parsed = parsePage(snapshot());
    const id = (role: string) => Number(parsed.elements.find((element) => element.role === role)!.ref.slice(1));

    assert.deepEqual(run<PageActionResult>(clickElement, id("row")), { ok: true });
    assert.equal((window as unknown as { opened?: string }).opened, "relocation");

    assert.deepEqual(run<PageActionResult>(typeIntoElement, id("searchbox"), "relocation"), { ok: true });
    assert.equal((window.document.getElementById("q") as HTMLInputElement).value, "relocation");
    assert.ok(((window as unknown as { inputs?: number }).inputs || 0) >= 1, "the page saw an input event");

    const stale = run<PageActionResult>(clickElement, 99999);
    assert.equal(stale.ok, false);
    assert.match(stale.error || "", /Take a new snapshot/);
});
