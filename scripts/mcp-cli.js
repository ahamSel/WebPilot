#!/usr/bin/env node
/**
 * Minimal MCP client for local testing against /api/mcp.
 * Usage:
 *   node scripts/mcp-cli.js list_runs
 *   node scripts/mcp-cli.js get_run run_123
 *   node scripts/mcp-cli.js list_artifacts run_123
 *   node scripts/mcp-cli.js agent_state
 *   node scripts/mcp-cli.js start_agent "goal text"
 *   node scripts/mcp-cli.js stop_agent
 */

const tool = process.argv[2];
const arg = process.argv[3];
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

if (!tool) {
  console.log("Usage: node scripts/mcp-cli.js <tool> [arg]");
  process.exit(1);
}

async function call(tool, payload) {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: payload || {} }
    })
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

(async () => {
  switch (tool) {
    case 'list_runs':
      await call('list_runs', {});
      break;
    case 'agent_state':
      await call('agent_state', {});
      break;
    case 'get_run':
      if (!arg) throw new Error('run id required');
      await call('get_run', { runId: arg });
      break;
    case 'list_artifacts':
      if (!arg) throw new Error('run id required');
      await call('list_artifacts', { runId: arg });
      break;
    case 'start_agent':
      if (!arg) throw new Error('goal required');
      await call('start_agent', { goal: arg });
      break;
    case 'stop_agent':
      await call('stop_agent', {});
      break;
    default:
      throw new Error('unknown tool');
  }
})();
