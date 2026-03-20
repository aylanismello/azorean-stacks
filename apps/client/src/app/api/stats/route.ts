import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Use anon client for track counts (same RLS view as tracks endpoint)
    // Service client only for discovery_runs which has no RLS equivalent

    // Counts by status — use limit(0) with count to stay compatible with RLS
    const [pending, approved, rejected] = await Promise.all([
      supabase.from("tracks").select("id", { count: "exact" }).eq("status", "pending").limit(0),
      supabase.from("tracks").select("id", { count: "exact" }).eq("status", "approved").limit(0),
      supabase.from("tracks").select("id", { count: "exact" }).eq("status", "rejected").limit(0),
    ]);

    const totalApproved = approved.count || 0;
    const totalRejected = rejected.count || 0;
    const totalReviewed = totalApproved + totalRejected;
    const approvalRate = totalReviewed > 0 ? totalApproved / totalReviewed : 0;

    // Top approved artists — paginated fetch of artist column
    const approvedTracks: { artist: string }[] = [];
    let artistPage = 0;
    while (true) {
      const { data: batch } = await supabase
        .from("tracks")
        .select("artist")
        .eq("status", "approved")
        .range(artistPage * 1000, (artistPage + 1) * 1000 - 1);
      if (!batch || batch.length === 0) break;
      approvedTracks.push(...(batch as { artist: string }[]));
      if (batch.length < 1000) break;
      artistPage++;
    }

    const artistCounts: Record<string, number> = {};
    approvedTracks.forEach((t) => {
      artistCounts[t.artist] = (artistCounts[t.artist] || 0) + 1;
    });

    const topArtists = Object.entries(artistCounts)
      .map(([artist, count]) => ({ artist, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Source breakdown — paginated fetch of source column
    const allSources: { source: string }[] = [];
    let sourcePage = 0;
    while (true) {
      const { data: batch } = await supabase
        .from("tracks")
        .select("source")
        .range(sourcePage * 1000, (sourcePage + 1) * 1000 - 1);
      if (!batch || batch.length === 0) break;
      allSources.push(...(batch as { source: string }[]));
      if (batch.length < 1000) break;
      sourcePage++;
    }

    const sourceCounts: Record<string, number> = {};
    allSources.forEach((t) => {
      sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
    });

    const sourceBreakdown = Object.entries(sourceCounts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);

    // Recent discovery runs (use service client — no RLS on this table)
    const serviceDb = getServiceClient();
    const { data: recentRuns } = await serviceDb
      .from("discovery_runs")
      .select("id, seed_id, seed_track_id, sources_searched, tracks_found, tracks_added, started_at, completed_at, notes")
      .order("started_at", { ascending: false })
      .limit(10);

    return NextResponse.json({
      total_reviewed: totalReviewed,
      total_approved: totalApproved,
      total_rejected: totalRejected,
      approval_rate: approvalRate,
      total_pending: pending.count || 0,
      top_artists: topArtists,
      source_breakdown: sourceBreakdown,
      recent_runs: recentRuns || [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
