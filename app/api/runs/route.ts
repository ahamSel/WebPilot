import { NextResponse } from "next/server";
import { listRuns } from "@/lib/recorder";

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        const runs = await listRuns(30);
        return NextResponse.json({ runs });
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to list runs" }, { status: 500 });
    }
}
