/**
 * SubAgent — A standalone agent instance for true parallel execution.
 *
 * Each SubAgent has its own:
 * - Model chat session
 * - Independent browser (via createIndependentMcpClient)
 * - Run recorder (separate run directory)
 * - State (step counter, URLs, snapshots, etc.)
 *
 * Multiple SubAgents run fully in parallel — each has its own browser
 * instance, so there is zero contention between agents.
 */

import { Type } from "@google/genai";
import {
    mcpText,
    parseSnapshot,
    buildNormalizedSnapshot,
    createIndependentMcpClient,
    type NormalizedSnapshot,
} from "./playwright-mcp-driver";
import { startRunRecorder, recordStep, finalizeRun, saveTextArtifact, type RunContext } from "./recorder";
import { looksLikeLoginOrSecurityBlock } from "./security-detect";
import type { CoordinationBus } from "./coordination-bus";
import {
    createModelClient,
    type RuntimeModelConfig,
    type ToolDeclaration,
    type ToolResponsePart,
} from "./model-client";
import type { BrowserChannel, BrowserRuntimeSettings } from "./browser-runtime";

// ============================================================================
// TYPES
// ============================================================================

export interface SubAgentConfig {
    goal: string;
    runtime: RuntimeModelConfig;
    /** Label for logging (e.g. "sub-0", "sub-1") */
    label: string;
    /** Browser options — headless mode, channel, etc. */
    headless?: boolean;
    channel?: BrowserChannel;
    browser?: BrowserRuntimeSettings;
    /** Optional coordination bus for inter-agent communication */
    coordinationBus?: CoordinationBus;
    /** Target site domain (e.g. "kijiji.ca") for coordination progress */
    site?: string;
    /** Callback for login/captcha/robot blocks — pauses until human resolves. Returns true if resumed, false if stopped. */
    onSecurityBlock?: (message: string) => Promise<boolean>;
}

export interface SubAgentResult {
    ok: boolean;
    result: string;
    pageSummaries: Array<{ url: string; title: string; textSnippet: string }>;
    runDir: string;
    steps: number;
    durationMs: number;
    browserInstanceId?: string;
    error?: string;
}

interface SubAgentLogEntry {
    timestamp: string;
    level: "debug" | "info" | "warn" | "error";
    action: string;
    details?: unknown;
    duration?: number;
}

// ============================================================================
// HELPERS
// ============================================================================

function nowIso() {
    return new Date().toISOString();
}

function shortErr(e: any): string {
    const msg = e?.message || String(e);
    return msg.length > 600 ? msg.slice(0, 600) + "…" : msg;
}

function extractDomainFromGoal(goal: string): string {
    const text = goal.trim();
    if (!text) return "";
    const urlLike = text.match(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/i);
    if (urlLike?.[1]) return urlLike[1].toLowerCase();
    const hostLike = text.match(/\b([a-z0-9.-]+\.[a-z]{2,})\b/i);
    if (hostLike?.[1]) return hostLike[1].toLowerCase();
    return "";
}

function extractUrlFromGoal(goal: string): string {
    const match = String(goal || "").match(/https?:\/\/[^\s"'`<>]+/i);
    return match?.[0] || "";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
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

// ============================================================================
// SUB-AGENT CLASS
// ============================================================================

export class SubAgent {
    private config: SubAgentConfig;
    private step = 0;
    private lastKnownUrl = "";
    private latestSnapshot: NormalizedSnapshot | null = null;
    private pageSummaries: Array<{ url: string; title: string; textSnippet: string }> = [];
    private runCtx: RunContext | null = null;
    private logs: SubAgentLogEntry[] = [];
    private stopped = false;
    private finalResult = "";
    private terminalStatus: "running" | "done" | "stopped" = "running";
    /** Own MCP client — independent browser per agent */
    private mcp: Awaited<ReturnType<typeof createIndependentMcpClient>> | null = null;
    private browserInstanceId = "";

    constructor(config: SubAgentConfig) {
        this.config = config;
    }

    private log(level: string, action: string, details?: any, duration?: number) {
        this.logs.push({
            timestamp: nowIso(),
            level: level as SubAgentLogEntry["level"],
            action,
            details: details !== undefined ? details : undefined,
            duration,
        });
        const prefix = `[${level.toUpperCase()}] [${this.config.label}]`;
        const durationStr = duration ? ` (${duration}ms)` : "";
        console.log(`${prefix} ${action}${durationStr}`, details || "");
    }

    // ================================================================
    // MCP HELPERS — each agent has its own browser, no mutex needed
    // ================================================================

    private async mcpCall(toolName: string, args: Record<string, any> = {}): Promise<any> {
        if (!this.mcp) throw new Error("SubAgent browser not initialized");
        return this.mcp.callTool(toolName, args);
    }

    // ================================================================
    // TOOLS
    // ================================================================

    private async tool_observe({ maxTextChars = 7000, maxElements = 80 } = {}) {
        const startTime = Date.now();

        const snapshotResult = await this.mcpCall("browser_snapshot", {});
        const snapshotText = mcpText(snapshotResult);
        const parsed = parseSnapshot(snapshotText);

        // Page text via browser_evaluate
        const pageTextResult = await this.mcpCall("browser_evaluate", {
            function: `() => {
                const text = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
                return text.slice(0, ${maxTextChars});
            }`,
        });
        let pageText = mcpText(pageTextResult);
        if (pageText.startsWith('"') && pageText.endsWith('"')) {
            try { pageText = JSON.parse(pageText); } catch { /* fall through */ }
        }

        // Evidence extraction
        let evidence = { dueMentions: [] as string[], keyLines: [] as string[], instructionBlocks: [] as string[] };
        try {
            const evidenceResult = await this.mcpCall("browser_evaluate", {
                function: `() => {
                    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
                    const fullText = String(document.body?.innerText || "");
                    const lines = fullText.split(/\\r?\\n/).map(l => norm(l)).filter(Boolean);
                    const dueMentions = Array.from(fullText.matchAll(
                        /Due on [A-Za-z]{3,9}\\s+\\d{1,2},\\s+\\d{4}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)/gi
                    )).map(m => norm(m[0])).slice(0, 6);
                    const keyLinePatterns = [/\\bproposal\\b/i, /\\binstructions?\\b/i, /\\bresearch question\\b/i,
                        /\\bannotated citations?\\b/i, /\\belevator pitch\\b/i, /\\bDue on\\b/i];
                    const keyLines = lines.filter(line => keyLinePatterns.some(p => p.test(line))).slice(0, 24);
                    return JSON.stringify({ dueMentions, keyLines, instructionBlocks: [] });
                }`,
            });
            const text = mcpText(evidenceResult);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) evidence = JSON.parse(jsonMatch[0]);
        } catch { /* ignore */ }

        const snapshot = buildNormalizedSnapshot(parsed, pageText, evidence);
        if (snapshot.elements.length > maxElements) {
            snapshot.elements = snapshot.elements.slice(0, maxElements);
        }

        const duration = Date.now() - startTime;
        this.log("info", "observe", {
            url: snapshot.url,
            title: (snapshot.title || "").slice(0, 50),
            elementCount: snapshot.elements.length,
        }, duration);

        this.latestSnapshot = snapshot;
        this.lastKnownUrl = snapshot.url || this.lastKnownUrl;

        this.pageSummaries.push({
            url: snapshot.url || "",
            title: snapshot.title || "",
            textSnippet: (snapshot.text || "").slice(0, 3000),
        });

        return { ok: true, snapshot };
    }

    private async tool_navigate({ url }: { url: string }) {
        const startTime = Date.now();
        this.log("info", "navigate_start", { url });

        await this.mcpCall("browser_navigate", { url });

        const duration = Date.now() - startTime;
        this.log("info", "navigate_complete", { url }, duration);

        // Lightweight check — get URL/title and check for security blocks
        const snapshotResult = await this.mcpCall("browser_snapshot", {});
        const snapshotText = mcpText(snapshotResult);
        const parsed = parseSnapshot(snapshotText);
        this.lastKnownUrl = parsed.url || url;

        // Check for login/captcha/robot blocks
        const titleLower = (parsed.title || "").toLowerCase();
        const suspiciousPatterns = ["log in", "login", "sign in", "signin", "authenticate", "cas login", "sso",
            "verify", "captcha", "robot", "identity", "access denied", "blocked"];
        const isSuspicious = suspiciousPatterns.some(p => titleLower.includes(p));

        if (isSuspicious) {
            // Full check with page text
            let pageText = "";
            try {
                const textResult = await this.mcpCall("browser_evaluate", {
                    function: `() => (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 3000)`,
                });
                pageText = mcpText(textResult);
                if (pageText.startsWith('"') && pageText.endsWith('"')) {
                    try { pageText = JSON.parse(pageText); } catch { /* keep as-is */ }
                }
            } catch { /* ignore */ }

            const check = looksLikeLoginOrSecurityBlock(pageText, parsed.title, parsed.elements || []);
            if (check.detected) {
                this.log("warn", "security_block_detected", { reason: check.reason, title: parsed.title, url: this.lastKnownUrl });

                // Report block to coordination bus
                this.config.coordinationBus?.reportProgress({
                    label: this.config.label,
                    site: this.config.site || extractDomainFromGoal(this.config.goal),
                    step: this.step,
                    status: "running",
                    lastUrl: this.lastKnownUrl,
                    timestamp: nowIso(),
                });

                // If we have a pause callback, ask human to solve it
                if (this.config.onSecurityBlock) {
                    const message = check.reason === "captcha"
                        ? `[${this.config.label}] CAPTCHA detected on ${this.lastKnownUrl}. Please solve it, then click Resume.`
                        : check.reason === "robot_detection"
                        ? `[${this.config.label}] Robot detection on ${this.lastKnownUrl}. Please verify manually, then click Resume.`
                        : `[${this.config.label}] Login page detected (${parsed.title}). Please log in, then click Resume.`;
                    const resumed = await this.config.onSecurityBlock(message);
                    if (!resumed) {
                        this.stopped = true;
                        this.terminalStatus = "stopped";
                        return { ok: false, blocked: true, reason: check.reason };
                    }
                    return { ok: true, url: this.lastKnownUrl, userIntervened: true };
                }

                // No pause callback — log warning and continue (model may handle it or finish with partial result)
                this.log("warn", "security_block_no_handler", { reason: check.reason });
            }
        }

        return { ok: true, url: this.lastKnownUrl, title: parsed.title };
    }

    private async tool_click({ ref, element }: { ref: string; element?: string }) {
        const startTime = Date.now();
        if (!ref) throw new Error("Click requires a ref");

        await this.mcpCall("browser_click", { ref, element: element || "" });
        await new Promise(r => setTimeout(r, 300));

        const duration = Date.now() - startTime;
        this.log("info", "click_complete", { ref, element }, duration);
        return { ok: true };
    }

    private async tool_type({ ref, text, submit = false, clear = false }: {
        ref: string; text: string; submit?: boolean; clear?: boolean;
    }) {
        const startTime = Date.now();
        if (!ref) throw new Error("Type requires a ref");

        if (clear) {
            await this.mcpCall("browser_click", { ref, element: "field to clear" });
            await this.mcpCall("browser_press_key", { key: "Control+a" });
            await this.mcpCall("browser_press_key", { key: "Backspace" });
        }

        await this.mcpCall("browser_type", { ref, text, submit, slowly: false });
        await new Promise(r => setTimeout(r, 300));

        const duration = Date.now() - startTime;
        this.log("info", "type_complete", { ref, textLength: text.length }, duration);
        return { ok: true };
    }

    private async tool_scroll({ direction = "down", amount = 500 }: {
        direction?: string; amount?: number;
    }) {
        const scrollMap: Record<string, { x: number; y: number }> = {
            up: { x: 0, y: -amount }, down: { x: 0, y: amount },
            left: { x: -amount, y: 0 }, right: { x: amount, y: 0 },
        };
        const { x, y } = scrollMap[direction] || scrollMap.down;

        await this.mcpCall("browser_evaluate", {
            function: `() => window.scrollBy({ left: ${x}, top: ${y}, behavior: "smooth" })`,
        });
        await new Promise(r => setTimeout(r, 400));
        return { ok: true };
    }

    private async tool_wait({ seconds = 2 }: { seconds?: number }) {
        await this.mcpCall("browser_wait_for", { time: seconds });
        return { ok: true };
    }

    private async tool_finish({ result }: { result: string }) {
        this.log("info", "finish", { resultLength: result.length });
        this.finalResult = result;
        this.stopped = true;
        this.terminalStatus = "done";
        return { ok: true };
    }

    private async dispatchTool(name: string, args: any) {
        // Check coordination bus before each action
        const bus = this.config.coordinationBus;
        if (bus?.shouldStop(this.config.label)) {
            this.log("info", "coordination_stop_requested");
            this.stopped = true;
            this.terminalStatus = "stopped";
            return { ok: true, cancelled: true };
        }

        let result;
        switch (name) {
            case "observe": result = await this.tool_observe(args); break;
            case "navigate": result = await this.tool_navigate(args); break;
            case "click": result = await this.tool_click(args); break;
            case "type": result = await this.tool_type(args); break;
            case "scroll": result = await this.tool_scroll(args); break;
            case "wait": result = await this.tool_wait(args); break;
            case "finish": result = await this.tool_finish(args); break;
            default: throw new Error(`Unknown tool: ${name}`);
        }

        // Report progress after each tool call
        bus?.reportProgress({
            label: this.config.label,
            site: this.config.site || extractDomainFromGoal(this.config.goal),
            step: this.step,
            status: this.stopped ? "done" : "running",
            result: this.stopped ? this.finalResult : undefined,
            lastUrl: this.lastKnownUrl,
            timestamp: nowIso(),
        });

        return result;
    }

    // ================================================================
    // MAIN RUN LOOP
    // ================================================================

    async run(): Promise<SubAgentResult> {
        const startTime = Date.now();
        const MAX_STEPS = 80;

        try {
            // Launch own browser
            const browser = this.config.browser;
            this.log("info", "launching_browser", {
                headless: browser?.headless ?? this.config.headless ?? false,
                browserName: browser?.browserName,
                channel: browser?.mode === "channel" ? browser.channel : undefined,
            });
            this.mcp = await createIndependentMcpClient({
                browserName: browser?.mode === "cdp" ? "chromium" : browser?.browserName,
                headless: browser?.headless ?? this.config.headless ?? false,
                channel: browser?.mode === "channel" ? browser.channel : this.config.channel,
                executablePath: browser?.mode === "custom" ? browser.executablePath : "",
            });
            this.browserInstanceId = this.mcp.instanceId;
            this.log("info", "browser_ready", {
                browserInstanceId: this.browserInstanceId,
                isolated: true,
            });

            this.runCtx = await startRunRecorder(
                `[${this.config.label}] ${this.config.goal}`,
                this.config.runtime.navModel
            );
            await saveTextArtifact(this.runCtx, "subagent_runtime.json", JSON.stringify({
                label: this.config.label,
                site: this.config.site || extractDomainFromGoal(this.config.goal),
                browserInstanceId: this.browserInstanceId,
                isolatedBrowser: true,
                runtime: {
                    provider: this.config.runtime.provider,
                    navModel: this.config.runtime.navModel,
                    synthModel: this.config.runtime.synthModel,
                    reviewModel: this.config.runtime.reviewModel,
                },
            }, null, 2));

            // Report initial progress
            this.config.coordinationBus?.reportProgress({
                label: this.config.label,
                site: this.config.site || extractDomainFromGoal(this.config.goal),
                step: 0,
                status: "running",
                timestamp: nowIso(),
            });

            let initialMessage: string;
            const goalUrl = extractUrlFromGoal(this.config.goal);
            if (goalUrl) {
                try {
                    this.log("info", "goal_seed_navigation", { url: goalUrl });
                    await this.tool_navigate({ url: goalUrl });
                    const seededObservation = await this.tool_observe();
                    const obsJson = JSON.stringify(seededObservation.snapshot || {}).slice(0, 12000);
                    initialMessage = `The browser is already on the requested URL. Continue from the current page.\nGoal: ${this.config.goal}\nObservation: ${obsJson}`;
                } catch (e: any) {
                    this.log("warn", "goal_seed_navigation_failed", { error: shortErr(e) });
                    initialMessage = `Start. Goal: ${this.config.goal}`;
                }
            } else {
                initialMessage = `Start. Goal: ${this.config.goal}`;
            }

            const modelClient = createModelClient(this.config.runtime);

            const SYSTEM = `You are a fast browser automation agent. Your goal: ${this.config.goal}

Available tools:
- observe(): Get current page accessibility snapshot with elements identified by ref IDs
- navigate({url}): Navigate to a URL (returns url+title only — call observe() to see page content)
- click({ref, element}): Click element by ref (does NOT return page state — call observe() after if needed)
- type({ref, text, submit?, clear?}): Type text into an input field by ref (does NOT return page state)
- scroll({direction?, amount?}): Scroll the page
- wait({seconds}): Wait for a specified time
- finish({result}): Complete the task with a result

Rules:
- Be fast and efficient. Minimize steps.
- Actions do NOT return page state. Call observe() explicitly when you need element refs or page content.
- Navigate directly to known URLs instead of searching.
- Extract ALL useful information from a page before moving on.
- Call finish() as soon as you have enough information. Include specific product names, prices, and details.
- You MUST call observe() before using click/type to get valid refs.
- Set clear:true when typing in fields that may have existing content.`;

            this.log("info", "starting", {
                goal: this.config.goal,
                provider: this.config.runtime.provider,
                model: this.config.runtime.navModel,
            });

            const tools: ToolDeclaration[] = [
                {
                    name: "observe",
                    description: "Get current page accessibility snapshot",
                    parameters: { type: Type.OBJECT, properties: {} },
                },
                {
                    name: "navigate",
                    description: "Navigate to a URL",
                    parameters: {
                        type: Type.OBJECT,
                        properties: { url: { type: Type.STRING, description: "URL to navigate to" } },
                        required: ["url"],
                    },
                },
                {
                    name: "click",
                    description: "Click an element by ref",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            ref: { type: Type.STRING, description: "Element ref (e.g. 'e5')" },
                            element: { type: Type.STRING, description: "Description of the element" },
                        },
                        required: ["ref", "element"],
                    },
                },
                {
                    name: "type",
                    description: "Type text into an input field",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            ref: { type: Type.STRING, description: "Element ref" },
                            text: { type: Type.STRING, description: "Text to type" },
                            submit: { type: Type.BOOLEAN, description: "Press Enter after" },
                            clear: { type: Type.BOOLEAN, description: "Clear field first" },
                        },
                        required: ["ref", "text"],
                    },
                },
                {
                    name: "scroll",
                    description: "Scroll the page",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            direction: { type: Type.STRING, description: "up/down/left/right" },
                            amount: { type: Type.NUMBER, description: "Pixels (default 500)" },
                        },
                    },
                },
                {
                    name: "wait",
                    description: "Wait seconds",
                    parameters: {
                        type: Type.OBJECT,
                        properties: { seconds: { type: Type.NUMBER, description: "Seconds (default 2)" } },
                    },
                },
                {
                    name: "finish",
                    description: "Complete the task with results",
                    parameters: {
                        type: Type.OBJECT,
                        properties: {
                            result: { type: Type.STRING, description: "Summary of findings" },
                        },
                        required: ["result"],
                    },
                },
            ];

            const chat = modelClient.createToolChat({
                model: this.config.runtime.navModel,
                systemInstruction: SYSTEM,
                tools,
            });

            let response;
            const initialPlannerStart = Date.now();
            try {
                response = await withTimeout(
                    chat.sendMessage(initialMessage),
                    this.config.runtime.timeoutMs,
                    `${this.config.label} initial planner call`
                );
                this.log("info", "model_call_complete", {
                    durationMs: Date.now() - initialPlannerStart,
                });
            } catch (e: any) {
                this.log("warn", "model_call_failed", {
                    durationMs: Date.now() - initialPlannerStart,
                    error: shortErr(e),
                });
                throw e;
            }

            for (let i = 0; i < MAX_STEPS && !this.stopped; i++) {
                const calls = response.functionCalls || [];

                if (!calls.length) {
                    const text = response.text;
                    this.finalResult = text || "No result";
                    this.terminalStatus = "done";
                    break;
                }

                const toolOutputs: ToolResponsePart[] = [];
                for (const call of calls) {
                    if (!call.name || this.stopped) continue;
                    this.step++;
                    const preUrl = this.lastKnownUrl || undefined;
                    const stepStart = Date.now();

                    let result;
                    try {
                        result = await this.dispatchTool(call.name, call.args || {});
                    } catch (e: any) {
                        this.log("error", `${call.name}_failed`, { error: shortErr(e) });
                        result = { ok: false, error: shortErr(e) };
                    }
                    const durationMs = Date.now() - stepStart;

                    // Record step
                    if (this.runCtx) {
                        const snapshot = (result as any)?.snapshot;
                        await recordStep(this.runCtx, {
                            step: this.step,
                            name: call.name,
                            source: "llm",
                            args: call.args || {},
                            ok: !!result?.ok,
                            durationMs,
                            observationSnippet: snapshot?.text?.slice(0, 400),
                            preUrl,
                            postUrl: snapshot?.url,
                            postTitle: snapshot?.title,
                            timestamp: nowIso(),
                        });
                    }

                    toolOutputs.push({ functionResponse: { name: call.name, response: result } });
                }

                if (this.stopped) break;

                const loopPlannerStart = Date.now();
                try {
                    response = await withTimeout(
                        chat.sendMessage(toolOutputs),
                        this.config.runtime.timeoutMs,
                        `${this.config.label} planner loop call`
                    );
                    this.log("debug", "model_loop_call_complete", {
                        durationMs: Date.now() - loopPlannerStart,
                    });
                } catch (e: any) {
                    this.log("warn", "model_loop_call_failed", {
                        durationMs: Date.now() - loopPlannerStart,
                        error: shortErr(e),
                    });
                    throw e;
                }
            }

            await saveTextArtifact(this.runCtx!, "session_logs.json", JSON.stringify(this.logs, null, 2));
            const finalStatus = this.terminalStatus === "stopped" ? "stopped" : "done";
            await finalizeRun(this.runCtx!, finalStatus, this.finalResult, {
                durationMs: Date.now() - startTime,
                runtime: {
                    provider: this.config.runtime.provider,
                    navModel: this.config.runtime.navModel,
                    synthModel: this.config.runtime.synthModel,
                    reviewModel: this.config.runtime.reviewModel,
                    browserInstanceId: this.browserInstanceId,
                    isolatedBrowser: true,
                },
            });

            // Report completion to coordination bus
            this.config.coordinationBus?.reportProgress({
                label: this.config.label,
                site: this.config.site || extractDomainFromGoal(this.config.goal),
                step: this.step,
                status: finalStatus === "stopped" ? "cancelled" : "done",
                result: this.finalResult,
                lastUrl: this.lastKnownUrl,
                timestamp: nowIso(),
            });

            return {
                ok: finalStatus === "done",
                result: this.finalResult,
                pageSummaries: this.pageSummaries,
                runDir: this.runCtx!.runDir,
                steps: this.step,
                durationMs: Date.now() - startTime,
                browserInstanceId: this.browserInstanceId,
            };
        } catch (e: any) {
            this.log("error", "sub_agent_error", { error: shortErr(e) });
            if (this.runCtx) {
                await saveTextArtifact(this.runCtx, "session_logs.json", JSON.stringify(this.logs, null, 2)).catch(() => {});
                await finalizeRun(this.runCtx, "error", shortErr(e), {
                    durationMs: Date.now() - startTime,
                    runtime: {
                        provider: this.config.runtime.provider,
                        navModel: this.config.runtime.navModel,
                        synthModel: this.config.runtime.synthModel,
                        reviewModel: this.config.runtime.reviewModel,
                        browserInstanceId: this.browserInstanceId,
                        isolatedBrowser: true,
                    },
                }).catch(() => {});
            }

            // Report error to coordination bus
            this.config.coordinationBus?.reportProgress({
                label: this.config.label,
                site: this.config.site || extractDomainFromGoal(this.config.goal),
                step: this.step,
                status: "error",
                lastUrl: this.lastKnownUrl,
                timestamp: nowIso(),
            });

            return {
                ok: false,
                result: this.finalResult || "",
                pageSummaries: this.pageSummaries,
                runDir: this.runCtx?.runDir || "",
                steps: this.step,
                durationMs: Date.now() - startTime,
                browserInstanceId: this.browserInstanceId,
                error: shortErr(e),
            };
        } finally {
            // Close own browser
            if (this.mcp) {
                this.log("info", "closing_browser");
                await this.mcp.close().catch(() => {});
                this.mcp = null;
            }
        }
    }
}
