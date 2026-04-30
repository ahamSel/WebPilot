#!/usr/bin/env node
/* Terminal-first runner for agent API flows.
 * Commands:
 *   node scripts/agent-runner.js start "goal text"
 *   node scripts/agent-runner.js run "goal text"
 *   node scripts/agent-runner.js watch
 *   node scripts/agent-runner.js state
 *   node scripts/agent-runner.js resume
 *   node scripts/agent-runner.js stop
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const API_URL = `${BASE_URL}/api/agent`;

const args = process.argv.slice(2);
const command = args[0];
const payload = args.slice(1).join(" ").trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getState() {
  const res = await fetch(API_URL, { method: "GET" });
  if (!res.ok) {
    throw new Error(`GET /api/agent failed (${res.status})`);
  }
  return await res.json();
}

async function postAction(action, goal) {
  const body = { action };
  if (goal) body.goal = goal;
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `POST ${action} failed (${res.status})`);
  }
  return json;
}

function printSummary(state) {
  const out = {
    status: state.status,
    step: state.step,
    runDir: state.runDir,
    lastAction: state.lastAction,
    finalResult: state.finalResult,
    lastError: state.lastError,
    intervention: state.intervention,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
  console.log(JSON.stringify(out, null, 2));
}

async function watchUntilTerminal() {
  const timeoutSec = Number(process.env.AGENT_TIMEOUT_SEC || 1800);
  const intervalMs = Number(process.env.AGENT_POLL_MS || 1500);
  const start = Date.now();
  let lastStatus = "";
  let lastStep = -1;

  while (true) {
    if ((Date.now() - start) / 1000 > timeoutSec) {
      throw new Error(`Timed out after ${timeoutSec}s`);
    }

    const state = await getState();
    if (state.status !== lastStatus || state.step !== lastStep) {
      console.log(`[agent] status=${state.status} step=${state.step}`);
      lastStatus = state.status;
      lastStep = state.step;
    }

    if (state.status === "paused") {
      console.log("[agent] paused, intervention required:");
      console.log(state.intervention || "(no message)");
      printSummary(state);
      return 2;
    }
    if (state.status === "done") {
      console.log("[agent] done");
      printSummary(state);
      return 0;
    }
    if (state.status === "stopped") {
      console.log("[agent] stopped");
      printSummary(state);
      return 0;
    }
    if (state.status === "error") {
      console.log("[agent] error");
      printSummary(state);
      return 1;
    }

    await sleep(intervalMs);
  }
}

async function main() {
  switch (command) {
    case "start":
      if (!payload) throw new Error("Missing goal text");
      await postAction("start", payload);
      console.log("[agent] started");
      return;
    case "run":
      if (!payload) throw new Error("Missing goal text");
      await postAction("start", payload);
      console.log("[agent] started");
      process.exit(await watchUntilTerminal());
      return;
    case "watch":
      process.exit(await watchUntilTerminal());
      return;
    case "state":
      printSummary(await getState());
      return;
    case "resume":
      await postAction("resume");
      console.log("[agent] resume requested");
      return;
    case "stop":
      await postAction("stop");
      console.log("[agent] stop requested");
      return;
    default:
      console.log("Usage:");
      console.log("  node scripts/agent-runner.js start \"goal text\"");
      console.log("  node scripts/agent-runner.js run \"goal text\"");
      console.log("  node scripts/agent-runner.js watch");
      console.log("  node scripts/agent-runner.js state");
      console.log("  node scripts/agent-runner.js resume");
      console.log("  node scripts/agent-runner.js stop");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[agent-runner] ${err.message}`);
  process.exit(1);
});
