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
- Rate any answer with 👍/👎 and add a note, or type `/feedback <what was off>` to attach a note to the last answer. Notes are saved locally with that run's trace (below), so problems can be looked into later.

## First run

Open **Settings** (gear icon) and click **Connect OpenRouter**. You approve a key for WebPilot on openrouter.ai; it can be revoked or given a credit limit from the OpenRouter dashboard. You can also paste an existing `sk-or-...` key.

Fast mode (Jev) is on by default.

## How it works

- WebPilot controls the tab you ask it to through `chrome.debugger` (the Chrome DevTools Protocol), attaching only when a task needs the page. Chrome shows a "WebPilot started debugging this browser" bar while a task runs; it goes away when the task ends, and clicking **Cancel** on it stops the task.
- Chrome refuses the debugger on pages that contain another extension's frame, which password managers (LastPass, 1Password...) and tools like Grammarly add to many pages, including Gmail, and detaches it when such a frame appears mid-task. It also can't attach while another tool is debugging the tab. On those pages WebPilot switches to page scripts (`src/dom-browser.ts`, `src/page-scripts.ts`): it reads the visible page into the same snapshot format and acts with DOM events. The flight log notes the switch; each navigation tries the debugger again.
- Pages are read from Chrome's accessibility tree and acted on with real mouse and keyboard events, so sites treat them like your own input.
- The same core runs in the desktop app and the extension: `lib/core/run-task.ts` (the task flow), `lib/cdp/` (the CDP driver and accessibility-tree snapshot), `lib/jev/` (fast mode), `lib/safety.ts` and `lib/model-client.ts`.
- The agent runs in the extension's background service worker (`src/engine.ts`), one session per tab; panels are views connected over a port. While a task runs, the worker keeps itself alive.
- Jev (a fast decision model, ~0.3s per call) and the LLM work as a pair, each doing what it's best at:
  - Requests about the open page that reading alone can answer ("summarize this", "what does this say about X") skip navigation and clicks and stream the answer straight from the page.
  - Requests that find or read information use fast mode: Jev picks each click and scroll; the LLM writes typed text and the answer. When Jev is blocked, stuck or guessing, it asks the LLM for that one step and keeps driving, instead of handing the whole task over.
  - Requests with several separate parts ("when is X, and also when is Y") and requests that change something (buy, book, send, delete, submit) go to the LLM planner, which thinks and decides but hands legwork (opening results, emails, items; moving through lists) back to Jev as sub-goals with `delegate`.
  - Jev requests stay within its 32k-token context: crowded pages keep the elements most relevant to the task. If a Jev call fails, the LLM picks that step. The planner's older page views are trimmed to their text, so later steps stay fast.
- Pages often navigate a moment after an action (a search that submits once its suggestions load). WebPilot notices when the page starts changing after it last looked, and looks again instead of clicking on the page being left.
- Answers stream into the panel as they are written, including the planner's (it replies in plain text rather than through a tool call, whose arguments only arrive at the end); Jev then checks them against every page it saw (are the facts on those pages, and is every part of the request answered?), and an answer that fails is redone (first by Jev looking closer, then by the model).
- Requests that only find or read information never send, buy or delete anything: those controls aren't even considered.
- When a request does ask for something irreversible (buy, place order, checkout, send, delete, publish, unsubscribe...), the panel shows **"Hold on — this can't be undone"** before each such click, with Allow and Skip. Skip leaves that action undone (it isn't asked about again during the task) and WebPilot carries on with the rest, saying in the answer what it skipped. Skipping a sign-in stops work on that site at once (nothing behind it can be reached): WebPilot finishes any other part of the request and tells you to sign in and ask again. The stop button ends the whole task.
- Sites are picked for your country, from your browser's language and time zone (walmart.ca rather than walmart.com in Canada).
- WebPilot never types into password, one-time-code or card fields and never makes up usernames or other personal details. On a sign-in page your password manager has already filled in, clicking "Log in" asks first (**"Hold on — sign in?"**); otherwise it asks you to sign in yourself and then continue.
- A follow-up like "no, it's on Gmail" or "try again" continues a request that didn't finish.

## Permissions

| Permission | Why |
|---|---|
| `sidePanel` | The WebPilot panel |
| `debugger` | Reading and controlling the tab you ask it to work in |
| `scripting` + all sites | Page scripts, for pages where Chrome doesn't allow the debugger (see How it works) |
| `tabs` | Knowing which tab is active and its title |
| `storage` | Your settings, OpenRouter key and conversation history (stored locally) |
| `identity` | "Connect OpenRouter" sign-in |

Chrome does not allow extensions to control `chrome://` pages or the Chrome Web Store.

## Privacy

Page text, element labels and URLs of the tab WebPilot works in are sent to OpenRouter to run the model, and in fast mode to TypeSafe (through OpenRouter) for Jev. Nothing is sent while no task is running. Settings and conversation history (at most the 100 most recent conversations) stay in the browser's local extension storage on this device; they are never synced or uploaded. Each answer also keeps a short technical trace there (routing decisions, steps and timings, errors) and any feedback you left, for troubleshooting. History has Clear all, which removes these too.

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
npx tsx scripts/extension-bridge.ts run edge "find X in my email" --then "no, it's on gmail"   # a conversation
npx tsx scripts/extension-bridge.ts last edge [n]            # your most recent conversation (n-th most recent), with traces
npx tsx scripts/extension-bridge.ts feedback edge            # answers you rated or commented on, with traces
npx tsx scripts/extension-bridge.ts targets chrome https://mail.google.com   # what blocks the debugger on a page
npm run bench:fast-mode -- --engine extension --browser chrome --suite realistic --modes fast
```

Jev's answer check (good answers kept, wrong, made-up, partial and falsely "not found" answers caught) has its own evaluation: `OPENROUTER_API_KEY=sk-or-... npm run eval:answer-check`.

The smoke test also loads a stand-in for a password manager (`scripts/fixtures/frame-injector`) that puts its frame into pages opened with `?pm=1`, so the page-script path is tested too.

The extension polls `http://127.0.0.1:4466` and only accepts commands from a server that knows the random secret generated for that build (`extension/.dev-bridge-token`, gitignored). Release builds (`npm run extension:build`) compile the bridge out and drop its permissions (`alarms`, localhost).
