import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function isPendingPipelineMigration(error: { code?: string; message?: string }): boolean {
  return ["42703", "PGRST204"].includes(error.code || "")
    && (error.message || "").includes("user_id");
}

async function getOwnedTrack(req: NextRequest, trackId: string) {
  const user = await getRequestUser(req);
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const db = getServiceClient();
  const { data: userTrack, error } = await db
    .from("user_tracks")
    .select("track_id, tracks!inner(id,storage_path,download_url,youtube_url,spotify_url,source_url,artist,title)")
    .eq("user_id", user.id)
    .eq("track_id", trackId)
    .maybeSingle();

  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!userTrack) {
    return { error: NextResponse.json({ error: "Track not found in your library" }, { status: 404 }) };
  }

  const track = Array.isArray(userTrack.tracks) ? userTrack.tracks[0] : userTrack.tracks;
  return { db, track, user };
}

async function signedTrackResponse(
  db: ReturnType<typeof getServiceClient>,
  track: { storage_path: string | null; download_url?: string | null; artist: string; title: string },
) {
  const filename = `${track.artist} - ${track.title}`.replace(/[/\\?%*:|"<>]/g, "");
  if (track.storage_path) {
    const { data: signed, error } = await db.storage
      .from("tracks")
      .createSignedUrl(track.storage_path, 3600);
    if (error || !signed?.signedUrl) {
      return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
    }
    return NextResponse.json({ success: true, status: "ready", url: signed.signedUrl, audio_url: signed.signedUrl, filename });
  }

  if (track.download_url) {
    return NextResponse.json({ success: true, status: "ready", url: track.download_url, audio_url: track.download_url, filename });
  }

  return null;
}

// Returns a signed URL only for tracks visible to the authenticated user.
export async function GET(req: NextRequest, props: Context) {
  const { id } = await props.params;
  const owned = await getOwnedTrack(req, id);
  if (owned.error) return owned.error;

  const ready = await signedTrackResponse(owned.db, owned.track);
  if (ready) return ready;

  const { data: preparation } = await owned.db
    .from("audio_preparation_queue")
    .select("state,last_error")
    .eq("user_id", owned.user.id)
    .eq("track_id", id)
    .maybeSingle();

  return NextResponse.json({
    status: preparation?.state || "not_requested",
    error: preparation?.last_error || null,
  }, { status: 202 });
}

// Queue local acquisition. Vercel is the control plane; the local engine owns
// yt-dlp, transcoding, and storage so requests survive serverless timeouts.
export async function POST(req: NextRequest, props: Context) {
  const { id } = await props.params;
  const owned = await getOwnedTrack(req, id);
  if (owned.error) return owned.error;
  const { db, track, user } = owned;

  const ready = await signedTrackResponse(db, track);
  if (ready) return ready;

  const sourceUrl = track.youtube_url || track.spotify_url || track.source_url;
  if (!sourceUrl) {
    return NextResponse.json({ error: "No downloadable source is available for this track yet" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { error: requestError } = await db.from("download_requests").insert({
    track_id: id,
    user_id: user.id,
    youtube_url: sourceUrl,
    status: "pending",
  });
  if (requestError && requestError.code !== "23505") {
    if (isPendingPipelineMigration(requestError)) {
      return NextResponse.json({
        error: "Audio preparation is temporarily unavailable while its database migration is applied",
      }, { status: 503 });
    }
    return NextResponse.json({ error: requestError.message }, { status: 500 });
  }

  const { error: resetError } = await db
    .from("tracks")
    .update({ dl_attempts: 0, dl_failed_at: null })
    .eq("id", id);
  if (resetError) return NextResponse.json({ error: resetError.message }, { status: 500 });

  const { error: queueError } = await db.from("audio_preparation_queue").upsert({
    user_id: user.id,
    track_id: id,
    state: "ranked",
    rank: 1,
    score: 10_000,
    score_components: { explicit_play_request: true },
    scoring_version: "explicit_play_request_v1",
    ranked_at: now,
    preparing_at: null,
    ready_at: null,
    failed_at: null,
    last_error: null,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    updated_at: now,
  }, { onConflict: "user_id,track_id" });
  if (queueError) return NextResponse.json({ error: queueError.message }, { status: 500 });

  const { error: intentError } = await db
    .from("user_tracks")
    .update({ local_download_intent: true })
    .eq("user_id", user.id)
    .eq("track_id", id);
  if (intentError) return NextResponse.json({ error: intentError.message }, { status: 500 });

  return NextResponse.json({ status: "pending", message: "Audio queued" }, { status: 202 });
}
