import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const rootDir = process.cwd();
const browserStoreDir = path.join(rootDir, ".playwright-browsers");
const playwrightCli = path.join(rootDir, "node_modules", "playwright", "cli.js");

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function rootPlaywrightRequire() {
  const packagePath = path.join(rootDir, "node_modules", "playwright", "package.json");
  const playwrightRequire = createRequire(packagePath);
  return playwrightRequire("playwright");
}

function chromiumInstallStatus() {
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserStoreDir;
    process.env.PLAYWRIGHT_SKIP_BROWSER_GC = process.env.PLAYWRIGHT_SKIP_BROWSER_GC || "1";
    const { chromium } = rootPlaywrightRequire();
    const executablePath = chromium.executablePath();
    return {
      executablePath,
      exists: !!executablePath && existsSync(executablePath),
    };
  } catch (error) {
    return {
      executablePath: "",
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runPlaywrightInstall() {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [playwrightCli, "install", "chromium"],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: browserStoreDir,
          PLAYWRIGHT_SKIP_BROWSER_GC: "1",
        },
        stdio: "inherit",
      }
    );

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Playwright Chromium install exited with code ${code ?? "unknown"}`));
    });
    child.on("error", reject);
  });
}

if (!await pathExists(playwrightCli)) {
  throw new Error("Playwright CLI not found. Run `npm install` first.");
}

await fs.mkdir(browserStoreDir, { recursive: true });

const before = chromiumInstallStatus();
if (before.exists) {
  console.log(`[desktop:browsers] Chromium already available at ${before.executablePath}`);
  process.exit(0);
}

if (before.error) {
  console.log(`[desktop:browsers] Chromium missing: ${before.error}`);
}

await runPlaywrightInstall();

const after = chromiumInstallStatus();
if (!after.exists) {
  throw new Error("Playwright Chromium install finished but the executable is still missing.");
}

console.log(`[desktop:browsers] Chromium ready at ${after.executablePath}`);
