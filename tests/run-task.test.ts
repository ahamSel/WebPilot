import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { runTask, type TaskBrowser } from "../lib/core/run-task";
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
            ? { model: "jev", answers: { needs_browser: { type: "noul", noul: 0.95 }, parallel_sites: { type: "noul", noul: 0.02 }, changes_something: { type: "noul", noul: 0.95 } }, usage: {} }
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
