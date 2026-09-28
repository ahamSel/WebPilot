import type { NextConfig } from "next";

const standaloneExcludes = [
  "agent_runs/**/*",
  "e2e_reports/**/*",
  "agent_threads/**/*",
  "desktop_dist/**/*",
  ".desktop-dev-data/**/*",
  ".playwright-browsers/**/*",
  ".playwright-mcp/**/*",
  "firebase-debug.log",
  "next.config.*",
  "package-lock.json",
  "*.md",
  "Dockerfile",
  "tsconfig.tsbuildinfo",
];

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingExcludes: {
    "/**": standaloneExcludes,
  },
  // Keep local/release commands on webpack for Windows packaging; Turbopack
  // requires native SWC bindings that may be unavailable on release hosts.
  webpack: (config) => {
    // The Playwright MCP driver resolves Playwright at runtime via
    // createRequire(<cwd>/package.json) so dev, standalone, and Electron share one
    // module instance. Webpack otherwise rewrites dynamic createRequire() calls
    // to `undefined`, so leave them to Node for this module.
    config.module.rules.push({
      test: /[\\/]lib[\\/]playwright-mcp-driver\.ts$/,
      parser: { createRequire: false },
    });
    return config;
  },
};

export default nextConfig;
