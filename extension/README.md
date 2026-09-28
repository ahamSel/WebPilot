# WebPilot browser extension

WebPilot in your browser's side panel. Ask it about the page you have open or anything on the web; it works in your current tab, with the logins you already have, and asks before anything irreversible.

Works in Chromium browsers: Chrome, Edge, Brave, Arc (Chrome 116+).

## Install from source

```bash
npm install
npm run extension:build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `extension/dist`. Click the WebPilot toolbar icon to open the side panel.

`extension:build` is the release build. For development use the dev build, which adds a test bridge (see Testing): `npm run extension:build:dev`, or `npm run extension:dev` to rebuild on every change.

## Using it

- Click the WebPilot icon, or press **Ctrl+Shift+Space** (change it at `chrome://extensions/shortcuts`), to open WebPilot **for the current tab**. Every tab has its own panel, conversation and running task; switching tabs switches panels, and a task keeps running if you close its panel or switch away.
- It's a conversation: follow-ups like "what about the second one?" or "open it" continue from the previous answers. Each turn also keeps hidden notes (pages visited, where it ended, what it clicked) so later messages can pick up from there, even after the tab has moved on.
- **History** (clock icon) lists past conversations. Opening one continues it in the current tab; WebPilot doesn't restore the old pages but knows what it did and navigates back if needed. **+** starts a new conversation.
- Enter sends, Shift+Enter adds a line, Esc stops a running task.

## First run

Open **Settings** (gear icon) and click **Connect OpenRouter**. You approve a key for WebPilot on openrouter.ai; it can be revoked or given a credit limit from the OpenRouter dashboard. You can also paste an existing `sk-or-...` key.

Fast mode (Jev) is on by default.

## How it works

- WebPilot controls the tab you ask it to through `chrome.debugger` (the Chrome DevTools Protocol), attaching only when a task needs the page. Chrome shows a "WebPilot started debugging this browser" bar while a task runs; it goes away when the task ends, and clicking **Cancel** on it stops the task.
- Pages are read from Chrome's accessibility tree and acted on with real mouse and keyboard events, so sites treat them like your own input.
- The same core runs in the desktop app and the extension: `lib/core/run-task.ts` (the task flow), `lib/cdp/` (the CDP driver and accessibility-tree snapshot), `lib/jev/` (fast mode), `lib/safety.ts` and `lib/model-client.ts`.
- The agent runs in the extension's background service worker (`src/engine.ts`), one session per tab; panels are views connected over a port. While a task runs, the worker keeps itself alive.
- Requests about the open page that reading alone can answer ("summarize this", "what does this say about X") skip navigation and clicks and stream the answer straight from the page. Other requests that only find or read information use fast mode: Jev picks each click in ~0.3s and the model writes text and the answer. Requests that change something (buy, book, send, delete, submit) use the careful model planner.
- Answers stream into the panel as they are written; Jev then checks them against the page, and an unsupported answer is redone (first by Jev looking closer, then by the model).
- Before an irreversible click (buy, place order, checkout, send, delete, publish, unsubscribe...) the panel shows **"Hold on — this can't be undone"** with Allow and Cancel. Cancel ends the task there; say "go ahead" to continue.

## Permissions

| Permission | Why |
|---|---|
| `sidePanel` | The WebPilot panel |
| `debugger` | Reading and controlling the tab you ask it to work in |
| `tabs` | Knowing which tab is active and its title |
| `storage` | Your settings, OpenRouter key and conversation history (stored locally) |
| `identity` | "Connect OpenRouter" sign-in |
| `https://openrouter.ai/*` | Model and Jev requests |

Chrome does not allow extensions to control `chrome://` pages or the Chrome Web Store.

## Privacy

Page text, element labels and URLs of the tab WebPilot works in are sent to OpenRouter to run the model, and in fast mode to TypeSafe (through OpenRouter) for Jev. Nothing is sent while no task is running. Settings and conversation history (at most the 100 most recent conversations) stay in the browser's local extension storage on this device; they are never synced or uploaded. History has Clear all.

## Testing

```bash
npm run extension:build
OPENROUTER_API_KEY=sk-or-... npm run extension:smoke            # headless
OPENROUTER_API_KEY=sk-or-... npm run extension:smoke -- --headed
```

The smoke test loads `extension/dist` into Chromium, opens the local webmail and shop fixtures, types requests into the real side panel and checks the answers, confirmations and recorded actions (no sends, deletes or orders). Screenshots go to `e2e_reports/extension/`.

The full scenario suite runs against the extension's engine too:

```bash
npm run bench:fast-mode -- --engine cdp --suite all
```

### Testing in your own browsers (dev bridge)

Dev builds include a bridge that lets the scenario harness run tasks inside the real browsers where the dev extension is installed, with their logins. Each task opens its own window and closes it afterwards, so your tabs are left alone.

```bash
node scripts/build-extension.mjs --dev --out ~/WebPilot-extension   # load this folder once per browser
npx tsx scripts/extension-bridge.ts ping chrome                      # or edge, brave...
npx tsx scripts/extension-bridge.ts reload edge                      # pick up a rebuild without clicking
npx tsx scripts/extension-bridge.ts run chrome "summarize this page" --url https://example.com
npm run bench:fast-mode -- --engine extension --browser chrome --suite realistic --modes fast
```

The extension polls `http://127.0.0.1:4466` and only accepts commands from a server that knows the random secret generated for that build (`extension/.dev-bridge-token`, gitignored). Release builds (`npm run extension:build`) compile the bridge out and drop its permissions (`alarms`, localhost).
