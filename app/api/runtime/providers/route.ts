import { NextRequest, NextResponse } from "next/server";

import {
  PROVIDER_PRESETS,
  defaultModelsForProvider,
  discoverOllamaModels,
  normalizeProvider,
  providerOrder,
} from "@/lib/runtime-provider-presets";

export async function GET(request: NextRequest) {
  const provider = normalizeProvider(request.nextUrl.searchParams.get("provider"));

  if (provider === "ollama") {
    const discovery = await discoverOllamaModels();
    return NextResponse.json({
      provider,
      preset: PROVIDER_PRESETS.ollama,
      discovery,
    });
  }

  const preset = PROVIDER_PRESETS[provider];
  return NextResponse.json({
    provider,
    preset,
    defaults: defaultModelsForProvider(provider),
    providers: providerOrder().map((id) => ({
      id,
      label: PROVIDER_PRESETS[id].label,
    })),
  });
}
