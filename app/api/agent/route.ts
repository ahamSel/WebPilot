import { NextRequest, NextResponse } from "next/server";
import { getAgentState, startAgent, requestPause, resumeFromPause, requestStop } from "@/lib/agent";
import type { RuntimeModelOverrides } from "@/lib/model-client";

export const dynamic = 'force-dynamic';

export async function GET() {
    const state = getAgentState();
    // Return full state including logs (limited to last 50 for payload size)
    return NextResponse.json({
        ...state,
        logs: state.logs?.slice(-50) || [],
    });
}

export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const goal = typeof body.goal === "string" ? body.goal : "";
    const threadId = typeof body.threadId === "string" ? body.threadId : null;
    const runtime = body.runtime && typeof body.runtime === "object" && !Array.isArray(body.runtime)
        ? body.runtime as RuntimeModelOverrides
        : {};

    try {
        if (action === "start") {
            const started = await startAgent(goal, runtime, { threadId });
            return NextResponse.json({ ok: true, ...started });
        }
        if (action === "pause") {
            requestPause();
            return NextResponse.json({ ok: true });
        }
        if (action === "resume") {
            resumeFromPause();
            return NextResponse.json({ ok: true });
        }
        if (action === "stop") {
            requestStop();
            return NextResponse.json({ ok: true });
        }
        return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
    } catch (e: unknown) {
        const error = e instanceof Error ? e.message : "Request failed";
        return NextResponse.json({ ok: false, error }, { status: 500 });
    }
}
