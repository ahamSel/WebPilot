import { NextResponse } from "next/server";
import { getRunDetail } from "@/lib/recorder";

export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    try {
        const { runId } = await params;
        const run = await getRunDetail(runId);
        if (!run) {
            return NextResponse.json({ error: "Run not found" }, { status: 404 });
        }
        return NextResponse.json({ run });
    } catch (e: any) {
        return NextResponse.json({ error: e?.message || "Failed to load run" }, { status: 500 });
    }
}
