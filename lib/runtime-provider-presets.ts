export type ModelProvider = "openrouter" | "ollama";

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

export interface ProviderPreset {
  id: ModelProvider;
  label: string;
  apiKeyLabel: string;
  apiKeyPlaceholder: string;
  apiKeyRequired: boolean;
  apiKeyUrl?: string;
  notes: string[];
  navModels: ModelOption[];
  synthModels: ModelOption[];
  reviewModels: ModelOption[];
}

export interface OllamaModelOption extends ModelOption {
  modifiedAt?: string;
  capabilities?: string[];
  contextLength?: number;
}

export interface OllamaDiscoveryResult {
  status: "ready" | "empty" | "unavailable";
  message: string;
  endpoint: string;
  models: OllamaModelOption[];
  hiddenModels?: OllamaModelOption[];
  defaultModel?: string;
}

export interface OpenRouterModelOption extends ModelOption {
  contextLength?: number;
  promptPricePerMillion?: number;
  completionPricePerMillion?: number;
  inputModalities?: string[];
  created?: number;
}

export interface OpenRouterDiscoveryResult {
  status: "ready" | "unavailable";
  message: string;
  endpoint: string;
  models: OpenRouterModelOption[];
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const OPENROUTER_TOOL_MODELS_URL = `${OPENROUTER_BASE_URL}/models?supported_parameters=tools`;
const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";
const OLLAMA_SHOW_URL = "http://127.0.0.1:11434/api/show";

// OpenRouter model ids are "<vendor>/<model>". Any tool-capable model id works;
// these are only the suggested defaults shown before live discovery loads.
const OR_GEMINI_FLASH = "google/gemini-3.8-flash";
const OR_GEMINI_FLASH_LITE = "google/gemini-3.5-flash-lite";
const OR_CLAUDE_SONNET = "anthropic/claude-sonnet-5";
const OR_CLAUDE_HAIKU = "anthropic/claude-haiku-4.5";
const OR_GPT_LUNA = "openai/gpt-6-luna";
const OR_GPT_SOL = "openai/gpt-6-sol";
const OR_QWEN_FLASH = "qwen/qwen3.8-flash";
const OR_DEEPSEEK_FLASH = "deepseek/deepseek-v4.1-flash";

const LEGACY_PROVIDERS = new Set([
  "gemini",
  "google",
  "openai",
  "openai-compatible",
  "openai_compatible",
  "anthropic",
  "claude",
]);

export const PROVIDER_PRESETS: Record<ModelProvider, ProviderPreset> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    apiKeyLabel: "OpenRouter API key",
    apiKeyPlaceholder: "sk-or-...",
    apiKeyRequired: true,
    apiKeyUrl: "https://openrouter.ai/settings/keys",
    notes: [
      "One key gives access to Gemini, Claude, GPT, Qwen, DeepSeek and most other hosted models.",
      "Only models that support tool calling are listed. Use a fast model for navigation and a stronger one for synthesis.",
    ],
    navModels: [
      { value: OR_GEMINI_FLASH, label: "Gemini 3.8 Flash", description: "Fast default planner." },
      { value: OR_GEMINI_FLASH_LITE, label: "Gemini 3.5 Flash-Lite", description: "Cheapest Gemini option." },
      { value: OR_GPT_LUNA, label: "GPT-6 Luna", description: "Fast, very low cost." },
      { value: OR_QWEN_FLASH, label: "Qwen 3.8 Flash", description: "Fast open-weight option." },
      { value: OR_DEEPSEEK_FLASH, label: "DeepSeek V4.1 Flash", description: "Fast open-weight option." },
      { value: OR_CLAUDE_HAIKU, label: "Claude Haiku 4.5", description: "Fast Claude planner." },
    ],
    synthModels: [
      { value: OR_CLAUDE_SONNET, label: "Claude Sonnet 5", description: "High-quality synthesis." },
      { value: OR_GPT_SOL, label: "GPT-6 Sol", description: "Strong synthesis." },
      { value: OR_GEMINI_FLASH, label: "Gemini 3.8 Flash", description: "Fast synthesis." },
    ],
    reviewModels: [
      { value: OR_GEMINI_FLASH, label: "Gemini 3.8 Flash", description: "Fast review." },
      { value: OR_CLAUDE_SONNET, label: "Claude Sonnet 5", description: "Thorough review." },
      { value: OR_GPT_SOL, label: "GPT-6 Sol", description: "Thorough review." },
    ],
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    apiKeyLabel: "API key",
    apiKeyPlaceholder: "",
    apiKeyRequired: false,
    notes: [
      "Ollama runs locally and does not need an API key on localhost.",
      "Only models already pulled into Ollama appear here.",
    ],
    navModels: [],
    synthModels: [],
    reviewModels: [],
  },
};

export function providerOrder(): ModelProvider[] {
  return ["openrouter", "ollama"];
}

export function normalizeProvider(value: unknown): ModelProvider {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "ollama") return "ollama";
  return "openrouter";
}

/**
 * True for providers from before the OpenRouter switch (Gemini, OpenAI, Claude).
 * Their saved keys and model ids do not work on OpenRouter, so callers should
 * reset them to OpenRouter defaults instead of carrying them over.
 */
export function isLegacyProvider(value: unknown): boolean {
  return LEGACY_PROVIDERS.has(String(value || "").trim().toLowerCase());
}

export function providerLabel(provider: unknown): string {
  return PROVIDER_PRESETS[normalizeProvider(provider)].label;
}

export function defaultBaseUrlForProvider(provider: unknown): string {
  return normalizeProvider(provider) === "ollama" ? OLLAMA_BASE_URL : OPENROUTER_BASE_URL;
}

export function defaultModelsForProvider(provider: unknown) {
  if (normalizeProvider(provider) === "openrouter") {
    return {
      navModel: OR_GEMINI_FLASH,
      synthModel: OR_CLAUDE_SONNET,
      reviewModel: OR_GEMINI_FLASH,
    };
  }
  return {
    navModel: "",
    synthModel: "",
    reviewModel: "",
  };
}

const OPENROUTER_DISCOVERY_TTL_MS = 10 * 60 * 1000;
let openRouterDiscoveryCache: { at: number; result: OpenRouterDiscoveryResult } | null = null;

function perMillion(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed * 1_000_000;
}

function formatPrice(value: number | undefined): string {
  if (value === undefined) return "";
  if (value === 0) return "free";
  return `$${Number(value.toFixed(value < 1 ? 3 : 2))}`;
}

export function parseOpenRouterModels(json: unknown): OpenRouterModelOption[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const models: OpenRouterModelOption[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const model = raw as Record<string, unknown>;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    // Batch variants are async-only and never useful for interactive browsing.
    if (!id || id.endsWith(":batch")) continue;
    const pricing = (model.pricing && typeof model.pricing === "object" ? model.pricing : {}) as Record<string, unknown>;
    const architecture = (model.architecture && typeof model.architecture === "object"
      ? model.architecture
      : {}) as Record<string, unknown>;
    const promptPrice = perMillion(pricing.prompt);
    const completionPrice = perMillion(pricing.completion);
    const contextLength = typeof model.context_length === "number" ? model.context_length : undefined;
    const inputModalities = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities.filter((item): item is string => typeof item === "string")
      : undefined;
    const priceLabel = promptPrice === undefined
      ? ""
      : promptPrice === 0 && completionPrice === 0
        ? "free"
        : `${formatPrice(promptPrice)} in / ${formatPrice(completionPrice)} out per 1M`;
    models.push({
      value: id,
      label: typeof model.name === "string" && model.name.trim() ? model.name.trim() : id,
      description: [
        contextLength ? `${Math.round(contextLength / 1000)}K context` : "",
        priceLabel,
      ].filter(Boolean).join(" · "),
      contextLength,
      promptPricePerMillion: promptPrice,
      completionPricePerMillion: completionPrice,
      inputModalities,
      created: typeof model.created === "number" ? model.created : undefined,
    });
  }
  return models.sort((left, right) => (right.created || 0) - (left.created || 0));
}

export async function discoverOpenRouterModels(options: { force?: boolean } = {}): Promise<OpenRouterDiscoveryResult> {
  if (
    !options.force &&
    openRouterDiscoveryCache &&
    Date.now() - openRouterDiscoveryCache.at < OPENROUTER_DISCOVERY_TTL_MS
  ) {
    return openRouterDiscoveryCache.result;
  }

  try {
    // The models list is public, so discovery works before a key is entered.
    const response = await fetch(OPENROUTER_TOOL_MODELS_URL, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return {
        status: "unavailable",
        message: `OpenRouter responded with ${response.status}. Showing suggested models only.`,
        endpoint: OPENROUTER_TOOL_MODELS_URL,
        models: [],
      };
    }
    const models = parseOpenRouterModels(await response.json().catch(() => ({})));
    const result: OpenRouterDiscoveryResult = {
      status: "ready",
      message: `${models.length} tool-capable OpenRouter models available.`,
      endpoint: OPENROUTER_TOOL_MODELS_URL,
      models,
    };
    openRouterDiscoveryCache = { at: Date.now(), result };
    return result;
  } catch {
    return {
      status: "unavailable",
      message: "Could not reach OpenRouter. Showing suggested models only.",
      endpoint: OPENROUTER_TOOL_MODELS_URL,
      models: [],
    };
  }
}

function summarizeOllamaModel(details: Record<string, unknown> | null | undefined): string {
  const parameterSize = typeof details?.parameter_size === "string" ? details.parameter_size : "";
  const quantization = typeof details?.quantization_level === "string" ? details.quantization_level : "";
  return [parameterSize, quantization].filter(Boolean).join(" · ");
}

function modelFamily(details: Record<string, unknown> | null | undefined): string {
  return typeof details?.family === "string" ? details.family.toLowerCase() : "";
}

function contextLengthFromModelInfo(modelInfo: Record<string, unknown> | null | undefined): number | undefined {
  if (!modelInfo) return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!key.endsWith(".context_length") || typeof value !== "number") continue;
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function isEmbeddingOnlyModel(model: {
  name: string;
  details?: Record<string, unknown>;
  capabilities?: string[];
}) {
  const capabilities = model.capabilities || [];
  if (capabilities.includes("completion")) return false;
  if (capabilities.length > 0) return capabilities.includes("embedding");

  const normalized = model.name.toLowerCase();
  const family = modelFamily(model.details);
  return (
    family === "bert" ||
    normalized.includes("embed") ||
    normalized.includes("bge-") ||
    normalized.includes("bge_") ||
    normalized.startsWith("bge:") ||
    normalized.startsWith("bge-") ||
    normalized.startsWith("all-minilm") ||
    normalized.startsWith("mxbai-embed") ||
    normalized.startsWith("nomic-embed") ||
    normalized.startsWith("qwen3-embedding") ||
    normalized.startsWith("embeddinggemma")
  );
}

function ollamaModelPriority(name: string) {
  const normalized = name.toLowerCase();
  const priorities: Array<[RegExp, number]> = [
    [/^gpt-oss:20b($|-)/, 0],
    [/^gpt-oss(?::latest)?$/, 1],
    [/^qwen3-coder(?::30b|:latest)?$/, 2],
    [/^qwen3-coder/, 3],
    [/^qwen3:30b/, 4],
    [/^qwen3:14b/, 5],
    [/^qwen3:8b/, 6],
    [/^qwen3(?::latest)?$/, 7],
    [/^mistral-small/, 8],
    [/^llama3\.3/, 9],
    [/^gemma4/, 10],
    [/^gemma3/, 11],
  ];
  return priorities.find(([pattern]) => pattern.test(normalized))?.[1] ?? 100;
}

function compareOllamaModels(left: OllamaModelOption, right: OllamaModelOption) {
  const priority = ollamaModelPriority(left.value) - ollamaModelPriority(right.value);
  if (priority !== 0) return priority;
  return compareModifiedAtDescending(left.modifiedAt, right.modifiedAt);
}

function compareModifiedAtDescending(left?: string, right?: string) {
  const leftMs = left ? Date.parse(left) : 0;
  const rightMs = right ? Date.parse(right) : 0;
  return rightMs - leftMs;
}

async function getOllamaModelMetadata(modelName: string): Promise<{
  capabilities?: string[];
  details?: Record<string, unknown>;
  contextLength?: number;
} | null> {
  try {
    const response = await fetch(OLLAMA_SHOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, verbose: false }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const json = await response.json().catch(() => ({}));
    const capabilities = Array.isArray(json?.capabilities)
      ? json.capabilities.filter((capability: unknown): capability is string => typeof capability === "string")
      : undefined;
    const details = json?.details && typeof json.details === "object"
      ? json.details as Record<string, unknown>
      : undefined;
    const modelInfo = json?.model_info && typeof json.model_info === "object"
      ? json.model_info as Record<string, unknown>
      : undefined;
    return {
      capabilities,
      details,
      contextLength: contextLengthFromModelInfo(modelInfo),
    };
  } catch {
    return null;
  }
}

export async function discoverOllamaModels(): Promise<OllamaDiscoveryResult> {
  try {
    const response = await fetch(OLLAMA_TAGS_URL, {
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      return {
        status: "unavailable",
        message: `Ollama responded with ${response.status}.`,
        endpoint: OLLAMA_TAGS_URL,
        models: [],
      };
    }

    const json = await response.json().catch(() => ({}));
    const rawModels = Array.isArray(json?.models) ? json.models : [];
    const modelCandidates = await Promise.all(rawModels.map(async (model: any) => {
        const name = typeof model?.name === "string" && model.name.trim()
          ? model.name.trim()
          : typeof model?.model === "string" && model.model.trim()
            ? model.model.trim()
            : "";
        if (!name) return null;
        const modifiedAt = typeof model?.modified_at === "string" ? model.modified_at : undefined;
        const metadata = await getOllamaModelMetadata(name);
        const details = metadata?.details || (
          model?.details && typeof model.details === "object" ? model.details as Record<string, unknown> : undefined
        );
        const capabilities = metadata?.capabilities;
        const summary = summarizeOllamaModel(details);
        const capabilityLabel = capabilities?.includes("tools")
          ? "tools"
          : capabilities?.includes("embedding")
            ? "embedding"
            : "";
        const description = [summary, metadata?.contextLength ? `${Math.round(metadata.contextLength / 1000)}K context` : "", capabilityLabel]
          .filter(Boolean)
          .join(" · ");
        return {
          value: name,
          label: summary ? `${name} · ${summary}` : name,
          description: description || "Installed in local Ollama.",
          modifiedAt,
          capabilities,
          contextLength: metadata?.contextLength,
          hidden: isEmbeddingOnlyModel({ name, details, capabilities }),
        } satisfies OllamaModelOption & { hidden: boolean };
      }));

    const visibleModels: OllamaModelOption[] = [];
    const hiddenModels: OllamaModelOption[] = [];
    for (const model of modelCandidates) {
      if (!model) continue;
      const { hidden, ...option } = model as OllamaModelOption & { hidden?: boolean };
      if (hidden) {
        hiddenModels.push(option);
      } else {
        visibleModels.push(option);
      }
    }

    const models = visibleModels.sort(compareOllamaModels);
    hiddenModels.sort((left, right) => compareModifiedAtDescending(left.modifiedAt, right.modifiedAt));

    if (!models.length) {
      return {
        status: "empty",
        message: hiddenModels.length
          ? "Ollama is running, but only embedding models were found."
          : "Ollama is running, but no local models are installed yet. Run `ollama pull <model>` first.",
        endpoint: OLLAMA_TAGS_URL,
        models: [],
        hiddenModels,
      };
    }

    return {
      status: "ready",
      message: hiddenModels.length
        ? `Local Ollama models loaded. ${hiddenModels.length} embedding model${hiddenModels.length === 1 ? "" : "s"} hidden.`
        : "Local Ollama models loaded.",
      endpoint: OLLAMA_TAGS_URL,
      defaultModel: models[0]?.value,
      models,
      hiddenModels,
    };
  } catch {
    return {
      status: "unavailable",
      message: "Ollama is not responding on http://127.0.0.1:11434. Start Ollama to use local models.",
      endpoint: OLLAMA_TAGS_URL,
      models: [],
    };
  }
}
