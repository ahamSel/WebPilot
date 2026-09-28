import { DEFAULT_JEV_MODEL, type JevClientConfig } from "./jev/client";
import {
    defaultBaseUrlForProvider,
    defaultModelsForProvider,
    isLegacyProvider,
    normalizeProvider,
    type ModelProvider,
} from "./runtime-provider-presets";
import type { BrowserRuntimeOverrides } from "./browser-runtime";
import {
    normalizeJsonSchemaTypes,
    normalizeToolDeclaration,
    type NormalizedToolDeclaration,
} from "./tool-schema";

export interface RuntimeModelOverrides {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    navModel?: string;
    synthModel?: string;
    reviewModel?: string;
    synthEnabled?: boolean;
    /** Fast mode: Jev picks each browser action; the LLM only writes text. */
    fastMode?: boolean;
    jevModel?: string;
    timeoutMs?: number;
    browser?: BrowserRuntimeOverrides;
}

export interface RuntimeModelConfig {
    provider: ModelProvider;
    apiKey: string;
    baseUrl: string;
    model: string;
    navModel: string;
    synthModel: string;
    reviewModel: string;
    synthEnabled: boolean;
    fastMode: boolean;
    jevModel: string;
    timeoutMs: number;
    /** Cancels in-flight requests when the user stops the task. */
    signal?: AbortSignal;
}

export interface RuntimeModelSummary {
    provider: ModelProvider;
    model: string;
    navModel: string;
    synthModel: string;
    reviewModel: string;
    synthEnabled: boolean;
    fastMode: boolean;
    jevModel?: string;
    baseUrl?: string;
    hasApiKey: boolean;
}

export type ToolDeclaration = NormalizedToolDeclaration;

export interface ToolCall {
    id?: string;
    name: string;
    args: Record<string, unknown>;
}

export interface ToolResponsePart {
    functionResponse: {
        name: string;
        response: Record<string, unknown>;
    };
}

export interface ToolChatResponse {
    text: string;
    functionCalls: ToolCall[];
}

export interface ToolChat {
    sendMessage(message: string | ToolResponsePart[]): Promise<ToolChatResponse>;
}

export interface GenerateTextOptions {
    model: string;
    prompt: string;
    systemInstruction?: string;
    thinkingBudget?: number;
}

export interface ModelClient {
    createToolChat(config: {
        model: string;
        systemInstruction: string;
        tools: ToolDeclaration[];
    }): ToolChat;
    generateText(options: GenerateTextOptions): Promise<string>;
}

interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
    // Reasoning models on OpenRouter (Gemini 3, Claude, ...) require their
    // reasoning blocks to be sent back unmodified across tool-call turns.
    reasoning_details?: unknown[];
}

const OPENROUTER_APP_URL = "https://github.com/ahamSel/WebPilot";
const OPENROUTER_APP_TITLE = "WebPilot";
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 10_000;

function boolFromInput(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
        if (normalized === "0" || normalized === "false" || normalized === "no") return false;
    }
    return fallback;
}

function toTimeoutMs(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function cleanBaseUrl(value: string | undefined): string {
    return String(value || "").trim().replace(/\/+$/, "");
}

function optionalTrimmedString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

export function buildChatCompletionsUrl(baseUrl: string): string {
    const clean = cleanBaseUrl(baseUrl);
    if (!clean) return "";
    if (clean.endsWith("/chat/completions")) return clean;
    if (clean.endsWith("/v1")) return `${clean}/chat/completions`;
    return `${clean}/v1/chat/completions`;
}

function lowerCaseSchemaType(value: unknown): unknown {
    return normalizeJsonSchemaTypes(value, "lower");
}

function normalizeContent(content: unknown): string {
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
                    return String((part as { text: string }).text);
                }
                return "";
            })
            .join("\n")
            .trim();
    }
    return "";
}

function stringifyToolResult(result: unknown): string {
    if (typeof result === "string") return result;
    try {
        return JSON.stringify(result ?? null);
    } catch {
        return String(result ?? "");
    }
}

function providerDisplayName(provider: ModelProvider): string {
    return provider === "ollama" ? "Ollama" : "OpenRouter";
}

function extractErrorMessage(text: string): string {
    try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
        if (typeof parsed.error === "string") return parsed.error;
        if (parsed.error && typeof parsed.error.message === "string") return parsed.error.message;
    } catch {
        // Not JSON; fall through to the raw text.
    }
    return text;
}

function retryDelayMs(response: Response, attempt: number): number {
    const header = response.headers.get("retry-after");
    const seconds = header ? Number(header) : NaN;
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt;
    return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/** Maps the planner's legacy thinking-token budget to an OpenRouter reasoning effort. */
export function reasoningEffortForBudget(budget: number | undefined): "low" | "medium" | "high" | undefined {
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return undefined;
    if (budget <= 1024) return "low";
    if (budget <= 4096) return "medium";
    return "high";
}

async function postChatCompletion(
    config: RuntimeModelConfig,
    body: Record<string, unknown>
): Promise<Record<string, unknown>> {
    const url = buildChatCompletionsUrl(config.baseUrl);
    if (!url) {
        throw new Error(`Missing base URL for ${providerDisplayName(config.provider)}.`);
    }

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }
    if (config.provider === "openrouter") {
        headers["HTTP-Referer"] = OPENROUTER_APP_URL;
        headers["X-OpenRouter-Title"] = OPENROUTER_APP_TITLE;
    }

    const deadline = Date.now() + config.timeoutMs;
    for (let attempt = 0; ; attempt++) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: config.signal ? AbortSignal.any([AbortSignal.timeout(remainingMs), config.signal]) : AbortSignal.timeout(remainingMs),
        });

        if (response.ok) {
            const json = await response.json() as Record<string, unknown>;
            // OpenRouter can report upstream failures inside a 200 response.
            const error = json.error as { message?: unknown } | undefined;
            if (error && !Array.isArray(json.choices)) {
                throw new Error(`${providerDisplayName(config.provider)} request failed: ${String(error.message || "unknown error")}`);
            }
            return json;
        }

        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES && !config.signal?.aborted) {
            const delay = retryDelayMs(response, attempt);
            if (Date.now() + delay < deadline) {
                await response.body?.cancel().catch(() => {});
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }
        }

        const text = await response.text().catch(() => "");
        const message = extractErrorMessage(text).slice(0, 400);
        throw new Error(`${providerDisplayName(config.provider)} request failed (${response.status}): ${message}`);
    }
}

function firstChoiceMessage(response: Record<string, unknown>): Record<string, unknown> {
    const choice = Array.isArray(response.choices) ? response.choices[0] as Record<string, unknown> : undefined;
    return choice && typeof choice.message === "object" && choice.message
        ? choice.message as Record<string, unknown>
        : {};
}

class ChatCompletionsToolChat implements ToolChat {
    private messages: ChatMessage[];
    private tools: Array<{ type: "function"; function: Record<string, unknown> }>;
    private pendingToolCalls: Array<{ id: string; name: string }> = [];

    constructor(private config: RuntimeModelConfig, private options: { model: string; systemInstruction: string; tools: ToolDeclaration[] }) {
        this.messages = [{ role: "system", content: options.systemInstruction }];
        this.tools = options.tools.map((rawTool) => {
            const tool = normalizeToolDeclaration(rawTool, { typeCase: "lower" });
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: lowerCaseSchemaType(tool.parameters),
                },
            };
        });
    }

    async sendMessage(message: string | ToolResponsePart[]): Promise<ToolChatResponse> {
        if (typeof message === "string") {
            this.messages.push({ role: "user", content: message });
        } else {
            message.forEach((part, index) => {
                const pending = this.pendingToolCalls[index];
                if (!pending) return;
                this.messages.push({
                    role: "tool",
                    tool_call_id: pending.id,
                    content: stringifyToolResult(part.functionResponse.response),
                });
            });
        }

        const body: Record<string, unknown> = {
            model: this.options.model,
            messages: this.messages,
        };
        if (this.config.provider === "openrouter") {
            // Browsing steps are short decisions; low effort keeps reasoning models
            // (Gemini 3 reasons at "medium" by default) fast. reasoning_details are
            // still returned so they can be passed back on the next turn.
            body.reasoning = { effort: "low" };
        }
        if (this.tools.length) {
            body.tools = this.tools;
            // Ollama rejects tool_choice; "auto" is its default behavior anyway.
            if (this.config.provider === "openrouter") body.tool_choice = "auto";
        }

        const response = await postChatCompletion(this.config, body);
        const messageObj = firstChoiceMessage(response);
        const toolCallsRaw = Array.isArray(messageObj.tool_calls) ? messageObj.tool_calls as Array<Record<string, unknown>> : [];
        const text = normalizeContent(messageObj.content);
        const reasoningDetails = Array.isArray(messageObj.reasoning_details) && messageObj.reasoning_details.length
            ? messageObj.reasoning_details as unknown[]
            : undefined;

        if (toolCallsRaw.length) {
            const assistantMessage: ChatMessage = {
                role: "assistant",
                content: text || null,
                tool_calls: [],
                ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
            };

            const functionCalls: ToolCall[] = [];
            this.pendingToolCalls = [];

            toolCallsRaw.forEach((call, index) => {
                const fn = typeof call.function === "object" && call.function ? call.function as Record<string, unknown> : {};
                const id = typeof call.id === "string" && call.id ? call.id : `tool_call_${Date.now()}_${index}`;
                const name = typeof fn.name === "string" ? fn.name : "";
                const argText = typeof fn.arguments === "string" && fn.arguments.trim() ? fn.arguments : "{}";
                let args: Record<string, unknown> = {};
                try {
                    const parsed = JSON.parse(argText);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        args = parsed as Record<string, unknown>;
                    }
                } catch {
                    args = {};
                }

                assistantMessage.tool_calls?.push({
                    id,
                    type: "function",
                    function: {
                        name,
                        arguments: argText,
                    },
                });
                this.pendingToolCalls.push({ id, name });
                functionCalls.push({ id, name, args });
            });

            this.messages.push(assistantMessage);
            return { text, functionCalls };
        }

        this.pendingToolCalls = [];
        this.messages.push({
            role: "assistant",
            content: text || "",
            ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
        });
        return { text, functionCalls: [] };
    }
}

class ChatCompletionsModelClient implements ModelClient {
    constructor(private config: RuntimeModelConfig) {}

    createToolChat(options: { model: string; systemInstruction: string; tools: ToolDeclaration[] }): ToolChat {
        return new ChatCompletionsToolChat(this.config, options);
    }

    async generateText(options: GenerateTextOptions): Promise<string> {
        const messages: ChatMessage[] = [];
        if (options.systemInstruction) {
            messages.push({ role: "system", content: options.systemInstruction });
        }
        messages.push({ role: "user", content: options.prompt });

        const body: Record<string, unknown> = {
            model: options.model,
            messages,
        };
        const effort = reasoningEffortForBudget(options.thinkingBudget) ?? "low";
        if (this.config.provider === "openrouter") {
            // OpenRouter ignores this for models without reasoning support.
            body.reasoning = { effort, exclude: true };
        }

        const response = await postChatCompletion(this.config, body);
        return normalizeContent(firstChoiceMessage(response).content);
    }
}

export function resolveRuntimeModelConfig(overrides: RuntimeModelOverrides = {}): RuntimeModelConfig {
    // Settings saved for a removed provider (Gemini, OpenAI, Claude) carry keys and
    // model ids that do not work on OpenRouter, so fall back to defaults for them.
    const legacyOverrides = isLegacyProvider(overrides.provider);
    const pick = (value: unknown) => (legacyOverrides ? undefined : optionalTrimmedString(value));

    const provider = normalizeProvider(optionalTrimmedString(overrides.provider) || process.env.MODEL_PROVIDER);
    const envMatchesProvider = !isLegacyProvider(process.env.MODEL_PROVIDER)
        && normalizeProvider(process.env.MODEL_PROVIDER) === provider;
    const env = (name: string) => (envMatchesProvider ? optionalTrimmedString(process.env[name]) : undefined);
    const providerDefaults = defaultModelsForProvider(provider);

    const model = String(
        pick(overrides.model) ||
        env("MODEL_MODEL") ||
        providerDefaults.navModel
    ).trim();

    const navModel = String(
        pick(overrides.navModel) ||
        env("MODEL_NAV_MODEL") ||
        model
    ).trim();

    const synthModel = String(
        pick(overrides.synthModel) ||
        env("MODEL_SYNTH_MODEL") ||
        providerDefaults.synthModel ||
        navModel
    ).trim();

    const reviewModel = String(
        pick(overrides.reviewModel) ||
        env("MODEL_REVIEW_MODEL") ||
        providerDefaults.reviewModel ||
        synthModel
    ).trim();

    const apiKey = String(
        pick(overrides.apiKey) ??
        (provider === "openrouter" ? optionalTrimmedString(process.env.OPENROUTER_API_KEY) : undefined) ??
        env("MODEL_API_KEY") ??
        ""
    ).trim();

    const baseUrl = cleanBaseUrl(
        pick(overrides.baseUrl) ??
        env("MODEL_BASE_URL") ??
        defaultBaseUrlForProvider(provider)
    );

    return {
        provider,
        apiKey,
        baseUrl,
        model,
        navModel,
        synthModel,
        reviewModel,
        synthEnabled: boolFromInput(
            overrides.synthEnabled ?? process.env.MODEL_SYNTH_ENABLED,
            true
        ),
        fastMode: boolFromInput(overrides.fastMode ?? process.env.WEBPILOT_FAST_MODE, false),
        jevModel: String(optionalTrimmedString(overrides.jevModel) || optionalTrimmedString(process.env.JEV_MODEL) || DEFAULT_JEV_MODEL),
        timeoutMs: toTimeoutMs(
            overrides.timeoutMs ?? process.env.MODEL_TIMEOUT_MS,
            120000
        ),
    };
}

export function getRuntimeModelSummary(config: RuntimeModelConfig): RuntimeModelSummary {
    return {
        provider: config.provider,
        model: config.model,
        navModel: config.navModel,
        synthModel: config.synthModel,
        reviewModel: config.reviewModel,
        synthEnabled: config.synthEnabled,
        fastMode: config.fastMode,
        jevModel: config.fastMode ? config.jevModel : undefined,
        baseUrl: config.baseUrl || undefined,
        hasApiKey: !!config.apiKey,
    };
}

export function hasRuntimeCredentials(config: RuntimeModelConfig): boolean {
    if (config.provider === "openrouter") {
        return !!config.apiKey;
    }
    return !!config.baseUrl;
}

export function missingCredentialsMessage(config: RuntimeModelConfig): string {
    return config.provider === "openrouter"
        ? "Missing OpenRouter API key. Add one in Settings."
        : "Missing Ollama base URL. Check the Ollama settings.";
}

/**
 * Jev is reached through OpenRouter with the same key as the chat models.
 * Returns why fast mode cannot run when it is unavailable.
 */
export function resolveJevConfig(config: RuntimeModelConfig): { jev: JevClientConfig } | { unavailable: string } {
    if (config.provider !== "openrouter") {
        return { unavailable: "Fast mode needs OpenRouter; Jev is not available for local Ollama models." };
    }
    if (!config.apiKey) return { unavailable: "Fast mode needs an OpenRouter API key." };
    return {
        jev: {
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            model: config.jevModel,
            timeoutMs: Math.min(config.timeoutMs, 20_000),
            signal: config.signal,
        },
    };
}

export function createModelClient(config: RuntimeModelConfig): ModelClient {
    return new ChatCompletionsModelClient(config);
}
