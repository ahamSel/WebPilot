import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    buildChatCompletionsUrl,
    createModelClient,
    hasRuntimeCredentials,
    reasoningEffortForBudget,
    resolveRuntimeModelConfig,
    type RuntimeModelConfig,
} from "../lib/model-client";
import {
    defaultModelsForProvider,
    isLegacyProvider,
    normalizeProvider,
    parseOpenRouterModels,
} from "../lib/runtime-provider-presets";
import { getBrowserToolDeclarations } from "../lib/tool-schema";

interface RecordedMessage {
    role: string;
    tool_call_id?: string;
    content?: string | null;
    reasoning_details?: unknown[];
}

interface RecordedRequest {
    url: string;
    headers: Record<string, string>;
    body: {
        messages: RecordedMessage[];
        tools?: Array<{ type: string; function: { parameters: { type: string } } }>;
        tool_choice?: string;
        reasoning?: unknown;
    };
}

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function mockFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
    const requests: RecordedRequest[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(input),
            headers: { ...(init?.headers as Record<string, string>) },
            body: JSON.parse(String(init?.body || "{}")),
        });
        const next = responses.shift();
        if (!next) throw new Error("Unexpected fetch call");
        return new Response(JSON.stringify(next.body), {
            status: next.status ?? 200,
            headers: { "Content-Type": "application/json", ...next.headers },
        });
    }) as typeof fetch;
    return requests;
}

function openRouterConfig(overrides: Partial<RuntimeModelConfig> = {}): RuntimeModelConfig {
    return resolveRuntimeModelConfig({
        provider: "openrouter",
        apiKey: "sk-or-test",
        timeoutMs: 20_000,
        ...overrides,
    });
}

test("unknown and legacy providers normalize to OpenRouter", () => {
    assert.equal(normalizeProvider("ollama"), "ollama");
    assert.equal(normalizeProvider("openrouter"), "openrouter");
    assert.equal(normalizeProvider("gemini"), "openrouter");
    assert.equal(normalizeProvider(undefined), "openrouter");
    assert.ok(isLegacyProvider("gemini"));
    assert.ok(isLegacyProvider("Anthropic"));
    assert.ok(!isLegacyProvider("openrouter"));
    assert.ok(!isLegacyProvider("ollama"));
});

test("legacy saved settings reset key and models to OpenRouter defaults", () => {
    const config = resolveRuntimeModelConfig({
        provider: "gemini",
        apiKey: "AIza-old-google-key",
        navModel: "gemini-2.5-flash",
        baseUrl: "",
    });
    const defaults = defaultModelsForProvider("openrouter");

    assert.equal(config.provider, "openrouter");
    assert.equal(config.navModel, defaults.navModel);
    assert.equal(config.synthModel, defaults.synthModel);
    assert.equal(config.baseUrl, "https://openrouter.ai/api/v1");
    assert.notEqual(config.apiKey, "AIza-old-google-key");
});

test("credential checks differ between OpenRouter and Ollama", () => {
    assert.equal(hasRuntimeCredentials({ ...openRouterConfig(), apiKey: "" }), false);
    assert.equal(hasRuntimeCredentials(openRouterConfig()), true);
    assert.equal(hasRuntimeCredentials(resolveRuntimeModelConfig({ provider: "ollama" })), true);
});

test("builds chat completions URLs for both providers", () => {
    assert.equal(buildChatCompletionsUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(buildChatCompletionsUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(buildChatCompletionsUrl("http://localhost:11434"), "http://localhost:11434/v1/chat/completions");
});

test("tool chat sends OpenRouter headers and preserves reasoning details across tool turns", async () => {
    const reasoningDetails = [{ type: "reasoning.encrypted", data: "opaque-signature" }];
    const requests = mockFetch([
        {
            body: {
                choices: [{
                    message: {
                        role: "assistant",
                        content: null,
                        reasoning_details: reasoningDetails,
                        tool_calls: [{
                            id: "call_1",
                            type: "function",
                            function: { name: "navigate", arguments: "{\"url\":\"https://example.com\"}" },
                        }],
                    },
                }],
            },
        },
        { body: { choices: [{ message: { role: "assistant", content: "Example Domain" } }] } },
    ]);

    const chat = createModelClient(openRouterConfig()).createToolChat({
        model: "google/gemini-3.8-flash",
        systemInstruction: "system",
        tools: getBrowserToolDeclarations(),
    });

    const first = await chat.sendMessage("Open example.com");
    assert.deepEqual(first.functionCalls, [{ id: "call_1", name: "navigate", args: { url: "https://example.com" } }]);

    const second = await chat.sendMessage([{ functionResponse: { name: "navigate", response: { ok: true } } }]);
    assert.equal(second.text, "Example Domain");

    assert.equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(requests[0].headers.Authorization, "Bearer sk-or-test");
    assert.equal(requests[0].headers["X-OpenRouter-Title"], "WebPilot");
    assert.equal(requests[0].body.tool_choice, "auto");
    assert.equal(requests[0].body.tools?.[0].type, "function");
    assert.equal(requests[0].body.tools?.[0].function.parameters.type, "object");

    const replayed = requests[1].body.messages;
    const assistant = replayed.find((message) => message.role === "assistant");
    assert.deepEqual(assistant?.reasoning_details, reasoningDetails);
    const toolResult = replayed.find((message) => message.role === "tool");
    assert.equal(toolResult?.tool_call_id, "call_1");
    assert.equal(toolResult?.content, "{\"ok\":true}");
});

test("tool chat compacts older tool results but keeps the latest ones whole", async () => {
    const observe = (id: string) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "observe", arguments: "{}" } }] });
    const requests = mockFetch([
        { body: { choices: [{ message: observe("c1") }] } },
        { body: { choices: [{ message: observe("c2") }] } },
        { body: { choices: [{ message: observe("c3") }] } },
        { body: { choices: [{ message: { role: "assistant", content: "done" } }] } },
    ]);
    const chat = createModelClient(openRouterConfig()).createToolChat({
        model: "google/gemini-3.8-flash",
        systemInstruction: "system",
        tools: getBrowserToolDeclarations(),
        compactToolResponse: (response) => ({ ...response, page: "(compacted)" }),
    });
    await chat.sendMessage("go");
    for (const page of ["page one", "page two", "page three"]) {
        await chat.sendMessage([{ functionResponse: { name: "observe", response: { ok: true, page } } }]);
    }

    const tools = requests[3].body.messages.filter((message) => message.role === "tool").map((message) => message.content);
    assert.deepEqual(tools, [
        "{\"ok\":true,\"page\":\"(compacted)\"}",
        "{\"ok\":true,\"page\":\"page two\"}",
        "{\"ok\":true,\"page\":\"page three\"}",
    ]);
});

test("streamed tool turns report text as written and rebuild tool calls and reasoning for the next turn", async () => {
    const sse = (deltas: Array<Record<string, unknown>>) => deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + "data: [DONE]\n\n";
    const bodies: Array<Record<string, unknown>> = [];
    const replies = [
        // Turn 1: a stray remark, then a tool call split across chunks.
        sse([
            { reasoning_details: [{ type: "reasoning.text", text: "Need the ", index: 0 }] },
            { reasoning_details: [{ type: "reasoning.text", text: "page first.", index: 0 }] },
            { content: "Let me look." },
            { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "observe", arguments: "" } }] },
            { tool_calls: [{ index: 0, function: { arguments: "{\"full\":" } }] },
            { tool_calls: [{ index: 0, function: { arguments: "true}" } }] },
        ]),
        // Turn 2: the answer, in pieces.
        sse([{ content: "The cheapest " }, { content: "tent is $89.99." }]),
    ];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body || "{}")));
        return new Response(replies.shift(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const shown: string[] = [];
    const chat = createModelClient(openRouterConfig()).createToolChat({
        model: "google/gemini-3.8-flash",
        systemInstruction: "system",
        tools: getBrowserToolDeclarations(),
        onText: (text) => shown.push(text),
        onTextReset: () => shown.push("<reset>"),
    });
    const first = await chat.sendMessage("cheapest tent?");
    assert.deepEqual(first.functionCalls, [{ id: "call_1", name: "observe", args: { full: true } }]);
    assert.deepEqual(shown, ["Let me look.", "<reset>"], "text before a tool call is withdrawn");

    const second = await chat.sendMessage([{ functionResponse: { name: "observe", response: { ok: true } } }]);
    assert.equal(second.text, "The cheapest tent is $89.99.");
    assert.deepEqual(shown.slice(2), ["The cheapest ", "tent is $89.99."]);

    assert.equal(bodies[0].stream, true);
    const replayed = (bodies[1].messages as Array<Record<string, unknown>>).find((message) => message.role === "assistant");
    assert.deepEqual(replayed?.reasoning_details, [{ type: "reasoning.text", text: "Need the page first.", index: 0 }]);
    assert.deepEqual(replayed?.tool_calls, [{ id: "call_1", type: "function", function: { name: "observe", arguments: "{\"full\":true}" } }]);
});

test("a tool turn that fails mid-stream is withdrawn and retried once", async () => {
    const sse = (events: Array<Record<string, unknown>>) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    const replies = [
        // The provider drops the request partway through the answer.
        sse([{ choices: [{ delta: { content: "Here are three" } }] }, { error: { message: "The operation was aborted" } }]),
        sse([{ choices: [{ delta: { content: "Here are three rentals." } }] }]),
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
        calls++;
        return new Response(replies.shift(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const shown: string[] = [];
    const chat = createModelClient(openRouterConfig()).createToolChat({
        model: "google/gemini-3.8-flash",
        systemInstruction: "system",
        tools: getBrowserToolDeclarations(),
        onText: (text) => shown.push(text),
        onTextReset: () => shown.push("<reset>"),
    });
    const reply = await chat.sendMessage("find rentals");
    assert.equal(calls, 2);
    assert.equal(reply.text, "Here are three rentals.");
    assert.deepEqual(shown, ["Here are three", "<reset>", "Here are three rentals."]);
});

test("Ollama requests omit OpenRouter-only fields", async () => {
    const requests = mockFetch([{ body: { choices: [{ message: { content: "hi" } }] } }]);
    const client = createModelClient(resolveRuntimeModelConfig({ provider: "ollama", navModel: "qwen3:8b" }));

    const chat = client.createToolChat({ model: "qwen3:8b", systemInstruction: "s", tools: getBrowserToolDeclarations() });
    await chat.sendMessage("hello");

    assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(requests[0].body.tool_choice, undefined);
    assert.equal(requests[0].headers["X-OpenRouter-Title"], undefined);
    assert.equal(requests[0].headers.Authorization, undefined);
});

test("generateText maps thinking budgets to reasoning effort on OpenRouter only", async () => {
    assert.equal(reasoningEffortForBudget(undefined), undefined);
    assert.equal(reasoningEffortForBudget(512), "low");
    assert.equal(reasoningEffortForBudget(2048), "medium");
    assert.equal(reasoningEffortForBudget(8192), "high");

    const requests = mockFetch([{ body: { choices: [{ message: { content: "{\"mode\":\"chat\"}" } }] } }]);
    const text = await createModelClient(openRouterConfig()).generateText({
        model: "google/gemini-3.8-flash",
        prompt: "route",
        systemInstruction: "router",
        thinkingBudget: 512,
    });

    assert.equal(text, "{\"mode\":\"chat\"}");
    assert.deepEqual(requests[0].body.reasoning, { effort: "low", exclude: true });
    assert.equal(requests[0].body.messages[0].role, "system");
});

test("retries rate-limited requests and surfaces provider error messages", async () => {
    const requests = mockFetch([
        { status: 429, body: { error: { code: 429, message: "slow down" } }, headers: { "Retry-After": "0" } },
        { body: { choices: [{ message: { content: "ok" } }] } },
    ]);
    const text = await createModelClient(openRouterConfig()).generateText({ model: "m", prompt: "p" });
    assert.equal(text, "ok");
    assert.equal(requests.length, 2);

    mockFetch([{ status: 401, body: { error: { code: 401, message: "No auth credentials found" } } }]);
    await assert.rejects(
        createModelClient(openRouterConfig()).generateText({ model: "m", prompt: "p" }),
        /OpenRouter request failed \(401\): No auth credentials found/
    );
});

test("parses the OpenRouter models catalog for the settings picker", () => {
    const models = parseOpenRouterModels({
        data: [
            {
                id: "google/gemini-3.8-flash",
                name: "Google: Gemini 3.8 Flash",
                created: 200,
                context_length: 1048576,
                pricing: { prompt: "0.000000375", completion: "0.000001875" },
                architecture: { input_modalities: ["text", "image"] },
            },
            { id: "google/gemini-3.8-flash:batch", name: "batch", created: 300, pricing: {} },
            { id: "qwen/qwen3.8-27b:free", name: "Qwen free", created: 100, pricing: { prompt: "0", completion: "0" } },
            { name: "missing id" },
        ],
    });

    assert.deepEqual(models.map((model) => model.value), ["google/gemini-3.8-flash", "qwen/qwen3.8-27b:free"]);
    assert.equal(models[0].contextLength, 1048576);
    assert.deepEqual(models[0].inputModalities, ["text", "image"]);
    assert.match(models[0].description || "", /1049K context · \$0\.375 in \/ \$1\.88 out per 1M/);
    assert.match(models[1].description || "", /free/);
});

test("stopping a task aborts an in-flight model request immediately", async () => {
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    const controller = new AbortController();
    const client = createModelClient({ ...openRouterConfig({ timeoutMs: 60_000 }), signal: controller.signal });
    const started = Date.now();
    const pending = client.generateText({ model: "m", prompt: "p" });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /abort/i);
    assert.ok(Date.now() - started < 2000, "the request should not wait for its 60s timeout");
});
