# Release Checklist

This checklist is for the public open-source desktop app.

## Before Release

```bash
npm run build
node -c electron/main.cjs
node -c electron/preload.cjs
npm run health
```

Run at least one provider smoke test:

```bash
npm run agent:cli -- "Go to https://example.com and tell me the page heading."
```

Run the desktop app:

```bash
npm run desktop:dev
```

Verify:

- settings persist
- provider/model selection works
- Ollama model discovery works when Ollama is installed
- browser/profile controls render correctly
- a managed-browser run completes
- activity and run detail load
- no console errors in the main workflow

## Build

Automated macOS release:

1. Bump `package.json` and `package-lock.json` to the next version.
2. Merge the version bump to `main`.
3. Push a matching tag, for example `v0.1.1`.
4. The `Release macOS` workflow builds the unsigned DMG, computes SHA-256, uploads workflow artifacts, and creates a draft GitHub Release.
5. Review the generated notes/assets, edit the notes if needed, then publish the draft release manually.

The workflow can also be run manually from GitHub Actions against an existing tag. Keep `draft=true` unless you intentionally want the run to publish the release immediately.

Unsigned/ad-hoc macOS build:

```bash
npm run desktop:build
```

Signed build:

```bash
npm run desktop:build:signed
```

Use the signed script only when the release machine is intentionally configured with the correct developer identity.

## GitHub Release Notes

Include:

- platform status: macOS alpha
- Windows/Linux status: planned, packaging configured but not yet validated
- supported providers: Gemini, OpenAI, Claude, OpenAI-compatible, Ollama
- browser/profile support caveats
- local data locations
- security reporting link
- license: GPL-3.0-or-later

## Keep Out Of Releases

Do not include ignored local artifacts:

- `.env.local`
- `agent_runs/`
- `agent_threads/`
- `desktop_dist/` except the specific release artifacts being uploaded
- `.next/`
- `.desktop-dev-data/`
- `.playwright-mcp/`
- screenshots or local test captures unless intentionally documented

## macOS Signing

Unsigned builds are acceptable for early alpha releases, but users will see normal macOS warnings. Notarized builds require Apple Developer credentials and should be done deliberately, not through automatic identity discovery.
