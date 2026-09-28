/// <reference types="chrome" />

import { defaultModelsForProvider } from "../../lib/runtime-provider-presets";
import { resolveRuntimeModelConfig, type RuntimeModelConfig } from "../../lib/model-client";

export interface ExtensionSettings {
    apiKey: string;
    navModel: string;
    fastMode: boolean;
}

const DEFAULTS: ExtensionSettings = {
    apiKey: "",
    navModel: defaultModelsForProvider("openrouter").navModel,
    fastMode: true,
};

const KEY = "webpilot.settings.v1";

export async function loadSettings(): Promise<ExtensionSettings> {
    const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<ExtensionSettings> | undefined;
    return {
        apiKey: typeof stored?.apiKey === "string" ? stored.apiKey : DEFAULTS.apiKey,
        navModel: typeof stored?.navModel === "string" && stored.navModel.trim() ? stored.navModel.trim() : DEFAULTS.navModel,
        fastMode: typeof stored?.fastMode === "boolean" ? stored.fastMode : DEFAULTS.fastMode,
    };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
    await chrome.storage.local.set({ [KEY]: settings });
}

export function modelConfigFor(settings: ExtensionSettings): RuntimeModelConfig {
    return resolveRuntimeModelConfig({
        provider: "openrouter",
        apiKey: settings.apiKey,
        navModel: settings.navModel,
        reviewModel: settings.navModel,
        synthEnabled: false,
        fastMode: settings.fastMode,
        timeoutMs: 60_000,
    });
}
