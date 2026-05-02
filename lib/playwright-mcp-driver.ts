/**
 * Playwright MCP Driver — Adapter layer between WebPilot agent and @playwright/mcp.
 *
 * Spawns Playwright MCP in-process via InMemoryTransport, exposes callMcpTool(),
 * and provides snapshot parsing and evidence extraction for the agent runtime.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { BrowserChannel, BrowserName } from "./browser-runtime";

// ============================================================================
// TYPES
// ============================================================================

export interface ParsedElement {
    ref: string;
    role: string;
    name: string;
    level?: number;
    url?: string;
    cursor?: string;
    checked?: boolean;
    focused?: boolean;
    value?: string;
}

export interface ParsedSnapshot {
    url: string;
    title: string;
    elements: ParsedElement[];
    rawYaml: string;
    consoleErrors: number;
    consoleWarnings: number;
}

export interface NormalizedSnapshot {
    url: string;
    title: string;
    text: string;
    elements: Array<{
        tag: string;
        label: string;
        ref: string;
        role: string;
        href: string;
        type: string;
        id: string;
        name: string;
    }>;
    evidence: {
        dueMentions: string[];
        keyLines: string[];
        instructionBlocks: string[];
    };
}

// ============================================================================
// MCP CLIENT LIFECYCLE
// ============================================================================

let mcpClient: InstanceType<typeof Client> | null = null;
let mcpServer: any = null;
let createMcpConnection:
    | ((config: Record<string, any>) => Promise<any>)
    | null = null;

export interface PlaywrightMcpOptions {
    /** Browser engine used by Playwright MCP. */
    browserName?: BrowserName;
    /** CDP WebSocket endpoint to connect to an existing browser. */
    cdpEndpoint?: string;
    /** Launch options when auto-launching (no CDP). */
    headless?: boolean;
    /** Optional branded browser channel override. Not used by default. */
    channel?: BrowserChannel;
    /** Dedicated profile directory for persistent browser state. */
    userDataDir?: string;
    /** Custom executable path for advanced users. */
    executablePath?: string;
    /** Use an isolated in-memory browser context. */
    isolated?: boolean;
}

function ensureDefaultPlaywrightBrowsersPath() {
    const projectBrowsersPath = path.join(process.cwd(), ".playwright-browsers");
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(projectBrowsersPath)) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = projectBrowsersPath;
        process.env.PLAYWRIGHT_SKIP_BROWSER_GC = process.env.PLAYWRIGHT_SKIP_BROWSER_GC || "1";
    }
}

async function getMcpCreateConnection() {
    ensureDefaultPlaywrightBrowsersPath();
    if (createMcpConnection) return createMcpConnection;
    const appRequire = createRequire(path.join(process.cwd(), "package.json"));
    const mcpModule = appRequire("@playwright/mcp") as typeof import("@playwright/mcp");
    createMcpConnection = mcpModule.createConnection;
    return createMcpConnection;
}

function getPlaywrightRequire() {
    ensureDefaultPlaywrightBrowsersPath();
    const appRequire = createRequire(path.join(process.cwd(), "package.json"));
    const playwrightPackagePath = appRequire.resolve("playwright/package.json");
    return createRequire(playwrightPackagePath);
}

export function getManagedChromiumExecutablePath(): string {
    const playwrightRequire = getPlaywrightRequire();
    const { chromium } = playwrightRequire("playwright") as typeof import("playwright");
    return chromium.executablePath();
}

export function isManagedChromiumInstalled(): boolean {
    try {
        const executablePath = getManagedChromiumExecutablePath();
        return !!executablePath && existsSync(executablePath);
    } catch {
        return false;
    }
}

export function ensureManagedChromiumInstalled() {
    let executablePath = "";
    try {
        executablePath = getManagedChromiumExecutablePath();
    } catch (error: any) {
        throw new Error(
            `Playwright Chromium is unavailable. Install it with \`npm run browsers:install\` for local development or rebuild the desktop app so the bundled browser is included. ${error?.message || ""}`.trim()
        );
    }

    if (!executablePath || !existsSync(executablePath)) {
        throw new Error(
            `Playwright Chromium is not installed. Expected executable at ${executablePath || "(unknown path)"}. Run \`npm run browsers:install\` for local development or rebuild the desktop app so Chromium is bundled.`
        );
    }
}

/**
 * Initialize the Playwright MCP server in-process and connect a client.
 * Call once at agent startup. Re-entrant (no-ops if already connected).
 *
 * If `cdpEndpoint` is provided, connects to an existing browser.
 * Otherwise, launches a new browser via @playwright/mcp's own Playwright.
 */
export async function initPlaywrightMcp(opts: PlaywrightMcpOptions = {}): Promise<void> {
    if (mcpClient) return; // already initialized

    const browserName = opts.browserName || "chromium";
    const browserConfig: Record<string, any> = {
        browserName,
    };

    if (opts.cdpEndpoint) {
        browserConfig.cdpEndpoint = opts.cdpEndpoint;
    } else {
        if (browserName === "chromium" && !opts.channel && !opts.executablePath) {
            ensureManagedChromiumInstalled();
        }
        if (opts.isolated) {
            browserConfig.isolated = true;
        }
        if (opts.userDataDir && !opts.isolated) {
            browserConfig.userDataDir = opts.userDataDir;
        }
        // Let @playwright/mcp launch its own browser — avoids playwright-core version mismatch.
        browserConfig.launchOptions = {
            headless: opts.headless ?? false,
            ...(opts.channel ? { channel: opts.channel } : {}),
            ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
        };
    }

    const config = {
        browser: browserConfig,
        capabilities: [
            "core" as const,
            "core-input" as const,
            "core-navigation" as const,
            "core-tabs" as const,
        ],
    };

    const createConnection = await getMcpCreateConnection();
    mcpServer = await createConnection(config);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    mcpClient = new Client({ name: "web-pilot", version: "1.0.0" });
    await mcpClient.connect(clientTransport);
}

/**
 * Shut down the MCP connection. Safe to call if not initialized.
 */
export async function closePlaywrightMcp(): Promise<void> {
    if (mcpClient) {
        try { await mcpClient.close(); } catch { /* ignore */ }
        mcpClient = null;
    }
    if (mcpServer) {
        try { await mcpServer.close(); } catch { /* ignore */ }
        mcpServer = null;
    }
}

/**
 * Call a Playwright MCP tool. Returns the result content array.
 */
export async function callMcpTool(
    name: string,
    args: Record<string, any> = {}
): Promise<any> {
    if (!mcpClient) throw new Error("Playwright MCP not initialized. Call initPlaywrightMcp() first.");
    const result = await mcpClient.callTool({ name, arguments: args });
    // MCP tool results have { content: [{ type: "text", text: "..." }, ...] }
    if (result.isError) {
        const contentArr = Array.isArray(result.content) ? result.content : [];
        const errText = contentArr
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n") || "Unknown MCP tool error";
        throw new Error(errText);
    }
    return result;
}

/**
 * Extract the first text content from an MCP tool result.
 */
export function mcpText(result: any): string {
    if (!result?.content) return "";
    for (const item of result.content) {
        if (item.type === "text") return item.text;
    }
    return "";
}

/**
 * Create an independent MCP client+server pair with its own browser.
 * Used by SubAgent for true parallel execution — each agent gets its own browser.
 * Caller is responsible for closing the returned client and server.
 */
export async function createIndependentMcpClient(opts: PlaywrightMcpOptions = {}): Promise<{
    instanceId: string;
    client: InstanceType<typeof Client>;
    server: any;
    callTool: (name: string, args?: Record<string, any>) => Promise<any>;
    close: () => Promise<void>;
}> {
    const instanceId = `browser_${randomUUID().slice(0, 8)}`;
    const browserName = opts.browserName || "chromium";
    const browserConfig: Record<string, any> = {
        browserName,
        isolated: true, // Required to allow multiple browser instances
    };

    if (opts.cdpEndpoint) {
        browserConfig.cdpEndpoint = opts.cdpEndpoint;
    } else {
        if (browserName === "chromium" && !opts.channel && !opts.executablePath) {
            ensureManagedChromiumInstalled();
        }
        browserConfig.launchOptions = {
            headless: opts.headless ?? false,
            ...(opts.channel ? { channel: opts.channel } : {}),
            ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
        };
    }

    const config = {
        browser: browserConfig,
        capabilities: [
            "core" as const,
            "core-input" as const,
            "core-navigation" as const,
        ],
    };

    const createConnection = await getMcpCreateConnection();
    const server = await createConnection(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "web-pilot-sub", version: "1.0.0" });
    await client.connect(clientTransport);

    const callTool = async (name: string, args: Record<string, any> = {}): Promise<any> => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) {
            const contentArr = Array.isArray(result.content) ? result.content : [];
            const errText = contentArr
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n") || "Unknown MCP tool error";
            throw new Error(errText);
        }
        return result;
    };

    const close = async () => {
        try { await client.close(); } catch { /* ignore */ }
        try { await server.close(); } catch { /* ignore */ }
    };

    return { instanceId, client, server, callTool, close };
}

// ============================================================================
// SNAPSHOT PARSING
// ============================================================================

const ROLE_TO_TAG: Record<string, string> = {
    link: "a",
    button: "button",
    textbox: "input",
    searchbox: "input",
    combobox: "select",
    checkbox: "input",
    radio: "input",
    slider: "input",
    spinbutton: "input",
    switch: "input",
    tab: "button",
    menuitem: "a",
    option: "option",
    treeitem: "li",
    listitem: "li",
    row: "tr",
    cell: "td",
    columnheader: "th",
    rowheader: "th",
    heading: "h1",
    img: "img",
    navigation: "nav",
    banner: "header",
    contentinfo: "footer",
    main: "main",
    complementary: "aside",
    form: "form",
    table: "table",
    list: "ul",
    paragraph: "p",
    code: "code",
    separator: "hr",
    generic: "div",
    group: "div",
    region: "section",
    article: "article",
    dialog: "dialog",
    alert: "div",
    status: "div",
    tooltip: "div",
    figure: "figure",
    blockquote: "blockquote",
};

/**
 * Parse the Markdown+YAML output from browser_snapshot into structured data.
 *
 * Playwright MCP returns:
 * ```
 * ### Page
 * - Page URL: https://...
 * - Page Title: ...
 * - Console: N errors, M warnings
 *
 * ### Snapshot
 * ```yaml
 * - generic [ref=e2]:
 *   - heading "Title" [level=1] [ref=e3]
 *   - link "Click me" [ref=e4] [cursor=pointer]:
 *     - /url: https://...
 * ```
 * ```
 */
export function parseSnapshot(mcpResultText: string): ParsedSnapshot {
    const lines = mcpResultText.split("\n");
    let url = "";
    let title = "";
    let consoleErrors = 0;
    let consoleWarnings = 0;
    const yamlLines: string[] = [];
    let inYamlBlock = false;

    for (const line of lines) {
        // Page metadata
        const urlMatch = line.match(/^- Page URL:\s*(.+)/);
        if (urlMatch) { url = urlMatch[1].trim(); continue; }
        const titleMatch = line.match(/^- Page Title:\s*(.+)/);
        if (titleMatch) { title = titleMatch[1].trim(); continue; }
        const consoleMatch = line.match(/^- Console:\s*(\d+)\s+error/);
        if (consoleMatch) { consoleErrors = parseInt(consoleMatch[1], 10); }
        const warnMatch = line.match(/(\d+)\s+warning/);
        if (warnMatch && line.includes("Console:")) { consoleWarnings = parseInt(warnMatch[1], 10); }

        // YAML block detection
        if (line.trim() === "```yaml") { inYamlBlock = true; continue; }
        if (inYamlBlock && line.trim() === "```") { inYamlBlock = false; continue; }
        if (inYamlBlock) { yamlLines.push(line); }
    }

    const rawYaml = yamlLines.join("\n");
    const elements = parseYamlElements(yamlLines);

    return { url, title, elements, rawYaml, consoleErrors, consoleWarnings };
}

/**
 * Parse YAML accessibility tree lines into flat elements list.
 *
 * Each element line looks like:
 *   - role "accessible name" [attr=val] [ref=eN]: text content
 *   - /url: https://...   (metadata child, not an element)
 */
function parseYamlElements(lines: string[]): ParsedElement[] {
    const elements: ParsedElement[] = [];
    // Match: optional indent, dash, role, optional "name", optional [attributes], optional : text
    const elementRegex = /^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(.*)$/;
    const attrRegex = /\[(\w+)(?:=([^\]]*))?\]/g;

    for (const line of lines) {
        // Skip /url metadata lines
        if (line.trim().startsWith("- /url:")) continue;

        const m = line.match(elementRegex);
        if (!m) continue;

        const role = m[2];
        const name = m[3] || "";
        const rest = m[4] || "";

        // Extract ref and other attributes
        let ref = "";
        let level: number | undefined;
        let cursor: string | undefined;
        let checked: boolean | undefined;
        let focused: boolean | undefined;

        let attrMatch;
        attrRegex.lastIndex = 0;
        while ((attrMatch = attrRegex.exec(rest)) !== null) {
            const key = attrMatch[1];
            const val = attrMatch[2] || "";
            if (key === "ref") ref = val;
            else if (key === "level") level = parseInt(val, 10);
            else if (key === "cursor") cursor = val;
            else if (key === "checked") checked = true;
            else if (key === "focused" || key === "active") focused = true;
        }

        // Only include elements with refs (interactive/targetable)
        if (!ref) continue;

        // Check for /url on the next line (look-ahead handled below)
        elements.push({ ref, role, name, level, cursor, checked, focused });
    }

    // Second pass: attach /url to the preceding link element
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith("- /url:")) {
            const urlVal = trimmed.replace("- /url:", "").trim();
            // Find the most recent link element
            for (let j = elements.length - 1; j >= 0; j--) {
                if (elements[j].role === "link" && !elements[j].url) {
                    elements[j].url = urlVal;
                    break;
                }
            }
        }
    }

    return elements;
}

// ============================================================================
// SNAPSHOT NORMALIZATION
// ============================================================================

/** Convert a ParsedSnapshot + evidence into the compact agent snapshot format. */
export function buildNormalizedSnapshot(
    parsed: ParsedSnapshot,
    pageText: string,
    evidence: { dueMentions: string[]; keyLines: string[]; instructionBlocks: string[] }
): NormalizedSnapshot {
    const elements = parsed.elements.slice(0, 80).map((el) => {
        return {
            tag: ROLE_TO_TAG[el.role] || el.role,
            label: el.name || "",
            ref: el.ref,
            role: el.role,
            href: el.url || "",
            type: el.role === "textbox" || el.role === "searchbox" ? "text"
                : el.role === "checkbox" ? "checkbox"
                : el.role === "radio" ? "radio"
                : "",
            id: "",
            name: "",
        };
    });

    return {
        url: parsed.url,
        title: parsed.title,
        text: pageText,
        elements,
        evidence,
    };
}

// ============================================================================
// EVIDENCE EXTRACTION
// ============================================================================

/**
 * Extract LMS-specific evidence (due dates, key lines, instruction blocks)
 * by running JS in the browser via browser_evaluate.
 */
export async function extractEvidence(): Promise<{
    dueMentions: string[];
    keyLines: string[];
    instructionBlocks: string[];
}> {
    try {
        const result = await callMcpTool("browser_evaluate", {
            function: `() => {
                const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
                const fullText = String(document.body?.innerText || "");
                const lines = fullText.split(/\\r?\\n/).map(l => norm(l)).filter(Boolean);

                const dueMentions = Array.from(fullText.matchAll(
                    /Due on [A-Za-z]{3,9}\\s+\\d{1,2},\\s+\\d{4}\\s+\\d{1,2}:\\d{2}\\s*(AM|PM)/gi
                )).map(m => norm(m[0])).slice(0, 6);

                const keyLinePatterns = [
                    /\\bproposal\\b/i, /\\binstructions?\\b/i, /\\bresearch question\\b/i,
                    /\\bannotated citations?\\b/i, /\\belevator pitch\\b/i, /\\bDue on\\b/i,
                ];
                const keyLines = lines.filter(line => keyLinePatterns.some(p => p.test(line))).slice(0, 24);

                const decodeHtml = (raw) => {
                    const wrapper = document.createElement("div");
                    wrapper.innerHTML = raw;
                    return norm(wrapper.innerText || wrapper.textContent || "");
                };
                const instructionBlocks = [];
                for (const block of document.querySelectorAll("d2l-html-block")) {
                    const raw = block.getAttribute("html") || "";
                    const txt = raw ? decodeHtml(raw) : norm(block.innerText || block.textContent || "");
                    if (!txt || txt.length < 80) continue;
                    instructionBlocks.push(txt.slice(0, 4000));
                    if (instructionBlocks.length >= 4) break;
                }

                return JSON.stringify({ dueMentions, keyLines, instructionBlocks });
            }`,
        });
        const text = mcpText(result);
        // browser_evaluate may return the result as a string in the text content
        // Try to extract JSON from the result
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return { dueMentions: [], keyLines: [], instructionBlocks: [] };
    } catch {
        return { dueMentions: [], keyLines: [], instructionBlocks: [] };
    }
}

/**
 * Extract visible page text via browser_evaluate.
 */
export async function extractPageText(maxChars: number = 7000): Promise<string> {
    try {
        const result = await callMcpTool("browser_evaluate", {
            function: `() => {
                const text = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
                return text.slice(0, ${maxChars});
            }`,
        });
        const text = mcpText(result);
        // browser_evaluate wraps the return value in the text content
        // Strip any surrounding quotes if present
        if (text.startsWith('"') && text.endsWith('"')) {
            try { return JSON.parse(text); } catch { /* fall through */ }
        }
        return text;
    } catch {
        return "";
    }
}

// ============================================================================
// HELPERS
// ============================================================================

export function isInitialized(): boolean {
    return mcpClient !== null;
}
