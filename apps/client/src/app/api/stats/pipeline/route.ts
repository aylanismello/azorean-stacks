import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { canEditSharedCatalog, getRequestUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await getRequestUser(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = getServiceClient();
    const { data: superLikes, error: superLikeError } = await db
      .from("user_tracks")
      .select("track_id")
      .eq("user_id", user.id)
      .eq("super_liked", true);
    if (superLikeError) throw superLikeError;

    const superLikedTrackIds = (superLikes || []).map((row) => row.track_id);
    const ownedSuperLikes = new Set(superLikedTrackIds);
    const { data: completedEvents, error: completedEventsError } = await db
      .from("engine_events")
      .select("metadata")
      .eq("event_type", "super_like_completed");
    if (completedEventsError) throw completedEventsError;
    const downloaded = new Set(
      (completedEvents || [])
        .map((event) => event.metadata?.track_id)
        .filter((trackId): trackId is string => typeof trackId === "string" && ownedSuperLikes.has(trackId)),
    ).size;

    const total = superLikedTrackIds.length;
    let connectedAt: string | null = null;
    let lastEventAt: string | null = null;
    let recentEvents: Array<Record<string, unknown>> = [];

    // Engine telemetry is operational metadata. Keep it behind the same explicit
    // operator allowlist used for shared catalog mutations.
    if (canEditSharedCatalog(user.id)) {
      const [connectedResult, lastEventResult, recentResult] = await Promise.all([
        db.from("engine_events")
          .select("created_at")
          .eq("event_type", "watcher_connected")
          .order("created_at", { ascending: false })
          .limit(1),
        db.from("engine_events")
          .select("created_at")
          .order("created_at", { ascending: false })
          .limit(1),
        db.from("engine_events")
          .select("event_type, status, created_at, metadata")
          .order("created_at", { ascending: false })
          .limit(10),
      ]);
      if (connectedResult.error) throw connectedResult.error;
      if (lastEventResult.error) throw lastEventResult.error;
      if (recentResult.error) throw recentResult.error;
      connectedAt = connectedResult.data?.[0]?.created_at ?? null;
      lastEventAt = lastEventResult.data?.[0]?.created_at ?? null;
      recentEvents = recentResult.data || [];
    }

    return NextResponse.json({
      super_likes: { total, downloaded, pending: Math.max(0, total - downloaded) },
      watcher: { connected_at: connectedAt, last_event: lastEventAt },
      last_events: recentEvents,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
