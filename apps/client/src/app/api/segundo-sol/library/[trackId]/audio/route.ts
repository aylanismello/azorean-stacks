import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/server-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ trackId: string }> };

async function getOwnedTrack(req: NextRequest, trackId: string) {
  const user = await getRequestUser(req);
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const db = getServiceClient();
  const { data: userTrack, error } = await db
    .from("user_tracks")
    .select("track_id, tracks!inner(storage_path, spotify_url, youtube_url, source_url)")
    .eq("user_id", user.id)
    .eq("track_id", trackId)
    .or("status.eq.approved,super_liked.eq.true")
    .maybeSingle();

  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!userTrack) {
    return { error: NextResponse.json({ error: "Track is not in your kept library" }, { status: 404 }) };
  }

  const track = Array.isArray(userTrack.tracks) ? userTrack.tracks[0] : userTrack.tracks;
  return { db, track, user };
}

export async function GET(req: NextRequest, props: Context) {
  const { trackId } = await props.params;
  const owned = await getOwnedTrack(req, trackId);
  if (owned.error) return owned.error;
  const { db, track, user } = owned;

  if (!track?.storage_path) {
    const { data: preparation } = await db
      .from("audio_preparation_queue")
      .select("state,last_error")
      .eq("user_id", user.id)
      .eq("track_id", trackId)
      .maybeSingle();
    return NextResponse.json({
      status: preparation?.state || "not_requested",
      error: preparation?.last_error || null,
    }, { status: 202 });
  }

  const { data: signed, error: signError } = await db.storage
    .from("tracks")
    .createSignedUrl(track.storage_path, 3600);
  if (signError || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not prepare this preview" }, { status: 500 });
  }

  return NextResponse.json({ url: signed.signedUrl, status: "ready" });
}

export async function POST(req: NextRequest, props: Context) {
  const { trackId } = await props.params;
  const owned = await getOwnedTrack(req, trackId);
  if (owned.error) return owned.error;
  const { db, track, user } = owned;

  if (!track) return NextResponse.json({ error: "Track not found" }, { status: 404 });
  if (track.storage_path) return NextResponse.json({ status: "ready" });

  const now = new Date().toISOString();
  const { error: preparationError } = await db.from("audio_preparation_queue").upsert({
    user_id: user.id,
    track_id: trackId,
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
  if (preparationError) {
    return NextResponse.json({ error: preparationError.message }, { status: 500 });
  }

  await db
    .from("user_tracks")
    .update({ local_download_intent: true })
    .eq("user_id", user.id)
    .eq("track_id", trackId);

  const acquisitionSource = track.youtube_url || track.spotify_url || track.source_url;
  if (acquisitionSource) {
    const { error: requestError } = await db.from("download_requests").insert({
      track_id: trackId,
      youtube_url: acquisitionSource,
      status: "pending",
    });
    if (requestError && requestError.code !== "23505") {
      return NextResponse.json({ error: requestError.message }, { status: 500 });
    }
    return NextResponse.json({ status: "pending", message: "Audio queued" }, { status: 202 });
  }

  return NextResponse.json({ error: "No downloadable source is available for this track yet" }, { status: 409 });
}
