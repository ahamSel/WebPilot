export type ModelProvider = "gemini" | "openai" | "anthropic" | "ollama";

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

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";
const OLLAMA_SHOW_URL = "http://127.0.0.1:11434/api/show";

const GEMINI_FLASH = "gemini-2.5-flash";
const GEMINI_FLASH_LITE = "gemini-2.5-flash-lite";
const GEMINI_PRO = "gemini-2.5-pro";
const OPENAI_FAST = "gpt-5-mini";
const OPENAI_CHEAP = "gpt-5-nano";
const OPENAI_SMART = "gpt-5.2";
const OPENAI_STABLE_FAST = "gpt-4.1-mini";
const OPENAI_STABLE_SMART = "gpt-4.1";
const CLAUDE_FAST = "claude-haiku-4-5-20251001";
const CLAUDE_BALANCED = "claude-sonnet-4-6";
const CLAUDE_SMART = "claude-opus-4-7";

export const PROVIDER_PRESETS: Record<ModelProvider, ProviderPreset> = {
  gemini: {
    id: "gemini",
    label: "Gemini",
    apiKeyLabel: "Google AI API key",
    apiKeyPlaceholder: "AIza...",
    apiKeyRequired: true,
    notes: [
      "Use a fast model for planning and a stronger model for synthesis/review.",
      "Gemini 2.5 Flash is the default planner because it is fast and supports function calling.",
    ],
    navModels: [
      { value: GEMINI_FLASH_LITE, label: "Gemini 2.5 Flash-Lite", description: "Fastest and lowest cost." },
      { value: GEMINI_FLASH, label: "Gemini 2.5 Flash", description: "Balanced default for planning." },
      { value: GEMINI_PRO, label: "Gemini 2.5 Pro", description: "Stronger, slower reasoning." },
    ],
    synthModels: [
      { value: GEMINI_FLASH, label: "Gemini 2.5 Flash", description: "Fast summarization." },
      { value: GEMINI_PRO, label: "Gemini 2.5 Pro", description: "Best quality synthesis." },
    ],
    reviewModels: [
      { value: GEMINI_FLASH, label: "Gemini 2.5 Flash", description: "Fast route review." },
      { value: GEMINI_PRO, label: "Gemini 2.5 Pro", description: "Thorough review." },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    apiKeyLabel: "OpenAI API key",
    apiKeyPlaceholder: "sk-...",
    apiKeyRequired: true,
    notes: [
      "These are curated defaults instead of a freeform model field.",
      "Planner defaults bias toward cheaper/faster models while synth/review can use stronger ones.",
    ],
    navModels: [
      { value: OPENAI_CHEAP, label: "GPT-5 nano", description: "Cheapest and fastest." },
      { value: OPENAI_FAST, label: "GPT-5 mini", description: "Fast default planner." },
      { value: OPENAI_STABLE_FAST, label: "GPT-4.1 mini", description: "Stable fast alternative." },
      { value: OPENAI_STABLE_SMART, label: "GPT-4.1", description: "Stronger non-reasoning model." },
      { value: OPENAI_SMART, label: "GPT-5.2", description: "Highest quality option." },
    ],
    synthModels: [
      { value: OPENAI_FAST, label: "GPT-5 mini", description: "Fast synthesis." },
      { value: OPENAI_STABLE_SMART, label: "GPT-4.1", description: "Stable stronger synthesis." },
      { value: OPENAI_SMART, label: "GPT-5.2", description: "Best quality synthesis." },
    ],
    reviewModels: [
      { value: OPENAI_FAST, label: "GPT-5 mini", description: "Fast review." },
      { value: OPENAI_STABLE_SMART, label: "GPT-4.1", description: "Stable stronger review." },
      { value: OPENAI_SMART, label: "GPT-5.2", description: "Best quality review." },
    ],
  },
  anthropic: {
    id: "anthropic",
    label: "Claude",
    apiKeyLabel: "Anthropic API key",
    apiKeyPlaceholder: "sk-ant-...",
    apiKeyRequired: true,
    notes: [
      "Claude uses Anthropic's Messages API with native tool use.",
      "Haiku 4.5 is the fast planner default; Sonnet 4.6 is the stronger synthesis/review default.",
    ],
    navModels: [
      { value: CLAUDE_FAST, label: "Claude Haiku 4.5", description: "Fast, lower-cost planner for interactive browsing." },
      { value: CLAUDE_BALANCED, label: "Claude Sonnet 4.6", description: "Best default for complex agentic tasks." },
      { value: CLAUDE_SMART, label: "Claude Opus 4.7", description: "Strongest reasoning option." },
    ],
    synthModels: [
      { value: CLAUDE_FAST, label: "Claude Haiku 4.5", description: "Fast synthesis." },
      { value: CLAUDE_BALANCED, label: "Claude Sonnet 4.6", description: "High-quality synthesis." },
      { value: CLAUDE_SMART, label: "Claude Opus 4.7", description: "Best quality synthesis." },
    ],
    reviewModels: [
      { value: CLAUDE_FAST, label: "Claude Haiku 4.5", description: "Fast route review." },
      { value: CLAUDE_BALANCED, label: "Claude Sonnet 4.6", description: "Thorough route review." },
      { value: CLAUDE_SMART, label: "Claude Opus 4.7", description: "Deepest review." },
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
  return ["gemini", "openai", "anthropic", "ollama"];
}

export function normalizeProvider(value: unknown): ModelProvider {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai-compatible" || normalized === "openai_compatible") {
    return "openai";
  }
  if (normalized === "anthropic" || normalized === "claude") {
    return "anthropic";
  }
  if (normalized === "ollama") {
    return "ollama";
  }
  return "gemini";
}

export function providerLabel(provider: unknown): string {
  return PROVIDER_PRESETS[normalizeProvider(provider)].label;
}

export function defaultBaseUrlForProvider(provider: unknown): string {
  const normalized = normalizeProvider(provider);
  if (normalized === "openai") return OPENAI_BASE_URL;
  if (normalized === "anthropic") return ANTHROPIC_BASE_URL;
  if (normalized === "ollama") return OLLAMA_BASE_URL;
  return "";
}

export function defaultModelsForProvider(provider: unknown) {
  const normalized = normalizeProvider(provider);
  if (normalized === "gemini") {
    return {
      navModel: GEMINI_FLASH,
      synthModel: GEMINI_PRO,
      reviewModel: GEMINI_PRO,
    };
  }
  if (normalized === "openai") {
    return {
      navModel: OPENAI_FAST,
      synthModel: OPENAI_SMART,
      reviewModel: OPENAI_SMART,
    };
  }
  if (normalized === "anthropic") {
    return {
      navModel: CLAUDE_FAST,
      synthModel: CLAUDE_BALANCED,
      reviewModel: CLAUDE_BALANCED,
    };
  }
  return {
    navModel: "",
    synthModel: "",
    reviewModel: "",
  };
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
