# WebPilot browser extension

WebPilot in your browser's side panel. Ask it about the page you have open or anything on the web; it works in your current tab, with the logins you already have, and asks before anything irreversible.

Works in Chromium browsers: Chrome, Edge, Brave, Arc (Chrome 116+).

## Install from source

```bash
npm install
npm run extension:build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `extension/dist`. Click the WebPilot toolbar icon to open the side panel.

For development, `npm run extension:dev` rebuilds on every change; click the reload icon on the extension card to pick it up.

## First run

Open **Settings** (gear icon) and click **Connect OpenRouter**. You approve a key for WebPilot on openrouter.ai; it can be revoked or given a credit limit from the OpenRouter dashboard. You can also paste an existing `sk-or-...` key.

Fast mode (Jev) is on by default.

## How it works

- The agent runs in the side panel page and controls the active tab through `chrome.debugger` (the Chrome DevTools Protocol). Chrome shows a "WebPilot started debugging this browser" bar while a task runs; it goes away when the task ends, and clicking **Cancel** on it stops the task.
- Pages are read from Chrome's accessibility tree and acted on with real mouse and keyboard events, so sites treat them like your own input.
- The same core runs in the desktop app and the extension: `lib/core/run-task.ts` (the task flow), `lib/cdp/` (the CDP driver and accessibility-tree snapshot), `lib/jev/` (fast mode), `lib/safety.ts` and `lib/model-client.ts`.
- Requests that only find or read information use fast mode: Jev picks each click in ~0.3s and the model writes text and the answer. Requests that change something (buy, book, send, delete, submit) use the careful model planner.
- Before an irreversible click (buy, place order, checkout, send, delete, publish, unsubscribe...) the panel shows **"Hold on — this can't be undone"** with Allow and Cancel.

## Permissions

| Permission | Why |
|---|---|
| `sidePanel` | The WebPilot panel |
| `debugger` | Reading and controlling the tab you ask it to work in |
| `tabs` | Knowing which tab is active and its title |
| `storage` | Your settings and OpenRouter key (stored locally) |
| `identity` | "Connect OpenRouter" sign-in |
| `https://openrouter.ai/*` | Model and Jev requests |

Chrome does not allow extensions to control `chrome://` pages or the Chrome Web Store.

## Privacy

Page text, element labels and URLs of the tab WebPilot works in are sent to OpenRouter to run the model, and in fast mode to TypeSafe (through OpenRouter) for Jev. Nothing is sent while no task is running. Settings stay in the browser's local extension storage.

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
