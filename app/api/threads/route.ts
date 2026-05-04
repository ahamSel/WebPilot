import { NextRequest, NextResponse } from "next/server";
import { deleteHistoryThread } from "@/lib/history";
import { getThreadDetail, listThreads } from "@/lib/threads";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    try {
        const threadId = req.nextUrl.searchParams.get("threadId");
        if (threadId) {
            const thread = await getThreadDetail(threadId);
            if (!thread) {
                return NextResponse.json({ error: "Thread not found" }, { status: 404 });
            }
            return NextResponse.json({ thread });
        }

        const limit = Number(req.nextUrl.searchParams.get("limit") || 20);
        const threads = await listThreads(limit);
        return NextResponse.json({ threads });
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load threads" }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const threadId = req.nextUrl.searchParams.get("threadId");
        if (!threadId) {
            return NextResponse.json({ error: "threadId required" }, { status: 400 });
        }
        const result = await deleteHistoryThread(threadId);
        if (!result.deletedThread && result.deletedRuns === 0) {
            return NextResponse.json({ error: "Thread not found" }, { status: 404 });
        }
        return NextResponse.json(result);
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to delete thread" }, { status: 500 });
    }
}
