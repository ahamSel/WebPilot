/**
 * Environment-independent task runner: LLM + Jev over any browser that
 * implements `TaskBrowser`. The browser extension runs it over `chrome.debugger`
 * (lib/cdp/driver.ts); tests run it over Playwright's CDP session.
 *
 * Flow: Jev preflight (chat or browse) -> pick a starting page (the current tab,
 * a URL from the request, or one the LLM suggests) -> fast mode (Jev picks each
 * action, the LLM writes text) -> answer + Jev answer check. When fast mode
 * hands off, or Jev finds its answer unsupported, an LLM planner loop continues
 * on the same page. Irreversible clicks always go through `confirm`.
 */

import { createModelClient, resolveJevConfig, type RuntimeModelConfig, type ToolResponsePart } from "../model-client";
import { extractExplicitUrls } from "../goal-urls";
import { runFastMode, summarizeFastModeForPlanner, writeFastModeAnswer, type FastModeBrowser, type FastModeResult } from "../jev/fast-mode";
import { jevCheckAnswer, jevPreflight } from "../jev/gates";
import { describeElement, parsePage, selectCandidates, type PageModel } from "../jev/page";
import { UNTRUSTED_CONTENT_RULE, irreversibleAction } from "../safety";
import { getBrowserToolDeclarations } from "../tool-schema";

export interface TaskBrowser extends FastModeBrowser {
    navigate(url: string): Promise<string>;
    pageInfo(): Promise<{ url: string; title: string }>;
    /** Visible text of the page, for answers and reviews. */
    pageText(maxChars?: number): Promise<string>;
}

export type TaskEvent =
    | { type: "status"; message: string }
    | { type: "step"; source: "jev" | "llm"; action: string; detail?: string; url?: string }
    | { type: "handoff"; reason: string }
    | { type: "confirm"; action: string; url: string }
    | { type: "done"; answer: string; mode: "chat" | "fast" | "planner" };

export interface RunTaskOptions {
    goal: string;
    config: RuntimeModelConfig;
    browser: TaskBrowser;
    /** Earlier turns of the conversation, most recent last. */
    history?: Array<{ user: string; assistant: string }>;
    /** Ask the user before an irreversible click; resolve false to cancel it. */
    confirm: (action: string, pageUrl: string) => Promise<boolean>;
    onEvent?: (event: TaskEvent) => void;
    signal?: AbortSignal;
    maxPlannerSteps?: number;
    /**
     * Where to start when the current tab is not a web page (e.g. the browser's
     * New Tab page) and no site is obvious. `{query}` is replaced with the request.
     */
    fallbackSearchUrl?: string;
}

export interface RunTaskResult {
    answer: string;
    mode: "chat" | "fast" | "planner";
    steps: number;
    jevCalls: number;
    llmCalls: number;
    durationMs: number;
}

export class TaskCancelledError extends Error {
    constructor(public stats: { steps: number; jevCalls: number; llmCalls: number } = { steps: 0, jevCalls: 0, llmCalls: 0 }) {
        super("Stopped by user.");
        this.name = "TaskCancelledError";
    }
}

const FAST_ANSWER_ACCEPT = 0.8;
const FAST_ANSWER_ESCALATE_BELOW = 0.3;

function isWebPage(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

function extractJson(text: string): Record<string, unknown> | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function formatHistory(history: RunTaskOptions["history"]): string {
    if (!history?.length) return "";
    return history.slice(-6).map((turn) => `User: ${turn.user}\nWebPilot: ${turn.assistant.slice(0, 600)}`).join("\n\n");
}

/** Compact page view for the LLM planner: numbered actionable elements plus text. */
function plannerObservation(page: PageModel, task: string): string {
    const { selected, truncated } = selectCandidates(page.elements, task, 150);
    const elements = selected.map((element) => `[${element.ref}] ${describeElement(element, page.url)}`).join("\n");
    return `Page: ${page.title} (${page.url})\nElements${truncated ? " (trimmed to the most relevant)" : ""}:\n${elements || "(none)"}\n\nText:\n${page.text.slice(0, 4000)}`;
}

interface TaskStats {
    steps: number;
    jevCalls: number;
    llmCalls: number;
}

export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
    const stats: TaskStats = { steps: 0, jevCalls: 0, llmCalls: 0 };
    try {
        return await runTaskInner({ ...options, config: { ...options.config, signal: options.signal } }, stats);
    } catch (error) {
        // Stopping aborts in-flight model and Jev requests; report it as a stop.
        if (options.signal?.aborted) throw new TaskCancelledError({ ...stats });
        throw error;
    }
}

async function runTaskInner(options: RunTaskOptions, stats: TaskStats): Promise<RunTaskResult> {
    const started = Date.now();
    const { config, browser, goal } = options;
    const emit = (event: TaskEvent) => options.onEvent?.(event);
    const llm = createModelClient(config);
    const jevSetup = config.fastMode ? resolveJevConfig(config) : null;
    const jev = jevSetup && "jev" in jevSetup ? jevSetup.jev : null;
    const conversation = formatHistory(options.history);

    const checkCancelled = async () => {
        if (options.signal?.aborted) throw new TaskCancelledError({ ...stats });
    };
    const confirmOrCancel = async (action: string, url: string) => {
        emit({ type: "confirm", action, url });
        const allowed = await options.confirm(action, url);
        await checkCancelled();
        return allowed;
    };
    const finish = (answer: string, mode: RunTaskResult["mode"]): RunTaskResult => {
        emit({ type: "done", answer, mode });
        return { answer, mode, ...stats, durationMs: Date.now() - started };
    };

    const current = await browser.pageInfo().catch(() => ({ url: "", title: "" }));

    // 1. Chat or browse? Jev decides in ~0.3s when confident; otherwise the LLM routes.
    let browse: boolean | undefined;
    let changesSomething = false;
    if (jev && !conversation) {
        try {
            const preflight = await jevPreflight(jev, goal, "");
            stats.jevCalls++;
            browse = preflight.browse;
            changesSomething = preflight.changesSomething;
        } catch {
            browse = undefined;
        }
    }
    let browserGoal = goal;
    if (browse === undefined) {
        emit({ type: "status", message: "Understanding the request" });
        const routeText = await llm.generateText({
            model: config.navModel,
            systemInstruction: `You route requests for WebPilot, an assistant that lives in the user's browser and can control the current tab. Return JSON only. ${UNTRUSTED_CONTENT_RULE}`,
            prompt: `${conversation ? `Conversation so far:\n${conversation}\n\n` : ""}Current tab: ${current.title || "(none)"} ${current.url || ""}

User message: ${goal}

Use "chat" when no browser action or live page is needed (greetings, questions about you, things answerable from the conversation). Use "browse" otherwise, including questions about the current page. For "browse", write browser_goal as a self-contained task that resolves references to the conversation.

"changes_something" is true when the task buys, orders, books, sends, posts, deletes, subscribes or submits something (not just finding or reading).

{"mode": "chat|browse", "reply": "full reply when chat", "browser_goal": "task when browse", "changes_something": false}`,
            thinkingBudget: 512,
        });
        stats.llmCalls++;
        const route = extractJson(routeText);
        if (route?.mode === "chat" && typeof route.reply === "string" && route.reply.trim()) {
            return finish(route.reply.trim(), "chat");
        }
        if (typeof route?.browser_goal === "string" && route.browser_goal.trim()) browserGoal = route.browser_goal.trim();
        if (route?.changes_something === true) changesSomething = true;
    }
    await checkCancelled();

    // 2. Starting page: a URL in the request, the current tab, or one the LLM picks.
    const explicitUrl = extractExplicitUrls(browserGoal)[0];
    if (explicitUrl) {
        emit({ type: "step", source: "llm", action: "navigate", detail: explicitUrl, url: explicitUrl });
        await browser.navigate(explicitUrl);
        stats.steps++;
    } else {
        const onWebPage = isWebPage(current.url);
        const suggestion = await llm.generateText({
            model: config.navModel,
            systemInstruction: "You pick where a browser task should start. Reply with STAY when the task is about the web page the user already has open (or can be done from it); otherwise reply with one absolute https URL, such as the site the task names or a good search page. Reply with nothing else.",
            prompt: `Task: ${browserGoal}\nCurrent tab: ${onWebPage ? `${current.title || "(untitled)"} ${current.url}` : "a browser page with no website (such as the New Tab page); STAY is not possible"}`,
        });
        stats.llmCalls++;
        let url = extractExplicitUrls(suggestion)[0];
        if ((!url || /\bSTAY\b/.test(suggestion)) && onWebPage) url = "";
        if (!url && !onWebPage) {
            url = (options.fallbackSearchUrl || "https://www.google.com/search?q={query}").replace("{query}", encodeURIComponent(browserGoal));
        }
        if (url) {
            emit({ type: "step", source: "llm", action: "navigate", detail: url, url });
            await browser.navigate(url);
            stats.steps++;
        }
    }
    await checkCancelled();

    // 3. Fast mode: Jev picks actions, the LLM writes text. Requests that change
    // something (buy, send, delete...) go to the careful LLM planner instead: Jev is
    // weak at multi-step flows like add to cart -> checkout.
    let handoff = "";
    let fast: FastModeResult | null = null;
    if (jev && changesSomething) {
        emit({ type: "status", message: "Careful mode: this request changes something" });
    }
    if (jev && !changesSomething) {
        emit({ type: "status", message: "Working fast" });
        fast = await runFastMode({
            task: browserGoal,
            jev,
            browser,
            writer: llm,
            writerModel: config.navModel,
            writerTimeoutMs: config.timeoutMs,
            log: (_level, action) => {
                if (action === "jev_decision") stats.jevCalls++;
                if (action === "fast_mode_text_written") stats.llmCalls++;
            },
            checkStop: checkCancelled,
            confirm: confirmOrCancel,
            onStep: async (step) => {
                stats.steps++;
                emit({
                    type: "step",
                    source: "jev",
                    action: step.operation,
                    detail: step.target ? step.target.description + (step.text ? ` ← "${step.text}"` : "") : undefined,
                    url: step.page.url,
                });
            },
        });

        if (fast.outcome === "done") {
            emit({ type: "status", message: "Writing the answer" });
            const pageText = await browser.pageText(12_000);
            const answer = (await writeFastModeAnswer(llm, config.navModel, browserGoal, fast, pageText)).trim();
            stats.llmCalls++;
            let supported = FAST_ANSWER_ACCEPT;
            try {
                const check = await jevCheckAnswer(jev, browserGoal, answer, fast.page.url, pageText);
                stats.jevCalls++;
                supported = check.supportedProbability;
            } catch {
                // Keep the answer if the check itself fails.
            }
            if (supported >= FAST_ANSWER_ESCALATE_BELOW) return finish(answer, "fast");
            handoff = `${summarizeFastModeForPlanner(fast)}\nFast mode proposed an answer that the page does not support; verify on the page before finishing.\nProposed answer: ${answer.slice(0, 800)}`;
            emit({ type: "handoff", reason: `Fast mode's answer was not supported by the page (${supported.toFixed(2)}).` });
        } else {
            handoff = summarizeFastModeForPlanner(fast);
            emit({ type: "handoff", reason: fast.reason });
        }
    }

    // 4. LLM planner on the same page.
    emit({ type: "status", message: "Thinking it through" });
    const tools = getBrowserToolDeclarations({ includeTabTools: false });
    const chat = llm.createToolChat({
        model: config.navModel,
        tools,
        systemInstruction: `You are WebPilot, a browser agent working in the user's own browser tab. Task: ${browserGoal}

Tools: observe() returns the page's actionable elements as [ref] descriptions plus page text. click({ref, element}) and type({ref, text, submit?}) act on refs from the latest observe(). navigate({url}), scroll({direction}), wait({seconds}). finish({result}) ends the task with the answer for the user.

Rules:
- Call observe() before using refs, and again after actions that change the page.
- ${UNTRUSTED_CONTENT_RULE}
- Only take irreversible actions (buy, pay, send, delete, publish...) when the task clearly asks for them; the user is asked to confirm each one.
- Answer from what the page shows. Be concise and specific; include names, prices and links when relevant.`,
    });

    let lastPage: PageModel = parsePage(await browser.snapshot());
    let response = await chat.sendMessage(`${handoff ? `${handoff}\n\n` : ""}Current page:\n${plannerObservation(lastPage, browserGoal)}`);
    stats.llmCalls++;
    const maxSteps = options.maxPlannerSteps ?? 30;

    for (let turn = 0; turn < maxSteps; turn++) {
        await checkCancelled();
        if (!response.functionCalls.length) {
            return finish(response.text || "I could not complete this task.", "planner");
        }
        const outputs: ToolResponsePart[] = [];
        for (const call of response.functionCalls) {
            const args = call.args as Record<string, unknown>;
            let result: Record<string, unknown>;
            try {
                if (call.name === "finish") {
                    return finish(String(args.result || response.text || "").trim(), "planner");
                }
                if (call.name === "observe") {
                    lastPage = parsePage(await browser.snapshot());
                    result = { ok: true, page: plannerObservation(lastPage, browserGoal) };
                } else if (call.name === "click") {
                    const ref = String(args.ref || "");
                    const element = lastPage.elements.find((candidate) => candidate.ref === ref);
                    const risky = irreversibleAction(element ? { role: element.role, label: element.name } : { label: String(args.element || "") });
                    if (risky && !(await confirmOrCancel(risky, lastPage.url))) {
                        result = { ok: false, error: `The user declined ${risky}. Do not retry it.` };
                    } else {
                        await browser.click(ref, String(args.element || ""));
                        result = { ok: true };
                    }
                } else if (call.name === "type") {
                    await browser.type(String(args.ref || ""), String(args.element || ""), String(args.text || ""), args.submit === true);
                    result = { ok: true };
                } else if (call.name === "navigate") {
                    await browser.navigate(String(args.url || ""));
                    result = { ok: true, ...(await browser.pageInfo()) };
                } else if (call.name === "scroll") {
                    await browser.pressKey(args.direction === "up" ? "PageUp" : "PageDown");
                    result = { ok: true };
                } else if (call.name === "wait") {
                    await new Promise((resolve) => setTimeout(resolve, Math.min(10, Number(args.seconds) || 2) * 1000));
                    result = { ok: true };
                } else {
                    result = { ok: false, error: `Unknown tool ${call.name}` };
                }
            } catch (error) {
                if (error instanceof TaskCancelledError) throw error;
                result = { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
            }
            if (call.name !== "observe") {
                stats.steps++;
                emit({ type: "step", source: "llm", action: call.name, detail: String(args.element || args.url || args.text || ""), url: lastPage.url });
            }
            outputs.push({ functionResponse: { name: call.name, response: result } });
        }
        response = await chat.sendMessage(outputs);
        stats.llmCalls++;
    }
    return finish("I ran out of steps before finishing this task.", "planner");
}
