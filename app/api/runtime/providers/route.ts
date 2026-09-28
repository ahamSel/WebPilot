import { NextRequest, NextResponse } from "next/server";

import {
  PROVIDER_PRESETS,
  defaultModelsForProvider,
  discoverOllamaModels,
  discoverOpenRouterModels,
  normalizeProvider,
  providerOrder,
} from "@/lib/runtime-provider-presets";

export async function GET(request: NextRequest) {
  const provider = normalizeProvider(request.nextUrl.searchParams.get("provider"));
  const discovery = provider === "ollama"
    ? await discoverOllamaModels()
    : await discoverOpenRouterModels({ force: request.nextUrl.searchParams.get("refresh") === "1" });

  return NextResponse.json({
    provider,
    preset: PROVIDER_PRESETS[provider],
    defaults: defaultModelsForProvider(provider),
    providers: providerOrder().map((id) => ({
      id,
      label: PROVIDER_PRESETS[id].label,
    })),
    discovery,
  });
}
