/**
 * Contract checks for the Playwright MCP server that ships in playwright-core.
 * They list tools without launching a browser, so a Playwright upgrade that
 * renames a tool or argument WebPilot depends on fails here instead of at runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toMcpArguments } from "../lib/playwright-mcp-driver";

interface McpServer {
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
}

const appRequire = createRequire(path.join(process.cwd(), "package.json"));

/** Tools WebPilot calls, with the arguments it passes (after toMcpArguments). */
const REQUIRED_TOOLS: Record<string, string[]> = {
    browser_navigate: ["url"],
    browser_navigate_back: [],
    browser_snapshot: [],
    browser_click: ["target", "element"],
    browser_type: ["target", "text", "submit", "slowly"],
    browser_press_key: ["key"],
    browser_evaluate: ["function"],
    browser_wait_for: ["time"],
    browser_tabs: ["action", "index"],
};

test("playwright and playwright-core are pinned to the same version", () => {
    const playwright = appRequire("playwright/package.json") as { version: string };
    const core = appRequire("playwright-core/package.json") as { version: string };
    assert.equal(playwright.version, core.version);
});

test("playwright-core exposes the MCP server tools WebPilot uses", async () => {
    const coreBundle = appRequire("playwright-core/lib/coreBundle") as {
        tools?: { createConnection?: (config: Record<string, unknown>) => Promise<McpServer> };
    };
    assert.equal(typeof coreBundle.tools?.createConnection, "function");

    const server = await coreBundle.tools!.createConnection!({
        browser: { browserName: "chromium", launchOptions: { headless: true } },
        capabilities: ["core", "core-input", "core-navigation", "core-tabs"],
        snapshot: { mode: "none" },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "webpilot-contract", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
        const { tools } = await client.listTools();
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        for (const [name, args] of Object.entries(REQUIRED_TOOLS)) {
            const tool = byName.get(name);
            assert.ok(tool, `Playwright MCP no longer provides ${name}`);
            const properties = Object.keys((tool.inputSchema.properties || {}) as Record<string, unknown>);
            for (const arg of args) {
                assert.ok(properties.includes(arg), `${name} no longer accepts "${arg}" (has: ${properties.join(", ")})`);
            }
            const required = (tool.inputSchema.required || []) as string[];
            for (const requiredArg of required) {
                assert.ok(args.includes(requiredArg), `${name} now requires "${requiredArg}", which WebPilot does not send`);
            }
        }
    } finally {
        await client.close().catch(() => {});
        await server.close().catch(() => {});
    }
});

test("element refs are sent as the MCP target argument", () => {
    assert.deepEqual(toMcpArguments({ ref: "e5", element: "Search" }), { target: "e5", element: "Search" });
    assert.deepEqual(toMcpArguments({ target: "e7", ref: "e5" }), { target: "e7" });
    assert.deepEqual(toMcpArguments({ url: "https://example.com" }), { url: "https://example.com" });
});
