import { NextResponse } from "next/server";
import { getRunDetail } from "@/lib/recorder";
import { deleteHistoryRun } from "@/lib/history";

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
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load run" }, { status: 500 });
    }
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    try {
        const { runId } = await params;
        const result = await deleteHistoryRun(runId);
        if (!result.deletedRun) {
            return NextResponse.json({ error: "Run not found" }, { status: 404 });
        }
        return NextResponse.json(result);
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to delete run" }, { status: 500 });
    }
}
