import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { getRequestUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function isMissingEntriesMigration(error: { code?: string }): boolean {
  return ["42P01", "PGRST205"].includes(error.code || "");
}

// Lossless ordered episode appearances. Resolved rows retain flattened track
// fields for legacy clients while `appearance_id` and `track` are authoritative.
export async function GET(req: NextRequest, props: Context) {
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: episodeId } = await props.params;
  const db = getServiceClient();
  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (sessionId) {
    const { data: ownedSession, error: sessionError } = await db.from("user_episode_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("episode_id", episodeId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (sessionError) return NextResponse.json({ error: sessionError.message }, { status: 500 });
    if (!ownedSession) return NextResponse.json({ error: "Episode session not found" }, { status: 404 });
  }
  let { data: rows, error } = await db
    .from("episode_track_entries")
    .select("id,episode_id,track_id,position,timestamp_text,timestamp_seconds,source_artist,source_title,source_artist_id,source_song_id,resolution_state,source_metadata,tracks(id,artist,title,status,spotify_url,youtube_url,storage_path,cover_art_url,preview_url,source_url,metadata,dl_attempts,dl_failed_at,seed_track_id,is_seed,is_re_seed,is_artist_seed)")
    .eq("episode_id", episodeId)
    .order("position", { ascending: true });

  if (error && isMissingEntriesMigration(error)) {
    const legacy = await db.from("episode_tracks")
      .select("episode_id,track_id,position,tracks(id,artist,title,status,spotify_url,youtube_url,storage_path,cover_art_url,preview_url,source_url,metadata,dl_attempts,dl_failed_at,seed_track_id,is_seed,is_re_seed,is_artist_seed)")
      .eq("episode_id", episodeId).order("position", { ascending: true, nullsFirst: false });
    error = legacy.error;
    rows = (legacy.data || []).map((row: any) => ({
      ...row,
      id: `${row.episode_id}:${row.track_id}`,
      timestamp_text: null,
      timestamp_seconds: null,
      source_artist: null,
      source_title: null,
      source_artist_id: null,
      source_song_id: null,
      resolution_state: "canonical",
      source_metadata: {},
    }));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const canonicalTracks = (rows || []).flatMap((row: any) => {
    const track = Array.isArray(row.tracks) ? row.tracks[0] : row.tracks;
    return track ? [track] : [];
  });
  const trackIds = [...new Set(canonicalTracks.map((track: any) => track.id))];
  const [opinionsResult, preparationResult] = trackIds.length
    ? await Promise.all([
        db.from("user_tracks").select("track_id,super_liked,status").eq("user_id", user.id).in("track_id", trackIds),
        db.from("audio_preparation_queue").select("track_id,state,last_error").eq("user_id", user.id).in("track_id", trackIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (opinionsResult.error || preparationResult.error) {
    return NextResponse.json({ error: opinionsResult.error?.message || preparationResult.error?.message }, { status: 500 });
  }

  const opinions = new Map((opinionsResult.data || []).map((row: any) => [row.track_id, row]));
  const preparation = new Map((preparationResult.data || []).map((row: any) => [row.track_id, row]));
  const signedUrls = new Map<string, string>();
  await Promise.all(canonicalTracks.map(async (track: any) => {
    if (!track.storage_path || signedUrls.has(track.id)) return;
    const { data: signed } = await db.storage.from("tracks").createSignedUrl(track.storage_path, 3600);
    if (signed?.signedUrl) signedUrls.set(track.id, signed.signedUrl);
  }));

  return NextResponse.json((rows || []).map((row: any) => {
    const track = Array.isArray(row.tracks) ? row.tracks[0] : row.tracks;
    const opinion = track ? opinions.get(track.id) : null;
    const queued = track ? preparation.get(track.id) : null;
    const canonical = track ? {
      ...track,
      audio_url: signedUrls.get(track.id) || null,
      audio_status: track.storage_path ? "ready" : queued?.state || "not_requested",
      audio_error: queued?.last_error || null,
      super_liked: Boolean(opinion?.super_liked),
      vote_status: opinion?.status || null,
    } : null;
    return {
      ...row,
      tracks: undefined,
      id: canonical?.id || row.id,
      appearance_id: row.id,
      track: canonical,
      ...(canonical || {
        artist: row.source_artist,
        title: row.source_title,
        status: "unresolved",
        spotify_url: null,
        youtube_url: null,
        storage_path: null,
        cover_art_url: null,
        preview_url: null,
        audio_url: null,
        audio_status: row.resolution_state === "unavailable" ? "unavailable" : "not_requested",
      }),
    };
  }));
}
