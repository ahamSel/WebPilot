import { NextRequest, NextResponse } from "next/server";
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
    } catch (e: any) {
        return NextResponse.json({ error: e?.message || "Failed to load threads" }, { status: 500 });
    }
}
