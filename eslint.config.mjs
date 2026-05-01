import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "desktop_dist/**",
    ".desktop-dev-data/**",
    ".playwright-browsers/**",
    ".playwright-mcp/**",
    "agent_runs/**",
    "agent_threads/**",
    "e2e_reports/**",
    "readiness_reports/**",
  ]),
]);

export default eslintConfig;
