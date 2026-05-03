import { Type } from "@google/genai";
import { SubAgent } from "./sub-agent";
import { createCoordinationBus } from "./coordination-bus";
import { looksLikeLoginOrSecurityBlock } from "./security-detect";
import {
    initPlaywrightMcp,
    closePlaywrightMcp,
    callMcpTool,
    mcpText,
    parseSnapshot,
    buildNormalizedSnapshot,
    extractEvidence,
    extractPageText,
    isInitialized,
    type NormalizedSnapshot,
} from "./playwright-mcp-driver";
import { startRunRecorder, recordStep, finalizeRun, saveTextArtifact, RunContext } from "./recorder";
import {
    createModelClient,
    getRuntimeModelSummary,
    hasRuntimeCredentials,
    resolveRuntimeModelConfig,
    type RuntimeModelConfig,
    type RuntimeModelOverrides,
    type ToolDeclaration,
    type ToolResponsePart,
} from "./model-client";
import {
    browserRuntimeKey,
    sanitizeBrowserRuntimeSettings,
    type BrowserRuntimeSettings,
} from "./browser-runtime";
import { buildThreadContext, ensureThread, updateThreadOnRunFinish, updateThreadOnRunStart } from "./threads";

// Env vars
const DEFAULT_CDP_HTTP = "http://127.0.0.1:9222";
const CDP_HTTP = process.env.CDP_HTTP || DEFAULT_CDP_HTTP;
const BROWSER_HEADLESS = (process.env.BROWSER_HEADLESS ?? "false") === "true";
const MAX_STEPS = Number(process.env.MAX_STEPS || 160);
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const CAPTURE_ARTIFACTS = (process.env.CAPTURE_ARTIFACTS ?? "1") === "1";

// ============================================================================
// LOGGING INFRASTRUCTURE
// ============================================================================

export interface LogEntry {
    timestamp: string;
    level: "debug" | "info" | "warn" | "error";
    action: string;
    details?: any;
    duration?: number;
}

const MAX_LOGS = 100;

// ============================================================================
// AGENT STATE
// ============================================================================

export interface PerformanceSummary {
    wallClockMs: number;
    totalSteps: number;
    llmCallCount: number;
    llmDurationMs: number;
    initialPlannerCalls: number;
    loopPlannerCalls: number;
    synthCallCount: number;
    synthDurationMs: number;
    coordinatorCallCount: number;
    coordinatorDurationMs: number;
}

export interface AgentState {
    status: "idle" | "running" | "paused" | "stopping" | "done" | "stopped" | "error";
    step: number;
    currentGoal: string;
    lastAction: string;
    lastError: string;
    finalResult: string;
    intervention: string;
    startedAt: string | null;
    finishedAt: string | null;
    stopRequested: boolean;
    pauseRequested: boolean;
    runDir: string;
    logs: LogEntry[];
    threadId: string | null;
    threadTitle: string | null;
    runtime: ReturnType<typeof getRuntimeModelSummary> | null;
    performance: PerformanceSummary | null;
}

export const state: AgentState = {
    status: "idle",
    step: 0,
    currentGoal: "",
    lastAction: "",
    lastError: "",
    finalResult: "",
    intervention: "",
    startedAt: null,
    finishedAt: null,
    stopRequested: false,
    pauseRequested: false,
    runDir: "",
    logs: [],
    threadId: null,
    threadTitle: null,
    runtime: null,
    performance: null,
};

/** Multiple agents can be paused simultaneously — resume unblocks all of them */
const pauseResolvers: Array<(value?: unknown) => void> = [];
let runningPromise: Promise<void> | null = null;
let runCtx: RunContext & { exports?: any[]; pauses?: any[]; urls?: Set<string>; heals?: any[] } | null = null;
let activeBrowserRuntimeKey = "";

// Track the latest page URL from snapshots (since we no longer have a direct page ref)
let lastKnownUrl: string = "";

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function nowIso() {
    return new Date().toISOString();
}

function shortErr(e: any): string {
    const msg = e?.message || String(e);
    return msg.length > 600 ? msg.slice(0, 600) + "…" : msg;
}

function extractExplicitUrls(goal: string): string[] {
    return Array.from(String(goal || "").matchAll(/https?:\/\/[^\s"'`<>]+/gi))
        .map((match) => match[0])
        .filter(Boolean);
}

function extractJsonObject(text: string): string | null {
    return text.match(/\{[\s\S]*\}/)?.[0] || null;
}

// Timeout wrapper for async operations
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId!);
        return result;
    } catch (e) {
        clearTimeout(timeoutId!);
        throw e;
    }
}

function log(level: LogEntry["level"], action: string, details?: any, duration?: number) {
    const entry: LogEntry = {
        timestamp: nowIso(),
        level,
        action,
        details: details !== undefined ? details : undefined,
        duration,
    };
    state.logs.push(entry);
    // Keep logs capped
    if (state.logs.length > MAX_LOGS) {
        state.logs = state.logs.slice(-MAX_LOGS);
    }
    // Console log for server-side debugging
    const prefix = `[${level.toUpperCase()}]`;
    const durationStr = duration ? ` (${duration}ms)` : "";
    console.log(`${prefix} ${action}${durationStr}`, details || "");
}

function logDurationMs(entry: LogEntry): number {
    if (typeof entry.duration === "number" && Number.isFinite(entry.duration)) return entry.duration;
    const detailsDuration = Number((entry.details as { durationMs?: unknown } | undefined)?.durationMs);
    return Number.isFinite(detailsDuration) ? detailsDuration : 0;
}

function buildPerformanceSummary(logs: LogEntry[], stepCount: number, wallClockMs: number): PerformanceSummary {
    const routeActions = new Set(["request_route_complete", "request_route_failed"]);
    const initialPlannerActions = new Set(["model_call_complete", "model_call_failed"]);
    const loopPlannerActions = new Set(["model_loop_call_complete", "model_loop_call_failed"]);
    const synthActions = new Set(["synth_complete", "synth_empty_fallback_to_flash", "coordinator_synth_complete"]);
    const coordinatorActions = new Set(["coordinator_split_response", "coordinator_synth_complete", "coordinator_synth_failed"]);

    let llmCallCount = 0;
    let llmDurationMs = 0;
    let initialPlannerCalls = 0;
    let loopPlannerCalls = 0;
    let synthCallCount = 0;
    let synthDurationMs = 0;
    let coordinatorCallCount = 0;
    let coordinatorDurationMs = 0;

    for (const entry of logs) {
        const durationMs = logDurationMs(entry);
        if (routeActions.has(entry.action)) {
            llmCallCount += 1;
            llmDurationMs += durationMs;
            continue;
        }
        if (initialPlannerActions.has(entry.action)) {
            llmCallCount += 1;
            initialPlannerCalls += 1;
            llmDurationMs += durationMs;
            continue;
        }
        if (loopPlannerActions.has(entry.action)) {
            llmCallCount += 1;
            loopPlannerCalls += 1;
            llmDurationMs += durationMs;
            continue;
        }
        if (synthActions.has(entry.action)) {
            synthCallCount += 1;
            synthDurationMs += durationMs;
        }
        if (coordinatorActions.has(entry.action)) {
            coordinatorCallCount += 1;
            coordinatorDurationMs += durationMs;
        }
    }

    return {
        wallClockMs: Math.max(0, wallClockMs),
        totalSteps: stepCount,
        llmCallCount,
        llmDurationMs,
        initialPlannerCalls,
        loopPlannerCalls,
        synthCallCount,
        synthDurationMs,
        coordinatorCallCount,
        coordinatorDurationMs,
    };
}

async function startRunLogging({
    goal,
    model,
    threadId,
    threadTitle,
    plannerContext,
    threadTurn,
}: {
    goal: string;
    model: string;
    threadId?: string | null;
    threadTitle?: string | null;
    plannerContext?: string;
    threadTurn?: number;
}) {
    const ctx = await startRunRecorder(goal, model, {
        threadId: threadId || undefined,
        threadTitle: threadTitle || undefined,
        userGoal: goal,
        plannerContext,
        threadTurn,
    });
    state.runDir = ctx.runDir;
    runCtx = { ...ctx, exports: [], pauses: [], urls: new Set(), heals: [] };
    log("info", "run_started", { goal, model, runId: ctx.runId });
    if (threadId) {
        await updateThreadOnRunStart(threadId, {
            runId: ctx.runId,
            userGoal: goal,
        });
    }
    return runCtx;
}

function formatPlannerThreadContext(contextText: string) {
    const trimmed = String(contextText || "").trim();
    if (!trimmed) return "";
    return `Previous thread context:\n${trimmed}\n\nUse it only when it helps interpret the current request. Prefer live browser state over past answers.`;
}

// ============================================================================
// PLAYWRIGHT MCP CONNECTION + AUTO-LAUNCH
// ============================================================================

async function tryGetCdpWs(endpoint = CDP_HTTP): Promise<string | null> {
    if (/^wss?:\/\//i.test(endpoint)) return endpoint;
    try {
        const res = await fetch(`${endpoint.replace(/\/+$/, "")}/json/version`, { method: "GET" });
        if (!res.ok) return null;
        const version = await res.json();
        return version.webSocketDebuggerUrl || null;
    } catch {
        return null;
    }
}

async function ensureMcpReady(browserSettings: BrowserRuntimeSettings) {
    const nextBrowserRuntimeKey = browserRuntimeKey(browserSettings);
    if (isInitialized() && activeBrowserRuntimeKey === nextBrowserRuntimeKey) return;
    if (isInitialized()) {
        log("info", "mcp_restarting_for_browser_change", {
            browser: browserSettings.mode,
            channel: browserSettings.channel || undefined,
            browserName: browserSettings.browserName,
        });
        await closePlaywrightMcp();
        activeBrowserRuntimeKey = "";
    }
    log("info", "mcp_connecting");

    if (browserSettings.mode === "cdp") {
        const endpoint = browserSettings.cdpEndpoint || CDP_HTTP;
        const ws = await tryGetCdpWs(endpoint);
        log("info", "mcp_cdp_connecting", { endpoint, ws: ws || endpoint });
        await initPlaywrightMcp({ cdpEndpoint: ws || endpoint });
    } else {
        log("info", "mcp_auto_launching", {
            browserName: browserSettings.browserName,
            channel: browserSettings.channel || undefined,
            mode: browserSettings.mode,
            headless: browserSettings.headless || BROWSER_HEADLESS,
        });
        await initPlaywrightMcp({
            browserName: browserSettings.browserName,
            headless: browserSettings.headless || BROWSER_HEADLESS,
            channel: browserSettings.mode === "channel" ? browserSettings.channel : "",
            userDataDir: browserSettings.userDataDir,
            executablePath: browserSettings.mode === "custom" ? browserSettings.executablePath : "",
            isolated: browserSettings.isolated,
        });
    }
    activeBrowserRuntimeKey = nextBrowserRuntimeKey;
    log("info", "mcp_connected");
}

// ============================================================================
// CONTROL FLOW
// ============================================================================

// Custom error class for user-requested stops (not actual errors)
class StopRequestedError extends Error {
    constructor() {
        super("Stopped by user.");
        this.name = "StopRequestedError";
    }
}

async function checkStopOrPause() {
    if (state.stopRequested) {
        state.status = "stopping";
        throw new StopRequestedError();
    }
    if (state.pauseRequested) {
        state.status = "paused";
        log("info", "agent_paused", { intervention: state.intervention });
        await new Promise((resolve) => pauseResolvers.push(resolve));
        state.status = "running";
        log("info", "agent_resumed");
    }
    if (state.stopRequested) {
        state.status = "stopping";
        throw new StopRequestedError();
    }
}

// ============================================================================
// CONTROL EXPORTS
// ============================================================================

// Pause the agent and wait for user to resume or stop
// Returns true if resumed, false if stopped
export async function requestPauseAndWait(message = "Paused for user intervention."): Promise<boolean> {
    state.pauseRequested = true;
    // Append to intervention message if multiple agents are blocked
    state.intervention = state.intervention
        ? `${state.intervention}\n${message}`
        : message;
    state.status = "paused";
    log("warn", "pause_requested", { message });

    // Wait for resume or stop — multiple agents can wait simultaneously
    await new Promise((resolve) => pauseResolvers.push(resolve));

    // Check if it was a stop request
    if (state.stopRequested) {
        log("info", "stop_during_pause");
        return false; // stopped
    }

    // Only clear pause state if no other agents are still waiting
    if (pauseResolvers.length === 0) {
        state.status = "running";
        state.pauseRequested = false;
        state.intervention = "";
    }
    log("info", "agent_resumed");
    return true; // resumed
}

// Legacy sync version for backward compatibility (just sets flag)
export function requestPause(message = "Paused for user intervention.") {
    state.pauseRequested = true;
    state.intervention = message;
    log("warn", "pause_requested", { message });
}

export function resumeFromPause() {
    state.pauseRequested = false;
    state.intervention = "";
    // Resume ALL waiting agents (main + any sub-agents)
    const resolvers = pauseResolvers.splice(0);
    for (const resolve of resolvers) resolve();
}

export function requestStop() {
    state.stopRequested = true;
    // Don't clear pauseRequested here - let the pause handler check stopRequested
    state.intervention = "";
    log("info", "stop_requested");
    // Unblock ALL waiting agents so they can check stopRequested
    const resolvers = pauseResolvers.splice(0);
    for (const resolve of resolvers) resolve();
}

// ============================================================================
// PARALLEL EXECUTION COORDINATOR
// ============================================================================

interface ParallelResult {
    result: string;
    totalSteps: number;
    runDirs: string[];
}

interface RequestRouteDecision {
    mode: "chat" | "browse";
    assistantReply: string;
    reason: string;
    browserGoal: string;
}

interface FinishReviewDecision {
    accept: boolean;
    reason: string;
    retryInstruction: string;
}

async function routeUserRequest(
    goal: string,
    modelConfig: RuntimeModelConfig,
    plannerContext: string = ""
): Promise<RequestRouteDecision> {
    const fallback: RequestRouteDecision = {
        mode: "browse",
        assistantReply: "",
        reason: "Router unavailable; using browser agent.",
        browserGoal: goal,
    };

    if (!hasRuntimeCredentials(modelConfig)) return fallback;

    const modelClient = createModelClient(modelConfig);
    log("info", "request_route_starting", { model: modelConfig.navModel });
    const routeStart = Date.now();

    let routeText = "";
    try {
        routeText = await withTimeout(
            modelClient.generateText({
                model: modelConfig.navModel,
                systemInstruction: (
                    "You are the first routing phase for an agentic browser. Decide whether the current "
                    + "user message should be answered directly inside the app or handled by browser "
                    + "automation. Infer intent from the full message and conversation context. Do not rely "
                    + "on surface keywords alone. Return JSON only."
                ),
                prompt: `Route the current WebPilot request.

Current user message:
${goal}

${plannerContext ? `Conversation context:\n${plannerContext}\n\n` : ""}Decision:
- Use mode "chat" when the user is conversing with WebPilot, testing the app, asking for clarification, or when no live browser/page action is needed.
- Use mode "browse" only when the request needs browser automation, live web/page state, navigation, form filling, clicking, extraction, comparison across websites, or interaction with a selected browser/profile.
- If mode is "chat", write assistant_reply as the complete response to show the user.
- If mode is "browse", write browser_goal as the task for the browser agent. Preserve the user's meaning without inventing extra search intent.

Respond with ONLY valid JSON:
{"mode": "chat|browse", "assistant_reply": "complete reply when mode is chat", "browser_goal": "browser task when mode is browse", "reason": "short routing reason"}`,
                thinkingBudget: 512,
            }),
            modelConfig.timeoutMs,
            "Request routing call"
        );
    } catch (e: any) {
        log("warn", "request_route_failed", { error: shortErr(e), durationMs: Date.now() - routeStart });
        return fallback;
    }

    log("info", "request_route_complete", { durationMs: Date.now() - routeStart, response: routeText.slice(0, 300) });

    const jsonText = extractJsonObject(routeText);
    if (!jsonText) return fallback;

    try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        const mode = parsed.mode === "chat" ? "chat" : "browse";
        const assistantReply = typeof parsed.assistant_reply === "string" ? parsed.assistant_reply.trim() : "";
        const browserGoal = typeof parsed.browser_goal === "string" && parsed.browser_goal.trim()
            ? parsed.browser_goal.trim()
            : goal;
        const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";

        if (mode === "chat" && !assistantReply) return fallback;

        return {
            mode,
            assistantReply,
            browserGoal,
            reason,
        };
    } catch {
        return fallback;
    }
}

async function reviewFinishResult(
    goal: string,
    result: string,
    snapshot: NormalizedSnapshot | null,
    modelConfig: RuntimeModelConfig,
    plannerContext: string = ""
): Promise<FinishReviewDecision> {
    if (!hasRuntimeCredentials(modelConfig)) {
        return { accept: true, reason: "No runtime credentials available for review.", retryInstruction: "" };
    }

    const modelClient = createModelClient(modelConfig);
    const snapshotContext = snapshot
        ? {
            url: snapshot.url,
            title: snapshot.title,
            evidence: snapshot.evidence,
            pageTextExcerpt: String(snapshot.text || "").slice(0, 15000),
        }
        : null;

    log("info", "finish_review_starting", { model: modelConfig.reviewModel });
    const reviewStart = Date.now();

    let reviewText = "";
    try {
        reviewText = await withTimeout(
            modelClient.generateText({
                model: modelConfig.reviewModel,
                systemInstruction: (
                    "You are a browser-agent completion reviewer. Decide whether the proposed final answer "
                    + "should be accepted or sent back to the browsing agent. Infer task requirements from the "
                    + "full user goal, conversation context, proposed answer, and observed page context. "
                    + "Do not rely on surface keywords alone. Return JSON only."
                ),
                prompt: `Review this proposed browser-agent completion.

User goal:
${goal}

${plannerContext ? `Conversation context:\n${plannerContext}\n\n` : ""}Proposed final answer:
${result}

Latest observed browser context:
${JSON.stringify(snapshotContext, null, 2)}

Decision rules:
- Accept if the answer satisfies the user goal or if no browser evidence is required.
- Reject only when the answer is unsupported by observed browser context, speculative, missing an action the user requested, or should clearly gather more page evidence first.
- If rejecting, write retry_instruction as a concrete instruction for the browsing agent's next step.

Respond with ONLY valid JSON:
{"accept": true/false, "reason": "short reason", "retry_instruction": "instruction for the browsing agent if rejected"}`,
                thinkingBudget: 1024,
            }),
            modelConfig.timeoutMs,
            "Finish review call"
        );
    } catch (e: any) {
        log("warn", "finish_review_failed", { error: shortErr(e) });
        return { accept: true, reason: "Finish review failed; accepting planner result.", retryInstruction: "" };
    }

    log("info", "finish_review_complete", { durationMs: Date.now() - reviewStart, response: reviewText.slice(0, 300) });

    const jsonText = extractJsonObject(reviewText);
    if (!jsonText) {
        log("warn", "finish_review_parse_failed", { text: reviewText.slice(0, 200) });
        return { accept: true, reason: "Finish review did not return JSON; accepting planner result.", retryInstruction: "" };
    }

    try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        const accept = typeof parsed.accept === "boolean"
            ? parsed.accept
            : String(parsed.accept).trim().toLowerCase() !== "false";
        const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
        const retryInstruction = typeof parsed.retry_instruction === "string"
            ? parsed.retry_instruction.trim()
            : "";

        return {
            accept,
            reason,
            retryInstruction,
        };
    } catch {
        log("warn", "finish_review_parse_failed", { text: reviewText.slice(0, 200) });
        return { accept: true, reason: "Finish review JSON was invalid; accepting planner result.", retryInstruction: "" };
    }
}

async function tryParallelExecution(
    goal: string,
    parentRunCtx: RunContext & { exports?: any[]; pauses?: any[]; urls?: Set<string>; heals?: any[] },
    modelConfig: RuntimeModelConfig,
    plannerContext: string = "",
    browserSettings: BrowserRuntimeSettings = sanitizeBrowserRuntimeSettings(null)
): Promise<ParallelResult | null> {
    if (!hasRuntimeCredentials(modelConfig)) return null;

    const modelClient = createModelClient(modelConfig);

    // Ask the selected navigation model to decide whether the task should split.
    log("info", "coordinator_analyzing", { goal: goal.slice(0, 100) });
    const splitStart = Date.now();

    let splitText = "";
    try {
        splitText = await withTimeout(
            modelClient.generateText({
                model: modelConfig.navModel,
                prompt: `Analyze this user goal and determine if it contains independent sub-tasks that can be done in parallel on different websites.

Goal: "${goal}"

${plannerContext ? `${plannerContext}\n\n` : ""}Rules:

- Only split if there are clearly INDEPENDENT tasks targeting DIFFERENT websites/sources.
- Each sub-task must be self-contained (can be completed without results from other sub-tasks).
- Do NOT split single-site tasks or tasks where steps depend on each other.
- Maximum 4 sub-tasks.

Respond with ONLY valid JSON, no markdown:
{"parallel": true/false, "tasks": [{"goal": "sub-task description", "site": "expected website"}]}

Examples:
- "find tents on kijiji and camping gear on walmart" → {"parallel": true, "tasks": [{"goal": "Go to kijiji.ca and find tents for camping", "site": "kijiji.ca"}, {"goal": "Go to walmart.ca and find camping gear", "site": "walmart.ca"}]}
- "search wikipedia for Voyager 1" → {"parallel": false, "tasks": [{"goal": "search wikipedia for Voyager 1", "site": "wikipedia.org"}]}
- "go to amazon, find a laptop, then check reviews on reddit" → {"parallel": false, "tasks": [{"goal": "go to amazon, find a laptop, then check reviews on reddit", "site": "amazon.com"}]}

IMPORTANT: When the user mentions specific websites, ALWAYS include those site names in the sub-task goal (e.g. "Go to kijiji.ca and find..." not just "find..."). The sub-agents navigate to the sites mentioned in their goals.`,
            }),
            modelConfig.timeoutMs,
            "Coordinator split analysis"
        );
    } catch (e: any) {
        log("debug", "coordinator_split_failed", { error: shortErr(e) });
        return null; // Fall back to sequential
    }

    log("info", "coordinator_split_response", { durationMs: Date.now() - splitStart, response: splitText.slice(0, 300) });

    // Parse the JSON response
    let splitData: { parallel: boolean; tasks: Array<{ goal: string; site: string }> };
    try {
        const jsonText = extractJsonObject(splitText);
        if (!jsonText) return null;
        splitData = JSON.parse(jsonText);
    } catch {
        log("warn", "coordinator_split_parse_failed", { text: splitText.slice(0, 200) });
        return null;
    }

    if (!splitData.parallel || !splitData.tasks || splitData.tasks.length < 2) {
        log("info", "coordinator_not_parallel", { reason: "single task or not parallelizable" });
        return null;
    }

    // ================================================================
    // PARALLEL EXECUTION
    // ================================================================
    const tasks = splitData.tasks.slice(0, 4);
    log("info", "coordinator_parallel_start", {
        taskCount: tasks.length,
        tasks: tasks.map(t => ({ goal: t.goal.slice(0, 60), site: t.site })),
    });

    // Create coordination bus for inter-agent communication
    const bus = createCoordinationBus();
    bus.onProgress((update) => {
        if (update.status === "done" || update.status === "error") {
            log("info", "coordinator_subagent_finished", {
                label: update.label,
                site: update.site,
                status: update.status,
                steps: update.step,
            });
        }
    });

    // Spawn sub-agents — each gets its own independent browser + coordination bus
    const subAgents = tasks.map((task, i) => new SubAgent({
        goal: task.goal,
        runtime: modelConfig,
        label: `sub-${i}`,
        headless: browserSettings.headless || BROWSER_HEADLESS,
        browser: browserSettings,
        coordinationBus: bus,
        site: task.site,
        onSecurityBlock: (message) => requestPauseAndWait(message),
    }));

    // Run all sub-agents in parallel!
    const subResults = await Promise.all(
        subAgents.map((agent) => {
            state.lastAction = `parallel: ${tasks.length} sub-agents running`;
            return agent.run().catch(e => ({
                ok: false,
                result: "",
                pageSummaries: [] as Array<{ url: string; title: string; textSnippet: string }>,
                runDir: "",
                steps: 0,
                durationMs: 0,
                browserInstanceId: "",
                error: shortErr(e),
            }));
        })
    );

    // Clean up coordination bus
    bus.destroy();

    // If ALL sub-agents failed, fall back to sequential
    const allFailed = subResults.every(r => !r.ok);
    if (allFailed) {
        log("warn", "coordinator_all_subagents_failed", {
            errors: subResults.map((r, i) => ({ label: `sub-${i}`, error: r.error })),
        });
        return null; // Fall back to sequential execution
    }

    // Collect results
    const totalSteps = subResults.reduce((sum, r) => sum + r.steps, 0);
    const runDirs = subResults.filter(r => r.runDir).map(r => r.runDir);
    const allPageSummaries = subResults.flatMap(r => r.pageSummaries);
    const subResultTexts = subResults.map((r, i) => {
        const status = r.ok ? "completed" : `failed: ${r.error || "unknown"}`;
        return `--- Sub-agent ${i} (${tasks[i].site}) [${status}, ${r.steps} steps, ${r.durationMs}ms] ---\n${r.result}`;
    }).join("\n\n");

    log("info", "coordinator_parallel_complete", {
        totalSteps,
        subAgentResults: subResults.map((r, i) => ({
            label: `sub-${i}`,
            ok: r.ok,
            steps: r.steps,
            durationMs: r.durationMs,
            browserInstanceId: r.browserInstanceId,
        })),
    });

    // Save coordinator decision artifact
    if (parentRunCtx) {
        await saveTextArtifact(parentRunCtx, "parallel_execution.json", JSON.stringify({
            splitData,
            subResults: subResults.map((r, i) => ({
                label: `sub-${i}`,
                goal: tasks[i].goal,
                site: tasks[i].site,
                ok: r.ok,
                steps: r.steps,
                durationMs: r.durationMs,
                runDir: r.runDir,
                browserInstanceId: r.browserInstanceId,
                resultPreview: r.result.slice(0, 500),
            })),
        }, null, 2));
    }

    // Pro synthesis: merge all sub-agent results
    let finalResult = subResultTexts;
    if (modelConfig.synthEnabled && allPageSummaries.length > 0) {
        try {
            log("info", "coordinator_synth_starting", { model: modelConfig.synthModel, pages: allPageSummaries.length });
            const synthStart = Date.now();
            const pagesContext = allPageSummaries.map((p, i) =>
                `--- Page ${i + 1}: ${p.title} (${p.url}) ---\n${p.textSnippet}`
            ).join("\n\n");

            const synthText = await withTimeout(
                modelClient.generateText({
                model: modelConfig.synthModel,
                prompt: `The user's current request was:\n"${goal}"\n\n${plannerContext ? `${plannerContext}\n\n` : ""}Multiple browsing agents ran in parallel and produced these results:\n${subResultTexts}\n\nHere is the raw page content observed:\n${pagesContext.slice(0, 30000)}\n\nProduce a comprehensive, well-structured final answer. Include specific product names, prices, and links where available. Organize by source/site. Be concise but thorough. Do not add information that wasn't in the observed pages.`,
                    systemInstruction: "You are a research synthesizer.",
                    thinkingBudget: 2048,
                }),
                modelConfig.timeoutMs,
                "Coordinator synthesis"
            );

            if (synthText && synthText.length > 50) {
                log("info", "coordinator_synth_complete", { durationMs: Date.now() - synthStart });
                finalResult = synthText;
            }
        } catch (synthErr: any) {
            log("warn", "coordinator_synth_failed", { error: shortErr(synthErr) });
        }
    }

    return { result: finalResult, totalSteps, runDirs };
}

// ============================================================================
// MAIN AGENT RUNNER
// ============================================================================

export interface StartAgentOptions {
    threadId?: string | null;
}

export async function startAgent(goal: string, runtimeOverrides: RuntimeModelOverrides = {}, options: StartAgentOptions = {}) {
    const userGoal = String(goal || "").trim();
    if (!userGoal) throw new Error("Enter a goal before starting.");
    const modelConfig = resolveRuntimeModelConfig(runtimeOverrides);
    const browserSettings = sanitizeBrowserRuntimeSettings(runtimeOverrides.browser);
    if (!hasRuntimeCredentials(modelConfig)) {
        throw new Error(modelConfig.provider === "gemini"
            ? "Missing Google AI API key."
            : modelConfig.provider === "openai"
                ? "Missing OpenAI API key."
                : modelConfig.provider === "anthropic"
                    ? "Missing Anthropic API key."
                    : "Missing Ollama runtime configuration.");
    }
    if (state.status === "running" || runningPromise) throw new Error("Already running");

    const threadState = await ensureThread(options.threadId, userGoal);
    const threadContextSummary = await buildThreadContext(threadState.thread.threadId);
    const plannerThreadContext = formatPlannerThreadContext(threadContextSummary?.contextText || "");
    const threadTurn = (threadContextSummary?.turns.length || 0) + 1;
    const startInfo = {
        threadId: threadState.thread.threadId,
        threadTitle: threadState.thread.title,
        createdThread: threadState.created,
    };

    runningPromise = (async () => {
        try {
            // Reset state
            state.status = "running";
            state.step = 0;
            state.currentGoal = userGoal;
            state.lastError = "";
            state.finalResult = "";
            state.intervention = "";
            state.startedAt = nowIso();
            state.finishedAt = null;
            state.stopRequested = false;
            state.pauseRequested = false;
            state.logs = []; // Clear logs for new run
            state.threadId = startInfo.threadId;
            state.threadTitle = startInfo.threadTitle;
            state.runtime = getRuntimeModelSummary(modelConfig);
            state.performance = null;
            lastKnownUrl = "";

            await startRunLogging({
                goal: userGoal,
                model: modelConfig.navModel,
                threadId: startInfo.threadId,
                threadTitle: startInfo.threadTitle,
                plannerContext: plannerThreadContext || undefined,
                threadTurn,
            });
            if (runCtx && plannerThreadContext) {
                await saveTextArtifact(runCtx, "thread_context.txt", plannerThreadContext);
            }
            const routeDecision = await routeUserRequest(userGoal, modelConfig, plannerThreadContext);
            if (runCtx) {
                await saveTextArtifact(runCtx, "request_route.json", JSON.stringify({
                    routedAt: nowIso(),
                    ...routeDecision,
                }, null, 2));
            }
            log("info", "request_routed", {
                mode: routeDecision.mode,
                reason: routeDecision.reason || undefined,
            });
            if (routeDecision.mode === "chat") {
                state.finalResult = routeDecision.assistantReply;
                state.lastAction = "direct_reply";
                state.status = "done";
                return;
            }

            const agentGoal = routeDecision.browserGoal || userGoal;
            await ensureMcpReady(browserSettings);
            const explicitGoalUrls = extractExplicitUrls(agentGoal);
            const goalUrl = explicitGoalUrls[0] || "";

            // ================================================================
            // COORDINATOR: LLM decides whether goal can be parallelized
            // ================================================================
            let parallelResult: ParallelResult | null = null;
            parallelResult = await tryParallelExecution(agentGoal, runCtx!, modelConfig, plannerThreadContext, browserSettings);
            if (parallelResult) {
                // Parallel execution handled everything
                state.finalResult = parallelResult.result;
                state.step = parallelResult.totalSteps;
                state.status = "done";
                requestStop();
                return; // Skip the sequential path
            }

            let latestObservationSnapshot: NormalizedSnapshot | null = null;
            // Collect page summaries for pro synthesis at end
            const pageSummaries: Array<{ url: string; title: string; textSnippet: string }> = [];

            // --- Helper Functions ---
            const domainAllowed = (url: string) => {
                if (!ALLOWED_DOMAINS.length) return true;
                try {
                    const host = new URL(url).host;
                    return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
                } catch { return false; }
            };

            // Login/security/robot detection uses shared utility (lib/security-detect.ts)
            // looksLikeLoginOrSecurityBlock is imported at the top of this file

            // ================================================================
            // TOOL: OBSERVE (via Playwright MCP)
            // ================================================================
            const tool_observe = async ({ maxTextChars = 7000, maxElements = 80 } = {}) => {
                const startTime = Date.now();

                // Get accessibility snapshot from Playwright MCP
                const snapshotResult = await callMcpTool("browser_snapshot", {});
                const snapshotText = mcpText(snapshotResult);
                const parsed = parseSnapshot(snapshotText);

                // Get page text and evidence via browser_evaluate
                const pageText = await extractPageText(maxTextChars);
                const evidence = await extractEvidence();

                // Build compact snapshot for the planner and run artifacts.
                const snapshot = buildNormalizedSnapshot(parsed, pageText, evidence);

                // Limit elements if needed
                if (snapshot.elements.length > maxElements) {
                    snapshot.elements = snapshot.elements.slice(0, maxElements);
                }

                const duration = Date.now() - startTime;
                log("info", "observe", {
                    url: snapshot.url,
                    title: (snapshot.title || "").slice(0, 50),
                    elementCount: snapshot.elements.length
                }, duration);

                latestObservationSnapshot = snapshot;
                lastKnownUrl = snapshot.url || lastKnownUrl;

                // Collect for pro synthesis
                pageSummaries.push({
                    url: snapshot.url || "",
                    title: snapshot.title || "",
                    textSnippet: (snapshot.text || "").slice(0, 3000),
                });

                if (runCtx) {
                    await saveTextArtifact(runCtx, `step${state.step}_observe.json`, JSON.stringify(snapshot, null, 2));
                }

                return { ok: true, snapshot };
            };

            // ================================================================
            // TOOL: NAVIGATE (via Playwright MCP) — lightweight, no auto-observe
            // ================================================================
            const tool_navigate = async ({ url }: any) => {
                const startTime = Date.now();
                log("info", "navigate_start", { url });

                if (!domainAllowed(url)) {
                    log("warn", "navigate_blocked", { url, reason: "domain_not_allowed" });
                    const resumed = await requestPauseAndWait(`Navigation to ${new URL(url).host} blocked by domain allowlist. Add it to ALLOWED_DOMAINS or click Resume to skip.`);
                    if (!resumed) {
                        throw new StopRequestedError();
                    }
                    return { ok: false, skipped: true, reason: "domain_not_allowed" };
                }

                await callMcpTool("browser_navigate", { url });

                const duration = Date.now() - startTime;
                log("info", "navigate_complete", { url }, duration);

                // Lightweight login/security check — just parse snapshot title, skip full text extraction
                const snapshotResult = await callMcpTool("browser_snapshot", {});
                const snapshotText = mcpText(snapshotResult);
                const parsed = parseSnapshot(snapshotText);
                lastKnownUrl = parsed.url || url;
                const titleLower = (parsed.title || "").toLowerCase();
                const loginTitlePatterns = ["log in", "login", "sign in", "signin", "authenticate", "cas login", "sso"];
                const isSuspicious = loginTitlePatterns.some(p => titleLower.includes(p));

                if (isSuspicious) {
                    // Full check with text extraction only when title looks like login
                    const pageText = await extractPageText(3000);
                    const loginCheck = looksLikeLoginOrSecurityBlock(pageText, parsed.title, parsed.elements);
                    if (loginCheck.detected) {
                        log("warn", "login_or_security_detected", { reason: loginCheck.reason, title: parsed.title });
                        const message = loginCheck.reason === "captcha"
                            ? "CAPTCHA detected. Please solve it manually, then click Resume."
                            : `Login page detected (${parsed.title}). Please log in manually, then click Resume.`;
                        const resumed = await requestPauseAndWait(message);
                        if (!resumed) {
                            throw new StopRequestedError();
                        }
                        return { ok: true, url: lastKnownUrl, userIntervened: true };
                    }
                }

                return { ok: true, url: lastKnownUrl, title: parsed.title };
            };

            // ================================================================
            // TOOL: CLICK (via Playwright MCP) — no auto-observe
            // ================================================================
            const tool_click = async ({ ref, element }: { ref: string; element?: string }) => {
                const startTime = Date.now();
                log("info", "click_start", { ref, element });

                if (!ref) throw new Error("Click requires a ref from the latest observe snapshot");

                await callMcpTool("browser_click", { ref, element: element || "" });

                // Wait a moment for navigation/rendering
                await new Promise(r => setTimeout(r, 300));

                const duration = Date.now() - startTime;
                log("info", "click_complete", { ref, element }, duration);

                return { ok: true };
            };

            // ================================================================
            // TOOL: TYPE (via Playwright MCP) — no auto-observe
            // ================================================================
            const tool_type = async ({ ref, text, submit = false, clear = false }: {
                ref: string;
                text: string;
                submit?: boolean;
                clear?: boolean;
            }) => {
                const startTime = Date.now();
                log("info", "type_start", { ref, textLength: text.length, submit, clear });

                if (!ref) throw new Error("Type requires a ref from the latest observe snapshot");

                // Clear existing content if requested
                if (clear) {
                    log("debug", "type_clearing", { ref });
                    await callMcpTool("browser_click", { ref, element: "field to clear" });
                    await callMcpTool("browser_press_key", { key: "Control+a" });
                    await callMcpTool("browser_press_key", { key: "Backspace" });
                }

                // Type the text
                await callMcpTool("browser_type", { ref, text, submit, slowly: false });

                const duration = Date.now() - startTime;
                log("info", "type_complete", { ref, textLength: text.length }, duration);

                await new Promise(r => setTimeout(r, 300));
                return { ok: true };
            };

            // ================================================================
            // TOOL: SCROLL (via Playwright MCP browser_evaluate) — no auto-observe
            // ================================================================
            const tool_scroll = async ({
                direction = "down",
                amount = 500,
            }: {
                direction?: "up" | "down" | "left" | "right";
                amount?: number;
            }) => {
                const startTime = Date.now();
                log("info", "scroll_start", { direction, amount });

                const scrollMap: Record<string, { x: number; y: number }> = {
                    up: { x: 0, y: -amount },
                    down: { x: 0, y: amount },
                    left: { x: -amount, y: 0 },
                    right: { x: amount, y: 0 },
                };
                const { x, y } = scrollMap[direction] || scrollMap.down;

                await callMcpTool("browser_evaluate", {
                    function: `() => window.scrollBy({ left: ${x}, top: ${y}, behavior: "smooth" })`,
                });

                // Wait for scroll to complete
                await new Promise(r => setTimeout(r, 400));

                const duration = Date.now() - startTime;
                log("info", "scroll_complete", { direction, amount }, duration);

                return { ok: true };
            };

            // ================================================================
            // TOOL: WAIT (via Playwright MCP) — no auto-observe
            // ================================================================
            const tool_wait = async ({ seconds = 2 }: { seconds?: number }) => {
                log("info", "wait_start", { seconds });
                await callMcpTool("browser_wait_for", { time: seconds });
                log("info", "wait_complete", { seconds });
                return { ok: true };
            };

            // ================================================================
            // TOOL: NEW_TAB — open a new browser tab
            // ================================================================
            const tool_new_tab = async () => {
                const startTime = Date.now();
                log("info", "new_tab_start");
                const result = await callMcpTool("browser_tabs", { action: "new" });
                const text = mcpText(result);
                const duration = Date.now() - startTime;
                log("info", "new_tab_complete", { result: text.slice(0, 200) }, duration);
                return { ok: true, info: text.slice(0, 300) };
            };

            // ================================================================
            // TOOL: SWITCH_TAB — switch to a tab by index, returns URL/title
            // ================================================================
            const tool_switch_tab = async ({ index }: { index: number }) => {
                const startTime = Date.now();
                log("info", "switch_tab_start", { index });
                await callMcpTool("browser_tabs", { action: "select", index });
                // Quick snapshot to tell the LLM which page it's now on
                const snapshotResult = await callMcpTool("browser_snapshot", {});
                const snapshotText = mcpText(snapshotResult);
                const parsed = parseSnapshot(snapshotText);
                lastKnownUrl = parsed.url || lastKnownUrl;
                const duration = Date.now() - startTime;
                log("info", "switch_tab_complete", { index, url: parsed.url, title: parsed.title }, duration);
                return { ok: true, url: parsed.url, title: parsed.title };
            };

            // ================================================================
            // TOOL: LIST_TABS — list open tabs
            // ================================================================
            const tool_list_tabs = async () => {
                const result = await callMcpTool("browser_tabs", { action: "list" });
                const text = mcpText(result);
                log("info", "list_tabs", { result: text.slice(0, 300) });
                return { ok: true, tabs: text };
            };

            // ================================================================
            // TOOL: FINISH
            // ================================================================
            const tool_finish = async ({ result }: { result: string }) => {
                const review = await reviewFinishResult(
                    `Original user request:\n${userGoal}\n\nBrowser agent task:\n${agentGoal}`,
                    result,
                    latestObservationSnapshot,
                    modelConfig,
                    plannerThreadContext
                );
                if (runCtx) {
                    await saveTextArtifact(runCtx, `step${state.step}_finish_review.json`, JSON.stringify({
                        checkedAt: nowIso(),
                        resultPreview: String(result || "").slice(0, 600),
                        observationUrl: latestObservationSnapshot?.url || null,
                        ...review,
                    }, null, 2));
                }
                if (!review.accept) {
                    const msg = review.retryInstruction || review.reason || "Review rejected the final answer. Gather more evidence, then finish again.";
                    log("warn", "finish_rejected_by_review", {
                        reason: review.reason,
                        retryInstruction: review.retryInstruction,
                        resultPreview: String(result || "").slice(0, 240),
                    });
                    return { ok: false, error: msg };
                }
                log("info", "finish", { resultLength: result.length });

                // Pro synthesis: use a stronger model to produce a polished answer
                if (modelConfig.synthEnabled && pageSummaries.length > 0) {
                    try {
                        log("info", "synth_starting", { model: modelConfig.synthModel, pages: pageSummaries.length });
                        const synthStart = Date.now();
                        const synthClient = createModelClient(modelConfig);
                        const pagesContext = pageSummaries.map((p, i) =>
                            `--- Page ${i + 1}: ${p.title} (${p.url}) ---\n${p.textSnippet}`
                        ).join("\n\n");
                        const synthText = await withTimeout(
                            synthClient.generateText({
                                model: modelConfig.synthModel,
                                prompt: `The user's current request was:\n"${userGoal}"\n\nThe browser agent task was:\n"${agentGoal}"\n\n${plannerThreadContext ? `${plannerThreadContext}\n\n` : ""}A fast browsing agent visited ${pageSummaries.length} pages and produced this draft:\n${result}\n\nHere is the raw page content observed:\n${pagesContext.slice(0, 30000)}\n\nProduce a comprehensive, well-structured final answer. Include specific product names, prices, and links where available. Be concise but thorough. Do not add information that wasn't in the observed pages.`,
                                systemInstruction: "You are a research synthesizer.",
                                thinkingBudget: 2048,
                            }),
                            modelConfig.timeoutMs,
                            "Synthesis Gemini call"
                        );
                        if (synthText && synthText.length > 50) {
                            log("info", "synth_complete", { durationMs: Date.now() - synthStart, resultLength: synthText.length });
                            state.finalResult = synthText;
                        } else {
                            log("warn", "synth_empty_fallback_to_flash", { durationMs: Date.now() - synthStart });
                            state.finalResult = result;
                        }
                    } catch (synthErr: any) {
                        log("warn", "synth_failed_fallback_to_flash", { error: shortErr(synthErr) });
                        state.finalResult = result;
                    }
                } else {
                    state.finalResult = result;
                }

                state.status = "done";
                requestStop();
                return { ok: true };
            };

            // ================================================================
            // DISPATCHER
            // ================================================================
            const dispatchTool = async (name: string, args: any) => {
                await checkStopOrPause();
                log("debug", "dispatch_tool", { name, args });

                switch (name) {
                    case "observe": return tool_observe(args);
                    case "navigate": return tool_navigate(args);
                    case "click": return tool_click(args);
                    case "type": return tool_type(args);
                    case "scroll": return tool_scroll(args);
                    case "wait": return tool_wait(args);
                    case "new_tab": return tool_new_tab();
                    case "switch_tab": return tool_switch_tab(args);
                    case "list_tabs": return tool_list_tabs();
                    case "finish": return tool_finish(args);
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            };

            const recordToolStep = async ({
                name,
                source,
                args,
                result,
                durationMs,
                preUrl,
            }: {
                name: string;
                source: "llm" | "seed" | "direct";
                args: Record<string, unknown>;
                result: unknown;
                durationMs?: number;
                preUrl?: string;
            }) => {
                if (!runCtx) return;
                const resultRecord = result && typeof result === "object"
                    ? result as Record<string, unknown>
                    : {};
                const observationRecord = resultRecord.observation && typeof resultRecord.observation === "object"
                    ? resultRecord.observation as Record<string, unknown>
                    : {};
                const snapshot = resultRecord.snapshot && typeof resultRecord.snapshot === "object"
                    ? resultRecord.snapshot as Partial<NormalizedSnapshot>
                    : observationRecord.snapshot && typeof observationRecord.snapshot === "object"
                        ? observationRecord.snapshot as Partial<NormalizedSnapshot>
                        : undefined;
                const observationText = snapshot?.text ? String(snapshot.text).slice(0, 400) : undefined;
                const stepError = typeof resultRecord.error === "string" ? resultRecord.error : undefined;
                await recordStep(runCtx, {
                    step: state.step,
                    name,
                    source,
                    args,
                    ok: resultRecord.ok === true,
                    error: stepError,
                    durationMs,
                    observationSnippet: observationText?.slice(0, 400),
                    preUrl,
                    postUrl: snapshot?.url || (typeof resultRecord.url === "string" ? resultRecord.url : undefined),
                    postTitle: snapshot?.title || (typeof resultRecord.title === "string" ? resultRecord.title : undefined),
                    timestamp: nowIso(),
                });
            };

            // Seed explicit URL goals before the first planner call.
            let initialObservation: Awaited<ReturnType<typeof tool_observe>> | null = null;
            if (goalUrl) {
                try {
                    log("info", "goal_seed_navigation", { url: goalUrl });
                    state.step++;
                    const navigatePreUrl = lastKnownUrl || undefined;
                    const navigateStart = Date.now();
                    const navigateResult = await tool_navigate({ url: goalUrl });
                    await recordToolStep({
                        name: "navigate",
                        source: "seed",
                        args: { url: goalUrl },
                        result: navigateResult,
                        durationMs: Date.now() - navigateStart,
                        preUrl: navigatePreUrl,
                    });

                    state.step++;
                    const observePreUrl = lastKnownUrl || undefined;
                    const observeArgs = { maxTextChars: 2800, maxElements: 50 };
                    const observeStart = Date.now();
                    initialObservation = await tool_observe(observeArgs);
                    await recordToolStep({
                        name: "observe",
                        source: "seed",
                        args: observeArgs,
                        result: initialObservation,
                        durationMs: Date.now() - observeStart,
                        preUrl: observePreUrl,
                    });
                } catch (e: any) {
                    log("warn", "goal_seed_navigation_failed", { error: shortErr(e) });
                }
            }

            // ================================================================
            // MODEL SETUP
            // ================================================================
            const modelClient = createModelClient(modelConfig);

            const SYSTEM = `You are a fast browser automation agent. Your current goal: ${agentGoal}

${plannerThreadContext ? `${plannerThreadContext}\n\n` : ""}Available tools:
- observe(): Get current page accessibility snapshot with elements identified by ref IDs, plus evidence
- navigate({url}): Navigate to a URL (returns url+title only — call observe() to see page content)
- click({ref, element}): Click element by ref (does NOT return page state — call observe() after if needed)
- type({ref, text, submit?, clear?}): Type text into an input field by ref (does NOT return page state)
- scroll({direction?, amount?}): Scroll the page (does NOT return page state)
- wait({seconds}): Wait for a specified time
- new_tab(): Open a new browser tab
- switch_tab({index}): Switch to a tab by index (0-based)
- list_tabs(): List all open tabs
- finish({result}): Complete the task with a result

Speed rules:
- Be fast and efficient. Minimize the number of steps — every tool call costs time.
- Actions (navigate, click, type, scroll) do NOT automatically return the page state.
  Call observe() explicitly when you need to see page content or find element refs.
  Batch actions when you know what to do next: navigate → type (by known field) → observe is 3 calls instead of navigate → observe → type → observe (4 calls).
- For multi-site tasks, use parallel tabs to overlap page loading:
  navigate(url1) → new_tab() → navigate(url2) → switch_tab({index:0}) → observe() → [interact with site 1] → switch_tab({index:1}) → observe() → [interact with site 2]
- If you know the URLs for multiple sites, navigate to them directly instead of searching for them.
- After observing a page, extract ALL useful information before moving on. Don't come back to a page you already visited.
- Call finish() as soon as you have enough information. Your result will be refined by a second model, so focus on gathering complete raw data rather than polishing prose.

Tips:
- observe() returns an accessibility tree where each interactive element has a ref (e.g. "e5") you use in click/type
- You MUST call observe() before using click/type to get valid refs for the current page
- For coursework/deadline tasks, rely on snapshot.evidence (dueMentions, keyLines, instructionBlocks)
- Do not speculate. If detail text is not visible, keep navigating/observing until you can cite exact text
- For evidence-heavy goals, include the exact due date/time string and at least one exact quoted instruction sentence
- Set clear:true when typing in fields that may have existing content`;

            log("info", "agent_starting", {
                goal: agentGoal,
                userGoal,
                provider: modelConfig.provider,
                navModel: modelConfig.navModel,
                synthModel: modelConfig.synthModel,
                synthEnabled: modelConfig.synthEnabled,
            });

            const tools: ToolDeclaration[] = [
                {
                    name: "observe",
                    description: "Get current page accessibility snapshot with interactive elements, ref IDs, visible text, and evidence",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            maxTextChars: { type: Type.NUMBER, description: "Optional max visible text chars to capture (default 7000)" },
                            maxElements: { type: Type.NUMBER, description: "Optional max interactive elements to capture (default 80)" },
                        },
                    },
                },
                {
                    name: "navigate",
                    description: "Navigate to a URL",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            url: { type: Type.STRING, description: "The URL to navigate to" },
                        },
                        required: ["url"],
                    },
                },
                {
                    name: "click",
                    description: "Click an element by its ref from the latest observe snapshot",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            ref: { type: Type.STRING, description: "Element ref from snapshot (e.g. 'e5')" },
                            element: { type: Type.STRING, description: "Human-readable description of the element being clicked" },
                        },
                        required: ["ref", "element"],
                    },
                },
                {
                    name: "type",
                    description: "Type text into an input field by its ref",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            ref: { type: Type.STRING, description: "Element ref from snapshot" },
                            text: { type: Type.STRING, description: "Text to type" },
                            submit: { type: Type.BOOLEAN, description: "Press Enter after typing" },
                            clear: { type: Type.BOOLEAN, description: "Clear existing content before typing" },
                        },
                        required: ["ref", "text"],
                    },
                },
                {
                    name: "scroll",
                    description: "Scroll the page in a direction",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            direction: { type: Type.STRING, description: "Scroll direction: up, down, left, right" },
                            amount: { type: Type.NUMBER, description: "Pixels to scroll (default 500)" },
                        },
                    },
                },
                {
                    name: "wait",
                    description: "Wait for a specified number of seconds",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            seconds: { type: Type.NUMBER, description: "Seconds to wait (default 2)" },
                        },
                    },
                },
                {
                    name: "new_tab",
                    description: "Open a new browser tab for parallel browsing",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {},
                    },
                },
                {
                    name: "switch_tab",
                    description: "Switch to a browser tab by index (0-based)",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            index: { type: Type.NUMBER, description: "Tab index to switch to (0-based)" },
                        },
                        required: ["index"],
                    },
                },
                {
                    name: "list_tabs",
                    description: "List all open browser tabs with their indices and URLs",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {},
                    },
                },
                {
                    name: "finish",
                    description: "Complete the task with results",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            result: { type: Type.STRING, description: "Summary of what was accomplished" },
                        },
                        required: ["result"],
                    },
                },
            ];

            const chat = modelClient.createToolChat({
                model: modelConfig.navModel,
                systemInstruction: SYSTEM,
                tools,
            });

            log("info", "model_call_starting", { message: "Calling planner..." });
            const geminiStart = Date.now();
            let response;
            try {
                const initialObservationText = initialObservation?.snapshot
                    ? `\nCurrent browser observation: ${JSON.stringify(initialObservation.snapshot).slice(0, 12000)}`
                    : "";
                response = await withTimeout(
                    chat.sendMessage(
                        `Start.\nCurrent request: ${agentGoal}\nOriginal user request: ${userGoal}\n${plannerThreadContext ? `${plannerThreadContext}\n` : ""}${initialObservationText}`
                    ),
                    modelConfig.timeoutMs,
                    "Initial planner call"
                );
                log("info", "model_call_complete", { durationMs: Date.now() - geminiStart });
            } catch (geminiError: any) {
                log("error", "model_call_failed", { error: shortErr(geminiError), durationMs: Date.now() - geminiStart });
                throw geminiError;
            }

            // ================================================================
            // MAIN LOOP
            // ================================================================
            for (let i = 0; i < MAX_STEPS; i++) {
                await checkStopOrPause();
                const calls = response.functionCalls || [];

                if (!calls.length) {
                    const text = response.text;
                    if (text) {
                        state.step++;
                        await recordToolStep({
                            name: "finish",
                            source: "direct",
                            args: { result: text },
                            result: { ok: true, result: text },
                            durationMs: 0,
                            preUrl: lastKnownUrl || undefined,
                        });
                        state.lastAction = "Thought: " + text.slice(0, 200);
                        log("info", "agent_thought", { thought: text.slice(0, 200) });
                    }
                    state.finalResult = text || "No tool calls - agent finished thinking";
                    state.status = "done";
                    break;
                }

                const toolOutputs: ToolResponsePart[] = [];
                for (const call of calls) {
                    if (!call.name) continue;
                    state.step++;
                    state.lastAction = `${call.name}(${JSON.stringify(call.args)})`;
                    const preUrl = lastKnownUrl || undefined;

                    let result;
                    const stepStart = Date.now();
                    try {
                        result = await dispatchTool(call.name, call.args || {});
                    } catch (e: any) {
                        log("error", `${call.name}_failed`, { error: shortErr(e) });
                        result = { ok: false, error: shortErr(e) };
                        state.lastError = shortErr(e);
                    }
                    const durationMs = Date.now() - stepStart;

                    // Persist step record to disk for run inspection.
                    await recordToolStep({
                        name: call.name,
                        source: "llm",
                        args: call.args || {},
                        result,
                        durationMs,
                        preUrl,
                    });

                    if (runCtx) {
                        if (CAPTURE_ARTIFACTS) {
                            // Save DOM snapshot via browser_evaluate
                            try {
                                const htmlResult = await callMcpTool("browser_evaluate", {
                                    function: "() => document.documentElement.outerHTML",
                                });
                                const html = mcpText(htmlResult);
                                if (html) {
                                    await saveTextArtifact(runCtx, `step${state.step}_dom.html`, html);
                                }
                            } catch (e) {
                                log("warn", "artifact_dom_failed", { error: shortErr(e) });
                            }
                        }
                    }

                    toolOutputs.push({ functionResponse: { name: call.name, response: result } });
                }

                // finish() requests stop; do not perform another model round-trip after the terminal tool call.
                if (state.stopRequested) {
                    log("debug", "agent_loop_exit_after_terminal_tool", {
                        stopRequested: state.stopRequested,
                    });
                    break;
                }

                log("debug", "model_loop_call_starting", { toolCount: toolOutputs.length });
                const loopCallStart = Date.now();
                try {
                    response = await withTimeout(
                        chat.sendMessage(toolOutputs),
                        modelConfig.timeoutMs,
                        "Planner API call"
                    );
                    log("debug", "model_loop_call_complete", { durationMs: Date.now() - loopCallStart });
                } catch (geminiLoopError: any) {
                    log("error", "model_loop_call_failed", { error: shortErr(geminiLoopError), durationMs: Date.now() - loopCallStart });
                    throw geminiLoopError;
                }
            }

        } catch (e: any) {
            // Don't treat user-requested stops as errors
            if (e instanceof StopRequestedError) {
                state.status = "stopped";
                log("info", "agent_stopped_by_user");
            } else {
                state.status = "error";
                state.lastError = shortErr(e);
                log("error", "agent_error", { error: shortErr(e) });
            }
        } finally {
            if (state.status !== "error" && state.status !== "done" && state.status !== "stopped") state.status = "done";
            state.finishedAt = nowIso();
            const finalDurationMs = state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0;
            log("info", "agent_finished", {
                status: state.status,
                steps: state.step,
                duration: finalDurationMs
            });
            state.performance = buildPerformanceSummary(state.logs, state.step, finalDurationMs);
            if (runCtx) {
                await saveTextArtifact(runCtx, "session_logs.json", JSON.stringify(state.logs, null, 2));
                await saveTextArtifact(runCtx, "performance_summary.json", JSON.stringify(state.performance, null, 2));
                await finalizeRun(runCtx, state.status, state.finalResult, {
                    durationMs: finalDurationMs,
                    runtime: state.runtime,
                    performance: state.performance,
                    lastError: state.lastError || undefined,
                });
                if (state.threadId) {
                    await updateThreadOnRunFinish(state.threadId, {
                        runId: runCtx.runId,
                        status: state.status,
                        userGoal,
                        finalResult: state.finalResult || state.lastError,
                    });
                }
            }
            runningPromise = null;
            // Don't close MCP - keep it for next run
        }
    })();

    return startInfo;
}

export function getAgentState() {
    return state;
}
