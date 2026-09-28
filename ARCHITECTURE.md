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
- `lib/model-client.ts`: one OpenAI-compatible chat-completions client used for both OpenRouter and Ollama.
- `lib/tool-schema.ts`: versioned browser tool declarations and schema normalization for provider/MCP compatibility.
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

The MCP server ships inside `playwright-core` (`lib/coreBundle`), and WebPilot loads it from there on a stable Playwright release. The separate `@playwright/mcp` package is only a thin wrapper that pins alpha Playwright builds, so it is not used. `playwright` and `playwright-core` are pinned to the same exact version, so the Chromium build installed by `npm run browsers:install` is the one the MCP server launches.

`lib/playwright-mcp-driver.ts` is the only place that knows the MCP wire format:

- Automatic snapshots after actions are turned off (`snapshot.mode: "none"`); the agent calls `browser_snapshot` whenever it needs the page, which returns the YAML inline. Since Playwright 1.63, action snapshots are written to files instead.
- Element refs are sent as the MCP `target` argument (renamed from `ref` in Playwright 1.63).

## Upgrading Playwright

Dependabot opens a weekly grouped PR for `playwright` and `playwright-core` (stable releases only). Before merging one:

1. `npm test` runs `tests/playwright-mcp-contract.test.ts`, which fails if a tool or argument WebPilot uses was renamed or removed.
2. `npm run browsers:install && npm run browser:smoke` checks that the new Chromium build launches.
3. Run one real task (`npm run agent:cli -- "Go to https://example.com and tell me the page heading."`) to confirm the snapshot format still parses.
4. For releases, run the `Package Desktop` workflow to package and smoke-test the desktop app on every platform.

## Safety

`lib/safety.ts` holds the rules every agent path shares:

- **Irreversible actions need the user's OK.** Before a click whose label starts with a committing verb (buy, pay, place order, checkout, send, delete, unsubscribe, publish...), the run pauses with "Confirm: WebPilot wants to click …"; Resume allows it and Stop cancels. It applies to the LLM planner, fast mode and parallel sub-agents, and matches on the page's own label for the element rather than the model's description. Links only trigger it for strong verbs (buy, checkout, delete...), so navigation like "Sent items" or "Send feedback" does not.
- **Page content is untrusted.** Planner, sub-agent, text-writing and answer prompts say that instructions found in pages or emails must never be followed. Jev gets a neutral version ("only the task defines what to do"), because it reads instructions literally and a list of risky verbs made it avoid legitimate steps.

## Fast Mode (Jev)

Fast mode (`fastMode` in settings, `WEBPILOT_FAST_MODE=1`) puts TypeSafe's Jev decision model in charge of each browser step. Jev returns typed decisions with calibrated probabilities in ~0.3s instead of generating text, so it replaces the LLM wherever the question is really a choice. It is reached through OpenRouter with the same API key (`/api/v1/systemone`, model `typesafe/jev-1.13`, override with `JEV_MODEL`); it is not available with Ollama.

Modules under `lib/jev/`:

- `client.ts`: the decision API (`choice` and `noul` questions, retries, answer parsing).
- `page.ts`: builds the page state from the accessibility snapshot alone (a numbered list of actionable elements with landmark info, plus a text excerpt). Every Playwright MCP `browser_evaluate` costs ~0.5-1s, so fast mode avoids them. Pages with more than ~250 elements are trimmed to the ones in main content that share words with the task.
- `fast-mode.ts`: the step loop. One Jev call per step asks a flat `action` choice (`click_<ref>`, `type_<ref>`, scroll, back, done, blocked) plus `goal_done`, `stuck` and `submit_after_typing`. The LLM only writes text for inputs and phrases the final answer.
- `gates.ts`: Jev yes/no gates in front of LLM calls. A preflight asks "needs the browser?" and "independent sites in parallel?" in one call, skipping the LLM router and split analysis when Jev is confident. An answer check accepts a supported final answer without the LLM reviewer; Jev never rejects on its own.

Fast mode finishes when Jev chooses done, when `goal_done` is high, or when `goal_done` is likely (≥0.45) and no next action is confident (open-ended tasks such as "find some tents" are usually done on a results page). Its answer then goes through Jev's answer check: a clearly unsupported answer (<0.3) is not finished and the LLM planner continues instead.

Control returns to the LLM planner (with a summary of the steps taken) when Jev reports the task blocked or stuck, several actions in a row make no visible change, there is no starting page, or the step/time budget runs out. Irreversible clicks go through the confirmation above. Every element action already taken from a page, and page actions that changed nothing, are removed from the options when Jev decides on that page again; actions are identified by role, label and link target because Playwright renumbers refs on each page load.

Planner and text-writing calls on OpenRouter request `reasoning.effort: "low"`; browsing steps are short decisions, and reasoning models such as Gemini 3 otherwise reason at "medium".

Each Jev step is recorded with `source: "jev"`, and `stepN_jev.json` artifacts keep Jev's probabilities for tuning thresholds. `npm run bench:fast-mode` compares fast mode with the LLM-only agent on the same tasks.

Privacy: in fast mode the page text excerpt, element labels and URLs of every step are sent to TypeSafe (through OpenRouter).

## Tool Schema Versioning

The agent exposes a stable WebPilot browser tool schema from `lib/tool-schema.ts` instead of scattering raw provider payloads through the runtime. The current schema version is `webpilot.browser-tools.v1`.

`lib/model-client.ts` normalizes tool declarations before sending them to OpenRouter or Ollama. The normalizer accepts current WebPilot `parameters`, MCP-style `inputSchema` or `input_schema`, and OpenAI-style wrapped `function` payloads. Unknown fields are preserved, missing optional fields get safe defaults, and provider-specific type casing is handled at the adapter boundary.

## Model Providers

The runtime provider abstraction keeps UI, API, and agent code independent of a single LLM vendor. The current public provider surface is:

- OpenRouter, which routes one API key to Gemini, Claude, GPT, Qwen, DeepSeek and most other hosted models.
- Ollama local runtime.

Both speak the OpenAI chat-completions format, so a single client handles them. OpenRouter-only extras are added at the adapter boundary: app attribution headers, reasoning effort for router/review calls, and passing `reasoning_details` back across tool turns (required by reasoning models such as Gemini 3). Rate-limited and temporarily unavailable responses (429/502/503) are retried within the call timeout.

## Desktop Packaging

`scripts/prepare-electron-build.mjs` builds Next standalone output, copies static assets, compiles runtime modules for packaged direct execution, and excludes local runtime data from the app bundle.

The default desktop build is unsigned/ad-hoc for public alpha distribution. Signed/notarized releases should use the explicit signed build script once credentials are configured.
