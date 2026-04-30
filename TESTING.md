# Testing

## Static Checks

```bash
npm run build
node -c electron/main.cjs
node -c electron/preload.cjs
npm run health
```

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
curl -sS "http://127.0.0.1:3000/api/runtime/providers?provider=ollama"
```

## Agent Smoke

With a configured model provider:

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
- Run detail shows summary, timing, steps, logs, artifacts, and final result.
- Library shows threads and lets users switch run history.

## Layout Checks

The desktop UI should not rely on mobile-first behavior, but it should tolerate resizing. Check at least:

- `1440x900`
- `1080x760`
- the configured Electron minimum window size

Look for horizontal overflow, clipped buttons, clipped selects, titlebar overlap, and scroll containers that trap content.

## Desktop Build Smoke

```bash
npm run desktop:build
```

Then open the generated macOS artifact locally and verify:

- app launches
- settings persist
- managed browser can run a simple task
- activity/run detail opens
- no local runtime folders are bundled into the app resources
