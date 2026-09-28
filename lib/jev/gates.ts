/**
 * Jev gates in front of LLM calls that are really yes/no decisions.
 *
 * Each gate returns a confident answer when Jev's probability is clearly on
 * one side, and `undefined` in the uncertain middle so the caller falls back
 * to the LLM. Jev answers in ~0.3s; the LLM calls these replace take 2-15s.
 */

import { decide, noulAnswer, type JevClientConfig } from "./client";

export interface PreflightResult {
    /** true: browse without asking the LLM router; undefined: ask the router. */
    browse?: boolean;
    /** false: skip the LLM split analysis; undefined: run it. */
    parallel?: boolean;
    /**
     * true: the request changes something (buy, book, send, delete, submit...).
     * Jev handles finding and reading well but is weak at multi-step flows like
     * add to cart -> checkout, so these skip fast mode and go to the LLM planner.
     */
    changesSomething: boolean;
    needsBrowserProbability: number;
    parallelProbability: number;
    changesSomethingProbability: number;
    latencyMs: number;
}

const BROWSE_THRESHOLD = 0.8;
const PARALLEL_SKIP_BELOW = 0.35;
const CHANGES_SOMETHING_THRESHOLD = 0.5;
const ACCEPT_THRESHOLD = 0.8;

export async function jevPreflight(jev: JevClientConfig, message: string, conversationContext: string): Promise<PreflightResult> {
    const decision = await decide(
        jev,
        {
            user_message: message,
            conversation_context: conversationContext.slice(0, 4000) || "none",
            app: "WebPilot is an agentic browser. It can chat with the user directly or control a web browser to navigate, click, type, read pages, and extract information.",
        },
        {
            needs_browser: {
                type: "noul",
                instructions: "Does answering the user's current message require controlling a web browser: visiting websites, reading live web pages, clicking, filling forms, or extracting information from the web? Answer false for greetings, questions about the app itself, or requests the assistant can answer from the conversation alone.",
            },
            parallel_sites: {
                type: "noul",
                instructions: "Does the message ask for two or more independent sub-tasks on different websites that could run at the same time without needing each other's results (for example, compare prices on two different stores)? Answer false for single-site tasks and for steps that depend on each other.",
            },
            changes_something: {
                type: "noul",
                instructions: "Does the message ask the assistant to carry out an action that changes something for the user, such as buying, ordering, adding to a cart, booking, paying, sending or replying to a message, posting, deleting, subscribing, or submitting a form? Answer false when the user only wants to find, compare, read, check or summarize information.",
            },
        }
    );
    const needsBrowser = noulAnswer(decision, "needs_browser");
    const parallel = noulAnswer(decision, "parallel_sites");
    const changesSomething = noulAnswer(decision, "changes_something");
    return {
        browse: needsBrowser >= BROWSE_THRESHOLD ? true : undefined,
        parallel: parallel < PARALLEL_SKIP_BELOW ? false : undefined,
        needsBrowserProbability: needsBrowser,
        parallelProbability: parallel,
        changesSomething: changesSomething >= CHANGES_SOMETHING_THRESHOLD,
        changesSomethingProbability: changesSomething,
        latencyMs: decision.latencyMs,
    };
}

export interface AnswerCheck {
    /**
     * true: accept without the LLM reviewer; undefined: ask the reviewer.
     * Jev never rejects on its own: a wrong rejection sends the task back to
     * the slow planner loop, so an unconvinced Jev defers to the LLM instead.
     */
    accept?: true;
    supportedProbability: number;
    latencyMs: number;
}

export async function jevCheckAnswer(jev: JevClientConfig, task: string, answer: string, pageUrl: string, pageText: string): Promise<AnswerCheck> {
    const decision = await decide(
        jev,
        {
            task,
            proposed_answer: answer.slice(0, 3000),
            page: { url: pageUrl, text: pageText.slice(0, 12000) },
        },
        {
            answer_supported: {
                type: "noul",
                instructions: "Does the proposed answer complete the task, with every factual claim in it supported by the page text? Answer false if the answer is speculative, contradicts the page, misses part of what the task asked for, or relies on information that is not on the page.",
            },
        }
    );
    const supported = noulAnswer(decision, "answer_supported");
    return {
        accept: supported >= ACCEPT_THRESHOLD ? true : undefined,
        supportedProbability: supported,
        latencyMs: decision.latencyMs,
    };
}
