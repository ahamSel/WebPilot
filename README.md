# WebPilot

Open-source agentic browser with Playwright control, bring-your-own model providers, local Ollama support, and an Electron desktop shell.

WebPilot is meant to be a hackable, local-first alternative to closed agentic browsers. The default browser is Playwright Chromium, but the desktop app can also target installed browser channels and user-selected profile folders where the platform allows it.

## Features

- Desktop app built with Electron and Next.js.
- Browser automation through Playwright MCP.
- Model providers: Gemini, OpenAI, OpenAI-compatible endpoints, and Ollama.
- Runtime settings UI for provider, model, browser source, profile strategy, headless mode, and isolation.
- Local run recording with logs, step traces, artifacts, timing, and final results.
- Thread history for follow-up tasks.
- MCP endpoint and stdio server for external agents and tools.
- Unsigned macOS desktop builds for early public releases.

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

For the desktop shell:

```bash
npm run desktop:dev
```

## Model Setup

Gemini:

```bash
GEMINI_API_KEY=...
MODEL_PROVIDER=gemini
```

OpenAI:

```bash
MODEL_PROVIDER=openai
MODEL_API_KEY=sk-...
MODEL_BASE_URL=https://api.openai.com/v1
```

Ollama:

```bash
MODEL_PROVIDER=ollama
MODEL_BASE_URL=http://127.0.0.1:11434/v1
```

The settings UI can discover local Ollama models and hides known embedding-only models when Ollama reports enough metadata to identify them.

## Browser Modes

The app supports these runtime browser modes:

- Managed Playwright browser with temporary, app profile, custom folder, or memory-only profile behavior.
- Installed browser channels such as Chrome, Edge, and Firefox where Playwright supports the target.
- Existing browser connection through Chrome DevTools Protocol.
- Custom executable path for advanced users.

Profile discovery is platform-specific and conservative. Browser profile data can contain cookies and private browsing state, so treat profile paths as sensitive.

## Useful Commands

```bash
npm run build
npm run health
npm run agent:cli -- "Go to https://example.com and summarize the page"
npm run mcp:stdio
npm run desktop:build
```

`npm run desktop:build` creates an unsigned/ad-hoc desktop build by default. Use `npm run desktop:build:signed` only when you have a signing identity configured.

## Project Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [RUNNING.md](./RUNNING.md)
- [DESKTOP.md](./DESKTOP.md)
- [TESTING.md](./TESTING.md)
- [THREADS.md](./THREADS.md)
- [docs/RELEASE.md](./docs/RELEASE.md)

## License

GPL-3.0-or-later. Contributions must be compatible with that license.
