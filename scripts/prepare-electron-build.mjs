import fs from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";

const rootDir = process.cwd();
const standaloneDir = path.join(rootDir, ".next", "standalone");
const standaloneStaticDir = path.join(standaloneDir, ".next", "static");
const standaloneNodeModulesDir = path.join(standaloneDir, ".next", "node_modules");
const sourceStaticDir = path.join(rootDir, ".next", "static");
const sourcePublicDir = path.join(rootDir, "public");
const targetPublicDir = path.join(standaloneDir, "public");
const desktopRuntimeOutDir = path.join(standaloneDir, "desktop-runtime");
const pruneTargets = [
  "agent_runs",
  "e2e_reports",
  "agent_threads",
  "desktop_dist",
  ".desktop-dev-data",
  ".playwright-browsers",
];

async function copyDirIfPresent(from, to) {
  try {
    await fs.access(from);
  } catch {
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true, force: true });
}

async function materializeStandaloneSymlinks(dir) {
  const stats = await fs.lstat(dir).catch(() => null);
  if (!stats) return;

  if (stats.isSymbolicLink()) {
    const realTarget = await fs.realpath(dir);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.cp(realTarget, dir, { recursive: true, force: true });
    return;
  }

  if (!stats.isDirectory()) {
    return;
  }

  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    await materializeStandaloneSymlinks(path.join(dir, entry));
  }
}

async function pruneStandaloneContent() {
  for (const relativeTarget of pruneTargets) {
    await fs.rm(path.join(standaloneDir, relativeTarget), { recursive: true, force: true }).catch(() => {});
  }
}

async function compileDesktopRuntimeModules() {
  await fs.rm(desktopRuntimeOutDir, { recursive: true, force: true });
  await fs.mkdir(desktopRuntimeOutDir, { recursive: true });

  await esbuild.build({
    entryPoints: {
      agent: path.join(rootDir, "lib", "agent.ts"),
      recorder: path.join(rootDir, "lib", "recorder.ts"),
      threads: path.join(rootDir, "lib", "threads.ts"),
    },
    outdir: desktopRuntimeOutDir,
    entryNames: "[name]",
    bundle: true,
    packages: "external",
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: "inline",
    tsconfig: path.join(rootDir, "tsconfig.json"),
    logLevel: "silent",
  });
}

await fs.access(standaloneDir);
await copyDirIfPresent(sourceStaticDir, standaloneStaticDir);
await copyDirIfPresent(sourcePublicDir, targetPublicDir);
await materializeStandaloneSymlinks(standaloneNodeModulesDir);
await materializeStandaloneSymlinks(path.join(standaloneDir, ".next"));
await pruneStandaloneContent();
await compileDesktopRuntimeModules();

console.log("[desktop:build] Prepared standalone Next assets for Electron packaging.");
