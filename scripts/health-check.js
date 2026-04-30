#!/usr/bin/env node
/* Lightweight smoke check that future agents can run from the terminal.
 * It does not hit a live browser; it only inspects filesystem state
 * and reports basic warnings.
 */

const fs = require("fs");
const path = require("path");

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function log(section, message) {
  console.log(`[health:${section}] ${message}`);
}

const cwd = process.cwd();
const runDirRoot = process.env.RUN_STORE_DIR || path.join(cwd, "agent_runs");
const threadDirRoot = process.env.THREAD_STORE_DIR || path.join(cwd, "agent_threads");
let warnCount = 0;

// TESTING doc
if (exists(path.join(cwd, "TESTING.md"))) {
  log("doc", "TESTING.md found");
} else {
  log("warn", "TESTING.md missing");
  warnCount++;
}

// Runs
if (exists(runDirRoot)) {
  const entries = fs.readdirSync(runDirRoot).filter((d) => !d.startsWith("."));
  log("runs", `run directory present (${entries.length} entries)`);
  if (entries.length) {
    const latest = entries.sort().reverse()[0];
    const runJson = safeReadJson(path.join(runDirRoot, latest, "run.json"));
    if (runJson) {
      log("runs", `latest run ${latest}: status=${runJson.status || "unknown"}`);
    } else {
      log("warn", `latest run ${latest} missing run.json`);
      warnCount++;
    }
  }
} else {
  log("warn", "agent_runs directory missing (no runs recorded yet)");
}

// Threads
if (exists(threadDirRoot)) {
  const entries = fs.readdirSync(threadDirRoot).filter((d) => !d.startsWith("."));
  log("threads", `thread directory present (${entries.length} entries)`);
} else {
  log("warn", "agent_threads directory missing (no threads recorded yet)");
}

if (warnCount > 0) {
  log("result", `Completed with ${warnCount} warning(s)`);
  process.exit(0);
} else {
  log("result", "OK");
  process.exit(0);
}
