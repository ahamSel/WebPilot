"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_RUNTIME_SETTINGS,
  getRuntimeProviderDiscoveryClient,
  getRuntimeSettingsClient,
  listBrowserOptionsClient,
  saveRuntimeSettingsClient,
  type BrowserChannel,
  type BrowserDiscoveryBrowser,
  type BrowserDiscoveryResult,
  type BrowserName,
  type BrowserRuntimeSettings,
  type RuntimeSettings,
} from "@/lib/desktop-client";
import {
  PROVIDER_PRESETS,
  defaultBaseUrlForProvider,
  defaultModelsForProvider,
  providerOrder,
  type ModelOption,
  type ModelProvider,
  type OllamaDiscoveryResult,
} from "@/lib/runtime-provider-presets";
import { Input } from "@/components/ui/Input";
import { Toggle } from "@/components/ui/Toggle";
import { Badge } from "@/components/ui/Badge";
import { ModelSelector } from "./ModelSelector";
import { Eye, EyeOff } from "lucide-react";

type SaveStatus = "loading" | "saving" | "saved" | "error";
type ProfileStorageMode = "temporary" | "dedicated" | "custom" | "isolated";

const selectClass =
  "h-8 w-full min-w-0 rounded-[var(--wp-radius-sm)] border border-wp-border bg-wp-surface px-2 text-[13px] text-wp-text outline-none transition-colors focus:border-wp-accent focus:ring-2 focus:ring-wp-accent/20 disabled:cursor-not-allowed disabled:opacity-50";

function toBrowserName(value: string | undefined): BrowserName {
  return value === "firefox" || value === "webkit" ? value : "chromium";
}

function profileStorageMode(browser: BrowserRuntimeSettings, defaultUserDataDir?: string): ProfileStorageMode {
  if (browser.isolated) return "isolated";
  if (!browser.userDataDir) return "temporary";
  if (defaultUserDataDir && browser.userDataDir === defaultUserDataDir) return "dedicated";
  return "custom";
}

function optionsForProvider(
  provider: ModelProvider,
  ollamaDiscovery: OllamaDiscoveryResult | null
): { nav: ModelOption[]; synth: ModelOption[]; review: ModelOption[] } {
  if (provider === "ollama") {
    const models = ollamaDiscovery?.models || [];
    return { nav: models, synth: models, review: models };
  }
  const preset = PROVIDER_PRESETS[provider];
  return { nav: preset.navModels, synth: preset.synthModels, review: preset.reviewModels };
}

function currentBrowserChoice(
  browser: BrowserRuntimeSettings,
  discoveredBrowsers: BrowserDiscoveryBrowser[]
) {
  if (browser.mode === "cdp") return "cdp";
  if (browser.mode === "channel") return `channel:${browser.channel || "chrome"}`;
  if (browser.mode === "custom") {
    const match = discoveredBrowsers.find(
      (item) => item.kind === "custom" && item.executablePath && item.executablePath === browser.executablePath
    );
    return match ? `custom:${match.id}` : "custom";
  }
  return `managed:${browser.browserName || "chromium"}`;
}

function BrowserSourceOptions({
  currentValue,
  discoveredBrowsers,
}: {
  currentValue: string;
  discoveredBrowsers: BrowserDiscoveryBrowser[];
}) {
  const options: Array<{ value: string; label: string; disabled?: boolean }> = [
    { value: "managed:chromium", label: "WebPilot Chromium" },
  ];

  for (const browser of discoveredBrowsers) {
    if (browser.id === "managed-chromium" || !browser.available) continue;
    if (browser.kind === "channel" && browser.channel) {
      options.push({ value: `channel:${browser.channel}`, label: browser.label });
    }
    if (browser.kind === "custom") {
      options.push({ value: `custom:${browser.id}`, label: browser.label });
    }
  }

  options.push({ value: "cdp", label: "Running Chrome/Edge" });
  options.push({ value: "custom", label: "Custom executable" });

  if (!options.some((option) => option.value === currentValue)) {
    options.push({ value: currentValue, label: "Saved browser" });
  }

  return (
    <>
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </>
  );
}

export function ProviderForm() {
  const [runtime, setRuntime] = useState<RuntimeSettings>(DEFAULT_RUNTIME_SETTINGS);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [saveError, setSaveError] = useState("");
  const [ollamaDiscovery, setOllamaDiscovery] = useState<OllamaDiscoveryResult | null>(null);
  const [browserDiscovery, setBrowserDiscovery] = useState<BrowserDiscoveryResult | null>(null);
  const [profileStorageSelection, setProfileStorageSelection] = useState<ProfileStorageMode | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const skipNextSaveRef = useRef(true);

  const provider = runtime.provider;
  const preset = PROVIDER_PRESETS[provider];
  const modelOptions = optionsForProvider(provider, ollamaDiscovery);
  const browserProfiles = browserDiscovery?.profiles || [];
  const discoveredBrowsers = browserDiscovery?.browsers || [];
  const browserChoice = currentBrowserChoice(runtime.browser, discoveredBrowsers);
  const storageMode = profileStorageSelection || profileStorageMode(runtime.browser, browserDiscovery?.defaultUserDataDir);
  const canLaunchHeadless = runtime.browser.mode !== "cdp";

  useEffect(() => {
    getRuntimeSettingsClient()
      .then((settings) => {
        skipNextSaveRef.current = true;
        setRuntime(settings);
        setSaveStatus("saved");
      })
      .catch((err) => {
        setSaveStatus("error");
        setSaveError(err instanceof Error ? err.message : "Failed to load");
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    listBrowserOptionsClient()
      .then((result) => {
        if (!cancelled) setBrowserDiscovery(result);
      })
      .catch(() => {
        if (!cancelled) setBrowserDiscovery(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (saveStatus === "loading") return;

    setSaveStatus("saving");
    const timer = setTimeout(() => {
      saveRuntimeSettingsClient(runtime)
        .then(() => setSaveStatus("saved"))
        .catch((err) => {
          setSaveStatus("error");
          setSaveError(err instanceof Error ? err.message : "Save failed");
        });
    }, 400);

    return () => clearTimeout(timer);
  }, [runtime]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (provider !== "ollama") {
      setOllamaDiscovery(null);
      return;
    }

    let cancelled = false;
    getRuntimeProviderDiscoveryClient("ollama")
      .then((response) => {
        if (cancelled) return;
        const discovery = response.discovery || {
          status: "unavailable" as const,
          message: "Could not load local Ollama models.",
          endpoint: "http://127.0.0.1:11434/api/tags",
          models: [],
        };
        setOllamaDiscovery(discovery);
        setRuntime((current) => {
          if (current.provider !== "ollama") return current;
          const available = new Set(discovery.models.map((m) => m.value));
          const fallback = discovery.defaultModel || discovery.models[0]?.value || "";
          const pick = (v: string) => (available.has(v) ? v : fallback);
          return {
            ...current,
            baseUrl: defaultBaseUrlForProvider("ollama"),
            navModel: pick(current.navModel),
            synthModel: pick(current.synthModel),
            reviewModel: pick(current.reviewModel),
          };
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setOllamaDiscovery({
          status: "unavailable",
          message: err instanceof Error ? err.message : "Could not reach local Ollama.",
          endpoint: "http://127.0.0.1:11434/api/tags",
          models: [],
        });
      });

    return () => {
      cancelled = true;
    };
  }, [provider]);

  function setProvider(next: ModelProvider) {
    const defaults = defaultModelsForProvider(next);
    setRuntime((current) => ({
      ...current,
      provider: next,
      apiKey: next === current.provider ? current.apiKey : "",
      baseUrl: defaultBaseUrlForProvider(next),
      navModel: defaults.navModel,
      synthModel: defaults.synthModel,
      reviewModel: defaults.reviewModel,
    }));
  }

  function update(patch: Partial<RuntimeSettings>) {
    setRuntime((prev) => ({ ...prev, ...patch }));
  }

  function updateBrowser(patch: Partial<BrowserRuntimeSettings>) {
    setRuntime((prev) => ({
      ...prev,
      browser: {
        ...prev.browser,
        ...patch,
      },
    }));
  }

  function applyBrowserChoice(value: string) {
    setProfileStorageSelection(null);
    if (value === "managed:chromium" || value === "managed:firefox" || value === "managed:webkit") {
      updateBrowser({
        mode: "managed",
        browserName: toBrowserName(value.split(":")[1]),
        channel: "",
        cdpEndpoint: "",
        executablePath: "",
      });
      return;
    }

    if (value.startsWith("channel:")) {
      updateBrowser({
        mode: "channel",
        browserName: "chromium",
        channel: value.slice("channel:".length) as BrowserChannel,
        cdpEndpoint: "",
        executablePath: "",
      });
      return;
    }

    if (value.startsWith("custom:")) {
      const id = value.slice("custom:".length);
      const browser = discoveredBrowsers.find((item) => item.id === id);
      updateBrowser({
        mode: "custom",
        browserName: toBrowserName(browser?.browserName),
        channel: "",
        cdpEndpoint: "",
        executablePath: browser?.executablePath || runtime.browser.executablePath,
      });
      return;
    }

    if (value === "cdp") {
      updateBrowser({
        mode: "cdp",
        browserName: "chromium",
        channel: "",
        userDataDir: "",
        cdpEndpoint: runtime.browser.cdpEndpoint || "http://127.0.0.1:9222",
        executablePath: "",
        isolated: false,
      });
      return;
    }

    updateBrowser({
      mode: "custom",
      browserName: runtime.browser.browserName || "chromium",
      channel: "",
      cdpEndpoint: "",
    });
  }

  function applyProfileStorageMode(value: ProfileStorageMode) {
    if (value === "isolated") {
      setProfileStorageSelection(null);
      updateBrowser({ isolated: true, userDataDir: "" });
      return;
    }
    if (value === "temporary") {
      setProfileStorageSelection(null);
      updateBrowser({ isolated: false, userDataDir: "" });
      return;
    }
    if (value === "dedicated") {
      setProfileStorageSelection(null);
      updateBrowser({
        isolated: false,
        userDataDir: browserDiscovery?.defaultUserDataDir || runtime.browser.userDataDir,
      });
      return;
    }
    setProfileStorageSelection("custom");
    updateBrowser({
      isolated: false,
      userDataDir: runtime.browser.userDataDir === browserDiscovery?.defaultUserDataDir
        ? ""
        : runtime.browser.userDataDir,
    });
  }

  return (
    <div className="min-w-0 space-y-6">
      <div>
        <label className="block text-xs font-medium text-wp-text-secondary uppercase tracking-wider mb-2">
          Provider
        </label>
        <div className="flex min-w-0 flex-wrap gap-1">
          {providerOrder().map((p) => (
            <button
              type="button"
              key={p}
              onClick={() => setProvider(p)}
              className={`px-3 py-1.5 text-[13px] rounded-[var(--wp-radius-sm)] transition-colors ${
                provider === p
                  ? "bg-wp-accent text-white"
                  : "bg-wp-surface-raised text-wp-text-secondary hover:text-wp-text"
              }`}
            >
              {PROVIDER_PRESETS[p].label}
            </button>
          ))}
        </div>
      </div>

      {preset.apiKeyRequired && (
        <div>
          <label className="block text-xs font-medium text-wp-text-secondary uppercase tracking-wider mb-2">
            {preset.apiKeyLabel}
          </label>
          <div className="relative">
            <Input
              type={showApiKey ? "text" : "password"}
              value={runtime.apiKey || ""}
              onChange={(e) => update({ apiKey: e.target.value })}
              placeholder={preset.apiKeyPlaceholder}
              className="pr-9"
            />
            <button
              type="button"
              aria-label={showApiKey ? "Hide API key" : "Show API key"}
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-wp-text-secondary hover:text-wp-text transition-colors"
            >
              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      )}

      {provider !== "gemini" && (
        <div>
          <label className="block text-xs font-medium text-wp-text-secondary uppercase tracking-wider mb-2">
            Base URL
          </label>
          <Input
            value={runtime.baseUrl || ""}
            onChange={(e) => update({ baseUrl: e.target.value })}
            placeholder={defaultBaseUrlForProvider(provider) || ""}
          />
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-wp-text-secondary uppercase tracking-wider mb-2">
          Models
        </label>
        <div className="space-y-3">
          <ModelSelector
            label="Navigation"
            value={runtime.navModel || ""}
            options={modelOptions.nav}
            onChange={(v) => update({ navModel: v })}
          />
          <ModelSelector
            label="Synthesis"
            value={runtime.synthModel || ""}
            options={modelOptions.synth}
            onChange={(v) => update({ synthModel: v })}
          />
          <ModelSelector
            label="Review"
            value={runtime.reviewModel || ""}
            options={modelOptions.review}
            onChange={(v) => update({ reviewModel: v })}
          />
          {provider === "ollama" && ollamaDiscovery?.message && (
            <div className="min-w-0 rounded-[var(--wp-radius-sm)] border border-wp-border bg-wp-surface/60 px-2 py-1.5 text-[12px] text-wp-text-secondary">
              {ollamaDiscovery.message}
            </div>
          )}
        </div>
      </div>

      <Toggle
        checked={runtime.synthEnabled !== false}
        onChange={(v) => update({ synthEnabled: v })}
        label="Synthesis enabled"
      />

      <div className="min-w-0 space-y-3 rounded-[var(--wp-radius)] border border-wp-border bg-wp-surface/30 p-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <label className="text-xs font-medium text-wp-text-secondary uppercase tracking-wider">
            Browser
          </label>
          <span className="min-w-0 truncate text-[12px] text-wp-text-secondary">
            {browserDiscovery ? `${browserProfiles.length} profiles detected` : "Detecting..."}
          </span>
        </div>

        <div className="grid min-w-0 gap-3">
          <label className="min-w-0 space-y-1">
            <span className="text-[12px] text-wp-text-secondary">Source</span>
            <select
              value={browserChoice}
              onChange={(event) => applyBrowserChoice(event.target.value)}
              className={selectClass}
            >
              <BrowserSourceOptions
                currentValue={browserChoice}
                discoveredBrowsers={discoveredBrowsers}
              />
            </select>
          </label>

          {runtime.browser.mode === "cdp" && (
            <label className="min-w-0 space-y-1">
              <span className="text-[12px] text-wp-text-secondary">CDP endpoint</span>
              <Input
                value={runtime.browser.cdpEndpoint || ""}
                onChange={(event) => updateBrowser({ cdpEndpoint: event.target.value })}
                placeholder="http://127.0.0.1:9222"
              />
            </label>
          )}

          {runtime.browser.mode === "custom" && (
            <div className="grid min-w-0 gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
              <label className="min-w-0 space-y-1">
                <span className="text-[12px] text-wp-text-secondary">Engine</span>
                <select
                  value={runtime.browser.browserName}
                  onChange={(event) => updateBrowser({ browserName: event.target.value as BrowserName })}
                  className={selectClass}
                >
                  <option value="chromium">Chromium</option>
                  <option value="firefox">Firefox</option>
                  <option value="webkit">WebKit</option>
                </select>
              </label>
              <label className="min-w-0 space-y-1">
                <span className="text-[12px] text-wp-text-secondary">Executable</span>
                <Input
                  value={runtime.browser.executablePath || ""}
                  onChange={(event) => updateBrowser({ executablePath: event.target.value })}
                  placeholder="/Applications/Browser.app/Contents/MacOS/Browser"
                />
              </label>
            </div>
          )}

          {canLaunchHeadless && (
            <Toggle
              checked={runtime.browser.headless}
              onChange={(checked) => updateBrowser({ headless: checked })}
              label="Headless browser"
            />
          )}

          {runtime.browser.mode !== "cdp" && (
            <div className="grid min-w-0 gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
              <label className="min-w-0 space-y-1">
                <span className="text-[12px] text-wp-text-secondary">Profile storage</span>
                <select
                  value={storageMode}
                  onChange={(event) => applyProfileStorageMode(event.target.value as ProfileStorageMode)}
                  className={selectClass}
                >
                  <option value="temporary">Temporary</option>
                  <option value="dedicated" disabled={!browserDiscovery?.defaultUserDataDir}>WebPilot profile</option>
                  <option value="custom">Custom folder</option>
                  <option value="isolated">In memory</option>
                </select>
              </label>
              <label className="min-w-0 space-y-1">
                <span className="text-[12px] text-wp-text-secondary">Profile folder</span>
                <Input
                  value={runtime.browser.userDataDir || ""}
                  onChange={(event) => {
                    setProfileStorageSelection(event.target.value ? "custom" : profileStorageSelection);
                    updateBrowser({ isolated: false, userDataDir: event.target.value });
                  }}
                  disabled={runtime.browser.isolated}
                  placeholder={browserDiscovery?.defaultUserDataDir || "Temporary profile"}
                />
              </label>
            </div>
          )}

          {browserProfiles.length > 0 && (
            <div className="max-h-24 min-w-0 overflow-y-auto rounded-[var(--wp-radius-sm)] border border-wp-border bg-wp-surface px-2 py-1.5">
              {browserProfiles.slice(0, 8).map((profile) => (
                <div key={profile.profileId} className="flex min-w-0 items-center gap-2 py-0.5 text-[12px] text-wp-text-secondary">
                  <span className="shrink-0 text-wp-text">{profile.browserLabel}</span>
                  <span className="min-w-0 truncate">{profile.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="pt-2 border-t border-wp-border">
        <Badge
          tone={
            saveStatus === "saved" ? "success" :
            saveStatus === "saving" ? "neutral" :
            saveStatus === "error" ? "error" : "neutral"
          }
        >
          {saveStatus === "saved" && "Auto-saved \u2713"}
          {saveStatus === "saving" && "Saving..."}
          {saveStatus === "loading" && "Loading..."}
          {saveStatus === "error" && `Error: ${saveError}`}
        </Badge>
      </div>
    </div>
  );
}
