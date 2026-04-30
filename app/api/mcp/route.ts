import { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp/register-tools";

export const dynamic = "force-dynamic";

// Stateless: fresh server + transport per request.
// enableJsonResponse returns a single JSON body instead of SSE.
async function handleMcp(req: NextRequest): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
  }
}

export async function POST(req: NextRequest) {
  return handleMcp(req);
}

export async function GET(req: NextRequest) {
  return handleMcp(req);
}

export async function DELETE(req: NextRequest) {
  return handleMcp(req);
}
