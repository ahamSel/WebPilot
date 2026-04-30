# Security Policy

WebPilot controls a local browser and can interact with authenticated sessions when users explicitly configure a browser/profile or CDP connection. Treat security reports seriously.

## Supported Versions

The project is currently alpha. Security fixes target the latest `main` branch until stable release channels exist.

## Reporting a Vulnerability

Please do not open public issues for sensitive vulnerabilities.

Until a dedicated security contact is configured on the public GitHub repository, report issues privately to the repository owner. After the repo is public, enable GitHub private vulnerability reporting and update this file with the canonical reporting path.

Useful report details:

- Affected commit or release.
- Platform and browser mode.
- Whether the issue involves managed Chromium, a detected browser/profile, CDP, local run data, or model-provider credentials.
- Minimal reproduction steps.
- Expected impact.

## Security Boundaries

WebPilot should not be used to bypass CAPTCHAs, 2FA, paywalls, access controls, or site anti-automation protections. When a site requires human intervention, the agent should pause.

Provider API keys, browser profile paths, run artifacts, and local model settings are user-private data. Do not include real secrets, cookies, or private browsing artifacts in bug reports or pull requests.
