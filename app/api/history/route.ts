import { NextResponse } from "next/server";
import { clearHistory } from "@/lib/history";

export const dynamic = "force-dynamic";

export async function DELETE() {
    try {
        const result = await clearHistory();
        return NextResponse.json(result);
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to clear history" }, { status: 500 });
    }
}
