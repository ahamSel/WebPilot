import fs from "node:fs/promises";
import path from "node:path";

export interface RunContext {
    runId: string;
    runDir: string;
    stepsFile: string;
    artifactsDir: string;
    goal: string;
    model: string;
    startedAt: string;
    threadId?: string;
    userGoal?: string;
    threadTurn?: number;
}

export interface FinalizeRunExtras {
    durationMs?: number;
    runtime?: unknown;
    performance?: unknown;
    lastError?: string;
}

export interface RunMetadata {
    threadId?: string;
    threadTitle?: string;
    userGoal?: string;
    plannerContext?: string;
    threadTurn?: number;
}

export interface StepRecord {
    step: number;
    name: string;
    source?: "llm";
    args: any;
    ok: boolean;
    error?: string;
    durationMs?: number;
    observationSnippet?: string;
    preUrl?: string;
    postUrl?: string;
    postTitle?: string;
    postStateSignature?: string;
    postElementLabels?: string[];
    timestamp: string;
    heal?: {
        from?: string;
        to?: string;
        reason?: string;
    };
}

const RUN_ROOT = process.env.RUN_STORE_DIR || "agent_runs";

async function ensureDir(dir: string) {
    await fs.mkdir(dir, { recursive: true });
}

export async function startRunRecorder(goal: string, model: string, metadataInput: RunMetadata = {}): Promise<RunContext> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const runDir = path.join(RUN_ROOT, runId);
    await ensureDir(runDir);
    const artifactsDir = path.join(runDir, "artifacts");
    await ensureDir(artifactsDir);

    const runMeta = {
        runId,
        goal,
        model,
        startedAt: new Date().toISOString(),
        status: "running",
        threadId: metadataInput.threadId || undefined,
        threadTitle: metadataInput.threadTitle || undefined,
        userGoal: metadataInput.userGoal || goal,
        plannerContext: metadataInput.plannerContext || undefined,
        threadTurn: metadataInput.threadTurn,
    };
    await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(runMeta, null, 2), "utf8");

    const ctx: RunContext = {
        runId,
        runDir,
        stepsFile: path.join(runDir, "steps.jsonl"),
        artifactsDir,
        goal,
        model,
        startedAt: runMeta.startedAt,
        threadId: runMeta.threadId || undefined,
        userGoal: runMeta.userGoal || goal,
        threadTurn: runMeta.threadTurn,
    };
    return ctx;
}

export async function recordStep(ctx: RunContext, record: StepRecord) {
    try {
        const line = JSON.stringify(record);
        await fs.appendFile(ctx.stepsFile, line + "\n", "utf8");
    } catch (e) {
        // Swallow errors so step recording never breaks the agent
        console.warn("recordStep failed", e);
    }
}

export async function saveTextArtifact(ctx: RunContext, filename: string, contents: string) {
    try {
        const safeName = filename.replace(/[^\w.-]+/g, "_");
        const fullPath = path.join(ctx.artifactsDir, safeName);
        await fs.writeFile(fullPath, contents, "utf8");
        return fullPath;
    } catch (e) {
        console.warn("saveTextArtifact failed", e);
        return null;
    }
}

export async function saveBinaryArtifact(ctx: RunContext, filename: string, data: Buffer) {
    try {
        const safeName = filename.replace(/[^\w.-]+/g, "_");
        const fullPath = path.join(ctx.artifactsDir, safeName);
        await fs.writeFile(fullPath, data);
        return fullPath;
    } catch (e) {
        console.warn("saveBinaryArtifact failed", e);
        return null;
    }
}

export async function finalizeRun(
    ctx: RunContext,
    status: string,
    finalResult: string,
    extras: FinalizeRunExtras = {}
) {
    try {
        const metaPath = path.join(ctx.runDir, "run.json");
        const raw = await fs.readFile(metaPath, "utf8").catch(() => "{}");
        const meta = JSON.parse(raw || "{}");
        meta.status = status;
        meta.finalResult = finalResult;
        meta.finishedAt = new Date().toISOString();
        if (typeof extras.durationMs === "number") meta.durationMs = extras.durationMs;
        if (extras.runtime !== undefined) meta.runtime = extras.runtime;
        if (extras.performance !== undefined) meta.performance = extras.performance;
        if (extras.lastError !== undefined) meta.lastError = extras.lastError;
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
    } catch (e) {
        console.warn("finalizeRun failed", e);
    }
}

export interface RunSummary {
    runId: string;
    goal: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    finalResult?: string;
    runDir: string;
    performance?: unknown;
    threadId?: string;
    threadTitle?: string;
    userGoal?: string;
    lastError?: string;
    threadTurn?: number;
}

export interface RunLogEntry {
    timestamp: string;
    level: "debug" | "info" | "warn" | "error";
    action: string;
    details?: unknown;
    duration?: number;
}

export interface RunDetail extends RunSummary {
    model?: string;
    goal: string;
    plannerContext?: string;
    runtime?: unknown;
    logs: RunLogEntry[];
    steps: StepRecord[];
    artifacts: string[];
    threadContext?: string | null;
}

export interface RunArtifactDetail {
    runId: string;
    name: string;
    kind: "json" | "text" | "html" | "binary";
    mimeType: string;
    sizeBytes: number;
    modifiedAt?: string;
    step?: number;
    content: string;
    truncated: boolean;
    renderedHtml?: string | null;
}

export interface ListRunsOptions {
    threadId?: string;
}

function normalizeRunId(runId: string): string {
    const trimmed = String(runId || "").trim();
    if (!trimmed) {
        throw new Error("runId required");
    }
    const safe = path.basename(trimmed);
    if (safe !== trimmed) {
        throw new Error("Invalid runId");
    }
    return safe;
}

function sanitizePerformance(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const allowed = new Set([
        "wallClockMs",
        "totalSteps",
        "llmCallCount",
        "llmDurationMs",
        "initialPlannerCalls",
        "loopPlannerCalls",
        "synthCallCount",
        "synthDurationMs",
        "coordinatorCallCount",
        "coordinatorDurationMs",
    ]);
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([key]) => allowed.has(key))
    );
}

const PUBLIC_LOG_ACTIONS = new Set([
    "agent_error",
    "agent_finished",
    "agent_starting",
    "agent_stopped_by_user",
    "agent_thought",
    "artifact_dom_failed",
    "browser_ready",
    "click_complete",
    "coordination_stop_requested",
    "coordinator_analyzing",
    "coordinator_failed",
    "coordinator_not_parallel",
    "coordinator_split_response",
    "dispatch_tool",
    "finish",
    "finish_evidence_check",
    "goal_seed_navigation",
    "goal_seed_navigation_failed",
    "launching_browser",
    "mcp_auto_launching",
    "mcp_connected",
    "mcp_connecting",
    "mcp_restarting_for_browser_change",
    "model_call_complete",
    "model_call_failed",
    "model_call_starting",
    "model_loop_call_complete",
    "model_loop_call_failed",
    "navigate_complete",
    "navigate_start",
    "observe",
    "parallel_result_received",
    "parallel_tasks_started",
    "run_started",
    "security_block_detected",
    "security_block_no_handler",
    "scroll_complete",
    "synth_complete",
    "synth_empty_fallback_to_flash",
    "synth_failed_fallback_to_flash",
    "type_complete",
    "wait_complete",
]);

function sanitizeLogEntries(value: unknown): RunLogEntry[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((entry): entry is RunLogEntry => !!entry && typeof entry === "object")
        .filter((entry) => PUBLIC_LOG_ACTIONS.has(String(entry.action || "")));
}

function sanitizeStepRecord(step: StepRecord): StepRecord {
    return {
        ...step,
        source: step.source === "llm" ? "llm" : undefined,
        postStateSignature: undefined,
        postElementLabels: undefined,
    };
}

function publicArtifactName(name: string) {
    return name === "performance_summary.json"
        || name === "session_logs.json"
        || name === "thread_context.txt"
        || /^step\d+_/i.test(name);
}

function runDirForId(runId: string): string {
    return path.join(RUN_ROOT, normalizeRunId(runId));
}

function normalizeArtifactName(artifactName: string): string {
    const trimmed = String(artifactName || "").trim();
    if (!trimmed) {
        throw new Error("artifact required");
    }
    const safe = path.basename(trimmed);
    if (safe !== trimmed) {
        throw new Error("Invalid artifact name");
    }
    return safe;
}

function artifactPathFor(runId: string, artifactName: string): string {
    return path.join(runDirForId(runId), "artifacts", normalizeArtifactName(artifactName));
}

function detectArtifactKind(artifactName: string): RunArtifactDetail["kind"] {
    const extension = path.extname(artifactName).toLowerCase();
    if (extension === ".json") return "json";
    if (extension === ".html" || extension === ".htm") return "html";
    if (extension === ".txt" || extension === ".log" || extension === ".md" || !extension) return "text";
    return "binary";
}

function detectArtifactMimeType(kind: RunArtifactDetail["kind"]): string {
    if (kind === "json") return "application/json";
    if (kind === "html") return "text/html";
    if (kind === "text") return "text/plain";
    return "application/octet-stream";
}

function artifactStepFromName(artifactName: string): number | undefined {
    const match = /^step(\d+)_/i.exec(artifactName);
    if (!match) return undefined;
    return Number(match[1]);
}

function extractHtmlDocument(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.startsWith("<body")) {
        return raw;
    }
    const resultIndex = raw.indexOf("### Result");
    if (resultIndex < 0) return null;

    let candidate = raw.slice(resultIndex + "### Result".length).trim();
    const ranCodeIndex = candidate.indexOf("\n### Ran Playwright code");
    if (ranCodeIndex >= 0) {
        candidate = candidate.slice(0, ranCodeIndex).trim();
    }

    if (!candidate) return null;

    try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed === "string") {
            const html = parsed.trim();
            if (html.startsWith("<!doctype") || html.startsWith("<html") || html.startsWith("<body")) {
                return parsed;
            }
        }
    } catch {
        // Fall through to the raw-string heuristic below.
    }

    if (candidate.startsWith("<!doctype") || candidate.startsWith("<html") || candidate.startsWith("<body")) {
        return candidate;
    }

    return null;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
    const raw = await fs.readFile(filePath, "utf8").catch(() => null);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

async function readTextFile(filePath: string): Promise<string | null> {
    return fs.readFile(filePath, "utf8").catch(() => null);
}

export async function listRuns(limit: number = 20, options: ListRunsOptions = {}): Promise<RunSummary[]> {
    const entries = await fs.readdir(RUN_ROOT).catch(() => []);
    const metas: RunSummary[] = [];
    for (const entry of entries) {
        const metaPath = path.join(RUN_ROOT, entry, "run.json");
        const raw = await fs.readFile(metaPath, "utf8").catch(() => null);
        if (!raw) continue;
        try {
            const meta = JSON.parse(raw);
            if (options.threadId && meta.threadId !== options.threadId) continue;
            metas.push({
                runId: meta.runId || entry,
                goal: meta.goal || "",
                status: meta.status || "unknown",
                startedAt: meta.startedAt,
                finishedAt: meta.finishedAt,
                durationMs: meta.durationMs,
                finalResult: meta.finalResult,
                runDir: path.join(RUN_ROOT, entry),
                performance: sanitizePerformance(meta.performance),
                threadId: meta.threadId,
                threadTitle: meta.threadTitle,
                userGoal: meta.userGoal,
                lastError: meta.lastError,
                threadTurn: meta.threadTurn,
            });
        } catch {
            continue;
        }
    }
    metas.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    return metas.slice(0, limit);
}

export async function getRunDetail(runId: string): Promise<RunDetail | null> {
    const safeRunId = normalizeRunId(runId);
    const runDir = runDirForId(safeRunId);
    const metaPath = path.join(runDir, "run.json");
    const meta = await readJsonFile<Record<string, unknown>>(metaPath);
    if (!meta) return null;

    const stepsRaw = await readTextFile(path.join(runDir, "steps.jsonl"));
    const steps = (stepsRaw || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line) as StepRecord;
            } catch {
                return null;
            }
        })
        .filter((entry): entry is StepRecord => !!entry)
        .map(sanitizeStepRecord)
        .sort((a, b) => a.step - b.step);

    const artifactsDir = path.join(runDir, "artifacts");
    const artifactNames = (await fs.readdir(artifactsDir).catch(() => [])).filter(publicArtifactName);
    artifactNames.sort((a, b) => a.localeCompare(b));

    const logs = sanitizeLogEntries(await readJsonFile<RunLogEntry[]>(path.join(artifactsDir, "session_logs.json")));
    const performance = await readJsonFile<unknown>(path.join(artifactsDir, "performance_summary.json"));
    const threadContext = await readTextFile(path.join(artifactsDir, "thread_context.txt"));

    return {
        runId: String(meta.runId || safeRunId),
        goal: String(meta.goal || ""),
        status: String(meta.status || "unknown"),
        startedAt: String(meta.startedAt || ""),
        finishedAt: typeof meta.finishedAt === "string" ? meta.finishedAt : undefined,
        durationMs: typeof meta.durationMs === "number" ? meta.durationMs : undefined,
        finalResult: typeof meta.finalResult === "string" ? meta.finalResult : undefined,
        runDir,
        performance: sanitizePerformance(performance ?? meta.performance),
        runtime: meta.runtime,
        threadId: typeof meta.threadId === "string" ? meta.threadId : undefined,
        threadTitle: typeof meta.threadTitle === "string" ? meta.threadTitle : undefined,
        userGoal: typeof meta.userGoal === "string" ? meta.userGoal : undefined,
        lastError: typeof meta.lastError === "string" ? meta.lastError : undefined,
        threadTurn: typeof meta.threadTurn === "number" ? meta.threadTurn : undefined,
        model: typeof meta.model === "string" ? meta.model : undefined,
        plannerContext: typeof meta.plannerContext === "string" ? meta.plannerContext : undefined,
        logs,
        steps,
        artifacts: artifactNames,
        threadContext,
    };
}

const MAX_ARTIFACT_PREVIEW_CHARS = 200_000;
const MAX_RENDERED_HTML_CHARS = 120_000;

export async function getRunArtifactDetail(runId: string, artifactName: string): Promise<RunArtifactDetail | null> {
    const safeRunId = normalizeRunId(runId);
    const safeArtifactName = normalizeArtifactName(artifactName);
    const filePath = artifactPathFor(safeRunId, safeArtifactName);
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats || !stats.isFile()) {
        return null;
    }

    const kind = detectArtifactKind(safeArtifactName);
    const step = artifactStepFromName(safeArtifactName);

    if (kind === "binary") {
        return {
            runId: safeRunId,
            name: safeArtifactName,
            kind,
            mimeType: detectArtifactMimeType(kind),
            sizeBytes: stats.size,
            modifiedAt: stats.mtime?.toISOString(),
            step,
            content: "Binary artifact preview is not available yet.",
            truncated: false,
            renderedHtml: null,
        };
    }

    const raw = await fs.readFile(filePath, "utf8").catch(() => null);
    if (raw === null) {
        return null;
    }

    let content = raw;
    let truncated = false;
    if (content.length > MAX_ARTIFACT_PREVIEW_CHARS) {
        content = `${content.slice(0, MAX_ARTIFACT_PREVIEW_CHARS)}\n\n… preview truncated …`;
        truncated = true;
    }

    if (kind === "json") {
        try {
            const parsed = JSON.parse(raw);
            const sanitized = safeArtifactName === "performance_summary.json"
                ? sanitizePerformance(parsed)
                : safeArtifactName === "session_logs.json"
                    ? sanitizeLogEntries(parsed)
                    : parsed;
            content = JSON.stringify(sanitized, null, 2);
            if (content.length > MAX_ARTIFACT_PREVIEW_CHARS) {
                content = `${content.slice(0, MAX_ARTIFACT_PREVIEW_CHARS)}\n\n… preview truncated …`;
                truncated = true;
            }
        } catch {
            // Keep the raw contents when the JSON cannot be parsed cleanly.
        }
    }

    const extractedHtml = kind === "html" ? extractHtmlDocument(raw) : null;
    const renderedHtml = extractedHtml && extractedHtml.length <= MAX_RENDERED_HTML_CHARS
        ? extractedHtml
        : null;

    return {
        runId: safeRunId,
        name: safeArtifactName,
        kind,
        mimeType: detectArtifactMimeType(kind),
        sizeBytes: stats.size,
        modifiedAt: stats.mtime?.toISOString(),
        step,
        content,
        truncated,
        renderedHtml,
    };
}
