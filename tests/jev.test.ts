import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { JEV_TOKEN_BUDGET, decide, estimateJevTokens, rankedChoices, validateQuestions, type JevClientConfig } from "../lib/jev/client";
import { describeElement, parsePage, selectCandidates, type PageElement } from "../lib/jev/page";
import { runFastMode, type FastModeBrowser } from "../lib/jev/fast-mode";
import { jevCheckAnswer, jevPreflight } from "../lib/jev/gates";
import type { ModelClient } from "../lib/model-client";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

const JEV: JevClientConfig = {
    apiKey: "sk-or-test",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "typesafe/jev-1.13",
    timeoutMs: 5000,
};

interface JevRequest {
    url: string;
    body: { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: Record<string, string> }> };
}

/** Each queued responder receives the request and returns Jev `answers`. */
function mockJev(responders: Array<(request: JevRequest) => Record<string, unknown>>) {
    const requests: JevRequest[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request: JevRequest = { url: String(input), body: JSON.parse(String(init?.body)) };
        requests.push(request);
        const responder = responders.shift();
        if (!responder) throw new Error("Unexpected Jev call");
        return new Response(JSON.stringify({ model: "typesafe/jev-1.13-test", answers: responder(request), usage: { input_tokens: 100 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
    return requests;
}

function choice(option: string, probabilities: Record<string, number> = { [option]: 1 }) {
    return { type: "choice", choice: option, probabilities, confidence: 0.9 };
}

function noul(value: number) {
    return { type: "noul", noul: value };
}

function snapshot(url: string, title: string, yaml: string): string {
    return `### Page\n- Page URL: ${url}\n- Page Title: ${title}\n### Snapshot\n\`\`\`yaml\n${yaml}\n\`\`\``;
}

const HOME = snapshot("https://example.org/", "Home", [
    "- generic [ref=e1]:",
    "  - navigation \"Site\" [ref=e2]:",
    "    - link \"About us\" [ref=e3] [cursor=pointer]:",
    "      - /url: /about",
    "  - main [ref=e4]:",
    "    - heading \"Welcome\" [level=1] [ref=e5]",
    "    - paragraph [ref=e6]: Read about our",
    "    - link \"Pricing plans\" [ref=e7] [cursor=pointer]:",
    "      - /url: https://example.org/pricing",
    "    - textbox \"Search\" [ref=e8]: shoes",
    "    - checkbox \"Remember me\" [checked] [ref=e9]",
    "    - 'link \"\\\"Quoted\\\" title\" [ref=e10] [cursor=pointer]':",
    "      - /url: https://other.org/story",
    "    - button \"Buy now\" [ref=e11] [cursor=pointer]",
    "    - button \"Disabled\" [disabled] [ref=e12]",
].join("\n"));

const PRICING = snapshot("https://example.org/pricing", "Pricing", [
    "- main [ref=e1]:",
    "  - heading \"Pricing\" [level=1] [ref=e2]",
    "  - paragraph [ref=e3]: The Pro plan costs $10 per month.",
].join("\n"));

test("parsePage extracts actionable elements, landmarks, links and text", () => {
    const page = parsePage(HOME);
    assert.equal(page.url, "https://example.org/");
    assert.equal(page.title, "Home");

    const byRef = new Map(page.elements.map((element) => [element.ref, element]));
    assert.deepEqual([...byRef.keys()], ["e3", "e7", "e8", "e9", "e10", "e11"]);
    assert.equal(byRef.get("e3")?.chrome, true);
    assert.equal(byRef.get("e7")?.chrome, false);
    assert.equal(byRef.get("e7")?.url, "https://example.org/pricing");
    assert.equal(byRef.get("e8")?.kind, "type");
    assert.equal(byRef.get("e8")?.value, "shoes");
    assert.equal(byRef.get("e9")?.checked, true);
    assert.equal(byRef.get("e10")?.name, "\"Quoted\" title");
    assert.ok(!byRef.has("e12"), "disabled controls are not offered");

    assert.match(page.text, /Welcome Read about our Pricing plans/);
    assert.doesNotMatch(page.text, /About us/, "main-content text is preferred over navigation");

    assert.equal(describeElement(byRef.get("e7")!, page.url), "link \"Pricing plans\" -> /pricing");
    assert.equal(describeElement(byRef.get("e3")!, page.url), "link \"About us\" -> /about · site navigation");
    assert.equal(describeElement(byRef.get("e8")!, page.url), "textbox \"Search\" = \"shoes\"");
    assert.equal(describeElement(byRef.get("e10")!, page.url), "link \"\"Quoted\" title\" -> other.org/story");
});

test("page signature changes with content but not with identical snapshots", () => {
    assert.equal(parsePage(HOME).signature, parsePage(HOME).signature);
    assert.notEqual(parsePage(HOME).signature, parsePage(HOME.replace("shoes", "boots")).signature);
});

test("selectCandidates keeps task-relevant main content when it must truncate", () => {
    const elements: PageElement[] = Array.from({ length: 30 }, (_, index) => ({
        ref: `e${index}`,
        role: "link",
        name: index === 25 ? "Mosaic" : `Link ${index}`,
        kind: "click" as const,
        chrome: index < 10,
        index,
    }));
    elements.push({ ...elements[25], ref: "dup", index: 30 });

    const { selected, truncated } = selectCandidates(elements, "open the Mosaic browser article", 5);
    assert.equal(truncated, true);
    assert.equal(selected.length, 5);
    assert.ok(selected.some((element) => element.name === "Mosaic"));
    assert.ok(selected.every((element) => !element.chrome), "navigation links rank below content");
    assert.deepEqual(selected.map((element) => element.index), [...selected.map((element) => element.index)].sort((a, b) => a - b));

    const all = selectCandidates(elements, "anything", 100);
    assert.equal(all.truncated, false);
    assert.equal(all.selected.length, 30, "duplicate elements are collapsed");
});

test("Jev client validates questions, parses answers and ranks choices", async () => {
    assert.throws(() => validateQuestions({ q: { type: "choice", instructions: "x", criteria: { only: "one" } } }), /at least 2/);

    const requests = mockJev([() => ({ pick: choice("b", { a: 0.2, b: 0.7, c: 0.1 }), yes: noul(0.9) })]);
    const decision = await decide(JEV, { s: 1 }, {
        pick: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B", c: "C" } },
        yes: { type: "noul", instructions: "yes?" },
    });
    assert.equal(requests[0].url, "https://openrouter.ai/api/v1/systemone");
    assert.equal(requests[0].body.model, "typesafe/jev-1.13");
    assert.deepEqual(rankedChoices(decision.answers.pick.type === "choice" ? decision.answers.pick : undefined), ["b", "a", "c"]);
    assert.equal(decision.answers.yes.type === "noul" && decision.answers.yes.noul, 0.9);
});

function fakeBrowser(pages: Record<string, string>, start: string) {
    let current = start;
    const calls: string[] = [];
    const browser: FastModeBrowser = {
        snapshot: async () => pages[current],
        click: async (ref) => {
            calls.push(`click ${ref}`);
            if (ref === "e7") current = "pricing";
            return "### Ran Playwright code";
        },
        type: async (ref, _element, text, submit) => {
            calls.push(`type ${ref} ${text} ${submit}`);
            return "### Ran Playwright code";
        },
        pressKey: async (key) => {
            calls.push(`key ${key}`);
            return "";
        },
        back: async () => {
            calls.push("back");
            current = start;
            return "";
        },
    };
    return { browser, calls };
}

const noWriter = { generateText: async () => "", createToolChat: () => { throw new Error("unused"); } } as unknown as ModelClient;

function fastModeOptions(browser: FastModeBrowser, writer: ModelClient = noWriter) {
    return {
        task: "Find the price of the Pro plan",
        jev: JEV,
        browser,
        writer,
        writerModel: "test-model",
        writerTimeoutMs: 5000,
        log: () => {},
        checkStop: async () => {},
    };
}

test("fast mode clicks through to the answer and reports done", async () => {
    const requests = mockJev([
        () => ({ action: choice("click_e7"), goal_done: noul(0.02), stuck: noul(0.1), submit_after_typing: noul(0.5) }),
        () => ({ action: choice("done"), goal_done: noul(0.97), stuck: noul(0.02) }),
    ]);
    const { browser, calls } = fakeBrowser({ home: HOME, pricing: PRICING }, "home");
    const result = await runFastMode(fastModeOptions(browser));

    assert.equal(result.outcome, "done");
    assert.deepEqual(calls, ["click e7"]);
    assert.equal(result.page.url, "https://example.org/pricing");
    assert.equal(result.history[0].outcome, "now on \"Pricing\"");
    assert.deepEqual(result.pages.map((page) => page.title), ["Home", "Pricing"]);

    const criteria = requests[0].body.questions.action.criteria || {};
    assert.equal(criteria.click_e7, "click link \"Pricing plans\" -> /pricing");
    assert.equal(criteria.type_e8, "type into textbox \"Search\" = \"shoes\"");
    assert.ok("done" in criteria && "blocked" in criteria && !("back" in criteria));
    assert.ok("back" in (requests[1].body.questions.action.criteria || {}), "back is offered after navigating");
});

test("fast mode skips actions that did nothing and hands off after repeated no-progress", async () => {
    const requests = mockJev(Array.from({ length: 4 }, () => () => ({
        action: choice("click_e3", { click_e3: 0.6, click_e9: 0.3, scroll_down: 0.1 }),
        goal_done: noul(0.05),
        stuck: noul(0.2),
        submit_after_typing: noul(0.5),
    })));
    const { browser, calls } = fakeBrowser({ home: HOME }, "home");
    const result = await runFastMode({ ...fastModeOptions(browser), maxConsults: 0 });

    assert.equal(result.outcome, "handoff");
    assert.match(result.reason, /no visible progress/);
    assert.deepEqual(calls, ["click e3", "click e9", "key PageDown"], "each failed action is removed before re-deciding");
    assert.ok(!("click_e3" in (requests[1].body.questions.action.criteria || {})));
});

test("a blocked Jev asks the LLM for one step, then keeps driving", async () => {
    mockJev([
        () => ({ action: choice("blocked"), goal_done: noul(0.05), stuck: noul(0.3), submit_after_typing: noul(0.5) }),
        () => ({ action: choice("done"), goal_done: noul(0.96), stuck: noul(0.02) }),
    ]);
    const prompts: string[] = [];
    const writer = {
        generateText: async (request: { prompt: string }) => {
            prompts.push(request.prompt);
            return "{\"action\": \"click\", \"ref\": \"e7\", \"reason\": \"the pricing page lists plans\"}";
        },
        createToolChat: () => { throw new Error("unused"); },
    } as unknown as ModelClient;
    const { browser, calls } = fakeBrowser({ home: HOME, pricing: PRICING }, "home");
    const sources: string[] = [];
    const result = await runFastMode({ ...fastModeOptions(browser, writer), onStep: async (step) => { sources.push(step.source); } });

    assert.equal(result.outcome, "done");
    assert.deepEqual(calls, ["click e7"]);
    assert.deepEqual(sources, ["llm"], "the consulted step is credited to the LLM");
    assert.match(prompts[0], /blocked/);
    assert.match(prompts[0], /\[e7\] link "Pricing plans"/);
});

test("the LLM advisor can send Jev's task to the planner", async () => {
    mockJev([() => ({ action: choice("blocked"), goal_done: noul(0.05), stuck: noul(0.3), submit_after_typing: noul(0.5) })]);
    const writer = { generateText: async () => "{\"action\": \"handoff\", \"reason\": \"needs a form\"}", createToolChat: () => { throw new Error("unused"); } } as unknown as ModelClient;
    const { browser, calls } = fakeBrowser({ home: HOME }, "home");
    const result = await runFastMode(fastModeOptions(browser, writer));

    assert.equal(result.outcome, "handoff");
    assert.match(result.reason, /needs a form/);
    assert.deepEqual(calls, []);
});

test("Jev requests stay within its context budget on crowded pages", async () => {
    const links = Array.from({ length: 400 }, (_, index) => `  - link "Listing ${index}: ${"spacious family camping tent with vestibule and rainfly ".repeat(3)}" [ref=e${100 + index}]:\n    - /url: /item/${index}`);
    const crowded = snapshot("https://example.org/list", "Listings", `- main [ref=e1]:\n${links.join("\n")}\n  - paragraph [ref=e2]: ${"Lots of listing text. ".repeat(600)}`);
    const requests = mockJev([() => ({ action: choice("done"), goal_done: noul(0.95), stuck: noul(0.02) })]);
    const logged: string[] = [];
    const browser: FastModeBrowser = { snapshot: async () => crowded, click: async () => "", type: async () => "", pressKey: async () => "", back: async () => "" };
    // A small budget stands in for a page too big for Jev's 32k context.
    const budget = 6000;
    assert.ok(JEV_TOKEN_BUDGET > budget);
    const result = await runFastMode({ ...fastModeOptions(browser), task: "find a family tent", jevTokenBudget: budget, log: (_level, action) => { logged.push(action); } });

    assert.equal(result.outcome, "done");
    const body = requests[0].body;
    assert.ok(estimateJevTokens(body.state, body.questions as never) <= budget, "the request fits the budget");
    assert.ok(Object.keys(body.questions.action.criteria || {}).length < 250, "fewer options were offered");
    assert.ok(logged.includes("jev_request_trimmed"));
});

test("when a Jev call fails, the LLM picks that step", async () => {
    let jevCalls = 0;
    globalThis.fetch = (async () => {
        jevCalls++;
        if (jevCalls === 1) return new Response(JSON.stringify({ error: { message: "context length exceeded" } }), { status: 400, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ model: "jev", answers: { action: choice("done"), goal_done: noul(0.97), stuck: noul(0.02) }, usage: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const writer = {
        generateText: async () => "{\"action\": \"click\", \"ref\": \"e7\", \"reason\": \"pricing\"}",
        createToolChat: () => { throw new Error("unused"); },
    } as unknown as ModelClient;
    const { browser, calls } = fakeBrowser({ home: HOME, pricing: PRICING }, "home");
    const result = await runFastMode(fastModeOptions(browser, writer));

    assert.equal(result.outcome, "done");
    assert.deepEqual(calls, ["click e7"]);
});

test("fast mode hands irreversible clicks to the planner", async () => {
    mockJev([() => ({ action: choice("click_e11"), goal_done: noul(0.1), stuck: noul(0.1), submit_after_typing: noul(0.5) })]);
    const { browser, calls } = fakeBrowser({ home: HOME }, "home");
    const result = await runFastMode(fastModeOptions(browser));

    assert.equal(result.outcome, "handoff");
    assert.match(result.reason, /irreversible/);
    assert.deepEqual(calls, []);
});

test("fast mode asks the LLM for typed text and Jev for submit", async () => {
    mockJev([
        () => ({ action: choice("type_e8"), goal_done: noul(0.05), stuck: noul(0.1), submit_after_typing: noul(0.9) }),
        () => ({ action: choice("blocked"), goal_done: noul(0.05), stuck: noul(0.1), submit_after_typing: noul(0.5) }),
    ]);
    const writer = { generateText: async () => "\"pro plan price\"\nextra line", createToolChat: () => { throw new Error("unused"); } } as unknown as ModelClient;
    const { browser, calls } = fakeBrowser({ home: HOME }, "home");
    const result = await runFastMode(fastModeOptions(browser, writer));

    assert.deepEqual(calls, ["type e8 pro plan price true"]);
    assert.equal(result.outcome, "handoff");
    assert.match(result.reason, /blocked/);
});

test("Jev gates only shortcut the LLM when confident", async () => {
    mockJev([
        () => ({ needs_browser: noul(0.95), parallel_sites: noul(0.05), changes_something: noul(0.9), multiple_parts: noul(0.8) }),
        () => ({ needs_browser: noul(0.5), parallel_sites: noul(0.6), changes_something: noul(0.1), multiple_parts: noul(0.1) }),
        () => ({ answer_supported: noul(0.9) }),
        () => ({ answer_supported: noul(0.05) }),
    ]);
    const confident = await jevPreflight(JEV, "Go to example.com", "");
    assert.equal(confident.browse, true);
    assert.equal(confident.parallel, false);
    assert.equal(confident.changesSomething, true);
    assert.equal(confident.multiPart, true);

    const unsure = await jevPreflight(JEV, "hmm", "");
    assert.equal(unsure.browse, undefined);
    assert.equal(unsure.parallel, undefined);
    assert.equal(unsure.changesSomething, false);

    assert.equal((await jevCheckAnswer(JEV, "task", "answer", "https://x", "text")).accept, true);
    assert.equal((await jevCheckAnswer(JEV, "task", "answer", "https://x", "text")).accept, undefined, "Jev never rejects on its own");
});

test("links without an accessible name are named from their child text", () => {
    const page = parsePage(snapshot("https://docs.example/Array", "Array", [
        "- main [ref=e1]:",
        "  - term [ref=e2]:",
        "    - link [ref=e3] [cursor=pointer]:",
        "      - /url: /docs/Array/map",
        "      - code [ref=e4]: Array.prototype.map()",
        "  - definition [ref=e5]:",
        "    - paragraph [ref=e6]: Returns a new array.",
        "  - button [ref=e7] [cursor=pointer]:",
        "    - img [ref=e8]",
    ].join("\n")));

    const link = page.elements.find((element) => element.ref === "e3");
    assert.equal(link?.name, "Array.prototype.map()");
    assert.equal(link?.url, "/docs/Array/map");
    assert.ok(!page.elements.some((element) => element.ref === "e7"), "icon-only buttons with no text are dropped");
    assert.deepEqual(page.elements.map((element) => element.index), page.elements.map((_, index) => index));
});

test("fast mode does not retry a failing click when the page content keeps changing", async () => {
    let counter = 0;
    const requests = mockJev(Array.from({ length: 3 }, () => () => ({
        action: choice("click_e3", { click_e3: 0.5, click_e7: 0.4, scroll_down: 0.1 }),
        goal_done: noul(0.05),
        stuck: noul(0.2),
        submit_after_typing: noul(0.5),
    })));
    const calls: string[] = [];
    const browser: FastModeBrowser = {
        // Every snapshot differs (e.g. a live counter), like a dynamic page.
        snapshot: async () => HOME.replace("Read about our", `Read about our (${counter++})`),
        click: async (ref) => {
            calls.push(`click ${ref}`);
            if (ref === "e3") throw new Error("Timeout 5000ms exceeded");
            return "";
        },
        type: async () => "",
        pressKey: async () => "",
        back: async () => "",
    };
    await runFastMode({ ...fastModeOptions(browser), maxSteps: 2 });

    assert.deepEqual(calls, ["click e3", "click e7"]);
    assert.ok(!("click_e3" in (requests[1].body.questions.action.criteria || {})));
});

test("fast mode clicks an irreversible control only after the user confirms", async () => {
    mockJev([
        () => ({ action: choice("click_e11"), goal_done: noul(0.1), stuck: noul(0.1), submit_after_typing: noul(0.5) }),
        () => ({ action: choice("done"), goal_done: noul(0.95), stuck: noul(0.05), submit_after_typing: noul(0.5) }),
    ]);
    const { browser, calls } = fakeBrowser({ home: HOME }, "home");
    const asked: string[] = [];
    const result = await runFastMode({
        ...fastModeOptions(browser),
        confirm: async (action) => {
            asked.push(action);
            return true;
        },
    });

    assert.deepEqual(asked, ["button \"Buy now\""]);
    assert.deepEqual(calls, ["click e11"]);
    assert.equal(result.outcome, "done");
});

test("fast mode stops on a results page when done is likely and no action is confident", async () => {
    mockJev([
        () => ({ action: choice("click_e7", { click_e7: 0.2, click_e3: 0.19, scroll_down: 0.18 }), goal_done: noul(0.55), stuck: noul(0.1), submit_after_typing: noul(0.5) }),
    ]);
    const { browser, calls } = fakeBrowser({ home: HOME }, "home");
    const result = await runFastMode(fastModeOptions(browser));

    assert.equal(result.outcome, "done");
    assert.match(result.reason, /likely complete/);
    assert.deepEqual(calls, []);
});

test("a confident next action still runs even when done is somewhat likely", async () => {
    mockJev([
        () => ({ action: choice("click_e7", { click_e7: 0.9, done: 0.1 }), goal_done: noul(0.55), stuck: noul(0.1), submit_after_typing: noul(0.5) }),
        () => ({ action: choice("done"), goal_done: noul(0.95), stuck: noul(0.05) }),
    ]);
    const { browser, calls } = fakeBrowser({ home: HOME, pricing: PRICING }, "home");
    await runFastMode(fastModeOptions(browser));
    assert.deepEqual(calls, ["click e7"]);
});

test("a second pass cannot finish on the page whose answer was unsupported", async () => {
    const requests = mockJev([
        () => ({ action: choice("click_e7", { click_e7: 0.3, done: 0.2 }), goal_done: noul(0.9), stuck: noul(0.1), submit_after_typing: noul(0.5) }),
        () => ({ action: choice("done"), goal_done: noul(0.95), stuck: noul(0.05) }),
    ]);
    const { browser, calls } = fakeBrowser({ home: HOME, pricing: PRICING }, "home");
    const result = await runFastMode({ ...fastModeOptions(browser), noDoneOn: "https://example.org/" });

    assert.deepEqual(calls, ["click e7"], "goal_done=0.9 on the blocked page does not end the run");
    assert.equal(result.outcome, "done");
    assert.equal(result.page.url, "https://example.org/pricing");
    assert.ok(!("done" in (requests[0].body.questions.action.criteria || {})), "done is not offered on the blocked page");
});
