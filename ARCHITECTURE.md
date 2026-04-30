# Architecture

WebPilot is a local-first agentic browser. The public app has four main layers:

1. Next.js renderer for chat, activity, settings, library, and run inspection.
2. Electron shell for desktop windows, settings persistence, packaged runtime loading, and native browser/profile discovery.
3. Agent runtime for model calls, tool dispatch, run recording, threads, and browser coordination.
4. Playwright MCP driver for browser launch/control, snapshots, tabs, and evidence extraction.

## Runtime Flow

1. The user starts a task from the UI, API, CLI, or MCP tool.
2. Runtime settings are resolved from UI settings, environment variables, or defaults.
3. Electron or Next starts the agent runtime.
4. The agent initializes Playwright MCP with the selected browser/profile settings.
5. The planner model receives the task and available browser tools.
6. Browser tool calls are executed and recorded to `agent_runs/`.
7. The run finalizes with result text, logs, artifacts, timing, runtime metadata, and thread updates.

## Core Modules

- `lib/agent.ts`: sequential agent loop, model/tool orchestration, pause/stop handling, run finalization.
- `lib/sub-agent.ts`: isolated parallel agents used for split multi-site tasks.
- `lib/model-client.ts`: provider abstraction for Gemini, OpenAI, OpenAI-compatible endpoints, and Ollama.
- `lib/browser-runtime.ts`: browser/profile settings schema and sanitization.
- `lib/playwright-mcp-driver.ts`: in-process Playwright MCP client, snapshot parsing, page text, and evidence extraction.
- `lib/recorder.ts`: run metadata, step logs, artifacts, and run listing/detail APIs.
- `lib/threads.ts`: local thread summaries and follow-up context.
- `lib/mcp/register-tools.ts`: public MCP tools and resources for runs and agent control.
- `electron/main.cjs`: desktop shell, window routing, settings, browser discovery, direct runtime bridge.
- `electron/preload.cjs`: safe renderer bridge.

## Storage

Local data is written under these directories:

- `agent_runs/`: run metadata, step traces, artifacts, final results.
- `agent_threads/`: thread summaries and run references.
- `.desktop-dev-data/`: Electron dev-mode runtime data.

Packaged Electron builds store runtime data under the app user-data directory.

## Browser Control

The browser layer is built around Playwright MCP. WebPilot can launch a managed browser, use selected Playwright browser channels, connect to a CDP endpoint, or launch a custom executable. Existing profile usage is intentionally conservative because browser profiles can contain sensitive account state.

## Model Providers

The runtime provider abstraction keeps UI, API, and agent code independent of a single LLM vendor. The current public provider surface is:

- Gemini via Google AI API key.
- OpenAI via API key.
- OpenAI-compatible endpoints.
- Ollama local runtime.

## Desktop Packaging

`scripts/prepare-electron-build.mjs` builds Next standalone output, copies static assets, compiles runtime modules for packaged direct execution, and excludes local runtime data from the app bundle.

The default desktop build is unsigned/ad-hoc for public alpha distribution. Signed/notarized releases should use the explicit signed build script once credentials are configured.
