import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { TaskFailedError, compactPlannerResult, runTask, type TaskBrowser } from "../lib/core/run-task";
import { resolveRuntimeModelConfig } from "../lib/model-client";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

const SHOP = `### Page
- Page URL: https://shop.example/p/tent
- Page Title: Trailhead 2P
### Snapshot
\`\`\`yaml
- main [ref=b1]:
  - heading "Trailhead 2P" [level=1] [ref=b2]
  - button "Buy now" [ref=b11]
\`\`\``;

function fakeBrowser(log: string[]): TaskBrowser {
    let url = "about:blank";
    return {
        snapshot: async () => SHOP,
        click: async (ref: string) => { log.push(`click ${ref}`); return ""; },
        type: async () => "",
        pressKey: async () => "",
        back: async () => "",
        navigate: async (target: string) => { url = target; log.push(`navigate ${target}`); return ""; },
        pageInfo: async () => ({ url, title: url === "about:blank" ? "" : "Trailhead 2P" }),
        pageText: async () => "Trailhead 2P $89.99 Buy now",
    };
}

/** Routes Jev decisions and chat completions to canned responses. */
function mockServices(chatReplies: Array<Record<string, unknown>>) {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        const body = url.endsWith("/systemone")
            ? { model: "jev", answers: { needs_browser: { type: "noul", noul: 0.95 }, parallel_sites: { type: "noul", noul: 0.02 }, changes_something: { type: "noul", noul: 0.95 }, multiple_parts: { type: "noul", noul: 0.02 } }, usage: {} }
            : { choices: [{ message: chatReplies.shift() || { content: "done" } }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
}

test("declining a confirmation ends the task and remembers where it stopped", async () => {
    mockServices([
        { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "click", arguments: JSON.stringify({ ref: "b11", element: "Buy now" }) } }] },
        { content: "should not be reached" },
    ]);
    const log: string[] = [];
    const asked: string[] = [];
    const result = await runTask({
        goal: "buy the tent at https://shop.example/p/tent",
        config: resolveRuntimeModelConfig({ provider: "openrouter", apiKey: "sk-or-test", fastMode: true }),
        browser: fakeBrowser(log),
        confirm: async (action) => {
            asked.push(action);
            return false;
        },
    });

    assert.deepEqual(asked, ["button \"Buy now\""]);
    assert.deepEqual(log, ["navigate https://shop.example/p/tent"], "the Buy button was never clicked");
    assert.match(result.answer, /stopped before clicking button "Buy now"/);
    assert.equal(result.memory.finalUrl, "https://shop.example/p/tent");
});

test("a guessed start site that doesn't load falls back to a search", async () => {
    mockServices([
        { content: "https://dead.example/" },
        { content: "Trailhead 2P is $89.99." },
    ]);
    const log: string[] = [];
    const browser = fakeBrowser(log);
    const navigate = browser.navigate;
    browser.navigate = async (target: string) => {
        if (target.startsWith("https://dead.example")) {
            log.push(`navigate ${target} (not responding)`);
            throw new Error(`${target} is not responding.`);
        }
        return navigate(target);
    };
    const result = await runTask({
        goal: "find the price of the trailhead tent",
        config: resolveRuntimeModelConfig({ provider: "openrouter", apiKey: "sk-or-test", fastMode: true }),
        browser,
        confirm: async () => false,
    });

    assert.equal(log[0], "navigate https://dead.example/ (not responding)");
    assert.match(log[1], /^navigate https:\/\/www\.google\.com\/search\?q=find%20the%20price/);
    assert.match(result.answer, /89\.99/);
});

test("a failed task reports how far it got", async () => {
    mockServices([]);
    const log: string[] = [];
    const browser = fakeBrowser(log);
    browser.snapshot = async () => {
        throw new Error("Lost control of the tab (target_closed).");
    };
    await assert.rejects(
        runTask({
            goal: "buy the tent at https://shop.example/p/tent",
            config: resolveRuntimeModelConfig({ provider: "openrouter", apiKey: "sk-or-test", fastMode: true }),
            browser,
            confirm: async () => false,
        }),
        (error: unknown) => {
            assert.ok(error instanceof TaskFailedError);
            assert.equal(error.message, "Lost control of the tab (target_closed).");
            assert.equal(error.memory.finalUrl, "https://shop.example/p/tent");
            return true;
        }
    );
});

test("the planner splits a multi-part request and delegates each part to Jev", async () => {
    const chatReplies: Array<Record<string, unknown>> = [
        { content: null, tool_calls: [{ id: "d1", type: "function", function: { name: "delegate", arguments: JSON.stringify({ goal: "find the tent's price" }) } }] },
        { content: null, tool_calls: [{ id: "d2", type: "function", function: { name: "delegate", arguments: JSON.stringify({ goal: "find the tent's weight" }) } }] },
        { content: "Trailhead 2P costs $89.99 and weighs 2.1 kg." },
    ];
    const fastModeTasks: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        let body: Record<string, unknown>;
        if (url.endsWith("/systemone")) {
            const request = JSON.parse(String(init?.body || "{}")) as { state: { task?: string }; questions: Record<string, unknown> };
            if ("action" in request.questions) {
                fastModeTasks.push(String(request.state.task));
                body = { model: "jev", answers: { action: { type: "choice", choice: "done", confidence: 0.9, probabilities: { done: 0.9 } }, goal_done: { type: "noul", noul: 0.95 }, stuck: { type: "noul", noul: 0.01 } }, usage: {} };
            } else {
                body = { model: "jev", answers: { needs_browser: { type: "noul", noul: 0.95 }, parallel_sites: { type: "noul", noul: 0.02 }, changes_something: { type: "noul", noul: 0.02 }, multiple_parts: { type: "noul", noul: 0.9 } }, usage: {} };
            }
        } else {
            body = { choices: [{ message: chatReplies.shift() || { content: "done" } }] };
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const events: string[] = [];
    const result = await runTask({
        goal: "what does the tent at https://shop.example/p/tent cost, and how much does it weigh?",
        config: resolveRuntimeModelConfig({ provider: "openrouter", apiKey: "sk-or-test", fastMode: true }),
        browser: fakeBrowser([]),
        confirm: async () => false,
        onEvent: (event) => {
            if (event.type === "step") events.push(`${event.source} ${event.action} ${event.detail || ""}`.trim());
        },
    });

    assert.equal(result.mode, "planner");
    assert.match(result.answer, /89\.99.*2\.1 kg/);
    assert.deepEqual(fastModeTasks, ["find the tent's price", "find the tent's weight"], "each part went to Jev as its own sub-goal");
    assert.deepEqual(events.filter((event) => event.includes("delegate")), ["llm delegate find the tent's price", "llm delegate find the tent's weight"]);
});

test("earlier page views in the planner's history keep their text but drop their elements", () => {
    const page = "Page: Inbox (https://mail.example/)\nElements:\n[b1] link \"Inbox\"\n[b2] button \"Compose\"\n\nText:\nDental cleaning on October 3 at 10:30 AM.";
    const compacted = compactPlannerResult({ ok: true, page });
    assert.equal(compacted.page, "Page: Inbox (https://mail.example/)\n(Earlier page: elements omitted.)\nText:\nDental cleaning on October 3 at 10:30 AM.");
    assert.deepEqual(compactPlannerResult({ ok: true }), { ok: true });
});
