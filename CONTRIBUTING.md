# Contributing to WebPilot

WebPilot is an alpha desktop app for local-first browser agents. Contributions are welcome, especially around reliability, latency, browser compatibility, local model support, and desktop packaging.

## Development Setup

```bash
npm install
npm run browsers:install
npm run dev
```

Electron development:

```bash
npm run desktop:dev
```

Production build checks:

```bash
npm run build
npm run desktop:build
```

The default desktop build is unsigned. Use `npm run desktop:build:signed` only when intentionally testing signing/notarization.

## Before Opening a Pull Request

- Run `npm run build`.
- Test any UI changes in the Electron shell when they affect desktop behavior.
- Keep local run artifacts out of commits.
- Update docs when changing settings, provider behavior, browser/profile behavior, packaging, or release flow.
- Keep changes scoped; avoid mixing product changes with formatting-only rewrites.

## Product Principles

- Local-first by default.
- Bring your own model key, or use a local Ollama model.
- Prefer deterministic browser setup and clear tool flows before adding more model calls.
- Do not design features for bypassing CAPTCHAs, 2FA, paywalls, or site security controls.
- Treat browser profiles, cookies, provider credentials, local model settings, and run artifacts as private user data.

## License

By contributing, you agree that your contribution is licensed under `GPL-3.0-or-later`, matching the project license.
