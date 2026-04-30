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

Explicit signed build:

```bash
npm run desktop:build:signed
```

The default build intentionally disables signing identity auto-discovery. This avoids accidentally signing public alpha builds with a personal Apple Developer identity.

## Release Artifacts

Electron Builder writes artifacts to `desktop_dist/`.

The build prep step:

- runs Next standalone build
- installs bundled Playwright browsers
- copies public/static assets
- compiles desktop runtime modules
- excludes local runtime data from the app bundle

## Platform Status

macOS is the first release target. Windows and Linux packaging are configured but should be tested on those platforms before public release artifacts are published.
