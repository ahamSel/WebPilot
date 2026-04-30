# Running WebPilot

## Web App

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Desktop App

```bash
npm run desktop:dev
```

The desktop dev command starts Next.js on port `3210` by default and launches Electron against that local URL.

## Production Server

```bash
npm run build
npm run start
```

## Docker

```bash
docker compose up --build
```

The compose file mounts `agent_runs/` and `agent_threads/` so local history survives container restarts.

## Environment

Required for cloud providers:

- `GEMINI_API_KEY` for Gemini.
- `MODEL_API_KEY` for OpenAI or compatible providers.

Optional:

- `MODEL_PROVIDER=gemini|openai|ollama`
- `MODEL_BASE_URL=...`
- `MODEL_NAV_MODEL=...`
- `MODEL_SYNTH_MODEL=...`
- `MODEL_SYNTH_ENABLED=1`
- `RUN_STORE_DIR=./agent_runs`
- `THREAD_STORE_DIR=./agent_threads`
- `MAX_STEPS=160`
- `ALLOWED_DOMAINS=`
- `CAPTURE_ARTIFACTS=1`
- `BROWSER_HEADLESS=false`
- `CDP_HTTP=http://127.0.0.1:9222`

## CLI

Run an agent task through the HTTP API:

```bash
npm run agent:cli -- "Go to https://example.com and summarize the page"
```

Use the local MCP test client:

```bash
npm run mcp:cli list_runs
npm run mcp:cli agent_state
```

Start the stdio MCP server:

```bash
npm run mcp:stdio
```
