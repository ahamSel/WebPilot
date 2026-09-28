/**
 * Client for TypeSafe's Jev "System One" decision model.
 *
 * Jev does not generate text. It takes a JSON `state` plus named, typed
 * questions and returns typed answers with calibrated probabilities in a
 * single fast call (typically 0.2-0.5s). Reached through OpenRouter with the
 * same key as the chat models, or directly at api.typesafe.ai.
 */

export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";

export type JevCriteria = Record<string, string>;

export interface JevChoiceQuestion {
    type: "choice";
    instructions: string;
    /** Option id -> description. At most 255 options. */
    criteria: JevCriteria;
}

export interface JevNoulQuestion {
    type: "noul";
    instructions: string;
    criteria?: { true?: string; false?: string };
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

export interface JevChoiceAnswer {
    type: "choice";
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}

export interface JevNoulAnswer {
    type: "noul";
    noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export interface JevDecision {
    model: string;
    answers: Record<string, JevAnswer>;
    inputTokens: number;
    cost?: number;
    latencyMs: number;
}

export interface JevClientConfig {
    apiKey: string;
    /** OpenRouter (`https://openrouter.ai/api/v1`) or TypeSafe (`https://api.typesafe.ai/v1`). */
    baseUrl: string;
    model: string;
    timeoutMs: number;
    /** Cancels in-flight decisions when the user stops the task. */
    signal?: AbortSignal;
}

export const JEV_MAX_CHOICE_OPTIONS = 255;

const RETRYABLE_STATUSES = new Set([429, 502, 503, 529]);
const MAX_RETRIES = 2;

function systemOneUrl(baseUrl: string): string {
    const clean = baseUrl.trim().replace(/\/+$/, "");
    return clean.endsWith("/systemone") ? clean : `${clean}/systemone`;
}

function parseAnswer(raw: unknown): JevAnswer | null {
    if (!raw || typeof raw !== "object") return null;
    const answer = raw as Record<string, unknown>;
    if (answer.type === "choice" && typeof answer.choice === "string") {
        const probabilities: Record<string, number> = {};
        if (answer.probabilities && typeof answer.probabilities === "object") {
            for (const [key, value] of Object.entries(answer.probabilities as Record<string, unknown>)) {
                if (typeof value === "number" && Number.isFinite(value)) probabilities[key] = value;
            }
        }
        return {
            type: "choice",
            choice: answer.choice,
            probabilities,
            confidence: typeof answer.confidence === "number" ? answer.confidence : 0,
        };
    }
    if (answer.type === "noul" && typeof answer.noul === "number") {
        return { type: "noul", noul: answer.noul };
    }
    return null;
}

export function validateQuestions(questions: Record<string, JevQuestion>) {
    for (const [name, question] of Object.entries(questions)) {
        if (question.type !== "choice") continue;
        const count = Object.keys(question.criteria).length;
        if (count < 2) throw new Error(`Jev choice "${name}" needs at least 2 options.`);
        if (count > JEV_MAX_CHOICE_OPTIONS) {
            throw new Error(`Jev choice "${name}" has ${count} options; the limit is ${JEV_MAX_CHOICE_OPTIONS}.`);
        }
    }
}

export async function decide(
    config: JevClientConfig,
    state: unknown,
    questions: Record<string, JevQuestion>
): Promise<JevDecision> {
    validateQuestions(questions);
    const started = Date.now();
    const deadline = started + config.timeoutMs;
    const body = JSON.stringify({ model: config.model, state, questions });

    for (let attempt = 0; ; attempt++) {
        const response = await fetch(systemOneUrl(config.baseUrl), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
                "HTTP-Referer": "https://github.com/ahamSel/WebPilot",
                "X-OpenRouter-Title": "WebPilot",
            },
            body,
            signal: config.signal
                ? AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - Date.now())), config.signal])
                : AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });

        if (!response.ok) {
            const delay = Math.min(1000 * 2 ** attempt, 4000);
            if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES && Date.now() + delay < deadline) {
                await response.body?.cancel().catch(() => {});
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }
            const text = await response.text().catch(() => "");
            let message = text;
            try {
                const parsed = JSON.parse(text) as { error?: { message?: string } | string };
                message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message || text;
            } catch {
                // Keep the raw body.
            }
            throw new Error(`Jev request failed (${response.status}): ${message.slice(0, 300)}`);
        }

        const json = await response.json() as Record<string, unknown>;
        const rawAnswers = (json.answers && typeof json.answers === "object" ? json.answers : {}) as Record<string, unknown>;
        const answers: Record<string, JevAnswer> = {};
        for (const name of Object.keys(questions)) {
            const parsed = parseAnswer(rawAnswers[name]);
            if (!parsed) throw new Error(`Jev response is missing an answer for "${name}".`);
            answers[name] = parsed;
        }
        const usage = (json.usage && typeof json.usage === "object" ? json.usage : {}) as Record<string, unknown>;
        return {
            model: typeof json.model === "string" ? json.model : config.model,
            answers,
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
            cost: typeof usage.cost === "number" ? usage.cost : undefined,
            latencyMs: Date.now() - started,
        };
    }
}

export function choiceAnswer(decision: JevDecision, name: string): JevChoiceAnswer | undefined {
    const answer = decision.answers[name];
    return answer?.type === "choice" ? answer : undefined;
}

export function noulAnswer(decision: JevDecision, name: string): number {
    const answer = decision.answers[name];
    return answer?.type === "noul" ? answer.noul : 0;
}

/** Options ordered from most to least likely. */
export function rankedChoices(answer: JevChoiceAnswer | undefined): string[] {
    if (!answer) return [];
    const entries = Object.entries(answer.probabilities);
    if (!entries.length) return [answer.choice];
    return entries.sort((left, right) => right[1] - left[1]).map(([key]) => key);
}
