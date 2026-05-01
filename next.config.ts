import type { NextConfig } from "next";

const standaloneExcludes = [
  "agent_runs/**/*",
  "e2e_reports/**/*",
  "agent_threads/**/*",
  "desktop_dist/**/*",
  ".desktop-dev-data/**/*",
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
  // Note: if Turbopack panics in constrained envs, run build with
  // NEXT_USE_TURBOPACK=0 npm run build to force webpack.
};

export default nextConfig;
