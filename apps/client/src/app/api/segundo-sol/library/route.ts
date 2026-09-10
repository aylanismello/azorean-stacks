import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function preferredSource(track: Record<string, any>): string | null {
  return (
    track.spotify_url ||
    track.soundcloud_url ||
    track.bandcamp_url ||
    track.youtube_url ||
    track.source_url ||
    null
  );
}

export async function GET(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kind = req.nextUrl.searchParams.get("kind") || "all";
  const search = (req.nextUrl.searchParams.get("search") || "").trim().slice(0, 120);
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 60, 1), 100);
  const offset = Math.max(Number(req.nextUrl.searchParams.get("offset")) || 0, 0);

  let query = getServiceClient()
    .from("user_tracks")
    .select("track_id, status, super_liked, voted_at, tracks!inner(*)", { count: "exact" })
    .eq("user_id", user.id);

  // A super-like is a stronger annotation on an approved row, never a
  // replacement for approval. Keep the CMS crate strictly user-approved.
  query = query.eq("status", "approved");
  if (kind === "super_liked") query = query.eq("super_liked", true);
  else if (kind === "approved") query = query.eq("super_liked", false);

  if (search) {
    const escaped = search.replace(/[%_\\]/g, (character) => `\\${character}`);
    query = query.or(`artist.ilike.%${escaped}%,title.ilike.%${escaped}%`, {
      referencedTable: "tracks",
    });
  }

  const { data, error, count } = await query
    .order("voted_at", { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const catalogTracks = (data || []).flatMap((row: any) => {
    const track = Array.isArray(row.tracks) ? row.tracks[0] : row.tracks;
    return track ? [{ row, track }] : [];
  });
  const trackIds = catalogTracks.map(({ track }) => track.id);
  const preparation = trackIds.length
    ? await getServiceClient()
        .from("audio_preparation_queue")
        .select("track_id,state,last_error")
        .eq("user_id", user.id)
        .in("track_id", trackIds)
    : { data: [], error: null };
  const preparationByTrack = new Map(
    (preparation.data || []).map((item: any) => [item.track_id, item]),
  );

  const tracks = catalogTracks.map(({ row, track }) => {
    const queueState = preparationByTrack.get(track.id) as { state?: string; last_error?: string | null } | undefined;
    const localReady = Boolean(track.storage_path);
    return {
      id: track.id,
      artist: track.artist,
      title: track.title,
      artwork_url: track.cover_art_url || null,
      source_url: preferredSource(track),
      source_origin: row.super_liked ? "stacks_super_like" : "stacks_like",
      super_liked: Boolean(row.super_liked),
      playable: localReady,
      audio_status: localReady ? "ready" : queueState?.state || "not_requested",
      audio_error: queueState?.last_error || null,
      voted_at: row.voted_at,
      metadata: {
        source: track.source,
        source_context: track.source_context,
        spotify_url: track.spotify_url || null,
        soundcloud_url: track.soundcloud_url || null,
        bandcamp_url: track.bandcamp_url || null,
        youtube_url: track.youtube_url || null,
        original_source_url: track.source_url || null,
      },
    };
  });

  return NextResponse.json({ tracks, total: count || 0 });
}
