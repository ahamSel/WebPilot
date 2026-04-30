/**
 * MCP Mutex — Ensures atomic tab-switch + tool-call pairs for parallel agents.
 *
 * When multiple sub-agents share one Playwright MCP connection, each agent
 * needs to switch to its tab before executing a tool. Without a mutex,
 * agent A could switch to tab 0, then agent B switches to tab 1 before A's
 * tool call executes, causing A's tool to run on the wrong tab.
 *
 * The mutex serializes all MCP operations while allowing Gemini API calls
 * to run in true parallel (since those don't touch the browser).
 */

import { callMcpTool, mcpText, parseSnapshot } from "./playwright-mcp-driver";

export class McpMutex {
    private queue: Promise<void> = Promise.resolve();

    /**
     * Run a function with exclusive access to the MCP client.
     * Calls are queued — only one runs at a time.
     */
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        let release: () => void;
        const prev = this.queue;
        this.queue = new Promise<void>((r) => {
            release = r;
        });
        await prev;
        try {
            return await fn();
        } finally {
            release!();
        }
    }
}

/**
 * Call an MCP tool on a specific tab, atomically.
 * Switches to the tab and executes the tool within a single mutex lock.
 */
export async function callMcpToolOnTab(
    mutex: McpMutex,
    tabIndex: number,
    toolName: string,
    args: Record<string, any> = {}
): Promise<any> {
    return mutex.runExclusive(async () => {
        // Switch to the agent's tab first
        await callMcpTool("browser_tabs", { action: "select", index: tabIndex });
        // Execute the actual tool on that tab
        return await callMcpTool(toolName, args);
    });
}

/**
 * Call multiple MCP tools on a specific tab in one atomic lock.
 * Useful for operations that need multiple sequential calls (e.g., clear + type).
 */
export async function callMcpToolsOnTab(
    mutex: McpMutex,
    tabIndex: number,
    calls: Array<{ name: string; args?: Record<string, any> }>
): Promise<any[]> {
    return mutex.runExclusive(async () => {
        await callMcpTool("browser_tabs", { action: "select", index: tabIndex });
        const results: any[] = [];
        for (const call of calls) {
            results.push(await callMcpTool(call.name, call.args || {}));
        }
        return results;
    });
}
