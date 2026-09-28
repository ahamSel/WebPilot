/**
 * Compares the LLM-only agent with fast mode (Jev) on the same tasks.
 *
 * Usage:
 *   npm run bench:fast-mode                    # every task, both modes, once
 *   npm run bench:fast-mode -- --repeat 3      # repeat each task/mode pair
 *   npm run bench:fast-mode -- --only mosaic,voyager --modes fast
 *
 * Needs OPENROUTER_API_KEY (fast mode reaches Jev through OpenRouter) and a
 * Playwright Chromium (`npm run browsers:install`). Runs headless and writes
 * JSON + Markdown reports to e2e_reports/. Each task costs a few cents at most.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getAgentState, requestStop, startAgent } from "../lib/agent";

interface BenchTask {
    id: string;
    goal: string;
    /** Every pattern must match the final answer. */
    expect: RegExp[];
}

type Mode = "llm" | "fast";

interface BenchResult {
    task: string;
    mode: Mode;
    run: number;
    passed: boolean;
    status: string;
    wallClockMs: number;
    steps: number;
    llmCalls: number;
    llmMs: number;
    jevCalls: number;
    jevMs: number;
    fastModeOutcome: "done" | "handoff" | "not used";
    handoffReason?: string;
    finalResult: string;
    error?: string;
}

const TASKS: BenchTask[] = [
    {
        id: "example",
        goal: "Go to https://example.com and tell me the page heading.",
        expect: [/Example Domain/i],
    },
    {
        id: "mosaic",
        goal: "Go to https://en.wikipedia.org/wiki/Web_browser and click the link to the Mosaic browser article, then tell me the year Mosaic was released.",
        expect: [/\b1993\b/],
    },
    {
        id: "voyager",
        goal: "Search Wikipedia for the Voyager 1 article and tell me its launch date.",
        expect: [/September 5,? 1977|5 September 1977/i],
    },
    {
        id: "lovelace",
        goal: "Go to https://en.wikipedia.org, use the search box to find Ada Lovelace, and tell me the year she was born.",
        expect: [/\b1815\b/],
    },
    {
        id: "openai_founding",
        goal: "Go to https://en.wikipedia.org/wiki/OpenAI and return the founding year and headquarters city.",
        expect: [/\b2015\b/, /San Francisco/i],
    },
    {
        id: "altman_drilldown",
        goal: "Go to https://en.wikipedia.org/wiki/OpenAI, then open Sam Altman's article and tell me his birth year.",
        expect: [/\b1985\b/],
    },
    {
        id: "apollo11",
        goal: "Go to https://en.wikipedia.org/wiki/Apollo_11 and tell me who the mission commander was.",
        expect: [/Armstrong/i],
    },
    {
        id: "mdn_map",
        goal: "Go to https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array and open the page for the map() method, then tell me what map() returns.",
        expect: [/new array/i],
    },
];

const RUN_TIMEOUT_MS = Number(process.env.BENCH_RUN_TIMEOUT_MS || 240_000);

function parseArgs() {
    const args = process.argv.slice(2);
    const value = (flag: string) => {
        const index = args.indexOf(flag);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const only = value("--only")?.split(",").map((item) => item.trim()).filter(Boolean);
    const modes = (value("--modes")?.split(",") || ["llm", "fast"]).filter((mode): mode is Mode => mode === "llm" || mode === "fast");
    return {
        repeat: Math.max(1, Number(value("--repeat") || 1)),
        tasks: only?.length ? TASKS.filter((task) => only.includes(task.id)) : TASKS,
        modes,
        model: value("--model"),
    };
}

async function waitForRun(): Promise<boolean> {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const status = getAgentState().status;
        if (status !== "running" && status !== "stopping" && status !== "paused") return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    requestStop();
    for (let i = 0; i < 40 && getAgentState().status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
}

async function runOnce(task: BenchTask, mode: Mode, run: number, model?: string): Promise<BenchResult> {
    await startAgent(task.goal, {
        provider: "openrouter",
        ...(model ? { navModel: model, reviewModel: model } : {}),
        synthEnabled: false,
        fastMode: mode === "fast",
        browser: { mode: "managed", headless: true },
    });
    const finished = await waitForRun();
    // Let the run's finally block write the performance summary.
    for (let i = 0; i < 20 && !getAgentState().performance; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const state = getAgentState();
    const performance = state.performance;
    const logs = state.logs;
    const handoff = logs.find((entry) => entry.action === "fast_mode_handoff");
    const done = logs.some((entry) => entry.action === "fast_mode_done");
    const finalResult = String(state.finalResult || "");
    const passed = finished && state.status === "done" && task.expect.every((pattern) => pattern.test(finalResult));

    return {
        task: task.id,
        mode,
        run,
        passed,
        status: finished ? state.status : "timeout",
        wallClockMs: performance?.wallClockMs ?? 0,
        steps: state.step,
        llmCalls: performance?.llmCallCount ?? 0,
        llmMs: performance?.llmDurationMs ?? 0,
        jevCalls: performance?.jevCallCount ?? 0,
        jevMs: performance?.jevDurationMs ?? 0,
        fastModeOutcome: done ? "done" : handoff ? "handoff" : "not used",
        handoffReason: handoff ? String((handoff.details as { reason?: unknown })?.reason || "") : undefined,
        finalResult: finalResult.slice(0, 500),
        error: state.lastError || undefined,
    };
}

function median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function markdownReport(results: BenchResult[], modes: Mode[]): string {
    const lines: string[] = [];
    lines.push("| Task | Mode | Pass | Median time | Steps | LLM calls | Jev calls | Fast mode |");
    lines.push("|---|---|---|---|---|---|---|---|");
    const taskIds = [...new Set(results.map((result) => result.task))];
    for (const taskId of taskIds) {
        for (const mode of modes) {
            const rows = results.filter((result) => result.task === taskId && result.mode === mode);
            if (!rows.length) continue;
            const passes = rows.filter((row) => row.passed).length;
            const fastOutcome = mode === "fast"
                ? rows.map((row) => row.fastModeOutcome === "handoff" ? `handoff (${row.handoffReason})` : row.fastModeOutcome).join("; ")
                : "";
            lines.push(`| ${taskId} | ${mode} | ${passes}/${rows.length} | ${seconds(median(rows.map((row) => row.wallClockMs)))} | ${median(rows.map((row) => row.steps))} | ${median(rows.map((row) => row.llmCalls))} | ${median(rows.map((row) => row.jevCalls))} | ${fastOutcome} |`);
        }
    }
    lines.push("");
    for (const mode of modes) {
        const rows = results.filter((result) => result.mode === mode);
        if (!rows.length) continue;
        lines.push(`**${mode}**: ${rows.filter((row) => row.passed).length}/${rows.length} passed, median ${seconds(median(rows.map((row) => row.wallClockMs)))}, total ${seconds(rows.reduce((sum, row) => sum + row.wallClockMs, 0))}`);
    }
    return lines.join("\n");
}

async function main() {
    if (!process.env.OPENROUTER_API_KEY && !process.env.MODEL_API_KEY) {
        throw new Error("Set OPENROUTER_API_KEY to run the benchmark.");
    }
    const options = parseArgs();
    const results: BenchResult[] = [];

    for (let run = 1; run <= options.repeat; run++) {
        for (const task of options.tasks) {
            for (const mode of options.modes) {
                process.stdout.write(`[bench] ${task.id} · ${mode} · run ${run} ... `);
                let result: BenchResult;
                try {
                    result = await runOnce(task, mode, run, options.model);
                } catch (error) {
                    result = {
                        task: task.id, mode, run, passed: false, status: "error", wallClockMs: 0, steps: 0,
                        llmCalls: 0, llmMs: 0, jevCalls: 0, jevMs: 0, fastModeOutcome: "not used", finalResult: "",
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
                results.push(result);
                console.log(`${result.passed ? "PASS" : "FAIL"} ${seconds(result.wallClockMs)} (${result.status}, llm ${result.llmCalls}, jev ${result.jevCalls}${result.fastModeOutcome === "handoff" ? `, handoff: ${result.handoffReason}` : ""})`);
            }
        }
    }

    const reportDir = process.env.E2E_REPORT_DIR || path.join(process.cwd(), "e2e_reports");
    await fs.mkdir(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const markdown = markdownReport(results, options.modes);
    await fs.writeFile(path.join(reportDir, `bench-fast-mode-${stamp}.json`), JSON.stringify(results, null, 2));
    await fs.writeFile(path.join(reportDir, `bench-fast-mode-${stamp}.md`), `${markdown}\n`);
    console.log(`\n${markdown}\n\nReports written to ${reportDir}`);
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
