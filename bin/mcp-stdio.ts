#!/usr/bin/env npx tsx
/**
 * Standalone MCP server over stdio.
 * Use with Claude Code, Cursor, or any MCP-compatible client:
 *
 *   npx webpilot-mcp          (if published to npm)
 *   npx tsx bin/mcp-stdio.ts   (local dev)
 *
 * Config in claude_desktop_config.json:
 *   { "mcpServers": { "webpilot": { "command": "npx", "args": ["tsx", "bin/mcp-stdio.ts"], "cwd": "/path/to/web-pilot" } } }
 */

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../lib/mcp/register-tools";

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("webpilot-mcp fatal:", err);
  process.exit(1);
});
