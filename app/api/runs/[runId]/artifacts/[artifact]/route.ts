import { NextResponse } from "next/server";
import { getRunArtifactDetail } from "@/lib/recorder";

export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ runId: string; artifact: string }> }
) {
    try {
        const { runId, artifact } = await params;
        const artifactDetail = await getRunArtifactDetail(runId, artifact);
        if (!artifactDetail) {
            return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
        }
        return NextResponse.json({ artifact: artifactDetail });
    } catch (e: any) {
        return NextResponse.json({ error: e?.message || "Failed to load artifact" }, { status: 500 });
    }
}
