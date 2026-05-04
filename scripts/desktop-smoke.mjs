import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "desktop_dist");
const smokePrefix = "[webpilot:desktop-smoke] ";

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function findPackagedApp(dir, depth = 0) {
  if (depth > 4 || !(await pathExists(dir))) return null;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name === "WebPilot.app") {
      return fullPath;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findPackagedApp(path.join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function assert(condition, message, details = undefined) {
  if (condition) return;
  const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function reservePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function runPackagedSmoke(executablePath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Packaged smoke timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 60_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Packaged smoke exited with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(smokePrefix));
      if (!line) {
        reject(new Error(`Packaged smoke did not print its JSON result.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(smokePrefix.length)));
      } catch (error) {
        reject(new Error(`Packaged smoke printed invalid JSON: ${line}\n${error}`));
      }
    });
  });
}

const appPath = await findPackagedApp(distDir);
assert(appPath, "Could not find WebPilot.app under desktop_dist. Build the desktop app before running desktop:smoke.");

const executablePath = path.join(appPath, "Contents", "MacOS", "WebPilot");
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "webpilot-smoke-user-data-"));
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "webpilot-smoke-runtime-"));
const defaultPort = Number(process.env.ELECTRON_PORT || 3210);
const reservedDefaultPort = await reservePort(defaultPort);

try {
  const result = await runPackagedSmoke(executablePath, {
    ...process.env,
    WEBPILOT_DESKTOP_SMOKE: "1",
    WEBPILOT_USER_DATA_DIR: userDataDir,
    RUN_STORE_DIR: path.join(runtimeDir, "runs"),
    THREAD_STORE_DIR: path.join(runtimeDir, "threads"),
    ELECTRON_ENABLE_LOGGING: "1",
  });

  assert(result?.isPackaged === true, "Packaged smoke must launch the packaged Electron app.", result);
  assert(result?.runtimeTransport === "direct", "Packaged app must use the direct desktop runtime, not HTTP fallback.", result);
  assert(!result?.runtimeError, "Packaged app reported a desktop runtime load error.", result);
  assert(result?.historyLoaded === true, "Packaged app must include direct history deletion runtime methods.", result);
  assert(
    result?.browser?.headless === false,
    "Default packaged browser setting must be headed.",
    result?.browser
  );
  const rendererPort = new URL(result.rendererUrl).port;
  assert(
    rendererPort !== String(defaultPort),
    "Packaged app should move off the default port when it is already occupied.",
    result
  );

  console.log("[desktop:smoke] Packaged Electron app loaded with direct runtime, isolated data, dynamic port, and headed browser defaults.");
} finally {
  if (reservedDefaultPort) {
    await new Promise((resolve) => reservedDefaultPort.close(resolve));
  }
}
