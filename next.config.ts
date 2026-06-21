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
};

export default nextConfig;
