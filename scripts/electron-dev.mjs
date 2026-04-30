import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const port = Number(process.env.DESKTOP_PORT || 3210);
const devUrl = `http://127.0.0.1:${port}`;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const dataRoot = path.join(process.cwd(), ".desktop-dev-data");

function desktopDataEnv() {
  return {
    ELECTRON_DESKTOP: "1",
    RUN_STORE_DIR: path.join(dataRoot, "agent_runs"),
    THREAD_STORE_DIR: path.join(dataRoot, "agent_threads"),
  };
}

let nextProcess;
let electronProcess;
let shuttingDown = false;

function waitForUrl(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const poll = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(poll, 300);
      });
    };

    poll();
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electronProcess) electronProcess.kill("SIGTERM");
  if (nextProcess) nextProcess.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

nextProcess = spawn(npmCmd, ["run", "dev", "--", "--port", String(port)], {
  env: {
    ...process.env,
    ...desktopDataEnv(),
    PORT: String(port),
  },
  stdio: "inherit",
});

nextProcess.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[desktop:dev] Next dev exited with code ${code ?? "unknown"}.`);
    shutdown(code ?? 1);
  }
});

try {
  await waitForUrl(devUrl, 45000);
} catch (error) {
  console.error("[desktop:dev] Failed to start Next dev server:", error);
  shutdown(1);
}

electronProcess = spawn(npxCmd, ["electron", "."], {
  env: {
    ...process.env,
    ...desktopDataEnv(),
    ELECTRON_RENDERER_URL: devUrl,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    ELECTRON_PORT: String(port),
  },
  stdio: "inherit",
});

electronProcess.on("exit", (code) => {
  if (!shuttingDown) {
    shutdown(code ?? 0);
  }
});
