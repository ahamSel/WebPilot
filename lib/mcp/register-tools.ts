/**
 * Shared MCP tool and resource registrations.
 * Used by both the Next.js HTTP route and the standalone stdio server.
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startAgent, requestStop, getAgentState } from "@/lib/agent";
import { listRuns } from "@/lib/recorder";

const RUN_STORE_DIR = process.env.RUN_STORE_DIR || path.join(process.cwd(), "agent_runs");
const ARTIFACT_DIR = (runId: string) => path.join(RUN_STORE_DIR, runId, "artifacts");

async function readFileSafe(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "webpilot-mcp", version: "0.1.0" });

  server.registerTool(
    "list_runs",
    {
      description: "List recent agent runs",
      inputSchema: z.object({ limit: z.number().optional().default(20) }),
    },
    async ({ limit }) => {
      const runs = await listRuns(limit);
      return { content: [{ type: "text", text: JSON.stringify(runs, null, 2) }] };
    }
  );

  server.registerTool(
    "start_agent",
    {
      description: "Start a new agent run with the given goal",
      inputSchema: z.object({ goal: z.string() }),
    },
    async ({ goal }) => {
      await startAgent(goal);
      return { content: [{ type: "text", text: "started" }] };
    }
  );

  server.registerTool(
    "stop_agent",
    {
      description: "Signal the agent to stop",
      inputSchema: z.object({}).optional(),
    },
    async () => {
      requestStop();
      return { content: [{ type: "text", text: "stop requested" }] };
    }
  );

  server.registerTool(
    "agent_state",
    {
      description: "Get current agent state snapshot",
      inputSchema: z.object({}).optional(),
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(getAgentState(), null, 2) }],
    })
  );

  server.registerTool(
    "get_run",
    {
      description: "Get run metadata and basic step count for a run",
      inputSchema: z.object({ runId: z.string() }),
    },
    async ({ runId }) => {
      const runJson = await readFileSafe(path.join(RUN_STORE_DIR, runId, "run.json"));
      if (!runJson) throw new Error("run.json not found");
      const stepsText = await readFileSafe(path.join(RUN_STORE_DIR, runId, "steps.jsonl"));
      const stepCount = stepsText ? stepsText.split("\n").filter(Boolean).length : 0;
      return {
        content: [
          { type: "text", text: runJson },
          { type: "text", text: `step_count=${stepCount}` },
        ],
      };
    }
  );

  server.registerTool(
    "list_artifacts",
    {
      description: "List artifact filenames for a given run",
      inputSchema: z.object({ runId: z.string() }),
    },
    async ({ runId }) => {
      const dir = ARTIFACT_DIR(runId);
      if (!existsSync(dir)) return { content: [{ type: "text", text: "[]" }] };
      const files = fsSync.readdirSync(dir).filter((file) => !file.startsWith("."));
      return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
    }
  );

  server.registerResource(
    "run-meta",
    new ResourceTemplate("runs://{runId}/run.json", {
      list: async () => {
        const entries = existsSync(RUN_STORE_DIR)
          ? fsSync.readdirSync(RUN_STORE_DIR).filter((dir) => !dir.startsWith("."))
          : [];
        return { resources: entries.map((runId) => ({ uri: `runs://${runId}/run.json`, name: runId })) };
      },
    }),
    { title: "Run metadata", description: "run.json for a given run", mimeType: "application/json" },
    async (uri, { runId }) => {
      const rid = Array.isArray(runId) ? runId[0] : runId;
      const text = await readFileSafe(path.join(RUN_STORE_DIR, rid, "run.json"));
      if (!text) throw new Error("Not found");
      return { contents: [{ uri: uri.href, text, mimeType: "application/json" }] };
    }
  );

  server.registerResource(
    "run-steps",
    new ResourceTemplate("runs://{runId}/steps.jsonl", {
      list: async () => {
        const entries = existsSync(RUN_STORE_DIR)
          ? fsSync.readdirSync(RUN_STORE_DIR).filter((dir) => !dir.startsWith("."))
          : [];
        return { resources: entries.map((runId) => ({ uri: `runs://${runId}/steps.jsonl`, name: runId })) };
      },
    }),
    { title: "Run steps log", description: "steps.jsonl for a given run", mimeType: "application/json" },
    async (uri, { runId }) => {
      const rid = Array.isArray(runId) ? runId[0] : runId;
      const text = await readFileSafe(path.join(RUN_STORE_DIR, rid, "steps.jsonl"));
      if (!text) throw new Error("Not found");
      return { contents: [{ uri: uri.href, text, mimeType: "application/x-ndjson" }] };
    }
  );

  server.registerResource(
    "artifact",
    new ResourceTemplate("artifact://{runId}/{filename}", {
      list: async () => {
        if (!existsSync(RUN_STORE_DIR)) return { resources: [] };
        const runs = fsSync.readdirSync(RUN_STORE_DIR).filter((dir) => !dir.startsWith("."));
        const resources: { uri: string; name: string }[] = [];
        for (const runId of runs) {
          const dir = ARTIFACT_DIR(runId);
          if (!existsSync(dir)) continue;
          const files = fsSync.readdirSync(dir).filter((file) => !file.startsWith("."));
          for (const file of files) {
            resources.push({ uri: `artifact://${runId}/${file}`, name: `${runId}/${file}` });
          }
        }
        return { resources };
      },
    }),
    { title: "Run artifact", description: "Artifact file from a run", mimeType: "application/octet-stream" },
    async (uri, { runId, filename }) => {
      const rid = Array.isArray(runId) ? runId[0] : runId;
      const fname = Array.isArray(filename) ? filename[0] : filename;
      const file = path.join(ARTIFACT_DIR(rid), fname);
      if (!existsSync(file)) throw new Error("Not found");
      const data = await fs.readFile(file);
      return {
        contents: [{
          uri: uri.href,
          mimeType: fname.endsWith(".png") ? "image/png" : fname.endsWith(".html") ? "text/html" : "application/octet-stream",
          blob: data.toString("base64"),
          encoding: "base64",
        }],
      };
    }
  );

  return server;
}
