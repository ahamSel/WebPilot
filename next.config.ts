import type { NextConfig } from "next";

const standaloneExcludes = [
  "agent_runs/**/*",
  "e2e_reports/**/*",
  "agent_threads/**/*",
  "desktop_dist/**/*",
  ".desktop-dev-data/**/*",
  ".playwright-mcp/**/*",
  "firebase-debug.log",
  "*.md",
  "Dockerfile",
  "tsconfig.tsbuildinfo",
];

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["http://127.0.0.1:3210"],
  outputFileTracingExcludes: {
    "/**": standaloneExcludes,
  },
  // Note: if Turbopack panics in constrained envs, run build with
  // NEXT_USE_TURBOPACK=0 npm run build to force webpack.
};

export default nextConfig;
