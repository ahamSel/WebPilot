#!/usr/bin/env node
/* Terminal-first E2E harness for WebPilot agent.
 *
 * Usage:
 *   node scripts/agent-e2e.js list
 *   node scripts/agent-e2e.js run wikipedia_openai
 *   node scripts/agent-e2e.js run --goal "custom goal"
 *   node scripts/agent-e2e.js run-all
 *   node scripts/agent-e2e.js run-all --include-manual
 *
 * Environment:
 *   BASE_URL=http://localhost:3001
 *   AGENT_TIMEOUT_SEC=1200
 *   AGENT_POLL_MS=1500
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const API_URL = `${BASE_URL}/api/agent`;
const DEFAULT_TIMEOUT_SEC = Number(process.env.AGENT_TIMEOUT_SEC || 1200);
const POLL_MS = Number(process.env.AGENT_POLL_MS || 1500);
const RUN_META_TIMEOUT_MS = Number(process.env.RUN_META_TIMEOUT_MS || 45000);
const START_RETRY_MAX = Number(process.env.AGENT_START_RETRY_MAX || 30);
const E2E_REPORT_DIR = process.env.E2E_REPORT_DIR || path.join(process.cwd(), "e2e_reports");

const SCENARIOS = {
  wikipedia_openai: {
    description: "General web extraction outside Brightspace",
    manual: false,
    goal:
      "Go to https://en.wikipedia.org/wiki/OpenAI and return: founding year, headquarters city, and two founders. Include one exact sentence quote from the page.",
    forbidPause: true,
    minSteps: 2,
    expectFinalIncludesAny: [
      "OpenAI",
      "founded",
      "headquarters",
    ],
    expectRegex: [
      "\\b(2015|2016)\\b",
      "\\b(Sam Altman|Elon Musk|Ilya Sutskever|Greg Brockman|Wojciech Zaremba)\\b",
    ],
  },
  wikipedia_openai_founder_drilldown: {
    description: "Multi-page flow: OpenAI page then founder drilldown",
    manual: false,
    goal:
      "Go to https://en.wikipedia.org/wiki/OpenAI, then get Sam Altman's birth year from his page. Return: person, birth year, and one exact quote from Sam Altman page.",
    forbidPause: true,
    minSteps: 2,
    expectFinalIncludesAny: ["Sam Altman", "birth year"],
    expectRegex: ["\\b1985\\b"],
  },
  wikipedia_apollo11: {
    description: "Long-form extraction from a dense page",
    manual: false,
    goal:
      "Go to https://en.wikipedia.org/wiki/Apollo_11 and return: launch date, Moon landing date, and commander. Include one exact sentence quote from the page.",
    forbidPause: true,
    minSteps: 2,
    expectFinalIncludesAny: ["Apollo 11", "commander", "launch"],
    expectRegex: ["\\b1969\\b", "\\bNeil Armstrong\\b"],
  },
  brightspace_due: {
    description: "Brightspace due item with instruction quote",
    manual: true,
    goal:
      "In Brightspace for SOCI-1000-083, find the next due item and include one exact instruction sentence in quotes.",
    forbidPause: false,
    requireEvidenceCheck: true,
    minSteps: 2,
    expectFinalIncludesAny: ["Due on", "due on", "due"],
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getState() {
  const res = await fetch(API_URL, { method: "GET" });
  if (!res.ok) throw new Error(`GET /api/agent failed (${res.status})`);
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

function lower(s) {
  return String(s || "").toLowerCase();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function isoForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function saveBatchReport(report) {
  await ensureDir(E2E_REPORT_DIR);
  const file = path.join(E2E_REPORT_DIR, `e2e_report_${isoForFilename()}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

async function waitForTerminal(timeoutSec, forbidPause) {
  const start = Date.now();
  let last = "";
  while (true) {
    if ((Date.now() - start) / 1000 > timeoutSec) {
      throw new Error(`Timed out after ${timeoutSec}s`);
    }
    const state = await getState();
    const marker = `${state.status}:${state.step}`;
    if (marker !== last) {
      console.log(`[e2e] status=${state.status} step=${state.step}`);
      last = marker;
    }

    if (state.status === "paused") {
      if (forbidPause) {
        throw new Error(`Scenario paused unexpectedly: ${state.intervention || "(no message)"}`);
      }
      return { terminal: "paused", state };
    }
    if (state.status === "done") return { terminal: "done", state };
    if (state.status === "stopped") return { terminal: "stopped", state };
    if (state.status === "error") return { terminal: "error", state };
    await sleep(POLL_MS);
  }
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

async function readSteps(file) {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function waitForRunMetaDone(runJsonPath, timeoutMs = 5000) {
  const start = Date.now();
  let lastMeta = null;
  while (Date.now() - start <= timeoutMs) {
    try {
      const meta = await readJson(runJsonPath);
      lastMeta = meta;
      if (meta.status === "done" || meta.status === "error" || meta.status === "stopped") return meta;
    } catch {
      // Ignore transient read failures while recorder finalizes.
    }
    await sleep(250);
  }
  return lastMeta;
}

function assertCondition(ok, msg, failures) {
  if (!ok) failures.push(msg);
}

async function validateRunArtifacts(runDir, scenario, finalState) {
  const failures = [];
  const runJsonPath = path.join(runDir, "run.json");
  const stepsPath = path.join(runDir, "steps.jsonl");
  const artifactsDir = path.join(runDir, "artifacts");

  const runMeta = await waitForRunMetaDone(runJsonPath, RUN_META_TIMEOUT_MS);
  const steps = await readSteps(stepsPath);

  assertCondition(!!runMeta, "run.json missing or unreadable", failures);
  if (runMeta) {
    assertCondition(runMeta.status === "done", `run.json status is ${runMeta.status}, expected done`, failures);
  }
  assertCondition(steps.length >= (scenario.minSteps || 1), `steps.jsonl has ${steps.length} steps, expected at least ${scenario.minSteps || 1}`, failures);

  const finishRows = steps.filter((s) => s.name === "finish");
  assertCondition(finishRows.length > 0, "No finish step found in steps.jsonl", failures);
  assertCondition(finishRows.some((s) => s.ok), "No successful finish step found", failures);

  if (scenario.requireEvidenceCheck) {
    const files = await fs.readdir(artifactsDir).catch(() => []);
    const checks = files.filter((f) => f.includes("_finish_evidence_check.json"));
    assertCondition(checks.length > 0, "No finish evidence check artifacts found", failures);
    let hasOk = false;
    for (const file of checks) {
      const check = await readJson(path.join(artifactsDir, file)).catch(() => null);
      if (check && check.ok === true) hasOk = true;
    }
    assertCondition(hasOk, "No passing finish evidence check found", failures);
  }

  const finalText = String(finalState.finalResult || "");
  if (Array.isArray(scenario.expectFinalIncludesAny) && scenario.expectFinalIncludesAny.length) {
    const anyMatched = scenario.expectFinalIncludesAny.some((needle) => lower(finalText).includes(lower(needle)));
    assertCondition(anyMatched, `Final result missing expected keywords: ${scenario.expectFinalIncludesAny.join(", ")}`, failures);
  }
  if (Array.isArray(scenario.expectRegex)) {
    for (const pattern of scenario.expectRegex) {
      const re = new RegExp(pattern, "i");
      assertCondition(re.test(finalText), `Final result does not match regex: ${pattern}`, failures);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    stepCount: steps.length,
    finishAttempts: finishRows.length,
    runDir,
    finalResult: finalText,
  };
}

async function startScenarioWithRetry(goal) {
  let lastErr = null;
  for (let attempt = 1; attempt <= START_RETRY_MAX; attempt += 1) {
    try {
      await postAction("start", goal);
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!msg.includes("Already running")) throw e;

      const state = await getState().catch(() => null);
      if (state?.status === "paused") {
        await postAction("stop").catch(() => null);
      }
      console.log(`[e2e] start retry ${attempt}/${START_RETRY_MAX}: waiting for previous run to release`);
      await sleep(Math.min(3000, 500 + attempt * 120));
    }
  }
  throw lastErr || new Error("Unable to start scenario");
}

async function runScenario(scenarioName, scenario) {
  console.log(`[e2e] baseUrl=${BASE_URL}`);
  console.log(`[e2e] scenario=${scenarioName}`);
  console.log(`[e2e] goal=${scenario.goal}`);
  const startedAtMs = Date.now();
  await startScenarioWithRetry(scenario.goal);
  const terminal = await waitForTerminal(DEFAULT_TIMEOUT_SEC, !!scenario.forbidPause);

  if (terminal.terminal === "paused") {
    return {
      ok: false,
      reason: "paused_for_intervention",
      runDir: terminal.state.runDir,
      intervention: terminal.state.intervention,
      state: terminal.state,
    };
  }
  if (terminal.terminal === "error") {
    return {
      ok: false,
      reason: "agent_error",
      runDir: terminal.state.runDir,
      lastError: terminal.state.lastError,
      state: terminal.state,
    };
  }
  if (terminal.terminal === "stopped") {
    return {
      ok: false,
      reason: "stopped_by_user",
      runDir: terminal.state.runDir,
      state: terminal.state,
    };
  }

  const validated = await validateRunArtifacts(terminal.state.runDir, scenario, terminal.state);
  return {
    ...validated,
    elapsedMs: Date.now() - startedAtMs,
    state: {
      status: terminal.state.status,
      step: terminal.state.step,
      runDir: terminal.state.runDir,
      lastError: terminal.state.lastError,
    },
  };
}

function usage() {
  console.log("Usage:");
  console.log("  node scripts/agent-e2e.js list");
  console.log("  node scripts/agent-e2e.js run <scenario_name>");
  console.log("  node scripts/agent-e2e.js run --goal \"custom goal\"");
  console.log("  node scripts/agent-e2e.js run-all [scenario_name ...] [--include-manual]");
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(1);
  }

  if (cmd === "list") {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      console.log(`${name}: ${scenario.description} [${scenario.manual ? "manual" : "auto"}]`);
    }
    return;
  }

  if (cmd === "run-all") {
    const includeManual = args.includes("--include-manual");
    const requested = args.slice(1).filter((a) => !a.startsWith("--"));
    const names = requested.length
      ? requested
      : Object.keys(SCENARIOS).filter((name) => includeManual || !SCENARIOS[name].manual);
    if (!names.length) {
      throw new Error("No scenarios selected for run-all");
    }

    const startedAt = new Date().toISOString();
    const results = [];
    for (const name of names) {
      const scenario = SCENARIOS[name];
      if (!scenario) throw new Error(`Unknown scenario: ${name}`);
      if (scenario.manual && !includeManual && !requested.length) continue;

      console.log(`[e2e] run-all starting ${name}`);
      const r = await runScenario(name, scenario);
      results.push({ scenario: name, ...r });
      if (!r.ok) {
        console.log(`[e2e] run-all scenario failed: ${name}`);
      }
    }

    const summary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      includeManual,
      selectedScenarios: names,
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
    const reportPath = await saveBatchReport(summary);
    console.log("[e2e] run-all summary");
    console.log(JSON.stringify({ ...summary, reportPath }, null, 2));
    process.exit(summary.failed === 0 ? 0 : 2);
    return;
  }

  if (cmd !== "run") {
    usage();
    process.exit(1);
  }

  let scenarioName = args[1];
  let scenario = null;

  if (scenarioName === "--goal") {
    const goal = args.slice(2).join(" ").trim();
    if (!goal) throw new Error("Missing custom goal text");
    scenarioName = "custom_goal";
    scenario = {
      description: "custom",
      goal,
      forbidPause: false,
      minSteps: 1,
      expectFinalIncludesAny: [],
      expectRegex: [],
    };
  } else {
    scenario = SCENARIOS[scenarioName];
    if (!scenario) throw new Error(`Unknown scenario: ${scenarioName}`);
  }

  const result = await runScenario(scenarioName, scenario);
  console.log("[e2e] result");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((e) => {
  console.error(`[e2e] failed: ${e.message}`);
  process.exit(1);
});
