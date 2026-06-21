# Desktop App

WebPilot ships as an Electron shell around the Next.js app and local agent runtime.

## Development

```bash
npm run desktop:dev
```

This starts Next.js on `127.0.0.1:3210`, launches Electron, and stores dev runtime data in `.desktop-dev-data/`.

## Settings Bridge

Electron persists runtime settings locally:

- provider and model choices
- API base URL and key
- synth setting
- browser mode
- profile strategy
- headless and isolation flags

The renderer accesses these through `electron/preload.cjs`.

## Browser Discovery

The desktop shell detects common local browser installs and profile roots where possible. It exposes:

- managed WebPilot Chromium
- installed browser channels
- CDP connection mode
- custom executable mode
- temporary, app, custom, and memory-only profile strategies

Profiles can contain sensitive browsing state. The UI should continue to make profile selection explicit and avoid silently attaching to a real user profile.

## Building

Unsigned/ad-hoc build:

```bash
npm run desktop:build
```

Platform-specific unsigned builds:

```bash
npm run desktop:build:mac
npm run desktop:build:win
npm run desktop:build:linux
```

Explicit signed build:

```bash
npm run desktop:build:signed
```

The default build intentionally disables signing identity auto-discovery. This avoids accidentally signing public alpha builds with a personal Apple Developer identity.

## Release Artifacts

Electron Builder writes artifacts to `desktop_dist/`.

- macOS: `.dmg`
- Windows: unsigned NSIS `.exe` and `.zip`
- Linux: AppImage and `.zip`

The build prep step:

- runs Next standalone build
- installs bundled Playwright browsers
- copies public/static assets
- compiles desktop runtime modules
- excludes local runtime data from the app bundle

## Platform Status

macOS has the established release workflow. Windows packaging can be built and smoke-tested on a Windows host with `npm run desktop:build:win && npm run desktop:smoke`. Linux packaging is prepared for native Linux hosts and the `Package Desktop` GitHub Actions workflow; use the workflow when a local Linux desktop environment is unavailable.

All public alpha artifacts are unsigned unless release notes explicitly say otherwise. The default unsigned Windows build is intentionally unprivileged and skips executable signing/resource-editing steps that require Electron Builder's Windows signing tool bundle. Do not imply Windows code signing, Microsoft Store distribution, Linux repository signing, or macOS notarization until those credentials and checks exist.
