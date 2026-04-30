import { GoogleGenAI } from "@google/genai";
import {
    defaultBaseUrlForProvider,
    defaultModelsForProvider,
    normalizeProvider,
    type ModelProvider,
} from "./runtime-provider-presets";
import type { BrowserRuntimeOverrides } from "./browser-runtime";

export interface RuntimeModelOverrides {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    navModel?: string;
    synthModel?: string;
    reviewModel?: string;
    synthEnabled?: boolean;
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
    timeoutMs: number;
}

export interface RuntimeModelSummary {
    provider: ModelProvider;
    model: string;
    navModel: string;
    synthModel: string;
    reviewModel: string;
    synthEnabled: boolean;
    baseUrl?: string;
    hasApiKey: boolean;
}

export interface ToolDeclaration {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

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

interface OpenAiChatMessage {
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
}

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

function buildOpenAiCompatibleUrl(baseUrl: string): string {
    const clean = cleanBaseUrl(baseUrl);
    if (!clean) return "";
    if (clean.endsWith("/chat/completions")) return clean;
    if (clean.endsWith("/v1")) return `${clean}/chat/completions`;
    return `${clean}/v1/chat/completions`;
}

function lowerCaseSchemaType(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => lowerCaseSchemaType(item));
    }
    if (!value || typeof value !== "object") {
        if (typeof value === "string" && /^[A-Z_]+$/.test(value)) {
            return value.toLowerCase();
        }
        return value;
    }

    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === "type" && typeof child === "string") {
            next[key] = child.toLowerCase();
            continue;
        }
        next[key] = lowerCaseSchemaType(child);
    }
    return next;
}

function extractGeminiText(response: unknown): string {
    const candidateParts = (response as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    })?.candidates?.[0]?.content?.parts;
    const fromCandidates = Array.isArray(candidateParts)
        ? candidateParts
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("\n")
            .trim()
        : "";
    const directText = typeof (response as { text?: string })?.text === "string"
        ? (response as { text: string }).text.trim()
        : "";
    return directText || fromCandidates;
}

function extractGeminiFunctionCalls(response: unknown): ToolCall[] {
    const rawCalls = Array.isArray((response as { functionCalls?: unknown[] })?.functionCalls)
        ? (response as { functionCalls: Array<{ name?: string; args?: Record<string, unknown> }> }).functionCalls
        : [];
    return rawCalls
        .filter((call) => typeof call?.name === "string" && call.name.trim())
        .map((call) => ({
            name: String(call.name),
            args: typeof call.args === "object" && call.args ? call.args : {},
        }));
}

function normalizeOpenAiContent(content: unknown): string {
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

async function postOpenAiCompatibleJson(
    config: RuntimeModelConfig,
    body: Record<string, unknown>
): Promise<Record<string, unknown>> {
    const url = buildOpenAiCompatibleUrl(config.baseUrl);
    if (!url) {
        throw new Error(`Missing base URL for ${config.provider} provider.`);
    }

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${config.provider} request failed (${response.status}): ${text.slice(0, 400)}`);
    }

    return await response.json();
}

class GeminiToolChat implements ToolChat {
    private chat: ReturnType<GoogleGenAI["chats"]["create"]>;

    constructor(private config: RuntimeModelConfig, options: { model: string; systemInstruction: string; tools: ToolDeclaration[] }) {
        const ai = new GoogleGenAI({ apiKey: config.apiKey });
        this.chat = ai.chats.create({
            model: options.model,
            config: {
                systemInstruction: options.systemInstruction,
                tools: [{
                    functionDeclarations: options.tools,
                }],
            },
        });
    }

    async sendMessage(message: string | ToolResponsePart[]): Promise<ToolChatResponse> {
        const response = await this.chat.sendMessage({ message });
        return {
            text: extractGeminiText(response),
            functionCalls: extractGeminiFunctionCalls(response),
        };
    }
}

class GeminiModelClient implements ModelClient {
    constructor(private config: RuntimeModelConfig) {}

    createToolChat(options: { model: string; systemInstruction: string; tools: ToolDeclaration[] }): ToolChat {
        return new GeminiToolChat(this.config, options);
    }

    async generateText(options: GenerateTextOptions): Promise<string> {
        const ai = new GoogleGenAI({ apiKey: this.config.apiKey });
        const contents = options.systemInstruction
            ? `${options.systemInstruction}\n\n${options.prompt}`
            : options.prompt;
        const config = typeof options.thinkingBudget === "number"
            ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } }
            : undefined;
        const response = await ai.models.generateContent({
            model: options.model,
            contents,
            ...(config ? { config } : {}),
        });
        return extractGeminiText(response);
    }
}

class OpenAiCompatibleToolChat implements ToolChat {
    private messages: OpenAiChatMessage[];
    private tools: Array<{ type: "function"; function: Record<string, unknown> }>;
    private pendingToolCalls: Array<{ id: string; name: string }> = [];

    constructor(private config: RuntimeModelConfig, private options: { model: string; systemInstruction: string; tools: ToolDeclaration[] }) {
        this.messages = [{ role: "system", content: options.systemInstruction }];
        this.tools = options.tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: lowerCaseSchemaType(tool.parameters),
            },
        }));
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

        const response = await postOpenAiCompatibleJson(this.config, {
            model: this.options.model,
            messages: this.messages,
            tools: this.tools,
            tool_choice: this.tools.length ? "auto" : undefined,
        });

        const choice = Array.isArray(response.choices) ? response.choices[0] as Record<string, unknown> : undefined;
        const messageObj = choice && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
        const toolCallsRaw = Array.isArray(messageObj.tool_calls) ? messageObj.tool_calls as Array<Record<string, unknown>> : [];
        const text = normalizeOpenAiContent(messageObj.content);

        if (toolCallsRaw.length) {
            const assistantMessage: OpenAiChatMessage = {
                role: "assistant",
                content: text || null,
                tool_calls: [],
            };

            const functionCalls: ToolCall[] = [];
            this.pendingToolCalls = [];

            toolCallsRaw.forEach((call, index) => {
                const fn = typeof call.function === "object" && call.function ? call.function as Record<string, unknown> : {};
                const id = typeof call.id === "string" && call.id ? call.id : `tool_call_${Date.now()}_${index}`;
                const name = typeof fn.name === "string" ? fn.name : "";
                const argText = typeof fn.arguments === "string" ? fn.arguments : "{}";
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
        this.messages.push({ role: "assistant", content: text || "" });
        return { text, functionCalls: [] };
    }
}

class OpenAiCompatibleModelClient implements ModelClient {
    constructor(private config: RuntimeModelConfig) {}

    createToolChat(options: { model: string; systemInstruction: string; tools: ToolDeclaration[] }): ToolChat {
        return new OpenAiCompatibleToolChat(this.config, options);
    }

    async generateText(options: GenerateTextOptions): Promise<string> {
        const messages: OpenAiChatMessage[] = [];
        if (options.systemInstruction) {
            messages.push({ role: "system", content: options.systemInstruction });
        }
        messages.push({ role: "user", content: options.prompt });

        const response = await postOpenAiCompatibleJson(this.config, {
            model: options.model,
            messages,
        });

        const choice = Array.isArray(response.choices) ? response.choices[0] as Record<string, unknown> : undefined;
        const messageObj = choice && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
        return normalizeOpenAiContent(messageObj.content);
    }
}

export function resolveRuntimeModelConfig(overrides: RuntimeModelOverrides = {}): RuntimeModelConfig {
    const overrideProvider = optionalTrimmedString(overrides.provider);
    const overrideModel = optionalTrimmedString(overrides.model);
    const overrideNavModel = optionalTrimmedString(overrides.navModel);
    const overrideSynthModel = optionalTrimmedString(overrides.synthModel);
    const overrideReviewModel = optionalTrimmedString(overrides.reviewModel);
    const overrideApiKey = optionalTrimmedString(overrides.apiKey);
    const overrideBaseUrl = optionalTrimmedString(overrides.baseUrl);

    const provider = normalizeProvider(
        overrideProvider ||
        process.env.MODEL_PROVIDER ||
        process.env.OPENAI_COMPAT_PROVIDER ||
        (process.env.MODEL_BASE_URL || process.env.OPENAI_COMPAT_BASE_URL ? "openai-compatible" : "gemini")
    );
    const providerDefaults = defaultModelsForProvider(provider);

    const model = String(
        overrideModel ||
        process.env.MODEL_MODEL ||
        process.env.GEMINI_MODEL ||
        providerDefaults.navModel
    ).trim();

    const navModel = String(
        overrideNavModel ||
        process.env.MODEL_NAV_MODEL ||
        process.env.GEMINI_NAV_MODEL ||
        model
    ).trim();

    const synthModel = String(
        overrideSynthModel ||
        process.env.MODEL_SYNTH_MODEL ||
        process.env.GEMINI_SYNTH_MODEL ||
        providerDefaults.synthModel ||
        navModel
    ).trim();

    const reviewModel = String(
        overrideReviewModel ||
        process.env.MODEL_REVIEW_MODEL ||
        process.env.GEMINI_REVIEW_MODEL ||
        providerDefaults.reviewModel ||
        synthModel
    ).trim();

    const apiKey = String(
        overrideApiKey ??
        process.env.MODEL_API_KEY ??
        process.env.OPENAI_COMPAT_API_KEY ??
        process.env.GEMINI_API_KEY ??
        process.env.GOOGLE_API_KEY ??
        ""
    ).trim();

    const baseUrl = cleanBaseUrl(
        overrideBaseUrl ??
        process.env.MODEL_BASE_URL ??
        process.env.OPENAI_COMPAT_BASE_URL ??
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
            overrides.synthEnabled ??
            process.env.MODEL_SYNTH_ENABLED ??
            process.env.GEMINI_SYNTH_ENABLED,
            true
        ),
        timeoutMs: toTimeoutMs(
            overrides.timeoutMs ??
            process.env.MODEL_TIMEOUT_MS ??
            process.env.GEMINI_TIMEOUT_MS,
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
        baseUrl: config.baseUrl || undefined,
        hasApiKey: !!config.apiKey,
    };
}

export function hasRuntimeCredentials(config: RuntimeModelConfig): boolean {
    if (config.provider === "gemini") {
        return !!config.apiKey;
    }
    if (config.provider === "openai") {
        return !!config.apiKey;
    }
    return !!config.baseUrl;
}

export function createModelClient(config: RuntimeModelConfig): ModelClient {
    if (config.provider === "openai" || config.provider === "ollama") {
        return new OpenAiCompatibleModelClient(config);
    }
    return new GeminiModelClient(config);
}
