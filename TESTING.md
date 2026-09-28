# Testing

## Static Checks

```bash
npm run test
npm run build
node -c electron/main.cjs
node -c electron/preload.cjs
npm run health
```

## Unit Tests

```bash
npm run test
```

This verifies the versioned browser tool schema adapter against current WebPilot declarations, legacy MCP-style `input_schema`, OpenAI-style wrapped function declarations, missing optional fields, and unknown extension fields.

`tests/playwright-mcp-contract.test.ts` starts the Playwright MCP server (without launching a browser) and checks that every tool and argument WebPilot calls still exists, so a Playwright upgrade that renames one fails here.

It also covers the OpenRouter/Ollama model client with a mocked `fetch`: request URLs and headers, tool-call round trips including `reasoning_details`, retries on rate limits, error messages, migration of legacy Gemini/OpenAI/Claude settings, and parsing of the OpenRouter models catalog. No API key or network access is needed.

`tests/jev.test.ts` covers fast mode without network access: accessibility-snapshot parsing, candidate selection, the Jev client, the step loop against a fake browser (done, no-progress handoff, irreversible-click guard, typing with submit), and the Jev gates.

## Fast Mode Benchmark

```bash
npm run browsers:install
OPENROUTER_API_KEY=sk-or-... npm run bench:fast-mode
npm run bench:fast-mode -- --only mosaic,voyager --modes fast --repeat 3
```

Runs a fixed set of public-web tasks (Wikipedia, MDN, example.com) headless in both the LLM-only mode and fast mode, checks each final answer against expected patterns, and writes JSON and Markdown reports with time, steps, LLM calls, Jev calls and fast-mode handoffs to `e2e_reports/`. Model latency on OpenRouter varies run to run, so compare medians over `--repeat 3` or more before drawing conclusions.

## Deterministic Browser Smoke

```bash
npm run browsers:install
npm run browser:smoke
```

The browser smoke starts a local fixture server and verifies that Playwright Chromium can open a page, click a button, fill an input, extract text, handle a navigation, and surface a failed selector error. It does not require model credentials or external websites.

## Local API Smoke

Start the app:

```bash
npm run dev
```

Then verify:

```bash
curl -sS http://127.0.0.1:3000/api/agent
curl -sS http://127.0.0.1:3000/api/runs
curl -sS http://127.0.0.1:3000/api/threads
curl -sS "http://127.0.0.1:3000/api/runtime/providers?provider=openrouter"
curl -sS "http://127.0.0.1:3000/api/runtime/providers?provider=ollama"
```

## Agent Smoke

With a configured model provider, run the full agent loop:

```bash
npm run agent:cli -- "Go to https://example.com and tell me the page heading in one short sentence."
```

Expected:

- run status becomes `done`
- final result mentions `Example Domain`
- a run directory appears under `agent_runs/`
- `steps.jsonl`, `run.json`, `session_logs.json`, and `performance_summary.json` exist

## UI Smoke

Check these views in web and Electron:

- Home loads without console errors.
- Settings shows provider/model controls.
- Ollama discovery hides known embedding-only models when metadata identifies them.
- Browser source and profile controls render without clipping.
- Activity lists recent runs.
- Activity confirms before deleting a run and refreshes the list afterward.
- Run detail shows summary, timing, steps, logs, artifacts, and final result.
- Run detail confirms before deleting the selected run.
- Library shows threads, lets users switch run history, and confirms before deleting a thread or clearing history.

## Layout Checks

The desktop UI should not rely on mobile-first behavior, but it should tolerate resizing. Check at least:

- `1440x900`
- `1080x760`
- the configured Electron minimum window size

Look for horizontal overflow, clipped buttons, clipped selects, titlebar overlap, and scroll containers that trap content.

## Desktop Build Smoke

```bash
npm run desktop:build
npm run desktop:smoke
```

Use platform-specific build scripts when preparing a release candidate:

```bash
npm run desktop:build:win
npm run desktop:build:linux
```

Then smoke-test the generated package on the same OS:

- app launches
- settings persist
- managed browser can run a simple task
- activity/run detail opens
- no local runtime folders are bundled into the app resources

`npm run desktop:smoke` launches the packaged app with isolated temporary data and verifies that the direct desktop runtime loads instead of falling back to HTTP. On Linux CI, run it under `xvfb-run -a`.
